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
 * The default is 1, and it is measured rather than assumed. Run:
 *
 *   OCR_POOL_SIZE=1 taskset -c 0 node scripts/loadtest.js 6 1 2 3 4
 *
 * and again with 2 and 3. On one core of this machine (i5-9300H, WSL2, Node 24),
 * p50 at concurrency 1 and sustained throughput across concurrency 1-4:
 *
 *   pool 1   p50  2214ms   0.37 - 0.46 req/s
 *   pool 2   p50  4021ms   0.17 - 0.35 req/s
 *   pool 3   p50  8701ms   0.12 - 0.24 req/s
 *
 * More workers is not slightly worse, it is much worse, and it is worse even at
 * concurrency 1. A second worker cannot run in parallel with the first on one
 * core; it only adds another resident WASM heap for the same core to page
 * around. The free hosting tier this targets is a single shared CPU, so 1 is
 * the size that fits it. OCR_POOL_SIZE raises it on a box with real cores -
 * after re-running that sweep there, because the answer is a property of the
 * machine and not of this file.
 */
export const DEFAULT_POOL_SIZE = 1;

/**
 * Queue depth beyond which new work is refused rather than accepted and left to
 * time out in a browser. Four deep at ~5s of OCR each is already a 20s wait; a
 * fifth caller is better served by a 503 that says "busy" than by a spinner.
 */
export const DEFAULT_MAX_QUEUE = 4;

/**
 * Deadline for one recognition, after which the worker running it is destroyed.
 *
 * The queue bound above stops an unbounded backlog, but on its own it made the
 * 503 the *mechanism* of a denial rather than a defence against it: with one
 * worker and no time bound, a single slow job held the pool and everyone else
 * was refused instantly. There was no timeout and no abort on the scheduler
 * job, so "slow" meant "for as long as the attacker chose".
 *
 * The pre-processing pixel cap (OCR_PREPROCESS.maxPixels) is the first half of
 * the fix and bounds the work by construction. This is the second half, and it
 * is the one that does not depend on having predicted the input: whatever gets
 * through, it stops after the deadline below.
 *
 * 60s, and the first value tried here was 30s, which measurement rejected.
 *
 * The pixel cap bounds the work to within a factor of about two, not exactly.
 * `npm run bench:bounds` holds the pixel count at the 4M cap and varies the
 * shape; on one core at load 3.97 the same 4.0M pixels measured:
 *
 *   2000x2000    12989ms
 *   1265x3162    27628ms   <- worst
 *    632x6325    19665ms
 *    400x10000   17461ms
 *    200x20000   19429ms
 *
 * A 2.1x spread at identical pixel counts, and not monotonic in aspect ratio,
 * so no simple shape rule tightens it. 30s left a 1.09x margin over the worst
 * legitimate image the cap admits - it would have fired on real uploads. 60s is
 * ~2.2x that worst case.
 *
 * The cost of the larger number is stated rather than hidden: one request can
 * hold the single worker for a minute. What bounds that in aggregate is the
 * rate limiter, which is why it had to be repaired first, and the queue depth
 * above. It also lands near the point where the browser gives up anyway.
 *
 * A timed-out job cannot be cancelled - tesseract.js exposes no abort - so the
 * worker is terminated and the pool rebuilt. Rejecting the caller while leaving
 * the worker chewing would free the semaphore slot and not the CPU, which is
 * the same denial with better bookkeeping.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 60_000;

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
  const jobTimeoutMs = readSize("OCR_JOB_TIMEOUT_MS", DEFAULT_JOB_TIMEOUT_MS);
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
      jobTimeoutMs,
      ms: Math.round(performance.now() - started),
    });
    return workers;
  })();

  pool = { scheduler, ready, size, maxQueue, jobTimeoutMs, inFlight: 0, waiting: [], queued: 0, poisoned: false };

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

  // A waiter is an object rather than a bare callback because it can be woken
  // two ways: a slot frees (resolve), or the pool is destroyed under it
  // (reject). Before the deadline existed there was only one way.
  return new Promise((resolve, reject) => {
    current.waiting.push({
      resolve: () => {
        current.queued -= 1;
        current.inFlight += 1;
        resolve(Math.round(performance.now() - queuedAt));
      },
      reject,
    });
  });
}

function release(current) {
  current.inFlight -= 1;
  const next = current.waiting.shift();
  if (next) next.resolve();
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
    const result = await withDeadline(current, current.scheduler.addJob("recognize", image));
    return { data: result.data, waitMs, recogniseMs: Math.round(performance.now() - started) };
  } finally {
    release(current);
  }
}

/**
 * Race one job against the pool's deadline. Losing the race destroys the pool.
 *
 * The rejected promise from `addJob` is deliberately still awaited-and-ignored
 * on the timeout path: it settles when the terminated worker's channel closes,
 * and an unhandled rejection there would be logged as a crash in a path that is
 * working exactly as designed.
 */
function withDeadline(current, job) {
  job.catch(() => {});

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      poisonPool(current, `a recognition exceeded ${current.jobTimeoutMs}ms`);
      reject(
        new AppError("That image took too long to read. Try a smaller or simpler photo.", {
          code: "OCR_TIMEOUT",
          statusCode: 504,
          details: `exceeded ${current.jobTimeoutMs}ms`,
        })
      );
    }, current.jobTimeoutMs);

    job.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * Destroy a pool whose worker cannot be trusted to stop, and free anyone
 * waiting on it.
 *
 * The queued callers are rejected rather than migrated: they were queued behind
 * a job that has just been abandoned mid-flight, the workers they were waiting
 * for are being terminated, and a 503 telling them to retry is both true and
 * immediate. Silently re-queueing them onto a pool that is still being rebuilt
 * is how a queue turns into a hang.
 */
function poisonPool(current, reason) {
  if (current.poisoned) return;
  current.poisoned = true;
  logger.warn("terminating the ocr pool", { reason });

  if (pool === current) pool = null;

  const waiting = current.waiting.splice(0, current.waiting.length);
  current.queued = 0;
  for (const wake of waiting) wake.reject(new AppError("The analyzer is restarting. Please try again.", {
    code: "OCR_BUSY",
    statusCode: 503,
    details: reason,
  }));

  current.ready
    .then((workers) => Promise.all(workers.map((worker) => worker.terminate())))
    .catch((error) => logger.warn("could not terminate a poisoned ocr pool", { reason: error?.message }));
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
