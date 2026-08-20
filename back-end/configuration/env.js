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
  // How many reverse proxies sit in front of this process. See parseTrustProxy.
  TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY),
  // Exact browser origins allowed to call the API, comma separated.
  CORS_ORIGINS: parseList(process.env.CORS_ORIGINS),
};

/**
 * How many proxy hops to trust in X-Forwarded-For, defaulting to NONE.
 *
 * This defaults to `false` because getting it wrong is not a subtle
 * misconfiguration, it disables the rate limiter completely. `trust proxy: 1`
 * makes Express take an entry from a client-supplied X-Forwarded-For header as
 * `req.ip` whether or not a proxy actually set it - and this app's own shipped
 * topology has no proxy in front of it: docker-compose publishes 5000:5000, and
 * front-end/nginx.conf serves static assets with no proxy_pass, so the browser
 * calls the API directly.
 *
 * Measured against this repo's own configuration (express 4.21.2,
 * express-rate-limit 8.0.1, /api/analyze budget 20 per 15 minutes), 300
 * requests from one machine:
 *
 *   trust proxy 1, no header        20 allowed, 280 blocked
 *   trust proxy 1, rotating XFF    300 allowed,   0 blocked
 *   trust proxy false, rotating XFF 20 allowed, 280 blocked
 *
 * express-rate-limit's own validator does not flag `1` - it only errors on
 * `true` - which is why this survived review. Set TRUST_PROXY=1 when deploying
 * behind exactly one proxy that overwrites the header (Render, Fly, a load
 * balancer), and leave it unset anywhere the process is reachable directly.
 */
export function parseTrustProxy(raw) {
  if (raw === undefined || raw === "" || raw === "false") return false;
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  // A comma-separated list of trusted proxy addresses is the other safe form.
  if (raw.includes(".") || raw.includes(":")) return raw.split(",").map((entry) => entry.trim());
  // "true" trusts every hop, so any client can name its own address. Refused.
  console.warn(
    JSON.stringify({
      level: "warn",
      message: `TRUST_PROXY=${raw} is not a hop count or an address list; falling back to false`,
      hint: "Use the number of proxies in front of this process, e.g. TRUST_PROXY=1",
    })
  );
  return false;
}

function parseList(raw) {
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

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
