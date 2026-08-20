// rag/ingest.js - Build the retrieval corpus. Idempotent and re-runnable.
//
//   node rag/ingest.js            fetch the taxonomies, rebuild everything
//   node rag/ingest.js --offline  rebuild from the cached taxonomies on disk
//
// Writes three files into rag/corpus/:
//   chunks.json      the passages, with ids, aliases and source attribution
//   embeddings.f32   chunk count x 384 float32, row-major, L2-normalised
//   meta.json        model, dimensions, counts, source urls, build date
//
// Deterministic given the same input: the same taxonomy snapshot produces the
// same chunk ids in the same order, so a rebuild is a no-op in git unless Open
// Food Facts actually changed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { additiveToPassage, additiveClassToPassage, allergenToPassage } from "./normalize.js";
import { chunkText, MAX_CHUNK_TOKENS } from "./chunker.js";
import { embed, countTokens, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "./embedder.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, "corpus");
const cacheDir = path.join(here, ".taxonomy-cache");

const SOURCES = {
  additives: "https://static.openfoodfacts.org/data/taxonomies/additives.json",
  additivesClasses: "https://static.openfoodfacts.org/data/taxonomies/additives_classes.json",
  allergens: "https://static.openfoodfacts.org/data/taxonomies/allergens.json",
};

const offline = process.argv.includes("--offline");

async function loadTaxonomy(name, url) {
  const cachePath = path.join(cacheDir, `${name}.json`);

  if (offline) {
    if (!fs.existsSync(cachePath)) {
      throw new Error(`--offline was given but ${cachePath} does not exist. Run without --offline once.`);
    }
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  }

  process.stdout.write(`fetching ${name} ... `);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = await response.text();
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cachePath, body);
  console.log(`${(body.length / 1024).toFixed(0)}KB`);
  return JSON.parse(body);
}

const [additives, additivesClasses, allergens] = await Promise.all([
  loadTaxonomy("additives", SOURCES.additives),
  loadTaxonomy("additives_classes", SOURCES.additivesClasses),
  loadTaxonomy("allergens", SOURCES.allergens),
]);

// Readable names for the class ids referenced by additive entries.
const classNames = {};
for (const [id, entry] of Object.entries(additivesClasses)) {
  const name = typeof entry.name === "string" ? entry.name : entry.name?.en;
  if (name) classNames[id] = name.toLowerCase();
}

const passages = [];
// Sorted so the output ordering does not depend on JSON key order.
for (const id of Object.keys(additives).sort()) {
  const passage = additiveToPassage(id, additives[id], { classNames });
  if (passage) passages.push(passage);
}
for (const id of Object.keys(additivesClasses).sort()) {
  const passage = additiveClassToPassage(id, additivesClasses[id]);
  if (passage) passages.push(passage);
}
for (const id of Object.keys(allergens).sort()) {
  const passage = allergenToPassage(id, allergens[id]);
  if (passage) passages.push(passage);
}

console.log(`normalised ${passages.length} passages`);

// The chunker needs a synchronous token counter; the tokenizer is async, so
// pre-measure every sentence once and serve the chunker from that table.
const tokenCache = new Map();
async function warmTokenCache(text) {
  const pieces = text.split(/(?<=[.!?])\s+/).map((piece) => piece.trim()).filter(Boolean);
  for (const piece of [...pieces, text]) {
    if (!tokenCache.has(piece)) tokenCache.set(piece, await countTokens(piece));
  }
}
function countCached(text) {
  if (tokenCache.has(text)) return tokenCache.get(text);
  // A joined candidate: the sum of its parts is an upper bound that never
  // under-counts, so the chunker cannot overshoot the model's window.
  const parts = text.split(/(?<=[.!?])\s+/).map((piece) => piece.trim()).filter(Boolean);
  const total = parts.reduce((sum, part) => sum + (tokenCache.get(part) ?? Math.ceil(part.length / 4)), 0);
  tokenCache.set(text, total);
  return total;
}

const chunks = [];
for (const passage of passages) {
  await warmTokenCache(passage.text);
  const parts = chunkText(passage.text, countCached, { maxTokens: MAX_CHUNK_TOKENS });

  parts.forEach((text, index) => {
    chunks.push({
      id: parts.length === 1 ? passage.id : `${passage.id}#${index}`,
      passageId: passage.id,
      kind: passage.kind,
      title: passage.title,
      aliases: passage.aliases,
      text,
      source: passage.source,
    });
  });
}

console.log(`chunked into ${chunks.length} chunks (max ${MAX_CHUNK_TOKENS} tokens each)`);

const BATCH = 64;
const vectors = [];
for (let start = 0; start < chunks.length; start += BATCH) {
  const batch = chunks.slice(start, start + BATCH);
  // The alias line is prepended so an exact identifier is inside the embedded
  // text as well as inside the lexical index.
  const inputs = batch.map((chunk) => `${chunk.title}. ${chunk.text}`);
  vectors.push(...(await embed(inputs)));
  process.stdout.write(`\rembedded ${Math.min(start + BATCH, chunks.length)}/${chunks.length}`);
}
console.log();

const matrix = new Float32Array(chunks.length * EMBEDDING_DIMENSIONS);
vectors.forEach((vector, index) => matrix.set(vector, index * EMBEDDING_DIMENSIONS));

fs.mkdirSync(corpusDir, { recursive: true });
fs.writeFileSync(path.join(corpusDir, "chunks.json"), `${JSON.stringify(chunks, null, 0)}\n`);
fs.writeFileSync(path.join(corpusDir, "embeddings.f32"), Buffer.from(matrix.buffer));
fs.writeFileSync(
  path.join(corpusDir, "meta.json"),
  `${JSON.stringify(
    {
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      maxChunkTokens: MAX_CHUNK_TOKENS,
      passages: passages.length,
      chunks: chunks.length,
      byKind: chunks.reduce((counts, chunk) => ({ ...counts, [chunk.kind]: (counts[chunk.kind] || 0) + 1 }), {}),
      sources: SOURCES,
      licence: "ODbL-1.0 (Open Food Facts)",
      builtAt: new Date().toISOString().slice(0, 10),
    },
    null,
    2
  )}\n`
);

console.log(
  `wrote ${chunks.length} chunks and a ${(matrix.byteLength / 1024).toFixed(0)}KB embedding matrix to rag/corpus/`
);
