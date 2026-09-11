# Phase C — Persistence, jobs, index and object storage

**Gate:** G4 · **Status:** IN PROGRESS — C0 and C1 done, C2 next · **Prerequisite:** Phase B complete (it is)

---

## Goal

Durable state that survives a crash and a redelivery **without duplicating committed work**, and
the search index the FR-08 matcher needs.

Phase B can accept a search and explain who was allowed to ask for it. Nothing yet executes one,
and nothing yet survives being interrupted halfway. This phase is where "we recorded that" stops
being a single `insertOne` and becomes a claim that holds when the process dies between two
writes.

## Why this before sources

Phase D brings in real source adapters, and Phase E the cascade that fetches. Both produce
partial work by nature: a run that fetched four of nine sources, a document staged to S3 whose
database reference never committed, a queue message delivered twice because the worker crashed
after the external call but before the acknowledgement. If the persistence and job semantics are
not settled first, every one of those becomes a bug discovered through corrupted data rather
than a case handled by design — and the corrupted data will be a screening result someone acted
on.

The order also matters for D12. The index decision is settled by a measurement over a realistic
corpus (C4). Doing that before the record schemas exist would measure a guess.

## Read before starting

Narrow list. **Do not read the source specification end to end.**

| What                                           | Why                                                                   |
| :--------------------------------------------- | :-------------------------------------------------------------------- |
| `docs/execution/handoff-log.md`                | The last three entries. Phase B found things that shape C1            |
| `apps/api/src/subjects/subjects.service.ts`    | The versioned-record pattern C1 generalises — read this one fully     |
| `apps/api/src/searches/searches.service.ts`    | `SearchRun` as it exists today, and the cursor index it depends on    |
| `apps/api/src/searches/idempotency.service.ts` | The claim/complete/release protocol C2 must not break                 |
| `apps/api/src/tenancy/entitlements.service.ts` | `pinVersions` — why every run carries the versions that explain it    |
| `packages/domain/src/access/permissions.ts`    | `decideAccess`. Repositories enforce the same boundary, not a new one |
| `docs/open-decisions.md` §D12                  | Why the index choice is open, and what closing it requires            |
| `infra/local/docker-compose.yml`               | Ports and service names for Meilisearch, LocalStack and Mongo         |

Spec sections, only for exact wording:
`CODEX_ADVERSE_SEARCH_IMPLEMENTATION_GOAL (3).md` §6.3 (required records — the paragraph after
the list is the load-bearing part), SEC-01, SEC-03, SEC-06, REL-01, REL-02, FR-06 (the failure
classification table), §8 G4, and tests T22–T24, T29–T31, T41 in §9.

---

## What already exists

Phase B created eleven collections. C1 extends this set; it does not restart it.

| Collection                  | §6.3 record                | State                                            |
| :-------------------------- | :------------------------- | :----------------------------------------------- |
| `tenants`                   | `Tenant`                   | Seeded, minimal                                  |
| `serviceCapabilities`       | `ServiceCapability`        | Seeded, one capability                           |
| `tenantEntitlementVersions` | `TenantEntitlementVersion` | Versioned, pinned to every run                   |
| `apiKeyCredentials`         | `ApiKeyCredential`         | Full lifecycle, hashed, audited                  |
| `apiKeyAuditEvents`         | (key-specific audit)       | Append-only in practice, **not yet enforced**    |
| `sessions`                  | (BFF session, not in §6.3) | Idle + absolute expiry, TTL index                |
| `subjectVersions`           | `SubjectVersion`           | Immutable versions, supersede-on-write           |
| `nameFrequencyProfiles`     | `NameFrequencyProfile`     | Shared, **not** tenant-owned                     |
| `searchRuns`                | `SearchRun`                | Created, never advanced; `revision` field unused |
| `idempotencyKeys`           | `InboxReceipt` (partly)    | Claim/complete/release, TTL expiry               |
| `taxonomyVersions`          | `TaxonomyVersion`          | Seeded v1, active                                |
| `policyVersions`            | `PolicyVersion`            | Seeded v1, active                                |
| `sourceVersions`            | `SourceVersion`            | Seeded, pointing at the fixture server           |

**Conventions to keep**, because breaking them silently is worse than either choice:

- Collection names are the §6.3 record name, camelCase, plural.
- Tenant-owned indexes lead with `tenantId`. Two deliberate exceptions exist and must stay
  documented: `apiKeyCredentials.keyId` (the presented credential carries no tenant, so the
  lookup cannot start with one) and `nameFrequencyProfiles` (population data is shared, and must
  never become tenant-owned, or a common Costa Rican surname is re-measured per customer).
- A version is immutable. An update writes a new version and supersedes the old one.
- Nothing trusts a tenant from a request. C2 extends that rule to queue envelopes.

---

## Steps

### C0 — Write the failure-injection matrix first

Before any of C2, C5 or C6. List every point where this phase writes to two systems, and what
must be true if the process dies between them. The matrix is the specification for the tests, and
writing it afterwards produces tests that describe the code that was written rather than the
property that was wanted.

At minimum, one row per boundary: after S3 upload / before reference commit; after reference
commit / before outbox publish; after outbox read / before delivery; after delivery / before
receipt write; after stage state write / before acknowledgement; after external request / before
acknowledgement. For each: what is orphaned, what reconciles it, and what the user sees while it
is unreconciled.

Commit the matrix as `docs/failure-injection-matrix.md`. It outlives this phase — Phase E adds
fetch boundaries to it.

### C1 — Record schemas, migrations and indexes

Implement the §6.3 records this phase needs, **not all thirty-five**. The ones Phase D through F
own (`AssociationAssertion`, `GraphSnapshot`, `EvidenceSpan`, `Assertion`, `Event`, `EventCluster`,
`EventChainLink`, `Finding`, `QueryPlan`, `QueryExecution`, `EgressIdentity`) are defined when
the code that produces them is written; defining them now hardens guesses.

This phase's records:

- **`StageExecution`** — the FR-09 stage ladder as durable state. Lease token, lease expiry,
  attempt count, failure class, revision. This is the record the worker fences on.
- **`OutboxEvent`** — event type, aggregate identity, payload, published state, attempt count,
  next attempt. Written **inside** the business transaction.
- **`InboxReceipt`** — generalise `idempotencyKeys`. It currently covers HTTP idempotency; C2
  needs the same for queue message identity. Note the §6.3 warning: an expired receipt must not
  let a late message repeat a committed effect, so **persisted run and stage identity is the
  final guard, not the receipt.**
- **`SourceDocumentVersion`** — enough to hold a staged evidence object: publisher, source URL,
  canonical URL, retrieval date with precision and timezone, content hash, S3 reference, index
  state. Populated in Phase E; the record and its reconciliation exist here.
- **`AuditEvent`** — SEC-06. Actor, authorised tenant, action, target and version, reason,
  correlation ID, result. Read `SEC-06` before designing it: a hash chain written by the same
  unrestricted writer is **explicitly not sufficient**, and business roles must not be able to
  update or delete entries. Decide how the integrity checkpoint is protected and write that
  decision down; if it cannot be done properly in a local stack, say so and record what
  production needs rather than shipping a chain that only looks tamper-evident.
- **`RetentionAction`** — D-012 set evidence retention at 30 days, configurable. The record that
  will carry out an expiry, and the legal-hold flag that overrides it.

Migrations: there is no migration runner yet. `StartupService` creates indexes idempotently,
which is fine for additive indexes and **not** fine for a change that has to transform existing
documents. Decide in this step whether Phase C needs a real runner or whether additive-only is
honest, and write the answer into `docs/architecture.md`.

**Done (2026-09-11).** `apps/api/src/persistence/` holds `StageExecutionService`,
`OutboxService`, `InboxReceiptService`, `SourceDocumentService`, `AuditService` (with the
`AuditCheckpointWriter` port and `LocalAuditCheckpointWriter`) and `RetentionService`, all
registered in `app.module.ts` and indexed by `StartupService`. `idempotencyKeys` became
`inboxReceipts` with a `channel`, and `IdempotencyService` is now a thin HTTP wrapper over it.
The FR-06 classification table lives in `packages/domain/src/reliability/failure-classification.ts`
— pure, so C6 wires it rather than inventing a second taxonomy. Covered by
`tests/integration/persistence.test.ts` (38 tests). The migration decision (additive-only, no
runner, with what production requires written out) and the audit-integrity decision are in
`docs/architecture.md` under "Persistence conventions (Phase C)".

**What C1 deliberately did not do:** nothing calls any of these records yet. `searchRuns` is
still created and never advanced, no stage is ever ensured by a real code path, and no audit
entry is written by a real action. Wiring them to the search lifecycle is C2's transaction
runner, and doing it in C1 would have meant designing the transaction boundary twice.

### C2 — Transactions and the outbox

Report state, audit reference and outbox events commit **together**, in one MongoDB transaction
(the local stack runs a replica set precisely so this is possible).

- One place that opens a transaction and one retry policy around it. §6.3 requires explicit
  handling of transaction conflicts, **unknown commit outcomes** and duplicate-key errors — the
  middle one is the one people forget: a commit whose result never came back is not a failure,
  and treating it as one is how work gets duplicated.
- S3, the search index and the queue are **outside** the transaction, in this order: stage the
  upload, verify the checksum, commit the reference, publish through the outbox.
- A queue envelope carries a tenant, and the worker **verifies job ownership against the
  persisted record** before acting on it (SEC-01). The envelope's tenant field is a routing hint,
  never an authority.

### C3 — The search index

Name-matching indexes and the corpus index, with **MongoDB as the system of record**. The index
is derived state: if it disagrees, MongoDB wins and the index is rebuilt.

Stay behind the `SEARCH_INDEX_KIND` seam that Phase A established. C4 may send this to
OpenSearch, and index-specific code outside the seam is what makes that migration expensive
enough to skip — which would decide D12 by inertia.

Reconciliation is a deliverable, not a follow-up: a committed document that never reached the
index must be findable and re-indexable, and the gate's exit condition names "no unindexed
committed documents" explicitly.

### C4 — The matcher-latency workload test — closes D12

The measurement, not a preference. Three latencies, measured **separately**:

1. matcher latency (the FR-08 name-form expansion path),
2. API acceptance latency,
3. total search latency.

Over the FR-16 corpus in `packages/evaluation`, with the FR-08 name-form expansions — including
the transliteration and phonetic keys, since those are what a naive index handles badly. Record
the numbers in `docs/decisions.md` and close D12 there with the figures.

The outline's own expectation: **OpenSearch is the likelier answer if the matcher needs custom
analysers or multi-field boolean scoring.** Meilisearch is a working assumption. If the
measurement says switch, switching is the deliverable, not a note for later.

### C5 — S3 staging and reference commit

Stage, verify the checksum, commit the reference, reconcile orphans. **Never return a successful
evidence reference to a missing object** — that is a screening product telling a reviewer that
evidence exists when it does not.

Keys are generated server-side with tenant and region context and opaque IDs — never a raw name
or a caller-supplied path (SEC-03). Local emulation is not evidence that real IAM and KMS
policies work; that is gate G11, and nothing in this phase may imply otherwise.

### C6 — Retries, DLQ, lease fencing and cancellation

Use the **FR-06 failure classification table** as written; do not invent a second taxonomy.
Transient network, rate limited, soft block, hard block and content error have different
policies and different attempt counts, and three of the five must not be retried at all.

- Bounded exponential backoff with full jitter. Honour `Retry-After` exactly when given.
- Lease renewal for long jobs, with a bound on total execution.
- **Fencing**: a stale worker must not overwrite a current or cancelled result. Lease token plus
  revision check, on every write that advances a run.
- Cancellation and refresh racing a late completion (T30): the cancellation holds and the
  historical run is unchanged.
- A crash after an external request but before acknowledgement **may repeat the external call**.
  Do not promise exactly-once external execution. Prevent duplicate committed findings anyway —
  that is what run and stage identity is for.

---

## Definition of done

- [x] C0 — `docs/failure-injection-matrix.md` exists and covers every two-system boundary (16 rows, FI-01..FI-16)
- [x] C1 — records, indexes and the migration decision; tenant context leads every tenant-owned key, with the five cross-tenant index exceptions documented in `docs/architecture.md`
- [ ] C2 — state, audit reference and outbox commit in one transaction, with conflict, unknown-outcome and duplicate-key handling
- [ ] C3 — index built behind the seam; reconciliation re-indexes a committed-but-unindexed document
- [ ] C4 — three latencies measured over the FR-16 corpus; **D12 closed in `docs/decisions.md` with numbers**
- [ ] C5 — staged upload, checksum verification, reference commit, orphan reconciliation
- [ ] C6 — FR-06 classification honoured; DLQ, lease fencing, cancellation, duplicate delivery
- [ ] T22, T23 — still pass (they do today; C2 must not regress them)
- [ ] T24 — redelivery or crash before acknowledgement commits no duplicate stage, finding or event
- [ ] T29 — simultaneous actions on one revision: one accepted, the stale one gets 409 **and a recovery path**
- [ ] T30 — cancel or refresh racing a late completion: fencing holds; the historical run is unchanged
- [ ] T31 — repeated and out-of-order deliveries are deduplicated and applied safely
- [ ] T41 — upload commits but DB fails, then DB commits but the publisher crashes: orphan reconciled, outbox republishes, **no dangling success**
- [ ] Restart verified at **every** persistence and publication boundary in the C0 matrix
- [ ] `verify-local.mjs` still reports honestly; no suite marked implemented that does not run
- [ ] `docs/implementation-status.md` moves G4 to Complete with the commands as evidence
- [ ] `START-HERE.md` active-phase pointer moved to Phase D
- [ ] Handoff entry written

## Do not

- Put S3, the index or the queue inside the MongoDB transaction. The order in C2 exists because
  a distributed transaction across them does not.
- Trust a queue message's tenant field. Verify ownership against the persisted record (SEC-01).
- Treat an unknown commit outcome as a failure. Retrying a commit that may have succeeded is how
  duplicate work is committed.
- Let an expired idempotency receipt allow a repeated business effect. Run and stage identity is
  the final guard (§6.3).
- Decide D12 by inertia. If C4's numbers favour OpenSearch, switching is this phase's work.
- Solve a CAPTCHA or work around a block. The FR-06 table says cool down and abandon, and that is
  a product rule, not a technical limitation.
- Ship an audit chain whose integrity depends only on the same writer that can rewrite it
  (SEC-06). If the local stack cannot protect a checkpoint properly, record what production needs.
- Build Phase D's records because the schema "felt incomplete". They are defined with the code
  that produces them.

## Decision to close

**D12 — search index choice.** Closed by C4's measurement, recorded in `docs/decisions.md` with
the numbers rather than as a preference. Measure matcher latency separately from API acceptance
latency and from total search latency, over the FR-16 corpus with the FR-08 name-form
expansions. Meilisearch is the current working assumption; OpenSearch is the likelier answer if
the matcher needs custom analysers or multi-field boolean scoring.

## Known risks

| Risk                                                                           | Mitigation                                                                                                                                     |
| :----------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| Transaction tests pass on a single-node replica set and fail on a real cluster | The local stack is a replica set, not standalone, for this reason. Still, note in the handoff that G11 re-verifies against production topology |
| Failure-injection tests become slow and get skipped                            | Inject at the seam, not with real timeouts. A suite that takes ten minutes stops being run                                                     |
| C4 measures a corpus too small to distinguish the candidates                   | State the corpus size and the confidence with the numbers. An unconvincing measurement leaves D12 open — that is an honest outcome             |
| Lease fencing looks correct under no contention                                | Every fencing test must have two workers racing. A single-worker test proves nothing about staleness                                           |
| The audit integrity requirement is larger than it first appears                | Read SEC-06 before designing, not after. It explicitly rules out the obvious implementation                                                    |

## Expanding this brief further

It is now a brief, not an outline. Two things are deliberately left to the step that does them,
because they depend on what the step finds:

- the exact field list for `StageExecution` and `OutboxEvent`, which follows from the C0 matrix;
- whether a migration runner is needed, which C1 decides and records in `docs/architecture.md`.
