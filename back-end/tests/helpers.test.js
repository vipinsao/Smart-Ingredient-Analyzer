import test from "node:test";
import assert from "node:assert/strict";
import AnalysisHelpers from "../utils/helpers.js";

test("extractIngredients reads the ingredients section and stops at the next heading", () => {
  const ocrText = [
    "VEEBA CULINARY SAUCE",
    "INGREDIENTS: Water, Sugar, Jaggery, Tomato Paste, Tamarind (5%),",
    "Iodised Salt, Spices and Condiments, Preservative (INS211).",
    "NUTRITIONAL INFORMATION (Approx. Values)",
    "Serving size: 1/2 Tbsp",
  ].join("\n");

  const result = AnalysisHelpers.extractIngredients(ocrText);

  assert.match(result, /Water, Sugar, Jaggery/);
  assert.match(result, /INS211/);
  assert.doesNotMatch(result, /NUTRITIONAL/i, "nutrition block must not leak into the ingredients");
  assert.doesNotMatch(result, /Serving size/i);
});

test("extractIngredients returns an empty string for empty or non-string input", () => {
  assert.equal(AnalysisHelpers.extractIngredients(""), "");
  assert.equal(AnalysisHelpers.extractIngredients("   "), "");
  assert.equal(AnalysisHelpers.extractIngredients(null), "");
  assert.equal(AnalysisHelpers.extractIngredients(undefined), "");
});

test("detectAllergens flags every allergen family present in the text", () => {
  const allergens = AnalysisHelpers.detectAllergens(
    "Wheat flour, milk solids, roasted peanuts, sesame seeds, egg powder"
  );

  assert.deepEqual(allergens.sort(), ["dairy", "eggs", "gluten", "peanuts", "sesame"]);
});

test("detectAllergens matches whole words, so maltodextrin is not gluten", () => {
  // Substring matching used to flag gluten here: "malt" is a gluten keyword and
  // it is a substring of "maltodextrin", which is normally corn-derived.
  const allergens = AnalysisHelpers.detectAllergens("Corn starch, maltodextrin, eggplant, sunflower oil");

  assert.deepEqual(allergens, [], `unexpected flags: ${allergens.join(", ")}`);
});

test("detectAllergens reports which keyword produced each flag", () => {
  const { details } = AnalysisHelpers.detectAllergenDetails("Contains whey and barley malt");

  const byAllergen = Object.fromEntries(details.map((d) => [d.allergen, d.matches]));
  assert.deepEqual(byAllergen.dairy, ["whey"]);
  assert.deepEqual(byAllergen.gluten.sort(), ["barley", "malt"]);
});

test("detectAllergens returns nothing for non-string input instead of throwing", () => {
  assert.deepEqual(AnalysisHelpers.detectAllergens(undefined), []);
  assert.deepEqual(AnalysisHelpers.detectAllergens(42), []);
});

test("calculateHealthScore subtracts 10 per Bad and 4 per Neutral", () => {
  const score = AnalysisHelpers.calculateHealthScore([
    { ingredient: "water", status: "Good" },
    { ingredient: "sugar", status: "Bad" },
    { ingredient: "salt", status: "Neutral" },
    { ingredient: "msg", status: "Bad" },
  ]);

  assert.equal(score.score, 100 - 10 - 10 - 4);
  assert.deepEqual(score.breakdown, { good: 1, bad: 2, neutral: 1 });
});

test("calculateHealthScore never returns a negative score", () => {
  const analysis = Array.from({ length: 30 }, () => ({ ingredient: "x", status: "Bad" }));
  assert.equal(AnalysisHelpers.calculateHealthScore(analysis).score, 0);
});

test("calculateHealthScore survives rows the model returned malformed", () => {
  // Before the fix this threw TypeError: Cannot read properties of undefined
  // (reading 'toLowerCase') and surfaced to the user as a 500.
  assert.doesNotThrow(() =>
    AnalysisHelpers.calculateHealthScore([{ ingredient: "sugar" }, null, "nope", { status: 7 }])
  );
  assert.equal(AnalysisHelpers.calculateHealthScore("not an array").score, 100);
});

test("detectHarmfulIngredients matches the curated list and ignores malformed rows", () => {
  const harmful = AnalysisHelpers.detectHarmfulIngredients([
    { ingredient: "Sodium Benzoate", status: "Bad" },
    { ingredient: "water", status: "Good" },
    { status: "Bad" },
    null,
  ]);

  assert.equal(harmful.length, 1);
  assert.equal(harmful[0].ingredient, "Sodium Benzoate");
});
