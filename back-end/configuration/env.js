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
  // Where the OpenAI-compatible chat-completions call goes. Overridable so the
  // pipeline can be profiled and load-tested against a local stub without a
  // provider key and without paying for thousands of tokens per run; see
  // scripts/stub-llm.js. Production leaves it unset.
  GROQ_BASE_URL:
    process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1/chat/completions",
  // Optional. When present, Gemini Vision is tried for OCR before Tesseract.
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};

/**
 * Report what this process can do, rather than refusing to start.
 *
 * GROQ_API_KEY used to be required at boot, and the process exited without it.
 * That was the wrong boundary: OCR, the corpus, hybrid retrieval, abstention,
 * citation checking, the allergen table and the health score all run with no
 * key at all, and /health - which the README tells a reader to curl first - was
 * unreachable without a Groq account. Someone evaluating this repo had to forge
 * a fake key to see any of it.
 *
 * The key is now checked where it is used. Without it every other stage runs
 * and only the generation call fails, with a typed error that names what is
 * missing.
 */
export function validateEnv() {
  const generationEnabled = Boolean(env.GROQ_API_KEY && String(env.GROQ_API_KEY).trim() !== "");

  if (!generationEnabled) {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "GROQ_API_KEY is not set: OCR and retrieval will run, ingredient verdicts will not",
        hint: "Copy back-end/.env.example to back-end/.env and add a free key from https://console.groq.com/keys",
      })
    );
  }

  return {
    ok: true,
    generationEnabled,
    geminiOcrEnabled: Boolean(env.GEMINI_API_KEY),
  };
}

export default env;
