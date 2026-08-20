import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeGrounded,
  buildContextBlock,
  validateCitations,
  attachSources,
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
