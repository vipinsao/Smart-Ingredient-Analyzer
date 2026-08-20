# Design decisions

Why the system is built the way it is, including the choices that are
deliberately unfashionable.

---

## OCR runs on the server, not in the browser

Tesseract.js runs in both places. This project runs it on the server
(`back-end/optimized-ocr.js`), which means the photograph is uploaded.

That is a real privacy cost and it was chosen anyway, for two reasons. First,
the pre-processing that makes OCR usable on a phone photo — downscale,
grayscale, histogram normalisation, sharpening — is done with `sharp`, a
libvips binding that has no browser equivalent of comparable quality; the
canvas-based alternative would be a second, weaker implementation. Second, the
server can choose between two OCR engines and fall back between them, which the
browser cannot do without shipping an API key to the client.

The honest trade-off: running Tesseract in the browser would keep the photo on
the device entirely, and would move the slowest part of the pipeline off a
shared free-tier CPU onto the user's own. It would also cost the pre-processing
step and the Gemini Vision path. That is a defensible redesign, not a bug, and
it is not what this repo does today.

What the photo is *not* used for: it never reaches the language model. Only the
extracted ingredient text is sent to Groq. Free model tiers generally permit the
provider to train on submitted data, so the smaller the payload the better, and
a line of text is a much smaller disclosure than a photograph of somebody's
kitchen.

---

## Why retrieval instead of a bare prompt

The original implementation asked the model "is this ingredient harmful?" and
rendered whatever came back. Three problems, in increasing order of severity:

1. The answer is unattributable. A user cannot check it, and neither can I.
2. The answer is not stable. The same label at the same temperature can produce
   a different verdict.
3. The model will answer for ingredients it has no reliable knowledge of, in
   the same confident register it uses for ones it does. For a tool people
   might use to decide what to eat, that is not a quality problem, it is a
   liability.

Retrieval fixes all three at once, and the citation requirement is what makes
it real: a verdict citing a passage id that was never in the prompt is rejected
and regenerated. Without that check, "RAG" is just a longer prompt.

## Why hybrid retrieval — and what the measurement actually said

The design argument for hybrid is that the two retrievers fail on different
query shapes. Ingredient identifiers are exact strings: a label prints `INS211`
or `E211`, and a 384-dimension sentence embedding places every additive code in
roughly the same region because they are the same shape of string. BM25 treats
a rare token as rare and ranks the one passage containing it first. Dense
retrieval earns its place on the opposite case, where a query shares no words
with the passage that answers it.

That argument is sound and the measurement did not support it here.
`npm run eval` reports, on 40 labelled questions, that **no query BM25 misses at
k=5 is found by dense retrieval**, and that equal-weight RRF costs 13 points of
recall@1 against BM25 alone. The full table is in the README.

Why: the corpus is short, entity-shaped passages whose titles contain the query
terms nearly verbatim, and the questions are mostly identifier or name lookups
— exactly what lexical search was designed for. My paraphrase questions turned
out to quote the source text too closely to discriminate.

What I did about it, rather than quietly shipping the losing configuration:
weighted the fusion. Dense is kept at weight 0.5 against lexical's 1.0, which
recovers BM25's recall@1 while keeping dense's contribution at rank 1 on the two
queries it does win. The weight sits in the middle of the flat region of the
sweep rather than on its argmax, because the argmax differs by one question out
of forty and that is noise, not a finding.

The honest summary for a corpus of this shape: **lexical retrieval is doing
almost all of the work**, and I can show the table that says so.

## Why no vector database

839 chunks at 384 dimensions. A brute-force cosine scan is about 322,000
multiply-adds per query - smaller than the JSON parsing around it, and orders of
magnitude below the model call it feeds. pgvector on a free Supabase tier would
work, and would add an account, a network round trip, a connection pool and a
migration to save something too small to measure reliably.

Deliberately no millisecond figure here. `npm run eval` prints p50/p95/max
alongside the machine that produced them, and the spread across machines is
about 3x - a fixed number in a document would be a claim the measurement cannot
support, and it would be the one number in this repo that does not reproduce.
The multiply-add count reproduces everywhere.

The scan is linear, so this is a decision with a stated expiry: somewhere in
the low hundreds of thousands of chunks the constant factors stop hiding it and
an approximate index starts to pay. The corpus would have to grow by two orders
of magnitude first.

## Why a local embedding model

`Xenova/all-MiniLM-L6-v2` runs in-process through ONNX Runtime: no API key, no
per-query cost, no rate limit, and no third party sees the query. It also means
ingestion and the entire evaluation harness run offline, which is why CI can
measure retrieval quality on every push without a secret.

The cost is a one-time ~87MB model download and about 14 seconds to construct
the pipeline on a cold cache. The pipeline is therefore a lazily-initialised
singleton, not a per-request construction.

## Chunk size: 110 tokens

The model's encoder accepts 256 tokens and **truncates silently** past that —
not degrades, discards. A 400-token passage would be embedded as its first 256
tokens and the remainder would be permanently unretrievable, with no error
anywhere. Quality also falls off well before the cap, since the model was
trained on short sentence pairs.

110 tokens sits inside the reliable range with headroom for the tokenizer's
special tokens. Chunks overlap by one sentence so a fact spanning a boundary
stays retrievable from either side, and a single sentence longer than the
budget is hard-split on words rather than left for the tokenizer to cut
invisibly. `rag/chunker.js` takes its token counter as an argument, so the
packing logic is unit-tested without loading the model.

## The abstention threshold, and why it is not the best one

The rule: abstain when the top cosine is below 0.42 **and** the top BM25 score
is below 8.5.

Both signals have to be weak. An earlier version abstained on the dense score
alone, and the eval set made the flaw obvious: `INS 211` has a cosine of 0.234,
because to the embedding model every additive code looks alike — while BM25
puts the correct passage first. Refusing there would be refusing an answer the
system demonstrably has.

The thresholds come from the measured distribution, which `npm run eval`
prints. They are **not** the F1-optimal pair. `cosine < 0.49` scores F1 0.88
against the configured 0.84, but it starts refusing `carrageenan` — a real
additive the corpus describes in full. Abstention precision of 100%, meaning
the system never refuses a question it can answer, is worth more here than
refusing two more out-of-corpus queries, because a wrongly-refused additive is
a silent hole in a food-safety answer while a wrongly-answered whole food still
has to survive the citation check.

**One rule I tried and discarded.** Requiring a lexical token overlap between
the query and the top passage's title looked principled and measured *worse*:
10 of 18 out-of-corpus questions refused, against 13 for the simple rule. The
overlap check fires on out-of-corpus questions too — "how many calories are in
a banana" overlaps the allergen taxonomy's `banana` entry. Discarded, and
recorded here rather than deleted, because the negative result is the useful
part.

The thresholds are only valid for the corpus they were measured on. Re-run
`npm run eval` after any change to `rag/corpus/`.

## Why allergens stay deterministic even though retrieval exists

Retrieval could answer allergen questions from the taxonomy. It still does not
decide the allergen flags. Somebody with a peanut allergy needs the same answer
for the same label every time, and needs to be able to see *why* a flag
appeared. `detectAllergenDetails` returns the keyword that produced each flag,
and the UI shows it. A retrieval-plus-generation pipeline cannot make that
promise, however good its citations are.

## The degraded path is loud

If the grounded path fails for an infrastructure reason — the corpus will not
load, or the model produced nothing citable twice — the ungrounded analysis
runs and the response carries `grounded: false` with a reason, which the UI
renders as a banner above the results. Degrading silently would defeat the
entire subsystem.

The condition is an allow-list, not a deny-list: only `GROUNDED_ANALYSIS_FAILED`
and a missing corpus degrade. Everything else propagates. Degrading on a
provider error would be pointless anyway, since the ungrounded path calls the
same provider — there is a test for exactly that.

"Loud" describes a moment, not a state. The degraded result used to be written
to the cache under the ordinary 48-hour TTL, so one uncitable reply pinned an
unsourced answer to that photo — and to every photo yielding the same
ingredient text — for two days after the provider recovered, with no
invalidation path short of a restart. It now gets `CACHE_CONFIG.degradedTTL`,
60 seconds. Not caching it at all would be equally correct and would re-run
OCR, the expensive half, for every retry during an outage; a minute keeps that
protection and caps the staleness. The policy lives in `CacheManager.setResult`
rather than at the three call sites, because a degraded result written through
plain `set()` from any one of them restores the whole class.

## The gap must be attributed correctly, or reporting it is worse than useless

This system's product is not its verdicts. It is that an ingredient it will not
rule on is *said* to be one, with the reason. That makes a wrong reason the
worst failure available to it — a plausible answer where an error belonged.

Two mechanisms enforce it.

**Every ingredient named in the prompt carries its own evidence.** The passage
budget used to be spent front to back while the ingredient list was built
independently of it, so past roughly eight non-overlapping ingredients the
later ones were named to the model with none of their passages attached. The
model declined, correctly, and the response reported "Retrieved passages did
not support a verdict" about passages that had been retrieved, had cleared both
abstention thresholds, and had then been deleted by a budget the user never
sees. `selectContextChunks` now spends the budget one round at a time — every
ingredient gets its best passage before any gets its second — and
`contextBudgetFor` never lets the budget fall below one passage per ingredient.
The ingredient list is built *from* what selection covered, so the prompt can
only ask about evidence it is carrying.

Batching into several model calls would give 25 ingredients 25 ingredients'
worth of evidence, and was rejected: it multiplies latency and provider cost
against a 20-second mobile timeout to buy supporting passages rather than
coverage, which round-robin already guarantees.

**Uncovered entries carry a code.** `NO_SOURCE`, `MODEL_DECLINED` and
`BUDGET_DROPPED` are three different facts about the world and shared one
sentence between them. They no longer do, in the payload or in the UI.

## Coverage is attributed on our side, not taken from the model's free text

Which ingredients went unanswered used to be decided by an exact lowercased
compare against the `ingredient` string the model wrote itself. Nothing
constrains a model to echo the string it was given, so a reply of `"sodium
benzoate"` to a label reading `"Sodium Benzoate (E211)"` was returned in
`analysis` *and* pushed to `uncovered`, and
`coverage.analysed + coverage.uncovered` exceeded `coverage.parsed`.

`matchVerdictsToNames` attributes each verdict back to the label's own wording
over an explicit alias set: the name, the name without its parenthetical, and
the parenthetical itself. It does no fuzzy or substring matching on purpose —
`"sugar"` capturing `"sugar syrup"` would attribute a verdict to an ingredient
nobody ruled on, which is the same class of error as the one above, not a
smaller one.

The obvious alternative is to number the ingredients `I1..In` the way the
passages are already numbered `C1..Cn` and have the verdict cite its ingredient
by index. That is exact — when the model emits the token correctly. When it does
not, a rename stops being a recoverable mismatch and becomes a lost verdict and
a retry, and the failure lands on the same provider compliance the citation
check already spends its retry budget on. Attribution is done here instead,
where it is deterministic and testable without a provider key.

The invariant this buys is worth stating plainly:
`verdicts.length + uncovered.length === considered.length` on the grounded
path, always, and `coverage.reconciled` tells the caller when it applies. The
degraded path answers from a prompt built on raw label text rather than on the
parsed list, so it reports no reconciliation rather than an arithmetic that
does not hold.

## Open Food Facts, and what ODbL asks for

The corpus is built from the Open Food Facts additives, additive-classes and
allergens taxonomies, published under the Open Database License v1.0. ODbL
carries two obligations and both are structural here rather than a footnote:

**Attribution** — every chunk carries a `source` record naming the dataset, the
taxonomy entry, the licence and a URL. Those records are returned by the API in
each verdict's `sources` array and rendered under every verdict, so attribution
travels with the data.

**Share-alike** — `rag/corpus/` is a Derived Database in ODbL terms, so it is
offered under ODbL, not under this repository's MIT licence. That split is
stated in `LICENSE` and in `rag/CORPUS.md`.

The corpus is committed rather than fetched at boot: the app then needs no
network at startup, CI can measure retrieval on every push, and the exact data
behind a published measurement is pinned. `npm run ingest` rebuilds it
deterministically — entries are processed in sorted order, so an unchanged
upstream produces an empty git diff.

---

## The model's output is schema-constrained, and the model is asked twice

`services/groqService.js` asks for a JSON array. Prompt instructions are a
request, not a contract: the observed failure modes are a markdown code fence
around the array, prose either side of it, an array truncated by the token
limit, a status word outside the allowed set, and `concerns` returned as a
string instead of an array.

So the response passes three gates:

1. `GroqService.extractJsonArray` finds the array inside whatever wrapping came
   back, and if the array is truncated it salvages the complete `{...}` objects
   and discards the severed tail. Eleven good verdicts beat an error page.
2. `schemas/analysis.js` validates every row with Zod, coercing what is
   coercible (`"BAD"` to `Bad`, a bare string to a one-element `concerns`
   array) and dropping rows that have no ingredient name at all.
3. If neither gate produces a usable row, the model is asked once more with an
   explicit repair instruction. A second failure is a typed 502, not a crash
   and not a half-rendered result.

An unrecognised status becomes `Neutral`, never `Good` or `Bad`. An unknown
verdict must not be scored as harmful, and must not be scored as healthy
either.

Before this existed, a row missing its `status` key reached
`AnalysisHelpers.calculateHealthScore`, threw `TypeError: Cannot read
properties of undefined (reading 'toLowerCase')`, and reached the user as
`500 Internal server error`.

## Allergen flags are deterministic, not model-generated

`AnalysisHelpers.detectAllergenDetails` matches a fixed keyword table
(`ALLERGENS` in `configuration/constants.js`) against the extracted text. The
model is never asked about allergens.

Someone with a peanut allergy needs the same answer for the same label every
time. A language model gives no such guarantee: the same prompt at the same
temperature can produce a different list, and there is no way to explain to a
user why a flag appeared once and not the next time. A keyword table can be
read, tested, and pointed at — `detectAllergenDetails` returns which keyword
produced each flag, so the answer is auditable.

Matching is on word boundaries with an optional plural. That is not cosmetic:
substring matching flagged gluten for `maltodextrin`, because `malt` is a gluten
keyword and a substring of a normally corn-derived ingredient. There is a test
for exactly that case.

The health score is deterministic for the same reason: 100, minus 10 per `Bad`
verdict and 4 per `Neutral` one. The model supplies the verdicts; the arithmetic
is ours, and it is explainable in one sentence.

## Groq for analysis, Gemini optionally for OCR

The requirement was that anyone can clone this and run it at zero cost.

Groq's free developer tier needs no credit card and charges nothing per token;
it is governed by rate limits. It is fast enough that the model call is not the
bottleneck — measured at 3.5s against 21s for OCR on the deployed instance.
Model ids are volatile: Groq shut down `llama-3.3-70b-versatile` on 2026-08-16,
so `GROQ_MODEL` is configurable and defaults to a model currently listed as
production-ready.

Gemini Vision reads stylised label typography better than Tesseract does, so it
is tried first when `GEMINI_API_KEY` is set. It is optional on purpose: with no
Gemini key the app falls back to Tesseract and still works end to end. That
keeps the required-secret count at one.

Both providers sit behind the same internal interface — OCR returns
`{ text, confidence, method }` regardless of engine — but only one provider is
implemented for analysis. Two half-implemented providers would be worse than
one working one.

## Keys never reach the browser

Every model call is made from `back-end/`. The frontend's only environment
variable is `VITE_API_URL`, and Vite inlines `VITE_*` variables into the
published bundle, which is why nothing else may be named that way. A key in a
`VITE_` variable is a key published on the internet.

## Caching is content-addressed, twice

`utils/cache.js` keys results two ways:

- **sha256 of the uploaded bytes.** A repeat of the exact same photo skips OCR,
  which is the expensive half — seconds, against a few hundred milliseconds for
  the model.
- **hash of the extracted ingredient text.** Two different photos of the same
  product converge here and skip the model call.

The original implementation had only the text key, which meant OCR ran on every
request; a cache hit saved 3.5s of a 25s request. It is an in-process cache, so
it is lost on restart and not shared across instances — the right shape for a
single free-tier container, and the wrong shape for anything larger.

An entry's TTL depends on what the entry claims: a sourced result keeps the
full 48 hours, a `grounded: false` result keeps 60 seconds. See [The degraded
path is loud](#the-degraded-path-is-loud).

## Rate limiting sits on the route that costs money

There is a global limiter, and a tighter one on `POST /api/analyze`
specifically, because that is the route that burns OCR CPU and a model call.

### `trust proxy` defaults to none, and the previous reasoning here was wrong

This document used to say that `app.set("trust proxy", 1)` was the safe choice
because "trusting one hop reads the address the platform put there, while
trusting everything would let a client set its own `X-Forwarded-For`". That is
not what the setting does. Any non-`false` value makes Express read `req.ip` out
of the client-supplied header. `1` does not verify that a proxy exists; it takes
the last entry of whatever the client sent.

And this project's own shipped topology has no proxy in front of it:
`docker-compose.yml` publishes `5000:5000`, and `front-end/nginx.conf` serves
static assets with no `proxy_pass`, so the browser calls the API directly.

Measured against this repo's configuration — express 4.21.2,
express-rate-limit 8.0.1, `/api/analyze` budget 20 per 15 minutes, 300 requests
from one machine:

| configuration | allowed | blocked |
| --- | --- | --- |
| `trust proxy: 1`, no header | 20 | 280 |
| `trust proxy: 1`, rotating `X-Forwarded-For` | **300** | **0** |
| `trust proxy: false`, rotating `X-Forwarded-For` | 20 | 280 |

The limiter was not weakened, it was absent. On an unauthenticated route that
spends the owner's API key and the container's only CPU, that is the finding
that makes every other abuse finding exploitable at will rather than
opportunistically.

express-rate-limit ships a validator for this and it does **not** flag `1` — it
only errors on `true` — which is why a wrong comment and a wrong value survived
review together.

`TRUST_PROXY` now defaults to `false` and accepts a hop count or a list of proxy
addresses. `true` is refused with a warning. The deployment that genuinely sits
behind one proxy sets `TRUST_PROXY=1` and says so out loud.

### CORS lists exact origins

The production list used to end with `/\.vercel\.app$/`. The API is
unauthenticated, so CORS was never protecting data here — but that regex matches
any site anybody deploys to Vercel, which let an attacker's page drive its
visitors' browsers into `/api/analyze`. That spends this project's Groq quota
from residential addresses that a per-IP limiter correctly sees as unrelated
people. Exact origins only, overridable through `CORS_ORIGINS`.

## Bounding one dimension is not bounding the work

The size checks on an upload are `express.json({ limit: "12mb" })` and an 8MB
check on the decoded buffer. Both bound **encoded bytes**. Nothing bounded the
pixels those bytes decode to, and Tesseract's runtime tracks pixels.

`targetWidth()` returned `Math.min(originalWidth, maxWidth)`. `metadata.height`
was read only to check it was non-zero. So an image that is already narrow
enough received no downscale at all, however tall it was, and aspect ratio
walked straight around the cap.

Measured on one core, text-filled canvases, with `npm run bench:bounds`:

| upload | wire | pixels | after pre-processing | cost |
| --- | --- | --- | --- | --- |
| 2000×1500 | 0.39MB | 3.0M | 2000×1500 — unchanged | 11.4s |
| 2000×20000 | **5.46MB** | 40.0M | **2000×20000 — unchanged** | **126.2s** |
| 16383×16383 | 8.30MB | 268.4M | 2000×2000 | 13.4s |

11.1× the cost of a normal label, from a file well inside the 8MB allowance.
Five of them held the single OCR worker for ten minutes, and the queue bound
above them turned a defence into the mechanism: everyone else got an instant
503.

The square case is the instructive one. It is **not** saved by sharp's default
pixel limit — 16383² is 268,402,689, which is that limit exactly, so it passes.
It is saved by the width cap, which downscales it to 2000×2000 while preserving
aspect ratio. Bounding width happens to bound a square. It does nothing for a
strip.

Three bounds now, at three different levels:

- **`limitInputPixels` is stated rather than inherited.** `grep -rn
  limitInputPixels back-end/` used to return nothing, so the guarantee lived in
  a dependency default that a version bump could change in silence.
- **`maxPixels` caps the area handed to OCR**, scaling uniformly so a tall
  receipt is shrunk rather than cropped or refused. 4M is 2000×2000: above the
  1.9M of this repo's own sample, so no real label is downscaled by it that the
  width cap was not already downscaling.
- **A per-recognition deadline**, after which the worker is destroyed and the
  pool rebuilt. tesseract.js exposes no abort, so rejecting the caller while
  leaving the worker running would free the bookkeeping and not the CPU.

The first two make a hostile upload cost no more than a legitimate one. The
third is the backstop for the shape nobody predicted. Neither replaces the rate
limiter, which is why that had to be fixed first.

## Two bounds on work that the caller chooses

The same failure — a caller choosing how much work the server does — appeared in
two more places, and both are bounded by the same reasoning rather than by
guesswork about attacker behaviour.

**Ingredient parsing was quadratic.** `/\b(?!ins)\d+(?!\d*%|ins)\b/gi` re-scans
the rest of a digit run inside the lookahead at every backtrack position. It
runs synchronously, on the request thread, over whatever Tesseract produced.
Measured on a digit run followed by `ins`, at 5k/10k/20k/40k characters:
32ms / 133ms / 600ms / 2666ms — a clean 4× per doubling. The replacement,
`/\b\d+\b(?!%)/g`, measures 0ms on all four.

Both guards the old pattern dropped were already dead. `(?!ins)` sat between a
word boundary and `\d+`, so it could never match anything. The `ins` half of the
trailing lookahead was already enforced by `\b`, because a digit followed by a
letter is not a word boundary — which is exactly what keeps `INS1422` intact.
OCR text is also truncated before parsing, because a linear pass over an
unbounded string is still unbounded.

**The result cache had no `maxKeys`.** Its keys are content hashes and the
caller supplies the content — and appending one byte after a JPEG's EOI marker
changes the hash without changing a pixel, a trick this repo's own
`scripts/profile-analyze.js` documents and relies on. Every distinct byte string
bought a 48-hour entry. It is bounded now, and `CacheManager.set` evicts the
oldest entry rather than letting node-cache throw `ECACHEFULL`, which would have
traded a memory leak for an outage.

## Anything that has not named itself development is production

`errorHandler` attached internal detail to responses whenever
`NODE_ENV !== "production"`. Every other value that variable can hold — `prod`,
`Production`, `staging`, a typo, or the empty string a container gets when the
variable is dropped — took the development branch and started talking.

It is a deny-list now: detail is attached only when `NODE_ENV` is explicitly
`development` or `test`. It also reads the raw variable rather than the
`env.NODE_ENV` that falls back to `"development"`, because that fallback is a
reasonable default for choosing a port and the wrong one for deciding whether to
expose internals.

Choosing the CORS origin list still keys off `env.NODE_ENV`, because there the
unset case already fails closed — the development list is localhost-only, which
is narrower than production's, not wider.

## Errors are typed, and mapped in one place

`utils/AppError.js` carries a `code` and a `statusCode`. `middleware/errorHandler.js`
maps typed errors first, framework errors (`entity.too.large`) second, and only
then falls back to matching on message text.

The order matters. The previous version matched on text first, so an oversized
upload — whose message body-parser writes as `request entity too large` — matched
nothing and fell through to a generic 500. The frontend had a branch for 413
that could never fire.

The frontend now shows the server's own message rather than re-deriving one from
the error code, which is how that mapping drifted into referring to codes the
server had stopped sending.

---

## Measuring generation: what is exact, what is a proxy, and when a judge is worth having

Retrieval is easy to score. A labelled question either got its passage back or
it did not, and `npm run eval` says so 58 times. Generation is not, and the
temptation is to produce a number anyway.

So the generation harness sorts its metrics into three kinds and says which is
which, in the code, in the output, and here.

**Exact.** *Citation validity*: every id a verdict cites either appeared in the
prompt or it did not. There is no judgement in it. It is counted twice — per
verdict, which is what a user experiences (this answer is or is not
attributable), and per citation, which is what the model's behaviour looks like
(how often it reaches for an id that does not exist). *Unsupported numerals*:
every standalone number in a verdict's stated reason that appears in none of its
cited passages. This corpus is full of quantities — acceptable daily intakes, E
numbers, percentages — and a verdict asserting "an ADI of 40 mg/kg" against
passages containing no 40 has invented the figure whatever else is true of it.
That check is string comparison and gives the same answer every time.

**A proxy, and never presented as more.** *Lexical support*: the fraction of a
claim's content words that also occur in the passages it cites. It is here
because it is deterministic, free, needs no second model, and catches the
failure that matters most in a food-safety tool — a verdict whose reason shares
almost no vocabulary with the passage it names as its source. It has two failure
modes and both are written where it is defined: a correct paraphrase ("stops
mould" for "antifungal agent") scores low and is not wrong, and a negated claim
("EFSA did not assess this") scores near 1.0 against a passage saying the
opposite, and is wrong. So the harness prints the whole ratio distribution and
not just a count above a line, and the 0.6 line is called a reporting convention
rather than a threshold. Calibrating a threshold needs a set of verdicts a human
has labelled grounded or ungrounded. No such set exists for this corpus, so
there is nothing to calibrate against and pretending otherwise would be the
whole problem in miniature.

**Optional, and compromised.** *LLM-as-judge*, off unless `--judge` is passed.

The case for it: attribution against a supplied passage is about the easiest
thing a judge can be asked. The passage is in the prompt, the claim is one
sentence, the answer space is three tokens, and no world knowledge is required —
this is the shape of judging task with the best published agreement with human
raters. It also catches exactly what the lexical proxy cannot: paraphrase and
negation.

The case against it, which is not small and is printed every time the judge
runs. The judge here is `openai/gpt-oss-120b`, the same model that wrote the
claims, and models score their own output higher than other models' — a
self-preference bias this makes no attempt to correct. Worse, the judge's own
accuracy is unmeasured, for the same reason the lexical threshold is
uncalibrated: there are no human labels. An unvalidated judge produces a number
with an unknown error bar, and a number with an unknown error bar reported to
two significant figures is how a metric becomes a lie.

The rule this settles on: **an LLM judge is worth having when the task is closed
(the evidence is in the prompt), the answer space is small, the judge is a
different model from the generator, and its agreement with human labels has been
measured on a sample.** Here the first two hold and the last two do not. So it
is available, it is off by default, its verdicts are reported beside the
deterministic ones rather than blended into them, and its two defects are named
in the output — not only in this file, because a number that travels without its
caveat is a number without its caveat.

**What none of this measures.** No generation numbers have been produced. There
was no API key. The harness runs, has been exercised end to end against
`scripts/stub-llm.js`, and its output on a stub is a property of the stub and is
recorded nowhere — `rag/eval/generation-results.json` is gitignored for that
reason.

---

## The instrumentation is hand-written, and there are six metrics

`@opentelemetry/auto-instrumentations-node` was the obvious choice and was not
taken.

Two reasons, and the second is the real one. First, this package is ESM, and
auto-instrumentation works by patching CommonJS `require`; under ESM it needs
`--experimental-loader @opentelemetry/instrumentation/hook.mjs` threaded through
`npm start`, the Dockerfile, the profiler and the load test — four entry points,
each of which can be forgotten, and the failure mode of forgetting is silence.

Second, it would have reported `http`, `fs` and `dns`. The measured cost of a
request here is 78% Tesseract, ~4% retrieval and, against a stub, ~0.6% model
call. None of those are library calls an auto-instrumentor knows the name of.
The spans worth having are this application's own stages and would have had to
be written by hand either way; auto-instrumentation would have added a hundred
transitive packages and a loader hook to decorate them with `http.server` spans
that duplicate the one in `server.js`.

The cost of that choice is stated rather than hidden: there is no automatic span
around an outbound HTTP call, so the Groq round trip is timed by the
`llm.generate` span written around it and by nothing else, and a `fetch` added
somewhere else in future will be invisible until somebody wraps it.

**Six metrics, and the discipline is in what was left out.** Request duration by
route and outcome, cache lookups by result, retrieval duration, OCR rejections
by reason, provider tokens by kind, OCR queue depth. Three of those exist
because the earlier performance work needed them and had to reconstruct them
by hand each time.

Three things deliberately absent. There is **no cache hit-rate gauge**: a ratio
cannot be re-windowed or summed across instances, two counters can, and the
division is free at query time. There is **no per-stage metric mirroring the
spans** — the trace already carries that, and a metric duplicating a span is two
things to keep in step. And the `http.route` attribute is a **closed set**:
`req.path` on a 404 is whatever the caller typed, and on an unauthenticated API
one scan would mint a time series per probed URL, which is a memory leak with a
dashboard attached.

**Queue depth is an observable gauge, not a counter.** Depth is a level, not an
event; sampling it at export time costs nothing per request, where incrementing
and decrementing a counter would put bookkeeping on the OCR path.

**Batch span processor, never simple.** A `SimpleSpanProcessor` serialises and
writes at the moment each span ends, on the request thread — putting the
exporter inside the path the instrumentation exists to observe rather than
speed up.

**A defect this file should record, because it was written here.** Instruments
are resolved on first use rather than at import, and that is not a style choice.
`trace.getTracer()` returns a proxy that picks up a provider registered later,
which is why a module-scope tracer works. `metrics.getMeter()` does not: called
before `setGlobalMeterProvider`, it returns a `NoopMeter`, and every instrument
built from it is permanently and silently a no-op. The first version of
`telemetry.js` created its instruments at import, so traces appeared, metrics
did not, and nothing anywhere reported an error. It was caught by running the
server and looking for the metric names, not by reading the code.

**What was deliberately not instrumented.** The two Next.js applications in this
portfolio have no OpenTelemetry and are not getting any. They are page-render
and API-route apps whose slow paths are third-party API calls the platform's own
request log already times; there is no multi-stage pipeline inside a request to
decompose, so a trace would show one span with the same duration the access log
already reports. Instrumenting them would add a runtime dependency, a loader
hook per entry point and a config surface, in exchange for a number that already
exists. Over-instrumenting a small app is a judgement failure in the same family
as under-instrumenting a large one, and the honest answer to "why is there no
tracing in the Next.js apps" is that nothing in them is currently
unattributable.
