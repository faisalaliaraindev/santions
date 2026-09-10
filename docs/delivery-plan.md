# Delivery plan

The working plan we execute against. It is not a restatement of the implementation goal —
that document defines _what_ must be true. This one records where we actually are, the order
we will do the remaining work in and why that order, what "done" means for each step, and
which decisions block which gate.

**Owner:** engineering · **Last updated:** 2026-09-10 · **Status:** active

Update this document as steps complete. If a step's exit evidence does not exist, the step is
not done, however much code was written.

---

## 1. Where we are

| Gate                                    | State                                                                 |
| :-------------------------------------- | :-------------------------------------------------------------------- |
| G0 — Discovery and decisions            | **Done**                                                              |
| G1 — Reproducible local foundation      | **Partial** — workspace and CI done; the stack has never been started |
| G2 — Domain core and evaluation harness | **Done** — I1–I10 pass, 92.95% / 90.65% coverage                      |
| G3–G11                                  | Not started                                                           |

Verified today, on a clean checkout, with no infrastructure running:

```
pnpm lint / typecheck   clean
pnpm test:unit          165 passed
pnpm test:invariants     29 passed   ← the I1–I10 release gate
pnpm test:evaluation     12 passed
```

The control panel repository has its toolchain, API transport seam and the boundary tests
that enforce decision D-001. None of its twelve FR-14 pages is built, deliberately: the API
does not exist yet, and the plan forbids mock screens.

### The gap that shapes the next step

`infra/local/keycloak/` is empty. Compose mounts it as Keycloak's realm-import directory, so
the stack would start with no realm, no clients, no roles and no synthetic accounts. This is
the kind of problem that only surfaces by actually running things — which is the argument for
finishing G1 before writing anything that depends on it.

---

## 2. Principles governing the order

These are the reasons the sequence below is what it is. If we depart from the sequence, we
should be departing from a principle knowingly.

1. **Nothing is "done" without executable evidence.** A command another engineer can run and
   a result they can read. Prose assertions do not close a gate.
2. **A suite that does not exist fails; it never passes vacuously.** `pnpm verify:local`
   already behaves this way and reports the unimplemented suites as unverified.
3. **The invariants gate everything downstream.** I1–I10 run on every pull request with no
   I/O. Any change that makes them harder to run is a change in the wrong direction.
4. **Infrastructure is stood up before the code that depends on it.** Security-negative tests
   written against a stack that has never started prove nothing.
5. **Coverage claims wait for measurement.** No language is enabled and no recall figure is
   published until G10 measures it. Until then the coverage statement says so.
6. **Decisions close at their gate.** An open decision that silently acquires a default is
   worse than an open decision — see `docs/open-decisions.md`.

---

## 3. The plan

### Phase A — Make the local stack real (finishes G1)

**Why first:** G3 delivers authentication, tenancy and cross-tenant isolation, and its exit
condition is that security-negative and entitlement-negative tests pass. Those tests need a
real OIDC provider and a real replica set to mean anything.

| #   | Step                   | Deliverable                                                                                                                                                                                   |
| :-- | :--------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Keycloak realm         | Realm JSON: panel client (auth-code + PKCE), machine client (client credentials), the nine roles from section 4.2, synthetic users across **two** tenants so T04 has something to run against |
| A2  | LocalStack bootstrap   | Evidence bucket with public access blocked; jobs queue with DLQ and redrive policy                                                                                                            |
| A3  | Search index bootstrap | Index creation and settings, behind the `SEARCH_INDEX_KIND` seam so D12 can still go either way                                                                                               |
| A4  | `pnpm local:bootstrap` | Idempotent. Seeds two synthetic tenants, an approved taxonomy version and source registry entries — all visibly labelled mock and isolated from live mode (T55)                               |
| A5  | Bring it up and verify | Actually run it. Expect to find more problems like the empty realm directory                                                                                                                  |

**Exit evidence**

- `pnpm local:up && pnpm local:bootstrap` succeeds from a clean checkout with no manual
  database edits.
- **T01** — healthy services including search index and model runtime; OIDC login works;
  seeded synthetic tenants present; no live call made.
- **T02** — restart API/worker/database/index; persisted state survives; no duplicate
  findings; index reconciles.
- A missing prerequisite produces an actionable error, not a security bypass.

**Risk:** first run pulls several GB. Keycloak and SearXNG configuration are the likely time
sinks.

---

### Phase B — Identity, tenancy and the API contract (G3)

**Why here:** authentication and tenant binding come before any business-data endpoint. Every
later gate inherits this boundary, and retrofitting isolation is how cross-tenant leaks
happen.

| #   | Step                        | Deliverable                                                                                                                                                  |
| :-- | :-------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | `packages/contracts`        | Versioned schemas, generated OpenAPI with examples and reusable error schemas                                                                                |
| B2  | Human auth                  | OIDC auth-code + PKCE through a backend-for-frontend session; provider tokens stay server-side                                                               |
| B3  | Machine auth                | Client credentials, audience-bound short-lived tokens, scoped grants, JWKS rotation and safe caching                                                         |
| B4  | Roles and permissions       | All nine roles with each permission defined explicitly. Infrastructure operation does not imply permission to read evidence                                  |
| B5  | Tenancy and entitlements    | `Tenant`, `ServiceCapability`, `TenantEntitlementVersion` **pinned to every search**; sandbox/live API key records with hashed material and one-time display |
| B6  | Subject snapshots           | FR-01 intake preserving Unicode and original scripts, with the name-frequency prior computed and stored                                                      |
| B7  | Reserved endpoints          | FR-15 deferred routes return `501` with a documented reason (decision D-007)                                                                                 |
| B8  | Production startup guards   | Reject development issuer, mock sources and test credentials                                                                                                 |
| B9  | Generate the panel's client | `pnpm api:generate` in the frontend starts working; committed output                                                                                         |

**Exit evidence**

- **T03–T09** pass: forged/expired/wrong-audience tokens rejected; cross-tenant access denied
  across every route; role policy enforced; CSRF and CORS correct; production startup fails
  safely on development configuration.
- **T62, T63, T68** pass: sandbox cannot run live; a tenant without the capability is refused
  as an entitlement denial and **no source call occurs**; API key secret shown once and
  stored only as a hash.
- Two tenants with deliberately identical external references stay isolated.

**Closes decision:** **D10** — the minimum identity data an integrating application must
supply. It hardens into the subject-snapshot schema, so it cannot be deferred past this gate.

---

### Phase C — Persistence, jobs and storage (G4)

| #   | Step                              | Deliverable                                                                            |
| :-- | :-------------------------------- | :------------------------------------------------------------------------------------- |
| C1  | Record schemas and indexes        | The records listed in section 6.3, with tenant context leading every key               |
| C2  | Transactions and outbox           | State, audit reference and outbox committed transactionally                            |
| C3  | Search index integration          | Name-matching indexes and corpus index, reconciled against MongoDB as system of record |
| C4  | **Matcher-latency workload test** | The measurement that settles **D12**                                                   |
| C5  | S3 staging and commit             | Checksum verification, reference commit, orphan reconciliation                         |
| C6  | Jobs                              | Retry classification, DLQ, lease fencing, cancellation, duplicate-delivery handling    |

**Exit evidence**

- **T22–T24, T29–T31, T41** pass under injected failure: no duplicate committed work, no lost
  terminal events, no unindexed committed documents, no successful reference to absent
  evidence.
- Restart verified at each persistence and publication boundary.

**Closes decision:** **D12** — search index choice, recorded in `docs/decisions.md` with the
measured result, not a preference.

---

### Phase D — Sources, graph and taxonomy administration (G5)

| #   | Step                        | Deliverable                                                                    |
| :-- | :-------------------------- | :----------------------------------------------------------------------------- |
| D1  | Four-eyes approval          | Versioned source, taxonomy and policy approval; proposer ≠ approver            |
| D2  | Registry adapters and mocks | Free registry adapters plus deterministic mock counterparts for every port     |
| D3  | Association graph           | Sourced identity and edge resolution, tenure labelling, frozen graph snapshots |
| D4  | Graph limits                | One-hop bounds, unresolved candidates, person-only degraded execution          |
| D5  | Source health               | Reliability profile, breaker state, kill switch including mid-run suspension   |
| D6  | Wire the lexicon audit      | Already built and tested; wire it into taxonomy activation as well as CI       |

**Exit evidence**

- **T14, T15, T20, T36, T45, T79** pass.
- No unsupported company association is automatically searched; graph limitations visible; a
  disabled category is never queried.

**Closes decisions:** **D1** (jurisdictions and languages enabled first), **D3** (categories
on by default), **D8** (retention per source and jurisdiction).

---

### Phase E — Planning, cascade and fetch (G6)

The pure planning rules already exist and are tested. This phase gives them somewhere to send
queries.

| #   | Step                                    | Deliverable                                                                                                |
| :-- | :-------------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| E1  | Plan generation                         | The eight families generated from real subjects, taxonomy and graph; F1 and F4 provably survive truncation |
| E2  | The seven-rung cascade                  | Per-rung logging, per-source budgets, circuit breakers, coverage emission                                  |
| E3  | Egress pool                             | Egress identities, sticky rotation, the FR-06 failure classifier                                           |
| E4  | Relevance filter and fetch gate         | Rejected candidates stored as leads with reasons and visible in coverage                                   |
| E5  | HTTP-first fetch                        | Deterministic, logged, per-domain-cached Playwright escalation only                                        |
| E6  | Contract tests for undocumented sources | Scheduled, alerting on response-shape change — Google News RSS above all                                   |

**Exit evidence**

- Fixture searches complete end to end through real local infrastructure.
- **T37–T39, T46, T59, T84–T90** pass.
- A blocked or exhausted source produces a **visible coverage gap and never a clean result**.

**Closes decision:** **D6** — how robots exceptions for official sources are approved and
recorded, with a named approver per source and jurisdiction.

---

### Phase F — Extraction and the full pipeline (G7)

| #   | Step                             | Deliverable                                                                                             |
| :-- | :------------------------------- | :------------------------------------------------------------------------------------------------------ |
| F1  | Deterministic parsing            | Readability-class extraction, PDF, OCR; the four date fields with declared precision and no backfilling |
| F2  | `ExtractionModelPort`            | Against a locally served open-weight model, plus the synthetic adapter for offline tests                |
| F3  | The eight validation rules       | Each one proven to reject its own failure case                                                          |
| F4  | Wire G2 to real assertions       | Four axes, roles, stages, tenure, clustering, independence and banding against real extraction output   |
| F5  | Duplicate layers and split/merge | Every FR-12 layer; reviewed event corrections in both directions with history                           |
| F6  | Prompt-injection tests           | Fetched fixture documents that try to change policy or fetch URLs                                       |
| F7  | Full evaluation run              | All FR-16 metrics recorded on the held-out split                                                        |

**Exit evidence**

- **I1–I10 pass against real pipeline output**, not only the G2 fixtures. This is the single
  most important checkpoint in the plan — the G2 harness and the G7 harness are the same code,
  which is what makes this checkable rather than assertable.
- Hard-negative cases do not become confirmed matches.
- **T32–T35, T82, T83** pass.

**Closes decisions:** **D4** (adverse media vs list matching for designations), **D5**
(reviewer capacity assumption), **D7** (which open-weight model, benchmarked on the labelled
set), **D9** (whether numeric confidence is ever shown — default remains no).

---

### Phase G — The control panel (G8)

All twelve FR-14 pages against the real local API. The boundary tests already in the frontend
keep domain logic out of the browser as pages land.

**Exit evidence**

- **T50–T52** pass: full journey persists through reload; expiry, forbidden role, partial
  result and review conflict all recover accessibly; keyboard and screen-reader use verified
  manually as well as automatically.
- The no-match statement renders with scope, sources, versions, date, horizon and coverage in
  **every** path that can produce it.
- A human can configure scope, run, review, refresh and export a complete search locally
  without calling hidden admin endpoints by hand.

**Closes decision:** **D11** — whether procedural stage and outcome status render at the same
visual weight as the band. Recommendation on file: yes. It cannot be deferred past the
results page.

---

### Phase H — Integration, live sources, hardening (G9–G11)

| Gate | Focus                         | Notes                                                                                                                                                                                                                          |
| :--- | :---------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G9   | Zquence contract              | Typed client, callback fixture with signature/replay/duplicate/out-of-order handling, entitlement denials. Zquence-side work needs separate workspace access                                                                   |
| G10  | Live free-source verification | **The first live calls.** Measure archive horizon, per-country and per-language coverage, officer completeness and end-to-end recall. Populate the coverage matrix. Disable every profile without an agreed measured threshold |
| G11  | Hardening and handoff         | Security review, real AWS IAM/KMS under authorised staging, restore and deletion-replay, workload verification, readiness report                                                                                               |

**Closes decision:** **D2** — declared archive horizon per source, published on every result.

G10 is where the honest answer to "does this actually find things" arrives. Everything before
it is capability; G10 is measurement. Plan for the possibility that measured free-source
recall is lower than hoped in some languages — the correct response is to disable those
profiles and say so, not to relax the threshold.

---

## 4. Decision calendar

From `docs/open-decisions.md`. A decision listed here blocks its gate's exit.

| Gate | Decisions that must close                                                                    | Owner                                      |
| :--- | :------------------------------------------------------------------------------------------- | :----------------------------------------- |
| G3   | D10 minimum identity data                                                                    | Product + Zquence                          |
| G4   | D12 search index choice                                                                      | Engineering (by measurement)               |
| G5   | D1 jurisdictions/languages · D3 default categories · D8 retention                            | Source/policy + taxonomy admin, compliance |
| G6   | D6 robots exception approval                                                                 | Source admin                               |
| G7   | D4 designation boundary · D5 reviewer capacity · D7 extraction model · D9 numeric confidence | Product + compliance + engineering         |
| G8   | D11 visual weight of stage vs band                                                           | Product + design                           |
| G10  | D2 archive horizon per source                                                                | Source/policy admin                        |

**D1, D3, D8 and D10 need people outside engineering.** They should be raised now rather than
at the gate — D10 in particular shapes the subject schema in Phase B, which is two phases
away.

---

## 5. What could invalidate this plan

Named so we notice early rather than discovering them as slippage.

| Risk                                                                        | Signal                                 | Response                                                                                                                       |
| :-------------------------------------------------------------------------- | :------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| Free-source recall is too low to be useful in some languages                | G10 measurement                        | Disable those profiles and publish the figure. Do not relax the threshold                                                      |
| An open-weight model cannot meet the extraction contract on span validation | G7 evaluation                          | The span rules are not negotiable — they are what prevents fabricated findings. Try another model, or narrow the enabled scope |
| Google News RSS shape changes                                               | Scheduled contract test alerts         | Already designed for: the run reports a coverage gap, never zero results                                                       |
| Meilisearch cannot express the matcher's needs                              | G4 workload test                       | Switch to OpenSearch. The `SEARCH_INDEX_KIND` seam exists for this                                                             |
| Two-repository contract drift                                               | A panel break not caught by backend CI | G9 contract tests run against the generated client, so backend CI fails first                                                  |
| Compliance approval for a jurisdiction does not arrive                      | Phase D stalls                         | Country stays disabled. Coverage statement names it. Not an engineering blocker                                                |

---

## 6. Executing this plan across sessions

Each phase is executed in its own session, with context cleared between phases. The
per-phase briefs in [`execution/`](./execution/) exist so a cold session can work a phase
without reading the ~167KB of source specification.

| File                                                     | Role                                                                            |
| :------------------------------------------------------- | :------------------------------------------------------------------------------ |
| [`execution/START-HERE.md`](./execution/START-HERE.md)   | Session entry point: active phase, reading list, session protocol               |
| [`execution/handoff-log.md`](./execution/handoff-log.md) | The only thing carrying state between sessions                                  |
| `execution/phase-*.md`                                   | Self-contained brief per phase: goal, narrow reading list, steps, exit evidence |

Briefs for A and B are complete. C through H are outlines, expanded into full briefs at the
start of their phase — deliberately, because their detail depends on what earlier phases
reveal.

---

## 6. Immediate next actions

1. **A1** — write the Keycloak realm JSON (the gap found today).
2. **A2, A3** — LocalStack and search-index bootstrap.
3. **A4** — `pnpm local:bootstrap`, idempotent, mock-labelled.
4. **A5** — bring the stack up, run T01 and T02, and fix whatever that surfaces.
5. Update `docs/implementation-status.md` to move G1 to complete — **only** once A5's evidence
   exists.

In parallel, and not blocking: raise **D10** with product and Zquence, since it shapes the
Phase B subject schema.
