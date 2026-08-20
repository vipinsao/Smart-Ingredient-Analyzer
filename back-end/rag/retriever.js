// rag/retriever.js - Hybrid retrieval over the Open Food Facts corpus.
//
// Two retrievers, fused by Reciprocal Rank Fusion:
//   dense    cosine similarity over MiniLM embeddings - wins on paraphrase
//            ("what stops bread going mouldy" -> the preservative passage)
//   lexical  BM25 - wins on exact identifiers ("E211", "INS211"), which are
//            precisely the strings that appear on a real food label
//
// No vector database. At 839 chunks x 384 dimensions a brute-force scan is
// ~322k multiply-adds per query, which measures under a millisecond; a vector
// index would add an operational dependency and a network hop to save nothing.
// The scan is linear, so this stops being the right answer somewhere in the
// low hundreds of thousands of chunks.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bm25Index, reciprocalRankFusion } from "./bm25.js";
import { embedOne, EMBEDDING_DIMENSIONS } from "./embedder.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, "corpus");

/**
 * Below this cosine similarity, the corpus is treated as having nothing to say
 * and the caller abstains rather than guessing.
 *
 * The value is not a guess: rag/eval/run-eval.js prints the cosine
 * distribution for in-corpus and out-of-corpus questions, and this sits in the
 * separating band. Re-run the eval after any corpus change and re-check it.
 */
export const ABSTAIN_MIN_COSINE = 0.42;

/**
 * How much the dense ranking counts against the lexical one during fusion.
 *
 * Not 1.0. Weighting both retrievers equally measurably hurt this corpus:
 * recall@1 83% (lexical alone) -> 70% (equal-weight RRF). The sweep printed by
 * `npm run eval` is flat between 0.2 and 0.7, so this sits in the middle of
 * that region rather than on its argmax, which differs by a single question out
 * of forty and is not a result.
 */
export const DENSE_FUSION_WEIGHT = 0.5;

/**
 * The lexical half of the same decision. BM25 scores are not comparable across
 * queries in absolute terms, but a top score of zero means no query term
 * occurs in any passage, and a low score means only common terms matched.
 *
 * Both signals must be weak before the system abstains. Abstaining on the
 * dense score alone was wrong in a way the eval set makes obvious: "INS 211"
 * has a cosine of 0.23 because the embedding model sees every additive code as
 * the same shape of string, while BM25 puts the correct passage first.
 */
export const ABSTAIN_MIN_LEXICAL = 8.5;

export class Retriever {
  constructor({ chunks, embeddings, meta }) {
    this.chunks = chunks;
    this.embeddings = embeddings;
    this.meta = meta;
    this.bm25 = new Bm25Index(
      chunks.map((chunk) => ({
        id: chunk.id,
        // Aliases are indexed with the body so "E211" and "sodium benzoate"
        // both hit the same passage.
        text: `${chunk.title} ${chunk.aliases.join(" ")} ${chunk.text}`,
      }))
    );
    this.indexById = new Map(chunks.map((chunk, index) => [chunk.id, index]));
  }

  static load(directory = corpusDir) {
    const chunks = JSON.parse(fs.readFileSync(path.join(directory, "chunks.json"), "utf8"));
    const buffer = fs.readFileSync(path.join(directory, "embeddings.f32"));
    const meta = JSON.parse(fs.readFileSync(path.join(directory, "meta.json"), "utf8"));

    const embeddings = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength / Float32Array.BYTES_PER_ELEMENT
    );

    const expected = chunks.length * EMBEDDING_DIMENSIONS;
    if (embeddings.length !== expected) {
      throw new Error(
        `corpus is inconsistent: ${chunks.length} chunks imply ${expected} floats, found ${embeddings.length}. Re-run rag/ingest.js.`
      );
    }

    return new Retriever({ chunks, embeddings, meta });
  }

  /** Cosine similarity; both sides are already L2-normalised, so it is a dot product. */
  denseSearch(queryVector, topK = 10) {
    const hits = new Array(this.chunks.length);

    for (let i = 0; i < this.chunks.length; i += 1) {
      const offset = i * EMBEDDING_DIMENSIONS;
      let score = 0;
      for (let d = 0; d < EMBEDDING_DIMENSIONS; d += 1) {
        score += this.embeddings[offset + d] * queryVector[d];
      }
      hits[i] = { index: i, id: this.chunks[i].id, score };
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  lexicalSearch(query, topK = 10) {
    return this.bm25.search(query, topK);
  }

  /**
   * @param {string} query
   * @param {{topK?: number, candidates?: number, mode?: "hybrid"|"dense"|"lexical"}} options
   *        `mode` and `denseWeight` exist so the evaluation harness can measure
   *        each retriever on its own and sweep the fusion weight; the
   *        application always uses hybrid at the configured weight.
   */
  async retrieve(query, { topK = 5, candidates = 20, mode = "hybrid", denseWeight = DENSE_FUSION_WEIGHT } = {}) {
    const started = performance.now();

    const queryVector = mode === "lexical" ? null : await embedOne(query);
    const dense = queryVector ? this.denseSearch(queryVector, candidates) : [];
    const lexical = mode === "dense" ? [] : this.lexicalSearch(query, candidates);

    let ranked;
    if (mode === "dense") ranked = dense.slice(0, topK);
    else if (mode === "lexical") ranked = lexical.slice(0, topK);
    else {
      ranked = reciprocalRankFusion(
        [
          { label: "dense", hits: dense, weight: denseWeight },
          { label: "lexical", hits: lexical, weight: 1 },
        ],
        { topK }
      );
    }

    const topCosine = dense.length > 0 ? dense[0].score : 0;
    const topLexical = lexical.length > 0 ? lexical[0].score : 0;

    return {
      query,
      mode,
      topCosine,
      topLexical,
      // Abstain only when BOTH retrievers are weak. Either one being confident
      // is enough to answer, because they fail on different query shapes:
      // dense on exact identifiers, lexical on paraphrase.
      abstain: topCosine < ABSTAIN_MIN_COSINE && topLexical < ABSTAIN_MIN_LEXICAL,
      latencyMs: performance.now() - started,
      results: ranked.map((hit) => ({
        ...this.chunks[hit.index ?? this.indexById.get(hit.id)],
        score: hit.score,
        ranks: hit.ranks,
      })),
    };
  }
}

let shared = null;

/** Load the corpus once per process; it is ~1.3MB and read-only. */
export function getRetriever() {
  if (!shared) shared = Retriever.load();
  return shared;
}

/** Has the corpus already been loaded? Lets /health answer without loading it. */
export function isRetrieverLoaded() {
  return shared !== null;
}

/**
 * Corpus provenance without paying for the corpus.
 *
 * meta.json is a few hundred bytes. chunks.json plus the embeddings is ~1.3MB
 * and building the BM25 index over them is real CPU, so a health check that
 * wanted three fields for its response body was doing the whole load - on the
 * cold container, on the platform's probe, before any user had asked for
 * anything.
 */
export function readCorpusMeta(directory = corpusDir) {
  return JSON.parse(fs.readFileSync(path.join(directory, "meta.json"), "utf8"));
}

export default {
  Retriever,
  getRetriever,
  isRetrieverLoaded,
  readCorpusMeta,
  ABSTAIN_MIN_COSINE,
  ABSTAIN_MIN_LEXICAL,
  DENSE_FUSION_WEIGHT,
};
