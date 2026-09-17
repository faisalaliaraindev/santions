# Start here

Entry point for a session working on this project. Designed to be read cold, with no memory
of previous sessions. It is deliberately short.

---

## 1. Active phase

> **Phase I — Tenant self-service onboarding**
>
> **I4, I1, I2 and I3 are built. I5/I6 are the remainder, and nothing blocks them.** Read
> [`phase-i-tenant-onboarding.md`](./phase-i-tenant-onboarding.md) — it is the brief, and it is
> short.
>
> **Today a tenant is created by editing `scripts/bootstrap/seed-data.mjs` and re-running the
> bootstrap.** That is provisioning by redeploy. This phase replaces it with signup through the
> API: a customer registers, sets a password, logs in, and issues their own **sandbox and live**
> keys with nobody at Erly involved.
>
> **Done (2026-09-16): I4.** `POST /v1/tenant/api-keys/{keyId}/disable` and `.../enable` move a
> reversible `disabledAt`, separate from the one-way `revokedAt` that `DELETE` sets. Recorded as
> **D-054**. Do not let a later change merge the two fields: either a leaked key becomes
> switch-back-on-able, or a routine pause becomes irreversible.
>
> **Done (2026-09-16): I1.** `POST /v1/signup` writes the tenant, entitlement, taxonomy and policy
> records in **one transaction**, with a **generated** tenant id the body cannot name. Recorded as
> **D-055** (live access is a value on the tenant record, read by `decideLiveAccess`, not a
> condition in the issuing route) and **D-056** (signup is bounded per client address). One
> builder, `buildTenantProvisioning`, now defines what a tenant is made of, and the bootstrap
> imports it rather than keeping its own copy. **Nothing yet sets `emailVerifiedAt`**, so a
> self-signed-up tenant has sandbox only until I2 lands the verification flow.
>
> **Done (2026-09-16): I2.** The customer credential store, in our own database, argon2id
> (D-051). Signup now takes a password and creates the tenant's administrator in the same
> transaction; `POST /v1/signup/verify` sets `tenants.emailVerifiedAt`, which is **the** thing
> standing between a self-signed-up tenant and a live key. Password reset, lockout and single-use
> emailed tokens come with it. Recorded as **D-057** (signup says an address is taken; every other
> account route says nothing) and **D-058** (no mail transport is configured — the local stack
> writes to an `outboundEmails` collection, and **production refuses to start** rather than
> dropping messages somewhere nobody reads).
>
> **Done (2026-09-16): I3.** `POST /v1/auth/login` returns a session token presented as
> `Authorization: Session <token>`, created in the **same store** as the panel's cookie and ended
> by `POST /v1/auth/logout`. Every failure is one opaque `401`; the session's environment is
> derived from `decideLiveAccess` rather than requested; attempts are bounded per origin by a
> limiter now shared with signup. Recorded as **D-059**.
>
> **Signup → confirm → sign in → issue your own key now runs end to end**, with nobody at Erly
> involved. `tests/security/login.test.ts` does exactly that.
>
> **Done (2026-09-17): the flow closes.** Signup now grants the first user
> `['tenant_admin', 'analyst']` — without `analyst` there is no `search:create` and no
> `search:write` scope, so a self-signed-up tenant could issue keys and never use them. A
> dev-only `GET /v1/dev/outbound-emails/latest` reads the verification token over HTTP (absent in
> production by registration, not by a guard). Postman folder 13 runs signup → token → verify →
> login → **sandbox and live** keys → subject → search → poll → findings, with every customer
> call on the tenant's own key. `tests/e2e/tenant-onboarding-e2e.test.ts` proves it: 16 passed.
>
> **A search needs the API _and_ the worker** (`pnpm dev` runs both). A stale worker completes a
> run in ~130ms as `FAILED`, which looks exactly like a provisioning bug and is not one.
>
> **Next: I5/I6** — mostly assembly. A tenant can already hold both key kinds; what is left is
> the single response that hands over both with each secret shown once (I6), and a decision about
> whether signup itself should issue the sandbox key rather than making the customer sign in for
> it. **Before live keys reach anyone**, the fixed-feed fetch below is the prerequisite — I3 was
> the last thing standing between a self-signed-up tenant and live traffic.
>
> **All three gating decisions are closed** (2026-09-16), so no session needs to stop and ask:
>
> - **D-053** — signup is **open**, no invite code, both key kinds from day one. Payment and
>   live-key approval come later, and live issuance must read tenant state so that gate is not a
>   retrofit.
> - **D-051** — passwords live in **our own database as argon2id hashes**, not in Keycloak and not
>   reversibly encrypted. I2 therefore owns reset, lockout, rotation, MFA and breach response.
> - **D-052** — **email verification before a live key**; **no** per-tenant live budget yet. That
>   leaves the shared SEC budget unprotected, which is why the fixed-feed fix below is now a
>   prerequisite for handing out live keys rather than an optimisation.

### The previous phase, for context

Phase F is **partly done** and is not the active phase. The live path works end to end: a real
search against the SEC litigation-releases feed returns a real finding. What Phase F still owes is
in [`phase-f.md`](./phase-f.md) — **F3, the eight FR-07 validation rules**, is the next thing
there, and `grep validateAssertion` still returns nothing.

### LOCAL LIVE TEST READY — reached 2026-09-17

A newly signed-up tenant can run a real SEC-backed search on its own live key against the local
stack, and did: `SEC_LIVE_E2E=yes-contact-the-sec pnpm test:live`, 7 passed. See the
2026-09-17 (eleventh) entry in the handoff log for the run's identifiers and counts, and
`docs/sources/first-live-contact.md` for what has actually been contacted and when.

Two commands matter before touching live again: `pnpm sec:live-smoke --yes-contact-the-sec` makes
**one** counted request and reports on it, and `pnpm source:health <sourceId>` reads the breaker
and budget (`--reset --reason "…"` clears the record locally without weakening the breaker).

### Fixed-feed request amplification — fixed 2026-09-17

This section used to say a fixed feed was fetched **once per planned query, about 41 identical
requests per run**. That figure was an inference from the plan's size and it was wrong: a guard in
`RssNewsDiscoveryAdapter` already answers `noResults` for any family but F1 on a fixed feed, so
the measured cost was **one request per F1 query** — one per name form, per language, per
jurisdiction. Measured with a counting fetch port against a live-sized plan: **53 planned queries →
1 request** with no aliases, **56 → 4** with three aliases.

The real defect was the one underneath it: **`pollFloorMs` was read from the approved source
version and enforced nowhere**, so every search re-polled and nothing collapsed concurrent polls.
`FixedFeedPollCache` (`apps/api/src/sources/feed-poll-cache.ts`) now holds the publisher's own
floor — fifteen minutes for the SEC — and `apps/api/test/fixed-feed-amplification.test.ts` fails if
any of that regresses.

Fixed at the same time: `CascadeService` recorded **our own gate refusals** against source health.
A refusal carries `policyRefusal`, which classifies as `HARD_BLOCK`, so a missing robots position
or an unapproved configuration opened the breaker on a publisher that had done nothing — which is
how the SEC source reached `OPEN` / `HARD_BLOCK` with zero consecutive failures.

`pnpm source:health <sourceId>` reads the record; `--reset --reason "..."` clears it locally
without weakening the breaker.

## 2. What to read, and what not to

Read, in this order:

1. This file.
2. [`handoff-log.md`](./handoff-log.md) — the last few entries only. What the previous session
   did and what it left behind.
3. Your phase brief. It names every file and spec section you need.

**Do not read these unless a phase brief points you at a specific section:**

| File                                                       | Size   | Why not                                                |
| :--------------------------------------------------------- | :----- | :----------------------------------------------------- |
| `../../../Adverse_Search_Strategy.md`                      | ~66KB  | Domain reasoning. Already encoded in `packages/domain` |
| `../../../CODEX_ADVERSE_SEARCH_IMPLEMENTATION_GOAL (3).md` | ~102KB | The requirements. Phase briefs quote what you need     |
| `../requirements-traceability.md`                          | Large  | Read only the rows for your phase                      |

Reading the two source documents end to end costs roughly 45,000 tokens and leaves you less
room to do the work than to plan it. The phase briefs exist so you do not have to.

---

## 3. Session protocol

**At the start**

1. Read this file, the recent handoff entries, and your phase brief.
2. Run the health check below. If it does not pass, something regressed — investigate before
   building on it.
3. Work the steps in the brief in order. They are dependency-ordered within the phase.

**Health check** — takes about ten seconds, no infrastructure needed:

```bash
pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:invariants && pnpm test:evaluation
```

Expected today (2026-09-16): clean, clean, **895 passed, 29 passed, 12 passed**.

With the stack running (`pnpm local:up && pnpm local:bootstrap`), `pnpm test:integration` adds
**215 integration** tests, `pnpm test:security` **181 security** tests, and `pnpm test:e2e:api`
**10 API end-to-end** tests over real HTTP, real SQS and a real worker. All four figures were
re-measured on 2026-09-16; the ones they replace had drifted by a session or two.

Coverage is gated at 85/80 and currently reports 94.07% / 90.46% — but only under CI's own
invocation, which is
`pnpm exec vitest run --project unit --project invariants --project evaluation --coverage`.
Running `--project unit` alone reports ~84% and fails, because domain code is also exercised by
the other two projects. Do not "fix" a coverage failure that is really a wrong invocation.

**At the end — before the session is cleared**

1. Append an entry to [`handoff-log.md`](./handoff-log.md) using the template at its top.
   This is the only thing carrying state to the next session. Write it as though the reader
   knows nothing, because they will not.
2. Update the phase brief's checklist — tick what is genuinely done, and note what is
   half-done and where it stopped.
3. If the phase completed, update the **Active phase** pointer in section 1 and move the gate
   in `../implementation-status.md`.
4. Commit. A phase left uncommitted is a phase the next session cannot see.

---

## 4. Rules that survive every phase

These are not style preferences. Each one exists because breaking it produces a screening
product that states something untrue about a real person.

1. **Never weaken an invariant to make something pass.** I1–I10 are in
   `packages/evaluation/src/invariants/harness.ts`. If one fails, the code is wrong.
2. **Never mark a suite passing that did not run.** Unimplemented commands exit non-zero
   deliberately.
3. **Never claim a source was verified live beyond what was actually run.** First live contact
   happened on **2026-09-16** — the SEC, under D17 — and the litigation-releases feed has been
   polled successfully since. `docs/sources/first-live-contact.md` records what, when and with
   what evidence. Every other source is still unverified, and fixtures remain labelled and
   isolated from live mode.
4. **Never enable a language without a measured recall figure** (FR-03). None is measured, so
   none is enabled, and the coverage statement must say so.
5. **Keep `packages/domain` and `packages/evaluation` free of I/O.** Use a port.
6. **Do not let an open decision acquire a silent default.** See `../open-decisions.md`.

---

## 5. Phase map

| Phase | Gate   | Focus                                | Brief                        |
| :---- | :----- | :----------------------------------- | :--------------------------- |
| A     | G1     | Make the local stack real            | [`phase-a.md`](./phase-a.md) |
| B     | G3     | Identity, tenancy, API contract      | [`phase-b.md`](./phase-b.md) |
| C     | G4     | Persistence, jobs, index, storage    | [`phase-c.md`](./phase-c.md) |
| D     | G5     | Sources, graph, taxonomy admin       | [`phase-d.md`](./phase-d.md) |
| E     | G6     | Planning, cascade, fetch             | [`phase-e.md`](./phase-e.md) |
| **F** | G7     | Extraction and the full pipeline     | [`phase-f.md`](./phase-f.md) |
| G     | G8     | Control panel                        | [`phase-g.md`](./phase-g.md) |
| H     | G9–G11 | Integration, live sources, hardening | [`phase-h.md`](./phase-h.md) |

Briefs for A, B, C, D, E and **F** are complete. G and H are outlines that must be expanded into full
briefs **at the start of their phase** — deliberately, because their detail depends on what
earlier phases reveal. Writing them out now would harden guesses into instructions. Each
outline says what expanding it involves.

Why the phases are ordered this way: [`../delivery-plan.md`](../delivery-plan.md).

---

## 6. Where things are

```
packages/domain/       PURE. Taxonomy, stages, four axes, banding, clustering, planning,
                       and the FR-06 failure classification table
packages/evaluation/   PURE. Labelled dataset, FR-16 metrics, I1-I10 harness
packages/contracts/    Versioned schemas; the OpenAPI document is generated from here
apps/api/              NestJS. auth/ tenancy/ subjects/ searches/ persistence/ jobs/
                       search-index/ — see below
                       worker-main.ts is the worker entrypoint — same image, same DI graph,
                       no HTTP server (D-016). There is no separate apps/worker package
infra/local/           Docker Compose stack, host ports in the 280xx range
scripts/               local-up, local-bootstrap, local-reset, verify-local
docs/                  architecture, decisions, open-decisions, traceability, status,
                       failure-injection-matrix
```

Inside `apps/api/src`, the four directories Phase C added:

| Directory       | What is in it                                                                                                                                                                                                                                                                       |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin/`        | The D1 approval lifecycle, the SEC-05 gate at activation, and capability coverage                                                                                                                                                                                                   |
| `persistence/`  | The section 6.3 records, and `TransactionRunner` — the one place a transaction opens                                                                                                                                                                                                |
| `jobs/`         | `QueuePort` + SQS adapter, `OutboxPublisher`, `verifyJobOwnership` (SEC-01), and C6's `JobConsumer`, `WorkerRuntime`, `DeadLetterPort` and `JobHandler` interface                                                                                                                   |
| `search-index/` | `SearchIndexPort` behind the D12 seam, the Meilisearch adapter, the FI-10 reconciler                                                                                                                                                                                                |
| `storage/`      | `ObjectStorePort` + S3 adapter, `EvidenceStagingService` (stage → verify → commit, plus the orphan sweep), `RetentionSweeper`                                                                                                                                                       |
| `sources/`      | The six FR-05 ports (D2), their deterministic mocks in `mock/`, the GB-only Companies House adapter, the live `HttpEvidenceFetchAdapter` (E1), and `FetchGateService` — the only issuer of a `FetchAuthorisation` — with its source-version reader and the one egress identity (E2) |
| `associations/` | The FR-02 graph (D3): officer resolution, the `DIRECTOR_OF` edges, and the snapshot frozen to the run                                                                                                                                                                               |
| `pipeline/`     | The search pipeline, the job handler that runs it, and the findings store (Phase E slice)                                                                                                                                                                                           |

The control panel is a separate repository: `../erly-sanction-service-frontend`. It has its
own `CLAUDE.md`. It must never import the domain packages — decision D-001, enforced by lint
and by `src/app/boundaries.test.ts`.
