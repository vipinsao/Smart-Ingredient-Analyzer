// services/ocrPool.js - A Tesseract worker pool with a lifecycle.
//
// The problem this solves, measured with scripts/bench-ocr-worker.js:
// `Tesseract.recognize(buffer, "eng", ...)` is a convenience wrapper that
// creates a worker, runs one image, and terminates it. A worker is a child
// process that loads a WASM core and a 5.2MB language pack before it reads a
// single glyph, and that cost is paid again by every request. Here it is paid
// once, at boot.
//
// Two mechanisms, deliberately separate:
//
//   scheduler   tesseract.js's own createScheduler dispatches a job to whichever
//               pooled worker is idle. It owns which worker runs the work.
//   semaphore   admission control in front of the scheduler. It owns how many
//               jobs may be in flight and how many may wait, so the queue depth
//               is bounded and the wait is measurable. The scheduler's own queue
//               is unbounded, and an unbounded queue on a one-core container
//               does not fail - it just stops answering, which is worse.
//
// Sizing: see OCR_POOL_SIZE below. On a single shared CPU, extra workers do not
// make OCR faster, they make every concurrent request slower at once and add a
// resident WASM heap each.
import Tesseract from "tesseract.js";
import AppError from "../utils/AppError.js";
import logger from "../utils/logger.js";

/**
 * Recognition parameters. Unchanged from the per-request call this replaces -
 * a pooled worker must read the same image the same way, or the speed-up is
 * confounded with an accuracy change.
 */
export const TESSERACT_PARAMETERS = {
  tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
  tessedit_char_whitelist:
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789,().-% :",
};

/**
 * How many workers, and how deep the queue in front of them may get.
 *
 * The default is 1. Not a guess: `taskset -c 0 node scripts/bench-ocr-pool.js`
 * measures pool sizes 1..3 under concurrent load on a single core, and on one
 * core a second worker cannot run in parallel with the first - it only splits
 * the same core between two WASM heaps, so throughput is flat and every
 * individual request gets slower. The free hosting tier this app targets is a
 * single shared CPU with 512MB, so 1 is the size that fits it. Raise it with
 * OCR_POOL_SIZE on a box with real cores, after re-running the benchmark there.
 */
export const DEFAULT_POOL_SIZE = 1;

/**
 * Queue depth beyond which new work is refused rather than accepted and left to
 * time out in a browser. Four deep at ~5s of OCR each is already a 20s wait; a
 * fifth caller is better served by a 503 that says "busy" than by a spinner.
 */
export const DEFAULT_MAX_QUEUE = 4;

function readSize(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

let pool = null;

/**
 * Build the pool. Idempotent and concurrency-safe: the promise is stored, not
 * the resolved value, so ten simultaneous first-requests all await one build
 * rather than starting ten pools.
 */
function ensurePool() {
  if (pool) return pool;

  const size = readSize("OCR_POOL_SIZE", DEFAULT_POOL_SIZE);
  const maxQueue = readSize("OCR_MAX_QUEUE", DEFAULT_MAX_QUEUE);
  const started = performance.now();

  const scheduler = Tesseract.createScheduler();

  const ready = (async () => {
    const workers = await Promise.all(
      Array.from({ length: size }, async () => {
        const worker = await Tesseract.createWorker("eng", undefined, {
          logger: () => {},
          // Not optional. tesseract.js rejects the job promise AND, if no
          // errorHandler is supplied, re-throws inside its own message handler,
          // where nothing can catch it - so one undecodable image takes the
          // process down with an uncaught exception even though the request
          // that caused it was already being handled. Supplying a handler keeps
          // the rejection and drops the throw.
          errorHandler: (reason) => logger.warn("tesseract worker reported an error", { reason: String(reason) }),
        });
        await worker.setParameters(TESSERACT_PARAMETERS);
        scheduler.addWorker(worker);
        return worker;
      })
    );
    logger.info("ocr pool ready", {
      workers: size,
      maxQueue,
      ms: Math.round(performance.now() - started),
    });
    return workers;
  })();

  pool = { scheduler, ready, size, maxQueue, inFlight: 0, waiting: [], queued: 0 };

  // A failed build must not stay cached, or the process serves 500s forever
  // instead of retrying on the next request. Attached after the assignment so
  // the identity check below always has a pool to compare against.
  ready.catch((error) => {
    logger.error("ocr pool failed to start", { reason: error?.message });
    if (pool && pool.ready === ready) pool = null;
  });

  return pool;
}

/** Take a slot, or wait for one. Rejects immediately when the queue is full. */
function acquire(current) {
  if (current.inFlight < current.size) {
    current.inFlight += 1;
    return Promise.resolve(0);
  }

  if (current.queued >= current.maxQueue) {
    return Promise.reject(
      new AppError("The analyzer is busy. Please try again in a moment.", {
        code: "OCR_BUSY",
        statusCode: 503,
        details: `queue full (${current.queued}/${current.maxQueue})`,
      })
    );
  }

  current.queued += 1;
  const queuedAt = performance.now();
  return new Promise((resolve) => {
    current.waiting.push(() => {
      current.queued -= 1;
      current.inFlight += 1;
      resolve(Math.round(performance.now() - queuedAt));
    });
  });
}

function release(current) {
  current.inFlight -= 1;
  const next = current.waiting.shift();
  if (next) next();
}

/**
 * Warm the pool before the first request arrives.
 *
 * Called at boot so the worker startup lands on an idle process rather than on
 * whoever shows up first. It deliberately does not block listening: /health must
 * answer while this is still running, because a platform health check that times
 * out during warm-up restarts the container it is waiting for.
 */
export async function warmOcrPool() {
  const current = ensurePool();
  await current.ready;
  return { workers: current.size, maxQueue: current.maxQueue };
}

/**
 * Recognise one image on a pooled worker.
 *
 * @param {Buffer} image already pre-processed bytes
 * @returns {Promise<{data: object, waitMs: number, recogniseMs: number}>}
 *          `waitMs` is time spent queued behind other requests, reported apart
 *          from recognition so a slow response can be attributed to load rather
 *          than to OCR.
 */
export async function recognize(image) {
  const current = ensurePool();
  const waitMs = await acquire(current);

  try {
    await current.ready;
    const started = performance.now();
    const result = await current.scheduler.addJob("recognize", image);
    return { data: result.data, waitMs, recogniseMs: Math.round(performance.now() - started) };
  } finally {
    release(current);
  }
}

/**
 * Terminate every worker and forget the pool.
 *
 * Without this the child processes outlive a SIGTERM and the container has to be
 * killed rather than stopped. Safe to call when no pool was ever built, and safe
 * to call twice, because a shutdown path that throws is a shutdown path nobody
 * runs.
 */
export async function terminateOcrPool() {
  if (!pool) return;
  const current = pool;
  pool = null;

  try {
    await current.ready.catch(() => {});
    await current.scheduler.terminate();
    logger.info("ocr pool terminated", { workers: current.size });
  } catch (error) {
    logger.warn("ocr pool did not terminate cleanly", { reason: error?.message });
  }
}

/** Introspection for /health and for the tests. */
export function ocrPoolStats() {
  if (!pool) return { started: false };
  return {
    started: true,
    workers: pool.size,
    maxQueue: pool.maxQueue,
    inFlight: pool.inFlight,
    queued: pool.queued,
  };
}

export default { warmOcrPool, recognize, terminateOcrPool, ocrPoolStats, TESSERACT_PARAMETERS };
