// optimized-ocr.js - The two OCR engines and the heuristic that decides
// whether what came back is actually an ingredient label.
//
// Engine order: Gemini Vision first when a key is configured (it reads
// stylised label typography far better), Tesseract otherwise. Tesseract always
// works and needs no key, so the app is usable with the Groq key alone.
import fetch from "node-fetch";
import { GEMINI_TIMEOUT_MS } from "./configuration/constants.js";
import { prepareForVision, preprocessForOcr } from "./services/imagePreprocessor.js";
import { recognize } from "./services/ocrPool.js";
import AppError from "./utils/AppError.js";
import logger from "./utils/logger.js";

const INGREDIENT_KEYWORDS = [
  "ingredients", "contains", "water", "sugar", "jaggery", "tomato", "paste",
  "tamarind", "salt", "spices", "condiments", "stabilizers", "acidity",
  "regulators", "preservative", "ins1422", "ins415", "ins260", "ins334",
  "ins211", "flour", "oil", "milk", "egg", "wheat", "corn", "rice", "soy",
  "nuts", "peanut", "dairy", "protein", "fat", "sodium", "vitamin", "mineral",
  "artificial", "natural", "flavor", "coloring", "extract", "powder", "syrup",
  "starch", "glucose", "fructose", "citric acid", "baking", "yeast", "gelatin",
  "lecithin",
  // Units and measurements
  "ins", "mg", "kg", "ml", "oz", "lb", "cup", "tbsp", "tsp", "%", "milligram",
  "gram", "kilogram", "milliliter", "liter", "ounce", "pound",
  // Nutritional terms
  "calories", "carbs", "carbohydrate", "fiber", "cholesterol", "trans fat",
  "saturated", "unsaturated", "monounsaturated", "polyunsaturated",
  // Allergen warnings
  "allergen", "allergy", "warning", "may contain", "processed in facility",
  "gluten", "shellfish", "fish", "sesame", "sulfite",
  // Food categories
  "organic", "non-gmo", "kosher", "halal", "vegan", "vegetarian", "free range",
  "pasteurized", "homogenized",
];

const NUTRITION_PATTERNS = [
  /\d+\s*(mg|g|kg|ml|l|oz|lb|%)/i,
  /calories\s*:?\s*\d+/i,
  /protein\s*:?\s*\d+/i,
  /fat\s*:?\s*\d+/i,
  /sodium\s*:?\s*\d+/i,
  /sugar\s*:?\s*\d+/i,
  /fiber\s*:?\s*\d+/i,
  /vitamin\s+[a-z]\s*:?\s*\d+/i,
  /\d+\s*calories/i,
];

export const MIN_INGREDIENT_SCORE = 2;

/**
 * Score OCR output on how much it looks like a food label.
 *
 * This is what stops a photo of a cat from being sent to the model and coming
 * back as a confident nutritional analysis of nothing. It is a heuristic, not
 * a classifier: it counts ingredient vocabulary, INS additive codes,
 * percentages, nutrition patterns and list punctuation.
 */
export function validateIngredientText(text) {
  if (typeof text !== "string" || text.trim().length < 10) {
    return {
      isValid: false,
      reason: "Text too short to be ingredient list",
      confidence: 0,
      score: 0,
      foundKeywords: [],
      foundPatterns: 0,
      wordCount: 0,
    };
  }

  const lowerText = text.toLowerCase();
  let score = 0;
  const foundKeywords = [];
  const foundPatterns = [];

  for (const keyword of INGREDIENT_KEYWORDS) {
    if (lowerText.includes(keyword)) {
      score += keyword === "ingredients" ? 15 : 3;
      foundKeywords.push(keyword);
    }
  }

  const insMatches = text.match(/ins\d+/gi) || [];
  score += insMatches.length * 5;

  const percentageMatches = text.match(/\d+\.?\d*%/g) || [];
  score += percentageMatches.length * 3;

  NUTRITION_PATTERNS.forEach((pattern, index) => {
    if (pattern.test(text)) {
      score += 7;
      foundPatterns.push(`pattern_${index}`);
    }
  });

  const commaCount = (text.match(/,/g) || []).length;
  if (commaCount >= 3) score += Math.min(commaCount * 2, 15);

  const parenCount = (text.match(/\(/g) || []).length;
  if (parenCount >= 2) score += Math.min(parenCount * 3, 12);

  // Mostly one- and two-letter tokens is the signature of OCR noise.
  const words = text.split(/\s+/);
  const shortWords = words.filter((word) => word.length <= 2).length;
  if (shortWords > words.length * 0.5) score -= 5;

  const isValid = score >= MIN_INGREDIENT_SCORE;

  return {
    isValid,
    confidence: Math.min(Math.max(score, 0), 100),
    reason: isValid
      ? `Found ${foundKeywords.length} ingredient keywords and ${foundPatterns.length} nutrition patterns`
      : `Score too low (${score}/${MIN_INGREDIENT_SCORE}). May not be an ingredient label.`,
    foundKeywords: foundKeywords.slice(0, 5),
    foundPatterns: foundPatterns.length,
    wordCount: words.length,
    score,
  };
}

/** Gemini Vision OCR. Requires GEMINI_API_KEY; optional in this app. */
export async function performGeminiVisionOCR(imageBuffer) {
  if (!process.env.GEMINI_API_KEY) {
    throw new AppError("Gemini API key not configured", {
      code: "GEMINI_NOT_CONFIGURED",
      statusCode: 503,
    });
  }

  const startTime = Date.now();
  const base64Image = imageBuffer.toString("base64");

  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: "You are an expert at reading food labels and ingredient lists. Your task is to extract ONLY the ingredients list from this food label image. \n\nLook for sections that start with 'INGREDIENTS:', 'Contains:', 'Composition:', or similar headers. Extract the complete ingredient text exactly as written, preserving all commas, parentheses, percentages, and INS codes (like INS 262, INS 415, etc.).\n\nInclude ALL ingredients from the list, even if they seem unusual or contain numbers/codes. Do not skip any ingredients.\n\nIf you cannot find any ingredients list, respond with exactly 'NO_INGREDIENTS_FOUND'.\n\nDo not include:\n- Nutritional information\n- Allergen warnings (unless they are part of the ingredients list)\n- Manufacturing details\n- Storage instructions\n- Any other text\n\nReturn only the ingredients text, nothing else.",
                },
                { inline_data: { mime_type: "image/jpeg", data: base64Image } },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 1024, candidateCount: 1 },
        }),
        // Without a deadline a stalled connection holds the request open for as
        // long as the socket survives.
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      }
    );
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new AppError("Gemini Vision OCR timed out", {
        code: "GEMINI_TIMEOUT",
        statusCode: 504,
      });
    }
    throw new AppError("Could not reach Gemini Vision", {
      code: "GEMINI_UNREACHABLE",
      statusCode: 503,
      details: error.message,
    });
  }

  if (!response.ok) {
    throw new AppError(`Gemini Vision returned HTTP ${response.status}`, {
      code: "GEMINI_HTTP_ERROR",
      statusCode: 502,
    });
  }

  const result = await response.json();
  const extractedText = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  if (!extractedText.trim()) {
    throw new AppError("No text extracted from image", {
      code: "NO_TEXT_DETECTED",
      statusCode: 400,
    });
  }

  const cleanText = extractedText.trim().toUpperCase();
  if (cleanText === "NO_INGREDIENTS_FOUND" || cleanText.includes("NO INGREDIENTS")) {
    throw new AppError(
      "No ingredient list found in the photo. Point the camera at the ingredients section of the label.",
      { code: "NOT_AN_INGREDIENT_LABEL", statusCode: 422 }
    );
  }

  const validation = validateIngredientText(extractedText);
  if (!validation.isValid) {
    throw new AppError(
      "That does not look like a food ingredient label. Please photograph the ingredients section.",
      { code: "NOT_AN_INGREDIENT_LABEL", statusCode: 422, details: validation.reason }
    );
  }

  return {
    text: extractedText.trim(),
    confidence: Math.min(validation.confidence, 90),
    method: "gemini_vision",
    words: extractedText.trim().split(/\s+/).length,
    processingTime: Date.now() - startTime,
    validation,
  };
}

/**
 * Tesseract OCR. No key, no network, MIT licensed - the always-available path.
 *
 * The work runs on a pooled worker (services/ocrPool.js). It used to call
 * `Tesseract.recognize`, which creates a worker, uses it once and terminates it;
 * the language pack and WASM core were therefore reloaded on every request.
 */
export async function performTesseractOCR(imageBuffer) {
  const startTime = performance.now();

  const { data, waitMs, recogniseMs } = await recognize(imageBuffer);

  const extractedText = data.text;
  const validation = validateIngredientText(extractedText);

  if (!validation.isValid) {
    throw new AppError(
      "No readable ingredient list found. Try a sharper, better-lit photo of the ingredients section.",
      { code: "NOT_AN_INGREDIENT_LABEL", statusCode: 422, details: validation.reason }
    );
  }

  return {
    text: extractedText,
    confidence: Math.min(data.confidence, validation.confidence),
    method: "tesseract",
    words: data.words?.length || 0,
    processingTime: Math.round(performance.now() - startTime),
    // Queueing behind another request and recognising are reported apart, so a
    // slow response under load is attributable to load rather than to OCR.
    waitMs,
    recogniseMs,
    validation,
  };
}

/**
 * Run OCR, giving each engine the image it works best on.
 *
 * A 422 (this is not an ingredient label) is not retried on the other engine:
 * both engines read the same photo, and asking Tesseract to re-read a picture
 * Gemini just confirmed is not a label only burns 20 seconds.
 */
export async function performSmartOCR(imageBuffer, { isMobile = false } = {}) {
  if (process.env.GEMINI_API_KEY) {
    const startedPreprocess = performance.now();
    try {
      const visionImage = await prepareForVision(imageBuffer, { isMobile });
      const preprocessMs = Math.round(performance.now() - startedPreprocess);
      const result = await performGeminiVisionOCR(visionImage);
      logger.info("ocr complete", {
        method: result.method,
        preprocessMs,
        ms: result.processingTime,
        confidence: result.confidence,
      });
      return { ...result, preprocessMs };
    } catch (error) {
      if (error.code === "NOT_AN_INGREDIENT_LABEL") throw error;
      logger.warn("gemini vision ocr failed, falling back to tesseract", {
        code: error.code,
        reason: error.message,
      });
    }
  }

  const startedPreprocess = performance.now();
  const ocrImage = await preprocessForOcr(imageBuffer);
  const preprocessMs = Math.round(performance.now() - startedPreprocess);

  const result = await performTesseractOCR(ocrImage);
  logger.info("ocr complete", {
    method: result.method,
    preprocessMs,
    waitMs: result.waitMs,
    recogniseMs: result.recogniseMs,
    ms: result.processingTime,
    confidence: result.confidence,
  });
  return { ...result, preprocessMs };
}

export default { performSmartOCR, performGeminiVisionOCR, performTesseractOCR, validateIngredientText };
