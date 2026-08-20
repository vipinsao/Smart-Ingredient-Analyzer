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

// Target size of the passage block in the prompt.
//
// A target, not a hard ceiling: `contextBudgetFor` raises it to the number of
// ingredients that actually have evidence. See the comment there for why the
// budget is the thing that bends.
export const MAX_CONTEXT_CHUNKS = 24;

/**
 * Why an ingredient carries no verdict.
 *
 * These are three different facts about the world and they must not share one
 * sentence:
 *
 *   NO_SOURCE      - retrieval found nothing above threshold. The corpus does
 *                    not cover this ingredient. This is the honest gap, and
 *                    reporting it is what this module is for.
 *   MODEL_DECLINED - passages WERE put in front of the model and it still
 *                    would not rule.
 *   BUDGET_DROPPED - passages were retrieved, cleared both thresholds, and
 *                    were then dropped to fit the prompt. Nothing was asked
 *                    about this ingredient at all.
 *
 * The third used to be reported as the second, which read to the user as the
 * first. Every ingredient that cleared retrieval was pushed onto the prompt's
 * ingredient list, but its passages were only added while the shared
 * MAX_CONTEXT_CHUNKS budget lasted - so past roughly eight ingredients the
 * later ones were named in the prompt with none of their evidence attached.
 * The model correctly declined, and the sweep below announced "Retrieved
 * passages did not support a verdict" about passages that had supported one
 * perfectly well and were then deleted. For a tool whose entire product is
 * that the gap it reports can be trusted, a misattributed gap is the worst
 * available failure, so the three now travel with a code.
 */
export const UNCOVERED_NO_SOURCE = "NO_SOURCE";
export const UNCOVERED_MODEL_DECLINED = "MODEL_DECLINED";
export const UNCOVERED_BUDGET_DROPPED = "BUDGET_DROPPED";

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
 * The passage budget for one request.
 *
 * Bounding the prompt is a real constraint - 25 ingredients times 3 passages
 * is a prompt several times larger than the answer it asks for - so
 * MAX_CONTEXT_CHUNKS stays. What cannot stay is a budget below one passage per
 * ingredient, because that does not shrink the prompt honestly: it deletes the
 * evidence and leaves the question, which is exactly how the truncation defect
 * manufactured a false gap report.
 *
 * So the budget bends before the guarantee does. MAX_INGREDIENTS caps the
 * floor at 25 - one passage above the target, not an unbounded prompt.
 */
export function contextBudgetFor(ingredientCount, target = MAX_CONTEXT_CHUNKS) {
  return Math.max(target, ingredientCount);
}

/**
 * Fair-share the passage budget across ingredients instead of spending it
 * front to back.
 *
 * Round n hands every ingredient its n-th best passage before any ingredient
 * receives its (n+1)-th. A budget of at least one per ingredient therefore
 * covers every ingredient, and any shortfall costs the *supporting* passages
 * of the last ingredients rather than every passage of some of them.
 *
 * An ingredient whose top passage was already selected for an earlier
 * ingredient counts as covered: the evidence is in the prompt, which is the
 * only thing that matters here.
 *
 * `dropped` is the guard. With the budget floor above it is empty, but it is
 * returned rather than assumed so that a future budget change surfaces as a
 * named category instead of as a silent lie about retrieval.
 *
 * @param {{name: string, results: Array}[]} retrieved
 * @param {number} budget
 * @returns {{chunks: Array, covered: string[], dropped: string[]}}
 */
export function selectContextChunks(retrieved, budget) {
  const chunks = [];
  const seen = new Set();
  const covered = new Set();
  const rounds = retrieved.reduce((most, entry) => Math.max(most, entry.results.length), 0);

  for (let round = 0; round < rounds; round += 1) {
    for (const entry of retrieved) {
      const chunk = entry.results[round];
      if (!chunk) continue;
      if (seen.has(chunk.id)) {
        covered.add(entry.name);
        continue;
      }
      if (chunks.length >= budget) continue;
      seen.add(chunk.id);
      chunks.push(chunk);
      covered.add(entry.name);
    }
  }

  return {
    chunks,
    covered: retrieved.filter((entry) => covered.has(entry.name)).map((entry) => entry.name),
    dropped: retrieved.filter((entry) => !covered.has(entry.name)).map((entry) => entry.name),
  };
}

/** Fold a free-text ingredient name to a comparison key. */
export function ingredientKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The keys one ingredient name may legitimately be written as.
 *
 * A label says "Sodium Benzoate (E211)"; a model answering about it writes
 * "sodium benzoate", or occasionally "E211". All three are the same
 * ingredient, and they are the only three - this deliberately does not do
 * fuzzy or substring matching, because "sugar" matching "sugar syrup" would
 * attribute a verdict to an ingredient nobody ruled on, which is the same
 * class of error as the one this file exists to prevent.
 */
export function ingredientKeys(name) {
  const text = String(name);
  const keys = [ingredientKey(text)];

  const withoutParens = ingredientKey(text.replace(/\([^)]*\)/g, " "));
  if (withoutParens) keys.push(withoutParens);

  for (const match of text.matchAll(/\(([^)]*)\)/g)) {
    const inner = ingredientKey(match[1]);
    if (inner) keys.push(inner);
  }

  return [...new Set(keys.filter(Boolean))];
}

/**
 * Attribute each verdict back to the ingredient that was asked about.
 *
 * The model writes the `ingredient` field itself and does not always echo the
 * label's wording - "Sodium Benzoate (E211)" comes back as "sodium benzoate".
 * Comparing those with an exact lowercased `===` counted the same ingredient
 * as an answer in `analysis` and as a non-answer in `uncovered` at the same
 * time, so `coverage.analysed + coverage.uncovered` exceeded `coverage.parsed`
 * - a coverage report that does not add up is not a coverage report.
 *
 * Matched verdicts are relabelled with the label's own wording so every list
 * the caller renders is keyed on the same names. A verdict naming no requested
 * ingredient - or a second verdict for one already answered - is not an answer
 * to a question that was asked, and is returned separately rather than counted.
 *
 * @returns {{matched: Array, unmatched: Array, unanswered: string[]}}
 */
export function matchVerdictsToNames(verdicts, names) {
  // First writing of a key wins, so two label entries that fold to the same
  // alias ("Sugar (cane)" and "Sugar (invert)" both fold to "sugar") resolve
  // to the earlier one and the second verdict lands in `unmatched` rather than
  // being counted twice.
  const byKey = new Map();
  for (const name of names) {
    for (const key of ingredientKeys(name)) {
      if (!byKey.has(key)) byKey.set(key, name);
    }
  }

  const matched = [];
  const unmatched = [];
  const answered = new Set();

  for (const verdict of verdicts) {
    const name = ingredientKeys(verdict.ingredient)
      .map((key) => byKey.get(key))
      .find(Boolean);

    if (!name || answered.has(name)) {
      unmatched.push(verdict);
      continue;
    }
    answered.add(name);
    matched.push({ ...verdict, ingredient: name });
  }

  return { matched, unmatched, unanswered: names.filter((name) => !answered.has(name)) };
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

/**
 * The retry prompt, exported so the evaluation harness asks for a repair in
 * exactly the words the request path uses. A harness that re-words the retry
 * is measuring a prompt this application never sends.
 */
export function buildRetryPrompt(basePrompt, failure) {
  return `${basePrompt}\n\nYour previous answer was rejected: ${failure}. Cite only ids listed above, and omit any ingredient you cannot cite.`;
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
export async function analyzeGrounded(
  ingredientNames,
  { retriever, complete, extractJsonArray, maxContextChunks = MAX_CONTEXT_CHUNKS }
) {
  const names = [...new Set(ingredientNames.map((name) => name.trim()).filter(Boolean))].slice(0, MAX_INGREDIENTS);

  if (names.length === 0) {
    throw new AppError("No ingredients to analyse", { code: "NO_INGREDIENTS", statusCode: 422 });
  }

  // 1. Retrieve per ingredient. An ingredient whose retrieval abstains never
  //    reaches the model.
  const retrieved = [];
  const uncovered = [];

  // Retrieval and generation are timed apart. They are the two halves of this
  // function and they are slow for entirely different reasons - one is our own
  // CPU embedding N ingredient names, the other is a network round trip - so a
  // single combined number cannot tell you which one to work on.
  const startedRetrieval = performance.now();
  let modelMs = 0;

  for (const name of names) {
    const outcome = await retriever.retrieve(name, { topK: CHUNKS_PER_INGREDIENT });

    // No passages is the same fact as abstaining: nothing was found. Letting
    // it through here would name the ingredient in the prompt with no evidence
    // behind it, which is the defect this whole path was rewritten to remove.
    if (outcome.abstain || outcome.results.length === 0) {
      uncovered.push({
        ingredient: name,
        code: UNCOVERED_NO_SOURCE,
        reason: "No authoritative source found for this ingredient in the Open Food Facts corpus.",
        topCosine: Number((outcome.topCosine ?? 0).toFixed(3)),
      });
      continue;
    }

    retrieved.push({ name, results: outcome.results });
  }

  const retrievalMs = Math.round(performance.now() - startedRetrieval);

  // 1b. Select the passages BEFORE naming the ingredients, and name only the
  //     ingredients whose passages survived selection. The prompt can then
  //     only ask about evidence it is actually carrying.
  const budget = contextBudgetFor(retrieved.length, maxContextChunks);
  const { chunks: chunkOrder, covered: grounded, dropped } = selectContextChunks(retrieved, budget);

  for (const name of dropped) {
    uncovered.push({
      ingredient: name,
      code: UNCOVERED_BUDGET_DROPPED,
      reason:
        "Sources for this ingredient were retrieved but did not fit this request's evidence budget, so it was never put to the model. Analyse a shorter ingredient list for a verdict on it.",
    });
  }

  if (dropped.length > 0) {
    logger.warn("grounded analysis: evidence budget dropped ingredients", {
      dropped: dropped.length,
      budget,
      ingredients: retrieved.length,
    });
  }

  if (grounded.length === 0) {
    logger.info("grounded analysis abstained for every ingredient", { ingredients: names.length });
    return {
      verdicts: [],
      uncovered,
      contextChunks: [],
      attempts: 0,
      grounded: true,
      considered: names,
      retrievalMs,
      modelMs: 0,
    };
  }

  const { block, byId } = buildContextBlock(chunkOrder);
  const allowedIds = new Set(byId.keys());
  const basePrompt = buildPrompt(block, grounded);

  let lastFailure = null;

  // 2. Generate, validate, and retry once. The retry names the specific
  //    citations that did not resolve rather than repeating the rules.
  for (const attempt of [1, 2]) {
    const prompt = attempt === 1 ? basePrompt : buildRetryPrompt(basePrompt, lastFailure);

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
    const { matched, unmatched, unanswered } = matchVerdictsToNames(valid, grounded);

    if (matched.length === 0) {
      lastFailure =
        invalid.length > 0
          ? invalid[0].reason
          : unmatched.length > 0
            ? "no verdict named an ingredient from the label"
            : `every row failed schema validation (${schemaRejected} rows)`;
      logger.warn("grounded analysis: no citable verdicts", { attempt, reason: lastFailure });
      continue;
    }

    // 3. An ingredient that was named in the prompt WITH its passages and that
    //    the model still would not rule on is uncovered for that reason and
    //    for no other. Every other reason left this list above, carrying its
    //    own code.
    for (const name of unanswered) {
      uncovered.push({
        ingredient: name,
        code: UNCOVERED_MODEL_DECLINED,
        reason: "Retrieved passages did not support a verdict for this ingredient.",
      });
    }

    if (invalid.length > 0 || schemaRejected > 0 || unmatched.length > 0) {
      logger.warn("grounded analysis: dropped unusable rows", {
        attempt,
        uncitable: invalid.length,
        schemaRejected,
        unattributable: unmatched.length,
      });
    }

    return {
      verdicts: attachSources(matched, byId),
      uncovered,
      contextChunks: chunkOrder.map((chunk) => ({ id: chunk.id, title: chunk.title, source: chunk.source })),
      attempts: attempt,
      droppedRows: invalid.length + schemaRejected + unmatched.length,
      grounded: true,
      // Every name this call actually considered. verdicts.length +
      // uncovered.length === considered.length, always: that is the invariant
      // `coverage` is rendered from.
      considered: names,
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

export default {
  analyzeGrounded,
  buildContextBlock,
  contextBudgetFor,
  selectContextChunks,
  ingredientKey,
  ingredientKeys,
  matchVerdictsToNames,
  validateCitations,
  attachSources,
  buildPrompt,
  buildRetryPrompt,
};
