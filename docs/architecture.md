# Architecture

## What this service is, and what it is not

It retrieves published material about a subject, resolves whether that material refers to
the subject, classifies what is reported and at what procedural stage, and grades how well
the evidence supports the connection.

It is **not** a criminal record check, **not** a proof of identity, **not** a determination
of guilt, and **not** a sanctions-list engine. A designation found in reporting is a lead to
verify against the primary list, never a finding. Target Platform keeps its sanctions.io integration
and makes the final compliance decision.

## Repository split

Two repositories, per decision D-001:

- `adverse-search-service` — this repository. API, worker, domain, providers,
  persistence, evaluation, infrastructure.
- `adverse-search-frontend` — the React control panel.

The panel reaches the domain only through the versioned HTTP API, using a client generated
from the OpenAPI document this repository produces. There is no second matching engine in
the browser.

## Package layout

```
apps/
  api/             NestJS HTTP API, BFF session, validation, authorisation, commands
  worker/          Queue consumers: association resolution, discovery, fetch,
                   extraction, classification, clustering, report assembly
packages/
  contracts/       Public schemas, versioned types, OpenAPI generation
  domain/          PURE. State machines, identity rules, taxonomy, stage ladder,
                   banding rules, invariants, permission decisions
  providers/       Discovery, registry, fetch and extraction adapters
  persistence/     Tenant-scoped repositories, transactions, indexes, outbox, S3 metadata
  observability/   Correlation context, redaction, metric conventions
  client/          Typed Node client and Target Platform integration examples
  evaluation/      PURE. Labelled dataset, metrics, I1-I10 invariant harness
infra/
  local/           Compose, emulator bootstrap, OIDC realm, SearXNG, model runtime, fixtures
  aws/             Infrastructure code, disabled until deployment is authorised
```

### The purity boundary

`packages/domain` and `packages/evaluation` perform **no I/O**: no database, no network, no
filesystem, no clock reads. Callers pass `asOf` explicitly.

This is load-bearing, not stylistic. `pnpm test:invariants` runs the I1-I10 release gate on
every pull request, and it must run on a clean checkout with nothing else started. A gate
that needs a database running is a gate that gets skipped when it is inconvenient — which is
exactly when it matters.

The cost is that ICU transliteration, libpostal and NER cannot be imported by the domain
package. They are injected as ports (`TransliterationPort`), implemented in
`packages/providers`. `matchNameForms` cannot match across scripts on its own and its tests
say so rather than pretending otherwise.

## The pipeline

```
intake ─→ association graph ─→ query plan ─→ discovery cascade ─→ relevance filter
                                                                         │
                                                                         ▼
  banding ←─ clustering ←─ classification ←─ extraction ←─ fetch gate ─→ fetch
     │
     ▼
  review ─→ refresh (F8 outcome pass) ─→ new linked run
```

Each stage is durable and independently restartable. Stage state, audit reference and outbox
events commit transactionally; S3, search-index and queue publication happen outside the
transaction and are reconciled through the outbox.

### Why clustering runs before banding

Independence is an input to Axis D, and Axis D is an input to the band. Ten copies of one
wire story are one independent report, and the system cannot know that until it has grouped
them. Banding before clustering would let syndication inflate a band — invariant I6.

### Why the four axes are computed independently

The four axes answer four different questions, and combining them early is how screening
products produce their most damaging errors:

| Axis            | Question                                                                         |
| :-------------- | :------------------------------------------------------------------------------- |
| A — Identity    | Is the person in this document the subject?                                      |
| B — Attribution | Is the subject connected to the entity, and was the connection live at the time? |
| C — Event       | What conduct, in what role, at what stage, named by whom?                        |
| D — Authority   | How much weight does this publisher carry, and how independent is it?            |

They are combined only at banding, by explicit versioned rules, and the contributing values
remain visible after combination. Invariant I1 exists because the tempting shortcut —
letting a severe event or a prestigious publisher raise confidence that it is the right
person — is precisely wrong. A national newspaper reporting a conviction has not established
that the convicted person is the customer.

## Data flow and trust boundaries

```
        ┌─────────────┐  signed, scoped token   ┌──────────────┐
Target Platform │  integrator │ ──────────────────────▶ │  apps/api    │
        └─────────────┘                          └──────┬───────┘
                                                        │ tenant-scoped commands
        ┌─────────────┐  OIDC + BFF session             ▼
 human  │control panel│ ──────────────────────▶ ┌──────────────┐   ┌──────────┐
        └─────────────┘                          │ MongoDB (RS) │◀─▶│  outbox  │
                                                 └──────┬───────┘   └────┬─────┘
                                                        │                │ SQS
                                                        ▼                ▼
                                                 ┌──────────────┐  ┌──────────────┐
                                                 │ search index │  │ apps/worker  │
                                                 └──────────────┘  └──────┬───────┘
                                                                          │
                          ╔═══════════════ egress boundary ═══════════════╪═════╗
                          ║  fetch gate: registry approval, robots, URL   │     ║
                          ║  policy, SSRF validation, budgets, relevance  ▼     ║
                          ║                                        free sources ║
                          ╚════════════════════════════════════════════════════╝
                                                        │
                                                        ▼
                                                 ┌──────────────┐
                                                 │  S3 evidence │
                                                 └──────────────┘
```

**Trust boundaries, and what crosses them:**

- **Integrator → API.** A signed, scoped token authorises the selected tenant. A raw
  client-supplied tenant header that is not bound to authenticated entitlement is rejected.
  `externalSubjectRef` and `externalCaseRef` are recorded, but neither is a database lookup
  instruction nor an authorisation credential.
- **Worker → external source.** Everything outbound passes the fetch gate. Every request
  records tenant, job, subject, query, source, egress identity, region and policy decision.
  An unattributable outbound request is a defect.
- **Fetched document → extraction model.** Document content is **data**. Instructions inside
  a document are ignored and logged as a security event. The model receives cleaned text, a
  schema and bounded context — no tools, no credentials, no network, no authority to modify
  policy, scope or thresholds.
- **Model output → anything.** Model output is untrusted. It is never interpolated into
  commands, HTML, queries or fetch destinations, and every cited span is validated against
  the stored document before a finding can exist. Model self-reported confidence is discarded
  and never shown to a reviewer.

## Threat model summary

The full model lives in `docs/threat-model.md`. The headline risks this architecture is
shaped around:

| Risk                                          | Control                                                                                                                                                                  |
| :-------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong person attributed a crime               | Four independent axes; contradiction blocks resolution (I2); name-frequency prior; `NAMESAKE_DISTINGUISHED` role                                                         |
| A matter overstated                           | Stage ladder with span-supported transitions only (I4); mandatory display rules; settlement never an admission (I5)                                                      |
| A stale accusation shown forever              | F8 outcome queries mandatory and re-run on refresh; `OUTCOME_UNKNOWN` queue; acquittals at equal prominence (I7)                                                         |
| A broken parser reported as a clean result    | Coverage state separate from findings state (I10); scheduled contract tests on undocumented sources; per-source recall monitoring                                        |
| Cross-tenant disclosure                       | Scope enforced in handlers, repositories, index queries, queue envelopes, workers, caches, evidence retrieval, exports and webhooks; missing tenant context fails closed |
| Prompt injection from a fetched document      | Content is data; spans validated against the stored document; entity grounding rejects invented names; security event logged                                             |
| SSRF via a discovered URL                     | Allowlisted schemes/ports/domains; resolved-address validation; pinned resolution against rebinding; same restrictions for Playwright subresources and webhooks          |
| Protected characteristics used as query terms | Build-gating lexicon audit; exclusions enforced at classification time, not display time                                                                                 |

## What is deliberately kept out of the dependency set

No graph database, no Redis, no vector database. Indexed MongoDB serves report lookup and
one-hop graph traversal. Any of these may be introduced later, but only when a documented
query or workload test justifies it — and MongoDB is not mistaken for an internet search
engine, which is why a real search index is in the mandatory stack.

## Persistence conventions (Phase C)

The collection naming and versioning rules were set in Phase B and are unchanged: a collection
is named for its section 6.3 record, camelCase, plural; a version is immutable and an update
writes a new version and supersedes the old one; nothing trusts a tenant that came from a
request, and Phase C extends that rule to queue envelopes.

Three things Phase C decided that were previously unstated.

### Indexes that do not lead with tenant context

Section 6.3 requires tenant-owned keys and indexes to start with tenant context, and every
tenant-owned index in this service does. There are now five documented exceptions, each of
which exists because the query genuinely has no tenant to start from:

| Index                                                                               | Why it cannot lead with `tenantId`                                                                                                                 |
| :---------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKeyCredentials.keyId`                                                           | The presented credential carries no tenant. The lookup is what _establishes_ the tenant                                                            |
| `nameFrequencyProfiles`                                                             | Population data is shared and must never become tenant-owned, or a common surname is re-measured per customer                                      |
| `stageExecutions.{state, nextAttemptAt}` and `{state, leaseExpiresAt}`              | Work claiming and lease sweeping are platform processes. A per-tenant sweep leaves a crashed worker's stage stuck in whichever tenant nobody swept |
| `outboxEvents.{publishedAt, nextAttemptAt}`                                         | Publication is a platform process and must see the oldest due event anywhere                                                                       |
| `sourceDocumentVersions.{indexState, createdAt}`, `retentionActions.{state, dueAt}` | Reconciliation and retention are platform obligations; scoping them per tenant is how one tenant's unindexed evidence goes unnoticed               |

These are **index** exceptions, not authorisation exceptions. Every one of them feeds a
platform process that then acts on a single record whose `tenantId` it reads from the record
itself — never from a queue envelope, a request header or a caller's claim (SEC-01). Fairness
between tenants in work claiming is REL-02's problem and is solved in the claim query, not by
an index that makes cross-tenant work invisible.

### Migrations

**Decision: additive-only, with no migration runner, until the first production deployment.**

`StartupService` creates indexes idempotently at boot. That is honest for additive index
creation and it is _not_ honest for anything that has to transform existing documents — a
renamed field, a re-shaped value, a split collection. Saying "we can migrate" without having
migrated anything is a claim, not a capability.

What makes additive-only defensible right now is narrow and will expire: there is no
production deployment, no customer data, and the local stack is rebuilt with
`pnpm local:reset` whenever a shape changes. Phase C produced one change that a runner would
have been needed for — `idempotencyKeys` became `inboxReceipts` with a `channel` field — and it
was safe only because the data in it was local, disposable and at most 24 hours old.

**What this commits us to.** A migration runner is required before the first deployment that
holds data anyone depends on, and it must land with:

- ordered, versioned, idempotent migrations recorded in a `schemaMigrations` collection;
- a forward migration and a documented recovery for each — not necessarily a reversible one,
  but never nothing;
- execution as a deliberate step, not as a side effect of a process starting, so that ten API
  instances booting at once do not each begin transforming the same documents;
- a test that runs them against a database seeded with the _previous_ shape, since a migration
  verified only against an empty database has not been verified.

Until then, any change requiring a document transformation is a change that must either wait
for the runner or be accompanied by one. This paragraph is the record that the choice was
made rather than overlooked. Gate G11 re-checks it.

### Audit integrity

SEC-06 explicitly rules out the obvious implementation: _a hash chain stored with the same
unrestricted writer is not sufficient by itself._ The design honours that by separating what
the code can do from what the deployment must do.

**What the code does.** `auditEvents` carries a per-tenant gapless sequence and a hash chain
over entry content and predecessor hash. Entries commit **inside** the business transaction, so
there is no window in which an action happens unrecorded. `AuditService` exposes no update and
no delete method to any caller. `verifyChain` detects a sequence gap, a broken link, an altered
entry and a checkpoint mismatch.

**What the code cannot do, stated rather than papered over.** An attacker holding the entry
writer's credentials can rewrite an entry, recompute every hash after it and leave a chain that
verifies. Detection of _that_ requires a checkpoint written by a principal the entry writer
cannot act as. This is a deployment property. No amount of additional code in this repository
creates it.

So `AuditCheckpointWriter` is a port. The only implementation today is
`LocalAuditCheckpointWriter`, which shares MongoDB and its credentials with the entry writer,
and every checkpoint it writes carries `protection: 'NONE_LOCAL_STACK'` so that nothing built
on these records can accidentally claim tamper-evidence this deployment does not have.

**What production must supply**, and what gate G11 verifies rather than this phase:

1. Separate audit-write and audit-read permissions, neither held by the business roles.
2. A checkpoint writer with its own principal — a different IAM role, a different datastore, or
   an external notary — which the entry-writing principal cannot assume. Periodic, covering the
   current head, with the appropriate `protection` value recorded.
3. A verifier that runs on a schedule and alerts on any non-`ok` verdict, including entries
   accumulating past the last checkpoint.
4. Retention reconciled with SEC-05: minimal permitted facts, not a permanent duplicate of the
   evidence text.

Local emulation is not evidence that any of this works, exactly as it is not for S3 IAM and KMS
(SEC-03).

### Jobs and the queue

The queue is reached through `QueuePort`. Two things about the implementation are decisions
rather than defaults.

**The AWS SDK, not the unsigned REST calls the bootstrap scripts use.** Those scripts talk to
LocalStack, which accepts unsigned requests, and keeping the SDK out of them is what stops a
stray AWS profile pointing a bootstrap script at real infrastructure. The _application_ has the
opposite requirement: in production it authenticates with a credential that rotates — an instance
role, a task role, IRSA — and SigV4 over a rotating credential is a security control to be used,
not re-implemented. The SDK's credential chain is the production answer and is the same code path
locally, with only the endpoint overridden. Startup refuses an `AWS_ENDPOINT_URL` or a static
access key in production, for exactly that reason.

**Two cost levers are built in rather than retrofitted.** Long polling (`WaitTimeSeconds: 20`),
because short polling bills a request per empty receive and on an idle queue that is the whole
bill; and batched sends of up to ten envelopes, which SQS charges as one request, so a run
fanning out to nine sources costs one request rather than nine. Both are cheaper to adopt now
than to introduce later against code that assumed per-message calls.

**A missing queue is a refusal, not a fallback.** With no `JOBS_QUEUE_URL` the service uses an
in-process queue and says so loudly, and production startup rejects the configuration outright. A
service that accepts a search and publishes its job into a variable that vanishes at restart has
told a customer "queued" and queued nothing — which is worse than refusing to start.

### The search index is derived state

MongoDB is the system of record; the index is a fast way to find things that are already durably
recorded. If the two disagree, MongoDB wins and the index is rebuilt — `IndexerService.rebuildTenant`
purges and re-projects, and that is always a correct repair. The index is never read to decide
what is true.

Two rules follow from that and are easy to lose:

- **A write is `INDEXED` only once the index confirms it is searchable.** Meilisearch writes are
  asynchronous; the document is not findable when the HTTP call returns. Marking on the enqueue
  would record a document as indexed while the matcher cannot see it, and the symptom of that is
  a screening result with nothing in it.
- **A search the index cannot answer raises.** Returning an empty list on an outage reports
  "no matches found" for a person who was never actually searched for. Coverage state exists to
  carry that distinction (section 6.2, invariant I10); an empty array destroys it.

Deletion propagates here too. SEC-05 requires restriction and erasure to reach indexes as well as
evidence objects and exports: a restricted record that is still searchable is still disclosed,
whatever the record says.

### Evidence objects: stage, verify, commit — and never the inverse

MongoDB holds the reference; S3 holds the bytes. They cannot be committed together — S3 cannot
join a MongoDB transaction — so the **ordering** is what stands in for one, and a reconciler is
what makes the ordering safe. The rule runs in both directions:

| Direction        | Order                                    | Worst case if it crashes half-way             |
| :--------------- | :--------------------------------------- | :-------------------------------------------- |
| Writing (FI-03)  | stage object → verify → commit reference | an object nobody references — swept after 6 h |
| Deleting (FI-15) | mark reference expired → delete object   | an object past its expiry — swept, retried    |

Both leave the _object_ wrong and the _reference_ right, and never the reverse. That asymmetry is
the entire point: an orphaned object costs a few kilobytes and is invisible to every user, while
a reference to bytes that are not there is a screening product telling a reviewer that evidence
exists when it does not. One of those failure modes gets investigated; the other gets believed.

Three properties hold it up:

1. **Verification is the store's arithmetic, not ours.** After the write the object is read back
   and S3's own SHA-256 and byte count are compared against what we intended to store. Trusting
   the checksum we computed would confirm that we can hash a buffer, which was never the risk —
   the risk is a truncated or corrupted transfer, and only the far end can see that.
2. **`verifiedAt` is set in one place and required in another.** `EvidenceStagingService` is the
   only writer of it, and `SourceDocumentService.commit` refuses a reference without it. Two
   locks on the same door, so a future caller assembling a reference by hand fails loudly rather
   than committing a plausible-looking lie.
3. **An action is not closed until the object is confirmed gone.** "I asked for a delete" is not
   "the object is gone". The retention sweeper re-reads after deleting and leaves the action open
   if anything is still there.

#### Object keys, and what the sweep is allowed to delete

Keys are built in exactly one function (`keyFor`) and have exactly one shape:

```
evidence/<region>/<tenantId>/<YYYY-MM-DD>/<uuid>
```

No caller input appears anywhere in it (SEC-03). A key derived from a publisher name or a source
URL would leak the subject of a screening into object metadata, and a key carrying a
caller-supplied path is a traversal waiting to be found. Tenant leads, as it leads every
tenant-owned index key, which is what makes the orphan sweep a prefix listing rather than a
full-bucket scan.

The orphan sweep deletes **only objects whose keys match that shape**, and counts everything else
as unattributable. This matters more than it looks: the sweep lists a tenant prefix, so every key
it sees starts with that prefix by construction — a guard that only re-checked the prefix would
be unreachable, which is a guard that does nothing. The question worth asking is narrower: _did
this system create this object?_ Anything else under the prefix — uploaded by hand, left by an
older layout, or named with a literal `..` (S3 treats it as text, not traversal) — is left alone.
A scheduled job that deletes objects it did not create is a bucket-wide delete wearing a prefix
filter, and it only has to be wrong once.

The sweep also reads the committed key set **after** listing the bucket, never before. An object
staged during the sweep appears in a later listing but its reference is already in the set, so it
is protected. The inverse order has a window in which a just-committed object looks like an
orphan — and deleting it would produce the exact failure FI-03 exists to prevent, caused by the
reconciler for it.

### A batched sweep over shared state needs a bounded drain

This has now been paid for three times, in three different components, and it is written here so
there is not a fourth:

| Component                          | Sweep                               | Batch |
| :--------------------------------- | :---------------------------------- | ----: |
| `IndexerService.reconcile` (C3)    | unindexed documents, cross-tenant   |   100 |
| `OutboxPublisher.publishOnce` (C2) | unpublished events, cross-tenant    |    50 |
| `RetentionSweeper.sweepOnce` (C5)  | due retention actions, cross-tenant |   100 |

Each is batched so one backlog cannot monopolise the process, and each is **cross-tenant by
design** because the obligation it discharges is. Two consequences follow, and both have bitten:

1. **"Everything is done" is only true after the sweep has run to completion.** A caller — a test,
   or a gate check — that calls the sweep once and asserts on the result is asserting that its own
   record happened to fall in the first batch. Drain in a bounded loop; bounded, so a broken
   sweeper fails rather than hangs.
2. **A global sweep run in a test will act on other tests' fixtures.** Integration files run in
   parallel against one database, so a sweeper started by one file completes records another file
   is still asserting on. `RetentionSweeper.sweepOnce` therefore accepts an optional `tenantId`.
   The scheduled sweeper omits it — retention is an obligation across every tenant, and a
   per-tenant schedule is a list of tenants to forget to add to — but a targeted run passes it,
   which is also what an erasure request wants.

### Consuming a message: one sequence, and why it is in that order

Every queued message goes through `JobConsumer.handle` in one fixed order, and the order is not
a style choice — each guard only holds if the ones before it ran.

```
parse → poison check → ownership (SEC-01) → receipt (FI-07) → stage identity (FI-07)
      → lease (FI-11) → work → fenced write (FI-11/FI-12) → acknowledge
```

**Ownership precedes everything that touches data.** The envelope's `tenantId` is a routing
hint. The tenant the code acts on comes from the persisted record, loaded by aggregate ID with
no tenant filter — a loader scoped by the envelope's own claim would turn the check into a
tautology, reporting a forged tenant as a harmless replay rather than as an attempted crossing.

**Two layers of duplicate protection, not one.** The `InboxReceipt` is cheap and expires; stage
identity — `(tenantId, runId, stageKey)`, unique — does not. The second layer is what §6.3 means
by "persisted run/stage identity remains the final guard", and it is tested by deleting the
receipt outright and redelivering.

**Handling returns a disposition; it performs no transport call.** `ACKNOWLEDGE`, `RETRY_LATER`
with a delay, or `DEAD_LETTER` with a reason. The runtime carries it out. This is what makes the
cases that matter assertable without a queue: "a cancelled run's late completion is discarded"
is a returned value, not an inference from which SQS calls were observed.

**A refused fence is never retried.** If the lease moved or the revision changed, this worker's
result is not wanted — something else is authoritative now. Retrying is precisely how a stale
worker eventually wins. The message is acknowledged and the refusal is counted on the record as
a discarded attempt, because "we threw away work" is a fact an operator may need and a reviewer
must never see presented as a finding.

**The backoff is served by the transport, not by sleeping.** `RETRY_LATER` sets the message's
visibility timeout. A worker that slept for sixty seconds would be a worker doing nothing for
sixty seconds, and a process that died mid-sleep would lose the retry. The delay belongs to the
message, not to whoever was holding it. `Retry-After` is passed through exactly: a source that
says "wait 30 seconds" has told us the answer.

### Two dead-letter mechanisms, because they answer different questions

SQS has a redrive policy (`maxReceiveCount: 5`) and the consumer also sends explicitly. Both are
wanted:

- **Redrive is a backstop** for a message the consumer keeps failing on for reasons nobody has
  classified. It takes five deliveries to notice and records nothing about why.
- **An explicit dead-letter is a decision.** A forged tenant, an unparsable body, an event type
  nothing handles — each will fail identically on every future delivery. Waiting for the
  backstop costs four more attempts at something already judged, and produces a DLQ entry with
  no reason attached, so the operator who finds it starts from nothing.

A dead-letter is never a delete. The original body is preserved byte for byte with a reason
attached, because a message this service refused is evidence of a producer bug, a configuration
error or an attack, and quiet disposal is the one outcome that must not happen to it. That is
why `JOBS_DEAD_LETTER_QUEUE_URL` is a production startup guard: without it, exactly those
messages would be held in process memory and lost at restart.

## Administrative records and the rights gate (Phase D)

`apps/api/src/admin/` holds two services and one controller.

**`VersionedRecordService`** applies one lifecycle to three record kinds. It writes the shape the
Phase A bootstrap already seeded — `{sourceId, version}` for sources, `{tenantId, version}` for
taxonomy and policy, with the lifecycle in a `status` field — so there is one registry, not an
administrable one beside a seeded one. Full reasoning in `docs/decisions.md` D-018.

Three things about it are worth knowing before changing it:

- **Every transition is one transaction** carrying the new status, its audit entry, and (on
  activation) the supersede of the previous active version. There is never a moment with two
  active versions and never one with none.
- **A refusal is audited outside that transaction.** A denial appended inside the transaction
  that then throws is rolled back with it, and the refusal leaves no trace at all — which is the
  opposite of what SEC-06 wants, since an attempt to approve one's own version is exactly what an
  auditor needs to see. `auditDenial` therefore runs in a transaction of its own after the
  business transaction has aborted. This was found by a test that asserted the audit entry
  existed rather than asserting the 403; the 403 was always correct and the trail was empty.
- **Every version it writes is stamped with the operating mode** (`MOCK` / `LIVE`). Test T55
  requires that a fixture cannot pass as a live result, and the label lives on the record rather
  than in a config flag. A version proposed through the admin API in a mock stack is as much a
  fixture as a seeded one.

**`CapabilityCoverageService`** stores what the service can and cannot do per jurisdiction, and
builds the coverage statement. The collection `capabilityCoverage` is **shared, not tenant-owned**
— it joins `nameFrequencyProfiles` as a documented cross-tenant exception, on the same reasoning:
what is possible in a country is a property of the service and its approved sources, not of a
customer, and making it per-tenant invites one tenant's coverage to drift from the truth.

### Route ordering, which is load-bearing

`ReservedController` must be registered **before** `AdminController` in `app.module.ts`. Nest
matches routes in registration order, and `/v1/admin/:collection` otherwise shadows the reserved
`/v1/admin/plans`, turning a documented 501 (FR-15, D-007) into a 403 from a permission check on
a route that was never meant to exist. There is a test for it in `tests/security/admin-routes.test.ts`.

### `@RequirePermission` now accepts alternatives

A route serving several record kinds behind one path needs `source:propose` for a source and
`taxonomy:propose` for a taxonomy; declaring one of them locks the other kind's administrator out
of their own records. `RequirePermission(...permissions)` admits a caller holding **any** of the
declared permissions, and the service then enforces the exact one against the record it has
loaded. With a single permission — every other route in the service — the behaviour is unchanged.
The route-level check is a coarse gate, never the whole check.

---

## The six source seams (Phase D step D2)

FR-05 names six ports. All six are defined in `apps/api/src/sources`, all six have deterministic
mocks in `apps/api/src/sources/mock`, and exactly one has a real adapter.

| Port                  | Cascade rungs | Real adapter in Phase D               |
| :-------------------- | :------------ | :------------------------------------ |
| `NewsDiscoveryPort`   | 2, 3, 4       | none — Phase E                        |
| `WebDiscoveryPort`    | 5, 6          | none — Phase E                        |
| `PrimarySourcePort`   | 1             | none — Phase E                        |
| `CompanyRegistryPort` | —             | **UK Companies House, GB only**       |
| `EvidenceFetchPort`   | —             | none — Phase E                        |
| `ExtractionModelPort` | —             | none — Phase F selects the model (D7) |

All six are defined now rather than one at a time, because a seam invented at the moment its
first adapter is written is shaped by that adapter. Defining them against the specification, with
mocks that must satisfy them, is what stops `WebDiscoveryPort` becoming "whatever SearXNG
returns".

**The Companies House adapter is not Costa Rican coverage.** D-010 enables Costa Rica only; this
adapter declares `jurisdictions: ['GB']` and `assertJurisdictionCovered` throws on anything else.
It exists as the proving ground for the port and the FR-02 graph — real pagination, real failure
modes, a real partial date of birth. Costa Rica has no free automatable officer-level source at
all (D0, open decision **D14**), and no adapter changes that.

### What the shared vocabulary carries

`source-adapter.ts` holds three things every port shares.

**The outcome** — `SourceOutcome<T>`, four statuses, decision D-021. A caller cannot reach the
data without matching on what happened.

**Provenance on the record** — adapter id, source id, parser version, stability class, mode and
retrieval time ride with the data rather than being looked up afterwards. FR-05's volatility
control keys the scheduled contract test off the parser version and D5's breaker off the
stability class; both are useless if the figure has to be recovered from the registry later.

**The mode rule** — `MockModeWitness`, decision D-022. A live process cannot construct a mock.

### Where the gates live, and where they do not

Two refusals in this directory are **throws**, not `FAILED` outcomes, and the distinction is
load-bearing. A `FAILED` outcome means a source was asked and did not answer, which opens a
coverage gap for that source. But asking a British register about Costa Rica, or fetching a URL
whose robots position was never established, are **our** decisions not to ask. Recording either as
a coverage gap would put a line in a coverage statement for an attempt that was never made.

`EvidenceFetchPort` takes a `FetchAuthorisation` as a required input rather than deriving one.
The gate decision and the gate action are separate so the decision can be audited on its own —
and so a second, subtly different copy of the gate cannot grow inside the HTTP client.

### Source content conformance

`assertContentConforms` (`apps/api/src/admin/source-content.ts`) checks a source version's content
against the FR-05 field list at **submit** and again at **activation**, never at propose — see
decision D-023 for why a draft is allowed to be incomplete. `mode` is not a content field: it is
stamped on the envelope from the running configuration, and content that declares it is rejected
(T55).

---

## Indexed sources: a publisher read on a schedule, not per query

`apps/api/src/sources/indexed/` holds the second way this service can read a publisher. A
query-time source answers one planned query per request; an **indexed** source is downloaded
whole on its own cadence, parsed into a local snapshot, and searched in our own database. See
decision **D-062** for why that is a source shape rather than a cache.

It is one lifecycle over two artifact shapes:

| Connector          | Artifact                   | Sources                                              |
| :----------------- | :------------------------- | :--------------------------------------------------- |
| `INDEXED_BULK_XML` | one complete list document | OFAC SDN, OFAC non-SDN, UK Sanctions List, UNSC, EU   |
| `INDEXED_BULK_JSON`| one complete list document | World Bank debarred firms                             |
| `INDEXED_RSS`      | a rolling publication feed | DOJ, CFTC, FTC, FCA warnings                          |

**The pieces, and what each one is not allowed to do.**

- `IndexedSourceScheduler` — a due check every five minutes. It owns **no** cadence of its own;
  `refreshIntervalMs` and `staleAfterMs` come from the approved registry version. `refreshDue`
  walks sources **sequentially** on purpose: one tick must not become a burst at a publisher that
  hosts several of our sources.
- `IndexedSourceRefreshService` — the lifecycle. Fetch and parse happen entirely before the
  transaction, and only a validated artifact reaches `commitSnapshot` (D-063). A refresh is
  claimed with a ten-minute database lease, so two processes cannot refresh one source at once,
  and an in-process promise map collapses concurrent callers onto one attempt.
- `ScheduledArtifactTransportAdapter` — the only path to the network, through
  `FetchGateService.authoriseScheduledArtifact` and then the same `EvidenceFetchPort` a document
  fetch uses. It therefore inherits the SEC-02 address policy, the recorded request ceiling, the
  breaker and the budget without a second implementation of any of them (D-065).
- `IndexedSourceRepository` — snapshot storage and candidate retrieval. A snapshot version is
  derived from the artifact hash, so the same bytes can never produce two snapshot identities.
- `IndexedSourceSearchService` — retrieval and banding. It runs **once per subject**, not once per
  planned query, and it runs whether or not the ladder ran.

**The projection.** Every parser produces `NormalizedSourceRecord`: names, aliases,
original-script names, dates with an explicit precision, places, nationalities, identifiers,
programmes, listing dates, and `rawEvidence` carrying the publisher's own fields untouched. Every
normalised field is nullable **because normalising a dataset must never turn an absence into an
invented fact** — a designation with no recorded date of birth must come out with no date of
birth, not with a plausible one.

**Where it sits in the pipeline.** `SearchPipeline.execute` calls the search service before the
ladder is built and prepends its findings and source outcomes to the run's. The outcomes are
reported at **cascade rung 0**, and they say which snapshot was read and how many records were in
it:

| Snapshot state                             | Outcome     |
| :----------------------------------------- | :---------- |
| none usable                                 | `FAILED`    |
| usable, but stale or last refresh failed    | `PARTIAL`   |
| usable and current                          | `COMPLETED` |

The `FAILED` row is the important one. A source with no snapshot is a **coverage gap**, never a
source that looked and found nothing — which is the same rule D-061 states for query-time
sources, applied to a shape that could otherwise fail silently.

**Provenance.** A finding from a snapshot carries `sourceRecordId`, `sourceSnapshotVersion`,
`parserVersion` and `rawEvidenceHash` on its document, so a reviewer can name the row of the
published list it came from and the parse that produced it. Those four fields are optional on the
finding contract and absent for fetched documents — they describe how this evidence exists, and a
fetched HTML page has no row id.

**Operating it.** `GET /v1/admin/indexed-sources` (needs `platform:read_health`) reports
usability, freshness, row counts and the last failure per source.
`POST /v1/admin/indexed-sources/{sourceId}/refresh` (needs `source:approve` **and** the header
`X-Allow-Publisher-Contact: true`) runs one refresh now. Postman folder 16 exercises both.

---

## The association graph (Phase D step D3)

FR-02, in `apps/api/src/associations` with the decisions in `packages/domain/src/association`.

### Resolution is an identity grade

`resolveOfficer` builds an Axis A `IdentityFactor` list out of what a register published and
hands it to the **same `gradeIdentity`** a document match uses. There is no register-specific
notion of "matched enough"; a second one would drift from the document one and the two would
disagree about the same person in the same run.

| Grade          | Status                 | The graph may…                                   |
| :------------- | :--------------------- | :----------------------------------------------- |
| `CORROBORATED` | `RESOLVED`             | attach the companies and anchor queries on them  |
| `PARTIAL`      | `CANDIDATE_FOR_REVIEW` | show the companies, anchor nothing               |
| `WEAK`         | `UNRESOLVED`           | show the officer, attach nothing                 |
| `CONTRADICTED` | `CONTRADICTED`         | nothing — the register says this is someone else |

`attachesCompany` is stored on each edge rather than recomputed at display time: an edge can be
resolved and still out of scope, and a boolean each consumer derives separately is a boolean
they eventually derive differently.

**Resolution runs twice per officer.** The officer search does not say which companies a
register attributes to an officer, so the strongest signal — the client supplied company X and
the register puts a person of that name in company X — is unknowable until after the one-hop.
The first pass decides only whether asking is worth a call; the second, with the appointments
known, is stored. Decision D-025.

### Dates, currency and scope

Currency is four values, not a boolean (decision D-024). A register's silence about a
resignation is `CURRENT_PER_REGISTER_SILENCE` — in the default scope, because excluding it would
make a current-only search return nothing against most registers, and **never** labelled
confirmed. Attaching an _event_ to a tenure still goes through `labelTenure`, which answers
`UNKNOWN` rather than `DURING_TENURE` whenever the dates cannot show the person still held the
role. That is where FR-02's "an unknown end date never proves current status" actually bites.

A former-director search without the `historical_directorships` entitlement is **refused**, not
silently narrowed (decision D-027).

### The snapshot

`graphSnapshots` gets a `PENDING` row inside the search-creation transaction, so the run is
pinned to one snapshot id from the moment it exists; `build()` populates it later, off the
request path, because a registry outage must not fail search creation. Companies are copied per
snapshot rather than shared, so a registry correction next month cannot rewrite what a
historical search explained. A refresh links; nothing mutates. Decision D-026.

Association coverage keeps three values apart: `COMPLETE`, `INCOMPLETE` (we asked and something
failed or a bound bound) and `UNKNOWN` (**we never asked** — no approved register covers this
jurisdiction). Costa Rica is the `UNKNOWN` case today, and reporting it as `INCOMPLETE` would
imply an attempt that never happened.

### The name-frequency prior is missing, and that is recorded rather than filled in

No distribution is loaded for Costa Rica. `scripts/bootstrap/name-frequency.mjs` is the loader,
requires a real counts file, and prints the gap and its cost on every bootstrap. The derivation
(`assignDeciles`) is pure and tested, and draws its deciles on **population mass** rather than
on the surname ranking — a rank-based split puts a moderately common name in the same band as a
unique one, and the T71 penalty then fires for the wrong names.

The consequence, stated wherever it matters: with no distribution the FR-08 top-decile penalty
never fires for Costa Rican names, so a common name reaches a higher identity grade on the same
evidence than it would with the distribution loaded. It is blocked on the SEC-05 aggregate-only
approval for the TSE padrón (D-011), not on engineering.

---

## Traversal bounds and association coverage (Phase D step D4)

### The bounds are policy, not constants

FR-02's three bounds — `maxOfficerCandidates`, `maxCompaniesPerOfficer`, `maxEdgesPerSnapshot` —
live on the tenant's **policy version**, are read through `PolicyService`, and are **pinned onto
the snapshot at creation**. Decision D-028.

Pinning is the load-bearing part. A bound raised in October must not change what a search from
March is reported to have covered, or the truncation note on that report stops matching the graph
printed beside it. `PolicyService.loadPinned` reads by version with no `status` filter for the
same reason: a superseded version is still the one that run used.

A bad bound never fails a search. `resolveGraphBounds` falls back to a documented default per
field and returns a problem string that travels into the coverage statement — stated rather than
silent, because a run that quietly fell back is a run whose truncation nobody can explain. Each
bound also has a ceiling: a policy may narrow the traversal, never remove the limit.

### A bound that binds is a record, not a sentence

Every bound produces a `BoundApplication` — which bound, its limit, how many existed (null when
the source does not say), and what it applied to. `describeBound` renders it for a reviewer.
Storing only the rendered sentence, as D3 did, meant the only way to ask "did the edge cap bind?"
was to match on a string.

The `available: null` case is deliberate: "more than 25, we do not know how many" and "25 of 312"
lead a reviewer to different next steps.

### Three coverage outcomes that must not collapse

| Outcome      | Meaning                                                            | Run outcome          |
| :----------- | :----------------------------------------------------------------- | :------------------- |
| `COMPLETE`   | The register answered and the answer was within bounds             | `COMPLETED`          |
| `INCOMPLETE` | We asked, and something failed or a bound bound                    | `FAILED` / `PARTIAL` |
| `UNKNOWN`    | **We never asked** — no approved register covers this jurisdiction | `SKIPPED`            |

`summariseAssociationCoverage` is the pure mapping. Both `INCOMPLETE` and `UNKNOWN` make the run
`INCOMPLETE` — correct, since in both cases the run covered less than a reader might assume — but
they map to **different** source outcomes with **different** details, so "we never asked" and "we
asked and it failed" never become the same fact. A bound that binds is `PARTIAL` with
`TRUNCATED_BY_PLAN`, not `FAILED`: a bounded traversal still produced real associations.

None of the three ever means "no associations exist". Where the phrase appears in a detail
string, it appears as a denial of the inference.

### What reporting in writes, and what it leaves alone

`SearchesService.recordAssociationCoverage` stores the source outcome on the run, re-runs
`aggregateRun`, and writes back **only `coverage`**. Decision D-030.

`execution` and `findings` are statements about the whole run, and with a single failed source
outcome `aggregateRun` correctly concludes `FAILED` — right for a run in which nothing else ran,
wrong for a real one whose person search is still to come. Whoever finishes the run owns those.

This is what makes FR-02's degraded execution real: a registry outage records a `FAILED` source
outcome and an `INCOMPLETE` coverage, and no path in that method fails, deletes or rolls back the
run. Outcomes are keyed by source and replaced rather than appended, so a redelivered message
cannot make one outage look like three.
