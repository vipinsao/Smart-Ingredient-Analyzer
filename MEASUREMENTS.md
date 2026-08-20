# Measured performance and abuse bounds

The workings behind the performance and hardening claims in
[README.md](./README.md). Every figure here is the output of a command in
`back-end/package.json`, run on the machine named in the section that reports
it. Nothing here is borrowed from someone else's benchmark.

---

## Cost per label

One real label (`Water, Sugar, Jaggery, Tomato Paste, Tamarind (5%), Iodised
Salt, Spices and Condiments, Stabilizers (INS1422, INS415), Acidity Regulators
(INS260, INS334) and Preservative (INS211).`) parses to 15 ingredients. Five
abstain before any token is spent. The remainder produce a prompt of **24
context passages, 7,448 characters** (~1,860 tokens by the 4-characters-per-token
rule of thumb — an estimate, not a provider count).

## Latency, and where it goes

Every figure in this section was measured on one machine — **Intel i5-9300H,
WSL2, Node 24** — pinned to a single core with `taskset -c 0`, because the
deployment target is a free tier with one shared CPU and an 8-core laptop
answers a different question. The model call is stubbed
(`back-end/scripts/stub-llm.js`), so these are the pipeline's own costs with the
provider round trip removed; add that for a user-facing total.

Before and after were run **back to back in one session**, from a git worktree
at the pre-pool commit and then at `master`. That matters: the same unchanged
code measured 3.8s and 7.7s on this laptop two hours apart, so any before/after
pair taken at different times on this hardware is meaningless.

```bash
cd back-end
taskset -c 0 node scripts/profile-analyze.js 3 5
```

Medians, warm process, one core, in milliseconds:

| stage | before | after |
| --- | --- | --- |
| sharp pre-processing | 660 | 422 |
| Tesseract | 3,257 | 1,502 |
| **total, server-side** | **3,777** | **1,941** |

First request after a cold boot, medians:

| stage | before | after |
| --- | --- | --- |
| retrieval (embed + BM25) | 494 | 133 |
| Tesseract | 2,721 | 2,136 |
| **total, server-side** | **3,794** | **3,327** |
| boot to a healthy `/health` | 672 | 592 |

Three changes account for it: the Tesseract worker is pooled instead of being
created and destroyed per request; the ONNX embedding session and the corpus
are built at boot instead of inside the first user's request; and `/health` no
longer loads the 1.3MB corpus in order to fill in three fields.

**The prior diagnosis was wrong, and the measurement is how I know.** The claim
on record was that per-request worker startup was "most of" a 21s OCR call.
`npm run bench:ocr` puts `createWorker` at 397ms against 2,361ms of
recognition — 14%, not most. Pooling still roughly halves the warm request,
because in a loaded server process the per-request child-process spawn and WASM
instantiation cost far more than they do in an isolated benchmark, but the
dominant cost is recognition itself and it remains so.

## Concurrency

```bash
cd back-end
taskset -c 0 node scripts/loadtest.js 8 1 2 3 4 6
```

One core, pool size 1, eight requests per level, distinct image each time:

| concurrency | ok | failed | p50 | p95 | req/s |
| --- | --- | --- | --- | --- | --- |
| 1 | 8 | 0 | 2,214 | 2,567 | 0.46 |
| 2 | 8 | 0 | 4,483 | 4,751 | 0.46 |
| 3 | 8 | 0 | 7,367 | 8,734 | 0.41 |
| 4 | 8 | 0 | 10,204 | 13,904 | 0.37 |
| 6 | 5 | 3 × `OCR_BUSY` | 12,107 | 17,656 | 0.45 |

**Throughput is flat at roughly 0.45 requests per second no matter how many
people ask at once, and latency rises linearly with concurrency.** That is the
correct shape for CPU-bound work on one core and it is the honest limit of this
deployment: this app serves about one user at a time. At concurrency 6 the
queue bound starts refusing work with a typed 503 rather than accepting
requests it cannot finish before a browser gives up.

More workers does not help, which is why the pool defaults to one. Same
command, `OCR_POOL_SIZE` varied, p50 at concurrency 1 and the throughput range
across levels 1–4:

| pool size | p50 at concurrency 1 | req/s across 1–4 |
| --- | --- | --- |
| 1 | 2,214 | 0.37 – 0.46 |
| 2 | 4,021 | 0.17 – 0.35 |
| 3 | 8,701 | 0.12 – 0.24 |

## Limits and abuse

This API is unauthenticated by design — it is a demo anyone can try. That makes
every bound on it load-bearing, because the only thing standing between a
visitor and the owner's Groq quota is a rate limiter, and the only thing
standing between one upload and the container's single CPU is a pixel cap.

An independent review found that neither of those was actually holding. Both
were fixed, both are measured, and the measurements are reproducible:

**The rate limiter was fully bypassable.** `app.set("trust proxy", 1)` does not
verify that a proxy exists — it takes an entry from the client-supplied
`X-Forwarded-For` header as `req.ip`. This app publishes directly
(`docker-compose.yml` maps `5000:5000`; `front-end/nginx.conf` has no
`proxy_pass`), so there was no proxy overwriting that header. 300 requests from
one machine against a 20-per-15-minute budget:

| configuration | allowed | blocked |
| --- | --- | --- |
| `trust proxy: 1`, no header | 20 | 280 |
| `trust proxy: 1`, rotating `X-Forwarded-For` | **300** | **0** |
| `trust proxy: false` (now the default), rotating `X-Forwarded-For` | 20 | 280 |

`TRUST_PROXY` now defaults to none. **Set `TRUST_PROXY=1` when deploying behind
Render, Fly or any single proxy** — without it every visitor shares one bucket;
with it set wrongly there is no bucket at all. `express-rate-limit`'s own
validator does not catch this: it errors on `true` and says nothing about `1`.

**Bounding one dimension is not bounding the work.** The upload checks —
`express.json({ limit: "12mb" })` and an 8MB cap on the decoded buffer — bound
encoded *bytes*. Tesseract's cost tracks *pixels*, and `targetWidth()` returned
`Math.min(width, maxWidth)`, so a tall image was never downscaled at all.
`npm run bench:bounds`, one core, text-filled canvases:

| upload | wire | pixels | before | after |
| --- | --- | --- | --- | --- |
| 2000×1500 | 0.39MB | 3.0M | 2000×1500, 11.4s | unchanged |
| 2000×20000 | 5.46MB | 40.0M | **2000×20000, 126.2s** | downscaled into the 4M-pixel budget |
| 16383×16383 | 8.30MB | 268.4M | 2000×2000, 13.4s | refused before decode |

11.1× the cost of a normal label, from a file well inside the size allowance.

The square case is worth reading carefully, because the obvious explanation is
wrong: it is **not** stopped by sharp's default pixel limit. 16383² is
268,402,689 — that limit exactly — so it passes. What saved it was the width cap
downscaling it to 2000×2000. Bounding width happens to bound a square and does
nothing to a strip.

Three bounds now, at three levels: `limitInputPixels` stated explicitly rather
than inherited from a dependency default, `maxPixels` capping the area handed to
OCR, and a deadline on any single recognition after which the worker is
destroyed and rebuilt — because tesseract.js exposes no abort, so rejecting the
caller without killing the worker would free the bookkeeping and not the CPU.

**The pixel cap bounds the work to within about 2×, not exactly**, and finding
that out changed the deadline. Holding the pixel count at the 4M cap and varying
only the shape, on one core at load 3.97:

| canvas | megapixels | OCR | confidence |
| --- | --- | --- | --- |
| 2000×2000 | 4.0 | 12,989ms | 94 |
| 1265×3162 | 4.0 | **27,628ms** | 94 |
| 632×6325 | 4.0 | 19,665ms | 88 |
| 400×10000 | 4.0 | 17,461ms | 57 |
| 200×20000 | 4.0 | 19,429ms | 55 |

A 2.1× spread at identical pixel counts, and not monotonic in aspect ratio, so
no simple shape rule tightens it. The first deadline tried here was 30 seconds,
which that table rejects: it leaves a 1.09× margin over the worst legitimate
image the cap admits, so it would have fired on real uploads. It is 60 seconds,
about 2.2× the worst measured case.

The cost of the larger number is real and worth stating: one request can hold
the single OCR worker for a minute. What bounds that in aggregate is the rate
limiter — which is exactly why that had to be repaired first.

**Two more places where the caller chose how much work the server did.**
Ingredient parsing used a quadratic regex, synchronously, on OCR output —
32ms / 133ms / 600ms / 2666ms at 5k / 10k / 20k / 40k characters, blocking the
event loop for every other request. It is linear now, and the text is capped
before it runs. And the result cache had no `maxKeys`, while its keys are
content hashes of caller-supplied bytes; it is bounded, and evicts rather than
throwing when full.

All of it is in [DECISIONS.md](./DECISIONS.md) with the reasoning, and covered
by tests in `back-end/tests/`.

## What did not work

- **Downscaling the image before OCR.** `maxWidth: 1200` cut the sample from
  3,270ms to 2,024ms and turned `INS1422, INS415 ... INS211` into
  `NS1422 ... NS211`. Those identifiers are exactly what BM25 matches on, so it
  is not a speed-up, it is a broken retriever. Reverted.
  `npm run bench:preprocess`
- **Dropping `sharpen` or `normalise`.** Each saves 250–350ms of sharp time and
  each damages the extracted text on at least one of the three test subjects.
  Kept.
- **`png compressionLevel: 0`.** Byte-identical OCR output, and no time
  difference this machine can resolve. The *unchanged* configuration measured
  2,663ms, 3,345ms and 3,665ms of recognition on three runs of the same sweep,
  so an effect of a couple of hundred milliseconds cannot be distinguished from
  the machine. Not changed.

Nothing in `OCR_PREPROCESS` changed as a result of this work. The benchmark
that says why is committed.

## What the instrumentation costs

`npm run bench:telemetry`, 300 image-cache-hit requests per configuration, on
this machine (i5-9300H, WSL2, Node 24). That path on purpose: a full analysis is
~2.7s of which ~78% is Tesseract and which varies by more than a second between
identical warm requests, so no instrumentation cost is resolvable there. A cache
hit is ~1.5ms of server time inside a ~7ms round trip and still runs the whole
HTTP layer, the request span, the validate span and two metric records.

| configuration | p50 | p95 | mean |
| --- | --- | --- | --- |
| off (`OTEL_TRACES_EXPORTER=none OTEL_METRICS_EXPORTER=none`) | 6.831ms | 12.067ms | 7.188ms |
| console (the shipped default) | 7.033ms | 15.111ms | 7.731ms |
| console, 1s metric export interval | 7.147ms | 11.791ms | 7.382ms |

**+0.202ms at p50** against the uninstrumented floor.

Same-session `npm run profile 3 8`, telemetry off then on:

| | off | on (console) |
| --- | --- | --- |
| cold first request, total median | 2294.9ms | 2285.1ms |
| warm request, total median | 1986.1ms | 1790.0ms |
| boot to a healthy `/health` | 388–430ms | 424–483ms |

The request-path differences run the wrong way, which is the point: they are
this machine's variance, not the change. The only repeatable cost is boot,
roughly +40 to +50ms of SDK module loading, paid once — and `/health` answers
during warm-up by design, so it does not delay readiness.

---

## Not measured

**Citation validity, groundedness and abstention-after-generation are
implemented and unit-tested against fixtures, but have NOT been measured
against a live model, because no Groq API key was available.** `npm run eval`
covers everything up to the model call.

The harness that would measure the rest now exists:

```bash
cd back-end && GROQ_API_KEY=... npm run eval:generation
```

It has been run end to end against `scripts/stub-llm.js` — 58 questions, no key,
no network — which proves the code executes and that the five out-of-corpus
questions it sees are the same five `npm run eval` names. Those figures describe
the stub, not a model, and are recorded nowhere:
`rag/eval/generation-results.json` is gitignored so that a stub run cannot be
mistaken for a measured one.

**No generation numbers appear in this repository, and none are estimated.**
Run the command above with a key and you will have the first ones.
