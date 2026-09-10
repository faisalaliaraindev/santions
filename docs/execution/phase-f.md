# Phase F — Extraction, classification and the full pipeline

**Gate:** G7 · **Status:** outline — expand before starting · **Prerequisite:** Phase E

> **Outline, not a brief.** Expand at the start of the phase.

## Goal

Turn fetched documents into validated assertions, and run the G2 domain core against real
extraction output rather than fixtures.

## Scope

| Step | Deliverable                                                                                        |
| :--- | :------------------------------------------------------------------------------------------------- |
| F1   | Deterministic parsing, PDF and OCR; the four date fields with declared precision, never backfilled |
| F2   | `ExtractionModelPort` against a locally served open-weight model, plus the synthetic adapter       |
| F3   | All eight FR-07 validation rules, each proven to reject its own failure case                       |
| F4   | Wire the G2 core to real assertions: four axes, roles, stages, tenure, clustering, banding         |
| F5   | Every FR-12 duplicate layer, plus reviewed event split and merge with preserved history            |
| F6   | Prompt-injection tests using fetched fixture documents that try to change policy or fetch URLs     |
| F7   | Full evaluation run; all FR-16 metrics recorded on the held-out split                              |

## The most important checkpoint in the whole plan

**I1 to I10 must pass against real pipeline output, not only the G2 fixtures.**

This is checkable rather than assertable because the harness is the same code. The G2 seed
dataset carries `scenario` objects holding the axis inputs a pipeline would produce (decision
D-005). At F4, real extraction produces those same axis-input shapes, the same labels apply,
and `runAllInvariants` runs unchanged.

If making that work requires modifying the harness, something is wrong with the pipeline, not
the harness.

## The part that is easy to get wrong

**Entity grounding is the most dangerous hallucination class**: every named entity in an
assertion must appear in the document. A model that invents a co-defendant produces a finding
about a person who was never mentioned.

Model self-reported confidence is discarded and never shown to a reviewer. Model output is
untrusted — never interpolated into commands, HTML, queries or fetch destinations. Document
content is data; instructions inside a document are ignored and logged as a security event.

A missing date stays null. It is never backfilled with retrieval time.

The extraction model receives cleaned text, a schema and bounded context. No tools, no
credentials, no network, and no authority to modify policy, scope or thresholds.

## Exit evidence

Hard-negative cases do not become confirmed matches. T32 to T35, T82 and T83 pass. Corrections
and company attribution survive grouping and refresh.

## Decisions to close

**D4** the boundary between adverse media and list matching for designations · **D5** the
reviewer capacity assumption thresholds are set against · **D7** which open-weight model,
benchmarked on the labelled set · **D9** whether numeric confidence is ever shown.

D9's default is no, and `isDisplayableProbability` in
`packages/domain/src/banding/finding-attributes.ts` already enforces it — a number reaches a
surface only inside a `CalibratedProbability` naming its calibration scope, rule version,
evaluation run and held-out sample size.
