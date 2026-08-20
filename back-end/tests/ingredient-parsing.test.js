import test from "node:test";
import assert from "node:assert/strict";
import AnalysisHelpers, { MAX_OCR_TEXT_CHARS } from "../utils/helpers.js";

test("parseIngredientList emits the group name and the codes inside the brackets", () => {
  const names = AnalysisHelpers.parseIngredientList(
    "Water, Sugar, Tamarind (5%), Stabilizers (INS1422, INS415), Acidity Regulators (INS260, INS334) and Preservative (INS211)."
  );

  // The bracketed codes are the retrievable ones - they are what the corpus is
  // keyed on - so they must survive parsing.
  for (const code of ["INS1422", "INS415", "INS260", "INS334", "INS211"]) {
    assert.ok(names.includes(code), `${code} was lost. Got: ${names.join(" | ")}`);
  }
  assert.ok(names.includes("Water"));
  assert.ok(names.includes("Tamarind"), "the percentage should be stripped, not the ingredient");
  assert.ok(names.includes("Stabilizers"));
});

test("parseIngredientList splits only at bracket depth zero", () => {
  const names = AnalysisHelpers.parseIngredientList("Raising agents (E500ii, E503ii), salt");

  assert.ok(names.includes("E500ii"));
  assert.ok(names.includes("E503ii"));
  assert.ok(names.includes("raising agents") || names.includes("Raising agents"));
  assert.ok(!names.some((name) => name.includes("E500ii, E503ii")));
});

test("parseIngredientList drops OCR debris and caps the list", () => {
  assert.deepEqual(AnalysisHelpers.parseIngredientList(""), []);
  assert.deepEqual(AnalysisHelpers.parseIngredientList("a, b, 12, ., --"), []);

  const many = Array.from({ length: 40 }, (unused, index) => `ingredient${index}`).join(", ");
  assert.equal(AnalysisHelpers.parseIngredientList(many).length, 25);
});

test("parseIngredientList strips the heading and de-duplicates", () => {
  const names = AnalysisHelpers.parseIngredientList("INGREDIENTS: Sugar, sugar, SUGAR, Salt");
  assert.deepEqual(names, ["Sugar", "Salt"]);
});


// ---------------------------------------------------------------------------
// The extractor ran a quadratic regex, synchronously, on OCR output whose
// length the uploader chooses. Measured on a digit run followed by "ins", at
// 5k/10k/20k/40k characters: 32ms / 133ms / 600ms / 2666ms - a clean 4x per
// doubling. The replacement measures 0ms on all four.
// ---------------------------------------------------------------------------

test("ingredient extraction is linear in the length of the OCR text", () => {
  // The worst-case shape: a long digit run followed by "ins", which forced the
  // old lookahead to re-scan the run at every backtrack position.
  const hostile = `Ingredients: ${"1".repeat(40000)}ins`;

  const started = performance.now();
  AnalysisHelpers.extractIngredients(hostile);
  const elapsed = performance.now() - started;

  // The old pattern took 2666ms on this input. 500ms is a wide margin over the
  // ~0ms the linear one measures, and still an order of magnitude under the
  // regression it guards.
  assert.ok(elapsed < 500, `extraction took ${Math.round(elapsed)}ms, expected linear behaviour`);
});

test("OCR text is capped before any regex runs over it", () => {
  const enormous = `Ingredients: ${"9".repeat(MAX_OCR_TEXT_CHARS * 3)}%`;
  const started = performance.now();
  AnalysisHelpers.extractIngredients(enormous);
  assert.ok(performance.now() - started < 500);
});

test("the linear pattern still keeps percentages and additive codes", () => {
  const text =
    "INGREDIENTS: Water, Sugar, Tamarind (5%), Stabilizers (INS1422, INS415), " +
    "Acidity Regulators (INS260, INS334) and Preservative (INS211). 250 g";
  const extracted = AnalysisHelpers.extractIngredients(text);

  for (const code of ["INS1422", "INS415", "INS260", "INS334", "INS211"]) {
    assert.ok(extracted.includes(code), `additive code ${code} was destroyed: ${extracted}`);
  }
  assert.ok(extracted.includes("5%"), `percentage was destroyed: ${extracted}`);
  // A bare quantity is still stripped, which is what the pattern is for.
  assert.ok(!/\b250\b/.test(extracted), `bare number survived: ${extracted}`);
});
