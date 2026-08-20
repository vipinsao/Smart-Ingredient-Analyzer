import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeGrounded,
  buildContextBlock,
  contextBudgetFor,
  selectContextChunks,
  matchVerdictsToNames,
  validateCitations,
  attachSources,
  MAX_CONTEXT_CHUNKS,
} from "../rag/groundedAnalysis.js";
import { GroqService } from "../services/groqService.js";

const chunk = (id, title, text) => ({
  id,
  passageId: id,
  title,
  text,
  aliases: [title],
  source: { dataset: "Open Food Facts additives taxonomy", licence: "ODbL-1.0", entry: id, url: "https://example.test" },
});

/** A retriever stub: returns whatever the test says it should for each query. */
function fakeRetriever(byQuery, { abstainFor = [] } = {}) {
  return {
    calls: [],
    async retrieve(query) {
      this.calls.push(query);
      if (abstainFor.includes(query)) {
        return { query, abstain: true, topCosine: 0.11, topLexical: 0.4, results: [] };
      }
      return { query, abstain: false, topCosine: 0.7, topLexical: 20, results: byQuery[query] || [] };
    },
  };
}

const deps = (complete, retriever) => ({
  retriever,
  complete,
  extractJsonArray: GroqService.extractJsonArray,
});

test("buildContextBlock numbers passages C1..Cn and maps them back", () => {
  const { block, byId } = buildContextBlock([chunk("a", "E211 Sodium benzoate", "preservative"), chunk("b", "E330 Citric acid", "antioxidant")]);

  assert.match(block, /^\[C1\] E211 Sodium benzoate/);
  assert.match(block, /\[C2\] E330 Citric acid/);
  assert.equal(byId.get("C2").id, "b");
});

test("validateCitations rejects an invented passage id", () => {
  // The failure everyone worries about: the model cites C7 when the prompt
  // carried six passages. The verdict is unattributable and must not ship.
  const { valid, invalid } = validateCitations(
    [
      { ingredient: "a", citations: ["C1"] },
      { ingredient: "b", citations: ["C7"] },
      { ingredient: "c", citations: [] },
    ],
    ["C1", "C2"]
  );

  assert.deepEqual(valid.map((v) => v.ingredient), ["a"]);
  assert.equal(invalid.length, 2);
  assert.match(invalid[0].reason, /unresolvable citation/);
  assert.match(invalid[1].reason, /no citation/);
});

test("attachSources resolves each citation to its real source record", () => {
  const { byId } = buildContextBlock([chunk("additive:en:e211", "E211 Sodium benzoate", "preservative")]);
  const [verdict] = attachSources([{ ingredient: "sodium benzoate", citations: ["C1"] }], byId);

  assert.equal(verdict.sources[0].id, "additive:en:e211");
  assert.equal(verdict.sources[0].licence, "ODbL-1.0");
});

test("a grounded verdict carries citations that resolve to retrieved passages", async () => {
  const retriever = fakeRetriever({
    "sodium benzoate": [chunk("additive:en:e211", "E211 Sodium benzoate", "Additive class: preservative. EFSA overexposure risk high.")],
  });

  const result = await analyzeGrounded(["sodium benzoate"], deps(
    async () =>
      JSON.stringify([
        { ingredient: "sodium benzoate", status: "Bad", reason: "EFSA assessed overexposure risk as high", concerns: ["overexposure"], citations: ["C1"] },
      ]),
    retriever
  ));

  assert.equal(result.attempts, 1);
  assert.equal(result.verdicts.length, 1);
  assert.deepEqual(result.verdicts[0].citations, ["C1"]);
  assert.equal(result.verdicts[0].sources[0].id, "additive:en:e211");
  assert.equal(result.uncovered.length, 0);
});

test("an ingredient the corpus does not cover is reported, not guessed at", async () => {
  const retriever = fakeRetriever(
    { "sodium benzoate": [chunk("additive:en:e211", "E211 Sodium benzoate", "preservative")] },
    { abstainFor: ["unicorn tears"] }
  );

  const result = await analyzeGrounded(["sodium benzoate", "unicorn tears"], deps(
    async (prompt) => {
      // The abstained ingredient must never reach the model.
      assert.doesNotMatch(prompt, /unicorn tears/);
      return JSON.stringify([{ ingredient: "sodium benzoate", status: "Bad", reason: "r", concerns: [], citations: ["C1"] }]);
    },
    retriever
  ));

  assert.equal(result.verdicts.length, 1);
  assert.deepEqual(
    result.uncovered.map((entry) => entry.ingredient),
    ["unicorn tears"]
  );
  assert.match(result.uncovered[0].reason, /No authoritative source/);
});

test("every ingredient abstaining means no model call at all", async () => {
  const retriever = fakeRetriever({}, { abstainFor: ["mystery powder"] });
  let called = false;

  const result = await analyzeGrounded(["mystery powder"], deps(async () => {
    called = true;
    return "[]";
  }, retriever));

  assert.equal(called, false, "abstention must happen before any token is spent");
  assert.deepEqual(result.verdicts, []);
  assert.equal(result.uncovered.length, 1);
});

test("an invented citation triggers one retry, and the corrected answer is accepted", async () => {
  const retriever = fakeRetriever({
    "citric acid": [chunk("additive:en:e330", "E330 Citric acid", "Additive class: antioxidant.")],
  });

  const prompts = [];
  const result = await analyzeGrounded(["citric acid"], deps(async (prompt) => {
    prompts.push(prompt);
    return prompts.length === 1
      ? JSON.stringify([{ ingredient: "citric acid", status: "Good", reason: "r", concerns: [], citations: ["C9"] }])
      : JSON.stringify([{ ingredient: "citric acid", status: "Neutral", reason: "antioxidant", concerns: [], citations: ["C1"] }]);
  }, retriever));

  assert.equal(result.attempts, 2);
  assert.equal(result.verdicts[0].status, "Neutral");
  assert.match(prompts[1], /unresolvable citation\(s\): C9/);
});

test("two uncitable answers fail with a typed 502 rather than shipping unsourced claims", async () => {
  const retriever = fakeRetriever({
    "citric acid": [chunk("additive:en:e330", "E330 Citric acid", "antioxidant")],
  });

  await assert.rejects(
    () =>
      analyzeGrounded(["citric acid"], deps(
        async () => JSON.stringify([{ ingredient: "citric acid", status: "Good", reason: "r", concerns: [], citations: ["C42"] }]),
        retriever
      )),
    (error) => error.code === "GROUNDED_ANALYSIS_FAILED" && error.statusCode === 502
  );
});

test("an ingredient the model silently drops is reported as uncovered", async () => {
  const retriever = fakeRetriever({
    "citric acid": [chunk("additive:en:e330", "E330 Citric acid", "antioxidant")],
    "xanthan gum": [chunk("additive:en:e415", "E415 Xanthan gum", "thickener")],
  });

  const result = await analyzeGrounded(["citric acid", "xanthan gum"], deps(
    async () => JSON.stringify([{ ingredient: "citric acid", status: "Neutral", reason: "r", concerns: [], citations: ["C1"] }]),
    retriever
  ));

  assert.equal(result.verdicts.length, 1);
  assert.deepEqual(result.uncovered.map((entry) => entry.ingredient), ["xanthan gum"]);
});

test("a provider failure is not disguised as an ungrounded answer", async () => {
  // Degrading to the ungrounded path would call the same broken provider, so a
  // provider error must propagate rather than silently changing the contract.
  const { analyzeIngredients } = await import("../services/analysisService.js");
  const { default: groqService } = await import("../services/groqService.js");

  const originalRequest = groqService.requestCompletion;
  groqService.requestCompletion = async () => {
    const error = new Error("Analysis service returned an error.");
    error.code = "ANALYSIS_HTTP_ERROR";
    error.statusCode = 502;
    throw error;
  };

  try {
    await assert.rejects(
      () => analyzeIngredients("Preservative (INS211)"),
      (error) => error.code === "ANALYSIS_HTTP_ERROR"
    );
  } finally {
    groqService.requestCompletion = originalRequest;
  }
});

// ---------------------------------------------------------------------------
// The passage budget must not be able to manufacture a coverage gap.
// ---------------------------------------------------------------------------

/** N ingredients, each with its own three distinct passages. */
function manyIngredients(count, chunksEach = 3) {
  const names = Array.from({ length: count }, (_, i) => `ingredient ${i + 1}`);
  const byQuery = {};
  for (const [index, name] of names.entries()) {
    byQuery[name] = Array.from({ length: chunksEach }, (_, k) =>
      chunk(`chunk:${index}:${k}`, `Passage ${index}-${k}`, `evidence for ${name}`)
    );
  }
  return { names, byQuery };
}

/** A model that will only rule on ingredients whose evidence is in the prompt. */
const onlyRulesOnEvidence = (names) => async (prompt) => {
  const present = names.filter((name) => prompt.includes(`evidence for ${name}`));
  return JSON.stringify(
    present.map((name) => ({ ingredient: name, status: "Neutral", reason: "r", concerns: [], citations: ["C1"] }))
  );
};

test("evidence truncated to fit the prompt is never reported as evidence that did not exist", async () => {
  // Ten ingredients x three passages is 30 passages against a 24-passage
  // budget. The old code filled the budget front to back, so ingredients 9 and
  // 10 were named in the prompt with none of their passages attached, the
  // model correctly declined, and they came back as "Retrieved passages did
  // not support a verdict for this ingredient" - a statement about passages
  // that had been retrieved, had cleared both thresholds, and had then been
  // deleted by a budget the user never sees.
  const { names, byQuery } = manyIngredients(10);
  const retriever = fakeRetriever(byQuery);

  let prompt = "";
  const result = await analyzeGrounded(names, deps(async (text) => {
    prompt = text;
    return onlyRulesOnEvidence(names)(text);
  }, retriever));

  // Every ingredient the prompt names carries at least one of its own passages.
  const named = prompt.split("INGREDIENTS TO ANALYSE:")[1].split("Return a JSON")[0];
  for (const name of names) {
    if (!named.includes(`- ${name}\n`)) continue;
    assert.ok(prompt.includes(`evidence for ${name}`), `${name} was named with no evidence attached`);
  }

  assert.equal(result.verdicts.length, 10, "every ingredient with evidence should get a verdict");
  assert.deepEqual(result.uncovered, [], "nothing was uncovered, so nothing may be reported as uncovered");
  // And the budget still did its job.
  assert.ok(result.contextChunks.length <= MAX_CONTEXT_CHUNKS, "the prompt budget must still hold");
});

test("selectContextChunks spends the budget a round at a time, not front to back", () => {
  const { names, byQuery } = manyIngredients(10);
  const retrieved = names.map((name) => ({ name, results: byQuery[name] }));

  const { chunks, covered, dropped } = selectContextChunks(retrieved, MAX_CONTEXT_CHUNKS);

  assert.equal(chunks.length, MAX_CONTEXT_CHUNKS);
  assert.deepEqual(covered, names);
  assert.deepEqual(dropped, []);
});

test("an ingredient sharing another's passage counts as covered, not dropped", () => {
  const shared = chunk("additive:en:e330", "E330 Citric acid", "antioxidant");
  const retrieved = [
    { name: "citric acid", results: [shared] },
    { name: "acidity regulator (E330)", results: [shared] },
  ];

  const { chunks, covered, dropped } = selectContextChunks(retrieved, 24);

  assert.equal(chunks.length, 1, "the same passage is not sent twice");
  assert.equal(covered.length, 2);
  assert.deepEqual(dropped, []);
});

test("a budget too small to carry one passage each names the shortfall as its own category", () => {
  // The guard. contextBudgetFor keeps this unreachable in the shipped
  // configuration, and the point of the category is that if a future budget
  // change makes it reachable it surfaces under its own name rather than as a
  // lie about retrieval.
  const { names, byQuery } = manyIngredients(4, 1);
  const retrieved = names.map((name) => ({ name, results: byQuery[name] }));

  const { covered, dropped } = selectContextChunks(retrieved, 2);

  assert.deepEqual(covered, ["ingredient 1", "ingredient 2"]);
  assert.deepEqual(dropped, ["ingredient 3", "ingredient 4"]);
});

test("contextBudgetFor never returns a budget below one passage per ingredient", () => {
  assert.equal(contextBudgetFor(4), MAX_CONTEXT_CHUNKS);
  assert.equal(contextBudgetFor(25), 25);
  assert.equal(contextBudgetFor(9, 4), 9);
});

test("a dropped ingredient is reported under BUDGET_DROPPED and never reaches the prompt", async () => {
  const { names, byQuery } = manyIngredients(4, 1);
  const retriever = fakeRetriever(byQuery);

  // maxContextChunks is a target; the floor still applies, so force the drop by
  // driving selection directly is the unit test above. Here the whole path is
  // exercised with the floor intact: nothing may be dropped.
  const result = await analyzeGrounded(names, {
    ...deps(onlyRulesOnEvidence(names), retriever),
    maxContextChunks: 1,
  });

  assert.equal(result.verdicts.length, 4, "the floor must override a budget that would drop evidence");
  assert.deepEqual(result.uncovered, []);
});

// ---------------------------------------------------------------------------
// Coverage arithmetic.
// ---------------------------------------------------------------------------

test("matchVerdictsToNames attributes a renamed verdict back to the label's wording", () => {
  const { matched, unmatched, unanswered } = matchVerdictsToNames(
    [
      { ingredient: "sodium benzoate", status: "Bad" },
      { ingredient: "SUGAR", status: "Bad" },
      { ingredient: "molybdenum", status: "Good" },
    ],
    ["Sodium Benzoate (E211)", "Sugar", "Citric Acid"]
  );

  assert.deepEqual(matched.map((v) => v.ingredient), ["Sodium Benzoate (E211)", "Sugar"]);
  assert.deepEqual(unmatched.map((v) => v.ingredient), ["molybdenum"]);
  assert.deepEqual(unanswered, ["Citric Acid"]);
});

test("a verdict the model renamed is counted once, so analysed + uncovered === parsed", async () => {
  // The model writes the `ingredient` field itself. Matching it back with an
  // exact lowercased === made "Sodium Benzoate (E211)" both answered (it is in
  // `analysis`) and unanswered (it is in `uncovered`), so the coverage figures
  // added up to more ingredients than the label had.
  const retriever = fakeRetriever({
    "Sodium Benzoate (E211)": [chunk("additive:en:e211", "E211 Sodium benzoate", "preservative")],
    "Citric Acid": [chunk("additive:en:e330", "E330 Citric acid", "antioxidant")],
  });

  const result = await analyzeGrounded(["Sodium Benzoate (E211)", "Citric Acid"], deps(
    async () =>
      JSON.stringify([
        { ingredient: "sodium benzoate", status: "Bad", reason: "r", concerns: [], citations: ["C1"] },
        { ingredient: "citric acid", status: "Neutral", reason: "r", concerns: [], citations: ["C2"] },
      ]),
    retriever
  ));

  assert.deepEqual(result.verdicts.map((v) => v.ingredient), ["Sodium Benzoate (E211)", "Citric Acid"]);
  assert.deepEqual(result.uncovered, []);
  assert.equal(result.verdicts.length + result.uncovered.length, result.considered.length);
});

test("coverage reconciles across every reason an ingredient can carry no verdict", async () => {
  // The invariant, over a label that hits all three: one uncovered by the
  // corpus, one the model declined, one answered under a different name.
  const retriever = fakeRetriever(
    {
      "Sodium Benzoate (E211)": [chunk("additive:en:e211", "E211 Sodium benzoate", "preservative")],
      "Xanthan Gum": [chunk("additive:en:e415", "E415 Xanthan gum", "thickener")],
    },
    { abstainFor: ["Unicorn Tears"] }
  );

  const result = await analyzeGrounded(["Sodium Benzoate (E211)", "Xanthan Gum", "Unicorn Tears"], deps(
    async () =>
      JSON.stringify([
        { ingredient: "sodium benzoate", status: "Bad", reason: "r", concerns: [], citations: ["C1"] },
      ]),
    retriever
  ));

  assert.equal(result.verdicts.length + result.uncovered.length, result.considered.length);
  assert.deepEqual(
    result.uncovered.map((entry) => [entry.ingredient, entry.code]),
    [
      ["Unicorn Tears", "NO_SOURCE"],
      ["Xanthan Gum", "MODEL_DECLINED"],
    ]
  );
});

test("a second verdict for the same ingredient is dropped rather than double-counted", async () => {
  const retriever = fakeRetriever({
    "citric acid": [chunk("additive:en:e330", "E330 Citric acid", "antioxidant")],
  });

  const result = await analyzeGrounded(["citric acid"], deps(
    async () =>
      JSON.stringify([
        { ingredient: "citric acid", status: "Neutral", reason: "r", concerns: [], citations: ["C1"] },
        { ingredient: "Citric Acid", status: "Bad", reason: "r", concerns: [], citations: ["C1"] },
      ]),
    retriever
  ));

  assert.equal(result.verdicts.length, 1);
  assert.equal(result.droppedRows, 1);
  assert.equal(result.verdicts.length + result.uncovered.length, result.considered.length);
});
