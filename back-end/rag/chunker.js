// rag/chunker.js - Token-aware chunking.
//
// The embedding model is Xenova/all-MiniLM-L6-v2. Its encoder accepts 256
// tokens and truncates silently past that, and its published behaviour
// degrades well before the cap: the model was trained on short sentence pairs,
// and quality falls off past roughly 128 tokens. Anything beyond the cap is not
// "slightly worse" - it is discarded without warning, so a long passage would
// be embedded as its first 256 tokens and the rest would be unretrievable.
//
// MAX_CHUNK_TOKENS is therefore 110, comfortably inside the degradation point
// with room for the [CLS]/[SEP] tokens the tokenizer adds. Chunks overlap by
// one sentence so a fact split across a boundary is still retrievable from
// either side.
export const MAX_CHUNK_TOKENS = 110;
export const SENTENCE_OVERLAP = 1;

/** Split on sentence ends, keeping the terminator with its sentence. */
export function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Pack sentences into chunks of at most `maxTokens` tokens.
 *
 * @param {string} text
 * @param {(text: string) => number} countTokens the real tokenizer at runtime,
 *        a stub in tests - which is why it is injected rather than imported.
 * @param {{maxTokens?: number, overlap?: number}} options
 * @returns {string[]}
 */
export function chunkText(text, countTokens, { maxTokens = MAX_CHUNK_TOKENS, overlap = SENTENCE_OVERLAP } = {}) {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const chunks = [];
  let current = [];

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join(" "));
    current = overlap > 0 ? current.slice(-overlap) : [];
  };

  for (const sentence of sentences) {
    // A single sentence longer than the budget cannot be packed; hard-split it
    // on words rather than silently letting the tokenizer truncate it.
    if (countTokens(sentence) > maxTokens) {
      flush();
      current = [];
      chunks.push(...hardSplit(sentence, countTokens, maxTokens));
      continue;
    }

    const candidate = [...current, sentence].join(" ");
    if (current.length > 0 && countTokens(candidate) > maxTokens) {
      flush();
    }
    current.push(sentence);
  }

  if (current.length > 0) chunks.push(current.join(" "));

  // The overlap tail can leave a final chunk that is a subset of the previous
  // one; embedding the same words twice buys nothing.
  return dedupe(chunks);
}

function hardSplit(sentence, countTokens, maxTokens) {
  const words = sentence.split(/\s+/);
  const pieces = [];
  let piece = [];

  for (const word of words) {
    const candidate = [...piece, word].join(" ");
    if (piece.length > 0 && countTokens(candidate) > maxTokens) {
      pieces.push(piece.join(" "));
      piece = [word];
    } else {
      piece.push(word);
    }
  }

  if (piece.length > 0) pieces.push(piece.join(" "));
  return pieces;
}

function dedupe(chunks) {
  const seen = new Set();
  const output = [];
  for (const chunk of chunks) {
    const key = chunk.trim();
    if (key.length === 0 || seen.has(key)) continue;
    // Drop a chunk wholly contained in one already emitted.
    if (output.some((existing) => existing.includes(key))) continue;
    seen.add(key);
    output.push(key);
  }
  return output;
}

export default { chunkText, splitSentences, MAX_CHUNK_TOKENS };
