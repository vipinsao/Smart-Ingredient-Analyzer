// scripts/loadtest.js - How many people can use this at once.
//
// Drives N concurrent analyses against a real server (model call stubbed, see
// scripts/stub-llm.js) at a series of concurrency levels, and reports
// throughput, p50, p95 and what failed. Every request carries a distinct image
// so nothing is answered from cache; the point is to load the pipeline, not the
// hash map in front of it.
//
//   node scripts/loadtest.js [requestsPerLevel] [levels...]
//   node scripts/loadtest.js 8 1 2 3 4
//   taskset -c 0 node scripts/loadtest.js 6 1 2 3    # one-core container
//
// Expect it to get worse, not better, past the pool size: OCR is CPU-bound, so
// concurrency beyond the number of workers does not add throughput, it adds
// queueing. The number that matters is where the queue bound starts refusing
// work, because a 503 that says "busy" is a better answer than a request that
// is accepted and then times out in the browser.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createStubServer } from "./stub-llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const perLevel = Number(process.argv[2] || 6);
const levels = process.argv.slice(3).map(Number).filter((value) => value > 0);
const concurrencyLevels = levels.length > 0 ? levels : [1, 2, 3, 4];
const imagePath = path.join(here, "..", "..", "front-end", "public", "ingredient.jpeg");

const image = fs.readFileSync(imagePath);

function requestBody(tag) {
  // Trailing bytes after a JPEG's EOI marker are ignored by decoders, so this
  // is the same photo with a different cache key: identical work, no cache hit.
  const buffer = Buffer.concat([image, Buffer.from(` load-${tag}`)]);
  return JSON.stringify({
    image: `data:image/jpeg;base64,${buffer.toString("base64")}`,
    fastMode: true,
    isMobile: false,
  });
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function waitForHealth(port, deadlineMs = 180000) {
  const started = performance.now();
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (performance.now() - started > deadlineMs) throw new Error("server never became healthy");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const stub = createStubServer();
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = stub.address().port;

const port = 5500 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, [path.join(here, "..", "server.js")], {
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: "development",
    LOG_LEVEL: "warn",
    GROQ_API_KEY: "stub-key-not-used",
    GROQ_BASE_URL: `http://127.0.0.1:${stubPort}/v1/chat/completions`,
    GEMINI_API_KEY: "",
    // The per-IP analyze budget is 20 per 15 minutes. A load test comes from one
    // address, so without this it measures express-rate-limit.
    ANALYZE_RATE_LIMIT_MAX: "100000",
    RATE_LIMIT_MAX: "100000",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

let counter = 0;

async function fire() {
  counter += 1;
  const started = performance.now();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody(counter),
    });
    const payload = await response.json();
    return {
      ms: Math.round(performance.now() - started),
      ok: response.ok,
      status: response.status,
      code: payload.code,
      waitMs: payload.timings?.ocrWait,
    };
  } catch (error) {
    return { ms: Math.round(performance.now() - started), ok: false, status: 0, code: error.message };
  }
}

try {
  await waitForHealth(port);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  console.log(`node:     ${process.version}, ${os.availableParallelism()} core(s) visible to this process`);
  console.log(`requests: ${perLevel} per level, concurrency ${concurrencyLevels.join(", ")}`);

  // One request first, so warm-up is not attributed to the first level.
  await fire();
  const warmed = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  console.log(`ocr pool: ${JSON.stringify(warmed.warmup?.ocrPool ?? health.warmup?.ocrPool)}\n`);

  console.log(
    `${"conc".padStart(4)} | ${"ok".padStart(3)} | ${"fail".padStart(4)} | ${"p50".padStart(7)} | ${"p95".padStart(7)} | ${"max".padStart(7)} | ${"req/s".padStart(6)} | failures`
  );
  console.log(`-----+-----+------+---------+---------+---------+--------+---------`);

  for (const concurrency of concurrencyLevels) {
    const results = [];
    const wallStarted = performance.now();

    // Fixed-size worker set pulling from a shared budget: `concurrency`
    // requests are in flight at all times until `perLevel` have been sent.
    let remaining = perLevel;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          if (remaining <= 0) return;
          remaining -= 1;
          results.push(await fire());
        }
      })
    );

    const wallMs = performance.now() - wallStarted;
    const okTimes = results.filter((result) => result.ok).map((result) => result.ms);
    const failures = results.filter((result) => !result.ok);
    const byCode = {};
    for (const failure of failures) byCode[failure.code ?? failure.status] = (byCode[failure.code ?? failure.status] ?? 0) + 1;

    console.log(
      `${String(concurrency).padStart(4)} | ${String(okTimes.length).padStart(3)} | ${String(failures.length).padStart(4)} | ` +
        `${String(percentile(okTimes, 0.5) ?? "-").padStart(7)} | ${String(percentile(okTimes, 0.95) ?? "-").padStart(7)} | ` +
        `${String(okTimes.length ? Math.max(...okTimes) : "-").padStart(7)} | ` +
        `${(results.length / (wallMs / 1000)).toFixed(2).padStart(6)} | ` +
        `${Object.keys(byCode).length ? JSON.stringify(byCode) : "none"}`
    );
  }
} finally {
  server.kill("SIGTERM");
  stub.close();
}
