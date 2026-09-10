# Phase C — Persistence, jobs, index and object storage

**Gate:** G4 · **Status:** outline — expand before starting · **Prerequisite:** Phase B

> **This is an outline, not a brief.** Expand it into a full brief (in the shape of
> `phase-a.md`) at the start of the phase, once Phase B's actual schemas and auth boundary
> exist. Writing the detail now would harden guesses about records that do not exist yet.

## Goal

Durable state that survives crashes and redelivery without duplicating committed work, and the
search index the FR-08 matcher needs.

## Scope

| Step | Deliverable                                                                                        |
| :--- | :------------------------------------------------------------------------------------------------- |
| C1   | The section 6.3 record schemas, migrations and indexes, with tenant context leading every key      |
| C2   | Transactions and the outbox: state, audit reference and outbox events commit together              |
| C3   | Search index: name-matching indexes, corpus index, reconciliation with MongoDB as system of record |
| C4   | **The matcher-latency workload test** — the measurement that settles D12                           |
| C5   | S3 staging, checksum verification, reference commit, orphan reconciliation                         |
| C6   | Retry classification, DLQ, lease fencing, cancellation, duplicate-delivery handling                |

## The part that is easy to get wrong

S3, search-index and queue publication are **not** inside the MongoDB transaction. The order
is: stage the upload, verify the checksum, commit the reference, then publish through the
outbox — and reconcile orphaned objects, unindexed documents and undelivered events. A
successful evidence reference must never point at a missing object.

Expiring a deduplication receipt must not let a late message repeat a committed business
effect. Persisted run and stage identity is the final guard, not the receipt.

## Exit evidence

T22 to T24, T29 to T31, and T41 pass under injected failure: no duplicate committed work, no
lost terminal events, no unindexed committed documents, no successful reference to absent
evidence. Restart verified at every persistence and publication boundary.

## Decision to close

**D12 — search index choice.** Closed by C4's measurement and recorded in `docs/decisions.md`
with the numbers, not as a preference. Measure matcher latency separately from API acceptance
latency and from total search latency, over the FR-16 corpus with the FR-08 name-form
expansions. Meilisearch is the current working assumption; OpenSearch is the likelier answer if
the matcher needs custom analysers or multi-field boolean scoring.

## Expanding this brief involves

Listing the section 6.3 records against what Phase B actually built; deciding the index and
outbox collection shapes; and writing the failure-injection matrix for C6 before writing C6.
