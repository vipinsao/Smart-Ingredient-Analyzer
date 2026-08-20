// services/groqService.js - Ingredient analysis via Groq's OpenAI-compatible
// chat completions API.
//
// The contract with the model is "return a JSON array of verdicts". A model
// cannot be relied on to honour that, so every response goes through three
// gates before it is trusted:
//
//   1. extractJsonArray - find the array even if the model wrapped it in prose
//      or a code fence, and salvage whole objects out of a truncated array.
//   2. parseAnalysis     - validate each row against the Zod schema, coercing
//      what is coercible and dropping what is not.
//   3. one retry         - if a response survives neither, ask again once with
//      an explicit repair instruction. A second failure is a typed 502, not a
//      crash and not a half-rendered result.
import fetch from "node-fetch";
import { env } from "../configuration/env.js";
import { LLM_TIMEOUT, LLM_TOKENS } from "../configuration/constants.js";
import { parseAnalysis } from "../schemas/analysis.js";
import AppError from "../utils/AppError.js";
import logger from "../utils/logger.js";

const REPAIR_INSTRUCTION = `
Your previous answer could not be parsed as JSON.
Return ONLY a JSON array. No prose, no markdown fence, no trailing commas.
Every element must have exactly these keys: "ingredient" (string),
"status" (one of "Good", "Bad", "Neutral"), "reason" (string),
"concerns" (array of strings).`;

export class GroqService {
  constructor() {
    this.baseUrl = env.GROQ_BASE_URL;
    this.apiKey = env.GROQ_API_KEY;
    this.model = env.GROQ_MODEL;
  }

  createPrompt(ingredients) {
    return `You are a certified nutritionist and food safety expert. Analyze these food ingredients and provide a comprehensive health assessment.

IMPORTANT JSON RULES:
- Return ONLY a valid JSON array that can be parsed with JavaScript JSON.parse.
- Do NOT wrap the JSON in markdown or code fences.
- Do NOT include any text before or after the JSON.
- Do NOT use double quotes inside any string values. If you need quotes, use single quotes instead.
- All keys MUST be in double quotes.
- All string values MUST be in double quotes.
- No trailing commas are allowed.

Special notes for Indian food additives:
- INS codes (like INS1422, INS415, etc.) are food additive codes used in India
- Treat these as stabilizers, emulsifiers, or preservatives based on their function
- Jaggery is unrefined sugar, healthier than white sugar but still sugar
- Tamarind is a natural fruit extract, generally good

For each ingredient, determine:
- Health impact (Good/Bad/Neutral)
- Brief scientific reason
- Specific health concerns if any

Ingredients to analyze:
${ingredients}

Expected JSON format:
[{
  "ingredient": "sugar",
  "status": "Bad",
  "reason": "High glycemic index, linked to obesity and diabetes",
  "concerns": ["diabetes", "obesity", "dental health"]
}]`;
  }

  /**
   * Pull a JSON array out of a model response.
   *
   * Handles the two failure shapes seen in practice: a code fence around the
   * array, and an array truncated by the token limit. In the truncated case the
   * complete `{...}` objects are salvaged and the incomplete tail is dropped -
   * eleven good verdicts are worth more than an error page.
   *
   * @returns {Array|null} null when nothing parseable was found.
   */
  static extractJsonArray(text) {
    if (typeof text !== "string" || text.trim() === "") return null;

    const cleaned = text
      .trim()
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();

    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    const candidate = arrayMatch ? arrayMatch[0] : cleaned;

    try {
      const parsed = JSON.parse(candidate);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      const objectMatches = candidate.match(/{[^{}]*}/g) || [];
      if (objectMatches.length === 0) return null;

      try {
        return JSON.parse(`[${objectMatches.join(",")}]`);
      } catch {
        return null;
      }
    }
  }

  async analyze(ingredients, options = {}) {
    const { isMobile = false, fastMode = true } = options;

    const timeout = isMobile ? LLM_TIMEOUT.mobile : fastMode ? LLM_TIMEOUT.fast : LLM_TIMEOUT.normal;
    const maxTokens = isMobile ? LLM_TOKENS.mobile : fastMode ? LLM_TOKENS.fast : LLM_TOKENS.normal;

    const basePrompt = this.createPrompt(ingredients);
    const startTime = Date.now();

    let lastFailure = null;

    // Attempt 1: the normal prompt. Attempt 2: the same prompt plus an
    // explicit repair instruction.
    for (const attempt of [1, 2]) {
      const prompt = attempt === 1 ? basePrompt : `${basePrompt}\n${REPAIR_INSTRUCTION}`;

      const content = await this.requestCompletion(prompt, maxTokens, timeout);
      const raw = GroqService.extractJsonArray(content);

      if (raw) {
        try {
          const { verdicts, dropped } = parseAnalysis(raw);
          if (dropped > 0) {
            logger.warn("dropped unusable verdict rows from model response", {
              dropped,
              kept: verdicts.length,
              attempt,
            });
          }
          return {
            analysis: verdicts,
            aiTime: Date.now() - startTime,
            attempts: attempt,
            droppedRows: dropped,
            success: true,
          };
        } catch (error) {
          lastFailure = error.message;
        }
      } else {
        lastFailure = "response contained no parseable JSON array";
      }

      logger.warn("model response failed validation", { attempt, reason: lastFailure });
    }

    throw new AppError(
      "The analysis service returned an unusable response. Please try again.",
      { code: "ANALYSIS_UNAVAILABLE", statusCode: 502, details: lastFailure }
    );
  }

  /**
   * One HTTP call to Groq. Returns the assistant message content.
   *
   * Kept as the narrow contract every caller already uses. The token counts
   * live on `requestCompletionDetailed` below rather than here, so that adding
   * accounting did not change the shape of the value the request path passes
   * into `analyzeGrounded`.
   */
  async requestCompletion(prompt, maxTokens, timeoutMs) {
    const { content } = await this.requestCompletionDetailed(prompt, maxTokens, timeoutMs);
    return content;
  }

  /**
   * The same call, with what it cost.
   *
   * @returns {Promise<{content: string, usage: object|null, latencyMs: number}>}
   *          `usage` is the provider's own token count, or null when the
   *          endpoint did not report one - scripts/stub-llm.js does not. It is
   *          passed through unmodified and never estimated from the character
   *          count, because an estimate that looks like a measurement is worse
   *          than an absent number.
   */
  async requestCompletionDetailed(prompt, maxTokens, timeoutMs) {
    // Checked here rather than at boot. Everything upstream of this line - OCR,
    // the corpus, retrieval, abstention - needs no key and now runs without
    // one, so a missing key costs the verdicts and nothing else.
    if (!this.apiKey || String(this.apiKey).trim() === "") {
      throw new AppError(
        "Ingredient verdicts need a GROQ_API_KEY. OCR and retrieval ran; generation did not.",
        {
          code: "GENERATION_NOT_CONFIGURED",
          statusCode: 503,
          details: "Set GROQ_API_KEY in back-end/.env - a free key from https://console.groq.com/keys",
        }
      );
    }

    const startedAt = performance.now();

    let response;
    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.1,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw new AppError("Analysis timed out. Please try again.", {
          code: "ANALYSIS_TIMEOUT",
          statusCode: 504,
        });
      }
      throw new AppError("Could not reach the analysis service.", {
        code: "ANALYSIS_UNREACHABLE",
        statusCode: 503,
        details: error.message,
      });
    }

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        detail = body?.error?.message || detail;
      } catch {
        // Groq returned a non-JSON error body; the status alone is the detail.
      }

      // 429 from the provider is a rate limit, not our bug - say so plainly.
      const statusCode = response.status === 429 ? 429 : 502;
      throw new AppError(
        response.status === 429
          ? "Analysis service is rate limited. Please wait a moment and try again."
          : "Analysis service returned an error.",
        { code: response.status === 429 ? "ANALYSIS_RATE_LIMITED" : "ANALYSIS_HTTP_ERROR", statusCode, details: detail }
      );
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (typeof content !== "string" || content.trim() === "") {
      throw new AppError("Analysis service returned an empty response.", {
        code: "ANALYSIS_EMPTY",
        statusCode: 502,
      });
    }

    return {
      content,
      usage: data?.usage ?? null,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}

export default new GroqService();
