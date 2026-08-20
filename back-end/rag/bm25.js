// rag/bm25.js - Lexical retrieval.
//
// Dense embeddings are the wrong tool for half the queries this app makes.
// "E211" and "INS211" are exact identifiers; a 384-dimension sentence
// embedding places them near every other additive code, because to the model
// they are near-identical strings of the same shape. BM25 treats them as rare
// terms and ranks the one passage that contains them first. Dense retrieval
// wins on the other half - "what stops bread going mouldy" retrieves the
// preservative passage without sharing a word with it.
//
// Standard BM25 with the usual constants; no dependency.
const K1 = 1.2;
const B = 0.75;

/**
 * Tokenise for lexical matching.
 *
 * "E 211", "E211", "e-211" and "INS211" are the same identifier printed four
 * ways, so a separated additive code is glued back together and the INS prefix
 * used on Indian labels is normalised to the E form.
 */
export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/\b(?:e|ins)[\s-]?(\d{3,4}[a-z]*)\b/g, " e$1 ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

export class Bm25Index {
  /** @param {Array<{id: string, text: string}>} documents */
  constructor(documents) {
    this.documents = documents;
    this.termFrequencies = [];
    this.lengths = [];
    this.documentFrequency = new Map();

    for (const document of documents) {
      const tokens = tokenize(document.text);
      const frequencies = new Map();
      for (const token of tokens) {
        frequencies.set(token, (frequencies.get(token) || 0) + 1);
      }
      this.termFrequencies.push(frequencies);
      this.lengths.push(tokens.length);
      for (const token of frequencies.keys()) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) || 0) + 1);
      }
    }

    this.averageLength =
      this.lengths.reduce((sum, length) => sum + length, 0) / (this.lengths.length || 1);
  }

  idf(term) {
    const n = this.documents.length;
    const df = this.documentFrequency.get(term) || 0;
    // BM25+ style smoothing; keeps the score of a term present in every
    // document at zero rather than negative.
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** @returns {Array<{index: number, id: string, score: number}>} best first */
  search(query, topK = 10) {
    const terms = tokenize(query);
    const scores = new Float64Array(this.documents.length);

    for (const term of terms) {
      if (!this.documentFrequency.has(term)) continue;
      const idf = this.idf(term);

      for (let i = 0; i < this.documents.length; i += 1) {
        const frequency = this.termFrequencies[i].get(term);
        if (!frequency) continue;
        const norm = 1 - B + (B * this.lengths[i]) / this.averageLength;
        scores[i] += (idf * (frequency * (K1 + 1))) / (frequency + K1 * norm);
      }
    }

    return Array.from(scores)
      .map((score, index) => ({ index, id: this.documents[index].id, score }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

/**
 * Reciprocal Rank Fusion.
 *
 * Chosen over score normalisation because BM25 scores and cosine similarities
 * are not on comparable scales and their ranges shift with the query. RRF uses
 * only the rank, so it needs no calibration: a document ranked first by either
 * retriever gets 1/(k+1) from that retriever, and a document both agree on
 * rises above one that only a single retriever liked.
 *
 * k = 60 is the value from the original paper (Cormack et al., 2009); it damps
 * the difference between rank 1 and rank 2 enough that one retriever cannot
 * dominate on its own.
 *
 * Each list carries a weight. Plain RRF weights both retrievers equally, and
 * on this corpus that measurably hurt: recall@1 fell from 83% (lexical alone)
 * to 70%, because dense retrieval ranks every additive code similarly and drags
 * a correct lexical rank-1 hit down. See the weight sweep printed by
 * `npm run eval`.
 */
export function reciprocalRankFusion(rankedLists, { k = 60, topK = 10 } = {}) {
  const scores = new Map();

  for (const { label, hits, weight = 1 } of rankedLists) {
    hits.forEach((hit, rank) => {
      const previous = scores.get(hit.id) || { id: hit.id, index: hit.index, score: 0, ranks: {} };
      previous.score += weight / (k + rank + 1);
      previous.ranks[label] = rank + 1;
      scores.set(hit.id, previous);
    });
  }

  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, topK);
}

export default { Bm25Index, tokenize, reciprocalRankFusion };
