// rag/eval/generation-metrics.js - Scoring functions for the generation half.
//
// `run-eval.js` measures everything up to the model call. These are the
// measurements that only exist after it: did the model cite passages that were
// really in its prompt, does each verdict's stated reason trace back to the
// passage it cites, and did it refuse when the corpus had nothing to say.
//
// Everything here is a pure function of (verdict, passages). No I/O, no model,
// no clock - which is why the whole file is unit-tested against fixtures in
// tests/generation-metrics.test.js and runs in CI with no key.
//
// The honest description of what these can and cannot do is in DECISIONS.md
// decision 17. The short version: `citationsResolve` is exact, the numeral
// check is exact, and `lexicalSupport` is a proxy for attribution that will
// mark a correct paraphrase unsupported and will not notice a negation flip.

/**
 * Words carrying no evidence. Deliberately short: this is not a linguistic
 * resource, it is the set of tokens whose presence or absence in a passage
 * says nothing about whether the passage supports the claim.
 */
const STOPWORDS = new Set(
  ("a an and are as at be been by can for from has have in into is it its may " +
    "no not of on or that the their there they this to used using was were " +
    "when which with would you your").split(" ")
);

/**
 * Crude suffix stripping, not a stemmer.
 *
 * Without it "assessed" and "assessment" miss "assess", and the support ratio
 * reads low for reasons that are grammatical rather than evidential. With it,
 * "classes" and "classed" collapse onto "class", which is right often enough
 * to be worth the false merges it also causes. Named crude so nobody mistakes
 * it for Porter.
 */
export function normaliseWord(word) {
  const lower = word.toLowerCase();
  if (lower.length <= 4) return lower;
  for (const suffix of ["ing", "ies", "ed", "es", "s"]) {
    if (lower.endsWith(suffix) && lower.length - suffix.length >= 3) {
      return lower.slice(0, lower.length - suffix.length);
    }
  }
  return lower;
}

/** Content words of a string: lowercased, de-suffixed, stopwords and digits removed. */
export function contentWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !/^\d+$/.test(token) && !STOPWORDS.has(token))
    .map(normaliseWord);
}

/**
 * Every standalone number in a string, normalised so "0.40" and ".4" compare
 * equal but "40" and "4" do not.
 */
export function numeralsIn(text) {
  const matches = String(text ?? "").match(/\d+(?:\.\d+)?/g) ?? [];
  return matches.map((raw) => String(Number(raw)));
}

/**
 * Citation validity: does every cited id name a passage that was actually in
 * the prompt?
 *
 * Exact, not a proxy. Counted two ways because they answer different
 * questions: the verdict rate is what a user experiences (this answer is or is
 * not attributable), the citation rate is what the model's behaviour looks
 * like (how often does it reach for an id that does not exist).
 *
 * @param {Array<{ingredient: string, citations: string[]}>} verdicts
 * @param {Set<string>|string[]} allowedIds ids that appeared in the prompt
 */
export function citationReport(verdicts, allowedIds) {
  const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds);

  let citations = 0;
  let citationsResolved = 0;
  let verdictsFullyValid = 0;
  let verdictsUncited = 0;
  const invented = [];

  for (const verdict of verdicts) {
    const ids = verdict.citations ?? [];
    if (ids.length === 0) {
      verdictsUncited += 1;
      continue;
    }

    let allResolve = true;
    for (const id of ids) {
      citations += 1;
      if (allowed.has(id)) citationsResolved += 1;
      else {
        allResolve = false;
        invented.push({ ingredient: verdict.ingredient, id });
      }
    }
    if (allResolve) verdictsFullyValid += 1;
  }

  return {
    verdicts: verdicts.length,
    verdictsFullyValid,
    verdictsUncited,
    citations,
    citationsResolved,
    invented,
    // Rates are null rather than 0 or 1 on an empty denominator: "no verdicts
    // were produced" is not "every verdict was valid", and averaging a
    // fabricated 1.0 into a corpus-level figure is how a metric starts lying.
    verdictValidity: verdicts.length === 0 ? null : verdictsFullyValid / verdicts.length,
    citationValidity: citations === 0 ? null : citationsResolved / citations,
  };
}

/**
 * Fraction of the claim's content words that also occur in the passages it
 * cites.
 *
 * This is a proxy for attribution and nothing more. It is here because it is
 * deterministic, free, needs no second model, and catches the failure that
 * matters most in a food-safety tool: a verdict whose stated reason shares
 * almost no vocabulary with the passage it claims as its source.
 *
 * It has two failure modes worth stating before anyone quotes it. A correct
 * paraphrase ("stops mould" for "antifungal agent") scores low and is not
 * wrong. A negated claim ("EFSA did not assess this") scores near 1.0 against
 * a passage saying the opposite, and is wrong. The second is why the judge in
 * `judgePrompt` exists as an option, and why neither number is presented on
 * its own.
 */
export function lexicalSupport(claim, passages) {
  const words = contentWords(claim);
  const supporting = new Set(passages.flatMap((passage) => contentWords(passage)));

  const missing = words.filter((word) => !supporting.has(word));
  return {
    total: words.length,
    supported: words.length - missing.length,
    missing: [...new Set(missing)],
    ratio: words.length === 0 ? null : (words.length - missing.length) / words.length,
  };
}

/**
 * Numbers asserted by the claim that appear in none of its cited passages.
 *
 * Unlike the word overlap this is exact and it is a hard signal. This corpus
 * is full of quantities - acceptable daily intakes, E numbers, percentages -
 * and a verdict that states "an ADI of 40 mg/kg" against passages containing
 * no 40 has invented the figure, whatever its wording overlap says.
 */
export function unsupportedNumerals(claim, passages) {
  const cited = new Set(passages.flatMap((passage) => numeralsIn(passage)));
  return [...new Set(numeralsIn(claim))].filter((value) => !cited.has(value));
}

/**
 * The reporting threshold for `lexicalSupport.ratio`, above which a claim is
 * counted as lexically supported.
 *
 * 0.6 is a reporting convention, NOT a calibrated value: no human-labelled set
 * of grounded and ungrounded verdicts exists for this corpus, so there is
 * nothing to calibrate against. The harness prints the full ratio distribution
 * beside the count for exactly that reason - the distribution is the finding,
 * the count above a line is a summary of it.
 */
export const LEXICAL_SUPPORT_THRESHOLD = 0.6;

/**
 * Score one verdict against the passages it cites.
 *
 * @param {{ingredient: string, reason: string, citations: string[]}} verdict
 * @param {Map<string, {title: string, text: string}>} byId the prompt's id map
 */
export function groundednessReport(verdict, byId) {
  const passages = (verdict.citations ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((chunk) => `${chunk.title} ${chunk.text}`);

  // A claim citing only ids that do not resolve has nothing to be grounded in.
  // That is a citation failure, already counted; reporting it as ungrounded
  // too would double-count the same defect.
  if (passages.length === 0) {
    return { ingredient: verdict.ingredient, scored: false, reason: "no resolvable citation" };
  }

  const support = lexicalSupport(verdict.reason, passages);
  const numerals = unsupportedNumerals(verdict.reason, passages);

  return {
    ingredient: verdict.ingredient,
    scored: true,
    claim: verdict.reason,
    citations: verdict.citations,
    lexicalSupport: support.ratio,
    unsupportedWords: support.missing,
    unsupportedNumerals: numerals,
    supported: support.ratio !== null && support.ratio >= LEXICAL_SUPPORT_THRESHOLD && numerals.length === 0,
  };
}

/**
 * Prompt for the optional LLM-as-judge pass.
 *
 * Deliberately the narrowest question that can be asked: one claim, the
 * passages it cited, three allowed answers. Attribution against a supplied
 * passage is the one judging task with published evidence of usable agreement
 * with human raters; open-ended quality scoring is not, and is not asked for
 * here. The limits of even this narrow use - chiefly that the judge is the
 * same model family that wrote the claim, and that its own accuracy is
 * unmeasured because there are no human labels - are argued in DECISIONS.md
 * decision 17 and reprinted by the harness whenever the judge runs.
 */
export function judgePrompt(claim, passages) {
  return `You are checking whether a claim is supported by the passages it cites. Judge attribution only: not whether the claim is true in general, only whether these passages state or directly entail it.

PASSAGES:
${passages.map((passage, index) => `[P${index + 1}] ${passage}`).join("\n\n")}

CLAIM:
${claim}

Answer with one word on the first line: SUPPORTED, PARTIAL, or UNSUPPORTED. Then one short sentence of justification on the second line.`;
}

/** Read a judgement out of the reply. Anything unrecognised is `null`, never a guess. */
export function parseJudgement(text) {
  const first = String(text ?? "").trim().split("\n")[0]?.trim().toUpperCase() ?? "";
  for (const verdict of ["UNSUPPORTED", "SUPPORTED", "PARTIAL"]) {
    if (first.startsWith(verdict)) return verdict;
  }
  return null;
}

export default {
  contentWords,
  numeralsIn,
  citationReport,
  lexicalSupport,
  unsupportedNumerals,
  groundednessReport,
  judgePrompt,
  parseJudgement,
  LEXICAL_SUPPORT_THRESHOLD,
};
