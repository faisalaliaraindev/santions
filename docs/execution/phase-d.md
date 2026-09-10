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

**D1** jurisdictions and languages enabled first · **D3** categories on by default · **D8**
retention per source and jurisdiction.

All three need people outside engineering. Raise them before the phase starts, not at its exit.
