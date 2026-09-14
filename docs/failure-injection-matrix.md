# Failure-injection matrix

Every point where this service writes to two systems that cannot commit together, what is left
behind if the process dies between them, what reconciles it, and what the user is told while it
is unreconciled.

Written **before** the code it describes (Phase C step C0). A matrix written afterwards describes
the code that was written; this one describes the property that was wanted, and the tests in C2,
C5 and C6 are derived from it rather than from the implementation.

It outlives Phase C. Phase E adds the fetch boundaries; Phase F adds extraction; a new two-system
write anywhere in this service adds a row here in the same change that adds the write.

---

## How to read a row

| Column                 | Means                                                                  |
| :--------------------- | :--------------------------------------------------------------------- |
| **ID**                 | Stable. Tests name it; the injection seam uses it as its identifier    |
| **Boundary**           | The two writes, in the order the code performs them                    |
| **Orphan**             | What exists after a crash between them that nothing points at          |
| **Reconciler**         | The named, idempotent process that resolves it. Not "a follow-up"      |
| **Window**             | How long the orphan can exist before the reconciler is expected to act |
| **What the user sees** | In §6.2 vocabulary, while it is unreconciled                           |

---

## Three rules that decide every ordering below

**1. Prefer an orphan to a dangling reference.** Where one of the two effects can be reconciled
after the fact and the other cannot, do the reconcilable one first. An orphaned S3 object costs
storage and is swept up. A committed reference to an object that was never written is a screening
product telling a reviewer that evidence exists when it does not (§6.3: _never return a successful
evidence reference to a missing object_). This is why uploads precede reference commits, and why
retention marks the reference before deleting the object — the inverse order of the same rule,
for the same reason.

**2. Every reconciler needs a grace window longer than the longest legitimate in-flight gap.**
A sweep that deletes "orphans" younger than the slowest healthy upload deletes live work, and it
will do it under load, which is exactly when the evidence matters. Each row states its window.
A window is a configured value with a stated basis, never a literal chosen at the call site.

**3. No unreconciled state may overstate knowledge.** While a boundary is unresolved, a run may
report `RUNNING` or `PARTIAL` execution and `INCOMPLETE` or `UNKNOWN` coverage. It may **never**
report `NO_MATCHES_FOUND`, and it may never report `WITHIN_DECLARED_SCOPE`. "We have not finished
looking" and "we looked and found nothing" are different facts, and a crash must not convert the
first into the second. `aggregateRun` in `packages/domain/src/coverage/result-state.ts` already
enforces the distinction; these rows are the reason it exists.

A fourth rule that is not about ordering: **an expired deduplication receipt must never permit a
repeated business effect.** Receipts are a convenience that makes duplicates cheap to detect.
Persisted run and stage identity is the guard that makes them impossible (§6.3). Every row below
that mentions a receipt also names the identity that holds when the receipt is gone.

---

## The matrix

| ID        | Boundary                                                    | Orphan                                                       | Reconciler                                                                                | Window      | Phase |
| :-------- | :---------------------------------------------------------- | :----------------------------------------------------------- | :---------------------------------------------------------------------------------------- | :---------- | :---- |
| **FI-01** | Idempotency claim written → run inserted                    | `IN_FLIGHT` receipt with no run                              | Explicit `release()`; TTL expiry as the backstop                                          | 24 h TTL    | B ✅  |
| **FI-02** | Subject version committed → run inserted                    | _Not an orphan_ — see below                                  | None, deliberately; closed on the search path by C2                                       | —           | C2 ✅ |
| **FI-03** | S3 object staged + checksum verified → reference committed  | S3 object nothing references                                 | Orphan-object sweep over the tenant prefix                                                | 6 h         | C5    |
| **FI-04** | Reference + outbox event committed → event published        | Unpublished `OutboxEvent`                                    | Outbox publisher polls unpublished, due events                                            | next poll   | C2    |
| **FI-05** | Event published to queue → marked published in Mongo        | Event published twice                                        | None needed — consumer dedupes (FI-07/FI-09)                                              | —           | C2    |
| **FI-06** | Queue message read → handling begins                        | Nothing durable                                              | Visibility timeout returns the message                                                    | visibility  | C6    |
| **FI-07** | Stage state committed → message acknowledged                | Message redelivered after committed work                     | `InboxReceipt` on message identity + stage identity                                       | visibility  | C6    |
| **FI-08** | External request made → message acknowledged                | **The external call may repeat**                             | Not prevented. Stage identity stops duplicate results                                     | visibility  | C6    |
| **FI-09** | Effect applied → receipt written                            | Effect committed, receipt absent                             | Same transaction; identity is the guard if it is not                                      | —           | C2    |
| **FI-10** | Document committed → written to the search index            | Committed-but-unindexed document                             | Re-indexer sweeps `indexState: PENDING`                                                   | 5 min       | C3    |
| **FI-11** | Lease acquired → stage state written                        | Lease held by a dead worker                                  | Lease-expiry sweeper; fencing rejects the stale write                                     | lease TTL   | C6    |
| **FI-12** | Cancellation committed → late completion arrives            | A result for a run that is no longer running                 | Fence rejects it; the attempt is recorded, not applied                                    | —           | C6    |
| **FI-13** | Review action read revision → review action written         | Two actions on one revision                                  | Revision check; the stale one gets 409 + a recovery path                                  | —           | C6    |
| **FI-14** | Business state + audit entry committed → checkpoint written | Audit entries past the last checkpoint                       | Checkpointer detects and closes the sequence gap                                          | checkpoint  | C1    |
| **FI-15** | Reference marked expired → S3 object deleted                | Object still present, reference says expired                 | Retention sweeper retries the delete                                                      | 24 h        | C1/C5 |
| **FI-16** | Notification delivered → delivery recorded                  | Delivery repeated, or arriving out of order                  | Receiver dedupes on event ID; lower revisions discarded                                   | —           | C6/G  |
| **FI-17** | Source registry read → snapshot committed                   | A snapshot citing a version that has changed                 | Snapshot pins what the run planned; health is re-read at each use                         | —           | D5    |
| **FI-18** | Source suspended → in-flight run already dispatched work    | Work in flight against a source we stopped                   | Access rechecked at every point of use; the gap is recorded                               | one call    | D5    |
| **FI-19** | Fetch authorised → the socket opens                         | A request made under an approval that has since been retired | The authorisation is issued per lead and names the version; health is re-read at the call | one request | E2    |

"✅" means it exists and holds today. The rest are specified here and built in the step named.

---

## The rows in full

### FI-01 — Idempotency claim written → run inserted

**Exists today** in `apps/api/src/searches/idempotency.service.ts`. The claim is a unique-index
insert precisely so that two identical concurrent requests cannot both pass a check (T22).

A crash after the claim and before `insertOne` on `searchRuns` leaves an `IN_FLIGHT` receipt for
a run that does not exist. The happy-path failure handler calls `release()`; a crash skips it, and
the TTL index on `expiresAt` clears it after `IDEMPOTENCY_WINDOW_MS` (24 h).

**What the user sees while unreconciled:** a retry with the same key is told `IN_FLIGHT` and asked
to retry, not given a second run. That is the correct answer even though the first run does not
exist — the alternative, treating an `IN_FLIGHT` claim as abandoned, is how two runs get created
for one request under exactly the load that made the first one slow.

**The gap this leaves, and why it is accepted:** for up to 24 h a genuinely crashed request cannot
be retried under its original key. The caller can retry under a new key and receives a new run.
The cost of the alternative — a heuristic "the claim looks stale" rule — is duplicate committed
work, which is worse. C2 may shorten the window for `IN_FLIGHT` claims specifically; it must not
remove the distinction.

### FI-02 — Subject version committed → run inserted

**No longer a boundary on the search path, and deliberately not an orphan anywhere else.**

C2 closed the gap: `SearchesService` resolves the subject _inside_ its transaction and passes the
session down, so a snapshot and the run that cites it commit together. There is no window between
them any more.

It stays in this table because the other path is real and must not acquire a reconciler by
mistake. `POST /v1/subjects` creates a subject version with no search at all, and a sweeper that
deleted "unreferenced" subject versions would delete records a customer created on purpose. A
subject version is a first-class record, not a fragment of a search.

Recorded here so that the next person to read this file does not invent a reconciler for it.

### FI-03 — S3 object staged and verified → reference committed

Order is fixed by rule 1. Stage the upload, verify the checksum against the bytes as stored, then
commit the `SourceDocumentVersion` reference. The inverse order is forbidden.

**Orphan:** an object under the tenant's prefix that no committed reference names.

**Reconciler:** an orphan sweep listing the tenant prefix and comparing against committed
references, deleting only objects whose last-modified time is older than the window.

**Window: 6 h.** Basis: the longest legitimate gap between a completed upload and its committed
reference is one transaction retry cycle — seconds. Six hours is three orders of magnitude of
headroom, chosen so that a sweep cannot race a slow commit under load. It costs a few hours of
storage for a bounded number of objects, which is the cheap side of the trade.

**What the user sees:** nothing about that document — the evidence is simply not attached to the
run. The source's `SourceCoverageOutcome` records the failure, so coverage reports `INCOMPLETE`
rather than the run silently completing with one document fewer than it fetched.

**Never the inverse.** A test must prove that no code path can commit a reference before the
object is verified present. This is the T41 first half, and it is the row that most directly
prevents "a screening product telling a reviewer that evidence exists when it does not".

### FI-04 — Reference and outbox event committed → event published

The `OutboxEvent` is written **inside** the same MongoDB transaction as the state change and the
audit reference (§6.3). Publication to SQS happens after the commit, outside the transaction.

**Orphan:** a committed, unpublished event. This is the normal case, not an exceptional one — the
publisher is what makes the outbox an outbox.

**Reconciler:** the publisher polls for events where `publishedAt` is null and `nextAttemptAt` is
due, in aggregate order, with bounded exponential backoff and full jitter on failure.

**Window: the next poll.** The event is durable and ordered; there is no data loss, only latency.

**What the user sees:** `execution: RUNNING`, progress unchanged, until the event is published and
consumed. Not `FAILED` — nothing has failed — and not `SUCCEEDED`.

This is the second half of **T41**: the DB commit succeeds, the publisher then crashes, and the
outbox republishes with no dangling success.

### FI-05 — Event published → marked published

A crash here publishes the event and never records that it was published, so the publisher sends
it again. **This is by design and must not be "fixed".** Marking-then-publishing would lose events
outright, which is unrecoverable; publishing-then-marking duplicates them, which the consumer
already handles (FI-07, FI-09). At-least-once with a deduplicating consumer beats at-most-once
with a lost run.

**What the user sees:** nothing. A duplicate delivery produces no second effect.

### FI-06 — Queue message read → handling begins

No durable write has happened. The message's visibility timeout expires and it returns to the
queue. Listed for completeness: it is the one boundary in this table with nothing to reconcile,
and confirming that is worth a row.

### FI-07 — Stage state committed → message acknowledged

The worker commits its stage state and crashes before deleting the message. The message is
redelivered and the work is attempted a second time.

**Reconciler, two layers:**

1. `InboxReceipt` keyed on `(tenantId, consumer, messageId)`, written in the same transaction as
   the effect (FI-09). A redelivery finds the receipt and acknowledges without re-doing the work.
2. **Stage identity** — `(runId, stageId)` with a unique index — which holds when the receipt has
   expired. A second attempt at a stage that already reached a terminal state is discarded, not
   re-run. This is the guard §6.3 means by "persisted run/stage identity remains the final guard".

**What the user sees:** nothing. One committed stage, one set of findings, one set of events.
This is **T24**.

### FI-08 — External request made → message acknowledged

The one boundary that cannot be made safe, and saying so plainly is part of the deliverable.
A crash after an outbound fetch but before acknowledgement **will** repeat the external call on
redelivery. REL-01 is explicit: _do not promise exactly-once external execution._

**What is prevented anyway:** duplicate _committed_ findings, events and stages, by the identity
in FI-07. The repeat costs a request against a source budget and the politeness limit for that
domain; it does not cost correctness.

**What reduces the cost:** the idempotent fetch key from FR-06 — a redelivered message re-uses the
stored response, with conditional `GET` against the stored `ETag`/`Last-Modified` where the source
supports it. That is Phase E's implementation; the row exists here because the _property_ is
Phase C's, and because the temptation to claim exactly-once arrives at the moment someone writes
the retry loop.

**What the user sees:** nothing, unless the repeated request is refused by a rate limit — in which
case the FR-06 classification handles it as `Rate limited`, and the affected source is reported as
a coverage gap, never as a zero result (REL-02).

### FI-09 — Effect applied → receipt written

If these are two transactions, a crash between them leaves an effect with no receipt, and the
redelivery repeats the effect. So **they are one transaction**: the receipt is a MongoDB document
precisely so that it can commit with the effect. This is the reason the inbox is not implemented
in the queue's own metadata.

Where a receipt genuinely cannot share the transaction — an effect in another system — the receipt
is not the guard and must not be treated as one. Stage and run identity is (FI-07).

**Receipt expiry never permits repetition.** A test drives this directly: commit an effect, delete
its receipt outright, redeliver the message, and assert that no second effect is committed. If
that test passes only because the receipt existed, it was testing nothing.

### FI-10 — Document committed → written to the search index

MongoDB is the system of record; the index is derived state. If they disagree, MongoDB wins and
the index is rebuilt (C3).

**Orphan:** a committed `SourceDocumentVersion` that the matcher cannot find — the most dangerous
row in this table, because its symptom is a clean result. An unindexed document does not look like
an error. It looks like nothing to report.

**Reconciler:** `indexState` on the record (`PENDING` → `INDEXED` | `FAILED`), set to `PENDING` in
the committing transaction, advanced by the indexer, and swept by a re-indexer that picks up
anything left `PENDING` beyond the window.

**Window: 5 minutes.** Basis: normal index latency is sub-second; five minutes is short enough
that a run's own aggregation notices, and long enough not to fight a transient index outage.

**What the user sees — the rule this row exists for:** a run whose documents are not all `INDEXED`
**must not** aggregate to `NO_MATCHES_FOUND`. It reports `INCOMPLETE` coverage while any of its
documents is unindexed. The gate's exit condition — "no unindexed committed documents" — is
checked as a query, not as an assumption.

### FI-11 — Lease acquired → stage state written

A worker takes a lease on a `StageExecution`, then dies. The lease expires; the stage returns to
`PENDING` with `attempt + 1`; another worker takes it. Meanwhile the first worker may not be dead
at all — merely paused long enough for its lease to expire — and may wake up and try to write.

**Fencing, not liveness detection.** The lease token and the record's `revision` are both checked
on every write that advances a run. A worker whose token is no longer the current one has its
write rejected; the attempt is recorded with its outcome so that a rejected write is visible
rather than silent.

**Every fencing test races two workers.** A single-worker test proves nothing about staleness: the
code path that matters is the one where the losing write arrives after the winning one committed.

**What the user sees:** `execution: RUNNING` with the attempt count visible in progress. A retried
stage is not a failure and is not reported as one.

### FI-12 — Cancellation committed → late completion arrives

A cancellation bumps the run's `revision` and sets `execution: CANCELLED`. A worker that was
mid-stage completes and tries to write its result.

**The cancellation holds.** The late write fails the revision fence and is discarded. The
historical run is unchanged — not re-opened, not marked `PARTIAL`, not given the late findings.
The discarded result is recorded as a discarded attempt, because "we threw away work" is a fact an
operator may need and a reviewer must never see presented as a finding.

The same applies to a refresh racing a late completion of the run it refreshes: the refresh is a
new run, and the old run's history is immutable. This is **T30**.

### FI-13 — Review action read revision → review action written

Two reviewers act on the same revision of a finding. One write wins on the revision check; the
other is refused with **409 and a recovery path** — the response carries the current revision and
the current state, so the losing reviewer can see what changed and re-submit deliberately.

A 409 with no recovery path is a dead end that trains people to retry blindly, which is how the
second reviewer's intent silently overwrites the first. This is **T29**, and the recovery path is
part of the test, not a nicety.

### FI-14 — Business state and audit entry committed → integrity checkpoint written

The audit entry commits **inside** the business transaction (§6.3: _commit report state, audit
reference and outbox events transactionally_). There is no boundary between the action and its
audit record, and that is the point — an action whose audit entry can fail separately is an action
that can happen unrecorded.

The boundary is the **integrity checkpoint**, which is written separately and, per SEC-06, by a
writer with different credentials from the one that writes entries. _A hash chain stored with the
same unrestricted writer is not sufficient by itself._

**Orphan:** audit entries past the last checkpoint. Detectable as a sequence gap, which is what
SEC-06 asks to be tested — _missing sequence/checkpoint detection_.

**What the user sees:** nothing. An operator sees an integrity warning until the checkpointer
catches up.

**C1 owes a decision here, not an implementation detail.** If the local stack cannot protect a
checkpoint writer from the process that writes entries, the honest output is a recorded statement
of what production must provide, not a chain that only looks tamper-evident. C1 writes that
decision into `docs/architecture.md`.

### FI-15 — Reference marked expired → S3 object deleted

Rule 1 in its other direction. Retention (D-012: 30 days, configurable) marks the reference first
and deletes the object second. The inverse leaves a live reference to a deleted object — the exact
dangling success FI-03 exists to prevent, arrived at from the opposite end.

**Orphan:** an object still present whose reference says expired. **Reconciler:** the retention
sweeper retries the delete; the `RetentionAction` record is not closed until the object is gone.

**Window: 24 h**, and a `RetentionAction` that has not closed within it is an operator alert rather
than a silent retry, because an undeleted object past its retention date is a compliance fact and
not merely a slow job.

**Legal hold overrides**, and it overrides at the point of the delete, not only at the point of
scheduling — a hold placed after a `RetentionAction` was created must still stop the deletion.

**What the user sees:** the evidence reported as expired. Not an error, not an empty document, and
not a 500 from a reference that no longer resolves.

### FI-17 — Source registry read → snapshot committed

The boundary D5 adds on the **registry** side. A run reads the source registry to decide what it
may use and commits a snapshot of that decision; between the two, an administrator can activate a
new version, supersede one, or engage the kill switch.

**Why a transaction does not solve this.** The two writes are not both writes. The registry read
happens at plan time and the snapshot commit inside the search-creation transaction, but the _use_
of the source happens minutes later inside a worker that holds neither. Wrapping the read and the
commit together would make them consistent with each other and leave the gap that matters - the one
between the commit and the fetch.

**Orphan:** a committed snapshot citing a source version that is no longer the active one. It is
**not** reconciled by rewriting the snapshot, and that is the decision: an approved version is
immutable and a snapshot records what the run planned, so correcting it afterwards would destroy
the only evidence of what the run actually intended.

**Reconciler:** none for the snapshot itself. `SourceHealthService.checkAccess` is what makes a
stale snapshot harmless — it re-reads the active version and the mutable health document at every
point of use (FI-18). The pinned version explains what the run intended; health decides what it is
allowed to do.

**Window: —.** There is no interval in which a stale snapshot can cause a call the current registry
forbids, because the registry is re-read at the call.

**What the user sees:** where the version has since been suspended or superseded, a coverage
outcome of `SUSPENDED` naming it, and on a historical read `sourceSuspendedSince` on the finding and
`sinceSuspendedSources` on the findings page (D-031). Never a silently narrower plan.

### FI-18 — Source suspended → in-flight run already dispatched work

The boundary on the **run** side, and the one T36 is about. An operator engages the kill switch at
10:31. A run that started at 10:28 has built its plan, may already hold leads, and is part-way
through fetching them.

**Orphan:** work in flight against a source this service has just stopped using — queued discovery
queries, and discovered leads whose documents have not yet been fetched.

**Reconciler: the point-of-use recheck, not a sweeper.** The pipeline calls
`SourceHealthService.checkAccess` immediately before **each** discovery query and **each** fetch.
There is no cancellation message chasing the run, deliberately: a cancellation that has to arrive is
one that can fail to arrive, and that failure is the thing this row exists to prevent. Making the
run ask, every time, removes the delivery problem entirely.

**Window: one call.** At most one request already on the wire completes after the switch is
engaged. It cannot be zero without holding a lock across an external call, which would make every
fetch in the system wait on the registry.

**What the user sees:** a `SourceCoverageOutcome` of `SUSPENDED` naming the suspension, its operator
and its reason, and a `PARTIAL` or `INCOMPLETE` run — never a `SUCCEEDED` / `NO_MATCHES_FOUND` run
that quietly consulted one fewer source. Each un-fetched lead is kept as a **rejected lead carrying
the suspension as its reason**, so nothing is lost and a reviewer can see what was not looked at.

**A result produced before the suspension is not deleted.** T36 is explicit, and deleting it would
destroy an accurate record of what was found and when. A later read shows `sourceSuspendedSince` on
the finding's document and lists the source in `sinceSuspendedSources` on the findings page — both
places, for the reason in decision **D-031**.

**Licence expiry is the same row.** T36 names it explicitly and `decideSourceAccess` puts it on the
same path: past the recorded expiry the source is refused exactly as a suspended one is.

### FI-19 — Fetch authorised → the socket opens

The boundary Phase E step 2 adds. `FetchGateService` reads the **active approved source version**,
derives a `FetchAuthorisation` from it, and hands it to the fetch adapter, which then screens,
consults robots.txt, checks health and opens a socket. Between the read and the socket, an
administrator can retire the version, activate a narrower one, or let the licence terms expire.

**Orphan:** none, in the storage sense — nothing is written between the two. What can exist is a
**request made under an approval that is no longer current**, which is the same shape of problem as
FI-17 and is recorded here so it is not mistaken for a new one.

**Reconciler: the authorisation is issued per lead, not per run.** It is derived immediately before
the fetch rather than at plan time, so the window is one request rather than the length of a run.
`SourceHealthService.checkAccess` closes the other half at the call itself, and the authorisation
names the exact `sourceVersionId` and `licenceTermsVersion` it was issued under — so a request made
in the window is attributable to the approval that was current when it was made, rather than being
indistinguishable from one made under the new version.

**Window: one request.** It cannot be zero without holding a lock across an external call.

**What the user sees:** where the gate refuses, a rejected lead carrying the reason, and — when the
refusal is a property of the source rather than of one URL — a `SKIPPED` coverage outcome naming
it (D-036). `SKIPPED`, not `FAILED`: the source answered nothing because we chose not to ask it,
and reporting an outage at a publisher that is working is its own kind of false statement.

### FI-16 — Notification delivered → delivery recorded

At-least-once and potentially out-of-order (REL-03). A crash after delivery and before recording
it repeats the delivery; independent retries can arrive out of order.

**Receiver-side rules, which the Zquence sample receiver demonstrates:** deduplicate on event ID,
and apply revisions safely — a delivery carrying a revision lower than the one already applied is
discarded, not applied as an update. An out-of-order delivery that overwrote newer state would
show a reviewer a result that the service has already superseded.

**Phase split, stated honestly:** the dedup-and-revision property is Phase C's and is tested here
over the queue consumer (**T31**). The signed HTTPS webhook transport, its signing-secret rotation
and the delivery log are REL-03 and belong to a later phase. This row is written now so that the
property is not re-derived, differently, when the transport is built.

---

## How these are injected

**At the seam, never with real timeouts.** A suite that takes ten minutes stops being run, and a
failure-injection suite that stops being run is worse than none, because the gate still claims it.

Each row's ID is the injection point identifier. The persistence layer exposes a test-only seam
that throws a distinguishable crash at a named point:

```ts
// Test-only. Registered only when ADVERSE_SEARCH_MODE is a test mode; the production
// container has no path that can register one.
failAt('FI-04'); // publisher dies after commit, before publish
```

Requirements on the seam:

- **It cannot be enabled in a live configuration.** Same discipline as the fixture sources: the
  registration path refuses any mode but the test mode, and a test asserts that refusal.
- **The crash is distinguishable** from a genuine error, so a test that passes because something
  else broke fails instead of passing quietly.
- **Leases, TTLs and backoff windows are injected clock values**, not waits. Time is a parameter
  everywhere in this codebase already; these rows do not get to be the exception.

**Restart is verified at every row**, per the gate's exit condition, and "verified" means the
reconciler ran and the assertion is on the reconciled state — not that the crash was survived.

---

## Row-to-test map

| Test    | Rows                       | The claim                                                           |
| :------ | :------------------------- | :------------------------------------------------------------------ |
| T22     | FI-01                      | Concurrent identical requests: one operation, one committed run     |
| T23     | FI-01                      | Changed body 409s; the same key in another tenant is independent    |
| T24     | FI-05, FI-07, FI-08, FI-09 | Redelivery or crash before acknowledgement commits no duplicate     |
| T29     | FI-13                      | One accepted, the stale one 409s **with a recovery path**           |
| T30     | FI-11, FI-12               | Fencing holds; the historical run is unchanged                      |
| T31     | FI-07                      | Repeated and out-of-order deliveries deduplicate and apply safely   |
| T41     | FI-03, FI-04               | Orphan reconciled, outbox republishes, no dangling success          |
| G4 exit | FI-10                      | No unindexed committed documents                                    |
| SEC-06  | FI-14                      | Sequence/checkpoint gaps are detected, not assumed absent           |
| D-012   | FI-15                      | Retention deletes the object, and legal hold stops it at the delete |
| T36     | FI-17, FI-18               | A source suspended mid-run stops being used **within** that run     |

---

## What this matrix does not cover

Named so that their absence is a decision and not an oversight:

- **Fetch boundaries** — partial cascade completion and egress identity rotation mid-fetch. Phase E
  adds them to this file. **Per-source budget exhaustion mid-run is now covered** by FI-18: the same
  point-of-use check that honours the kill switch refuses a spent budget, and the refusal is a
  coverage outcome (`PARTIAL` / `TRUNCATED_BY_QUOTA`) rather than an error.
- **Extraction boundaries** — an assertion committed against a document version that is later
  superseded. Phase F.
- **Export boundaries** — an export job whose artefact is staged but whose rights were revoked
  between ingestion and read (SEC-03 requires the recheck at read time). Phase G or H.
- **Cross-region and multi-node topology.** Every row here is verified against a single-node
  replica set. That is enough to prove the transaction semantics and not enough to prove they hold
  on a real cluster; G11 re-verifies against production topology.

---

## Where each row is tested, as of C6

The map above says which rows a numbered test claims. This says where the code actually is, so
a later session does not have to find it.

| Rows                        | File                                                                                                                                            |
| :-------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------- |
| FI-01, FI-02, FI-04, FI-05  | `tests/integration/transactions.test.ts`                                                                                                        |
| FI-03, FI-15                | `tests/integration/evidence-storage.test.ts`                                                                                                    |
| FI-06 – FI-09, FI-11, FI-12 | `tests/integration/jobs.test.ts`                                                                                                                |
| FI-10                       | `tests/integration/search-index.test.ts`                                                                                                        |
| FI-13                       | `tests/integration/jobs.test.ts` (T29, at the service boundary)                                                                                 |
| FI-17, FI-18                | `packages/domain/test/reliability/source-health.test.ts` (the decision) and `tests/integration/source-health.test.ts` (against the replica set) |

Two notes on what that table does **not** claim.

**FI-13 is tested on cancellation, not on a review action.** Review actions do not exist yet —
findings are Phase F. The property FI-13 is about is the revision fence and the recovery path in
the 409, and cancellation is the first action that has both, so it is tested there. When review
actions arrive they must use the same `ApiException.revisionConflict` rather than growing their
own 409, and the test moves with them.

**FI-14 and FI-16 have no row here.** FI-14's checkpoint writer needs credentials this process
must not hold (SEC-06), so the local stack can only stand in for it; FI-16 is notification
delivery, which Phase H builds. Both are listed as uncovered rather than quietly omitted.
