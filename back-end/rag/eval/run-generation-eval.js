// rag/eval/run-generation-eval.js - The generation half of the evaluation.
//
//   npm run eval:generation                 measure, deterministic scoring only
//   npm run eval:generation -- --judge      add the optional LLM-as-judge pass
//   npm run eval:generation -- --limit 10   a cheap smoke run
//
// `npm run eval` measures everything up to the model call and needs no key.
// This measures what happens after it and therefore does need one. WITHOUT
// GROQ_API_KEY IT PRINTS WHAT IT WOULD HAVE MEASURED AND EXITS 0 - it is wired
// into CI on those terms, so a missing key can never fail a build.
//
// What it measures, over the same 58 hand-labelled questions run-eval.js uses:
//
//   citation validity     does every cited id name a passage that was really
//                         in the prompt (exact)
//   groundedness          does each verdict's stated reason trace back to the
//                         passage it cites (a deterministic proxy, plus an
//                         optional judge - see DECISIONS.md decision 17)
//   post-generation       the second line of defence: when retrieval fails to
//   abstention            abstain on an out-of-corpus question, does the model
//                         still decline to invent a verdict
//   cost and latency      the provider's own token counts and wall time per
//                         query. Never estimated - see requestCompletionDetailed.
//
// It drives the application's own prompt builder, retry wording, schema and
// citation validator, but issues the model call itself rather than going
// through analyzeGrounded, because analyzeGrounded's job is to DROP the
// uncitable rows and this harness's job is to count them.
//
// One question per prompt, where the request path batches a whole label's
// ingredients into one. That isolates each question's score; it also means
// these numbers do not describe a 24-passage prompt. Stated, not hidden.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Retriever } from "../retriever.js";
import {
  buildContextBlock,
  buildPrompt,
  buildRetryPrompt,
  groundedVerdictSchema,
  validateCitations,
  CHUNKS_PER_INGREDIENT,
} from "../groundedAnalysis.js";
import groqService, { GroqService } from "../../services/groqService.js";
import { LLM_TIMEOUT, LLM_TOKENS } from "../../configuration/constants.js";
import {
  citationReport,
  groundednessReport,
  judgePrompt,
  parseJudgement,
  LEXICAL_SUPPORT_THRESHOLD,
} from "./generation-metrics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const { questions } = JSON.parse(fs.readFileSync(path.join(here, "questions.json"), "utf8"));

const args = process.argv.slice(2);
const useJudge = args.includes("--judge");
const limitFlag = args.indexOf("--limit");
const limit = limitFlag === -1 ? Infinity : Number(args[limitFlag + 1]);

// --- The skip path -------------------------------------------------------
// Exit 0, loudly. A build that goes red because a secret is absent teaches
// everyone to ignore it, and this measurement is optional by design.
if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY.trim() === "") {
  console.log(
    "SKIPPED: the generation evaluation needs GROQ_API_KEY, which is not set.\n" +
      "\n" +
      "  Nothing was measured. No numbers are reported, and none are estimated.\n" +
      `  It would have run ${questions.length} labelled questions through retrieval and the\n` +
      "  model, and scored citation validity, groundedness, post-generation\n" +
      "  abstention and per-query tokens and latency.\n" +
      "\n" +
      "  A free key with no credit card: https://console.groq.com/keys\n" +
      "  Then:  GROQ_API_KEY=... npm run eval:generation\n" +
      "\n" +
      "  The scoring functions themselves are unit-tested without a key:\n" +
      "    node --test tests/generation-metrics.test.js\n" +
      "  and everything up to the model call is measured by:  npm run eval"
  );
  process.exit(0);
}

const retriever = Retriever.load();
const selected = questions.slice(0, Number.isFinite(limit) ? limit : questions.length);
const maxTokens = LLM_TOKENS.normal;
const timeoutMs = LLM_TIMEOUT.normal;

console.log(
  `corpus: ${retriever.meta.chunks} chunks (${retriever.meta.model})\n` +
    `model:  ${groqService.model}\n` +
    `questions: ${selected.length}${selected.length < questions.length ? ` of ${questions.length} (--limit)` : ""}\n` +
    `judge:  ${useJudge ? `on (${groqService.model} judging its own output - see the caveat printed below)` : "off"}\n`
);

/** One model call, with its cost. Failures are recorded, never thrown away. */
async function complete(prompt) {
  return groqService.requestCompletionDetailed(prompt, maxTokens, timeoutMs);
}

/** Parse a completion into schema-valid verdicts, counting what did not survive. */
function parseVerdicts(content) {
  const raw = GroqService.extractJsonArray(content);
  if (!raw) return { verdicts: [], schemaRejected: 0, unparseable: true };

  const verdicts = [];
  let schemaRejected = 0;
  for (const row of raw) {
    const result = groundedVerdictSchema.safeParse(row);
    if (result.success) verdicts.push(result.data);
    else schemaRejected += 1;
  }
  return { verdicts, schemaRejected, unparseable: false };
}

const records = [];
// question id -> (citation id -> the passage text the model was shown. Kept
// beside the records rather than inside them: the judge needs it, the results
// file would be ten times the size for it.
const shownPassages = new Map();
let failures = 0;

for (const question of selected) {
  const inCorpus = question.expectedPassages.length > 0;
  const startedRetrieval = performance.now();
  const outcome = await retriever.retrieve(question.question, { topK: CHUNKS_PER_INGREDIENT });
  const retrievalMs = Math.round(performance.now() - startedRetrieval);

  // Retrieval abstained: no prompt, no tokens, no verdict. Already counted by
  // run-eval.js; recorded here so the two halves add up to the whole set.
  if (outcome.abstain) {
    records.push({
      id: question.id,
      question: question.question,
      category: question.category,
      inCorpus,
      stage: "pre-generation abstention",
      answered: false,
      retrievalMs,
      modelMs: 0,
      usage: null,
    });
    process.stdout.write(".");
    continue;
  }

  const { block, byId } = buildContextBlock(outcome.results);
  const allowedIds = new Set(byId.keys());
  shownPassages.set(
    question.id,
    new Map([...byId].map(([id, chunk]) => [id, `${chunk.title} ${chunk.text}`]))
  );
  const basePrompt = buildPrompt(block, [question.question]);

  const record = {
    id: question.id,
    question: question.question,
    category: question.category,
    inCorpus,
    retrievalMs,
    contextPassages: outcome.results.length,
    promptChars: basePrompt.length,
    attempts: 0,
    modelMs: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, reported: false },
    firstAttempt: null,
    stage: null,
    answered: false,
    citations: null,
    groundedness: [],
  };

  let lastFailure = null;

  try {
    // The application's own control flow: try, validate, retry once with the
    // rejected ids named. Both attempts are scored, because "the retry fixed
    // it" and "it was right first time" are different results.
    for (const attempt of [1, 2]) {
      const prompt = attempt === 1 ? basePrompt : buildRetryPrompt(basePrompt, lastFailure);
      const { content, usage, latencyMs } = await complete(prompt);

      record.attempts = attempt;
      record.modelMs += latencyMs;
      if (usage) {
        record.usage.reported = true;
        record.usage.promptTokens += usage.prompt_tokens ?? 0;
        record.usage.completionTokens += usage.completion_tokens ?? 0;
        record.usage.totalTokens += usage.total_tokens ?? 0;
      }

      const { verdicts, schemaRejected, unparseable } = parseVerdicts(content);
      const citations = citationReport(verdicts, allowedIds);
      const { valid } = validateCitations(verdicts, allowedIds);

      if (attempt === 1) {
        record.firstAttempt = { ...citations, schemaRejected, unparseable, valid: valid.length };
      }

      if (valid.length > 0) {
        record.stage = attempt === 1 ? "answered" : "answered after retry";
        record.answered = true;
        record.citations = citations;
        record.groundedness = valid.map((verdict) => groundednessReport(verdict, byId));
        break;
      }

      lastFailure = unparseable
        ? "the response contained no JSON array"
        : citations.invented.length > 0
          ? `unresolvable citation(s): ${citations.invented.map((entry) => entry.id).join(", ")}`
          : `every row failed schema validation (${schemaRejected} rows)`;

      // An empty array is the model declining, which on an out-of-corpus
      // question is the correct answer and must not be retried into one.
      if (verdicts.length === 0 && schemaRejected === 0 && !unparseable) {
        record.stage = "post-generation abstention";
        record.citations = citations;
        break;
      }

      if (attempt === 2) {
        record.stage = "post-generation abstention";
        record.citations = citations;
        record.rejectedReason = lastFailure;
      }
    }
  } catch (error) {
    failures += 1;
    record.stage = "error";
    record.error = `${error.code ?? error.name}: ${error.message}`;
  }

  records.push(record);
  process.stdout.write(record.stage === "error" ? "!" : record.answered ? "o" : "x");
}

console.log("\n");

// --- Optional LLM-as-judge ------------------------------------------------
// Run last and separately, so the deterministic numbers above are already
// final and are not silently blended with a judged one.
let judged = null;
if (useJudge) {
  const claims = records.flatMap((record) =>
    (record.groundedness ?? [])
      .filter((entry) => entry.scored)
      .map((entry) => ({ id: record.id, entry }))
  );

  const tally = { SUPPORTED: 0, PARTIAL: 0, UNSUPPORTED: 0, unparsed: 0 };
  const disagreements = [];

  for (const { id, entry } of claims) {
    // The judge is shown exactly the passage text the generator was shown.
    const shown = shownPassages.get(id) ?? new Map();
    const texts = entry.citations.map((citationId) => shown.get(citationId)).filter(Boolean);
    if (texts.length === 0) {
      tally.unparsed += 1;
      continue;
    }
    const prompt = judgePrompt(entry.claim, texts);

    try {
      const { content } = await complete(prompt);
      const verdict = parseJudgement(content);
      if (verdict === null) tally.unparsed += 1;
      else tally[verdict] += 1;
      entry.judge = verdict;
      if ((verdict === "SUPPORTED") !== entry.supported) {
        disagreements.push({ id, claim: entry.claim, judge: verdict, lexical: entry.lexicalSupport });
      }
    } catch (error) {
      tally.unparsed += 1;
      entry.judge = null;
      entry.judgeError = error.message;
    }
  }

  judged = { claims: claims.length, ...tally, disagreements };
}

// --- Aggregation ----------------------------------------------------------
const errored = records.filter((record) => record.stage === "error");
const scorable = records.filter((record) => record.stage !== "error");
const reachedModel = scorable.filter((record) => record.stage !== "pre-generation abstention");

const firstAttempts = reachedModel.map((record) => record.firstAttempt).filter(Boolean);
const sum = (values) => values.reduce((total, value) => total + value, 0);

const citationTotals = {
  verdicts: sum(firstAttempts.map((attempt) => attempt.verdicts)),
  verdictsFullyValid: sum(firstAttempts.map((attempt) => attempt.verdictsFullyValid)),
  verdictsUncited: sum(firstAttempts.map((attempt) => attempt.verdictsUncited)),
  citations: sum(firstAttempts.map((attempt) => attempt.citations)),
  citationsResolved: sum(firstAttempts.map((attempt) => attempt.citationsResolved)),
  invented: firstAttempts.flatMap((attempt) => attempt.invented),
  unparseable: firstAttempts.filter((attempt) => attempt.unparseable).length,
  schemaRejected: sum(firstAttempts.map((attempt) => attempt.schemaRejected)),
};

const rate = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator);
const pct = (value) => (value === null ? "n/a" : `${(value * 100).toFixed(0)}%`);

console.log("Citation validity, first attempt (exact: an id either was in the prompt or was not)");
console.log(`  verdicts produced                ${citationTotals.verdicts}`);
console.log(
  `  every citation resolved          ${citationTotals.verdictsFullyValid}  ` +
    `(${pct(rate(citationTotals.verdictsFullyValid, citationTotals.verdicts))} of verdicts)`
);
console.log(`  verdicts with no citation at all  ${citationTotals.verdictsUncited}`);
console.log(
  `  ids cited                        ${citationTotals.citations}, of which ${citationTotals.citationsResolved} resolved ` +
    `(${pct(rate(citationTotals.citationsResolved, citationTotals.citations))})`
);
console.log(`  responses with no JSON array      ${citationTotals.unparseable}`);
console.log(`  rows rejected by the schema       ${citationTotals.schemaRejected}`);
if (citationTotals.invented.length > 0) {
  console.log("  invented ids, by name:");
  for (const entry of citationTotals.invented) console.log(`    ${entry.ingredient} -> ${entry.id}`);
}

const retried = reachedModel.filter((record) => record.attempts === 2);
console.log(
  `\n  the retry fired on ${retried.length} question(s); ` +
    `${retried.filter((record) => record.answered).length} were answered citably on the second attempt`
);

// --- Groundedness ---------------------------------------------------------
const claims = records.flatMap((record) => (record.groundedness ?? []).filter((entry) => entry.scored));
const ratios = claims.map((entry) => entry.lexicalSupport).filter((value) => value !== null).sort((a, b) => a - b);
const at = (quantile) => (ratios.length === 0 ? null : ratios[Math.min(ratios.length - 1, Math.floor(quantile * ratios.length))]);

console.log("\nGroundedness (deterministic)");
console.log(`  claims scored                    ${claims.length}`);
console.log(
  `  claims stating a figure no cited passage contains  ` +
    `${claims.filter((entry) => entry.unsupportedNumerals.length > 0).length}   <- exact, and a hard signal`
);
console.log(
  `  lexical support ratio            ` +
    (ratios.length === 0
      ? "n/a"
      : `min ${at(0).toFixed(2)} p25 ${at(0.25).toFixed(2)} median ${at(0.5).toFixed(2)} p75 ${at(0.75).toFixed(2)} max ${at(0.999).toFixed(2)}`)
);
console.log(
  `  at or above the ${LEXICAL_SUPPORT_THRESHOLD} reporting line  ` +
    `${claims.filter((entry) => (entry.lexicalSupport ?? 0) >= LEXICAL_SUPPORT_THRESHOLD).length}/${claims.length}`
);
console.log(
  "  The ratio is a PROXY for attribution: it marks a correct paraphrase\n" +
    "  unsupported and a negated claim supported. The distribution is the\n" +
    "  finding; the count above the line is a summary of it, and 0.6 is a\n" +
    "  reporting convention, not a calibrated threshold. There is no\n" +
    "  human-labelled set for this corpus to calibrate one against."
);

if (judged) {
  console.log("\nGroundedness (LLM-as-judge)");
  console.log(`  claims judged   ${judged.claims}`);
  console.log(`  SUPPORTED ${judged.SUPPORTED}  PARTIAL ${judged.PARTIAL}  UNSUPPORTED ${judged.UNSUPPORTED}  unparsed ${judged.unparsed}`);
  console.log(`  disagreed with the lexical proxy on ${judged.disagreements.length} claim(s)`);
  console.log(
    `  CAVEAT, and it is not a small one: the judge is ${groqService.model}, the same\n` +
      "  model that wrote these claims, so a self-preference bias is expected and\n" +
      "  is not corrected for here. The judge's own accuracy is UNMEASURED,\n" +
      "  because no human-labelled set of grounded and ungrounded verdicts exists\n" +
      "  for this corpus. Treat this as a second opinion with a known conflict of\n" +
      "  interest, never as ground truth. DECISIONS.md decision 17."
  );
}

// --- Abstention, post-generation -----------------------------------------
// The layered defence: retrieval refuses first, and when it does not, the
// model is supposed to decline rather than invent. This scores the second
// layer only - the first is scored by npm run eval.
const leaked = scorable.filter((record) => !record.inCorpus && record.stage !== "pre-generation abstention");
const leakedRefused = leaked.filter((record) => !record.answered);
const inCorpusReached = reachedModel.filter((record) => record.inCorpus);
const wronglyRefused = inCorpusReached.filter((record) => !record.answered);

console.log("\nPost-generation abstention (the second line of defence)");
console.log(
  `  out-of-corpus questions retrieval let through   ${leaked.length}\n` +
    `    of those, generation still declined          ${leakedRefused.length}  (${pct(rate(leakedRefused.length, leaked.length))})`
);
for (const record of leaked) {
  console.log(`      ${record.answered ? "ANSWERED " : "declined "} [${record.category}] ${record.question}`);
}
console.log(
  `  in-corpus questions that reached the model     ${inCorpusReached.length}\n` +
    `    wrongly refused (over-abstention)            ${wronglyRefused.length}  (${pct(rate(wronglyRefused.length, inCorpusReached.length))})`
);
for (const record of wronglyRefused) {
  console.log(`      [${record.category}] ${record.question}${record.rejectedReason ? ` - ${record.rejectedReason}` : ""}`);
}

// --- Cost and latency -----------------------------------------------------
const withUsage = reachedModel.filter((record) => record.usage?.reported);
const modelLatencies = reachedModel.map((record) => record.modelMs).sort((a, b) => a - b);
const latencyAt = (quantile) =>
  modelLatencies.length === 0 ? null : modelLatencies[Math.min(modelLatencies.length - 1, Math.floor(quantile * modelLatencies.length))];

console.log("\nCost and latency per query (queries that reached the model)");
if (withUsage.length === 0) {
  console.log(
    "  The endpoint reported no `usage` block, so there are no token counts.\n" +
      "  They are left absent rather than estimated from the character count."
  );
} else {
  const promptTokens = sum(withUsage.map((record) => record.usage.promptTokens));
  const completionTokens = sum(withUsage.map((record) => record.usage.completionTokens));
  console.log(`  queries with a provider token count  ${withUsage.length}/${reachedModel.length}`);
  console.log(
    `  prompt tokens      total ${promptTokens}, mean ${Math.round(promptTokens / withUsage.length)} per query`
  );
  console.log(
    `  completion tokens  total ${completionTokens}, mean ${Math.round(completionTokens / withUsage.length)} per query`
  );
  console.log(`  total tokens       ${promptTokens + completionTokens}`);
  console.log(
    "  Tokens, not money. Groq's free tier charges nothing for these, and this\n" +
      "  harness does not know a price to multiply by, so it does not invent one."
  );
}
console.log(
  `  model wall time    p50 ${latencyAt(0.5)?.toFixed(0) ?? "n/a"}ms  p95 ${latencyAt(0.95)?.toFixed(0) ?? "n/a"}ms  ` +
    `max ${modelLatencies[modelLatencies.length - 1]?.toFixed(0) ?? "n/a"}ms\n` +
    "  Network latency to the provider from this machine is in these numbers\n" +
    "  and is not a property of the code."
);

if (errored.length > 0) {
  console.log(`\n${errored.length} question(s) failed outright and are excluded from every rate above:`);
  for (const record of errored) console.log(`  ${record.id} ${record.question} - ${record.error}`);
}

const results = {
  measuredAt: new Date().toISOString(),
  model: groqService.model,
  corpus: retriever.meta,
  questions: { selected: selected.length, ofTotal: questions.length },
  method:
    "one question per prompt through the application's own prompt builder, retry wording, schema and citation validator; " +
    "the model call is issued by the harness so the raw response can be scored before the request path drops its unusable rows",
  citationValidityFirstAttempt: citationTotals,
  retry: { fired: retried.length, recovered: retried.filter((record) => record.answered).length },
  groundedness: {
    deterministic: {
      claimsScored: claims.length,
      withUnsupportedNumerals: claims.filter((entry) => entry.unsupportedNumerals.length > 0).length,
      lexicalSupportThreshold: LEXICAL_SUPPORT_THRESHOLD,
      atOrAboveThreshold: claims.filter((entry) => (entry.lexicalSupport ?? 0) >= LEXICAL_SUPPORT_THRESHOLD).length,
      ratios,
      caveat:
        "lexical overlap is a proxy for attribution: it marks a correct paraphrase unsupported and a negated claim supported. " +
        "0.6 is a reporting convention; no human-labelled set exists for this corpus to calibrate one.",
    },
    judge: judged
      ? {
          ...judged,
          model: groqService.model,
          caveat:
            "the judge is the same model that wrote the claims (self-preference bias, uncorrected) and its own accuracy is " +
            "unmeasured for want of human labels; a second opinion with a known conflict of interest, not ground truth",
        }
      : null,
  },
  postGenerationAbstention: {
    leakedPastRetrieval: leaked.length,
    declinedByGeneration: leakedRefused.length,
    inCorpusReachingModel: inCorpusReached.length,
    wronglyRefused: wronglyRefused.length,
  },
  cost: {
    queriesWithProviderTokenCount: withUsage.length,
    promptTokens: sum(withUsage.map((record) => record.usage.promptTokens)),
    completionTokens: sum(withUsage.map((record) => record.usage.completionTokens)),
    note: "provider-reported token counts only; absent rather than estimated when the endpoint reports none",
  },
  latencyMs: {
    modelP50: latencyAt(0.5),
    modelP95: latencyAt(0.95),
    measuredOn: `${os.cpus()[0]?.model ?? "unknown cpu"}, ${process.version}`,
    note: "includes network latency to the provider; machine- and link-dependent, do not quote as a property of the code",
  },
  failures,
  records,
};

fs.writeFileSync(path.join(here, "generation-results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log("\nwrote rag/eval/generation-results.json");
