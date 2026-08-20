// scripts/bench-ocr-worker.js - How much of an OCR request is starting Tesseract?
//
// `Tesseract.recognize()` is a convenience wrapper: it creates a worker, runs
// one image through it, and terminates it. That worker is a child process that
// loads a ~15MB WASM core and a 5.2MB language pack before it reads a single
// glyph, and the whole cost is paid again on the next request. This script
// separates the two halves so the split is a measurement rather than a claim,
// and then measures a pooled worker doing the same work with the startup
// already paid.
//
//   node scripts/bench-ocr-worker.js [iterations] [imagePath]
//   taskset -c 0 node scripts/bench-ocr-worker.js 3      # one-core container
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Tesseract from "tesseract.js";
import { preprocessForOcr } from "../services/imagePreprocessor.js";
import { TESSERACT_PARAMETERS } from "../services/ocrPool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const iterations = Number(process.argv[2] || 3);
const imagePath =
  process.argv[3] || path.join(here, "..", "..", "front-end", "public", "ingredient.jpeg");

const image = await preprocessForOcr(fs.readFileSync(imagePath));
console.log(`subject:  ${imagePath}, preprocessed to ${(image.length / 1024).toFixed(1)}KB`);
console.log(`node:     ${process.version}, ${os.availableParallelism()} core(s) visible\n`);

function stats(label, values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  console.log(
    `${label.padEnd(34)} n=${values.length}  min ${String(sorted[0]).padStart(6)}ms  ` +
      `median ${String(sorted[Math.floor(sorted.length / 2)]).padStart(6)}ms  ` +
      `max ${String(sorted[sorted.length - 1]).padStart(6)}ms  mean ${mean}ms`
  );
  return mean;
}

// ---- one worker per image, created and terminated each time ---------------
const createMs = [];
const recogniseMs = [];
const terminateMs = [];

for (let i = 0; i < iterations; i += 1) {
  let started = performance.now();
  const worker = await Tesseract.createWorker("eng", undefined, { logger: () => {} });
  await worker.setParameters(TESSERACT_PARAMETERS);
  createMs.push(Math.round(performance.now() - started));

  started = performance.now();
  await worker.recognize(image);
  recogniseMs.push(Math.round(performance.now() - started));

  started = performance.now();
  await worker.terminate();
  terminateMs.push(Math.round(performance.now() - started));
}

const createMean = stats("createWorker + setParameters", createMs);
const recogniseMean = stats("worker.recognize", recogniseMs);
stats("worker.terminate", terminateMs);
console.log(
  `\nstartup is ${Math.round((createMean / (createMean + recogniseMean)) * 100)}% of a ` +
    `create-per-request OCR call on this machine.\n`
);

// ---- one worker, reused ----------------------------------------------------
const pooledStart = performance.now();
const pooled = await Tesseract.createWorker("eng", undefined, { logger: () => {} });
await pooled.setParameters(TESSERACT_PARAMETERS);
console.log(`pooled worker warmed in ${Math.round(performance.now() - pooledStart)}ms (paid once, at boot)`);

const reuseMs = [];
for (let i = 0; i < iterations; i += 1) {
  const started = performance.now();
  await pooled.recognize(image);
  reuseMs.push(Math.round(performance.now() - started));
}
stats("reused worker.recognize", reuseMs);
await pooled.terminate();
