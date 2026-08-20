// configuration/constants.js - Application constants.
export const HARMFUL_INGREDIENTS = new Set([
  "trans fat",
  "partially hydrogenated oil",
  "high fructose corn syrup",
  "aspartame",
  "sodium nitrate",
  "sodium nitrite",
  "bha",
  "bht",
  "artificial colors",
  "red dye 40",
  "yellow 5",
  "yellow 6",
  "monosodium glutamate",
  "msg",
  "carrageenan",
  "sodium benzoate",
]);

// Deterministic allergen keyword table.
//
// Allergen flags are produced by matching this table, NOT by asking the model.
// A user with a peanut allergy needs the same answer every time for the same
// label; a generative model gives no such guarantee. Keywords are matched on
// word boundaries (see utils/helpers.js), so "malt" flags gluten but
// "maltodextrin" - which is normally corn-derived - does not.
export const ALLERGENS = {
  gluten: ["wheat", "barley", "rye", "malt", "triticale", "semolina", "spelt", "farina"],
  dairy: ["milk", "lactose", "casein", "caseinate", "whey", "butter", "cream", "ghee", "curd", "paneer"],
  peanuts: ["peanut", "groundnut", "arachis oil"],
  "tree nuts": ["almond", "walnut", "cashew", "pecan", "hazelnut", "pistachio", "macadamia", "brazil nut"],
  soy: ["soy", "soya", "soybean", "soy lecithin", "tofu", "edamame"],
  eggs: ["egg", "albumin", "albumen", "mayonnaise"],
  fish: ["fish", "anchovy", "cod", "tuna", "salmon", "sardine"],
  shellfish: ["shrimp", "prawn", "crab", "lobster", "mollusk", "mollusc", "oyster", "squid"],
  sesame: ["sesame", "tahini", "gingelly"],
};

export const CACHE_CONFIG = {
  stdTTL: 172800, // 48 hours
  checkperiod: 3600, // 1 hour
};

export const IMAGE_LIMITS = {
  maxSizeBytes: 8 * 1024 * 1024, // 8MB of decoded image bytes
  minSizeBytes: 1024, // 1KB
  // The JSON body carrying the base64 image. base64 inflates bytes by ~4/3, so
  // this must exceed maxSizeBytes or a legal image is rejected by body-parser
  // before the friendlier size check below ever runs.
  maxBodySize: "12mb",
};

// Magic bytes for the formats the frontend is allowed to send. Checked against
// the decoded buffer so a renamed .exe or a text payload is rejected at the
// boundary rather than inside sharp.
export const SUPPORTED_IMAGE_SIGNATURES = [
  { format: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { format: "png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { format: "webp", bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF", verified further at offset 8
];

/** Positive integer from the environment, or the shipped default. */
function limitFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Global limiter - protects the process.
export const RATE_LIMIT_CONFIG = {
  windowMs: 15 * 60 * 1000,
  max: limitFromEnv("RATE_LIMIT_MAX", 100),
};

// Route limiter - /api/analyze costs OCR CPU and one model call per request,
// so it gets a tighter per-IP budget than the rest of the API.
//
// Overridable because a load test drives hundreds of requests from one address
// and would otherwise measure the rate limiter rather than the pipeline. The
// deployed app leaves both unset and gets the numbers above.
export const ANALYZE_RATE_LIMIT = {
  windowMs: 15 * 60 * 1000,
  max: limitFromEnv("ANALYZE_RATE_LIMIT_MAX", 20),
};

export const LLM_TIMEOUT = {
  mobile: 20000,
  fast: 20000,
  normal: 20000,
};

export const LLM_TOKENS = {
  mobile: 5000,
  fast: 5000,
  normal: 5000,
};

// Retained aliases: the Groq-specific names are used by existing callers.
export const GROQ_TIMEOUT = LLM_TIMEOUT;
export const GROQ_TOKENS = LLM_TOKENS;

// Gemini Vision OCR is a network call with no built-in deadline; without this
// a hung connection would hold the request open indefinitely.
export const GEMINI_TIMEOUT_MS = 15000;

export const OCR_PREPROCESS = {
  maxWidth: 2000,
  sharpen: { sigma: 1 },
};

export const VISION_PREPROCESS = {
  maxWidth: 2400,
  maxWidthMobile: 1800,
  quality: 95,
  qualityMobile: 90,
};

export default {
  HARMFUL_INGREDIENTS,
  ALLERGENS,
  CACHE_CONFIG,
  IMAGE_LIMITS,
  SUPPORTED_IMAGE_SIGNATURES,
  RATE_LIMIT_CONFIG,
  ANALYZE_RATE_LIMIT,
  LLM_TIMEOUT,
  LLM_TOKENS,
  GROQ_TIMEOUT,
  GROQ_TOKENS,
  GEMINI_TIMEOUT_MS,
  OCR_PREPROCESS,
  VISION_PREPROCESS,
};
