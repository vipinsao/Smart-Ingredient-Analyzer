// server.js - HTTP layer.
//
// Pipeline for POST /api/analyze:
//   validate body -> decode base64 -> validate bytes (size + magic number)
//   -> image cache lookup -> preprocess + OCR -> extract ingredient text
//   -> text cache lookup -> LLM analysis (schema-validated) -> deterministic
//      allergen + health scoring -> respond.
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import crypto from "crypto";

import { env, validateEnv } from "./configuration/env.js";
import {
  RATE_LIMIT_CONFIG,
  ANALYZE_RATE_LIMIT,
  IMAGE_LIMITS,
} from "./configuration/constants.js";

import ocrService from "./services/ocrService.js";
import { warmOcrPool, terminateOcrPool, ocrPoolStats } from "./services/ocrPool.js";
import { getRetriever, isRetrieverLoaded, readCorpusMeta } from "./rag/retriever.js";
import { getExtractor } from "./rag/embedder.js";
import { analyzeIngredients } from "./services/analysisService.js";
import cacheManager from "./utils/cache.js";
import Validators from "./utils/validators.js";
import AnalysisHelpers from "./utils/helpers.js";
import ErrorHandler from "./middleware/errorHandler.js";
import AppError from "./utils/AppError.js";
import logger from "./utils/logger.js";
import stopwatch from "./utils/stopwatch.js";

const { geminiOcrEnabled } = validateEnv();

const app = express();
const PORT = env.PORT;

// ============= MIDDLEWARE =============

app.use(helmet());

// Render, Fly and every other PaSS put a proxy in front of the app. Without
// this every client shares the proxy's IP and the per-IP rate limiter becomes
// one global bucket. `1` trusts exactly one hop - not `true`, which would let
// a client spoof its own address via X-Forwarded-For.
app.set("trust proxy", 1);

app.use(rateLimit({
  windowMs: RATE_LIMIT_CONFIG.windowMs,
  max: RATE_LIMIT_CONFIG.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later", code: "RATE_LIMITED" },
}));

// Tighter budget for the one route that costs OCR CPU and a model call.
const analyzeLimiter = rateLimit({
  windowMs: ANALYZE_RATE_LIMIT.windowMs,
  max: ANALYZE_RATE_LIMIT.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Analysis limit reached. Please wait a few minutes before trying again.",
    code: "ANALYZE_RATE_LIMITED",
  },
});

const allowedOrigins =
  env.NODE_ENV === "production"
    ? [
        "https://smart-ingredient-analyzer.vercel.app",
        "https://ai-ingredient-analyzer.vercel.app",
        /\.vercel\.app$/,
      ]
    : [
        "http://localhost:8080",   // the nginx container from docker compose
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:4173",
        "http://127.0.0.1:5173",
      ];

app.use(cors({ origin: allowedOrigins, credentials: true }));

app.use(express.json({ limit: IMAGE_LIMITS.maxBodySize }));

app.use((req, res, next) => {
  req.startTime = Date.now();
  req.id = crypto.randomUUID();
  next();
});

// ============= ROUTES =============

// Deliberately cheap. This endpoint is what the hosting platform polls to
// decide whether the container is alive, so it must answer while the heavy
// initialisation started at boot is still running - a probe that times out
// waiting for warm-up restarts the container it is waiting for, forever. It
// reports readiness rather than blocking on it.
app.get("/health", (req, res) => {
  let corpus = null;
  try {
    // meta.json only: a few hundred bytes, not the 1.3MB corpus and not the
    // BM25 index build. `loaded` says whether the real thing is in memory yet.
    const meta = readCorpusMeta();
    corpus = {
      chunks: meta.chunks,
      model: meta.model,
      builtAt: meta.builtAt,
      loaded: isRetrieverLoaded(),
    };
  } catch (error) {
    corpus = { error: error.message };
  }

  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptimeMs: Math.round(process.uptime() * 1000),
    ocr: geminiOcrEnabled ? "gemini-vision + tesseract" : "tesseract",
    model: env.GROQ_MODEL,
    warmup: { ...warmupState, ocrPool: ocrPoolStats() },
    corpus,
  });
});

app.post("/api/analyze", analyzeLimiter, async (req, res, next) => {
  try {
    const timer = stopwatch();

    const bodyValidation = Validators.validateRequestBody(req);
    if (!bodyValidation.valid) return res.status(400).json(bodyValidation);

    const { image, fastMode = true, isMobile = false } = req.body;

    const imageValidation = Validators.validateImage(image);
    if (!imageValidation.valid) return res.status(400).json(imageValidation);

    const base64Data = image.includes(",") ? image.split(",")[1] : image;

    const base64Validation = Validators.validateBase64(base64Data);
    if (!base64Validation.valid) return res.status(400).json(base64Validation);

    const imageBuffer = Buffer.from(base64Data, "base64");

    const bufferValidation = Validators.validateImageBuffer(imageBuffer);
    if (!bufferValidation.valid) {
      return res.status(bufferValidation.statusCode || 400).json(bufferValidation);
    }

    timer.mark("decode");

    logger.info("analyze request received", {
      requestId: req.id,
      bytes: imageBuffer.length,
      format: bufferValidation.format,
      isMobile,
      fastMode,
    });

    // Cache hit on the exact image skips OCR, which is the expensive half of
    // the pipeline (seconds, versus a few hundred milliseconds for the model).
    const imageKey = cacheManager.generateImageKey(imageBuffer);
    const cachedByImage = cacheManager.get(imageKey);
    if (cachedByImage) {
      timer.mark("cacheLookup");
      const timings = timer.report();
      logger.info("cache hit", { requestId: req.id, on: "image", timings });
      // The cached body carries the timings of the request that produced it.
      // Serving those unchanged would make a cache hit report seconds of OCR it
      // never ran, so they are replaced with this request's own.
      return res.json({
        ...cachedByImage,
        cached: true,
        cacheHit: "image",
        processingTime: timings.totalMs,
        timings,
      });
    }
    timer.mark("cacheLookup");

    const ocrResult = await ocrService.processImage(imageBuffer, { isMobile });
    timer.mark("ocr");
    timer.record("ocrPreprocess", ocrResult.preprocessMs);
    timer.record("ocrWait", ocrResult.waitMs);
    timer.record("ocrRecognise", ocrResult.recogniseMs ?? ocrResult.processingTime);

    const ingredientsText = AnalysisHelpers.extractIngredients(ocrResult.text);
    const ingredientsValidation = Validators.validateIngredients(ingredientsText);

    if (!ingredientsValidation.valid) {
      throw new AppError(ingredientsValidation.error, {
        code: ingredientsValidation.code,
        statusCode: 422,
        details: {
          ocrMethod: ocrResult.method,
          ocrConfidence: ocrResult.confidence,
          extractedLength: ingredientsText.length,
        },
      });
    }

    timer.mark("extract");

    const textKey = cacheManager.generateKey(ingredientsText);
    const cachedByText = cacheManager.get(textKey);
    if (cachedByText) {
      const timings = timer.report();
      logger.info("cache hit", { requestId: req.id, on: "text", timings });
      cacheManager.set(imageKey, cachedByText);
      return res.json({
        ...cachedByText,
        cached: true,
        cacheHit: "text",
        processingTime: timings.totalMs,
        timings,
      });
    }

    const analysisResult = await analyzeIngredients(ingredientsText, { isMobile, fastMode });
    timer.mark("analyse");
    timer.record("retrieval", analysisResult.retrievalMs);
    timer.record("model", analysisResult.modelMs);

    // Allergens and the health score are computed here, not asked of the
    // model: same label in, same flags out, every time.
    const { allergens, details: allergenDetails } =
      AnalysisHelpers.detectAllergenDetails(ingredientsText);
    const healthScore = AnalysisHelpers.calculateHealthScore(analysisResult.analysis);
    const harmfulIngredients = AnalysisHelpers.detectHarmfulIngredients(analysisResult.analysis);
    timer.mark("score");

    const result = {
      ingredientsText,
      analysis: analysisResult.analysis,
      // Ingredients the corpus does not cover are reported, not guessed at.
      uncovered: analysisResult.uncovered,
      grounded: analysisResult.grounded,
      degradedReason: analysisResult.degradedReason,
      sourcesConsulted: analysisResult.contextChunks,
      coverage: {
        parsed: analysisResult.ingredientsParsed.length,
        analysed: analysisResult.analysis.length,
        uncovered: analysisResult.uncovered.length,
      },
      healthScore,
      allergens,
      allergenDetails,
      harmfulIngredients,
      ocrConfidence: ocrResult.confidence,
      ocrMethod: ocrResult.method,
      processingTime: timer.totalMs,
      timings: timer.report(),
      aiTime: analysisResult.aiTime,
      llmAttempts: analysisResult.attempts,
      droppedRows: analysisResult.droppedRows,
      fastMode,
      isMobile,
      cached: false,
    };

    cacheManager.set(textKey, result);
    cacheManager.set(imageKey, result);

    logger.info("analyze complete", {
      requestId: req.id,
      timings: result.timings,
      ocrMethod: ocrResult.method,
      grounded: analysisResult.grounded,
      ingredients: analysisResult.analysis.length,
      uncovered: analysisResult.uncovered.length,
      allergens,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found", code: "NOT_FOUND" });
});

app.use((error, req, res, next) => ErrorHandler.handle(error, req, res));

// ============= LIFECYCLE =============

// An unhandled rejection would otherwise terminate the process on Node 20+
// with no explanation of what failed.
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled promise rejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

let shuttingDown = false;

const SHUTDOWN_TIMEOUT_MS = 5000;

// The OCR pool is a set of child processes. Left running they outlive the
// signal and the container has to be killed rather than stopped, so the exit is
// asynchronous now - with a deadline, because a shutdown that hangs waiting for
// a stuck worker is not a shutdown.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });

  const timer = setTimeout(() => {
    logger.warn("shutdown timed out, exiting anyway", { signal });
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();

  try {
    await terminateOcrPool();
  } catch (error) {
    logger.warn("shutdown error", { reason: error?.message });
  }

  cacheManager.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/**
 * Work the first request would otherwise pay for, moved to boot.
 *
 * Started after listen(), never awaited before it: the Tesseract worker, the
 * ONNX embedding session and the corpus are between them the several seconds a
 * cold instance used to charge to whoever arrived first. Failures here are
 * logged, not fatal - each of these paths still initialises lazily on demand,
 * so a warm-up that fails costs latency, not availability.
 */
const warmupState = { ocrPool: null, corpus: false, embedder: false };

function warmUp() {
  const started = performance.now();

  const tasks = [
    warmOcrPool()
      .then(() => { warmupState.ocrPool = "ready"; })
      .catch((error) => {
        warmupState.ocrPool = "failed";
        logger.warn("ocr pool warm-up failed", { reason: error?.message });
      }),
    Promise.resolve()
      .then(() => { getRetriever(); warmupState.corpus = true; })
      .catch((error) => logger.warn("corpus warm-up failed", { reason: error?.message })),
    getExtractor()
      .then(() => { warmupState.embedder = true; })
      .catch((error) => logger.warn("embedder warm-up failed", { reason: error?.message })),
  ];

  Promise.all(tasks).then(() => {
    logger.info("warm-up complete", { ms: Math.round(performance.now() - started), ...warmupState });
  });
}

app.listen(PORT, () => {
  logger.info("server listening", {
    port: PORT,
    env: env.NODE_ENV,
    model: env.GROQ_MODEL,
    geminiOcr: geminiOcrEnabled,
  });
  warmUp();
});

export default app;
