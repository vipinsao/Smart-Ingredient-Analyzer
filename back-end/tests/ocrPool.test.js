// tests/ocrPool.test.js - The pool's lifecycle and its admission control.
//
// The pool exists to stop a Tesseract worker being created and destroyed per
// request. What has to hold for that to be safe rather than just faster:
// building it twice must not produce two pools, a full queue must be refused
// rather than silently accepted, a rejected job must still give its slot back,
// and terminate must be callable on a pool that was never built and on one that
// already died - because a shutdown path that throws is a shutdown path that
// leaves child processes behind.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

const SMALL_IMAGE = await sharp({
  create: { width: 240, height: 80, channels: 3, background: { r: 255, g: 255, b: 255 } },
})
  .png()
  .toBuffer();

/**
 * Each test gets a pool built from its own configuration. The module keeps one
 * pool per process, so the environment has to be set before the first call and
 * the pool torn down after - otherwise the second test silently measures the
 * first test's pool.
 */
async function withPool({ size = 1, maxQueue = 4 }, body) {
  const previous = { size: process.env.OCR_POOL_SIZE, maxQueue: process.env.OCR_MAX_QUEUE };
  process.env.OCR_POOL_SIZE = String(size);
  process.env.OCR_MAX_QUEUE = String(maxQueue);

  const pool = await import("../services/ocrPool.js");
  await pool.terminateOcrPool();

  try {
    await pool.warmOcrPool();
    await body(pool);
  } finally {
    await pool.terminateOcrPool();
    if (previous.size === undefined) delete process.env.OCR_POOL_SIZE;
    else process.env.OCR_POOL_SIZE = previous.size;
    if (previous.maxQueue === undefined) delete process.env.OCR_MAX_QUEUE;
    else process.env.OCR_MAX_QUEUE = previous.maxQueue;
  }
}

test("the pool is warmed once and reused across recognitions", async () => {
  await withPool({ size: 1 }, async (pool) => {
    assert.deepEqual(pool.ocrPoolStats(), {
      started: true,
      workers: 1,
      maxQueue: 4,
      inFlight: 0,
      queued: 0,
    });

    const first = await pool.recognize(SMALL_IMAGE);
    const second = await pool.recognize(SMALL_IMAGE);

    assert.equal(typeof first.data.text, "string");
    assert.equal(typeof second.data.text, "string");
    // Nothing queued: one worker, one request at a time.
    assert.equal(first.waitMs, 0);
    assert.equal(second.waitMs, 0);
    // Still one worker. A second pool would have been built if warm-up were
    // not idempotent, and the worker count would have doubled.
    assert.equal(pool.ocrPoolStats().workers, 1);
    assert.equal(pool.ocrPoolStats().inFlight, 0);
  });
});

test("warming twice concurrently builds one pool, not two", async () => {
  await withPool({ size: 1 }, async (pool) => {
    await pool.terminateOcrPool();
    const [a, b] = await Promise.all([pool.warmOcrPool(), pool.warmOcrPool()]);
    assert.deepEqual(a, b);
    assert.equal(pool.ocrPoolStats().workers, 1);
  });
});

test("work beyond the queue bound is refused with a typed 503, not queued forever", async () => {
  await withPool({ size: 1, maxQueue: 1 }, async (pool) => {
    // Submitted without awaiting, so all three reach admission control before
    // the first finishes: one runs, one waits, one is over the bound.
    const results = await Promise.allSettled([
      pool.recognize(SMALL_IMAGE),
      pool.recognize(SMALL_IMAGE),
      pool.recognize(SMALL_IMAGE),
    ]);

    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 1, "exactly one job should be over the bound");
    assert.equal(rejected[0].reason.code, "OCR_BUSY");
    assert.equal(rejected[0].reason.statusCode, 503);

    // The two admitted jobs completed, and both slots came back.
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
    assert.equal(pool.ocrPoolStats().inFlight, 0);
    assert.equal(pool.ocrPoolStats().queued, 0);
  });
});

test("a queued job records the time it spent waiting", async () => {
  await withPool({ size: 1, maxQueue: 4 }, async (pool) => {
    const [first, second] = await Promise.all([
      pool.recognize(SMALL_IMAGE),
      pool.recognize(SMALL_IMAGE),
    ]);
    assert.equal(first.waitMs, 0);
    assert.ok(second.waitMs > 0, `queued job should report a wait, got ${second.waitMs}`);
  });
});

test("a failed job releases its slot instead of leaking it", async () => {
  await withPool({ size: 1, maxQueue: 1 }, async (pool) => {
    await assert.rejects(() => pool.recognize(Buffer.from("this is not an image")));
    assert.equal(pool.ocrPoolStats().inFlight, 0);
    // The pool is still usable, which is the point of releasing the slot.
    const result = await pool.recognize(SMALL_IMAGE);
    assert.equal(typeof result.data.text, "string");
  });
});

test("terminate is safe on a pool that was never built, and on one already terminated", async () => {
  const pool = await import("../services/ocrPool.js");
  await pool.terminateOcrPool();
  assert.deepEqual(pool.ocrPoolStats(), { started: false });
  await pool.terminateOcrPool();
  assert.deepEqual(pool.ocrPoolStats(), { started: false });
});
