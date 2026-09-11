# Phase D — Sources, association graph and taxonomy administration

**Gate:** G5 · **Status:** outline — expand before starting · **Prerequisite:** Phase C

> **Outline, not a brief.** Expand at the start of the phase.

## Goal

The source registry with four-eyes approval, the sourced association graph, and runtime
taxonomy administration — all versioned, all pinned to the searches that used them.

## Scope

| Step | Deliverable                                                                                 |
| :--- | :------------------------------------------------------------------------------------------ |
| D1   | Versioned source, taxonomy and policy approval; proposer must differ from approver          |
| D2   | Free registry adapters plus deterministic mock counterparts for every port                  |
| D3   | Sourced identity and edge resolution, tenure labelling, frozen graph snapshots              |
| D4   | One-hop bounds, unresolved candidates, person-only degraded execution                       |
| D5   | Source health: reliability profile, breaker state, kill switch including mid-run suspension |
| D6   | Wire the existing lexicon audit into taxonomy **activation**, not only CI                   |

## Already built

`packages/domain/src/tenure/tenure.ts` implements all five tenure labels and
`isConfirmedCurrent`, tested against T15. This phase feeds it real registry dates.

`packages/domain/src/taxonomy/lexicon-audit.ts` implements the T79 audit and is already wired
into CI. D6 wires it into the activation path so a runtime taxonomy edit cannot bypass it.

## The part that is easy to get wrong

An unresolved officer must not attach companies automatically. If registry access fails, person
searching continues and association coverage reports as **incomplete** — no result from a
registry never proves no associations exist.

Default policy is current confirmed directorships only. An unknown end date does not make a
directorship current.

Runtime source administration selects reviewed connector types and validated domain
configuration. It must never allow arbitrary executable code, SQL or JavaScript snippets,
unrestricted fetch URLs or unapproved model endpoints.

## Exit evidence

T14, T15, T20, T36, T45 and T79 pass. No unsupported company association is automatically
searched, graph limitations are visible, and a disabled category is never queried.

## Decisions to close

**None.** This section previously named D1 (jurisdictions and languages), D3 (categories on by
default) and D8 (retention per source and jurisdiction). All three closed on 2026-09-11 — see
`docs/decisions.md` D-010, D-009 and D-012 — and the outline was not updated at the time. It is
corrected here rather than left to mislead: a phase brief that sends someone to reopen a settled
decision costs a session.

What this phase must do instead is **honour them**, which is a different job and an easy one to
skip:

- **D-010** — Costa Rica, with es and en _requested_ but **not enabled**, because FR-03 forbids
  enabling a language with no measured recall figure. The registry and taxonomy this phase builds
  must keep that distinction visible, not flatten it into "es and en are on".
- **D-009** — all seventeen categories on by default. D6 (this phase) wires the lexicon audit into
  the **activation** path so a runtime taxonomy edit cannot introduce a protected characteristic
  that CI would have caught.
- **D-012** — retention is configurable per policy version, defaulting to 30 days, with a legal
  hold that overrides it. Phase C built the deletion machinery; this phase gives it the per-source
  and per-jurisdiction values that make it meaningful.

**The one to raise early: D6** — how robots exceptions for official sources are approved and
recorded. It is due at G6 (Phase E), but it is shaped by the source registry built here, and it
needs a source admin rather than an engineer. Raising it at the start of Phase E is raising it too
late to influence the record it has to live in.
