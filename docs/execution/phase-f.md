# Phase F — Extraction, classification and the full pipeline

**Gate:** G7 · **Status:** **brief — expanded 2026-09-15** · **Prerequisite:** Phase E

> Expanded from the outline at the start of the phase, as the phase map requires. The outline's
> step table (F1–F7) is unchanged and still correct. What is added is the **execution order**,
> which differs from the numbering, the **two blockers found while expanding it**, and the exact
> files involved. The original outline is preserved verbatim in section 8.

---

## 1. Goal

Turn fetched documents into validated assertions, and run the G2 domain core against real
extraction output rather than fixtures.

Today `SearchPipelineService` calls `MockExtractionModel`, which is rule-based and keyword-driven.
It is honest about being so — `modelId` and `promptVersion` are null on every assertion it emits —
but it only ever finds what its keyword table already knows, so the pipeline has never been run
against extraction it could be surprised by.

---

## 2. Read this before writing code

1. This brief.
2. `apps/api/src/sources/extraction-model.port.ts` — **read the header comment in full.** It is
   the contract, and it already decided three things this phase must not re-open: spans rather
   than restatements, model id and prompt version pinned as _required_ fields, and
   `validationResult` deliberately absent so a model cannot self-certify.
3. `apps/api/src/sources/mock/extraction-model.mock.ts` (217 lines) — the behaviour any real
   adapter has to match, including the two properties its header calls out.
4. `docs/open-decisions.md` — **D7** and **D9**, both due at this gate.
5. `CODEX_ADVERSE_SEARCH_IMPLEMENTATION_GOAL (3).md` — FR-07 only. Do not read the file end to
   end; it is ~102KB and this phase needs one section.

---

## 3. Two blockers found while expanding this brief

Both were found by reading the code, and both would otherwise be discovered several hours into
the phase with work already built on the wrong assumption.

### 3.1 D7 says "benchmarked on the labelled set". The labelled set has no document text.

`packages/evaluation/src/dataset/seed.ts` holds 16 labelled cases. Each carries document
**metadata** — `documentId`, `tier`, `issuingAuthorityId` — and a `scenario` object holding the
**axis inputs** a pipeline would produce. It carries **no document bodies**.

That is correct for what the set was built for: D-005 made it the seam that lets `runAllInvariants`
run against real pipeline output at F4 without changing the harness. But it means **D7 cannot be
executed as written.** You cannot compare two extraction models on a corpus with nothing to
extract from.

So F2 has a prerequisite nobody has scheduled: **a labelled extraction corpus** — documents with
known correct assertions and known correct spans. Decide deliberately, and record it, between:

- **(a) Extend the 16 seed cases with bodies.** Keeps one dataset. Every body is written by us,
  so it is synthetic and will flatter any extractor that reads the way we write.
- **(b) A separate extraction corpus from fetched fixture documents**, labelled by hand. Realistic
  text. Smaller, slower to build, and the held-out split has to be kept genuinely held out.
- **(c) Defer D7 and ship the rule-based extractor**, recording that no model was benchmarked.
  Honest, and it leaves the pipeline exactly as blind as it is now.

**Do not start F2 before this is settled**, because the benchmark's shape determines the adapter's
test surface. The recommendation is **(b)**, with the fetch fixtures already in
`evidence-fetch.mock.ts` as the seed corpus — they were written to be awkward, which is the
property that matters. But it is a real decision and it belongs in `docs/decisions.md`.

### 3.2 The pipeline passes raw HTML to the extractor and calls it normalised text.

`apps/api/src/pipeline/search-pipeline.service.ts` (the extraction call site, ~line 665):

```ts
const text = new TextDecoder().decode(fetched.data.body);
```

Two separate defects in one line.

**No normalisation.** `ExtractionInput.text` is documented as "Normalised text, with the offset
mapping back to the original held by the caller." There is no normalisation and the caller holds
no mapping. Spans therefore point into **raw HTML**, so every offset a reviewer is shown, and
every offset the FR-07 validator checks, is an offset into markup. This has not surfaced because
the fetch fixtures are effectively plain text. The first real HTML page breaks it.

**No charset handling.** `TextDecoder()` defaults to UTF-8 and ignores the declared charset. A
Spanish-language page served as ISO-8859-1 — which is not rare on Latin American news sites —
decodes to mojibake, and the name-form matching silently stops matching. This is the same failure
class as the `María` → `Mar?a` shell issue noted in `postman/README.md`, and it produces the same
symptom: a clean `NO_MATCHES_FOUND` that looks like an absence of news.

**This is F1, and F1 must therefore come first** — before any model work. See the order below.

---

## 4. Execution order

The numbering is F1–F7. The order to work them is **F1 → F3 → F2 → F4 → F5 → F6 → F7**, and the
swap of F3 ahead of F2 is deliberate.

| #   | Step                                                                    | Why here                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| :-- | :---------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **F1** normalisation, charset, PDF, OCR; the four date fields           | Everything downstream indexes into its output. Doing it after F2 means re-labelling every span in the benchmark corpus.                                                                                                                                                                                                                                                                                                                                              |
| 2   | **F3** the eight FR-07 validation rules                                 | **Build the validator before the model.** The rules are what make a model's output checkable, and writing them second means writing them against whatever the model happened to produce. Written first, they are the model's acceptance criteria. Note: **no FR-07 validation module exists anywhere in the repo today** — `grep validateAssertion` returns nothing. This is a from-scratch step, not a wiring step. It belongs in `packages/domain` (pure, no I/O). |
| 3   | **F2** `ExtractionModelPort` against a locally served open-weight model | Blocked on 3.1 above. Closes **D7**.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 4   | **F4** wire the G2 core to real assertions                              | The checkpoint below.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 5   | **F5** FR-12 duplicate layers, event split and merge                    | Needs real assertions to have anything to deduplicate.                                                                                                                                                                                                                                                                                                                                                                                                               |
| 6   | **F6** prompt-injection tests                                           | Needs a model; meaningless against the rule-based mock, which cannot be instructed.                                                                                                                                                                                                                                                                                                                                                                                  |
| 7   | **F7** full evaluation run, FR-16 metrics on the held-out split         | Closes the gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**FR-10 clustering is not in this list and is still the largest gap in the pipeline** — a
syndicated copy still counts as a second independent source on axis D. It sits in F5. If Phase F
is going to be split across sessions, clustering is the highest-value thing to pull forward,
because it changes bands that are being produced _today_.

---

## 5. The most important checkpoint in the whole plan

**I1 to I10 must pass against real pipeline output, not only the G2 fixtures.**

This is checkable rather than assertable because the harness is the same code. The G2 seed dataset
carries `scenario` objects holding the axis inputs a pipeline would produce (D-005). At F4, real
extraction produces those same axis-input shapes, the same labels apply, and `runAllInvariants`
runs unchanged.

**If making that work requires modifying the harness, something is wrong with the pipeline, not
the harness.** This is rule 1 in `CLAUDE.md` and it is the rule most likely to be under pressure
during this phase specifically.

---

## 6. The parts that are easy to get wrong

**Entity grounding is the most dangerous hallucination class.** Every named entity in an assertion
must appear in the document. A model that invents a co-defendant produces a finding about a person
who was never mentioned. The span requirement is the defence: an entity with no span is not an
entity, and the validator rejects it rather than trusting it.

**Model self-reported confidence is discarded and never shown to a reviewer.** D9's default is no,
and `isDisplayableProbability` in `packages/domain/src/banding/finding-attributes.ts` already
enforces it — a number reaches a surface only inside a `CalibratedProbability` naming its
calibration scope, rule version, evaluation run and held-out sample size. Do not add a second
path.

**Model output is untrusted.** Never interpolated into commands, HTML, queries or fetch
destinations. Document content is data; instructions inside a document are ignored and logged as a
security event. The same rule the discovery layer already follows: `buildEndpoint` in
`apps/api/src/sources/discovery/endpoint.ts` sets a query as one search parameter via `URL` rather
than splicing a string, and D-046 records why that rule lives in exactly one place.

**A missing date stays null.** Never backfilled with retrieval time. FR-07, and the same rule
`leadsFrom` already follows in discovery.

**The extraction model receives cleaned text, a schema and bounded context.** No tools, no
credentials, no network, no authority to modify policy, scope or thresholds.

**The relevance filter's rule applies here too** (D-047): extraction decides what a document
_says_, not whether the subject is guilty. An extractor that only emits assertions when it finds
adverse conduct would make the service better at confirming suspicions than at testing them — the
acquittal has to come through the pipeline as readily as the accusation.

---

## 7. Exit evidence

- Hard-negative cases do not become confirmed matches.
- T32 to T35, T82 and T83 pass.
- Corrections and company attribution survive grouping and refresh.
- I1–I10 pass against real pipeline output (section 5).
- All FR-16 metrics recorded on the held-out split.

**Decisions to close at G7:** **D4** the boundary between adverse media and list matching ·
**D5** the reviewer capacity assumption · **D7** which open-weight model · **D9** whether numeric
confidence is ever shown.

**D4 has a waiting input:** the client has shared two Costa Rican sanctions spreadsheets. Those
are **list matching, not adverse media**, which is exactly what D4 is about. No file paths have
been supplied yet. Do not fold them into the adverse-media pipeline to make them work.

---

## 8. The original outline, preserved

> **Goal.** Turn fetched documents into validated assertions, and run the G2 domain core against
> real extraction output rather than fixtures.
>
> | Step | Deliverable                                                                                        |
> | :--- | :------------------------------------------------------------------------------------------------- |
> | F1   | Deterministic parsing, PDF and OCR; the four date fields with declared precision, never backfilled |
> | F2   | `ExtractionModelPort` against a locally served open-weight model, plus the synthetic adapter       |
> | F3   | All eight FR-07 validation rules, each proven to reject its own failure case                       |
> | F4   | Wire the G2 core to real assertions: four axes, roles, stages, tenure, clustering, banding         |
> | F5   | Every FR-12 duplicate layer, plus reviewed event split and merge with preserved history            |
> | F6   | Prompt-injection tests using fetched fixture documents that try to change policy or fetch URLs     |
> | F7   | Full evaluation run; all FR-16 metrics recorded on the held-out split                              |

---

## 9. Checklist

- [ ] **F1** Normalisation with an offset map; charset from the declared encoding; PDF; OCR; the
      four date fields with declared precision
- [ ] **F3** The eight FR-07 validation rules in `packages/domain`, each with a test proving it
      rejects its own failure case
- [ ] **3.1 settled and recorded** — what the extraction benchmark corpus is
- [ ] **F2** The real `ExtractionModelPort` adapter; **D7 closed**
- [ ] **F4** G2 core wired to real assertions; I1–I10 green against real pipeline output
- [ ] **F5** FR-12 duplicate layers; **FR-10 clustering wired**; split and merge with history
- [ ] **F6** Prompt-injection tests from fetched fixture documents
- [ ] **F7** Full evaluation run; FR-16 metrics on the held-out split
- [ ] **D9** closed
- [ ] Gate G7 moved in `docs/implementation-status.md`
