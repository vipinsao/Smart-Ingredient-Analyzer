// scripts/bench-preprocess.js - What each pre-processing setting costs, and buys.
//
// Two thirds of an OCR request is Tesseract recognising pixels, and the
// pre-processing step decides how many pixels there are and what they look
// like. Every setting in OCR_PREPROCESS is therefore a latency decision, and
// none of them had a latency measurement attached.
//
// This sweeps them and prints, per configuration: how long sharp took, how long
// recognition took, Tesseract's own confidence, and how much of the extracted
// ingredient text survived. The last column is what decides whether a saving is
// allowed to be taken - a faster OCR that drops the "I" off "INS211" has broken
// lexical retrieval, which is the one thing the corpus is good at.
//
// Three subjects, because a conclusion drawn from one photo is a conclusion
// about one photo: the repo's sample, a softened copy (what a downscale or a
// slightly out-of-focus phone shot produces, which is the case `sharpen` exists
// for) and a low-contrast copy (the case `normalise` exists for).
//
//   node scripts/bench-preprocess.js [imagePath] [reps]
//   taskset -c 0 node scripts/bench-preprocess.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { preprocessForOcr } from "../services/imagePreprocessor.js";
import { recognize, terminateOcrPool, warmOcrPool } from "../services/ocrPool.js";
import AnalysisHelpers from "../utils/helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const imagePath =
  process.argv[2] || path.join(here, "..", "..", "front-end", "public", "ingredient.jpeg");
const reps = Number(process.argv[3] || 3);

const CONFIGURATIONS = [
  ["baseline (shipped settings)", {}],
  ["no sharpen", { sharpen: false }],
  ["no normalise", { normalise: false }],
  ["png compressionLevel 0", { compressionLevel: 0 }],
  ["maxWidth 1200", { maxWidth: 1200 }],
  ["maxWidth 1000", { maxWidth: 1000 }],
];

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

/** Longest-common-subsequence ratio; 1.0 means the two texts are identical. */
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const left = a.slice(0, 4000);
  const right = b.slice(0, 4000);
  let previous = new Uint16Array(right.length + 1);
  let current = new Uint16Array(right.length + 1);

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return previous[right.length] / Math.max(left.length, right.length);
}

const original = fs.readFileSync(imagePath);
const metadata = await sharp(original).metadata();

const subjects = [
  ["sample", original],
  ["softened", await sharp(original).blur(1.2).jpeg({ quality: 90 }).toBuffer()],
  ["low contrast", await sharp(original).linear(0.4, 90).jpeg({ quality: 90 }).toBuffer()],
];

console.log(`subject:  ${imagePath} (${metadata.width}x${metadata.height}, ${(original.length / 1024).toFixed(1)}KB)`);
console.log(`node:     ${process.version}, ${os.availableParallelism()} core(s) visible, ${reps} reps per cell\n`);

await warmOcrPool();

for (const [subjectName, buffer] of subjects) {
  const rows = [];
  let reference = null;

  for (const [label, options] of CONFIGURATIONS) {
    const sharpSamples = [];
    const ocrSamples = [];
    let image = null;
    let data = null;

    // Rep 0 is a discarded warm-up, so first-call setup is not charged to
    // whichever configuration happens to run first.
    for (let rep = 0; rep <= reps; rep += 1) {
      let started = performance.now();
      image = await preprocessForOcr(buffer, options);
      const sharpMs = Math.round(performance.now() - started);

      started = performance.now();
      ({ data } = await recognize(image));
      const ocrMs = Math.round(performance.now() - started);

      if (rep > 0) {
        sharpSamples.push(sharpMs);
        ocrSamples.push(ocrMs);
      }
    }

    const text = AnalysisHelpers.extractIngredients(data.text);
    if (reference === null) reference = text;

    rows.push({
      label,
      bytes: `${(image.length / 1024).toFixed(0)}KB`,
      sharpMs: median(sharpSamples),
      ocrMs: median(ocrSamples),
      confidence: Math.round(data.confidence),
      chars: text.length,
      similarity: similarity(reference, text).toFixed(3),
      text,
    });
  }

  console.log(`--- subject: ${subjectName} (median of ${reps}, ms) ---`);
  console.log(
    `${"configuration".padEnd(28)} | ${"bytes".padStart(7)} | ${"sharp".padStart(6)} | ${"ocr".padStart(6)} | ${"total".padStart(6)} | ${"conf".padStart(4)} | ${"chars".padStart(5)} | vs baseline`
  );
  console.log(`${"-".repeat(28)}-+---------+--------+--------+--------+------+-------+------------`);
  for (const row of rows) {
    console.log(
      `${row.label.padEnd(28)} | ${row.bytes.padStart(7)} | ${String(row.sharpMs).padStart(6)} | ` +
        `${String(row.ocrMs).padStart(6)} | ${String(row.sharpMs + row.ocrMs).padStart(6)} | ` +
        `${String(row.confidence).padStart(4)} | ${String(row.chars).padStart(5)} | ${row.similarity}`
    );
  }

  console.log("\n  extracted ingredient text:");
  for (const row of rows) {
    console.log(`    [${row.label}] ${row.text.slice(0, 260) || "(nothing extracted)"}`);
  }
  console.log("");
}

await terminateOcrPool();
