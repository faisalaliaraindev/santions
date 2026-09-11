# Handoff log

The only thing carrying state between sessions. Newest entry first.

Write each entry as though the reader knows nothing about what came before — because they
will not. Be specific about what is half-done and where it stopped. An entry that says
"made good progress" is worthless to the next session.

## Template

```markdown
## YYYY-MM-DD — Phase X, steps N–M

**Did:** what actually changed, by file or area.

**Verified:** the exact commands run and their results. Not "tests pass" — the numbers.

**Left half-done:** what is started but incomplete, and precisely where it stopped.

**Found:** anything surprising — a defect, a wrong assumption in a brief, a spec ambiguity.
Say what you did about it.

**Next session should:** the first concrete action, not a general direction.

**Decisions touched:** any of D1–D12 closed, or newly blocked.
```

---

## 2026-09-11 (late) — Phase D: brief expanded, **D0 done** (CR source dossier), **D1 done** (approval lifecycle + SEC-05 gate + capability coverage)

**Did — three things.**

**1. Expanded `docs/execution/phase-d.md`** from a ~4KB outline into a full brief in the Phase C
format, adding a step the outline did not have — **D0, the Costa Rica source dossier, before any
adapter** — because D-010 makes CR the only enabled jurisdiction and every free source this plan
was written around (Companies House, EDGAR, CourtListener) is UK or US.

**2. D0 — `docs/sources/cr-dossier.md`, v1.** Desk research only: **no source was contacted** —
search-engine queries, no endpoint call, no page fetch, no robots.txt read. Every claim labelled
`DOCUMENTED` / `INFERRED` / `UNKNOWN`; nothing marked verified. Three findings changed the phase:

- **No free automatable officer-level source exists in Costa Rica.** The Registro Nacional
  publishes company representatives only behind free registration **and a CAPTCHA** — a hard stop
  under FR-06, not an engineering problem. `api.hacienda.go.cr` is free and machine-readable but
  returns entity status and economic activity and **nothing about directors**. FR-02 therefore has
  no data source in the only enabled jurisdiction. Raised as **D14**.
- **Published CR judgments are probably depersonalised** — the Poder Judicial runs a
  de-identification protocol, a de-personalising tool and a repository of depersonalised
  judgments. A judgment with the names stripped is not a weak match; there is no name in it to
  match. Raised as **D15**.
- **The TSE padrón electoral solves the D-011 name-frequency gap**, under an aggregate-only
  constraint: derive the surname counts, **discard the roll**, name the use in the SEC-05 approval.

**3. D1 — the administrative spine.** Pure decisions in
`packages/domain/src/{lifecycle,rights,capability}/`; persistence and routes in
`apps/api/src/admin/`. Reasoning in `docs/decisions.md` **D-018/D-019/D-020**, mechanics in
`docs/architecture.md` under "Administrative records and the rights gate".

- **One lifecycle for three record kinds** — `PROPOSED → AWAITING_APPROVAL → APPROVED →
ACTIVATING → ACTIVE`, plus `SUSPENDED` / `SUPERSEDED` / `RETIRED` — wiring the existing pure
  `canApprove` rather than writing a second four-eyes check.
- **SEC-05 as an enforcement function**, not metadata: `decideRights` returns
  `ALLOW` / `DENY` / `REQUIRES_APPROVAL` with reason codes and machine-actionable restrictions,
  over jurisdiction, source, intended use, classification, collection method, retention, raw
  personal data, approval requirement and approval evidence. Default-deny throughout.
  `clearForActivation` is the gate in front of `ACTIVE`.
- **Capability coverage** per jurisdiction — `SUPPORTED` / `PARTIAL` / `UNKNOWN` / `UNSUPPORTED`
  — stored, surfaced on `GET /v1/admin/coverage/{jurisdiction}`, with one function
  (`interpretEmptyResult`) deciding what an empty result may be called. **Only `SUPPORTED` yields
  `NO_FINDINGS`.**
- **CR constraints are seeded data, not code.** `packages/domain/src/capability` contains no
  mention of Costa Rica; the nine CR rows live in `scripts/bootstrap/seed-data.mjs` with their
  rationales and the decision each is blocked by.
- Routes: `/v1/admin/{sources,taxonomy,policies}` with propose / list / read / edit-draft /
  transitions / activate, plus the coverage read and declare. OpenAPI regenerated and committed.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         338 passed  (was 283: +55 domain tests for lifecycle, rights, capability)
test:invariants    29 passed
test:evaluation    12 passed
test:integration  141 passed  (was 120: +21 in tests/integration/admin-lifecycle.test.ts)
test:security     106 passed  (was  95: +11 in tests/security/admin-routes.test.ts)
coverage          94.69% statements / 90.47% branches (gate 85/80)
pnpm verify:local  every suite ok except end-to-end, still [n/i] and still exits non-zero
```

**Found — five things worth knowing, three of them defects in my own first design:**

1. **A denial audited inside the transaction that refuses is rolled back with it.** The four-eyes
   refusal returned a correct 403 and left **no audit entry at all** — the opposite of what SEC-06
   wants, since an attempt to approve one's own version is exactly what an auditor needs to see.
   Fixed by writing denials in their own transaction after the business one aborts. Found only
   because the test asserted the audit entry existed rather than asserting the 403.
2. **A parallel `recordId` scheme collided with the existing unique indexes.** `sourceVersions`
   keys on `{sourceId, version}` and `taxonomyVersions`/`policyVersions` on `{tenantId, version}`,
   with the lifecycle in a `status` field. So **a taxonomy's identity is the tenant**, not a free
   id — `pinVersions` depends on one taxonomy timeline per tenant. The service now writes the
   shape that already exists, which means the Phase A fixture sources are administrable rather
   than sitting beside a second registry. (`approvalState` on seeded sources was normalised to
   `status`; nothing read the old name.)
3. **`/v1/admin/:collection` shadowed the reserved `/v1/admin/plans`**, turning a documented 501
   into a 403. Nest matches in registration order: `ReservedController` must be registered first.
   Test added.
4. **One route-level permission cannot serve three record kinds.** `@RequirePermission` now
   accepts alternatives and admits a caller holding any of them, with the service enforcing the
   exact one against the loaded record; otherwise a `taxonomy_admin` was locked out of taxonomy
   administration by a `source:propose` gate. Single-permission routes behave exactly as before.
5. **Records created through the admin API carried no `MOCK` label and broke T55.** A version
   proposed through the API in a mock stack is as much a fixture as a seeded one, so the service
   now stamps the operating mode on every version it writes. My security suite also left records
   in `tenant-alpha` — the same shared-fixture mistake C6 warned about — and now cleans up.

**Left half-done:** D1's FR-05 field list exists as a validated contract schema
(`sourceContentSchema`, with alpha-2 validation rejecting "EU"/"MENA"/"SEA" and no free-text field
that becomes a fetch), but the service stores version **content as an opaque object and does not
yet enforce conformance**. That lands in D2, when the adapters that consume those fields exist and
can say which are load-bearing. `SourceHealth`, budgets and breaker state are D5 and deliberately
not on the immutable version.

**Next session should:** start **D2** — define the six FR-05 ports
(`NewsDiscoveryPort`, `WebDiscoveryPort`, `PrimarySourcePort`, `CompanyRegistryPort`,
`EvidenceFetchPort`, `ExtractionModelPort`), deterministic mocks for all six, and one real
`CompanyRegistryPort` adapter. Author the fixtures from T14/T15/T20 **before** writing the
resolver. Per D0, the real registry adapter cannot be Costa Rican: use UK Companies House as the
proving ground and label it out-of-jurisdiction.

**Decisions touched:** **D-018, D-019, D-020 recorded** (one lifecycle; SEC-05 as enforcement with
non-approvable prohibitions; a missing capability is never an empty result). **D14, D15 and D16
opened.** D16 is new from D1 and needs product and security: any tenant's `source_admin` can
change shared registry entries that **every** tenant screens against, because source config is
shared and `decideAccess`'s tenant comparison does not apply to a record owning no tenant. The
recommendation in `docs/open-decisions.md` is a platform-scoped source role, closing by G8 before
the panel renders whatever this decides. **D6** (robots exceptions) still wants a source admin
during this phase; `robotsPosition` is already a field on the source schema, so the record exists
to carry the answer.

---

## 2026-09-11 (night) — Phase C step C6: the consumer, fencing, cancellation and the dead letter. **Gate G4 passed.**

**Did:**

- **`apps/api/src/jobs/job-consumer.ts`** — the one place a queued message becomes work. One
  fixed sequence: parse → poison check → ownership (SEC-01) → receipt (FI-07) → stage identity
  (FI-07) → lease (FI-11) → work → fenced write (FI-11/FI-12) → acknowledge. `handle()` returns
  a **disposition** (`ACKNOWLEDGE` / `RETRY_LATER` with a delay / `DEAD_LETTER` with a reason)
  and performs no transport call, which is what makes the interesting cases assertable without
  a queue.
- **`worker-runtime.service.ts`** — the loop that carries dispositions out, the FI-11 lease
  sweep, and a drain-on-shutdown that lets the in-flight message finish. It **refuses to start
  with no handlers registered**; see "left deliberately unbuilt" below.
- **`dead-letter.port.ts`** — an explicit DLQ send with a reason, alongside (not instead of) the
  SQS redrive policy. `JOBS_DEAD_LETTER_QUEUE_URL` is now a production startup guard.
- **`job-handler.ts`** — the `JobHandler` seam a phase registers work against, plus `JobFailure`,
  which carries an FR-06 `FailureSignal` rather than a class: the handler observes, the table
  classifies.
- **`QueuePort.release(handle, delaySeconds)`** — the FR-06 backoff is served as the message's
  visibility timeout rather than by sleeping in the worker. `ReceivedMessage.envelope` is now
  nullable and carries the raw `body`, so a malformed message reaches the consumer as a decision
  instead of being dropped inside the SQS adapter.
- **Cancellation, end to end.** `POST /v1/searches/{searchId}/cancel` with a **required**
  `If-Match`; `GET /v1/searches/{searchId}` now returns the revision as an `ETag`, and
  `SearchSummary` carries `revision`. A stale `If-Match` returns 409 with a new `conflict`
  object on the error envelope (`expectedRevision`, `currentRevision`, `currentState`).
- **`worker-main.ts`** — the worker entrypoint. Same image, same DI graph, no HTTP server
  (decision **D-016**; there is no `apps/worker` package and will not be one). `pnpm dev:worker`.
- Config: `JOBS_DEAD_LETTER_QUEUE_URL`, `JOB_LEASE_MS`, `JOB_MAX_EXECUTION_MS`,
  `JOB_MAX_DELIVERIES`, with two production guards (no DLQ; an execution bound shorter than one
  lease).
- Docs: `architecture.md` gains "Consuming a message: one sequence, and why it is in that order"
  and "Two dead-letter mechanisms"; `decisions.md` D-016 and **D-017**; phase-c.md's definition
  of done fully ticked; `implementation-status.md` moves **G4 to Complete**; `START-HERE.md`
  points at Phase D.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         283 passed  (was 260: +23 in apps/api/test/job-consumer.test.ts)
test:invariants    29 passed
test:evaluation    12 passed
test:integration  120 passed  (was 101: +19 in tests/integration/jobs.test.ts)
test:security      95 passed  (was  93: +2 new production guards)
coverage          94.07% statements / 89.46% branches (gate 85/80)
pnpm verify:local  every suite ok except end-to-end, still [n/i] and still exits non-zero
```

T24, T29, T30, T31 and T41 all have named tests. Three properties were verified by planting the
failure rather than by asserting the happy path:

1. **The receipt is not the guard.** A test commits a stage, then **deletes the receipt
   outright**, then redelivers — and the second attempt is still refused, by stage identity. If
   it had passed only because a receipt existed, it was testing the cheap layer.
2. **A late completion loses.** The cancellation lands _while the handler is running_. The
   worker finishes, its fenced write is refused, the result is discarded and counted in
   `discardedAttempts`, and the run stays `CANCELLED` with `findings: NOT_EVALUATED` — not
   re-opened, not `PARTIAL`. A stage that had already succeeded is left byte-identical.
3. **Retry-After is honoured exactly.** With jitter forced to 1%, a `Retry-After: 30` still
   produces a 30-second delay, asserted on the delay the transport was actually asked for.

**Left half-done:** nothing in C6. What is **deliberately unbuilt** is the first job handler —
the worker refuses to start without one, because a handler-less consumer receives every queued
search and dead-letters it as unroutable, and a process that looks healthy while draining the
queue into the DLQ is worse than one that will not start. Registering the first handler is
Phase E.

**Found — five things worth knowing:**

1. **This suite broke another file's test, and the failure appeared in the other file.** The
   first version borrowed the seeded `tenant-alpha`; `transactions.test.ts`'s T63 asserts that a
   refused entitlement leaves `tenant-alpha`'s audit trail unchanged, and these tests — running
   in parallel against the same database — were writing to it. Fixed by seeding a tenant of this
   suite's own in `beforeAll` and deleting it in `afterAll`. Worth remembering when adding any
   integration suite: **borrowing shared fixture state makes some other file fail.**
2. **A stage is only claimable once it is due,** so a fencing test cannot arrange an expired
   lease by passing a `now` in the past — the claim fails for a reason unrelated to what is
   being tested. Move the _sweep's_ clock forward instead, not the claim's.
3. **A sweep assertion must not be a count.** `findExpiredLeases` is cross-tenant and bounded,
   so `swept.returned >= 1` really measures how much unrelated work the shared local database
   happens to be holding. The test asserts membership of the sweep's own query instead.
4. **The C0 matrix's row-to-test map had T31 pointing at FI-16** — notification delivery, which
   nothing in Phase C touches. T31 is repeated and out-of-order _queue_ deliveries, which is
   FI-07. Corrected in `docs/failure-injection-matrix.md`, along with a new table saying which
   file tests each row, and an explicit note that FI-14 and FI-16 have no coverage yet.
5. **An internal defect is not an FR-06 class** (decision **D-017**). Mapping a type error onto
   `CONTENT_ERROR` — the non-retrying default for an unrecognised _source_ signal — would put
   our own bug into the coverage statement as a dead lead attributed to the publisher. It is
   recorded with a null class, retried three times in case it was environmental, then abandoned.

**Next session should:** start Phase D by **expanding [`phase-d.md`](./phase-d.md) from an
outline into a brief** — it is not yet one, and the outline itself says what expanding it
involves.

**Decisions touched:** **D-016** (the worker is a second entrypoint, not a second application)
and **D-017** (an internal defect is not an FR-06 class) recorded. D12 stays closed on C4's
numbers.

**A correction to an earlier claim in this entry, and to the phase brief.** An earlier draft of
this handoff said D1, D3 and D8 still carry placeholders and close in Phase D. That is wrong:
all three closed on 2026-09-11 (D-010 Costa Rica with es+en requested but not enabled, D-009 all
seventeen categories, D-012 configurable 30-day retention). `phase-d.md`'s "Decisions to close"
section had gone stale the same way and has been corrected — **no decision is due at G5**. The
lesson for the next session: `docs/open-decisions.md` is the register, and a phase brief's list
is a copy that can rot. Read the register.

The nearest live decision is **D6** (how robots exceptions for official sources are approved and
recorded), due G6 but shaped by the source registry Phase D builds — raise it with a source admin
during Phase D, not at the start of Phase E. **D11** (a well-evidenced acquittal banding as
`CORROBORATED`) is still open and must close by Phase G.

---

## 2026-09-11 (late night) — Phase C step C5: evidence staging, the orphan sweep and retention deletion

**Did:**

- **`apps/api/src/storage/object-store.port.ts`** — the seam, plus `InMemoryObjectStore`. Holds
  `keyFor` (the **only** place an object key is constructed) and `tenantOfKey` (what the orphan
  sweep is allowed to delete). Keys are `evidence/<region>/<tenantId>/<YYYY-MM-DD>/<uuid>` with
  no caller input anywhere in them (SEC-03).
- **`S3ObjectStoreAdapter`** — the AWS SDK, for the reason `SqsQueueAdapter` uses it and not for
  convenience: SigV4 over a rotating role credential is a security control that should be used
  rather than re-implemented. Every write sends `ChecksumSHA256`, every read asks for
  `ChecksumMode: ENABLED`, and the listing paginates to the end — a truncated listing would make
  the orphan sweep silently skip everything past the first page, and the symptom of that is
  storage cost rather than an error, so nobody would notice.
- **`EvidenceStagingService`** — FI-03. Stage, verify against the store's own checksum and byte
  count, then commit the reference. Plus `sweepOrphans`, which reads the committed key set
  **after** listing the bucket, never before.
- **`RetentionSweeper`** — FI-15. Mark the reference expired, then delete the object, and close
  the action only once the object is confirmed gone. The legal hold is re-read from the document
  at the point of deletion.
- Config: `S3_EVIDENCE_BUCKET` and `OBJECT_STORE_KIND`, with two production guards. Wiring in
  `app.module.ts`. `@aws-sdk/client-s3` added to `apps/api`.
- Docs: `docs/architecture.md` gains "Evidence objects: stage, verify, commit — and never the
  inverse" and "A batched sweep over shared state needs a bounded drain";
  `docs/decisions.md` D-015; phase-c.md C4 and C5 ticked; `START-HERE.md` and
  `implementation-status.md` moved to C6.

**The rule both rows enforce, stated once:** an orphaned object costs a few kilobytes and is
invisible to every user; a reference to bytes that are not there is a screening product telling a
reviewer that evidence exists when it does not. Both orderings are chosen so the _object_ is the
thing left wrong and never the _reference_. One of those failure modes gets investigated; the
other gets believed.

**Three properties, each verified by planting a violation:**

1. **Nothing is committed unless the object verified.** With a store that reports a checksum not
   matching the bytes, `stageAndCommit` throws **and** `sourceDocumentVersions` holds zero records
   for the tenant. The count assertion is the load-bearing one — a staging bug that throws _and_
   commits would pass a test that only checked the throw, and the record it left behind is the
   dangling success.
2. **The orphan sweep never deletes a referenced object, however old.** A committed document
   aged 400 days survives a sweep. The reconciler _for_ FI-03 deleting a referenced object would
   cause the exact failure FI-03 exists to prevent.
3. **A retention action does not close while the object is still present.** Against a store whose
   `remove` silently does nothing, the action ends `FAILED` with `completedAt` null and
   `lastError` containing "still present" — because "I asked for a delete" is not "the object is
   gone", and an action closing there reports a retention obligation as discharged while the
   bytes sit in the bucket.

Also tested directly: the legal hold raised **after** the action was scheduled still stops the
deletion (the only case that matters — a hold placed when litigation starts must protect the
evidence that litigation is about), a failed delete is retried rather than lost, and the key
carries no publisher, URL or path fragment even when the caller's `sourceUrl` contains
`../../etc/passwd`.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         260 passed
test:invariants    29 passed
test:evaluation    12 passed
test:integration  101 passed  (was 83: +18 in tests/integration/evidence-storage.test.ts)
test:security      93 passed  (was 91: +2 new production guards)
coverage          94.75% statements / 89.43% branches (gate 85/80)
```

The staging and retention paths run against the **real LocalStack S3**, not a fake — that the
store computes its own checksum, that a delete is idempotent, and that a listing paginates are
properties of S3 and not of our code. Failure injection uses the in-process store, because making
a real bucket corrupt bytes on demand means breaking it.

**Left half-done:** nothing within C5, with one thing deliberately not built: **neither sweep is
scheduled in-process.** `sweepOrphans`, `sweepOnce` and `overdue` exist and are called by tests,
ready for a scheduler; C6 owns the scheduling alongside retries and leases. Also **nothing calls
`stageAndCommit` in production yet** — nothing fetches documents until Phase F. The path is built
and tested; it is not yet on a request path. **C6 is not started**: no FR-06 classification, no
DLQ, no lease fencing, no cancellation.

**Found — three things:**

1. **The first version of the orphan sweep's safety guard could never fire, and the test I wrote
   for it was wrong in the same direction.** The guard checked that a key carried the tenant
   prefix — but the sweep _lists_ that prefix, so every key it sees carries it by construction.
   The test's "foreign" key was itself under the prefix, so the test asserted the guard fired when
   it could not. Fixed by asking the narrower and actually useful question: **did this system
   create this object?** Only `keyFor` creates evidence objects, so only keys matching its exact
   shape are eligible for deletion. Recorded as **D-015**. The general lesson is worth more than
   the fix: a guard that cannot fire and a test that cannot fail will agree with each other
   forever.
2. **A batched sweep over shared state, for the third time.** The C4 entry said "expect it a
   third time"; here it is. `RetentionSweeper.sweepOnce` sweeps due actions cross-tenant, so run
   from one integration file it completed the retention fixtures another file was still asserting
   on — two failures that passed in isolation and failed in the suite. Fixed by giving
   `sweepOnce` an optional `tenantId`; the scheduled sweeper omits it, because retention is an
   obligation across every tenant and a per-tenant schedule is a list of tenants to forget to add
   to, while a targeted run (an erasure request, or draining one tenant) passes it. **The rule and
   all three instances are now a table in `docs/architecture.md`**, which is where it should have
   been written after the first one.
3. **`keyFor` had a test-only escape hatch for the object id, and it was a hole in the
   reconciler.** A test that pinned a key could pin one `tenantOfKey` does not recognise, and the
   sweep would then quietly decline to collect exactly the objects that test created. Removed;
   nothing was using it.

Still open and still unaddressed, carried from six previous entries: **`POST /v1/subjects`
declares a permission but no scope**, so a key scoped to `search:read` can create a subject while
`POST /v1/searches` refuses it. It belongs to whoever owns the machine contract.

Carried from C4 and unchanged: **D13 / D-014** — three quarters of search acceptance latency is
the request waiting for the index write. Closes by G8 with Phase F.

**Next session should:** start **C6**. Read `docs/failure-injection-matrix.md` rows FI-06, FI-07,
FI-08, FI-11, FI-12, FI-13 and FI-16 first — they are the specification for its tests. Begin with
the **FR-06 failure classification table as written** (transient network, rate limited, soft
block, hard block, content error — three of the five must not be retried at all); do not invent a
second taxonomy. Every fencing test must have **two workers racing**: a single-worker test proves
nothing about staleness.

**Decisions touched:** **D-015 added** (the orphan sweep deletes only objects this system
created). No open decision closed. D13 / D-014 still open, closing by G8.

---

## 2026-09-11 (night) — Phase C step C4: the workload measurement that closes D12

**Did:**

- **`packages/evaluation/src/workload/population.ts`** — a deterministic, pure generator for the
  haystack the FR-16 names have to be found in. The FR-16 corpus holds sixteen cases, which is a
  correctness fixture and not a workload: every index answers sixteen documents instantly, so a
  latency taken over it would have closed D12 on noise. The sixteen names became the **queries**
  — they were chosen to be hard — and the generator builds the population around them: two exact
  collisions per target, a shared surname, a shared given name, a phonetic neighbour and a
  one-edit neighbour, so retrieval is a discrimination problem rather than a lookup. Eight query
  classes, one per FR-08 name form.
- **`packages/evaluation/src/workload/stats.ts`** — nearest-rank quantiles, `isDecisive` (a
  stated noise margin, so "unconvincing" has a definition rather than a feeling), and `recallOf`,
  which returns `NaN` and never `1` for a class nothing was queried in. A 100% that means
  "untested" is the most dangerous number the file could produce.
- **`scripts/workload/search-index.mjs`** (`pnpm bench:search-index`) — three strategies (naive /
  expanded / batched), three population sizes, recall@k by name form, and API acceptance measured
  against **both** index kinds so the index's contribution is attributable rather than merely
  present. Writes `docs/measurements/c4-search-index.json`.
- **`SearchIndexPort.searchSubjectsBatch`** plus the Meilisearch `/multi-search` implementation —
  added **because the measurement asked for it**, not in anticipation. Decision D-013.
- **`MeilisearchAdapter` now sends `Accept-Encoding: identity`.** See finding 1.
- Docs: `docs/measurements/c4-search-index.md` (the report), `docs/decisions.md` D-002 closed
  with figures plus new D-013 and D-014, `docs/open-decisions.md` D12 closed and D13 opened,
  `START-HERE.md` and `implementation-status.md` moved to C5.

**D12 is closed: Meilisearch.** Not by preference and not by inertia — D-002 set a specific
switch condition (OpenSearch if the matcher needs analysers or multi-field boolean scoring
Meilisearch cannot express), and that condition was tested and **not met**. At 100,000 subjects,
1,050 samples per strategy:

| Strategy                            | matcher p95 |    recall |
| :---------------------------------- | ----------: | --------: |
| naive (raw name, one query)         |      4.33ms |     67.6% |
| expanded (FR-08 forms, sequential)  |     11.20ms |     95.2% |
| **batched (FR-08 forms, one trip)** |  **7.05ms** | **95.2%** |

The matcher **does** need multi-field retrieval — raw-name recall falls 81.9% to 67.6% from
1,000 to 100,000 subjects as the top _k_ fills with lookalikes, and `PARTICLE` recall collapses
100% to 6.3% over that range. Meilisearch **expresses** it, in one round trip, flat across two
orders of magnitude (retrieval p95 5.65 to 6.35ms). No `OpenSearchAdapter` was written;
`SEARCH_INDEX_KIND=opensearch` still throws its not-implemented error.

Closed with limits stated, in D-002: 100,000 subjects not 10⁷, no concurrency test, the
`documents` index untested (nothing extracts text until Phase F), and **the non-Latin path
unmeasured** — `TRANSLITERATION` recall is 0% for every strategy because the only
`TransliterationPort` implementation is `identityTransliteration`, so a Cyrillic query is never
expanded into the Latin forms the index holds. That figure says nothing about Meilisearch, and it
is the likeliest re-open trigger.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         260 passed  (was 241: +19 in packages/evaluation/test/workload)
test:invariants    29 passed
test:evaluation    12 passed
test:integration   83 passed  (was 78: +5 for the batch path)
test:security      91 passed
coverage          94.75% statements / 89.43% branches (gate 85/80)
pnpm bench:search-index --sizes=1000,10000,100000 --repeats=10   full run recorded
```

**Left half-done:** nothing within C4. **C5 and C6 are not started** — no S3 staging, no
reference commit, no consumer loop, no DLQ, no fencing, no cancellation.

**Found — three things, two of them defects:**

1. **A flat ~45ms stall on every gzip response through the Docker Desktop port proxy — and the
   first run nearly recorded it as Meilisearch's latency.** The first measurement put retrieval
   at 47ms p50. It was not query work: `/health` answered in 1.8ms while every search took 45ms;
   32 concurrent searches finished in the same wall time as one, so it was a wait and not work;
   the stall switched on between 967 and 1,256 bytes of response body, 25/25 deterministic; the
   same query from **inside** the Docker network took 2.2ms; and `Accept-Encoding: identity`
   removed it entirely (48.06ms to 3.20ms, 0/20 slow). Node's `fetch` asks for gzip by default,
   so every call the adapter made was paying it. The adapter now asks for `identity`, which is
   right on its own merits — a service-to-service hop carrying small JSON gains nothing from
   compression. Matcher p95 went 52.76ms to 4.38ms. **Worth knowing generally: this is a
   property of the Docker Desktop port proxy on Windows and macOS, not of Meilisearch, and any
   other adapter that talks HTTP to a container from the host will hit it the same way.**
2. **A batched sweep over shared state asserted in one pass — the same trap as the C3
   reconciler, in a second place.** Adding these measurements pushed the outbox past
   `OutboxPublisher`'s batch of 50 and three tests in `tests/integration/transactions.test.ts`
   started failing intermittently. `publishOnce` sweeps the outbox **globally**, so with vitest
   running integration files in parallel a single pass need not reach the event under test — and
   `queue.failNextPublish` could be absorbed by another file's event entirely, which is why the
   test saw `attempt: 0`. Fixed with a bounded drain, and _verified by planting 300 due events_:
   the old tests fail 4 of 14 against that backlog, the fixed ones pass. **The rule, now written
   into both places: a batched sweep over shared state needs a bounded drain, never a single
   call.** This has now cost two sessions; expect it a third time.
3. **Three quarters of search acceptance is the request waiting for the index write.**
   `POST /v1/searches` is 127ms p50 against Meilisearch and 33ms against the in-process index.
   The ~94ms is the post-commit index write being awaited — something the request is explicitly
   allowed to lose and which the FI-10 reconciler already covers. Not changed here: dropping the
   wait trades C3's rule 2 (a write is not `INDEXED` until it is searchable) for latency, and
   that depends on whether anything reads the index between acceptance and the run completing,
   which Phase F's consumer decides. Raised as **D13 / D-014**, closing by G8. The composed total
   search latency is roughly 132ms, of which the matcher is 5.23ms — **4%**. Whatever is worth
   optimising in the search path, it is not the index.

Still open and still unaddressed, carried from five previous entries: **`POST /v1/subjects`
declares a permission but no scope**, so a key scoped to `search:read` can create a subject while
`POST /v1/searches` refuses it. It belongs to whoever owns the machine contract.

**Next session should:** start **C5** — S3 staging and reference commit. Read
`docs/failure-injection-matrix.md` first; it is the specification for the C5 and C6 tests, and
writing either without it means guessing at the boundaries they exist to cover.

**Decisions touched:** **D12 closed — Meilisearch**, recorded with figures in `docs/decisions.md`
D-002 and in `docs/measurements/c4-search-index.md`. **D-013 added** (the port gets a batch query,
because the measurement asked for one). **D-014 / D13 opened** (whether acceptance waits for the
index write; closes by G8 with Phase F). D7 and D11 untouched.

---

## 2026-09-11 (evening) — Phase C step C3: the search index behind the D12 seam

**Did:**

- **`SearchIndexPort`** (`apps/api/src/search-index/search-index.port.ts`) — the application-side
  half of the seam Phase A established in `scripts/bootstrap/search-index.mjs`. Nothing outside
  that directory names a concrete index, which is what keeps **D12 open on the numbers** rather
  than on the cost of changing. Carries the subject and document index shapes, a mandatory
  `tenantId` on every query, and `InMemorySearchIndex` for wiring tests.
- **`MeilisearchAdapter`** — talks to the HTTP API directly. Deliberately _not_ the official
  client, and deliberately the opposite trade from the SQS decision: there the dependency buys
  SigV4 over a rotating credential, which is a security control; here it would buy a thin wrapper
  over four endpoints.
- **`IndexerService`** — projection, write, reconciliation, gate check and tenant rebuild. The
  FI-10 reconciler, which is the row whose symptom is a clean screening result.
- **Wiring:** `SEARCH_INDEX_KIND` / `MEILI_HOST` / `MEILI_MASTER_KEY` in config;
  `SEARCH_INDEX_PORT` provided in `app.module.ts` (`opensearch` throws a clear
  not-implemented error rather than silently falling back, so the configuration cannot lie);
  `IndexerService.ensureIndexes` in `StartupService`; and `SearchesService.create` indexes the
  pinned subject version **after** the commit, outside the transaction, without failing the
  request if the index is unreachable.

**Three properties that carry the weight, each verified by planting a violation:**

1. **A write is not `INDEXED` until the index says it is searchable.** Meilisearch writes are
   asynchronous — the document is not findable when the HTTP call returns. The adapter waits for
   the task. Making it report the enqueue as success fails five tests, including the one that
   searches immediately with no polling.
2. **Every index query filters by tenant.** Removing the filter fails three tests, including two
   tenants holding deliberately identical names.
3. **The reconciler sweeps `indexState: { $ne: 'INDEXED' }`, not a list of states.** Subject
   versions written before C3 carry no `indexState` field at all; changing the sweep to
   `$in: ['PENDING', 'FAILED']` fails the legacy-record test. This is the additive-only migration
   decision from C1 being paid for in practice.

A fourth, not plantable but tested directly: **a search the index cannot answer throws.** An
outage returned as an empty list is "no matches found" for a person nobody actually searched for.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         241 passed
test:invariants    29 passed
test:evaluation    12 passed
test:integration   78 passed  (was 66: +12 in tests/integration/search-index.test.ts)
test:security      91 passed  (was 89: +2 new production guards)
coverage          93.74% statements / 91.33% branches (gate 85/80)
```

The index tests run against the **real Meilisearch** in the local stack, not a fake. Two of the
properties above — asynchronous writes, and whether a filter expression genuinely isolates
tenants — are properties of Meilisearch rather than of our code, and a fake would assert that the
fake works. Failure injection uses the in-process port, because making a real index fail on demand
means breaking it.

**Left half-done:** nothing within C3. **C4, C5 and C6 are not started.** Specifically: no
scheduled reconciler runs in-process (`reconcile()` and `countUnindexed()` exist and are called by
tests, ready for a scheduler); the corpus index is exercised through the record's own fields
because nothing extracts document text yet — Phase F owns supplying `title` and `text`; and no
consumer loop, no S3 staging, no DLQ.

**Found — three things:**

1. **The reconciler is batched, and a test that assumed one pass was wrong.** `reconcile()` moves
   at most 100 records so a backlog cannot monopolise the process — correct — but the shared local
   database has accumulated unindexed subject versions from every previous test run, so a single
   pass never reached the record under test. The tests now drain in a bounded loop. Worth knowing
   for **C4 and for the G4 exit check**: "no unindexed committed documents" is only true after the
   reconciler has actually run to completion, and on this machine that currently means several
   passes. The backlog is local test residue, not a defect, and `pnpm local:reset` clears it.
2. **Adding production guards broke the T09 fixture again, correctly** — the same pattern as C2.
   `SEARCH_INDEX_KIND` defaults to `meilisearch`, so production now demands `MEILI_HOST`, and
   `in-memory` is refused outright in production: it would answer every screening query from a map
   that is empty at startup, which reads as a clean result rather than as an outage. Fixture
   updated, both new guards tested.
3. **`indexState` on `subjectVersions` is a second additive field with the same trap as the
   first.** Any future sweep over an additive status field must exclude the terminal state rather
   than enumerate the others, or it skips every record written before the field existed. That rule
   is now written into the code comment and into this entry, because it will come up a third time.

Still open and still unaddressed, carried from four previous entries: **`POST /v1/subjects`
declares a permission but no scope**, so a key scoped to `search:read` can create a subject while
`POST /v1/searches` refuses it. It belongs to whoever owns the machine contract.

**Next session should:** start **C4**, which **closes D12** — the matcher-latency workload test.
Measure three latencies **separately** over the FR-16 corpus in `packages/evaluation`, with the
FR-08 name-form expansions including transliteration and phonetic keys, since those are what a
naive index handles badly: matcher latency, API acceptance latency, and total search latency.
Record the numbers in `docs/decisions.md` and close D12 there **with the figures**, not as a
preference. The brief's own expectation is that OpenSearch is the likelier answer if the matcher
needs custom analysers or multi-field boolean scoring — and if the measurement says switch, then
writing `OpenSearchAdapter` next to `MeilisearchAdapter` is this phase's work, not a note for
later. State the corpus size and the confidence with the numbers; an unconvincing measurement
leaves D12 open, which is an honest outcome.

**Decisions touched:** none closed. **D12 remains open** and is now genuinely decidable — the seam
is real, both sides of it are small, and C4's numbers are the only thing left. One architecture
note added to `docs/architecture.md` ("The search index is derived state"), recording that MongoDB
wins every disagreement, that a write is only indexed once confirmed searchable, and that an index
outage raises rather than returning an empty result.

---

## 2026-09-11 (later still) — Phase C step C2: transactions, the outbox and the queue seam

**Did:**

- **`TransactionRunner`** (`apps/api/src/persistence/transaction.runner.ts`) — the one place that
  opens a MongoDB transaction, written out rather than delegated to the driver's
  `withTransaction`, because §6.3 asks for three cases to be handled **explicitly** and the
  helper hides the one that matters:
  - a **transaction conflict** (`TransientTransactionError`) retries the whole body — nothing
    committed, so re-running is safe;
  - an **unknown commit outcome** (`UnknownTransactionCommitResult`) retries **the commit alone,
    never the body**. The work may already be durable; re-running it is how duplicate work gets
    committed. When both labels are present, unknown wins — an outcome we did not hear is not an
    outcome we know did not happen. If the deadline passes with the outcome still unknown, the
    caller gets `UnknownCommitOutcomeError`, which says "check the record", not "it failed";
  - a **duplicate key** is surfaced immediately and never retried. It is deterministic, and two
    services in this codebase deliberately _use_ it as their "somebody already did this" signal.
  - Bounded attempts (5), bounded deadline (15 s, shorter than the driver's 120 s because this
    sits behind an HTTP request), full-jitter backoff, injected `sleep`/`random` so the policy is
    testable without waiting for it.
- **Search creation now commits run, audit entry and outbox event together.**
  `SearchesService.create` does its read-only work first — sandbox/live check, entitlement check,
  pinned versions — then opens one transaction that inserts the `SearchRun`, appends the SEC-06
  `AuditEvent` and appends the `OutboxEvent` that will start the work. The subject snapshot is
  resolved **inside** the session (`SubjectsService.create` gained an optional `session`), so a
  snapshot and the run citing it commit together; matrix row FI-02 was updated to say that gap is
  now closed on the search path and why it deliberately stays open on `POST /v1/subjects`.
- **`QueuePort`** (`apps/api/src/jobs/queue.port.ts`) — the job envelope as a contract, a
  defensive `parseEnvelope` that rejects an unknown `envelopeVersion` rather than half-reading it,
  and an `InMemoryQueueAdapter` for tests.
- **`SqsQueueAdapter`** — the production implementation, using `@aws-sdk/client-sqs` (a new
  dependency; see **Found 2**). Long polling at 20 s and batched sends of ten, both cost decisions
  taken now because they are far cheaper to build in than to retrofit. Partial batch failure is
  reported per entry rather than treated as all-or-nothing.
- **`OutboxPublisher`** — the FI-04 reconciler. Polls committed-and-due events, publishes, then
  marks. **Publishes before marking**, deliberately: a crash between them republishes (FI-05),
  which the consumer deduplicates, whereas marking first would lose the event outright. Failed
  publications get a full-jitter backoff and stay in the outbox. Started from `main.ts`, not from
  the module, so importing the app in a test does not silently start draining whatever database
  that test is pointed at.
- **`verifyJobOwnership`** (SEC-01) — the only place allowed to turn an envelope into a tenant.
  It loads the aggregate **by ID alone** and takes the tenant from the record, so a forged
  envelope produces a `TENANT_MISMATCH` security event rather than cross-tenant work. A loader
  scoped by the envelope's own tenant would make the check a tautology, and a test asserts the
  loader is called with the aggregate ID and nothing else. Also returns `STALE_REVISION` for an
  out-of-order delivery (T31).
- **Config and startup guards:** `JOBS_QUEUE_URL`, `AWS_REGION`, `AWS_ENDPOINT_URL`, static AWS
  credentials and `OUTBOX_POLL_MS`. Production startup now **refuses** an endpoint override, a
  static access key, or a missing queue URL — see **Found 1**.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         241 passed  (was 221: +20 transaction/envelope/ownership policy)
test:invariants    29 passed
test:evaluation    12 passed
test:integration   66 passed  (was 52: +14 in tests/integration/transactions.test.ts)
test:security      89 passed  (was 86: +3 new production guards)
coverage          93.74% statements / 91.33% branches (gate 85/80), via CI's own invocation
```

The write-conflict test is a real conflict, not a simulated one: two sessions read-then-write the
same document under snapshot read concern, and the run log shows
`test.conflict.b: conflict on attempt 1; retrying the transaction`. Both increments land and the
counter reaches 2.

Three guards verified by planting a violation:

- making `classifyCommitError` return `RETRY_TRANSACTION` for an unknown commit outcome fails
  exactly the two tests that say the commit is retried and never the work;
- deleting the duplicate-key branch from `classifyBodyError` fails "never retries a duplicate
  key";
- making `verifyJobOwnership` skip its tenant comparison fails "refuses a forged tenant instead
  of doing that tenant work".

**Left half-done:** nothing within C2. **C3 through C6 are not started.** There is still no
consumer loop — `QueuePort.receive` and `verifyJobOwnership` exist and are tested, but nothing
dequeues in a running process, so nothing yet advances a `StageExecution`. No index writer, no S3
staging, no sweeper, no DLQ handling, and the FR-06 classification table is still unused by any
retry path.

**Found — three things:**

1. **Adding a production guard broke a passing test, correctly.** `T09 — accepts a properly
configured production environment` failed once startup began requiring `JOBS_QUEUE_URL`. The
   fixture was updated rather than the rule relaxed: a production API that accepts searches with
   no queue publishes every job into an in-process array that vanishes at restart, so the customer
   is told "queued" and nothing is queued. Two further guards were added alongside it and tested —
   `AWS_ENDPOINT_URL` set in production (that override exists for LocalStack; in production it can
   only mean AWS traffic is being redirected) and static AWS credentials present (a long-lived key
   in an environment variable is what an instance role exists to remove).
2. **`@aws-sdk/client-sqs` is a new dependency in a deliberately lean set** (24 packages). The
   reasoning, now recorded in `docs/architecture.md` under "Jobs and the queue": the bootstrap
   scripts avoid the SDK so a stray profile cannot point them at real AWS, but the application has
   the opposite requirement — it must authenticate with a rotating role credential, and SigV4 over
   a rotating credential is a security control to use rather than re-implement. If that trade is
   ever revisited, the port is the seam and `SqsQueueAdapter` is the only file affected.
3. **The integration duplicate-key test does not prove the duplicate-key guard.** Planting the
   violation showed it still passing: in this MongoDB version a duplicate key inside a transaction
   does not carry `TransientTransactionError`, so the error falls through to `FAIL` whether or not
   the explicit branch exists. The unit test with a synthetic error carrying **both** labels is
   what actually holds the guard. The integration test is still worth keeping — it asserts the
   error reaches the caller in one attempt and quickly — but it should not be cited as the proof.

Still open and still unaddressed, carried from three previous entries: **`POST /v1/subjects`
declares a permission but no scope**, so a key scoped to `search:read` can create a subject while
`POST /v1/searches` refuses it. It belongs to whoever owns the machine contract.

**Next session should:** start **C3** — the search index behind the `SEARCH_INDEX_KIND` seam
Phase A established, with MongoDB as the system of record and the index as derived state. The
reconciliation is a deliverable, not a follow-up: `SourceDocumentService.findUnindexed` and
`countUnindexed` already exist and already treat a `FAILED` index write as unindexed, so what C3
owes is the writer, the re-indexer that drains `indexState: PENDING`, and the gate check that
"no unindexed committed documents" is a query rather than an assumption (matrix row FI-10). Keep
index-specific code inside the seam — C4's measurement may send this to OpenSearch, and code
outside the seam is what would make that migration expensive enough to skip, which decides D12 by
inertia.

**Decisions touched:** none of D1–D12 closed. **D12 stays open**, still closed by C4's measurement
with numbers. Two decisions recorded in `docs/architecture.md` rather than `docs/decisions.md`,
both architecture rather than product: the AWS SDK behind `QueuePort` with its credential
reasoning, and the two SQS cost levers (long polling, batched sends). A missing queue is a startup
refusal rather than a silent fallback, which is a third and is recorded with them.

---

## 2026-09-11 (later) — Phase C steps C0 and C1: the failure matrix and the section 6.3 records

**Did:**

- **C0 — `docs/failure-injection-matrix.md`.** Sixteen rows, FI-01 to FI-16, one per point where
  this service writes to two systems that cannot commit together. Each row states the orphan, the
  named reconciler, the grace window with its basis, and what the user sees in §6.2 vocabulary
  while it is unreconciled. Three ordering rules sit above the table and decide every row:
  **prefer an orphan to a dangling reference** (an orphaned S3 object is swept up; a committed
  reference to an object that was never written tells a reviewer evidence exists when it does
  not); **every reconciler needs a grace window longer than the longest legitimate in-flight gap**
  (a sweep that deletes "orphans" younger than the slowest healthy upload deletes live work, and
  does it under load); and **no unreconciled state may overstate knowledge** — a run may report
  `RUNNING`/`INCOMPLETE`, never `NO_MATCHES_FOUND`. A row-to-test map ties FI rows to T22, T23,
  T24, T29, T30, T31, T41, the G4 exit condition, SEC-06 and D-012, and the file names the four
  boundary families it deliberately does **not** cover (fetch, extraction, export, multi-node) so
  their absence is a decision rather than an oversight.
- **C1 — the section 6.3 records this phase needs**, in `apps/api/src/persistence/`:
  - **`StageExecutionService`** — `(tenantId, runId, stageKey)` unique, which _is_ the
    duplicate-work guard rather than an optimisation; lease acquisition as one atomic
    `findOneAndUpdate`; `completeFenced` checking lease token **and** revision; `cancelRun`
    bumping revision so a late completion fails its fence; `reclaimExpiredLease` returning or
    abandoning; and `discardedAttempts`, so a refused write is visible rather than silent.
  - **`OutboxService`** — `append` takes a `ClientSession` as a **required** parameter, so an
    outbox event written outside its transaction is a type error rather than a code-review note.
  - **`InboxReceiptService`** — generalises the old `idempotencyKeys` into `inboxReceipts` with a
    `channel` (`http-idempotency`, or `queue:<consumer>`). `IdempotencyService` is now a thin
    HTTP wrapper that keeps the canonical request hash and the 409; the queue path will use the
    same claim protocol, so the two cannot drift into disagreeing about "already done".
  - **`SourceDocumentService`** — refuses outright to commit a reference whose stored object was
    never verified; commits `indexState: 'PENDING'` so an unindexed document is findable;
    `findUnindexed` counts `FAILED` as unindexed, because excluding it would make the gate check
    pass by omitting exactly the documents it asks about. Four date fields, each with precision,
    and a missing date stays null.
  - **`AuditService`** — per-tenant gapless sequence, hash chain, `append` requiring a session,
    no update or delete method at all, and `verifyChain` returning `SEQUENCE_GAP`, `BROKEN_LINK`,
    `ALTERED_ENTRY` or `CHECKPOINT_MISMATCH`. See **Found 1**.
  - **`RetentionService`** — mark the reference, then delete the object; the action is not closed
    until the object is gone; a hold stops it where it stands; overdue past the window is an
    operator concern, not a silent retry.
- **FR-06 failure classification moved into the pure package**,
  `packages/domain/src/reliability/failure-classification.ts`: the seven classes with their
  policies as data, `classifyFailure`, full-jitter `backoffDelayMs` with injected randomness, and
  `shouldRetry`. C6 wires it instead of writing a second taxonomy next to the retry loop.
- **The migration and audit-integrity decisions** are written into `docs/architecture.md` under
  a new "Persistence conventions (Phase C)" section, along with a table of the **five** indexes
  that deliberately do not lead with `tenantId` and why each one cannot.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         221 passed  (was 206: +15 FR-06 classification)
test:invariants    29 passed
test:evaluation    12 passed
test:integration   52 passed  (was 14: +38 in tests/integration/persistence.test.ts)
test:security      86 passed  (unchanged - the idempotency refactor regressed nothing)
coverage          93.74% statements / 91.33% branches, via CI's own invocation
                  (vitest --project unit --project invariants --project evaluation --coverage)
                  gate is 85/80
```

Three guards were verified by planting a violation rather than by assuming:

- deleting the `leaseToken` and `revision` conditions from `completeFenced` fails exactly the two
  fencing tests (FI-11 stale worker, FI-12 cancellation) and nothing else;
- dropping `result` from the audited hash fails "detects an altered entry (SEC-06)";
- making the unverified-reference check unreachable fails "refuses to commit a reference whose
  object was never verified (FI-03)".

A caution about coverage for the next session: `vitest run --project unit --coverage` alone
reports 84.56% and fails the gate, because domain code is also exercised by the invariants and
evaluation projects. The CI line above is the real gate. Do not "fix" a coverage failure that is
really a wrong invocation.

**Left half-done:** nothing within C0 or C1. **C2 through C6 are not started.** Specifically:
there is no transaction runner, so nothing yet commits state, audit and outbox together; nothing
calls any of the new records from a real code path — `searchRuns` is still created and never
advanced, no stage is ever ensured, no audit entry is written by a real action; there is no
publisher, no queue consumer, no index writer, no S3 staging and no sweeper. The reconcilers the
matrix names are specified, not built.

**Found — three things:**

1. **SEC-06 cannot be satisfied by code in this repository, and the design now says so.** A hash
   chain detects a removed or altered entry. It does not detect an attacker with the entry
   writer's credentials rewriting an entry and recomputing every hash after it — the chain then
   verifies. So `AuditCheckpointWriter` is a port; the only implementation,
   `LocalAuditCheckpointWriter`, shares MongoDB and its credentials with the entry writer and
   stamps every checkpoint `protection: 'NONE_LOCAL_STACK'`, so nothing built on these records can
   claim tamper-evidence this deployment does not have. A test asserts that value, and another
   test demonstrates the wholesale-rewrite attack being caught **only** by the checkpoint. What
   production must supply is enumerated in `docs/architecture.md`; G11 verifies it.
2. **The migration question answered itself during C1.** Renaming `idempotencyKeys` to
   `inboxReceipts` is exactly the kind of change `StartupService`'s idempotent index creation
   cannot handle — it transforms nothing and silently abandons the old collection. It was safe
   only because the data was local, disposable and at most 24 hours old. The recorded decision is
   **additive-only, no migration runner, until the first deployment holding data anyone depends
   on**, with four concrete requirements listed for the runner that must land before then. The
   old `idempotencyKeys` collection still exists in the local database with stale documents; it
   is unread and `pnpm local:reset` clears it.
3. **The audit sequence serialises audited writes per tenant.** A gapless per-tenant sequence
   needs an `$inc` on a counter inside the same transaction, so two audited writes for one tenant
   conflict and one retries. That cost was accepted deliberately: allocating the sequence outside
   the transaction leaves a hole whenever a transaction aborts, which is indistinguishable from a
   deletion and would make the tamper signal useless by crying wolf. If C2's transaction-conflict
   retry policy shows this to be a real throughput problem, the fix is a per-tenant batched
   sequence — not a non-gapless one.

Still open and still unaddressed, carried from the previous two entries: **`POST /v1/subjects`
declares a permission but no scope**, so a key scoped to `search:read` can create a subject while
`POST /v1/searches` refuses it. It belongs to whoever owns the machine contract.

**Next session should:** start **C2** — the transaction runner. One place that opens a MongoDB
transaction and one retry policy around it, handling transaction conflicts, **unknown commit
outcomes** (the one people forget: a commit whose result never came back is not a failure, and
treating it as one is how work gets duplicated) and duplicate-key errors explicitly. Then wire
the first real caller through it: a search creation that commits the `SearchRun`, its
`StageExecution` rows, its `AuditEvent` and its `OutboxEvent` together. The seams are already in
place — `OutboxService.append` and `AuditService.append` both require a `ClientSession`, and
every other write accepts an optional one. Read `docs/failure-injection-matrix.md` rows FI-04,
FI-05 and FI-09 before writing it; they are the specification.

**Decisions touched:** none closed. **D12 stays open** and is still closed by C4's measurement
with numbers in `docs/decisions.md`; Meilisearch remains a working assumption behind the
`SEARCH_INDEX_KIND` seam and nothing in C1 touched it. **D-012** (30-day evidence retention) now
has a record that can carry it out, but the retention _policy value_ is unchanged and still
placeholder-flagged. Two new decisions are recorded in `docs/architecture.md` rather than in
`docs/decisions.md`, because both are architecture rather than product: additive-only migrations
until first deployment, and the audit checkpoint as a port with an honestly-labelled local
implementation.

---

## 2026-09-11 (end of session) — Phase C brief expanded; nothing in C started

**Did:**

- **Expanded `docs/execution/phase-c.md` from an outline into a full brief**, in the shape of
  `phase-a.md`. It was deliberately left an outline until Phase B's real schemas existed, and
  they do now. The brief adds:
  - a **"What already exists"** table mapping all eleven collections Phase B created to their
    §6.3 record names, with honest state notes — `searchRuns` is created but never advanced and
    its `revision` field is unused, `idempotencyKeys` is only partly an `InboxReceipt`, and
    `apiKeyAuditEvents` is append-only in practice but not enforced;
  - the conventions worth keeping, including the **two deliberate exceptions** to
    tenant-leading indexes and why each exists;
  - a new **C0 — write the failure-injection matrix first**, ahead of the original C1–C6, as
    `docs/failure-injection-matrix.md`. The outline already required it before C6; it is now its
    own step because it is equally the specification for C2 and C5, and a matrix written
    afterwards describes the code that was written rather than the property that was wanted;
  - scope discipline made explicit: build the §6.3 records **this** phase needs, not all
    thirty-five. `AssociationAssertion`, `GraphSnapshot`, `Finding`, `QueryPlan`, `QueryExecution`
    and `EgressIdentity` are named as Phase D–F's, with "do not build them because the schema felt
    incomplete" in the Do-not list.
- **Renamed `api_keys` → `apiKeyCredentials` and `api_key_audit` → `apiKeyAuditEvents`.** That
  snake_case was introduced earlier the same day and was the only pair not following the
  convention every other collection uses (the §6.3 record name, camelCase, plural). Fixed now so
  C1 does not inherit two conventions and then have to pick one.
- Moved the `START-HERE.md` brief pointer to say the brief is expanded and to start at C0.

**Verified:** `lint`, `typecheck`, `format:check` clean; `test:security` 86 passed after the
rename; `test:unit` 206. No behaviour changed — the rename is a collection name and its two test
references.

**Left half-done — nothing. No Phase C code exists.** C0 has not been started: there is no
`docs/failure-injection-matrix.md` yet. The brief is a plan, not progress, and G4 is still
**Not started** in `implementation-status.md`.

**Found — two things the brief now carries, that the outline did not:**

1. **SEC-06 rules out the obvious audit implementation.** It states that a hash chain stored with
   the same unrestricted writer is _not sufficient by itself_, and that business roles must not be
   able to update or delete entries. So C1's `AuditEvent` needs its integrity checkpoint designed
   before it is written, and if a local stack cannot protect one properly, the honest output is a
   recorded statement of what production needs — not a chain that only looks tamper-evident.
2. **There is no migration runner.** `StartupService` creates indexes idempotently, which is fine
   for additive indexes and not fine for any change that has to transform existing documents. C1
   must decide whether Phase C needs a real runner or whether additive-only is honest, and record
   the answer in `docs/architecture.md`. Right now "we can migrate" is untested.

Also still open from the previous entry, and not addressed: **`POST /v1/subjects` declares a
permission but no scope**, so a key scoped to `search:read` can create a subject while
`POST /v1/searches` refuses it. Possibly intended, but currently an accident of which routes
carry `@RequireScope`. It belongs to whoever owns the machine contract.

**Next session should:** start Phase C at **C0** — write `docs/failure-injection-matrix.md`, one
row per two-system boundary (after S3 upload / before reference commit; after reference commit /
before outbox publish; after outbox read / before delivery; after delivery / before receipt write;
after stage state write / before acknowledgement; after external request / before
acknowledgement), each with what is orphaned, what reconciles it, and what the user sees while it
is unreconciled. Then C1. Read `docs/execution/phase-c.md` first — its "Read before starting"
list is narrow on purpose, and the two source specification documents in the parent directory
must not be read end to end.

**Decisions touched:** none. **D12 stays open** and is closed by C4's measurement, with numbers
in `docs/decisions.md` — not by preference, and not by inertia. Meilisearch remains a working
assumption behind the `SEARCH_INDEX_KIND` seam; if C4 favours OpenSearch, switching is Phase C's
work rather than a note for later.

---

## 2026-09-11 (last) — Phase B complete: T08, T07 and T68 closed; gate G3 met

**Did:**

- **T08 — CSRF and CORS, as executable checks.** The CSRF guard already existed; what did not
  exist was any test that it fires. `tests/security/session-lifecycle.test.ts` drives the
  assembled application with real cookies: a write with a valid session and no token is refused,
  so is one carrying **another session's** token, and so is one carrying a token truncated by a
  single character (which would pass a length-insensitive or short-circuiting comparison). The
  same write succeeds once the matching token is sent — without that control, the four refusals
  above would also pass if writes were simply broken. A bearer-authenticated machine client is
  deliberately **not** asked for a CSRF token, because a browser cannot set an `Authorization`
  header on its own and demanding one would be theatre that breaks integrators.
- **CORS moved out of the bootstrap** into `apps/api/src/common/cors.ts`, so the exact object
  the application installs can be asserted: origins are always an explicit list, never `true`,
  never `'*'`, never a function that could reflect the request, and **`false` when nothing is
  configured**. A missing configuration must fail closed, or the development convenience is what
  ships.
- **T07 — logout, revocation, expiry and key rotation.** Fourteen tests covering the property
  that actually matters: old access stops working. A logged-out cookie is refused; a revoked
  session is refused on writes as well as reads (401, not 403 — the credential is gone, so it is
  not a CSRF failure); `revokeAllForSubject` kills every session a person holds, not just the
  browser they signed out of; an idle-expired and an absolutely-expired session are both
  refused, the latter even while actively used; and an unknown session ID is answered
  identically to a revoked one, so session IDs cannot be probed. Rotation is tested in
  `auth.test.ts`: during provider overlap both keys verify, and once the retired key is
  withdrawn a token signed with it fails on the **signature** — a verifier that keeps honouring
  a retired key makes rotation meaningless, since the compromised key is still a signing key.
- **T68 — the API key lifecycle**, `apps/api/src/tenancy/api-key.service.ts`, and it is wired
  into `AuthGuard` rather than left as unreachable code. Keys look like
  `erly_<environment>_<keyId>_<secret>`: the environment is in the credential so a live key
  pasted into a sandbox configuration is visible as a mistake, and the key ID makes verification
  one indexed lookup instead of hashing the presented secret against every key a tenant owns.
  The secret is returned **once**, from `create`, and only a SHA-256 hash is stored — there is
  deliberately no method that returns a secret, because an API that can show a key again will be
  asked to. Rotation keeps the key's identity and invalidates the previous secret with no grace
  period; revocation is immediate, idempotent and permanent; a revoked key cannot be rotated back
  into service; and creation, rotation and revocation each write an audit entry with an actor and
  a reason. `lastUsedAt` is updated on every successful verification, which is what makes an
  unused key identifiable and therefore safe to revoke.
- **The API key is a documented credential.** `apiKey` was added to the OpenAPI security schemes
  with its own `ApiKey` scheme rather than a second flavour of `Bearer`. Regenerating the
  panel's client produced **no diff**: `openapi-typescript` does not emit security schemes as
  types, because they describe how to authenticate rather than what a payload looks like. The
  panel is unaffected — it authenticates with the session cookie and never holds a key.
- Registered `ApiKeyService` in the module and its indexes in `StartupService`.

**Verified:**

```
backend:   lint clean · typecheck clean · format:check clean
           test:unit 206 passed · test:invariants 29 · test:evaluation 12
           test:integration 14 passed
           test:security 86 passed  (was 48: +4 rotation/CORS, +14 session, +18 API key)
           verify:local 7 of 8 ok; only e2e unimplemented (Phase G)
frontend:  lint clean · build clean · format:check clean · test:unit 35 passed
```

Three guards verified by planting a violation rather than by assuming:

- making `CsrfGuard.canActivate` return `true` unconditionally fails exactly the three CSRF
  refusal tests;
- deleting the revocation check in `ApiKeyService.verify` fails "refuses immediately after
  revocation";
- (from the earlier session) editing the committed OpenAPI document, and adding an undocumented
  route, each fail their own guard.

**Left half-done:** nothing in Phase B. Gate G3 is **Complete** and the active phase pointer now
reads **C**. `phase-c.md` is still an outline; expanding it is the first task of that phase, by
design — its detail depends on what Phase B revealed, and writing it earlier would harden
guesses into instructions.

**Found — three things:**

1. **`format:check` and the OpenAPI drift test contradicted each other.** The generator wrote
   `JSON.stringify(…, null, 2)`, prettier wanted its own layout for the same file, and no
   committed file satisfied both — each check demanded the other's failure. The generator now
   formats its output with the repository's prettier configuration, so there is one right answer.
   Worth remembering for any future generated artefact that prettier also globs.
2. **A test tenant needs more than an entitlement to create a search.** The API key tests first
   failed at 403, then at 422: a tenant must also have an **active taxonomy version and policy
   version**, which only `local:bootstrap` seeds. The tests now use the seeded `tenant-alpha` and
   `tenant-beta` wherever they create a search — inventing a tenant produced a 422 that said
   nothing about the key under test, which would have made a green result meaningless.
3. **`POST /v1/subjects` declares a permission but no scope.** So a key scoped to `search:read`
   can still create a subject, while `POST /v1/searches` correctly refuses it. That may be
   intentional — creating a subject is not running a search — but it is worth a deliberate
   decision rather than an accident of which routes carry `@RequireScope`. Not changed here,
   because changing it silently would alter the machine contract.

**Next session should:** ~~expand `docs/execution/phase-c.md`~~ — done in the entry above. Start
at C0, then C1 — the section 6.3 record schemas, migrations and indexes, with tenant context
leading every key. Note that C4, the matcher-latency workload test, is what settles open
decision **D12**; Meilisearch is still only a working assumption behind the `SEARCH_INDEX_KIND`
seam.

**Decisions touched:** none closed. D-007 is respected — the API key service is provider-side,
and tenant self-service key management still answers 501. The scope question in **Found 3** is
new and unrecorded; it belongs to whoever owns the machine contract.

---

## 2026-09-11 (later) — Phase B steps B1 and B9: the OpenAPI document and the panel's client

**Did:**

- **`packages/contracts/src/openapi/`** — the document is _generated from the zod schemas_,
  never hand-written. `components.ts` converts a registry of twenty schemas in a single pass
  (one pass matters: converting them separately would inline `Alias` into three parents under
  three names instead of referencing one component) and builds the error responses from the
  existing `ERROR_STATUS` map, so nobody chooses a status by hand and a code cannot document
  itself under the wrong one. `document.ts` carries the paths, both security schemes, the
  shared parameters and the examples.
- **Two new contract schemas**, because the panel needs them typed and neither existed:
  `sessionInfoSchema` (`auth/session.ts`) and `healthStatusSchema` / `dependencyHealthSchema`
  (`common/health.ts`). The health and auth controllers now declare these as their return
  types, so a field added to a response without being published fails `pnpm typecheck`.
- **`pnpm openapi:generate`** writes `openapi/openapi.json`. It is committed: a contract change
  arrives as a reviewable diff in the pull request that caused it, rather than as a runtime
  surprise in a consumer.
- **`apps/api/test/openapi-document.test.ts`** — four checks tying the document to reality: the
  committed file matches what the builder produces, every route the controllers serve is
  documented, every method is documented, and nothing is documented that no controller serves.
  Route metadata is read from the controller classes with `Reflect`, not by booting the app —
  a contract check that only runs with MongoDB and Keycloak up is a check that stops running.
- **`packages/contracts/test/openapi.test.ts`** — eleven property checks: every `$ref` resolves,
  operation IDs are unique, every authenticated operation documents 401 and 403, exactly four
  operations are public, every error code appears once under the right status, request bodies
  are strict, and the three result dimensions stay three fields.
- **Frontend `pnpm api:generate`** now works. It emits `src/lib/api/generated/schema.ts` (via
  `openapi-typescript`), `operations.ts` (one function per callable operation, emitted by this
  repository's own script) and `index.ts`, all prettier-formatted and committed. Reserved FR-15
  routes get **no** function — a typed function for a route that answers 501 is an invitation
  to call it — and sign-in is exported as `AUTH_LOGIN_PATH` to navigate to, not a function to
  fetch.
- **`src/lib/api/generated.test.ts`** — seven tests: every published callable operation has a
  function, reserved routes have none, business calls go to `/v1`, auth and health do not, path
  parameters are escaped, and the idempotency key and CSRF token still reach the transport.

**Verified:**

```
backend:   lint clean · typecheck clean · format:check clean
           test:unit 206 passed (+15) · test:invariants 29 · test:evaluation 12
           test:integration 14 passed · test:security 48 passed   (real stack, bootstrapped)
           verify:local  7 of 8 suites ok; only e2e unimplemented (Phase G)
frontend:  lint clean · build clean · format:check clean · test:unit 35 passed (+8)
```

Both new guards were verified by planting a violation, not by assuming they work:

- editing one summary in `openapi/openapi.json` fails the drift test with "run
  `pnpm openapi:generate`"; restoring it passes.
- adding an undocumented `@Get('v1/probe')` to `HealthController` fails the route-coverage test
  naming the route; removing it passes.

**Left half-done — Phase B is still NOT complete.** B1–B9 are done, but three definition-of-done
items remain, and the previous handoff did not name them:

- **T07** — logout, revocation and key rotation. `POST /auth/logout` exists and revokes the
  session, but there is **no test** that old access stops working, and no JWKS rotation test.
- **T08** — CSRF and CORS. The production startup guard rejects a wildcard origin (tested), but
  there is no test that a state-changing request without `X-CSRF-Token` is refused by the
  running API.
- **T68** — environment-scoped API keys do not exist at all. The only API-key surface is the
  reserved route answering 501. B5 asks for hashed material, one-time secret display, rotation,
  revocation, expiry, last-used tracking and scopes.

G3 stays **Partial** in `implementation-status.md` for exactly these three.

**Found — four things, all real:**

1. **`GET /auth/session` was documented without a 403.** The property test caught it: the route
   requires `search:read`, so it can deny. A documented route that omits 401/403 reads as
   public, and the panel would treat a denial as an unexpected failure rather than offering a
   way back in. The document was fixed, not the test.
2. **A zod `.refine` does not survive into JSON Schema.** `createSearchSchema` requires exactly
   one of `subjectRef` and `subjectSnapshot`; that rule is a refinement, so the generated types
   let a caller supply neither or both. The API still rejects it at runtime, but the panel will
   not be stopped at compile time. Worth an explicit runtime check in the page that builds the
   request, and worth remembering before relying on any other refinement for safety.
3. **"Document order" for response statuses is not recoverable from parsed JSON.**
   `Object.keys` returns integer-like keys ascending, so `createSearch` — which declares 202
   then 200 — generated a client typed on the **200 idempotent replay** as its normal outcome.
   The emitter now ranks statuses explicitly (202, 201, 200, …). The generated type happened to
   be identical here, but the documented meaning was the opposite of what the service does.
4. **The hand-written client could only reach `/v1`.** Auth and health are `VERSION_NEUTRAL` on
   the service, so `authSession` would have requested `/v1/auth/session` and 404'd, which reads
   as an outage. `RequestOptions` gained a `basePath` (default `/v1`) and the generated
   operations for those routes pass an empty one. This is the **only** hand-written change to
   `client.ts`; transport, session, CSRF and error typing are untouched.

**Next session should:** close the three remaining Phase B items, in this order — T08 first
(a CSRF-rejection test against the running API, the cheapest and the one protecting a live
surface), then T07 (assert that a revoked session's cookie stops working, and that a rotated
signing key invalidates old tokens), then T68 (build the API key lifecycle from B5). Only then
move the G3 gate to Complete and set the active phase to C.

**Decisions touched:** none closed. D-007 is now visible to integrators rather than implied —
the four reserved routes are published with their 501 and the decision named in the description.

---

## 2026-09-11 — four open decisions closed by product

**Did:** recorded D-009 to D-012 in `docs/decisions.md`, marked D1, D3, D8 and D10 closed in
`docs/open-decisions.md`, and updated the seeded configuration: all seventeen categories,
Costa Rica as the only jurisdiction, Spanish and English requested, evidence retention
configurable at 30 days.

**Verified:** `pnpm local:bootstrap` re-run clean; seeded taxonomy reads 17 categories, CR,
es+en both UNMEASURED, retention 30. `pnpm verify:local` unchanged — 7 of 8 suites ok.

**Left half-done:** nothing from this change. Phase B still needs the OpenAPI document (B1)
and the panel client generation (B9).

**Found — three consequences of the Costa Rica choice that are now critical path:**

1. **Every free source named in the plan is UK or US.** Companies House, SEC EDGAR and
   CourtListener do not cover Costa Rica. CR source discovery is now Phase D critical path,
   not a detail. Candidates listed in decision D-010; none verified, none approved.
2. **The Spanish lexicon cannot be machine-translated** (strategy §6.2). It needs a
   Spanish-reading reviewer, and it is a Phase D deliverable rather than a translation task.
3. **Name-only input means most searches will be unresolved.** Correct behaviour under Axis A,
   but it sets reviewer workload and feeds open decision D5. A Costa Rican name-frequency
   distribution is now worth loading, or the FR-08 frequency penalty never fires for common
   surnames.

**Next session should:** finish Phase B — generate the OpenAPI document, then wire the panel
client. See [`phase-b.md`](./phase-b.md).

**Decisions touched:** D1, D3, D8, D10 all **closed**. D5 (reviewer capacity) is now more
load-bearing than before, because name-only input drives the queue.

---

## 2026-09-10 (later still) — Phase B, steps B1–B8 (gate G3 partial)

**Did:**

- **Permissions** (`packages/domain/src/access/permissions.ts`) — pure policy, so it lives in
  the domain package and is the same decision for an HTTP guard, a worker, an export job or a
  webhook. All nine roles, explicit permission list, `decideAccess`, four-eyes `canApprove`,
  break-glass expiry. `platform_operator` genuinely cannot read evidence.
- **`packages/contracts`** — zod schemas: the error contract with status and retryability
  mappings, FR-01 subject intake, search creation, the three result dimensions, cursor
  pagination. Schemas are `.strict()`, so an unknown field is rejected rather than dropped.
- **`apps/api`** — NestJS. Global `AuthGuard` → `CsrfGuard` → `PermissionGuard`, so a new
  route is protected by default and must opt out with `@Public()`. Token verifier (jose,
  asymmetric algorithms only), BFF session service (hashed session IDs, idle + absolute
  expiry, constant-time CSRF), entitlements with version pinning, subjects, idempotent search
  creation, reserved 501 routes, health, config guards, and the OIDC login flow.
- **Tests** — 23 in `tests/security/auth.test.ts` (real generated keys, not a mocked
  verifier), 25 in `tests/security/tenant-isolation.test.ts` (real API, real MongoDB).

**Verified:**

```
pnpm lint / typecheck   clean
pnpm test:unit          191 passed   (+26 permission tests)
pnpm test:invariants     29 passed
pnpm test:evaluation     12 passed
pnpm test:integration    14 passed
pnpm test:security       48 passed   <- new
pnpm verify:local        7 of 8 suites ok; only e2e unimplemented (Phase G)
```

The OIDC flow was verified against the **real Keycloak**, not a stub: `/auth/login` returns a
302 carrying `code_challenge_method=S256`, sets both handshake cookies, and `/auth/callback`
with a forged `state` is rejected.

**Left half-done — Phase B is NOT complete:**

- **B1 (part)** — the zod schemas exist, but no OpenAPI document is generated from them yet.
- **B9** — the panel's `pnpm api:generate` still exits non-zero, because it needs that
  document. The frontend cannot generate its typed client yet.

Everything else in B1–B8 is done. G3 is marked **Partial** in `implementation-status.md` for
exactly this reason.

**Found — five problems, all real:**

1. **esbuild does not emit decorator metadata**, so NestJS constructor DI resolved to
   `undefined` under vitest while working fine under `tsc`. Fixed with explicit `@Inject()`
   on every injected constructor parameter, which removes the dependency on
   `emitDecoratorMetadata` entirely rather than papering over it with an SWC plugin.
2. **Health endpoints were version-prefixed** to `/v1/health/live` by `defaultVersion`, so a
   load balancer would have had to know the API version — and a version bump would silently
   turn every probe into a 404, which reads as "the service is down". Health and the auth
   redirect flow are now `VERSION_NEUTRAL`.
3. **Circular import crash at startup.** `auth.controller.ts` imported the `APP_CONFIG` DI
   token from `app.module.ts`, which imports every controller. ESM temporal dead zone, and
   the error ("Cannot access 'APP_CONFIG' before initialization") pointed at the wrong file.
   Tokens now live in `apps/api/src/tokens.ts`.
4. **A brittle integration assertion.** T01 asserted there were _exactly_ two tenants, so it
   broke the moment the T63 security test created one of its own. It now asserts the two
   seeded tenants are **present**, which is what the bootstrap actually promises.
5. **T63's cleanup was not in a `finally`**, so one failed run left a `tenant-nocap-*` behind
   and broke an unrelated suite afterwards — with the failure pointing at the wrong test.
   Cleanup is now unconditional.

**Next session should:** finish Phase B — generate the OpenAPI document from the zod schemas
in `packages/contracts` (B1), then wire the frontend's `pnpm api:generate` to it (B9). After
that, Phase C. See [`phase-b.md`](./phase-b.md).

**Decisions touched:**

- **D10** (minimum identity data an integrator must supply) is **still open** and now
  materially matters: the FR-01 subject schema is implemented as the permissive superset —
  full name required, everything else optional, sparse identity searchable but left
  unresolved. That is a defensible default and it is recorded here as an assumption, but it
  should be confirmed by product and Zquence rather than hardened by silence.
- No other decision closed.

---

## 2026-09-10 (later) — Phase A complete: the local stack is real (gate G1)

**Did:**

- **A1** `infra/local/keycloak/realm-export.json`: realm `adverse-search-local`, panel client
  (auth-code + PKCE, confidential, exchanged by the BFF), two machine clients bound to
  different tenants, all nine roles from section 4.2, and ten synthetic users across
  `tenant-alpha` and `tenant-beta` — including a `platform_operator` who exists specifically
  to be denied evidence access in T06.
- **A2** `scripts/bootstrap/aws.mjs`: idempotent S3 bucket (public access blocked, versioning
  on) and an SQS jobs queue with a DLQ and redrive policy.
- **A3** `scripts/bootstrap/search-index.mjs`: `subjects` and `documents` indexes behind the
  `SEARCH_INDEX_KIND` seam. OpenSearch throws a clear not-implemented error rather than
  silently doing nothing, so decision D12 stays genuinely open.
- **A4** `scripts/local-bootstrap.mjs` + `scripts/bootstrap/seed-data.mjs`: idempotent,
  refuses any non-local endpoint, refuses to run unless `ADVERSE_SEARCH_MODE=mock`, and seeds
  two tenants, entitlement/taxonomy/policy versions and two fixture sources — every record
  carrying `mode: "MOCK"` so a fixture cannot pass as a live result (T55).
- **A5** `tests/integration/local-stack.test.ts`: T01 and T02 as 14 automated tests.
  `verify-local.mjs` now marks `integration` as implemented.
- Fixed `scripts/local-up.mjs` so it waits only on long-running services.

**Verified:**

```
pnpm local:up          7/7 services healthy
pnpm local:bootstrap   completes; re-running is a clean no-op
pnpm test:integration  14 passed
pnpm verify:local      lint, typecheck, unit, invariants, evaluation, integration all ok
                       security and e2e reported UNIMPLEMENTED (Phase B and G), so it
                       still exits non-zero - which is the intended behaviour at this gate
```

T02 was done properly rather than assumed: full `pnpm local:down` (containers removed), then
`pnpm local:up`, then `pnpm test:integration` **without re-bootstrapping** — 14 passed.
Seeded state genuinely survives a container recreate.

**Left half-done:** nothing in Phase A.

**Found — five problems that only surface by actually running it:**

1. **Port 27017 was already taken** by another MongoDB on this machine. Rather than fight for
   default ports on a dev box running several stacks, all host ports moved to a dedicated
   280xx range: mongo 28017, meilisearch 28700, localstack 28566, keycloak 28080, searxng
   28888, model runtime 28434, fixtures 28090. Container-internal ports are unchanged.
2. **Keycloak could not write its H2 volume** — the named volume is root-owned and Keycloak
   runs as uid 1000. Fixed by removing that volume entirely. That is the better design
   anyway: the realm is imported from the committed JSON on every start, so a persisted dev
   database cannot silently diverge from `realm-export.json` when someone edits it in the
   admin UI.
3. **The Keycloak healthcheck hung.** The image ships neither curl nor wget, so the check uses
   bash `/dev/tcp` — but without a `Connection: close` header the read never returns. The
   container reported unhealthy while serving perfectly. Fixed with the header plus a timeout.
4. **S3 bucket creation returned a 400** complaining about an "unspecified location
   constraint". The bootstrap was sending `application/x-www-form-urlencoded` for S3, so
   LocalStack never parsed the XML body. S3 now gets `application/xml`; SQS keeps the form
   encoding. Worth noting: the first fix attempt silently did not apply, and only _appeared_
   to work because the bucket already existed from manual debugging. It was re-verified by
   deleting the bucket and re-running from a genuinely empty state.
5. **`pnpm local:up` reported a healthy stack as broken.** `mongo-init` is a one-shot job that
   initiates the replica set and exits 0, and `docker compose up --wait` treats an exited
   container as a failure. Now the script starts everything, then waits only on the
   long-running services. A false alarm here is worse than no check, because it teaches people
   to ignore the check.

**Next session should:** start Phase B step B1 — create `packages/contracts` with the
versioned schemas and the generated OpenAPI document. See [`phase-b.md`](./phase-b.md).

**Decisions touched:** none closed.

- **D12** stays open behind the `SEARCH_INDEX_KIND` seam; Meilisearch is running as the
  working assumption and Phase C's workload test decides it.
- **D7** stays open. Ollama runs but **no model is pulled**, deliberately — pulling one to
  make a health check look better would decide D7 by accident. Phase F benchmarks candidates
  on the labelled set.
- **D1, D3, D8** have placeholder values seeded (GB only, eight categories, no retention
  rule), each carrying an `assumption` field on the record so the placeholder cannot quietly
  become the decision. They still need people outside engineering, and they close in Phase D.
- **D10** still needs product and Zquence, and it shapes the Phase B subject schema.

---

## 2026-09-10 — Phases G0 and G2 complete; frontend foundation; planning documents

**Did:**

- Scaffolded the backend pnpm workspace: Node 22 LTS, TypeScript strict with
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, eslint (type-aware, strict),
  prettier, vitest with named projects (`unit`, `invariants`, `evaluation`, `integration`,
  `security`), GitHub Actions CI.
- Built `packages/domain` — pure, no I/O. FR-03 taxonomy and exclusions, the build-gating
  lexicon audit, FR-09 stage ladder 0–15 with transitions, party roles, FR-02 tenure
  labelling, FR-08 name forms plus the transliteration port, all four axes, the FR-11 banding
  engine, FR-10 clustering, FR-04 query families with bounding, and the section 6.2 result
  dimensions with the FR-13 no-match statement.
- Built `packages/evaluation` — pure. Dataset types, split by entity **and** syndication
  family with a leakage assertion, a 16-case hard-negative seed corpus, the I1–I10 invariant
  harness, and FR-16 metrics.
- Wrote `infra/local/docker-compose.yml` (Mongo replica set, Meilisearch, LocalStack,
  Keycloak, SearXNG, Ollama, fixture server) and the `local-up` / `local-reset` /
  `verify-local` scripts.
- Wrote `docs/`: architecture, decisions, open-decisions, requirements-traceability,
  coverage-matrix (empty template), implementation-status, delivery-plan.
- Frontend repo: Vite 6 + React 18 + TS strict, router and TanStack Query, the hand-written
  API transport (`src/lib/api/client.ts`), and `src/app/boundaries.test.ts` enforcing
  decision D-001. No FR-14 page built — deliberate, the API does not exist.

**Verified:**

```
backend:   lint clean · typecheck clean
           test:unit 165 passed · test:invariants 29 passed · test:evaluation 12 passed
           coverage 92.95% statements / 90.65% branches (gate 85/80)
           docker compose config --quiet  → valid
frontend:  lint clean · typecheck clean · test:unit 27 passed · build clean
```

The D-001 boundary test was verified by planting a violation: importing `@erly/adverse-domain`
into a probe file fails the suite with an explanatory message; removing it passes again.

**Left half-done:** Gate G1. The compose stack has **never been started**. `local:bootstrap`
and `dev` are unimplemented and exit non-zero.

**Found:**

1. `infra/local/keycloak/` is empty, but compose mounts it as Keycloak's realm-import
   directory. The stack would come up with no realm, clients, roles or users. This is Phase A
   step A1.
2. The lexicon audit could be evaded by hyphenation — `Trans-gender` folded to `trans gender`
   and missed the stem `transgender`, so a protected characteristic could have reached an
   outbound query. Fixed by also comparing separator-free forms; regression test added.
3. Fixed event-date buckets split events across boundaries. Two reports of one event six days
   apart landed in different 30-day buckets and were never compared — silently splitting the
   event, under-counting independence, and therefore lowering the band. The bucket is now a
   blocking hint only and the merge decision compares real dates. Decision D-006.
4. A `VIA_ROLE` finding did not explain its ceiling to the reviewer. Band was correct; the
   rationale now always states that VIA_ROLE can never reach CORROBORATED.
5. A well-evidenced acquittal bands as `CORROBORATED`. This is correct — the band states how
   well the evidence supports the connection, and what is corroborated is an acquittal — but
   it is easy to misread in a results list. Raised as new open decision **D11**, must close by
   Phase G. Reasoning in `docs/decisions.md` D-008.

**Next session should:** start Phase A step A1 — write `infra/local/keycloak/realm-export.json`.
See [`phase-a.md`](./phase-a.md).

**Decisions touched:** D-001 (two-repo split) accepted and enforced. D-006, D-008 recorded.
**D11 and D12 opened.** D12 (search index) is deferred to Phase C's workload test; compose
carries Meilisearch as a working assumption only.
