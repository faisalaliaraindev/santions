# Implementation status

Honest status against the eleven gates. A gate is complete only when linked executable
evidence exists — a command another engineer can run and a result they can read.

**Last updated:** 2026-09-10

## Readiness labels

The plan requires these three to be reported separately (section 1.3).

| Label                | Status                                                             | Evidence                                                                                      |
| :------------------- | :----------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| Local verified       | **Not yet** — G0-G2 complete, G1 infrastructure partially stood up | `pnpm test:invariants`, `pnpm test:unit`, `pnpm test:evaluation` all pass on a clean checkout |
| Live source verified | **Not started** — no live source has been contacted                | None. No live call has been made.                                                             |
| Production approved  | **Not started**                                                    | None.                                                                                         |

## Gate status

| Gate                                                        | Status          | Notes                                                                                                                                                                                                                         |
| :---------------------------------------------------------- | :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0 — Discovery and decisions                                | **Complete**    | `docs/decisions.md`, `docs/open-decisions.md`, this file, `docs/architecture.md`, `docs/requirements-traceability.md`                                                                                                         |
| G1 — Reproducible local foundation                          | **Partial**     | Workspace, TypeScript strict, lint, test projects and CI baseline done. Compose stack scaffolded but **not yet verified end to end**; `local:bootstrap` and `dev` are unimplemented and exit non-zero rather than pretending. |
| G2 — Domain core and evaluation harness                     | **Complete**    | See below.                                                                                                                                                                                                                    |
| G3 — Identity, tenancy and API contract                     | **Not started** |                                                                                                                                                                                                                               |
| G4 — Persistence, jobs, index and object storage            | **Not started** |                                                                                                                                                                                                                               |
| G5 — Sources, association graph and taxonomy administration | **Not started** |                                                                                                                                                                                                                               |
| G6 — Query planning, discovery cascade and fetch            | **Partial**     | The pure planning rules (eight families, bounding, drop order) are implemented and tested in `packages/domain/src/planning`. No cascade, no fetch, no egress.                                                                 |
| G7 — Extraction, classification, clustering and banding     | **Partial**     | The pure classification, clustering and banding rules are implemented and tested. No extraction, no model, no real assertions.                                                                                                |
| G8 — React control panel                                    | **Not started** |                                                                                                                                                                                                                               |
| G9 — Zquence contract and external-client proof             | **Not started** |                                                                                                                                                                                                                               |
| G10 — Live free-source verification                         | **Not started** |                                                                                                                                                                                                                               |
| G11 — Hardening, production verification and handoff        | **Not started** |                                                                                                                                                                                                                               |

## G2 — what is actually built and verified

Exit condition: _"I1-I10 execute and pass against the seeded dataset, with no I/O, no
database and no network. Metrics report on the held-out split."_ — **met**.

```
pnpm install --frozen-lockfile
pnpm lint          # clean
pnpm typecheck     # clean
pnpm test:unit         # 165 passed
pnpm test:invariants   #  29 passed  <- the I1-I10 release gate
pnpm test:evaluation   #  12 passed
```

Coverage over `packages/domain/src` and `packages/evaluation/src`: **92.95% statements,
90.65% branches** (gate: 85 / 80).

### Implemented in `packages/domain` (pure, no I/O)

| Area                                                               | Module                          | Requirement               |
| :----------------------------------------------------------------- | :------------------------------ | :------------------------ |
| Taxonomy, exclusions, protected-characteristic stems               | `taxonomy/categories.ts`        | FR-03                     |
| Versioned taxonomy records, language enablement by measured recall | `taxonomy/types.ts`             | FR-03, FR-16              |
| Build-gating lexicon audit                                         | `taxonomy/lexicon-audit.ts`     | FR-03, T79                |
| Procedural stage ladder 0-15 with mandatory display rules          | `stages/ladder.ts`              | FR-09                     |
| Stage transitions, span-supported resolution, outcome status       | `stages/transitions.ts`         | FR-09, T76, T77           |
| Party role taxonomy                                                | `roles/party-roles.ts`          | FR-09, T17                |
| Tenure labelling across all five values                            | `tenure/tenure.ts`              | FR-02, FR-09, T15         |
| Name normalisation, phonetic keys, form matching                   | `identity/name-forms.ts`        | FR-08, T13                |
| Transliteration port and cross-script matching                     | `identity/transliteration.ts`   | FR-08                     |
| Axis A — identity resolution, frequency prior                      | `identity/axis-a.ts`            | FR-08, FR-01, T11, T71    |
| Axis B — attribution, VIA_ROLE, COMPANY_ONLY                       | `attribution/axis-b.ts`         | FR-08, T73, T74           |
| Axis C — event classification                                      | `events/axis-c.ts`              | FR-08                     |
| Axis D — authority tiers and independence                          | `authority/axis-d.ts`           | FR-08, T26                |
| Banding rules engine                                               | `banding/bands.ts`              | FR-11                     |
| Finding attributes, calibrated-probability guard                   | `banding/finding-attributes.ts` | FR-11, I8, I9             |
| Clustering rules and event chains                                  | `clustering/rules.ts`           | FR-10, T25-T28            |
| Eight query families, bounding, declared drop order                | `planning/query-families.ts`    | FR-04, T78                |
| Result dimensions, aggregation, no-match statement                 | `coverage/result-state.ts`      | 6.2, FR-13, T21, T47, T88 |

### Implemented in `packages/evaluation` (pure, no I/O)

| Area                                                               | Module                                    | Requirement  |
| :----------------------------------------------------------------- | :---------------------------------------- | :----------- |
| Labelled dataset types and runnable scenarios                      | `dataset/types.ts`, `dataset/scenario.ts` | FR-16        |
| Split by entity **and** syndication family, with leakage assertion | `dataset/split.ts`                        | FR-16        |
| 16-case seed corpus, hard-negative heavy                           | `dataset/seed.ts`                         | FR-16, G2    |
| I1-I10 invariant harness                                           | `invariants/harness.ts`                   | FR-11, FR-16 |
| FR-16 metrics, victim/witness measured separately                  | `metrics/metrics.ts`                      | FR-16        |

## Defects found and fixed during G2

Recorded because they are the kind that stay hidden until they cause a wrong result.

1. **Lexicon audit could be evaded by hyphenation.** `Trans-gender` folded to `trans gender`
   and did not match the stem `transgender`, so a protected characteristic could have reached
   an outbound query. Fixed by also comparing separator-free forms
   (`taxonomy/lexicon-audit.ts`). Regression test in place.

2. **Fixed event-date buckets split events across boundaries.** Two reports of one event
   dated six days apart landed in different 30-day buckets and were never compared, silently
   splitting the event and under-counting independence — which feeds Axis D and therefore the
   band. Fixed by treating the bucket as a blocking hint only and comparing real dates
   (`clustering/rules.ts`, decision D-006). Regression tests in place.

3. **A `VIA_ROLE` finding did not explain its ceiling.** The band was correct (SUPPORTED) but
   the rationale did not tell the reviewer that a `VIA_ROLE` attribution can _never_ reach
   CORROBORATED. Fixed so the ceiling and the inference statement are always stated
   (`banding/bands.ts`).

## Known gaps and unverified assumptions

- **The compose stack has not been brought up and verified.** `pnpm local:up` exists but the
  G1 exit condition ("clean checkout starts without undocumented manual database edits") is
  not yet demonstrated.
- **No live source has been contacted.** Every source contract in the plan is unverified
  against a real endpoint. The G10 measurements do not exist and `docs/coverage-matrix.md`
  is a template with no measured figures.
- **No language is enabled.** Per FR-03 a language is enabled only with a measured recall
  figure, and none has been measured. The seed dataset spans several languages but that is a
  fixture corpus, not a measurement.
- **The extraction model is not chosen** (open decision D7) and no model has been benchmarked.
- **The search index is not chosen** (open decision D12); local compose carries a working
  assumption that the G4 workload test may overturn.
- **`pnpm test:e2e`, `test:integration`, `test:security` and `test:load` have no
  implementations.** They exit non-zero rather than passing vacuously.
