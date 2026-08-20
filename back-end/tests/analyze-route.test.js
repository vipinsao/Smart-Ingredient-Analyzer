// tests/analyze-route.test.js - The route, end to end, as the process actually
// runs it.
//
// Every other test in this suite imports a function. None of them would have
// caught what this one exists for: `logger.info("analyze complete", { aiMs:
// groqResult.aiTime })` referenced a variable that a rename had removed, so
// every successful analysis threw a ReferenceError after the work was done and
// after the result had been written to the cache. The route returned 500 for
// the request that did the work and 200 for the one after it. Unit tests cannot
// see that; a real request can.
//
// It also pins the two behaviours the performance work depends on:
//   - a cache hit must short-circuit before OCR, not after
//   - SIGTERM must terminate the Tesseract child processes and exit
//
// The model call goes to a local stub (scripts/stub-llm.js), so this needs no
// API key and no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createStubServer } from "../scripts/stub-llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const imagePath = path.join(here, "..", "..", "front-end", "public", "ingredient.jpeg");
const image = fs.readFileSync(imagePath);

function body(tag = "") {
  // Bytes after a JPEG's EOI are ignored by decoders: same pixels, different
  // sha256, which is how a test asks for a genuine cache miss.
  const buffer = tag ? Buffer.concat([image, Buffer.from(` ${tag}`)]) : image;
  return JSON.stringify({
    image: `data:image/jpeg;base64,${buffer.toString("base64")}`,
    fastMode: true,
    isMobile: false,
  });
}

async function waitForHealth(port, deadlineMs = 60000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch {
      // Not listening yet.
    }
    if (Date.now() - started > deadlineMs) throw new Error("server never became healthy");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function withServer(run, { apiKey = "stub-key-not-used", stubOptions = {}, env = {} } = {}) {
  const stub = createStubServer(stubOptions);
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubPort = stub.address().port;
  const port = 5900 + Math.floor(Math.random() * 90);

  const child = spawn(process.execPath, [path.join(here, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "development",
      LOG_LEVEL: "error",
      GROQ_API_KEY: apiKey,
      GROQ_BASE_URL: `http://127.0.0.1:${stubPort}/v1/chat/completions`,
      GEMINI_API_KEY: "",
      ...env,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });

  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

  try {
    await run({ port, child, exited });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    stub.close();
  }
}

async function analyze(port, tag) {
  const response = await fetch(`http://127.0.0.1:${port}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body(tag),
  });
  return { status: response.status, payload: await response.json() };
}

test("a successful analysis returns 200, not a 500 from the logging that follows it", { timeout: 180000 }, async () => {
  await withServer(async ({ port }) => {
    await waitForHealth(port);

    const { status, payload } = await analyze(port, "first");

    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(payload)}`);
    assert.equal(payload.cached, false);
    assert.ok(payload.ingredientsText.length > 0, "OCR produced no ingredient text");
    assert.ok(Array.isArray(payload.analysis));
    // The stage breakdown the performance work is measured with.
    assert.ok(payload.timings.ocr > 0, "the first request must have run OCR");
    assert.equal(typeof payload.timings.totalMs, "number");
  });
});

test("a repeat of the same image is served from cache without running OCR", { timeout: 180000 }, async () => {
  await withServer(async ({ port }) => {
    await waitForHealth(port);

    const first = await analyze(port, "cache-probe");
    assert.equal(first.status, 200);
    assert.ok(first.payload.timings.ocr > 0);

    const second = await analyze(port, "cache-probe");

    assert.equal(second.status, 200);
    assert.equal(second.payload.cached, true);
    assert.equal(second.payload.cacheHit, "image");
    // The assertion that matters: not "it was faster" - timing assertions are
    // flaky - but that the OCR stage never ran at all. The cache is checked
    // before OCR, so no OCR stage is recorded.
    assert.equal(second.payload.timings.ocr, undefined, "a cache hit must not reach OCR");
    assert.equal(second.payload.timings.ocrRecognise, undefined);
    // The cached body must not report the timings of the request that filled it.
    assert.notEqual(second.payload.processingTime, first.payload.processingTime);
    // Same answer, though.
    assert.equal(second.payload.ingredientsText, first.payload.ingredientsText);
  });
});

test("without a Groq key the server still boots, still reads the label, and fails only generation", { timeout: 180000 }, async () => {
  await withServer(async ({ port }) => {
    const health = await waitForHealth(port);
    // Boots, rather than exiting the process the way it used to. Everything up
    // to generation needs no key, and someone evaluating this repo should not
    // have to open a Groq account to watch OCR and retrieval work.
    assert.equal(health.status, "OK");
    assert.match(health.generation, /disabled/);

    const { status, payload } = await analyze(port, "no-key");

    assert.equal(status, 503);
    assert.equal(payload.code, "GENERATION_NOT_CONFIGURED");
    // The failure names what is missing rather than being a generic 500.
    assert.match(payload.error, /GROQ_API_KEY/);
  }, { apiKey: "" });
});

test("/health answers before warm-up has finished, and reports what is ready", { timeout: 180000 }, async () => {
  await withServer(async ({ port }) => {
    const health = await waitForHealth(port);

    assert.equal(health.status, "OK");
    // Provenance without loading the corpus: meta.json is read, the 1.3MB
    // corpus and the BM25 index are not necessarily in memory yet.
    assert.equal(typeof health.corpus.chunks, "number");
    assert.equal(typeof health.corpus.loaded, "boolean");
    assert.ok(health.warmup, "health should report warm-up state");
  });
});

test("SIGTERM shuts the process down instead of leaving Tesseract workers behind", { timeout: 180000 }, async () => {
  await withServer(async ({ port, child, exited }) => {
    await waitForHealth(port);
    // Force the pool to exist, so shutdown has something to tear down.
    await analyze(port, "shutdown-probe");

    child.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve({ code: "timeout" }), 15000)),
    ]);

    assert.equal(result.code, 0, `expected a clean exit, got ${JSON.stringify(result)}`);
  });
});

// ---------------------------------------------------------------------------
// A degraded answer must not outlive the failure that produced it.
//
// The result written to the cache carries `grounded: false` and a
// `degradedReason`, and it used to be stored under the same 48-hour TTL as a
// fully sourced answer, with no invalidation path. One uncitable reply from the
// provider therefore pinned an unsourced answer to that photo - and to every
// photo yielding the same ingredient text - for two days after the provider
// recovered. Only a restart cleared it.
// ---------------------------------------------------------------------------

test("a degraded result is cached for a moment, not for two days", { timeout: 180000 }, async () => {
  await withServer(
    async ({ port }) => {
      await waitForHealth(port);

      const first = await analyze(port, "degraded");
      assert.equal(first.status, 200);
      assert.equal(first.payload.grounded, false, "the citationless stub must drive the degraded path");
      assert.ok(first.payload.degradedReason, "a degraded answer says so in the payload");
      assert.equal(first.payload.cached, false);

      // Cached briefly: an outage must not re-run OCR for every retry.
      const second = await analyze(port, "degraded");
      assert.equal(second.payload.cached, true);

      // And then gone. DEGRADED_CACHE_TTL is one second for this server, so
      // this is the entry expiring rather than a timing guess.
      await new Promise((resolve) => setTimeout(resolve, 1400));

      const third = await analyze(port, "degraded");
      assert.equal(third.payload.cached, false, "a degraded answer must not outlive its TTL");
      assert.ok(third.payload.timings.ocr > 0, "and the re-analysis is a real one");
    },
    { stubOptions: { citations: false }, env: { DEGRADED_CACHE_TTL: "1" } }
  );
});

test("a sourced result keeps the full cache lifetime", { timeout: 180000 }, async () => {
  // The control for the test above: the short TTL applies to degraded results
  // only, so this must still be a hit well after one second.
  await withServer(
    async ({ port }) => {
      await waitForHealth(port);

      const first = await analyze(port, "sourced-ttl");
      assert.equal(first.payload.grounded, true);

      await new Promise((resolve) => setTimeout(resolve, 1400));

      const second = await analyze(port, "sourced-ttl");
      assert.equal(second.payload.cached, true, "a sourced answer is not on the degraded TTL");
    },
    { env: { DEGRADED_CACHE_TTL: "1" } }
  );
});
