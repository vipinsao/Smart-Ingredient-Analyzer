// scripts/bench-telemetry.js - What the OpenTelemetry instrumentation costs.
//
//   node scripts/bench-telemetry.js [requests]
//
// Instrumentation that slows the thing it measures is a bad trade, and "it is
// probably negligible" is not a measurement. This boots the real server three
// times against the local stub model endpoint and compares:
//
//   off        OTEL_TRACES_EXPORTER=none OTEL_METRICS_EXPORTER=none
//              Spans and metrics still go through the @opentelemetry/api
//              facade, which is a no-op without a provider. This is the floor.
//   console    the shipped default: batched span export to stdout
//   otlp-ish   console again, but with the metric export interval turned down,
//              so periodic export lands inside the measurement window
//
// It measures the IMAGE-CACHE-HIT path deliberately. A full analysis is ~2.7s
// of which ~78% is Tesseract, and the noise on that path (measured: p50 2.0s to
// 3.4s across eight identical warm requests) is a thousand times any plausible
// instrumentation cost - so measuring there would prove nothing either way.
// A cache hit is ~1.5ms of server time inside a ~7ms round trip (the rest is a
// 300KB base64 body over loopback), and it still runs the whole HTTP layer, the
// request span, the validate span and two metric records - so the overhead is a
// large fraction of it and is actually resolvable.
//
// Every number printed is wall clock measured by the client on this machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createStubServer } from "./stub-llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const requests = Number(process.argv[2] || 300);
const imagePath = path.join(here, "..", "..", "front-end", "public", "ingredient.jpeg");
const image = fs.readFileSync(imagePath);

const body = JSON.stringify({
  image: `data:image/jpeg;base64,${image.toString("base64")}`,
  fastMode: true,
  isMobile: false,
});

const CONFIGURATIONS = [
  { label: "off", env: { OTEL_TRACES_EXPORTER: "none", OTEL_METRICS_EXPORTER: "none" } },
  { label: "console (default)", env: {} },
  { label: "console, 1s metrics", env: { OTEL_METRIC_EXPORT_INTERVAL: "1000" } },
];

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

async function post(port) {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const payload = await response.json();
  const elapsed = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return { elapsed, cacheHit: payload.cacheHit, serverMs: payload.processingTime };
}

function percentile(sorted, quantile) {
  return sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];
}

const stub = createStubServer();
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = stub.address().port;

console.log(`node ${process.version} on ${os.cpus()[0]?.model ?? "unknown cpu"}, ${os.availableParallelism()} cores`);
console.log(`${requests} image-cache-hit requests per configuration\n`);

const results = [];

for (const configuration of CONFIGURATIONS) {
  const port = 5600 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, [path.join(here, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "development",
      LOG_LEVEL: "error",
      GROQ_API_KEY: "stub-key-not-used",
      GROQ_BASE_URL: `http://127.0.0.1:${stubPort}/v1/chat/completions`,
      GEMINI_API_KEY: "",
      // The per-IP budget would refuse this benchmark long before it finished.
      RATE_LIMIT_MAX: "1000000",
      ANALYZE_RATE_LIMIT_MAX: "1000000",
      ...configuration.env,
    },
    // Span output to stdout is part of what the default configuration costs, so
    // it is produced and discarded rather than suppressed.
    stdio: ["ignore", "ignore", "inherit"],
  });

  try {
    await waitForHealth(port);

    // First request does the OCR and fills both caches. Second confirms the
    // cache is hot. Neither is measured.
    const cold = await post(port);
    const warm = await post(port);
    if (warm.cacheHit !== "image") {
      throw new Error(`expected an image cache hit, got ${warm.cacheHit ?? "a miss"}`);
    }

    const samples = [];
    for (let i = 0; i < requests; i += 1) samples.push((await post(port)).elapsed);
    samples.sort((a, b) => a - b);

    results.push({
      label: configuration.label,
      coldMs: cold.elapsed,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      mean: samples.reduce((total, value) => total + value, 0) / samples.length,
    });
  } finally {
    child.kill("SIGKILL");
  }
}

stub.close();

const width = Math.max(...results.map((row) => row.label.length), 13);
console.log(`${"configuration".padEnd(width)} |  p50 ms |  p95 ms | mean ms | first (OCR) ms`);
console.log(`${"-".repeat(width)}-+---------+---------+---------+---------------`);
for (const row of results) {
  console.log(
    `${row.label.padEnd(width)} | ${row.p50.toFixed(3).padStart(7)} | ${row.p95.toFixed(3).padStart(7)} | ` +
      `${row.mean.toFixed(3).padStart(7)} | ${row.coldMs.toFixed(0).padStart(14)}`
  );
}

const [off, ...instrumented] = results;
console.log("\nagainst the uninstrumented floor:");
for (const row of instrumented) {
  console.log(
    `  ${row.label.padEnd(width)}  p50 ${(row.p50 - off.p50 >= 0 ? "+" : "")}${(row.p50 - off.p50).toFixed(3)}ms  ` +
      `mean ${(row.mean - off.mean >= 0 ? "+" : "")}${(row.mean - off.mean).toFixed(3)}ms`
  );
}
console.log(
  "\nRead these against the path they sit on: a real analysis is ~2.7s, ~78% of\n" +
    "it Tesseract, and varies by more than a second between identical warm\n" +
    "requests on this machine. Any difference above is far inside that noise."
);
