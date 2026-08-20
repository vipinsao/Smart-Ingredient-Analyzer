// scripts/profile-analyze.js - Where the seconds actually go.
//
// Boots the real server against a local stub model endpoint (scripts/stub-llm.js)
// and prints the per-stage breakdown the route reports in `timings`.
//
//   node scripts/profile-analyze.js [boots] [warmRequests] [imagePath]
//
// Three phases, because they answer three different questions:
//
//   A  cold: a fresh process per sample, one request each. This is what the
//      first visitor to a spun-down free-tier instance pays, and the only
//      phase where retrieval and the model call are measured, because a warm
//      process serves the second identical label out of the text cache.
//   B  warm: many requests against one process. Each posts the same photo with
//      a few trailing bytes appended - JPEG decoders ignore bytes after EOI, so
//      the pixels and therefore the OCR work are identical, but the sha256
//      image-cache key is not, which is what forces the OCR path to run again.
//      These requests then hit the text cache, so they measure OCR, not the
//      model.
//   C  cache: the same bytes posted twice, checking the second never reaches OCR.
//
// Every number printed is measured on the machine that runs it, with the model
// call stubbed. Add the provider round trip for a user-facing total.
//
// Pin to one core to approximate a free-tier container:
//   taskset -c 0 node scripts/profile-analyze.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createStubServer } from "./stub-llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const boots = Number(process.argv[2] || 3);
const warmRequests = Number(process.argv[3] || 5);
const imagePath =
  process.argv[4] || path.join(here, "..", "..", "front-end", "public", "ingredient.jpeg");

const STAGES = [
  ["decode", "decode + validate bytes"],
  ["cacheLookup", "cache lookup"],
  ["ocrPreprocess", "  ocr: sharp preprocess"],
  ["ocrWait", "  ocr: queued behind other work"],
  ["ocrRecognise", "  ocr: tesseract recognise"],
  ["ocr", "OCR total"],
  ["extract", "extract ingredient text"],
  ["retrieval", "  analyse: retrieval (embed + BM25)"],
  ["model", "  analyse: model call (STUBBED)"],
  ["analyse", "analyse total"],
  ["score", "score + serialise"],
  ["totalMs", "TOTAL (server-side)"],
];

const image = fs.readFileSync(imagePath);

/** Same pixels, different bytes: defeats the image cache without changing the OCR work. */
function variant(tag) {
  return Buffer.concat([image, Buffer.from(` profile-${tag}`)]);
}

function requestBody(buffer) {
  return JSON.stringify({
    image: `data:image/jpeg;base64,${buffer.toString("base64")}`,
    fastMode: true,
    isMobile: false,
  });
}

async function waitForHealth(port, deadlineMs = 180000) {
  const started = performance.now();
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return performance.now() - started;
    } catch {
      // Not listening yet.
    }
    if (performance.now() - started > deadlineMs) throw new Error("server never became healthy");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function startServer(stubPort) {
  const port = 5100 + Math.floor(Math.random() * 400);
  const started = performance.now();
  const child = spawn(process.execPath, [path.join(here, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: "development",
      LOG_LEVEL: "warn",
      GROQ_API_KEY: "stub-key-not-used",
      GROQ_BASE_URL: `http://127.0.0.1:${stubPort}/v1/chat/completions`,
      GEMINI_API_KEY: "",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  return { child, port, started };
}

async function post(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function summarise(runs) {
  const rows = [];
  for (const [key, label] of STAGES) {
    const values = runs.map((run) => run[key]).filter((value) => typeof value === "number");
    if (values.length === 0) continue;
    values.sort((a, b) => a - b);
    rows.push({
      stage: label,
      min: values[0],
      median: values[Math.floor(values.length / 2)],
      max: values[values.length - 1],
    });
  }
  return rows;
}

function printTable(title, rows) {
  if (rows.length === 0) return;
  console.log(`\n${title}`);
  const width = Math.max(...rows.map((row) => row.stage.length), 5);
  console.log(`${"stage".padEnd(width)} |      min |   median |      max`);
  console.log(`${"-".repeat(width)}-+----------+----------+---------`);
  for (const row of rows) {
    console.log(
      `${row.stage.padEnd(width)} | ${String(row.min).padStart(8)} | ${String(row.median).padStart(8)} | ${String(row.max).padStart(8)}`
    );
  }
}

const stub = createStubServer();
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = stub.address().port;

console.log(`subject:  ${imagePath} (${(image.length / 1024).toFixed(1)}KB)`);
console.log(`node:     ${process.version}, ${os.availableParallelism()} core(s) visible to this process`);

const bootTimes = [];
const coldRuns = [];

try {
  // ---- phase A: cold process, cold cache ---------------------------------
  for (let i = 0; i < boots; i += 1) {
    const { child, port, started } = startServer(stubPort);
    try {
      await waitForHealth(port);
      const bootMs = Math.round(performance.now() - started);
      bootTimes.push(bootMs);
      const payload = await post(port, requestBody(variant(`cold-${i}`)));
      coldRuns.push(payload.timings);
      console.log(`  boot ${i + 1}: healthy in ${bootMs}ms, first analyze ${payload.timings.totalMs}ms`);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }

  // ---- phase B: warm process ---------------------------------------------
  const { child, port } = startServer(stubPort);
  try {
    await waitForHealth(port);
    await post(port, requestBody(variant("warmup")));

    const warmRuns = [];
    for (let i = 0; i < warmRequests; i += 1) {
      const payload = await post(port, requestBody(variant(`warm-${i}`)));
      warmRuns.push(payload.timings);
      console.log(`  warm ${i + 1}: ${payload.timings.totalMs}ms (cacheHit: ${payload.cacheHit ?? "none"})`);
    }

    // ---- phase C: identical bytes twice ----------------------------------
    const bytes = requestBody(variant("cache-probe"));
    const first = await post(port, bytes);
    const second = await post(port, bytes);

    printTable(`A. cold process, cold cache - first request after boot (n=${coldRuns.length}, ms)`, summarise(coldRuns));
    printTable(`B. warm process, cold image cache (n=${warmRuns.length}, ms)`, summarise(warmRuns));

    console.log(
      `\nboot to healthy /health: min ${Math.min(...bootTimes)}ms, max ${Math.max(...bootTimes)}ms (n=${bootTimes.length})`
    );
    console.log(
      `C. same bytes twice: 1st ${first.timings.totalMs}ms (cacheHit ${first.cacheHit ?? "none"}), ` +
        `2nd ${second.timings.totalMs}ms (cacheHit ${second.cacheHit ?? "none"}), ` +
        `2nd ran OCR: ${second.timings.ocr !== undefined}`
    );
  } finally {
    child.kill("SIGTERM");
  }
} finally {
  stub.close();
}
