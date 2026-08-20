# Retrieval corpus: sources, licence and obligations

## What is in it

`rag/corpus/` holds a derived database built from three Open Food Facts
taxonomies. It is committed so the app runs, and the evaluation reproduces,
without a network call.

| File | Contents |
| --- | --- |
| `chunks.json` | The passages: id, title, aliases, text, and the source record for each |
| `embeddings.f32` | `chunks × 384` float32, row-major, L2-normalised |
| `meta.json` | Embedding model, dimensions, chunk budget, counts, source URLs, build date |

Counts and the build date are in `meta.json`; `npm run ingest` regenerates all
three from the live taxonomies.

## Sources

- `https://static.openfoodfacts.org/data/taxonomies/additives.json`
- `https://static.openfoodfacts.org/data/taxonomies/additives_classes.json`
- `https://static.openfoodfacts.org/data/taxonomies/allergens.json`

## Licence and what it requires

Open Food Facts data is published under the **Open Database License (ODbL)
v1.0**. Two obligations follow, and both are met here rather than mentioned:

**Attribution.** Every passage in `chunks.json` carries a `source` record
naming the dataset, the taxonomy entry it came from, the licence, and a URL.
Those records are returned by the API in each verdict's `sources` array and
rendered under every verdict in the UI, so attribution travels with the data
instead of sitting only in a footer.

**Share-alike.** `rag/corpus/` is a *Derived Database* in ODbL terms. Publicly
using a derived database triggers the obligation to offer it under ODbL. So:

> **The contents of `back-end/rag/corpus/` are licensed under ODbL v1.0**, not
> under this repository's MIT licence. The MIT licence covers the source code.
> Contains information from Open Food Facts, which is made available under the
> Open Database License: https://opendatacommons.org/licenses/odbl/1-0/

Individual contents of the database are available under the Database Contents
License: https://opendatacommons.org/licenses/dbcl/1-0/

## What the corpus does and does not cover

It covers **regulated food additives** (E numbers, their additive class, EFSA
evaluation notes where the taxonomy carries them), **additive classes**
(what a preservative or an emulsifier does), and the **allergen list**.

It does **not** cover whole foods. There is no passage about water, sugar,
tomato paste or tamarind, which is why those ingredients come back as
uncovered rather than as verdicts. Nothing about nutrition, calories,
portion sizes, or medical advice is in scope either.

## Rebuilding

```bash
cd back-end
npm run ingest             # fetches the taxonomies and rebuilds all three files
npm run ingest -- --offline  # rebuilds from the cached taxonomy snapshot
npm run eval               # re-measures retrieval against the new corpus
```

Ingestion is deterministic: entries are processed in sorted key order, so an
unchanged upstream taxonomy produces a byte-identical corpus and an empty git
diff. Re-run `npm run eval` after any rebuild — the abstention thresholds in
`rag/retriever.js` were chosen from the measured score distribution and are
only valid for the corpus they were measured on.
