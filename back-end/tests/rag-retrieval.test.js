import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, splitSentences } from "../rag/chunker.js";
import { tokenize, Bm25Index, reciprocalRankFusion } from "../rag/bm25.js";
import { additiveToPassage, splitAdditiveName, stripLangPrefix } from "../rag/normalize.js";
import { Retriever } from "../rag/retriever.js";

// A stand-in tokenizer: one token per word. The real one is async and needs
// the model on disk, which is why chunkText takes the counter as an argument.
const countWords = (text) => text.split(/\s+/).filter(Boolean).length;

test("splitSentences keeps the terminator with its sentence", () => {
  assert.deepEqual(splitSentences("One. Two! Three?"), ["One.", "Two!", "Three?"]);
});

test("chunkText packs sentences up to the token budget", () => {
  const text = "aaa bbb ccc. ddd eee fff. ggg hhh iii. jjj kkk lll.";
  const chunks = chunkText(text, countWords, { maxTokens: 6, overlap: 0 });

  assert.equal(chunks.length, 2);
  for (const chunk of chunks) {
    assert.ok(countWords(chunk) <= 6, `chunk exceeded the budget: "${chunk}"`);
  }
});

test("chunkText overlaps by one sentence so a fact on a boundary stays retrievable", () => {
  const text = "alpha one. bravo two. charlie three. delta four.";
  const chunks = chunkText(text, countWords, { maxTokens: 4, overlap: 1 });

  assert.ok(chunks.length >= 2);
  const secondStartsWithFirstsTail = chunks[1].startsWith(chunks[0].split(". ").pop().replace(/\.$/, ""));
  assert.ok(secondStartsWithFirstsTail, `expected overlap, got: ${JSON.stringify(chunks)}`);
});

test("chunkText hard-splits a single sentence longer than the budget", () => {
  // Silent truncation is the failure this prevents: the embedding model drops
  // everything past its window without telling anyone.
  const long = `${"word ".repeat(30).trim()}.`;
  const chunks = chunkText(long, countWords, { maxTokens: 8, overlap: 0 });

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(countWords(chunk) <= 8);
});

test("tokenize normalises every spelling of an additive code to one token", () => {
  for (const spelling of ["E211", "e 211", "E-211", "INS211", "ins 211"]) {
    assert.ok(tokenize(spelling).includes("e211"), `${spelling} did not normalise`);
  }
});

test("BM25 ranks the passage containing an exact identifier first", () => {
  const index = new Bm25Index([
    { id: "a", text: "E211 sodium benzoate is a preservative" },
    { id: "b", text: "E212 potassium benzoate is a preservative" },
    { id: "c", text: "preservatives protect food against micro-organisms" },
  ]);

  assert.equal(index.search("INS 211", 3)[0].id, "a");
});

test("weighted reciprocal rank fusion lets one retriever outrank the other", () => {
  const dense = { label: "dense", weight: 0.5, hits: [{ id: "x", index: 0 }, { id: "y", index: 1 }] };
  const lexical = { label: "lexical", weight: 1, hits: [{ id: "y", index: 1 }, { id: "x", index: 0 }] };

  const fused = reciprocalRankFusion([dense, lexical], { topK: 2 });

  assert.equal(fused[0].id, "y", "the full-weight retriever's first place should win");
  assert.deepEqual(fused[0].ranks, { dense: 2, lexical: 1 });
});

test("stripLangPrefix and splitAdditiveName unpack the taxonomy's formats", () => {
  assert.equal(stripLangPrefix("en:preservative"), "preservative");
  assert.deepEqual(splitAdditiveName("E211 - Sodium benzoate"), { code: "E211", label: "Sodium benzoate" });
  assert.deepEqual(splitAdditiveName("Curcumin"), { code: "", label: "Curcumin" });
});

test("additiveToPassage states only what the taxonomy entry contains", () => {
  const passage = additiveToPassage(
    "en:e211",
    {
      name: { en: "E211 - Sodium benzoate" },
      e_number: { en: "211" },
      additives_classes: { en: "en:preservative" },
      efsa_evaluation_overexposure_risk: { en: "en:high" },
      vegan: { en: "yes" },
      vegetarian: { en: "yes" },
    },
    { classNames: { "en:preservative": "preservative" } }
  );

  assert.equal(passage.id, "additive:en:e211");
  assert.equal(passage.title, "E211 Sodium benzoate");
  // The aliases are what lexical retrieval matches a real label against.
  assert.deepEqual(passage.aliases.sort(), ["E211", "INS211", "Sodium benzoate"]);
  assert.match(passage.text, /Additive class: preservative/);
  assert.match(passage.text, /overexposure risk .* assessed as high/);
  assert.equal(passage.source.licence, "ODbL-1.0");
  // Nothing invented: no ADI sentence, because the entry carried no ADI.
  assert.doesNotMatch(passage.text, /acceptable daily intake/i);
});

test("the committed corpus retrieves the right additive for a label identifier", () => {
  // Lexical only, so this needs no embedding model and runs in CI in
  // milliseconds. Dense and hybrid quality is measured by `npm run eval`.
  const retriever = Retriever.load();
  const hits = retriever.lexicalSearch("INS 1422", 3);

  assert.ok(hits.length > 0);
  const top = retriever.chunks[hits[0].index];
  assert.equal(top.passageId, "additive:en:e1422", `got ${top.passageId} (${top.title})`);
});

test("the committed corpus is internally consistent", () => {
  const retriever = Retriever.load();
  assert.equal(retriever.chunks.length, retriever.meta.chunks);
  assert.equal(
    retriever.embeddings.length,
    retriever.meta.chunks * retriever.meta.dimensions,
    "embeddings.f32 and chunks.json must describe the same corpus"
  );
  for (const chunk of retriever.chunks.slice(0, 50)) {
    assert.equal(chunk.source.licence, "ODbL-1.0");
    assert.ok(chunk.text.length > 0);
  }
});
