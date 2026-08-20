// utils/logger.js - Structured (JSON-line) logging.
//
// One JSON object per line so the output is greppable and parseable by any log
// collector. `LOG_LEVEL` (error|warn|info|debug) filters output; default info.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const configuredLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
const threshold = LEVELS[configuredLevel] ?? LEVELS.info;

function emit(level, message, fields = {}) {
  if (LEVELS[level] > threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
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
