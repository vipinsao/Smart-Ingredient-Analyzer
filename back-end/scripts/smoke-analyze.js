// scripts/smoke-analyze.js - End-to-end check against a running API.
//
// Posts a real food-label photo to /api/analyze and prints what comes back.
//
//   node scripts/smoke-analyze.js [imagePath] [apiUrl]
//
// Defaults to the sample label in the repo and http://localhost:5000.
//
// The previous version of this script generated a blank white JPEG, which by
// definition contains no ingredient list, so it could only ever print the
// "no ingredients found" error. It also lived at the repo root, where its
// `node-fetch` and `sharp` imports had no package.json to resolve against.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const imagePath =
  process.argv[2] || path.join(here, "..", "..", "front-end", "public", "ingredient.jpeg");
const apiUrl = (process.argv[3] || process.env.API_URL || "http://localhost:5000").replace(/\/$/, "");

if (!fs.existsSync(imagePath)) {
  console.error(`No such image: ${imagePath}`);
  process.exit(1);
}

const buffer = fs.readFileSync(imagePath);
console.log(`posting ${path.basename(imagePath)} (${(buffer.length / 1024).toFixed(1)}KB) to ${apiUrl}/api/analyze`);

const started = Date.now();
const response = await fetch(`${apiUrl}/api/analyze`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    image: `data:image/jpeg;base64,${buffer.toString("base64")}`,
    fastMode: true,
    isMobile: false,
  }),
});

const body = await response.json();
console.log(`HTTP ${response.status} in ${Date.now() - started}ms`);

if (!response.ok) {
  console.error(body);
  process.exit(1);
}

console.log(`ocr:        ${body.ocrMethod} (confidence ${body.ocrConfidence})`);
console.log(`text:       ${body.ingredientsText}`);
console.log(`score:      ${body.healthScore.score}/100`, body.healthScore.breakdown);
console.log(`allergens:  ${body.allergens.length ? body.allergens.join(", ") : "none detected"}`);
console.log(`verdicts:   ${body.analysis.length} ingredients (${body.llmAttempts} model attempt(s))`);
for (const row of body.analysis) {
  console.log(`  [${row.status.padEnd(7)}] ${row.ingredient}`);
}
