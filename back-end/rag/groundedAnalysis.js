// rag/groundedAnalysis.js - Retrieval-augmented ingredient verdicts.
//
// The ungrounded version of this app asked a language model "is this
// ingredient harmful?" and rendered whatever came back. For a food-safety tool
// that is the wrong shape of answer: it is unattributable, it varies between
// identical requests, and it invents health claims for ingredients the model
// has never reliably seen.
//
// Here every verdict must cite a passage that was actually retrieved from the
// Open Food Facts corpus, and an ingredient the corpus does not cover is
// reported as uncovered rather than guessed at. Reporting the gap is the
// point.
import { z } from "zod";
import { canonicalStatus, STATUS_VALUES } from "../schemas/analysis.js";
import AppError from "../utils/AppError.js";
import logger from "../utils/logger.js";

export const MAX_INGREDIENTS = 25;
export const CHUNKS_PER_INGREDIENT = 3;
export const MAX_CONTEXT_CHUNKS = 24;

export const groundedVerdictSchema = z.object({
  ingredient: z.string().trim().min(1),
  status: z.preprocess(canonicalStatus, z.enum(STATUS_VALUES)),
  reason: z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string()),
  concerns: z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
        : typeof value === "string" && value.trim()
          ? [value.trim()]
          : [],
    z.array(z.string())
  ),
  citations: z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter((item) => typeof item === "string").map((item) => item.trim().toUpperCase())
        : typeof value === "string"
          ? [value.trim().toUpperCase()]
          : [],
    z.array(z.string())
  ),
});

/**
 * Number the retrieved chunks C1..Cn and render them for the prompt.
 * Pure: the same chunks always produce the same block and the same id map.
 */
export function buildContextBlock(chunks) {
  const byId = new Map();
  const lines = [];

  chunks.forEach((chunk, index) => {
    const id = `C${index + 1}`;
    byId.set(id, chunk);
    lines.push(`[${id}] ${chunk.title} — ${chunk.text}`);
  });

  return { block: lines.join("\n\n"), byId };
}

/**
 * A citation is valid only if it names a context id that was in the prompt.
 *
 * This is the check that catches the failure everybody worries about: a model
 * that invents "[C7]" when only six passages were supplied has invented the
 * evidence, and the verdict resting on it cannot be trusted even if it happens
 * to be correct.
 */
export function validateCitations(verdicts, allowedIds) {
  const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds);

  const valid = [];
  const invalid = [];

  for (const verdict of verdicts) {
    const unknown = verdict.citations.filter((citation) => !allowed.has(citation));
    if (verdict.citations.length === 0) {
      invalid.push({ verdict, reason: "no citation" });
    } else if (unknown.length > 0) {
      invalid.push({ verdict, reason: `unresolvable citation(s): ${unknown.join(", ")}` });
    } else {
      valid.push(verdict);
    }
  }

  return { valid, invalid };
}

/** Attach the real source record to each cited id, so the UI can link out. */
export function attachSources(verdicts, byId) {
  return verdicts.map((verdict) => ({
    ...verdict,
    sources: verdict.citations
      .map((citation) => byId.get(citation))
      .filter(Boolean)
      .map((chunk) => ({ id: chunk.id, title: chunk.title, ...chunk.source })),
  }));
}

export function buildPrompt(contextBlock, ingredients) {
  return `You are a food-safety analyst. Below are numbered reference passages from the Open Food Facts taxonomies, then a list of ingredients read off a food label.

RULES:
- Use ONLY the reference passages. Do not use any other knowledge.
- Every verdict MUST cite the passage ids it rests on, e.g. "citations": ["C3"].
- Cite only ids that appear below. Never invent an id.
- If the passages do not support a verdict for an ingredient, omit that ingredient entirely rather than guessing.
- status must be exactly one of "Good", "Bad", "Neutral".
- Return ONLY a JSON array. No markdown fence, no prose, no trailing commas.

REFERENCE PASSAGES:
${contextBlock}

INGREDIENTS TO ANALYSE:
${ingredients.map((name) => `- ${name}`).join("\n")}

Return a JSON array shaped like:
[{"ingredient":"sodium benzoate","status":"Bad","reason":"EFSA assessed overexposure risk as high","concerns":["overexposure"],"citations":["C1"]}]`;
}

function parseJsonArray(text, extractJsonArray) {
  const parsed = extractJsonArray(text);
  if (!parsed) return null;
  return parsed;
}

/**
 * @param {string[]} ingredientNames
 * @param {{retriever: object, complete: (prompt: string) => Promise<string>, extractJsonArray: (text: string) => any}} deps
 *        `complete` and `extractJsonArray` are injected so the whole grounded
 *        path is testable without an API key.
 */
export async function analyzeGrounded(ingredientNames, { retriever, complete, extractJsonArray }) {
  const names = [...new Set(ingredientNames.map((name) => name.trim()).filter(Boolean))].slice(0, MAX_INGREDIENTS);

  if (names.length === 0) {
    throw new AppError("No ingredients to analyse", { code: "NO_INGREDIENTS", statusCode: 422 });
  }

  // 1. Retrieve per ingredient. An ingredient whose retrieval abstains never
  //    reaches the model.
  const grounded = [];
  const uncovered = [];
  const chunkOrder = [];
  const seenChunks = new Set();

  // Retrieval and generation are timed apart. They are the two halves of this
  // function and they are slow for entirely different reasons - one is our own
  // CPU embedding N ingredient names, the other is a network round trip - so a
  // single combined number cannot tell you which one to work on.
  const startedRetrieval = performance.now();
  let modelMs = 0;

  for (const name of names) {
    const outcome = await retriever.retrieve(name, { topK: CHUNKS_PER_INGREDIENT });

    if (outcome.abstain) {
      uncovered.push({
        ingredient: name,
        reason: "No authoritative source found for this ingredient in the Open Food Facts corpus.",
        topCosine: Number(outcome.topCosine.toFixed(3)),
      });
      continue;
    }

    grounded.push(name);
    for (const chunk of outcome.results) {
      if (seenChunks.has(chunk.id) || chunkOrder.length >= MAX_CONTEXT_CHUNKS) continue;
      seenChunks.add(chunk.id);
      chunkOrder.push(chunk);
    }
  }

  const retrievalMs = Math.round(performance.now() - startedRetrieval);

  if (grounded.length === 0) {
    logger.info("grounded analysis abstained for every ingredient", { ingredients: names.length });
    return { verdicts: [], uncovered, contextChunks: [], attempts: 0, grounded: true, retrievalMs, modelMs: 0 };
  }

  const { block, byId } = buildContextBlock(chunkOrder);
  const allowedIds = new Set(byId.keys());
  const basePrompt = buildPrompt(block, grounded);

  let lastFailure = null;

  // 2. Generate, validate, and retry once. The retry names the specific
  //    citations that did not resolve rather than repeating the rules.
  for (const attempt of [1, 2]) {
    const prompt =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\nYour previous answer was rejected: ${lastFailure}. Cite only ids listed above, and omit any ingredient you cannot cite.`;

    const startedModel = performance.now();
    const completion = await complete(prompt);
    modelMs += Math.round(performance.now() - startedModel);

    const raw = parseJsonArray(completion, extractJsonArray);

    if (!raw) {
      lastFailure = "the response contained no JSON array";
      logger.warn("grounded analysis: unparseable model response", { attempt });
      continue;
    }

    const parsed = [];
    let schemaRejected = 0;
    for (const row of raw) {
      const result = groundedVerdictSchema.safeParse(row);
      if (result.success) parsed.push(result.data);
      else schemaRejected += 1;
    }

    const { valid, invalid } = validateCitations(parsed, allowedIds);

    if (valid.length === 0) {
      lastFailure =
        invalid.length > 0
          ? invalid[0].reason
          : `every row failed schema validation (${schemaRejected} rows)`;
      logger.warn("grounded analysis: no citable verdicts", { attempt, reason: lastFailure });
      continue;
    }

    // 3. An ingredient the model silently dropped is uncovered, not missing.
    //    Say which, rather than quietly returning a shorter list.
    const answered = new Set(valid.map((verdict) => verdict.ingredient.toLowerCase()));
    for (const name of grounded) {
      if (!answered.has(name.toLowerCase())) {
        uncovered.push({
          ingredient: name,
          reason: "Retrieved passages did not support a verdict for this ingredient.",
        });
      }
    }

    if (invalid.length > 0 || schemaRejected > 0) {
      logger.warn("grounded analysis: dropped unusable rows", {
        attempt,
        uncitable: invalid.length,
        schemaRejected,
      });
    }

    return {
      verdicts: attachSources(valid, byId),
      uncovered,
      contextChunks: chunkOrder.map((chunk) => ({ id: chunk.id, title: chunk.title, source: chunk.source })),
      attempts: attempt,
      droppedRows: invalid.length + schemaRejected,
      grounded: true,
      retrievalMs,
      modelMs,
    };
  }

  throw new AppError("Could not produce a grounded analysis for this label.", {
    code: "GROUNDED_ANALYSIS_FAILED",
    statusCode: 502,
    details: lastFailure,
  });
}

export default { analyzeGrounded, buildContextBlock, validateCitations, attachSources, buildPrompt };
