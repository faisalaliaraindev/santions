# Handoff — Adverse Search Service service

**Date:** 2026-09-10 · **Status:** gates G0, G1, G2 complete; G3 partial · **Audience:** whoever picks this up next

This is the consolidated picture: what exists, what has actually been verified, what is
deliberately not built, and what happens next. For the per-session running log see
[`execution/handoff-log.md`](./execution/handoff-log.md).

---

## 1. What the service is

It retrieves published material about a person, resolves whether that material actually refers
to them, classifies what is reported and at what procedural stage, and grades how well the
evidence supports the connection.

It is **not** a criminal record check, **not** a proof of identity, **not** a determination of
guilt, and **not** a sanctions-list engine. A designation found in reporting is a lead to
verify against the primary list — never a finding. Target Platform keeps its sanctions.io integration
and makes the final compliance decision.

Every source, library and model is free to use, open-source, or public data published by the
issuing authority. There are no paid data subscriptions and no commercial data licences.

---

## 2. Status at a glance

The plan requires three readiness labels to be reported **separately**. Conflating them is how
a screening product claims readiness it does not have.

| Label                    | Status          | What that rests on                                                                                                                                                                             |
| :----------------------- | :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local verified**       | **Partial**     | G0, G1, G2 complete and G3 partial. The stack starts from a clean checkout, seeds itself, survives a restart, and 7 of 8 test suites pass. The end-to-end suite does not exist (Phase G).      |
| **Live source verified** | **Not started** | **No live source has ever been contacted from this project.** No language is enabled, because none carries a measured recall figure. `docs/coverage-matrix.md` is an empty template by design. |
| **Production approved**  | **Not started** | No infrastructure, security, privacy, performance or restore gate has been run.                                                                                                                |

### Gates

| Gate                                    | State                                                    |
| :-------------------------------------- | :------------------------------------------------------- |
| G0 — Discovery and decisions            | **Complete**                                             |
| G1 — Reproducible local foundation      | **Complete**                                             |
| G2 — Domain core and evaluation harness | **Complete**                                             |
| G3 — Identity, tenancy, API contract    | **Partial** — B1 OpenAPI and B9 client generation remain |
| G4–G11                                  | Not started                                              |

### Verification, as of this handoff

```
pnpm lint               clean
pnpm typecheck          clean
pnpm test:unit          191 passed
pnpm test:invariants     29 passed   ← the I1–I10 release gate, needs no infrastructure
pnpm test:evaluation     12 passed
pnpm test:integration    14 passed   ← real stack
pnpm test:security       48 passed   ← real API, real MongoDB
pnpm test:e2e            NOT IMPLEMENTED (Phase G) — exits non-zero by design

pnpm verify:local        7 of 8 suites ok; exits non-zero because e2e is unimplemented
```

Coverage over `packages/domain` and `packages/evaluation`: **93.46% statements, 90.98%
branches** (gate: 85 / 80).

`verify:local` failing is the **intended** behaviour at this gate. A suite that does not exist
is reported as unverified, never as a pass.

---

## 3. Repositories

Two, not the single monorepo the implementation plan assumes. See decision **D-001**.

| Repository                       | Contents                                        | Commits |
| :------------------------------- | :---------------------------------------------- | :------ |
| `adverse-search-service`  | API, domain, evaluation, contracts, infra, docs | 5       |
| `adverse-search-frontend` | React control panel                             | 2       |

**The cost of the split, and how it is paid.** The plan requires the panel and external
integrators to invoke the same application services, and forbids a second matching engine in
the browser. Across two repositories that is no longer enforced by a shared build, so it is
enforced twice in the frontend:

- a `no-restricted-imports` lint rule blocking the domain packages;
- `src/app/boundaries.test.ts`, which walks the source tree and fails the build if any file
  imports domain code, if anything but the API client calls `fetch`, if evidence is rendered
  with `dangerouslySetInnerHTML`, or if anything writes to browser storage.

That guard was verified by planting a violation: it fails with an explanatory message, and
passes again when removed.

---

## 4. What is built

### `packages/domain` — pure, no I/O

No database, network, filesystem or clock reads; callers pass `asOf` explicitly. This is
load-bearing, not stylistic: `pnpm test:invariants` gates every pull request and must run on a
clean checkout with nothing started. A gate needing a database is a gate that gets skipped
exactly when it matters.

| Area                                                                         | Requirement       |
| :--------------------------------------------------------------------------- | :---------------- |
| Taxonomy: 17 categories, 8 exclusion reasons, protected-characteristic stems | FR-03             |
| Build-gating lexicon audit                                                   | FR-03, T79        |
| Procedural stage ladder 0–15 with mandatory display rules and transitions    | FR-09             |
| Party role taxonomy; victim/witness never adverse                            | FR-09, T17        |
| Tenure labelling across all five values                                      | FR-02, T15        |
| Name normalisation, phonetic keys, form matching, transliteration port       | FR-08, T13        |
| Axis A identity + name-frequency prior                                       | FR-08, T11, T71   |
| Axis B attribution, `VIA_ROLE`, `COMPANY_ONLY`                               | FR-08, T73, T74   |
| Axis C event classification                                                  | FR-08             |
| Axis D authority tiers and independence                                      | FR-08, T26        |
| Banding rules engine, pinned to a rules version                              | FR-11             |
| Clustering and event chains                                                  | FR-10, T25–T28    |
| Eight query families, bounding, declared drop order                          | FR-04, T78        |
| Result dimensions, aggregation, no-match statement                           | 6.2, FR-13        |
| Roles, permissions, four-eyes, break-glass                                   | 4.2, T04–T06, T45 |

**The cost of purity:** ICU transliteration, libpostal and NER cannot be imported here. They
are injected through ports. `matchNameForms` therefore genuinely cannot match across scripts,
and its tests assert `NO_MATCH` rather than pretending otherwise.

### `packages/evaluation` — pure, no I/O

- Labelled dataset split by entity **and** syndication family, with a leakage assertion that
  fails loudly rather than warning.
- A 16-case hard-negative-heavy seed corpus: common names, victims, witnesses, plaintiffs, a
  namesake with contradicting DOB, company-only events, syndication families, acquittals,
  corrections.
- The **I1–I10 invariant harness**, wired into CI as a release gate.
- FR-16 metrics, with victim and witness role accuracy measured **separately** and end-to-end
  recall counting discovery misses.

### `packages/contracts`

zod schemas as the single source of truth: the error contract with status and retryability
mappings, FR-01 subject intake, search creation, the three result dimensions, cursor
pagination. Schemas are `.strict()`, so a client typo like `dateofBirth` is rejected rather
than dropped — which would otherwise mean screening someone with no date of birth and nobody
noticing.

### `apps/api`

NestJS with three global guards in order — `AuthGuard`, `CsrfGuard`, `PermissionGuard` — so a
new route is protected by default and must opt out with `@Public()`. The opposite arrangement
ships unguarded routes: the one somebody forgets to decorate is the one that leaks.

- OIDC authorisation-code + PKCE, terminated by a backend-for-frontend session. Provider
  tokens stay server-side; the browser gets an opaque HTTP-only cookie.
- Token verifier on asymmetric algorithms only. HMAC is excluded because with a symmetric
  algorithm anything able to verify a token can mint one.
- Sessions with hashed IDs, idle **and** absolute expiry, constant-time CSRF comparison.
- Entitlement versions pinned to every search, so a historical run can explain why it was
  permitted at the time.
- FR-01 subject intake preserving original scripts, with no name splitting.
- Idempotent search creation: a unique-index claim, so concurrent identical requests commit
  exactly one run.
- FR-15 reserved routes returning **501 with a documented reason**, not 404.
- Production startup guards.

### `infra/local`

Seven services, all healthy: MongoDB replica set, Meilisearch, LocalStack (S3 + SQS),
Keycloak, SearXNG, Ollama, fixture server. Host ports live in a dedicated **280xx** range.

### Frontend

Toolchain, router, TanStack Query, the hand-written API transport (BFF session, CSRF,
idempotency keys, typed errors) and the boundary tests. **None of the twelve FR-14 pages is
built** — deliberately: the plan forbids mock screens, and until now there was no API.

---

## 5. How to run it

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env

pnpm local:up          # 7 services; first run pulls several GB
pnpm local:bootstrap   # idempotent; safe to re-run
pnpm dev               # builds, then serves the API on :3000

pnpm verify:local      # aggregates the mandatory non-live checks
```

**Prerequisites:** Node 22 LTS, pnpm 10.15.0 (`corepack enable`), Docker with Compose v2.

A standalone `mongod` will not do — transactions are required for the state/outbox/audit
commit, and only a replica set provides them.

| Service        | URL                       |
| :------------- | :------------------------ |
| API            | http://127.0.0.1:3000     |
| MongoDB (rs0)  | mongodb://127.0.0.1:28017 |
| Meilisearch    | http://127.0.0.1:28700    |
| LocalStack     | http://127.0.0.1:28566    |
| Keycloak       | http://127.0.0.1:28080    |
| SearXNG        | http://127.0.0.1:28888    |
| Model runtime  | http://127.0.0.1:28434    |
| Fixture server | http://127.0.0.1:28090    |

Synthetic accounts (password `local-development-only`): `alpha.analyst`, `alpha.reviewer`,
`alpha.viewer`, `beta.analyst`, `beta.reviewer`, `source.admin`, `source.approver`,
`platform.operator`, `auditor`.

---

## 6. Design decisions worth knowing

Full detail in [`decisions.md`](./decisions.md). The ones that shape everything else:

**D-001 — two repositories.** Enforced by lint and by a boundary test, since a shared build no
longer does it.

**D-004 — the domain core does no I/O.** So the invariant gate runs on a clean checkout.

**D-005 — the seed dataset carries axis inputs, not just labels.** This is what makes the
Phase F checkpoint checkable rather than assertable: the same harness runs against real
pipeline output using the same labels.

**D-006 — the event-date cluster bucket is a blocking hint, not identity.** Found by a test:
fixed buckets split two reports of one event six days apart, which under-counts independence
and therefore lowers the band.

**D-008 — the band is an evidentiary statement, not a statement of adversity.** A
well-evidenced acquittal correctly bands `CORROBORATED` — what is corroborated is an
acquittal. The fairness is carried by the stage and outcome status shown alongside. The
residual presentational risk is **open decision D11**.

**Three rules that override convenience**, restated in `CLAUDE.md`:

1. Never weaken an invariant to make something pass.
2. A suite that does not exist fails; it never passes vacuously.
3. Never claim verification that did not happen.

---

## 7. Defects found by actually running things

Recorded because they are the kind that stay hidden until they produce a wrong result.

### Domain (G2)

1. **The lexicon audit could be evaded by hyphenation.** `Trans-gender` folded to
   `trans gender` and missed the stem `transgender`, so a protected characteristic could have
   reached an outbound query.
2. **Fixed event-date buckets split events.** Two reports six days apart landed in different
   30-day buckets and were never compared — silently splitting the event, under-counting
   independence, and lowering the band.
3. **A `VIA_ROLE` finding did not explain its ceiling.** The band was right; the reviewer was
   not told it can never reach `CORROBORATED`.

### Infrastructure (G1)

4. **Port 27017 was already held** by another MongoDB on the dev machine. All host ports moved
   to a dedicated range.
5. **Keycloak could not write its H2 volume** (root-owned mount, uid 1000 process). Removing
   the volume is the better design anyway — the realm imports from committed JSON on every
   start, so a dev database cannot silently diverge from it.
6. **The Keycloak healthcheck hung** — no curl or wget in the image, and the `/dev/tcp` probe
   lacked `Connection: close`. The container reported unhealthy while serving perfectly.
7. **S3 creation 400'd** on a misleading "unspecified location constraint" — form-encoding was
   being sent for S3, so LocalStack never parsed the XML. Worth noting: the first fix
   **silently did not apply** and only appeared to work because manual debugging had already
   created the bucket. Caught by deleting it and running from empty.
8. **`local:up` reported a healthy stack as broken**, because `mongo-init` is a one-shot that
   exits 0 and `--wait` treats that as failure. A false alarm is worse than no check — it
   teaches people to ignore the check.

### API (G3)

9. **esbuild does not emit decorator metadata**, so NestJS DI resolved to `undefined` under
   vitest while working under `tsc`. Fixed with explicit `@Inject()`, which removes the
   dependency rather than working around it.
10. **Health endpoints were version-prefixed.** A load balancer would have needed to know the
    API version, and a version bump would silently 404 every probe.
11. **Circular import crash at startup** — a controller imported a DI token from `app.module`,
    which imports every controller. The ESM error pointed at the wrong file.
12. **A brittle integration assertion** demanded exactly two tenants, so it broke when a
    security test created one.
13. **A test's cleanup was not in a `finally`**, so one failed run poisoned an unrelated suite
    later, with the failure pointing at the wrong test.

---

## 8. What is deliberately NOT built

Being explicit, because the absence of these is the difference between this being honest and
being a demo.

- **No live source has ever been contacted.** Every source contract in the plan is unverified
  against a real endpoint.
- **No language is enabled.** FR-03 requires a measured recall figure; none has been measured.
  Every coverage statement must say so.
- **No extraction model is pulled.** Ollama runs, but pulling a model to make a health check
  look greener would decide open decision D7 by accident.
- **No worker, no persistence layer beyond the API's own collections, no sources, no fetch,
  no extraction, no clustering pipeline.** The domain rules exist; nothing feeds them yet.
- **No control-panel pages.** Mock screens are forbidden by the plan and the API only just
  became real.
- **The FR-15 commercial layer** is deferred by decision D-007; reserved routes return 501.
- **`test:e2e` and `test:load`** do not exist and exit non-zero.

---

## 9. Open decisions — several need people outside engineering

From [`open-decisions.md`](./open-decisions.md). **A decision blocks its gate's exit.**

| ID      | Decision                                               | Owner                        | Closes at    |
| :------ | :----------------------------------------------------- | :--------------------------- | :----------- |
| **D10** | Minimum identity data an integrator must supply        | Product + Target Platform            | G3 — **now** |
| D12     | Search index: OpenSearch or Meilisearch                | Engineering (by measurement) | G4           |
| D1      | Which jurisdictions and languages are enabled first    | Source/policy admin          | G5           |
| D3      | Which categories are on by default                     | Taxonomy admin               | G5           |
| D8      | Retention per source and jurisdiction                  | Compliance                   | G5           |
| D6      | How robots exceptions are approved and recorded        | Source admin                 | G6           |
| D4      | Boundary between adverse media and list matching       | Product + compliance         | G7           |
| D5      | Reviewer capacity assumption                           | Product + compliance         | G7           |
| D7      | Which open-weight extraction model                     | Engineering                  | G7           |
| D9      | Whether numeric confidence is ever shown (default: no) | Product                      | G7           |
| D11     | Visual weight of stage/outcome vs band                 | Product + design             | G8           |
| D2      | Declared archive horizon per source                    | Source/policy admin          | G10          |

**D10 needs attention now.** The FR-01 subject schema is implemented as the permissive
superset — full name required, everything else optional, sparse identity searchable but left
unresolved. That is defensible and it is recorded as an explicit assumption rather than
hardened by silence, but it is now baked into a schema that later phases build on.

**D1, D3 and D8** have placeholder values seeded (GB only, eight categories, no retention
rule), each carrying an `assumption` field **on the record** so the placeholder cannot quietly
become the decision. They should be raised before Phase D starts, not at its exit.

---

## 10. What happens next

Ordering and rationale in [`delivery-plan.md`](./delivery-plan.md); per-phase briefs in
[`execution/`](./execution/).

### Immediately — finish Phase B

1. Generate the **OpenAPI document** from the zod schemas in `packages/contracts` (B1).
2. Wire the frontend's `pnpm api:generate` to it and commit the generated client (B9).

That closes G3.

### Phase C — persistence, jobs, index, storage (G4)

The §6.3 record schemas with tenant context leading every key; transactions and the outbox;
search-index integration; **the matcher-latency workload test that settles D12**; S3 staging
with checksum and orphan reconciliation; retry classification, DLQ, lease fencing.

The part that is easy to get wrong: S3, index and queue publication are **not** inside the
MongoDB transaction. Stage the upload, verify the checksum, commit the reference, publish
through the outbox — and reconcile. A successful evidence reference must never point at a
missing object.

### Phase D — sources, graph, taxonomy admin (G5)

Four-eyes approval; free registry adapters plus deterministic mocks; sourced identity and edge
resolution feeding the existing tenure logic; source health and kill switches; the lexicon
audit wired into **activation**, not only CI. Closes D1, D3, D8.

### Phase E — planning, cascade, fetch (G6)

The eight families generated from real subjects; the seven-rung cascade; the egress pool and
failure classifier; relevance filtering and the fetch gate; **scheduled contract tests for
every undocumented source**.

That last one is not polish. A silent parse failure on Google News RSS reduces recall to zero
and the system starts reporting clean results for everyone. Closes D6.

### Phase F — extraction and the full pipeline (G7)

**The most important checkpoint in the whole plan: I1–I10 must pass against real pipeline
output, not only the G2 fixtures.** That is checkable rather than assertable because the
harness is the same code (decision D-005). If making it work requires modifying the harness,
the pipeline is wrong, not the harness. Closes D4, D5, D7, D9.

### Phase G — the control panel (G8)

All twelve FR-14 pages against the real API. Closes D11.

### Phase H — integration, live sources, hardening (G9–G11)

G9 the Target Platform contract; **G10 the first live calls this project has ever made** — measuring
archive horizons, per-language recall, and populating the coverage matrix; G11 hardening and
the readiness report.

Plan for the possibility that measured free-source recall is lower than hoped in some
languages. **The correct response is to disable those profiles and publish the figure, not to
relax the threshold.**

---

## 11. How to pick this up

The project is executed **one phase per session, with context cleared between phases**,
because the two source specification documents total ~167KB and reading them cold leaves more
room to plan than to work.

1. `CLAUDE.md` loads automatically and points at
   [`execution/START-HERE.md`](./execution/START-HERE.md).
2. That file names the active phase, the narrow reading list, and — importantly — **what not
   to read**.
3. Read the recent entries in [`execution/handoff-log.md`](./execution/handoff-log.md), then
   your phase brief.
4. Run the ten-second health check before building on anything.
5. Before the session ends: append a handoff entry, tick the brief's checklist, move the
   active-phase pointer if the phase completed, and commit.

Phase briefs for A and B are complete. **C through H are outlines, expanded into full briefs
at the start of their phase** — deliberately, because their detail depends on what earlier
phases reveal. Writing them out now would harden guesses into instructions.

---

## 12. Document map

| File                                | What it is                                     |
| :---------------------------------- | :--------------------------------------------- |
| `docs/handoff.md`                   | **This document**                              |
| `docs/execution/START-HERE.md`      | Session entry point                            |
| `docs/execution/handoff-log.md`     | Per-session running log                        |
| `docs/execution/phase-*.md`         | Per-phase briefs                               |
| `docs/delivery-plan.md`             | Why the phases are in this order               |
| `docs/implementation-status.md`     | Gate-by-gate status and known gaps             |
| `docs/architecture.md`              | Pipeline, trust boundaries, threat model       |
| `docs/decisions.md`                 | Architecture decisions with rationale and cost |
| `docs/open-decisions.md`            | D1–D12 with owners and closing gates           |
| `docs/requirements-traceability.md` | FR/SEC/REL and T01–T90 mapped to code          |
| `docs/coverage-matrix.md`           | **Empty template until G10**                   |
