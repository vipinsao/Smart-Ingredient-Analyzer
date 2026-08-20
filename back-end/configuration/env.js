import dotenv from "dotenv";

dotenv.config();

export const env = {
  PORT: process.env.PORT || 5000,
  NODE_ENV: process.env.NODE_ENV || "development",
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  // Groq refuses a request whose `model` is undefined, so a missing value here
  // used to surface as an opaque HTTP 400 on the first analysis instead of a
  // startup failure. The default is a model listed as production-ready on
  // Groq's free tier; llama-3.3-70b-versatile, the obvious previous choice,
  // was shut down by Groq on 2026-08-16.
  // Current IDs: https://console.groq.com/docs/models
  GROQ_MODEL: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  // Optional. When present, Gemini Vision is tried for OCR before Tesseract.
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};

const REQUIRED = ["GROQ_API_KEY"];

/**
 * Fail fast, and name every missing variable at once rather than one per
 * restart.
 */
export function validateEnv() {
  const missing = REQUIRED.filter((key) => !env[key] || String(env[key]).trim() === "");

  if (missing.length > 0) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Missing required environment variables",
        missing,
        hint: "Copy back-end/.env.example to back-end/.env and fill it in.",
      })
    );
    process.exit(1);
  }

  return { ok: true, geminiOcrEnabled: Boolean(env.GEMINI_API_KEY) };
}

export default env;
