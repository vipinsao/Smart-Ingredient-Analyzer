// utils/stopwatch.js - Per-request stage timing.
//
// The pipeline had exactly two numbers in it: total time, and the model call.
// Everything between them - preprocessing, worker startup, recognition,
// retrieval, scoring - was one opaque block, which is why "it is slow, probably
// Tesseract" was as precise as anybody could be about it. This records the
// boundary between every stage so the answer is a table instead of a guess.
//
// performance.now() rather than Date.now(): it is monotonic, so a clock
// adjustment mid-request cannot produce a negative stage.
export function stopwatch() {
  const started = performance.now();
  let last = started;
  const stages = {};

  return {
    /** Close the stage that has been running since the previous mark. */
    mark(name) {
      const now = performance.now();
      stages[name] = round(now - last);
      last = now;
      return stages[name];
    },
    /** Record a duration measured somewhere else (inside the OCR layer, say). */
    record(name, ms) {
      if (typeof ms === "number" && Number.isFinite(ms)) stages[name] = round(ms);
    },
    /** Discard time spent on work that is not the caller's to account for. */
    skip() {
      last = performance.now();
    },
    get totalMs() {
      return round(performance.now() - started);
    },
    /** @returns {object} stage name -> milliseconds, plus the total. */
    report() {
      return { ...stages, totalMs: round(performance.now() - started) };
    },
  };
}

function round(ms) {
  return Math.round(ms * 10) / 10;
}

export default stopwatch;
