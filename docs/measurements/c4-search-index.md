# C4 — the search-index workload measurement that closes D12

Reproduce with `pnpm bench:search-index` (requires `pnpm local:up && pnpm local:bootstrap`).
Raw figures: [`c4-search-index.json`](./c4-search-index.json). Harness:
[`scripts/workload/search-index.mjs`](../../scripts/workload/search-index.mjs), corpus generator
[`packages/evaluation/src/workload/population.ts`](../../packages/evaluation/src/workload/population.ts).

**Result: Meilisearch is confirmed. D12 closes on the numbers below**, not on inertia. See
`docs/decisions.md` D-002.

---

## What was measured, and why it is not only latency

D-002 asked for three latencies measured separately. It also named the condition that would
select OpenSearch: _"if the matcher needs custom analysers or multi-field boolean scoring that
Meilisearch cannot express."_ That is a statement about **capability**, and no latency figure
answers it. An index that is fast and cannot retrieve the right candidate is not the cheaper
option — it is the wrong one, and its symptom is the FI-10 symptom: a clean screening result.

So every latency below travels with a **recall@k broken down by FR-08 name form**. The two
together are what close the decision.

### The corpus

The FR-16 labelled corpus holds sixteen cases. Sixteen names is a correctness fixture, not a
workload: every index answers it instantly. So the FR-16 names are the **queries** — they were
chosen to be hard — and a generated population is the **haystack** they must be found in, at
1,000 / 10,000 / 100,000 subjects.

The haystack is not random names, which would make retrieval trivial. Around every target the
generator plants two exact collisions (different people, same name), a shared surname, a shared
given name, a phonetic neighbour and a one-edit neighbour. Finding the target is therefore a
discrimination problem, which is what real screening is.

105 queries per size, 10 repeats, k = 25 → **1,050 latency samples per strategy per size**.
Nearest-rank percentiles; p99 over 1,050 samples is the 1,040th observation, so treat p99 as
indicative and p95 as the figure to argue with.

### The three retrieval strategies

| Strategy     | What it does                                                                |
| :----------- | :-------------------------------------------------------------------------- |
| **naive**    | one query, the raw name as typed                                            |
| **expanded** | the FR-08 forms (folded, sorted core key, phonetic keys), one query each    |
| **batched**  | the same forms in one round trip, via `SearchIndexPort.searchSubjectsBatch` |

---

## Matcher latency (index retrieval + in-process comparison)

Milliseconds. `retrieval` is the index; `compare` is `matchAcrossScripts` over the returned
candidates; `matcher` is the two together.

| Population | Strategy | retrieval p50 | retrieval p95 | compare p95 | **matcher p95** | **recall** |
| ---------: | :------- | ------------: | ------------: | ----------: | --------------: | ---------: |
|      1,000 | naive    |          2.94 |          3.82 |        0.79 |        **4.53** |  **81.9%** |
|      1,000 | expanded |          7.60 |         11.27 |        1.37 |       **12.57** |  **96.2%** |
|      1,000 | batched  |          4.37 |          5.65 |        1.22 |        **6.76** |  **96.2%** |
|     10,000 | naive    |          2.87 |          3.82 |        0.67 |        **4.42** |  **81.9%** |
|     10,000 | expanded |          7.33 |          9.84 |        1.18 |       **10.79** |  **95.2%** |
|     10,000 | batched  |          4.61 |          6.16 |        1.22 |        **7.12** |  **95.2%** |
|    100,000 | naive    |          2.87 |          3.92 |        0.70 |        **4.33** |  **67.6%** |
|    100,000 | expanded |          7.76 |         10.62 |        1.08 |       **11.20** |  **95.2%** |
|    100,000 | batched  |          4.74 |          6.35 |        1.00 |        **7.05** |  **95.2%** |

**Retrieval latency is flat across two orders of magnitude.** Naive p95 moves 3.82 → 3.92ms
from a thousand subjects to a hundred thousand; batched moves 5.65 → 6.35ms. Meilisearch is not
the thing that will get slower as the population grows.

**Recall is not flat, and that is the finding.** Naive retrieval degrades with population —
81.9% → 67.6% — because the top _k_ fills with lookalikes before the right person is reached.
The expansion holds recall at 95.2% over the same range. Retrieving on the raw name is not a
simpler option that costs a little recall; it is an option that gets worse as the product
succeeds.

### Recall by FR-08 name form, at 100,000 subjects

| Form              | naive | expanded / batched |
| :---------------- | ----: | -----------------: |
| EXACT             |  100% |               100% |
| WORD_ORDER        |  100% |               100% |
| PARTICLE          |  6.3% |               100% |
| INITIAL_EXPANSION |  6.3% |              93.8% |
| DIACRITIC         |  100% |               100% |
| PHONETIC          |  100% |               100% |
| TYPO              |  100% |               100% |
| TRANSLITERATION   |    0% |                 0% |

Three things to read here:

1. **`INITIAL_EXPANSION` is 6.3% naive at every size.** Meilisearch cannot match "R. Mordaunt"
   to "Rhys Mordaunt" on its own, at any population. The expansion fixes it. This is not a
   scaling effect — it is a capability the index does not have and does not need to have,
   because the FR-08 forms supply it.
2. **`PARTICLE` collapses from 100% to 6.3% between 10,000 and 100,000 subjects, naive only.**
   The particle variant is still retrievable; it is simply outranked by lookalikes once there
   are enough of them. This is the clearest evidence that the naive strategy's recall is a
   function of corpus size, and the reason the batch method now exists.
3. **`TRANSLITERATION` is 0% for every strategy, and this is not attributable to the index.**
   The only `TransliterationPort` implementation in the codebase is `identityTransliteration`,
   which returns its input unchanged — so a Cyrillic or Arabic query is never expanded into the
   Latin forms the index holds. Nothing was measured about Meilisearch here. **D12 is closed on
   the seven forms that could be measured**, and the non-Latin path is a re-open trigger (see
   below).

---

## API acceptance latency

`POST /v1/subjects` and `POST /v1/searches` over real loopback HTTP, against the real
`AppModule` and the real MongoDB, with one override (a local JWKS instead of a network fetch to
Keycloak). Measured against **both** index kinds, so the index's contribution is attributable
rather than merely present.

| Index kind  | `POST /v1/subjects` p50 |   p95 | `POST /v1/searches` p50 |        p95 |
| :---------- | ----------------------: | ----: | ----------------------: | ---------: |
| in-memory   |                   10.13 | 14.93 |               **33.26** |  **39.31** |
| meilisearch |                    8.85 | 11.07 |              **127.04** | **153.17** |

**Roughly 94ms — about three quarters of search acceptance — is the request waiting for the
index write to become searchable.** `SearchesService.create` indexes the pinned subject version
after the commit, and `MeilisearchAdapter` waits for Meilisearch's task to succeed before
reporting the write as indexed (C3's rule 2). `POST /v1/subjects` is unaffected at ~9ms, which
confirms the attribution: the two endpoints differ in exactly that step.

This is **not** a Meilisearch problem — the index write itself is fast, and the wait is our
design choice. It is raised as open decision **D13**; C4 does not change it unilaterally,
because the alternative trades a correctness property (C3's rule 2) for latency and that is not
this step's call to make.

## Total search latency

Stated as a composition, not as an end-to-end observation, because the pipeline that would make
it one does not exist yet (Phase F). At 100,000 subjects, batched:

```
acceptance p50 127.04ms  +  matcher p50 5.23ms  ≈  132ms
```

The matcher is **4%** of it. Whatever is worth optimising in the search path, it is not the
index.

## Index write throughput

100,000 subjects in 5.0s (≈20,000/s), 10,000 in 0.4s, 1,000 in 0.16s, each including the wait
for the documents to become searchable. A full tenant rebuild is not an operation that needs
planning around at this scale.

---

## The decision

D-002's switch condition was specific: OpenSearch if the matcher needs custom analysers or
multi-field boolean scoring **that Meilisearch cannot express**. The measurement establishes
that the matcher does need multi-field retrieval — naive retrieval loses a third of its recall
at 100,000 subjects — and that **Meilisearch expresses it**, in one round trip, at 6.35ms p95,
flat across two orders of magnitude, at 95.2% recall.

The condition for switching was tested and not met. **Meilisearch is confirmed; D12 is closed.**
No `OpenSearchAdapter` is written, and `SEARCH_INDEX_KIND=opensearch` continues to throw a clear
not-implemented error rather than silently doing nothing.

### What this measurement does not establish

Recorded so that a later session can see what it would have to re-measure rather than assuming
this closed everything:

- **Scale stops at 100,000 subjects.** Flat from 1,000 to 100,000 is good evidence and is not
  evidence about 10 million.
- **No concurrency or throughput test.** Every figure is a single-client latency. Meilisearch
  answered 32 concurrent searches in the same wall time as one during diagnosis, which is
  encouraging and is not a load test.
- **One developer machine** (Windows, 12 logical CPUs, seven containers sharing them). The
  ranking of the three strategies is robust; the absolute milliseconds are not portable.
- **The `documents` index is untested.** Nothing extracts document text yet — Phase F owns
  supplying `title` and `text`. Corpus search may have a different profile from name matching,
  and it is the FR-05 rung-0 path.
- **The non-Latin path is unmeasured**, per `TRANSLITERATION` above.

### What would re-open D12

1. A real `TransliterationPort` lands and non-Latin recall through Meilisearch is poor — this is
   the likeliest re-open, and the most consequential, since it is the case FR-08 exists for.
2. The `documents` index, once it holds real text, needs analysers or field boosting Meilisearch
   cannot express.
3. A population beyond ~10⁶ subjects, or a concurrency test, shows degradation the flat curve
   above does not predict.

---

## Two defects the measurement found

Recorded here because neither was visible without running the thing.

### A flat ~45ms stall on every gzip response through the Docker Desktop port proxy

The first run put Meilisearch retrieval at **47ms p50** — a figure that would have been recorded
as evidence and would have made the index look like the bottleneck it is not. It was not query
work:

- `/health` answered in 1.8ms while every search took ~45ms;
- 32 concurrent searches finished in the same wall time as one, so it was a wait, not work;
- the stall appeared between 967 and 1,256 bytes of response body, 25/25 deterministic;
- the same query from **inside** the Docker network took **2.2ms**;
- and `Accept-Encoding: identity` removed it entirely (48.06ms → 3.20ms, 0/20 slow).

So: gzip-encoded responses above roughly one TCP segment stall ~45ms crossing the Docker Desktop
port proxy. Node's `fetch` requests gzip by default, so **every** call from `MeilisearchAdapter`
paid it. The adapter now sends `Accept-Encoding: identity`, which is right on its own merits —
this is a service-to-service hop carrying small JSON, where compression costs CPU on both ends
and saves nothing. Matcher p95 went from 52.76ms to 4.38ms on the same query set.

The stall is the proxy's, not Meilisearch's, and would not appear on a Linux host. Every
developer running the local stack on Windows or macOS was paying it on every search.

### A batched sweep over shared state, asserted in one pass — for the second time

Adding these measurements pushed the outbox backlog past `OutboxPublisher`'s batch size of 50,
and three tests in `tests/integration/transactions.test.ts` began failing intermittently.
`publishOnce` sweeps the outbox **globally**, so with integration files running in parallel a
single pass need not reach the event under test — and `queue.failNextPublish` could be absorbed
by another file's event entirely.

Fixed with a bounded drain, and verified by planting 300 due events: the old tests fail 4 of 14,
the fixed ones pass. This is the **same trap the C3 reconciler hit**, in a second place. The
rule is now written down in both: _a batched sweep over shared state needs a bounded drain,
never a single call._
