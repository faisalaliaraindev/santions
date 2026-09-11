# Phase B — Identity, tenancy and the API contract

**Gate:** G3 · **Status:** IN PROGRESS — B1–B9 done; T07, T08 and T68 remain

---

## Goal

Authentication, authorisation and tenant binding, before any endpoint that returns business
data. Plus the API contract itself, which the control panel then generates its client from.

## Why this before persistence

Every later gate inherits this boundary. Retrofitting tenant isolation is how cross-tenant
leaks happen: the isolation ends up enforced in the handlers that were written after the
decision and missing from the ones written before. Establishing it first means every
repository, queue envelope and worker is written against it from the start.

## Prerequisite

Phase A complete. A running Keycloak realm with two tenants' worth of synthetic users is not
optional here — the security-negative tests are the deliverable, and they need somebody to be
denied.

## Read before starting

| What                                         | Why                                                      |
| :------------------------------------------- | :------------------------------------------------------- |
| `docs/execution/handoff-log.md`              | Latest entries. Phase A will have found things           |
| `infra/local/keycloak/realm-export.json`     | The realm you authenticate against                       |
| `packages/domain/src/identity/name-forms.ts` | `normaliseName` — the subject snapshot stores its output |
| `packages/domain/src/identity/axis-a.ts`     | `NameFrequencyPrior` — computed at intake, step B6       |
| `docs/decisions.md` D-001, D-007             | The two-repo contract, and the FR-15 deferral            |
| `docs/open-decisions.md` D10                 | **Closes this phase.** Blocks the subject schema         |

Spec sections: §4.1–4.2 (ownership, auth, roles), FR-01, FR-15, §6.1 (endpoints), §6.2
(result dimensions), SEC-01, tests T03–T09 and T62/T63/T68.

---

## Steps

### B1 — `packages/contracts`

Versioned schemas and types, and the generated OpenAPI document with examples and reusable
error schemas.

The error schema matters more than it looks. The panel's `ApiError` (already written, in the
frontend at `src/lib/api/client.ts`) distinguishes an **entitlement denial** from throttling
and from a coverage gap, plus session expiry and revision conflict. Those are three genuinely
different operator actions. The contract must carry `code`, `message`, `correlationId` and
`retryable`, and never a stack trace or a source secret.

Status codes per §6.1: 401/403 correctly separated, 409 for revision and idempotency
conflicts, 413 input bounds, 422 invalid scope or policy, 429 throttling.

### B2 — Human authentication

OIDC authorisation-code with PKCE, terminated by a **backend-for-frontend session**. Provider
tokens stay server-side; the browser gets a secure, HTTP-only cookie. CSRF protection on
state-changing cookie-authenticated requests — the panel already sends `X-CSRF-Token` read
from a companion cookie, so match that.

Local development may use a loopback-only HTTP setting. Step B8 makes production reject it.

### B3 — Machine authentication

Client credentials with audience-bound short-lived tokens and scoped grants. Validate
signature, issuer, audience, expiry and allowed algorithms. Support signing-key rotation and
safe JWKS caching.

Browser bundles never contain machine secrets — the frontend boundary test already fails the
build if the panel calls `fetch` outside its API client, which keeps this honest.

### B4 — Roles and permissions

All nine roles, each permission defined **explicitly**. The one worth stating plainly:
`platform_operator` runs infrastructure and must **not** be able to read customer evidence.
Test T06 checks exactly this, so the role cannot be a convenience alias for admin.

No implicit super-admin tenant bypass. Cross-tenant access requires an explicit break-glass
workflow with a reason, bounded authorisation and an audit record.

### B5 — Tenancy and entitlements

Per FR-15 and decision D-007 — **structural seams only**, not the commercial layer.

- `Tenant`, `ServiceCapability`, `TenantEntitlementVersion`, with `adverse_media` as the only
  capability.
- **The entitlement version is pinned to every search**, so a historical search can explain
  why it was permitted at the time even after the tenant's configuration changes.
- A capability check in the API before search creation and in the worker before external
  source work, returning `ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN`. An entitlement denial is not a
  rate limit and not a coverage gap.
- Environment-scoped API keys (`sandbox`, `live`): hashed material, one-time secret display,
  rotation, revocation, expiry, last-used tracking, scopes. Sandbox keys cannot run live
  searches or reach live evidence.
- Reserved endpoints from §6.1 return **501** with a documented reason.

### B6 — Subject snapshots

FR-01 intake. Original full name, aliases with origin, optional DOB with declared precision,
country context, optional company identifiers, external references.

- **No Western first/last splitting.** Preserve Unicode and original scripts alongside derived
  normalised forms — `normaliseName` in the domain package produces both.
- Compute and store the **name-frequency prior** at intake. It is an input to Axis A grading
  and must be visible to reviewers, so it belongs on the snapshot, not computed later.
- Sparse input may be searched, but ambiguous identity stays unresolved. Never invent a DOB or
  nationality.
- `externalSubjectRef` and `externalCaseRef` are recorded but are **neither a lookup
  instruction nor an authorisation credential**.

### B7 — Idempotent search creation

`POST /v1/searches` with a tenant/client-scoped idempotency key: same canonical request
returns the same operation, changed body returns 409, concurrent submissions handled
atomically (tests T22, T23).

### B8 — Production startup guards

Startup must fail, safely and with an actionable message, on a development issuer, mock
sources, test credentials or insecure cookies (test T09).

### B9 — Generate the panel's client

Wire the frontend's `pnpm api:generate` to the OpenAPI document from B1. Generated output is
committed so a contract change appears as a reviewable diff rather than a runtime surprise,
and so the panel builds without the backend running.

Leave the frontend's hand-written `src/lib/api/client.ts` alone — transport, session, CSRF and
error typing stay hand-written. Only operations and types are generated.

---

## Definition of done

- [x] T03 — missing, expired, wrong-audience and forged tokens rejected without data disclosure
- [x] T04 — tenant A denied B's search, evidence, graph, review and export, on **every** route
- [x] T05 — forged tenant header or queue payload fails closed; stored ownership prevails
- [x] T06 — viewer cannot review; analyst cannot activate a source; operator cannot read evidence
- [ ] T07 — logout, revocation and key rotation behave as documented; old access does not persist
- [ ] T08 — CSRF blocked; no permissive CORS; no token in browser storage or logs
- [x] T09 — production startup fails on development issuer, mock source or test credentials
- [x] T62 — sandbox key cannot run a live search
- [x] T63 — tenant without the capability is refused as an entitlement denial and **no source call occurs**
- [ ] T68 — API key secret shown once, stored hashed, rotation and revocation audited
- [x] T22, T23 — idempotency: one operation for identical requests, 409 on changed body
- [x] Two tenants with deliberately identical external references stay isolated
- [x] `verify-local.mjs` has `security` marked implemented and the suite genuinely runs
- [x] OpenAPI generated; the frontend generates and builds against it
- [x] **D10 closed** and recorded in `docs/decisions.md`

## Do not

- Trust a queue message's tenant field. Verify job ownership against persisted records.
- Let missing tenant context default to anything. It fails closed.
- Build the FR-15 commercial layer — plan CRUD, usage ledger, overage, provider screens. It is
  deferred by decision D-007 and the reserved routes return 501.
- Implement a second matching engine anywhere, including in the API layer. The domain package
  is the only place banding and identity resolution exist.

## Decision to close

**D10 — the minimum identity data an integrating application must supply.** Owner: product
plus Zquence. It hardens into the B6 subject schema, so it cannot slide past this phase. If
the answer has not arrived when you reach B6, implement the permissive superset, record the
assumption prominently in `docs/decisions.md`, and flag it in the handoff — do not let the
schema quietly become the decision.
