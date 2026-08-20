import test from "node:test";
import assert from "node:assert/strict";
import {
  contentWords,
  numeralsIn,
  citationReport,
  lexicalSupport,
  unsupportedNumerals,
  groundednessReport,
  judgePrompt,
  parseJudgement,
} from "../rag/eval/generation-metrics.js";

/** The prompt's id map, as buildContextBlock hands it back. */
const byId = new Map([
  [
    "C1",
    {
      id: "additive:en:e211",
      title: "E211 Sodium benzoate",
      text: "Additive class: preservative. EFSA assessed overexposure risk as high for children.",
    },
  ],
  [
    "C2",
    {
      id: "additive:en:e330",
      title: "E330 Citric acid",
      text: "Additive class: antioxidant, acidity regulator. No acceptable daily intake specified.",
    },
  ],
]);

test("contentWords drops stopwords, digits and one-character tokens", () => {
  // "used" is a stopword, "2" is a digit, and "products" is de-suffixed to
  // "product" so it matches "product" in a passage.
  assert.deepEqual(contentWords("It is used as a preservative in 2 products"), [
    "preservative",
    "product",
  ]);
});

test("numeralsIn normalises the written form but not the value", () => {
  assert.deepEqual(numeralsIn("an ADI of 0.40 mg/kg, and E211"), ["0.4", "211"]);
  assert.deepEqual(numeralsIn("no numbers here"), []);
});

test("citationReport counts an invented id at both the verdict and the citation level", () => {
  const report = citationReport(
    [
      { ingredient: "sodium benzoate", citations: ["C1"] },
      { ingredient: "citric acid", citations: ["C2", "C9"] },
      { ingredient: "water", citations: [] },
    ],
    ["C1", "C2"]
  );

  assert.equal(report.verdicts, 3);
  assert.equal(report.verdictsFullyValid, 1);
  assert.equal(report.verdictsUncited, 1);
  // Three ids were cited across the two verdicts that cited anything.
  assert.equal(report.citations, 3);
  assert.equal(report.citationsResolved, 2);
  assert.deepEqual(report.invented, [{ ingredient: "citric acid", id: "C9" }]);
  assert.equal(report.verdictValidity, 1 / 3);
  assert.equal(report.citationValidity, 2 / 3);
});

test("citationReport reports null rates rather than a flattering 1.0 on an empty set", () => {
  // "The model produced nothing" must not average into a corpus-level figure
  // as "everything it produced was valid".
  const report = citationReport([], ["C1"]);
  assert.equal(report.verdictValidity, null);
  assert.equal(report.citationValidity, null);
});

test("lexicalSupport names the words the cited passage does not carry", () => {
  const support = lexicalSupport("EFSA assessed overexposure risk as high", [
    "E211 Sodium benzoate Additive class: preservative. EFSA assessed overexposure risk as high for children.",
  ]);

  assert.equal(support.ratio, 1);
  assert.deepEqual(support.missing, []);

  const invented = lexicalSupport("Linked to hyperactivity and asthma in schoolchildren", [
    "E211 Sodium benzoate Additive class: preservative.",
  ]);
  assert.ok(invented.ratio < 0.3, `expected a low ratio, got ${invented.ratio}`);
  assert.ok(invented.missing.includes("hyperactivity"));
});

test("unsupportedNumerals catches a figure the passages never state", () => {
  assert.deepEqual(
    unsupportedNumerals("EFSA set an acceptable daily intake of 40 mg/kg", [
      "E330 Citric acid. No acceptable daily intake specified.",
    ]),
    ["40"]
  );

  assert.deepEqual(
    unsupportedNumerals("E211 is a preservative", ["E211 Sodium benzoate Additive class: preservative."]),
    []
  );
});

test("a grounded verdict scores as supported", () => {
  const report = groundednessReport(
    {
      ingredient: "sodium benzoate",
      reason: "EFSA assessed overexposure risk as high",
      citations: ["C1"],
    },
    byId
  );

  assert.equal(report.scored, true);
  assert.equal(report.supported, true);
  assert.equal(report.lexicalSupport, 1);
  assert.deepEqual(report.unsupportedNumerals, []);
});

test("an invented quantity fails groundedness even when the wording overlaps", () => {
  // The whole point of scoring numbers separately: this claim reuses almost
  // every word of the passage and still states a figure that is not in it.
  const report = groundednessReport(
    {
      ingredient: "citric acid",
      reason: "Antioxidant and acidity regulator with an acceptable daily intake of 40 mg/kg",
      citations: ["C2"],
    },
    byId
  );

  assert.equal(report.supported, false);
  assert.deepEqual(report.unsupportedNumerals, ["40"]);
  assert.ok(report.lexicalSupport > 0.6, "the wording alone would have passed");
});

test("a claim citing only unresolvable ids is not scored for groundedness", () => {
  // It is already counted as a citation failure. Counting it twice would make
  // one defect look like two.
  const report = groundednessReport(
    { ingredient: "water", reason: "hydration", citations: ["C9"] },
    byId
  );

  assert.equal(report.scored, false);
  assert.match(report.reason, /no resolvable citation/);
});

test("the judge prompt asks about attribution only, and offers exactly three answers", () => {
  const prompt = judgePrompt("EFSA assessed overexposure risk as high", ["E211 Sodium benzoate ..."]);

  assert.match(prompt, /\[P1\] E211 Sodium benzoate/);
  assert.match(prompt, /not whether the claim is true in general/);
  assert.match(prompt, /SUPPORTED, PARTIAL, or UNSUPPORTED/);
});

test("parseJudgement returns null rather than guessing at an unrecognised reply", () => {
  assert.equal(parseJudgement("SUPPORTED\nThe passage states it."), "SUPPORTED");
  assert.equal(parseJudgement("unsupported - the passage says nothing"), "UNSUPPORTED");
  assert.equal(parseJudgement("PARTIAL"), "PARTIAL");
  assert.equal(parseJudgement("I think it is probably fine"), null);
  assert.equal(parseJudgement(""), null);
});
