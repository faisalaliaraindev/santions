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
