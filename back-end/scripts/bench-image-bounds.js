// scripts/bench-image-bounds.js - What an upload can make this process do.
//
// Tesseract's runtime tracks the number of pixels it is given, and until the
// pixel cap existed nothing in the request path bounded that number. The size
// limits are on the wire format: `express.json({ limit: "12mb" })` and an 8MB
// check on the decoded buffer. Both bound *encoded bytes*. A well-compressed
// PNG of black text on white is enormously smaller than its canvas.
//
// This builds the shapes that matter and reports, for each: bytes on the wire,
// pixels after decode, what pre-processing did to it, and what OCR cost.
//
//   node scripts/bench-image-bounds.js
//   taskset -c 0 node scripts/bench-image-bounds.js    # one-core container
//
// Machine-dependent, like every timing in this repo, and this one especially:
// run it on an idle machine and check the load average it prints.
import os from "node:os";
import sharp from "sharp";
import { OCR_PREPROCESS, IMAGE_LIMITS } from "../configuration/constants.js";
import { preprocessForOcr } from "../services/imagePreprocessor.js";
import { recognize, terminateOcrPool, warmOcrPool } from "../services/ocrPool.js";

const LINE = "INGREDIENTS: Water, Sugar, Jaggery, Tomato Paste, Tamarind (5%), Iodised Salt";

/** A text-filled canvas: compresses small, gives Tesseract real work on every row. */
async function textCanvas(width, height) {
  const rows = [];
  for (let y = 60; y < height; y += 60) {
    rows.push(`<text x="20" y="${y}" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#000">${LINE}</text>`);
  }
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="100%" height="100%" fill="#fff"/>${rows.join("")}</svg>`
  );
  // limitInputPixels is off for the *generator* only; the app's own limit is
  // what this script exists to exercise.
  return sharp(svg, { limitInputPixels: false }).png({ compressionLevel: 9 }).toBuffer();
}

const SUBJECTS = [
  ["normal label", 2000, 1500, "a full page of dense text at the width cap"],
  ["at the pixel cap", 2000, 2000, "the largest image the cap lets through untouched"],
  ["tall canvas", 2000, 20000, "width cap is a no-op on this shape"],
  ["square canvas", 16383, 16383, "sharp's own default pixel limit, exactly"],
];

console.log(`node:     ${process.version}, ${os.availableParallelism()} core(s) visible`);
console.log(`load:     ${os.loadavg().map((n) => n.toFixed(2)).join(" ")}  (1/5/15 min - measure on an idle machine)`);
// Printed defensively so the same script runs against a checkout from before
// these limits existed, which is how the before/after pair is produced.
const decodeLimit = OCR_PREPROCESS.limitInputPixels
  ? `${(OCR_PREPROCESS.limitInputPixels / 1e6).toFixed(0)}M px`
  : "sharp default (inherited)";
const ocrLimit = OCR_PREPROCESS.maxPixels
  ? `${(OCR_PREPROCESS.maxPixels / 1e6).toFixed(1)}M px`
  : "UNBOUNDED (width only)";
console.log(`limits:   wire <= ${IMAGE_LIMITS.maxSizeBytes / 1024 / 1024}MB, decode <= ${decodeLimit}, OCR <= ${ocrLimit}\n`);

await warmOcrPool();

console.log(
  `${"subject".padEnd(18)} | ${"canvas".padStart(13)} | ${"wire".padStart(7)} | ${"px in".padStart(7)} | ${"after preprocess".padStart(17)} | ${"sharp".padStart(7)} | ${"ocr".padStart(8)} | total`
);
console.log(`${"-".repeat(18)}-+---------------+---------+---------+-------------------+---------+----------+-------`);

for (const [name, width, height, note] of SUBJECTS) {
  const buffer = await textCanvas(width, height);
  const wire = `${(buffer.length / 1024 / 1024).toFixed(2)}MB`;
  const pxIn = `${((width * height) / 1e6).toFixed(1)}M`;

  let sharpMs = 0;
  try {
    let started = performance.now();
    const image = await preprocessForOcr(buffer);
    sharpMs = Math.round(performance.now() - started);
    const out = await sharp(image).metadata();

    started = performance.now();
    await recognize(image);
    const ocrMs = Math.round(performance.now() - started);

    console.log(
      `${name.padEnd(18)} | ${`${width}x${height}`.padStart(13)} | ${wire.padStart(7)} | ${pxIn.padStart(7)} | ` +
        `${`${out.width}x${out.height} (${((out.width * out.height) / 1e6).toFixed(1)}M)`.padStart(17)} | ` +
        `${String(sharpMs).padStart(7)} | ${String(ocrMs).padStart(8)} | ${sharpMs + ocrMs}ms`
    );
  } catch (error) {
    console.log(
      `${name.padEnd(18)} | ${`${width}x${height}`.padStart(13)} | ${wire.padStart(7)} | ${pxIn.padStart(7)} | ` +
        `${"REFUSED".padStart(17)} | ${String(sharpMs).padStart(7)} | ${"-".padStart(8)} | ${error.code ?? error.message}`
    );
  }
  console.log(`${" ".repeat(18)} | ${note}`);
}

// ---------------------------------------------------------------------------
// Does the pixel cap actually bound the work? Hold the pixel count at the cap
// and vary the shape. If cost tracked pixels alone these rows would be equal.
// They are not, which is why the per-job deadline is load-bearing rather than a
// redundant backstop - and why that deadline is sized from the worst row here.
// ---------------------------------------------------------------------------
const cap = OCR_PREPROCESS.maxPixels ?? 4_000_000;
const SHAPES = [
  [2000, 2000],
  [1265, 3162],
  [632, 6325],
  [400, 10000],
  [200, 20000],
];

console.log(`\nSame pixel count (${(cap / 1e6).toFixed(1)}M), different shapes:`);
console.log(`${"canvas".padStart(13)} | ${"megapixels".padStart(10)} | ${"ocr".padStart(8)} | confidence`);
console.log(`--------------+------------+----------+-----------`);

for (const [width, height] of SHAPES) {
  const buffer = await textCanvas(width, height);
  // Fed straight to OCR: pre-processing would resize these back to a common
  // shape, and the shape is the variable under test.
  const image = await sharp(buffer, { limitInputPixels: false })
    .grayscale()
    .toColourspace("b-w")
    .png()
    .toBuffer();

  const started = performance.now();
  try {
    const { data } = await recognize(image);
    console.log(
      `${`${width}x${height}`.padStart(13)} | ${((width * height) / 1e6).toFixed(1).padStart(10)} | ` +
        `${`${Math.round(performance.now() - started)}ms`.padStart(8)} | ${Math.round(data.confidence)}`
    );
  } catch (error) {
    console.log(
      `${`${width}x${height}`.padStart(13)} | ${((width * height) / 1e6).toFixed(1).padStart(10)} | ` +
        `${`${Math.round(performance.now() - started)}ms`.padStart(8)} | ${error.code}`
    );
  }
}

await terminateOcrPool();
