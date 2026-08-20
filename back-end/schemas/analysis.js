// schemas/analysis.js - Contract for the model's ingredient verdicts.
//
// The model is asked for JSON, but a language model can always return a shape
// we did not ask for: a missing key, a status word outside the allowed set, a
// string where an array belongs. Everything downstream (health score,
// harmful-ingredient lookup, the React list) assumes a fixed shape, so the
// model output is validated here before it is allowed any further.
import { z } from "zod";
import AppError from "../utils/AppError.js";

export const STATUS_VALUES = ["Good", "Bad", "Neutral"];

const GOOD_WORDS = new Set(["good", "healthy", "beneficial", "safe", "positive"]);
const BAD_WORDS = new Set(["bad", "harmful", "unhealthy", "avoid", "negative", "poor"]);

// Anything we cannot confidently read as Good or Bad becomes Neutral. That is
// the conservative choice: an unknown verdict must not be scored as harmful,
// and must not be scored as healthy either.
export function canonicalStatus(value) {
  if (typeof value !== "string") return "Neutral";
  const word = value.trim().toLowerCase();
  if (GOOD_WORDS.has(word)) return "Good";
  if (BAD_WORDS.has(word)) return "Bad";
  return "Neutral";
}

function toConcerns(value) {
  if (typeof value === "string") {
    const single = value.trim();
    return single ? [single] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

export const ingredientVerdictSchema = z.object({
  ingredient: z.string().trim().min(1),
  status: z.preprocess(canonicalStatus, z.enum(STATUS_VALUES)),
  reason: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : ""),
    z.string()
  ),
  concerns: z.preprocess(toConcerns, z.array(z.string())),
});

export const analysisSchema = z.array(ingredientVerdictSchema);

/**
 * Validate a raw model response.
 *
 * Rows that cannot be repaired (no ingredient name at all) are dropped rather
 * than failing the whole request - one bad row should not lose eleven good
 * ones. If nothing survives, that is a hard failure and the caller can retry.
 *
 * @returns {{ verdicts: Array, dropped: number }}
 */
export function parseAnalysis(raw) {
  const rows = Array.isArray(raw) ? raw : [raw];

  const verdicts = [];
  let dropped = 0;

  for (const row of rows) {
    const result = ingredientVerdictSchema.safeParse(row);
    if (result.success) verdicts.push(result.data);
    else dropped += 1;
  }

  if (verdicts.length === 0) {
    throw new AppError("Model response contained no usable ingredient verdicts", {
      code: "ANALYSIS_SCHEMA_INVALID",
      statusCode: 502,
      details: { dropped },
    });
  }

  return { verdicts, dropped };
}

export default { analysisSchema, ingredientVerdictSchema, parseAnalysis, canonicalStatus };
