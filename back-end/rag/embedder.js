// rag/embedder.js - Local sentence embeddings.
//
// Xenova/all-MiniLM-L6-v2 runs in-process through ONNX Runtime. No API key, no
// per-call cost, no third party sees the query. The model weights (~87MB) are
// downloaded once on first use and cached on disk.
//
// The pipeline is loaded lazily and shared, because construction costs ~14s on
// a cold cache and the model is ~90MB in memory; building one per call would
// be untenable.
import { pipeline, env } from "@huggingface/transformers";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;

const here = path.dirname(fileURLToPath(import.meta.url));
env.cacheDir = process.env.TRANSFORMERS_CACHE || path.join(here, "..", ".models");

let extractorPromise = null;

export function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", EMBEDDING_MODEL);
  }
  return extractorPromise;
}

/**
 * @param {string[]} texts
 * @returns {Promise<Float32Array[]>} mean-pooled, L2-normalised vectors, so
 *          cosine similarity is a plain dot product.
 */
export async function embed(texts) {
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const [rows, dimensions] = output.dims;

  const vectors = [];
  for (let row = 0; row < rows; row += 1) {
    vectors.push(Float32Array.from(output.data.slice(row * dimensions, (row + 1) * dimensions)));
  }
  return vectors;
}

export async function embedOne(text) {
  const [vector] = await embed([text]);
  return vector;
}

/** Token count as the embedding model itself counts it, used by the chunker. */
export async function countTokens(text) {
  const extractor = await getExtractor();
  const encoded = await extractor.tokenizer(text);
  return encoded.input_ids.dims[1];
}

export default { embed, embedOne, countTokens, getExtractor, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
