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
> keys with nobody at Adverse Search involved.
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
> **Signup → confirm → sign in → issue your own key now runs end to end**, with nobody at Adverse Search
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
> run in ~130ms as `FAILED`, which looks exactly like a provisioning bug and is not one. **As of
> 2026-09-21 it can no longer steal an e2e suite's messages** — see "Queue isolation" below — so
> you may leave `pnpm dev` running while the suites run.
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

### ONE ENDPOINT FOR EVERYTHING — 2026-09-23

**`POST /v1/screen` runs every source in one call, or one source with `"sources": ["<id>"]`.**
Result in the same response, no polling, no worker needed (it runs inside the API). Sources left
out are `SKIPPED`, so a single-source run is always `INCOMPLETE`; an unknown id is a `400` listing
the searchable ids (D-066). Google works through it with the local diagnostic header.
Test it with Postman **Folder 20**; the walkthrough is
[`../testing/live-test-sequence.md`](../testing/live-test-sequence.md).

### THREE LIVE SOURCES ACTIVE — reached 2026-09-18

Two publishers, three sources, all `ACTIVE` in the registry and all reachable:

| Source id                 | Active version | Connector              | Endpoint kind | Rung | Domain                 |
| :------------------------ | :------------- | :--------------------- | :------------ | :--- | :--------------------- |
| `sec-litigation-releases` | v5             | `NEWS_DISCOVERY_RSS`   | `FIXED_FEED`  | 1    | `www.sec.gov`          |
| `sec-press-releases`      | v1             | `NEWS_DISCOVERY_RSS`   | `FIXED_FEED`  | 1    | `www.sec.gov`          |
| `gdelt-doc-v2`            | v1             | `NEWS_DISCOVERY_GDELT` | `QUERY_FEED`  | 3    | `api.gdeltproject.org` |

`gdelt-doc-v2` carries `queryParam: query` and `requestCeilingPerSecond: 0.2`. **D18** (2026-09-18,
Faisal Ali, Source admin) authorised first contact with GDELT; D17 covers `www.sec.gov` only and
was not copied into it. Evidence: [`../sources/gdelt-evidence.json`](../sources/gdelt-evidence.json)
and [`../sources/sec-press-robots-evidence.json`](../sources/sec-press-robots-evidence.json).

Verify with `GET /v1/admin/sources?limit=200` on a **`source_admin`** credential — a
`tenant_admin`/`analyst` key is authenticated but not permitted, and answers 403.

Run the mixed live test with Postman folder **15 — Mixed Live E2E: SEC + GDELT**, armed by
`mixedLiveConfirm = yes-contact-sec-and-gdelt`. The runbook is
[`../sources/mixed-live-go-live.md`](../sources/mixed-live-go-live.md).

### NINE INDEXED SOURCES ARE ACTIVE AND HOLD REAL LOCAL SNAPSHOTS — 2026-09-21

A source can be read in a **second** shape. A discovery source is read at query time. An
**indexed** source is downloaded whole on a schedule, parsed into a local snapshot, and searched in
our own database — so it costs **no publisher request per search** and keeps answering while the
publisher is down. Decisions **D-062** to **D-065**; the mechanism is in
[`../architecture.md`](../architecture.md) under "Indexed sources".

They were content builders in code only until 2026-09-21. They are now onboarded, ACTIVE, and
populated from their real publishers:

| Source id                                | v   | State    | Rows   | Publisher                       |
| :--------------------------------------- | :-- | :------- | -----: | :------------------------------ |
| `ofac-sdn`                                | 2   | ACTIVE   | 19,393 | US Treasury OFAC                |
| `uk-sanctions-list`                       | 2   | ACTIVE   |  6,340 | FCDO                            |
| `eu-consolidated-financial-sanctions`     | 2   | ACTIVE   |  6,234 | European Commission             |
| `unsc-consolidated`                       | 2   | ACTIVE   |  1,011 | UN Security Council             |
| `ofac-consolidated-non-sdn`               | 2   | ACTIVE   |    481 | US Treasury OFAC                |
| `ftc-consumer-protection-press-releases`  | 2   | ACTIVE   |     30 | US FTC                          |
| `doj-fraud-enforcement`                   | 2   | ACTIVE   |     25 | US DOJ                          |
| `fca-warnings`                            | 2   | ACTIVE   |     20 | UK FCA                          |
| `cftc-enforcement-press-releases`         | 2   | ACTIVE   |     10 | US CFTC                         |
| `world-bank-debarred`                     | 2   | APPROVED |      0 | World Bank — **blocked**        |

**33,544 indexed records.** `world-bank-debarred` is deliberately not ACTIVE: its gateway needs
`WORLD_BANK_SANCTIONS_API_KEY`, which this deployment does not hold, and `robots.txt` on
`apigwext.worldbank.org` answers 403 from a WAF. Both are recorded on the version and on
[`../sources/evidence/world-bank-debarred.json`](../sources/evidence/world-bank-debarred.json). A
source stopped at APPROVED behind an evidenced blocker is the correct outcome, not a gap in the
work.

**How to reproduce this on a clean deployment** — the whole point, and previously undocumented:
[`../sources/indexed-source-onboarding.md`](../sources/indexed-source-onboarding.md). Three acts:
`pnpm indexed:first-contact` gathers evidence, `pnpm source:onboard --apply` drives
propose → submit → approve → activate over the **real Admin API** with two distinct principals, and
a controlled refresh fills the snapshot. Nothing writes to Mongo outside the repositories.

**D6 closed** (2026-09-21, Faisal Ali, Source admin). Four publishers serve their bulk file from
their own delivery host whose `robots.txt` answers 403, which this service reads as `UNKNOWN` and
refuses. The exception is recorded on the version, **scoped to named delivery hosts**, and usable
only on the scheduled-artifact path. A hop to any other host is still refused. See §6 of the
onboarding document.

### SEC DISCOVERY IS BACK ON — 2026-09-21

**`sec-litigation-releases` (v5) and `sec-press-releases` (v1) are ACTIVE again.** They were
SUSPENDED because the discovery identity matcher compared the subject's name **to itself** and
could reach `CONFIRMED` on a name alone. That defect was fixed in the twenty-first session and the
two sources were restored through the real lifecycle on 2026-09-21 — `RESTORE` is four-eyes and
re-runs the SEC-05 rights gate, and `db.auditEvents.countDocuments({action:
'source:four_eyes_bypassed_for_testing'})` is still **0**.

**`gdelt-doc-v2` stays SUSPENDED**, deliberately. It is outside this milestone and its budget is
not ours to spend; its daily spend is 0 and the acceptance run asserts that it stays that way.

Restoring a suspended source has its own operator command, because onboarding is a different shape
from restoring and a script with two modes is one nobody reads carefully before running:

```
SOURCE_APPROVER_KEY=asvc_... pnpm source:restore --apply --source <id> --reason "..."
pnpm source:restore                                  # plan only, lists what is SUSPENDED
```

The approver must not be the credential that **proposed** the version — four eyes is checked
against `proposedBy`. Note also that **releasing a kill switch is four-eyes in its own right**: the
principal who engaged it is refused, which is correct and is easy to discover the hard way by
leaving a source switched off for every later run.

**The combined acceptance run is the gate for all of this:**

```
COMBINED_LIVE_ACCEPTANCE=yes-contact-the-sec pnpm test:live:acceptance    # 11 passed
```

`tests/live/acceptance/combined-adverse-search.test.ts` — nine indexed sources from local
snapshots plus both SEC feeds live, in one deployment, asserting zero publisher requests for
indexed sources, the shared FR-08 resolver on the discovery path, AMBIGUOUS on a name alone, no
`FULL_DOB`/STRONG from a year-only date, tier read from the source version, FR-10 clustering live
in the runtime, independent authorities kept independent, indexed findings surviving a SEC failure,
and no fixture id anywhere. Postman folder **17** runs the same claims over HTTP.

One limitation is recorded rather than hidden: **copy *suppression* cannot be exercised in this
deployment**, because FR-10 never suppresses a tier-1 issuing authority as a copy and every ACTIVE
source here is one. The runtime asserts the half that protects a subject — a duplicate must not
inflate the independence count — and the suppression path itself is proved over constructed
candidates in `packages/domain/test/clustering/assign.test.ts`. The acceptance suite fails loudly
the day a source below tier 1 is activated, so that reasoning cannot expire silently.

Two things an operator uses:

- `GET /v1/admin/indexed-sources` — usability, freshness, row count, parser version, last failure
  and last snapshot prune per source. Needs `platform:read_health`.
- `POST /v1/admin/indexed-sources/{sourceId}/refresh` — one refresh now. Needs `source:approve`
  **and** the header `X-Allow-Publisher-Contact: true`.

Postman folder **16 — Global Indexed Sources E2E** is the acceptance test: 17 requests,
136 assertions, including that a tenant search causes **zero** publisher downloads.

A refresh **never** replaces a usable snapshot with a worse one (D-063), and a source with no
snapshot is reported as a **coverage gap** at rung 0 — never as a source that looked and found
nothing. Old snapshots are now **pruned**: the active one and one previous are kept, everything
older is deleted in a bounded pass, and `lastPrune` on the operator view shows it happening.

### A recorded ceiling is now enforced — 2026-09-18

`accessPolicy.requestCeilingPerSecond` had been recorded on every source version since FR-05 and
**read by nothing**. `RequestPacer` (`apps/api/src/sources/request-pacer.ts`) enforces it inside
`HttpEvidenceFetchAdapter`, keyed on the host, for every outbound request — the document fetch,
each redirect hop, and the robots.txt read before them. Driven from the approved version, never
from a constant.

Two consequences a session will meet:

- **A live GDELT run is slow on purpose** — 24 requests at 5 seconds each. `JOB_LEASE_MS` and
  `JOB_MAX_EXECUTION_MS` in `.env` were raised for it and folder 15 polls up to 400 times.
- **An unreadable robots.txt is no longer cached.** It used to be cached for the full 24-hour TTL,
  so one transient 429 refused a publisher for a day. Only a _known_ answer is cached now; a 404
  is a known answer (the site restricted nothing) and is cached like any other.

### TEMPORARY: `DISABLE_SOURCE_FOUR_EYES_FOR_TESTING`

A testing-only flag exists that lets one principal both propose and approve a **SOURCE** version.
Default `false`; setting it in production is a **startup failure**. It forgives an identity, never
a permission, never the rights clearance, never an audit entry, and never applies to a taxonomy or
a policy. Every approval taken under it is marked permanently in the version's own history and as
its own audit action `source:four_eyes_bypassed_for_testing`.

**It was not needed for the three sources above** — all three were approved by a credential
distinct from the proposer, and `db.auditEvents.countDocuments({action:
'source:four_eyes_bypassed_for_testing'})` is `0`. Remove the flag from `.env` when the live
testing is finished.

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

### Two source shapes on the ladder — added 2026-09-18

The FR-05 ladder is no longer all fixed feeds. Two proposals now exist **in code and not in the
registry**, and the difference matters:

| Source id                 | Shape        | Rung | Publisher            | State                          |
| :------------------------ | :----------- | :--- | :------------------- | :----------------------------- |
| `sec-litigation-releases` | `FIXED_FEED` | 1    | www.sec.gov          | **ACTIVE** since 2026-09-16    |
| `sec-press-releases`      | `FIXED_FEED` | 1    | www.sec.gov          | proposal in code, **not live** |
| `gdelt-doc-v2`            | `QUERY_FEED` | 3    | api.gdeltproject.org | proposal in code, **not live** |

A `FIXED_FEED` costs **one request per poll floor however large the query plan is**. A `QUERY_FEED`
costs **one request per planned query, bounded by its budget**. Neither claim was checkable from
anything the API returned, so `GET /v1/searches/{id}/findings` now carries **`liveDiscovery`**
(**D-060**): per source, the recorded `endpointKind`, hosts, queries offered, requests issued,
requests served without a socket, **distinct endpoints**, and the FR-04 families that reached the
wire. No query text and no URLs — endpoint identity is a one-way digest.

**Postman folder 15 — Mixed Live E2E: SEC + GDELT** runs the mixed live search and asserts the
architecture rather than `SUCCEEDED`. It is armed by `mixedLiveConfirm = yes-contact-sec-and-gdelt`,
which is **not** folder 14's `liveConfirm`. It halts unless all three sources are ACTIVE, and it
activates nothing.

**Nothing has contacted GDELT.** Activating either proposal takes acts by people — robots, terms,
endpoint verification, a named first-contact approval, four-eyes propose → approve → activate. The
SEC's D17 covers the press-releases feed and does **not** cover GDELT.
[`docs/sources/mixed-live-go-live.md`](../sources/mixed-live-go-live.md) is the runbook.

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

Expected today (2026-09-21): clean, clean, and **1101 passed across 66 files** for the three pure
projects run together (`pnpm exec vitest run --project unit --project invariants --project
evaluation`).

### Queue isolation — added 2026-09-21, and it is not a flakiness workaround

Two things used to cross between test runs, and both failures named the **victim** rather than the
cause, which cost two sessions:

1. **A long-running `pnpm dev` worker** polls `adverse-search-jobs` from `.env`, in whatever mode
   and whatever build it booted with, and took messages from the e2e suites. Every suite in
   `tests/e2e` now creates and polls **its own queue** — `tests/e2e/support/queues.ts` has the
   whole account. Proven: `pnpm test:e2e:api` is 34/34 with a **live** `pnpm dev` worker running.
2. **The shared outbox.** Per-suite queues stop a *consumer* crossing but not a *producer* one:
   the three e2e suites share one database, so `OutboxPublisher.publishOnce` in one app claims
   another app's `search.queued` row and posts it to **its own** queue. That is correct in
   production — many API instances, one outbox, one queue — and impossible there, because no two
   production instances hold different `JOBS_QUEUE_URL`s. The fix is `--no-file-parallelism` on
   the `test:e2e:api` script, so only one publisher is ever live.

**`fileParallelism: false` set on a vitest *project* is accepted silently and does nothing.** The
flag lives in the `package.json` script. If it is ever dropped, the suites start crossing their own
searches again; the only visible symptom is the summed test time exceeding the wall-clock duration.

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

The control panel is a separate repository: `../adverse-search-frontend`. It has its
own `CLAUDE.md`. It must never import the domain packages — decision D-001, enforced by lint
and by `src/app/boundaries.test.ts`.
