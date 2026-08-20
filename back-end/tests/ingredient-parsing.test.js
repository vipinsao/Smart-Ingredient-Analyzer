import test from "node:test";
import assert from "node:assert/strict";
import AnalysisHelpers from "../utils/helpers.js";

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
