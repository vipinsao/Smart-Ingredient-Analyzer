// scripts/ocr-benchmark.js - Measure what the pre-processing step actually buys.
//
// Runs Tesseract twice on the same photo: once on the raw upload, once on the
// pre-processed image, and prints Tesseract's own confidence score, the runtime
// and the extracted text for both. No API key required - Tesseract runs locally.
//
//   node scripts/ocr-benchmark.js [path/to/label.jpg]
//
// Default subject is the sample label committed in the repo.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performTesseractOCR } from "../optimized-ocr.js";
import { preprocessForOcr, measureContrast } from "../services/imagePreprocessor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const target =
  process.argv[2] || path.join(here, "..", "..", "front-end", "public", "ingredient.jpeg");

const raw = fs.readFileSync(target);
console.log(`subject: ${target} (${(raw.length / 1024).toFixed(1)}KB)`);

const processed = await preprocessForOcr(raw);
console.log(
  `contrast (mean channel stdev): raw ${(await measureContrast(raw)).toFixed(2)} -> ` +
    `preprocessed ${(await measureContrast(processed)).toFixed(2)}`
);

for (const [label, buffer] of [
  ["raw upload  ", raw],
  ["preprocessed", processed],
]) {
  const started = Date.now();
  try {
    const result = await performTesseractOCR(buffer);
    console.log(
      `\n${label} | ${Date.now() - started}ms | tesseract confidence ${result.confidence}\n` +
        result.text.trim().split("\n").slice(0, 8).map((line) => `    ${line}`).join("\n")
    );
  } catch (error) {
    console.log(`\n${label} | failed after ${Date.now() - started}ms: ${error.message}`);
  }
}
