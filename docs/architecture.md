# Architecture

## What this service is, and what it is not

It retrieves published material about a subject, resolves whether that material refers to
the subject, classifies what is reported and at what procedural stage, and grades how well
the evidence supports the connection.

It is **not** a criminal record check, **not** a proof of identity, **not** a determination
of guilt, and **not** a sanctions-list engine. A designation found in reporting is a lead to
verify against the primary list, never a finding. Zquence keeps its sanctions.io integration
and makes the final compliance decision.

## Repository split

Two repositories, per decision D-001:

- `erly-sanction-service-backend` — this repository. API, worker, domain, providers,
  persistence, evaluation, infrastructure.
- `erly-sanction-service-frontend` — the React control panel.

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
  client/          Typed Node client and Zquence integration examples
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
Zquence │  integrator │ ──────────────────────▶ │  apps/api    │
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
