// utils/helpers.js - Deterministic post-processing of the OCR text and the
// model's verdicts. Nothing in this file calls a network service: given the
// same input it always returns the same output, which is what makes the
// allergen flags and the health score explainable.
import { HARMFUL_INGREDIENTS, ALLERGENS } from "../configuration/constants.js";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary matcher, tolerant of a trailing plural.
// Built once per keyword at module load rather than per request.
const ALLERGEN_MATCHERS = Object.entries(ALLERGENS).map(([allergen, keywords]) => ({
  allergen,
  keywords: keywords.map((keyword) => ({
    keyword,
    pattern: new RegExp(`\\b${escapeRegExp(keyword)}s?\\b`, "i"),
  })),
}));

/**
 * Longest OCR output that will be parsed. Everything past this is discarded.
 *
 * Not a formatting choice - a bound on synchronous work on the request thread.
 */
export const MAX_OCR_TEXT_CHARS = 20000;

export class AnalysisHelpers {
  /**
   * Pull the ingredient list out of raw OCR text.
   *
   * Strategy, in order:
   *  1. anchor on an "Ingredients:" style heading and read until the next
   *     section heading (nutrition, storage, manufacturer, ...);
   *  2. if no heading was found, keep the lines that look like ingredient
   *     lines (commas, percentages, common ingredient words);
   *  3. if that finds nothing either, fall back to the whole text.
   */
  static extractIngredients(text) {
    if (typeof text !== "string" || text.trim().length === 0) {
      return "";
    }

    // Bound the input before any regex touches it. This runs synchronously on
    // the main thread against whatever Tesseract produced, and Tesseract's
    // output length is chosen by whoever uploaded the image, not by us. A real
    // ingredient list is a few hundred characters; the cap is an order of
    // magnitude above the longest label and still bounds the work.
    const bounded =
      text.length > MAX_OCR_TEXT_CHARS ? text.slice(0, MAX_OCR_TEXT_CHARS) : text;

    const lines = bounded
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return text.trim();
    }

    let ingredientLines = [];
    let startFound = false;

    for (const line of lines) {
      if (!startFound && /ingredients?|contents?|contains?/i.test(line)) {
        startFound = true;
        const cleanLine = line.replace(/^ingredients?:?\s*/i, "");
        if (cleanLine) ingredientLines.push(cleanLine);
        continue;
      }

      if (startFound) {
        if (
          /^(nutritional|nutrition|storage|manufactured|marketed|packed|usage|instructions|allergy|net weight|best before|expiry)/i.test(
            line
          )
        ) {
          break;
        }
        ingredientLines.push(line);
      }
    }

    if (!startFound && ingredientLines.length === 0) {
      ingredientLines = lines.filter((line) => {
        const lowerLine = line.toLowerCase();
        return (
          lowerLine.includes("water") ||
          lowerLine.includes("sugar") ||
          lowerLine.includes("salt") ||
          lowerLine.includes("oil") ||
          lowerLine.includes("spices") ||
          lowerLine.includes("ins") ||
          /\d+\.?\d*%/.test(line) ||
          line.includes(",")
        );
      });
    }

    if (ingredientLines.length === 0) {
      ingredientLines = lines;
    }

    return ingredientLines
      .join(" ")
      .replace(/[{}[\]]/g, "")
      .replace(/\s+/g, " ")
      .replace(/[^\w\s,().%\-:]/g, "")
      // Strip bare numbers, keep "5%" and keep the digits inside "INS1422".
      //
      // This was /\b(?!ins)\d+(?!\d*%|ins)\b/gi, which is quadratic: the `\d*`
      // inside the lookahead re-scans the rest of the digit run at every
      // backtrack position. Measured on this machine, a digit run followed by
      // "ins" - 5k/10k/20k/40k characters - cost 32ms/133ms/600ms/2666ms, a
      // clean 4x per doubling, blocking the event loop for every other request.
      // The same inputs measure 0ms here.
      //
      // The two guards it dropped were doing nothing. `(?!ins)` sat between a
      // word boundary and `\d+`, so it could never match. The `ins` half of the
      // trailing lookahead is already enforced by `\b`, since a digit followed
      // by a letter is not a word boundary - which is also what keeps
      // "INS1422" intact.
      // The colour lookbehind is not decoration: a bare `\b\d+\b` strip
      // deletes the number out of the entire US colour-additive convention, so
      // "RED 40" reached retrieval as "RED". Red 40 is E129 Allura Red - in the
      // corpus, and exactly what somebody opens this app to look up. It was
      // landing in the "no authoritative source found" bucket as a chip reading
      // "RED". Stray quantities ("SUGAR 25 G") are still stripped, and E621 /
      // INS1422 were never at risk: a digit preceded by a letter is not a word
      // boundary. Measured at 0ms on the 40k-digit run the comment above is about.
      .replace(/(?<!\b(?:red|yellow|blue|green|orange)\s)\b\d+\b(?!%)/gi, "")
      .replace(/\b[a-zA-Z]{1}\b/g, "")
      .replace(/,\s*,/g, ",")
      .replace(/\(\s*\)/g, "")
      .trim();
  }

  /**
   * Split an ingredient list into individual ingredients.
   *
   * A label reads "Stabilizers (INS1422, INS415)". Both the function word and
   * the two additive codes matter, and the codes are what the corpus can
   * actually be queried with, so a parenthesised group emits the outer name
   * AND each item inside it.
   *
   * Splitting happens at bracket depth zero only, so "Acidity Regulators
   * (INS260, INS334)" is not torn apart at the wrong comma.
   */
  static parseIngredientList(text, { limit = 25 } = {}) {
    if (typeof text !== "string" || text.trim() === "") return [];

    const cleaned = text
      .replace(/^\s*(ingredients?|contains?|composition)\s*:?\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();

    const topLevel = [];
    let buffer = "";
    let depth = 0;

    for (const character of cleaned) {
      if (character === "(") depth += 1;
      if (character === ")") depth = Math.max(0, depth - 1);

      if (depth === 0 && (character === "," || character === ";" || character === ".")) {
        topLevel.push(buffer);
        buffer = "";
        continue;
      }
      buffer += character;
    }
    topLevel.push(buffer);

    const names = [];

    for (const rawItem of topLevel) {
      // "X and Y" at the top level is two ingredients, but "Spices and
      // Condiments" is one phrase - only split when both sides look like
      // substantial names.
      const parts = rawItem.split(/\s+and\s+(?=[A-Za-z][\w\s]*\()/i);

      for (const part of parts) {
        const withoutGroup = part.replace(/\(([^)]*)\)/g, (match, inner) => {
          for (const nested of inner.split(/[,;]/)) {
            const name = AnalysisHelpers.cleanIngredientName(nested);
            if (name) names.push(name);
          }
          return " ";
        });

        const outer = AnalysisHelpers.cleanIngredientName(withoutGroup);
        if (outer) names.push(outer);
      }
    }

    const seen = new Set();
    const unique = [];
    for (const name of names) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(name);
    }

    return unique.slice(0, limit);
  }

  /** Trim an ingredient fragment down to a name: no percentages, no stray punctuation. */
  static cleanIngredientName(fragment) {
    const name = String(fragment)
      .replace(/\d+\.?\d*\s*%/g, "")
      .replace(/[^\w\s\-+()]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-\s]+|[-\s]+$/g, "");

    // Two characters is below anything meaningful and is usually OCR debris.
    if (name.length < 3) return "";
    // A bare number is not an ingredient.
    if (/^\d+$/.test(name)) return "";
    return name;
  }

  /**
   * Flag allergens by matching the keyword table on word boundaries.
   *
   * @returns {{ allergens: string[], details: Array<{allergen: string, matches: string[]}> }}
   */
  static detectAllergenDetails(ingredients) {
    if (typeof ingredients !== "string" || ingredients.trim() === "") {
      return { allergens: [], details: [] };
    }

    const details = [];

    for (const { allergen, keywords } of ALLERGEN_MATCHERS) {
      const matches = keywords
        .filter(({ pattern }) => pattern.test(ingredients))
        .map(({ keyword }) => keyword);

      if (matches.length > 0) details.push({ allergen, matches });
    }

    return { allergens: details.map((entry) => entry.allergen), details };
  }

  /** Backwards-compatible shape: the list of allergen names only. */
  static detectAllergens(ingredients) {
    return AnalysisHelpers.detectAllergenDetails(ingredients).allergens;
  }

  /**
   * Score = 100, minus 10 for every ingredient the model called Bad and 4 for
   * every Neutral one. Tolerates malformed rows so a single bad verdict cannot
   * take the whole request down with a TypeError.
   */
  static calculateHealthScore(analysis) {
    const rows = Array.isArray(analysis) ? analysis : [];

    let score = 100;
    let goodCount = 0;
    let badCount = 0;
    let neutralCount = 0;

    for (const item of rows) {
      const status = typeof item?.status === "string" ? item.status.toLowerCase() : "";
      switch (status) {
        case "good":
          goodCount++;
          break;
        case "bad":
          badCount++;
          score -= 10;
          break;
        case "neutral":
          neutralCount++;
          score -= 4;
          break;
        default:
          break;
      }
    }

    return {
      score: Math.max(0, Math.min(100, score)),
      breakdown: { good: goodCount, bad: badCount, neutral: neutralCount },
    };
  }

  /** Which of the model's verdicts name an ingredient on the harmful list. */
  static detectHarmfulIngredients(analysis) {
    const rows = Array.isArray(analysis) ? analysis : [];
    return rows.filter(
      (item) =>
        typeof item?.ingredient === "string" &&
        HARMFUL_INGREDIENTS.has(item.ingredient.trim().toLowerCase())
    );
  }
}

export default AnalysisHelpers;
