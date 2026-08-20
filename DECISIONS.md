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

## Rate limiting sits on the route that costs money

There is a global limiter, and a tighter one on `POST /api/analyze`
specifically, because that is the route that burns OCR CPU and a model call.

`app.set("trust proxy", 1)` is set because the app runs behind a platform proxy.
Without it every request appears to come from the proxy's address and the
"per-IP" limiter becomes one shared global bucket. The value is `1`, not `true`:
trusting one hop reads the address the platform put there, while trusting
everything would let a client set its own `X-Forwarded-For` and walk around the
limiter.

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
