// rag/eval/run-eval.js - Retrieval evaluation and the dense/lexical/hybrid
// ablation.
//
//   npm run eval
//
// Needs no API key: everything measured here happens before the model is
// called, which is also why it can run in CI on every push.
//
// Every number the README quotes about retrieval is produced by this file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Retriever, ABSTAIN_MIN_COSINE, ABSTAIN_MIN_LEXICAL, DENSE_FUSION_WEIGHT } from "../retriever.js";
import { embedOne } from "../embedder.js";
import { buildContextBlock, buildPrompt, MAX_CONTEXT_CHUNKS } from "../groundedAnalysis.js";
import AnalysisHelpers from "../../utils/helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const { questions } = JSON.parse(fs.readFileSync(path.join(here, "questions.json"), "utf8"));

// CI gate. Set from the measured baseline, low enough that noise does not
// break the build and high enough that a real regression does.
const RECALL_AT_5_FLOOR = 0.85;

const retriever = Retriever.load();
const inCorpus = questions.filter((question) => question.expectedPassages.length > 0);
const outOfCorpus = questions.filter((question) => question.expectedPassages.length === 0);

console.log(
  `corpus: ${retriever.meta.chunks} chunks from ${retriever.meta.passages} passages ` +
    `(${retriever.meta.model}, ${retriever.meta.dimensions}d)\n` +
    `questions: ${inCorpus.length} in corpus, ${outOfCorpus.length} out of corpus\n`
);

const MODES = ["dense", "lexical", "hybrid"];
const K_VALUES = [1, 3, 5];

/** Did any retrieved chunk come from a passage that answers the question? */
function isHit(results, expectedPassages, k) {
  return results.slice(0, k).some((chunk) => expectedPassages.includes(chunk.passageId));
}

const perMode = {};
const latencies = [];
const signals = [];

for (const mode of MODES) {
  const hits = Object.fromEntries(K_VALUES.map((k) => [k, 0]));
  const byCategory = {};

  for (const question of inCorpus) {
    const started = performance.now();
    const outcome = await retriever.retrieve(question.question, { topK: 5, mode });
    const elapsed = performance.now() - started;
    if (mode === "hybrid") latencies.push(elapsed);

    byCategory[question.category] ??= { total: 0, hit5: 0 };
    byCategory[question.category].total += 1;

    for (const k of K_VALUES) {
      if (isHit(outcome.results, question.expectedPassages, k)) hits[k] += 1;
    }
    if (isHit(outcome.results, question.expectedPassages, 5)) byCategory[question.category].hit5 += 1;
  }

  perMode[mode] = {
    recall: Object.fromEntries(K_VALUES.map((k) => [k, hits[k] / inCorpus.length])),
    byCategory,
  };
}

// --- Ablation table -------------------------------------------------------
console.log("Recall@k by retrieval mode");
console.log("mode      | recall@1 | recall@3 | recall@5");
console.log("----------|----------|----------|---------");
for (const mode of MODES) {
  const { recall } = perMode[mode];
  console.log(
    `${mode.padEnd(9)} |   ${(recall[1] * 100).toFixed(0).padStart(4)}%  |   ${(recall[3] * 100)
      .toFixed(0)
      .padStart(4)}%  |   ${(recall[5] * 100).toFixed(0).padStart(4)}%`
  );
}

// --- Fusion weight sweep --------------------------------------------------
// Published so the choice of DENSE_FUSION_WEIGHT can be checked rather than
// taken on trust.
console.log("\nHybrid fusion weight sweep (lexical weight fixed at 1.0)");
console.log("dense weight | recall@1 | recall@3 | recall@5");
console.log("-------------|----------|----------|---------");
const weightSweep = {};
for (const weight of [0, 0.2, 0.3, 0.5, 0.7, 1.0]) {
  const hits = Object.fromEntries(K_VALUES.map((k) => [k, 0]));
  for (const question of inCorpus) {
    const outcome = await retriever.retrieve(question.question, { topK: 5, mode: "hybrid", denseWeight: weight });
    for (const k of K_VALUES) if (isHit(outcome.results, question.expectedPassages, k)) hits[k] += 1;
  }
  weightSweep[weight] = Object.fromEntries(K_VALUES.map((k) => [k, hits[k] / inCorpus.length]));
  const marker = weight === DENSE_FUSION_WEIGHT ? " <- configured" : "";
  console.log(
    `${String(weight.toFixed(1)).padStart(12)} |   ${(weightSweep[weight][1] * 100).toFixed(0).padStart(4)}%  |   ${(
      weightSweep[weight][3] * 100
    )
      .toFixed(0)
      .padStart(4)}%  |   ${(weightSweep[weight][5] * 100).toFixed(0).padStart(4)}%${marker}`
  );
}

console.log("\nRecall@5 by question category (hybrid)");
console.log("category      | recall@5 | n");
console.log("--------------|----------|---");
for (const [category, counts] of Object.entries(perMode.hybrid.byCategory)) {
  console.log(
    `${category.padEnd(13)} |   ${((counts.hit5 / counts.total) * 100).toFixed(0).padStart(4)}%  | ${counts.total}`
  );
}

// --- Abstention -----------------------------------------------------------
// Collect the raw retrieval signals for every question so the threshold can be
// chosen from the data rather than asserted.
for (const question of questions) {
  const queryVector = await embedOne(question.question);
  const dense = retriever.denseSearch(queryVector, 1);
  const lexical = retriever.lexicalSearch(question.question, 1);

  signals.push({
    id: question.id,
    question: question.question,
    category: question.category,
    inCorpus: question.expectedPassages.length > 0,
    cosine: dense[0]?.score ?? 0,
    bm25: lexical[0]?.score ?? 0,
    // What it retrieved, not just how confident it was. A wrongly answered
    // out-of-corpus question is only diagnosable if you can see what came back.
    topChunk: dense[0] === undefined ? null : retriever.chunks[dense[0].index].title,
  });
}

/** The rule the application uses: abstain only when BOTH retrievers are weak. */
function abstains(signal, cosineThreshold, lexicalThreshold) {
  return signal.cosine < cosineThreshold && signal.bm25 < lexicalThreshold;
}

const describe = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return `min ${sorted[0].toFixed(3)} p25 ${at(0.25).toFixed(3)} median ${at(0.5).toFixed(3)} p75 ${at(
    0.75
  ).toFixed(3)} max ${sorted[sorted.length - 1].toFixed(3)}`;
};

console.log("\nRetrieval signal distribution");
console.log(`  in corpus     cosine: ${describe(signals.filter((s) => s.inCorpus).map((s) => s.cosine))}`);
console.log(`  out of corpus cosine: ${describe(signals.filter((s) => !s.inCorpus).map((s) => s.cosine))}`);
console.log(`  in corpus     bm25:   ${describe(signals.filter((s) => s.inCorpus).map((s) => s.bm25))}`);
console.log(`  out of corpus bm25:   ${describe(signals.filter((s) => !s.inCorpus).map((s) => s.bm25))}`);

function score(cosineThreshold, lexicalThreshold) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (const signal of signals) {
    const abstained = abstains(signal, cosineThreshold, lexicalThreshold);
    if (abstained && !signal.inCorpus) truePositive += 1;
    if (abstained && signal.inCorpus) falsePositive += 1;
    if (!abstained && !signal.inCorpus) falseNegative += 1;
  }

  const precision = truePositive / (truePositive + falsePositive || 1);
  const recall = truePositive / (truePositive + falseNegative || 1);
  const f1 = (2 * precision * recall) / (precision + recall || 1);
  return { truePositive, falsePositive, falseNegative, precision, recall, f1 };
}

// Sweep, so the chosen threshold can be shown to be the best available on this
// question set rather than a number somebody liked.
let best = null;
for (let cosine = 0.20; cosine <= 0.70; cosine += 0.01) {
  for (let lexical = 0; lexical <= 12; lexical += 0.5) {
    const result = score(cosine, lexical);
    if (!best || result.f1 > best.f1 + 1e-9) best = { ...result, cosine, lexical };
  }
}

const configured = score(ABSTAIN_MIN_COSINE, ABSTAIN_MIN_LEXICAL);

// Abstention broken down by why the question is out of corpus. The generic
// out-of-corpus questions are easy; the whole-food ingredient names taken off a
// real label are the hard case, because they share vocabulary with the corpus.
const outByCategory = {};
for (const signal of signals.filter((item) => !item.inCorpus)) {
  outByCategory[signal.category] ??= { total: 0, abstained: 0 };
  outByCategory[signal.category].total += 1;
  if (abstains(signal, ABSTAIN_MIN_COSINE, ABSTAIN_MIN_LEXICAL)) outByCategory[signal.category].abstained += 1;
}

console.log("\nAbstention (a correct abstention is a refusal on an out-of-corpus question)");
for (const [category, counts] of Object.entries(outByCategory)) {
  console.log(`  ${category.padEnd(26)} refused ${counts.abstained}/${counts.total}`);
}
console.log(
  `  configured  cosine < ${ABSTAIN_MIN_COSINE} AND bm25 < ${ABSTAIN_MIN_LEXICAL}  ->  ` +
    `precision ${(configured.precision * 100).toFixed(0)}%  recall ${(configured.recall * 100).toFixed(0)}%  ` +
    `F1 ${configured.f1.toFixed(2)}  (${configured.truePositive} correct, ${configured.falsePositive} wrongly refused, ` +
    `${configured.falseNegative} wrongly answered)`
);
console.log(
  `  best on this set  cosine < ${best.cosine.toFixed(2)} AND bm25 < ${best.lexical.toFixed(1)}  ->  F1 ${best.f1.toFixed(2)}`
);

// The abstention failures by name. A count says the rule is wrong five times;
// this says which five and what the corpus handed back instead, which is the
// part that can be argued about.
const wronglyAnswered = signals.filter(
  (signal) => !signal.inCorpus && !abstains(signal, ABSTAIN_MIN_COSINE, ABSTAIN_MIN_LEXICAL)
);
console.log("\nOut-of-corpus questions the configured rule answers instead of refusing");
for (const signal of wronglyAnswered) {
  console.log(
    `  "${signal.question}" -> ${signal.topChunk ?? "(nothing)"} ` +
      `(cosine ${signal.cosine.toFixed(3)}, bm25 ${signal.bm25.toFixed(1)})`
  );
}
if (wronglyAnswered.length === 0) console.log("  none");

// --- Latency --------------------------------------------------------------
const sortedLatency = [...latencies].sort((a, b) => a - b);
const percentile = (p) => sortedLatency[Math.min(sortedLatency.length - 1, Math.floor(p * sortedLatency.length))];

// Reported, but deliberately not quoted anywhere as a property of the system.
// This is wall-clock on whatever machine happens to run it, over 40 warm
// queries, and it moves by 3x between a laptop and a loaded CI box - so a
// figure like "p50 5.0ms" in a README is precision the method cannot support.
// The argument that does hold is structural and is printed with it.
console.log(
  `\nHybrid retrieval latency over ${latencies.length} queries (warm, embedding included), ` +
    `on THIS machine (${os.cpus()[0]?.model ?? "unknown cpu"}, ${os.availableParallelism()} cores, ${process.version}):\n` +
    `  p50 ${percentile(0.5).toFixed(1)}ms  p95 ${percentile(0.95).toFixed(1)}ms  max ${sortedLatency[sortedLatency.length - 1].toFixed(1)}ms\n` +
    `  Machine- and load-dependent by construction; re-run it rather than quoting it.\n` +
    `  The size argument does not move: ${retriever.meta.chunks} chunks x ${retriever.meta.dimensions} dims = ` +
    `${((retriever.meta.chunks * retriever.meta.dimensions) / 1000).toFixed(0)}k multiply-adds per query, ` +
    `against a model call measured in hundreds of milliseconds.`
);

// Which questions dense retrieval actually earns its place on. The ablation
// table says hybrid does not beat lexical overall; this says where dense still
// contributes, which is the reason it is kept at all.
console.log("\nQuestions where dense retrieval ranks the correct passage higher than BM25");
const rankOf = (results, expectedPassages) => {
  const index = results.findIndex((chunk) => expectedPassages.includes(chunk.passageId));
  return index === -1 ? null : index + 1;
};
let anyDenseWin = false;
for (const question of inCorpus) {
  const [dense, lexical, hybrid] = await Promise.all(
    MODES.map((mode) => retriever.retrieve(question.question, { topK: 5, mode }))
  );
  const ranks = {
    dense: rankOf(dense.results, question.expectedPassages),
    lexical: rankOf(lexical.results, question.expectedPassages),
    hybrid: rankOf(hybrid.results, question.expectedPassages),
  };
  if (ranks.dense !== null && (ranks.lexical === null || ranks.dense < ranks.lexical)) {
    anyDenseWin = true;
    console.log(
      `  "${question.question}" -> dense rank ${ranks.dense}, ` +
        `lexical rank ${ranks.lexical ?? "not in top 5"}, hybrid rank ${ranks.hybrid ?? "not in top 5"}`
    );
  }
}
if (!anyDenseWin) console.log("  none");

console.log("\nQuestions no retrieval mode answers at k=5");
let anyMiss = false;
for (const question of inCorpus) {
  const outcomes = await Promise.all(
    MODES.map((mode) => retriever.retrieve(question.question, { topK: 5, mode }))
  );
  if (outcomes.every((outcome) => !isHit(outcome.results, question.expectedPassages, 5))) {
    anyMiss = true;
    console.log(`  ${question.id} [${question.category}] ${question.question}`);
  }
}
if (!anyMiss) console.log("  none");

// --- Prompt size ----------------------------------------------------------
// What one real label costs in prompt, measured rather than estimated. Only
// the prompt is measurable here: completion length depends on the provider and
// this harness deliberately makes no API call.
const SAMPLE_LABEL =
  "Water, Sugar, Jaggery, Tomato Paste, Tamarind (5%), Iodised Salt, Spices and Condiments, " +
  "Stabilizers (INS1422, INS415), Acidity Regulators (INS260, INS334) and Preservative (INS211).";

const sampleNames = AnalysisHelpers.parseIngredientList(SAMPLE_LABEL);
const sampleChunks = [];
const sampleSeen = new Set();
let sampleAbstained = 0;

for (const name of sampleNames) {
  const outcome = await retriever.retrieve(name, { topK: 3 });
  if (outcome.abstain) {
    sampleAbstained += 1;
    continue;
  }
  for (const chunk of outcome.results) {
    if (sampleSeen.has(chunk.id) || sampleChunks.length >= MAX_CONTEXT_CHUNKS) continue;
    sampleSeen.add(chunk.id);
    sampleChunks.push(chunk);
  }
}

const { block } = buildContextBlock(sampleChunks);
const samplePrompt = buildPrompt(block, sampleNames);

console.log(
  `\nGrounded prompt for one real label (${sampleNames.length} ingredients parsed, ` +
    `${sampleAbstained} abstained before any model call):\n` +
    `  ${sampleChunks.length} context passages, ${samplePrompt.length} characters ` +
    `(~${Math.round(samplePrompt.length / 4)} tokens by the usual 4-characters-per-token rule of thumb - ` +
    `an estimate, not a provider token count)`
);

const results = {
  measuredAt: new Date().toISOString(),
  corpus: retriever.meta,
  questions: { inCorpus: inCorpus.length, outOfCorpus: outOfCorpus.length },
  recall: Object.fromEntries(MODES.map((mode) => [mode, perMode[mode].recall])),
  fusionWeightSweep: weightSweep,
  denseFusionWeight: DENSE_FUSION_WEIGHT,
  byCategory: perMode.hybrid.byCategory,
  abstention: {
    configured: { cosine: ABSTAIN_MIN_COSINE, lexical: ABSTAIN_MIN_LEXICAL, ...configured },
    byCategory: outByCategory,
    best,
  },
  // Recorded with the machine that produced it. Without that, the number gets
  // quoted somewhere as if it were a property of the system.
  latencyMs: {
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sortedLatency[sortedLatency.length - 1],
    measuredOn: `${os.cpus()[0]?.model ?? "unknown cpu"}, ${os.availableParallelism()} cores, ${process.version}`,
    note: "wall clock on one machine over 40 warm queries; machine- and load-dependent, do not quote",
  },
  denseRankWins: [],
  wronglyAnswered: wronglyAnswered.map((signal) => ({
    question: signal.question,
    retrieved: signal.topChunk,
    cosine: Number(signal.cosine.toFixed(3)),
    bm25: Number(signal.bm25.toFixed(1)),
  })),
  samplePrompt: {
    label: SAMPLE_LABEL,
    ingredientsParsed: sampleNames.length,
    abstainedBeforeModel: sampleAbstained,
    contextPassages: sampleChunks.length,
    characters: samplePrompt.length,
  },
};

fs.writeFileSync(path.join(here, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log("\nwrote rag/eval/results.json");

if (perMode.hybrid.recall[5] < RECALL_AT_5_FLOOR) {
  console.error(
    `\nFAIL: hybrid recall@5 is ${(perMode.hybrid.recall[5] * 100).toFixed(0)}%, below the ${(
      RECALL_AT_5_FLOOR * 100
    ).toFixed(0)}% floor.`
  );
  process.exit(1);
}
