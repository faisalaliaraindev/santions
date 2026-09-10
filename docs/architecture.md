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
