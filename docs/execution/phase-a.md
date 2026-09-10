# Phase A — Make the local stack real

**Gate:** finishes G1 · **Status:** COMPLETE (2026-09-10) · **Actual:** 1 session

---

## Goal

Take the local dependency stack from "written and syntactically valid" to "starts from a
clean checkout, seeds itself, and survives a restart". Nothing after this phase can be
honestly verified until it is true.

## Why this is first

Phase B delivers authentication, tenancy and cross-tenant isolation. Its exit condition is
that the security-negative and entitlement-negative tests pass. Those tests need a real OIDC
provider and a real MongoDB replica set to mean anything — written against a stack that has
never started, they prove nothing and give false confidence exactly where confidence is most
expensive to be wrong about.

## Read before starting

Narrow list. Do not read the source specification documents.

| What                             | Why                                                                    |
| :------------------------------- | :--------------------------------------------------------------------- |
| `infra/local/docker-compose.yml` | The stack you are completing. Read it fully; it is short and commented |
| `scripts/local-up.mjs`           | How startup and health-waiting already work                            |
| `scripts/verify-local.mjs`       | The suite-reporting contract you must not break                        |
| `.env.example`                   | Every variable the stack expects                                       |
| `docs/open-decisions.md` §D12    | Why the index choice is still open and must stay behind a seam         |

Spec sections, only if you need the exact wording:
`CODEX_ADVERSE_SEARCH_IMPLEMENTATION_GOAL (3).md` §4.2 (roles and auth), §8 G1 (gate
definition), §9.1 tests T01–T02.

---

## Steps

### A1 — Keycloak realm

**The gap that started this phase.** Compose mounts `./keycloak` into
`/opt/keycloak/data/import`, but the directory is empty, so the stack starts with no realm.

Create `infra/local/keycloak/realm-export.json` defining:

- **Realm** `adverse-search-local`, matching `OIDC_ISSUER` in `.env.example`.
- **Panel client** `adverse-search-panel` — public-facing flow is authorisation-code **with
  PKCE**, but the client is confidential and the code exchange happens in the backend-for-
  frontend. Redirect URIs limited to the local API origin, not the Vite dev origin: the panel
  reaches the API same-origin through the Vite proxy.
- **Machine client** `adverse-search-machine` — client credentials, service account enabled,
  audience-bound.
- **Realm roles**, all nine from §4.2: `viewer`, `analyst`, `reviewer`, `tenant_admin`,
  `source_admin`, `taxonomy_admin`, `auditor`, `platform_operator`, `platform_admin`.
- **Synthetic users across two tenants.** This matters more than it looks: test T04 checks
  that tenant A cannot reach tenant B's searches, evidence, graph, reviews or exports. With
  one tenant seeded, that test cannot be written honestly. Seed at least an analyst and a
  reviewer per tenant, plus one `platform_operator` who must be shown _unable_ to read
  evidence.
- A tenant claim mapped into the token, so Phase B can bind an authenticated identity to a
  tenant rather than trusting a client-supplied header.

**Watch for:** these are development-only accounts with known passwords. Phase B step B8 adds
the production startup guard that rejects this issuer and these accounts (test T09). Note that
dependency in your handoff entry so it is not forgotten.

### A2 — LocalStack bootstrap

Create `infra/local/bootstrap/aws.mjs` (or shell, if simpler) that is **idempotent** — running
it twice must be a no-op, not an error.

- S3 evidence bucket from `S3_EVIDENCE_BUCKET`, with public access blocked. Local emulation is
  not proof that real AWS policies work (SEC-03, gate G11) — do not let the script imply
  otherwise in its output.
- SQS jobs queue and its DLQ, with a redrive policy attaching them.
- Print what it created or found, so a confused operator can see the state.

### A3 — Search index bootstrap

Create the index and its settings **behind the `SEARCH_INDEX_KIND` seam**. Open decision D12
is settled by Phase C's matcher-latency workload test, and this phase must not quietly decide
it by writing Meilisearch-specific code into a shared path.

Keep the concrete client behind a small interface with one implementation now. If that feels
like premature abstraction, read D12 — the measurement genuinely may go the other way.

### A4 — `pnpm local:bootstrap`

Create `scripts/local-bootstrap.mjs` and wire it to the existing script name, replacing the
placeholder that currently exits non-zero.

Requirements:

- **Idempotent.** Safe to run repeatedly.
- **Seeds only the explicitly selected local environment.** It must refuse to run against a
  non-local endpoint — copy the `assertLocalOnly` guard from `scripts/local-reset.mjs`.
- Seeds: two synthetic tenants matching the Keycloak users, an approved taxonomy version, and
  source registry entries pointing at the fixture server.
- **Everything seeded is visibly labelled mock** and isolated from live mode (test T55). A
  fixture must never be able to appear as a live result.
- Calls A2 and A3 so one command brings a clean checkout to a working state.

### A5 — Bring it up and verify

The step that makes the phase real. Expect to find more problems like the empty realm
directory — that is the point of doing it now rather than after Phase B.

```bash
pnpm local:up          # first run pulls several GB
pnpm local:bootstrap
```

Then verify:

- **T01** — every service healthy including the search index and model runtime; OIDC login
  works against the local realm; seeded synthetic tenants present; **no live call made**.
- **T02** — restart the database, index and emulators; persisted state survives; the index
  reconciles; nothing is duplicated.

Add these as `tests/integration/` suites so they are repeatable, and turn on the `integration`
project in `verify-local.mjs` by flipping its `implemented` flag.

**Note on the model runtime:** compose starts Ollama but pulls no model. Which open-weight
model to use is open decision **D7**, closing in Phase F. For T01, "healthy" means the runtime
answers — not that a model is loaded. Do not pull one to make the check look better.

---

## Definition of done

- [x] A1 — realm JSON exists; Keycloak imports it; login works for a seeded user
- [x] A2 — bucket and queues created idempotently; public access blocked
- [x] A3 — index created behind the `SEARCH_INDEX_KIND` seam
- [x] A4 — `pnpm local:bootstrap` is idempotent, local-guarded, and seeds mock-labelled data
- [x] A5 — stack starts from a clean checkout with **no manual database edits**
- [x] T01 passes as an automated integration test
- [x] T02 passes as an automated integration test
- [x] `verify-local.mjs` has `integration` marked implemented, and the suite genuinely runs
- [x] A missing prerequisite produces an actionable error, never a security bypass
- [x] `docs/implementation-status.md` moves G1 to **Complete**, with the commands as evidence
- [x] `START-HERE.md` active-phase pointer moved to Phase B
- [x] Handoff entry written

## Do not

- Disable a healthcheck to get the stack green. A dependency that is not ready produces test
  failures that look like application defects.
- Pull an extraction model to make T01 look better. That is decision D7, in Phase F.
- Decide D12 by writing index-specific code outside the seam.
- Start Phase B work "while waiting for images". Finish the phase and hand off cleanly — a
  half-finished phase across a cleared session is worse than a clean stop.

## Known risks

| Risk                                                | Mitigation                                                                                                                          |
| :-------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| First image pull is several GB and slow             | Expected. Start it early in the session                                                                                             |
| Keycloak realm import format is version-sensitive   | Pinned to Keycloak 26. If import fails, read the container logs — the error is usually specific                                     |
| SearXNG needs a generated secret and can be fussy   | `settings.yml` exists with a dev placeholder. If it will not start, it blocks only cascade rung 5; record it and continue           |
| Mongo replica set not electing a primary on Windows | `mongo-init` handles initiation; the healthcheck waits for a primary. If it hangs, check the container can resolve its own hostname |
