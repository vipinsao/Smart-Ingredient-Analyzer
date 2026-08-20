// utils/logger.js - Structured (JSON-line) logging.
//
// One JSON object per line so the output is greppable and parseable by any log
// collector. `LOG_LEVEL` (error|warn|info|debug) filters output; default info.
//
// Every line emitted inside a span also carries `traceId` and `spanId`. That is
// the join between the two halves of the observability story: the trace says
// which stage was slow, the log line says what it decided, and without a shared
// key you are eyeballing timestamps. The import is the OpenTelemetry API
// facade, which is a no-op until something registers a provider - so a process
// with telemetry switched off pays one null check per line and logs exactly
// what it logged before.
import { trace, context } from "@opentelemetry/api";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configuredLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
const threshold = LEVELS[configuredLevel] ?? LEVELS.info;

const INVALID_TRACE_ID = "00000000000000000000000000000000";

function emit(level, message, fields = {}) {
  if (LEVELS[level] > threshold) return;
  const spanContext = trace.getSpan(context.active())?.spanContext();
  const correlation =
    spanContext && spanContext.traceId !== INVALID_TRACE_ID
      ? { traceId: spanContext.traceId, spanId: spanContext.spanId }
      : null;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...correlation,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  error: (message, fields) => emit("error", message, fields),
  warn: (message, fields) => emit("warn", message, fields),
  info: (message, fields) => emit("info", message, fields),
  debug: (message, fields) => emit("debug", message, fields),
};

export default logger;
