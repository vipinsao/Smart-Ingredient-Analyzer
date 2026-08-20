// middleware/errorHandler.js - The single place an error becomes an HTTP
// response.
//
// Order matters: typed errors are mapped by their code, framework errors by
// their known properties, and only then does anything fall back to matching on
// message text. The previous version matched on text first, which meant an
// oversized upload - whose message body-parser writes as "request entity too
// large" - fell through to a generic 500.
import AppError from "../utils/AppError.js";
import logger from "../utils/logger.js";
import { isProductionEnv } from "../configuration/env.js";

export class ErrorHandler {
  static handle(error, req, res) {
    const message = typeof error?.message === "string" ? error.message : "";

    let statusCode = 500;
    let errorResponse = { error: "Internal server error", code: "INTERNAL_ERROR" };

    if (error instanceof AppError) {
      statusCode = error.statusCode;
      errorResponse = { error: error.message, code: error.code };
    } else if (error?.type === "entity.too.large" || error?.status === 413) {
      statusCode = 413;
      errorResponse = {
        error: "Image is too large. Please use a smaller photo.",
        code: "IMAGE_TOO_LARGE",
      };
    } else if (error?.type === "entity.parse.failed") {
      statusCode = 400;
      errorResponse = { error: "Request body was not valid JSON", code: "INVALID_JSON" };
    } else if (message.includes("timeout")) {
      statusCode = 504;
      errorResponse = {
        error: "Analysis timed out. Please try with a clearer image.",
        code: "TIMEOUT_ERROR",
      };
    } else if (message.includes("quota exceeded")) {
      statusCode = 429;
      errorResponse = { error: "API quota exceeded. Please try again later.", code: "QUOTA_EXCEEDED" };
    } else if (message.includes("rate limit")) {
      statusCode = 429;
      errorResponse = { error: "Too many requests. Please wait a moment.", code: "RATE_LIMITED" };
    } else if (message.includes("network") || message.includes("fetch")) {
      statusCode = 503;
      errorResponse = { error: "Network error. Please check your connection.", code: "NETWORK_ERROR" };
    } else if (error?.code) {
      statusCode = error.statusCode || 400;
      errorResponse = { error: message || "Request failed", code: error.code };
    }

    logger.error("request failed", {
      code: errorResponse.code,
      statusCode,
      path: req?.originalUrl,
      detail: error?.details ?? message,
    });

    // Internal detail is exposed only in an environment that has explicitly
    // named itself development or test. The previous test was
    // `NODE_ENV !== "production"`, which leaked internals for every other value
    // the variable can hold - "prod", "staging", a typo, or the empty string a
    // container gets when the variable is dropped.
    if (!isProductionEnv()) {
      errorResponse.debug = error?.details ?? message;
    }

    // req.startTime is only set once the timing middleware has run; an error
    // thrown before it (body-parser rejecting an oversized body) would
    // otherwise report processingTime: NaN.
    if (typeof req?.startTime === "number") {
      errorResponse.processingTime = Date.now() - req.startTime;
    }

    return res.status(statusCode).json(errorResponse);
  }
}

export default ErrorHandler;
