import test from "node:test";
import assert from "node:assert/strict";
import { parseAnalysis, canonicalStatus } from "../schemas/analysis.js";

test("canonicalStatus maps synonyms and defaults anything unknown to Neutral", () => {
  assert.equal(canonicalStatus("Good"), "Good");
  assert.equal(canonicalStatus("  HARMFUL "), "Bad");
  assert.equal(canonicalStatus("beneficial"), "Good");
  assert.equal(canonicalStatus("moderately questionable"), "Neutral");
  assert.equal(canonicalStatus(undefined), "Neutral");
  assert.equal(canonicalStatus(5), "Neutral");
});

test("parseAnalysis coerces the shapes a model actually returns", () => {
  const { verdicts, dropped } = parseAnalysis([
    { ingredient: "Sugar", status: "BAD", reason: "  high GI  ", concerns: "diabetes" },
    { ingredient: "Water", status: "Good", concerns: null },
  ]);

  assert.equal(dropped, 0);
  assert.deepEqual(verdicts[0], {
    ingredient: "Sugar",
    status: "Bad",
    reason: "high GI",
    concerns: ["diabetes"],
  });
  // A missing reason becomes "" and a missing concerns list becomes [], so the
  // UI never has to guard for undefined.
  assert.deepEqual(verdicts[1].concerns, []);
  assert.equal(verdicts[1].reason, "");
});

test("parseAnalysis drops unusable rows but keeps the rest", () => {
  const { verdicts, dropped } = parseAnalysis([
    { ingredient: "Salt", status: "Neutral" },
    { status: "Bad", reason: "no ingredient name" },
    { ingredient: "   ", status: "Bad" },
  ]);

  assert.equal(verdicts.length, 1);
  assert.equal(dropped, 2);
});

test("parseAnalysis throws a typed 502 when nothing is usable", () => {
  assert.throws(
    () => parseAnalysis([{ nope: true }, "garbage"]),
    (error) => error.code === "ANALYSIS_SCHEMA_INVALID" && error.statusCode === 502
  );
});
