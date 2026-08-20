// services/analysisService.js - Chooses how a label gets analysed.
//
// Primary path: retrieval-augmented. Every verdict cites a passage retrieved
// from the Open Food Facts corpus, and an ingredient the corpus does not cover
// is returned in `uncovered` rather than guessed at.
//
// Degraded path: if the grounded path fails for an infrastructure reason - the
// corpus will not load, or the model produced nothing citable twice - the
// ungrounded analysis runs and the response is marked `grounded: false`. The
// degradation is visible in the payload and in the UI. Silently serving
// unattributable health claims from a food-safety tool is the failure this
// whole subsystem exists to prevent, so it degrades loudly or not at all.
import groqService, { GroqService } from "./groqService.js";
import { getRetriever } from "../rag/retriever.js";
import { analyzeGrounded } from "../rag/groundedAnalysis.js";
import { LLM_TIMEOUT, LLM_TOKENS } from "../configuration/constants.js";
import AnalysisHelpers from "../utils/helpers.js";
import logger from "../utils/logger.js";

/**
 * The only failures worth degrading for.
 *
 * An allow-list, not a deny-list: an unrecognised error propagates rather than
 * quietly switching the app to unsourced verdicts. Degrading on a provider
 * error would also be pointless, since the ungrounded path calls the same
 * provider.
 */
const DEGRADABLE_CODES = new Set(["GROUNDED_ANALYSIS_FAILED", "CORPUS_UNAVAILABLE"]);

export async function analyzeIngredients(ingredientsText, { isMobile = false, fastMode = true } = {}) {
  const names = AnalysisHelpers.parseIngredientList(ingredientsText);
  const timeout = isMobile ? LLM_TIMEOUT.mobile : fastMode ? LLM_TIMEOUT.fast : LLM_TIMEOUT.normal;
  const maxTokens = isMobile ? LLM_TOKENS.mobile : fastMode ? LLM_TOKENS.fast : LLM_TOKENS.normal;

  const complete = (prompt) => groqService.requestCompletion(prompt, maxTokens, timeout);
  const startedAt = Date.now();

  try {
    const result = await analyzeGrounded(names, {
      retriever: getRetriever(),
      complete,
      extractJsonArray: GroqService.extractJsonArray,
    });

    return {
      grounded: true,
      analysis: result.verdicts,
      uncovered: result.uncovered,
      contextChunks: result.contextChunks,
      attempts: result.attempts,
      droppedRows: result.droppedRows ?? 0,
      ingredientsParsed: names,
      aiTime: Date.now() - startedAt,
      retrievalMs: result.retrievalMs ?? 0,
      modelMs: result.modelMs ?? 0,
    };
  } catch (error) {
    const corpusMissing = /corpus|ENOENT|chunks\.json/i.test(error.message || "");
    if (!DEGRADABLE_CODES.has(error.code) && !corpusMissing) throw error;

    logger.warn("grounded analysis unavailable, degrading to ungrounded", {
      code: error.code,
      reason: error.message,
    });

    const fallback = await groqService.analyze(ingredientsText, { isMobile, fastMode });

    return {
      grounded: false,
      degradedReason:
        "The reference corpus could not produce a cited answer for this label, so these verdicts are the model's own and carry no source.",
      analysis: fallback.analysis.map((verdict) => ({ ...verdict, citations: [], sources: [] })),
      uncovered: [],
      contextChunks: [],
      attempts: fallback.attempts,
      droppedRows: fallback.droppedRows ?? 0,
      ingredientsParsed: names,
      aiTime: Date.now() - startedAt,
      // The degraded path does no retrieval at all, so every millisecond of it
      // is the provider.
      retrievalMs: 0,
      modelMs: fallback.aiTime ?? 0,
    };
  }
}

export default { analyzeIngredients };
