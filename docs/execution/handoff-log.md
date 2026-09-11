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

## 2026-09-11 (last) — Phase B complete: T08, T07 and T68 closed; gate G3 met

**Did:**

- **T08 — CSRF and CORS, as executable checks.** The CSRF guard already existed; what did not
  exist was any test that it fires. `tests/security/session-lifecycle.test.ts` drives the
  assembled application with real cookies: a write with a valid session and no token is refused,
  so is one carrying **another session's** token, and so is one carrying a token truncated by a
  single character (which would pass a length-insensitive or short-circuiting comparison). The
  same write succeeds once the matching token is sent — without that control, the four refusals
  above would also pass if writes were simply broken. A bearer-authenticated machine client is
  deliberately **not** asked for a CSRF token, because a browser cannot set an `Authorization`
  header on its own and demanding one would be theatre that breaks integrators.
- **CORS moved out of the bootstrap** into `apps/api/src/common/cors.ts`, so the exact object
  the application installs can be asserted: origins are always an explicit list, never `true`,
  never `'*'`, never a function that could reflect the request, and **`false` when nothing is
  configured**. A missing configuration must fail closed, or the development convenience is what
  ships.
- **T07 — logout, revocation, expiry and key rotation.** Fourteen tests covering the property
  that actually matters: old access stops working. A logged-out cookie is refused; a revoked
  session is refused on writes as well as reads (401, not 403 — the credential is gone, so it is
  not a CSRF failure); `revokeAllForSubject` kills every session a person holds, not just the
  browser they signed out of; an idle-expired and an absolutely-expired session are both
  refused, the latter even while actively used; and an unknown session ID is answered
  identically to a revoked one, so session IDs cannot be probed. Rotation is tested in
  `auth.test.ts`: during provider overlap both keys verify, and once the retired key is
  withdrawn a token signed with it fails on the **signature** — a verifier that keeps honouring
  a retired key makes rotation meaningless, since the compromised key is still a signing key.
- **T68 — the API key lifecycle**, `apps/api/src/tenancy/api-key.service.ts`, and it is wired
  into `AuthGuard` rather than left as unreachable code. Keys look like
  `erly_<environment>_<keyId>_<secret>`: the environment is in the credential so a live key
  pasted into a sandbox configuration is visible as a mistake, and the key ID makes verification
  one indexed lookup instead of hashing the presented secret against every key a tenant owns.
  The secret is returned **once**, from `create`, and only a SHA-256 hash is stored — there is
  deliberately no method that returns a secret, because an API that can show a key again will be
  asked to. Rotation keeps the key's identity and invalidates the previous secret with no grace
  period; revocation is immediate, idempotent and permanent; a revoked key cannot be rotated back
  into service; and creation, rotation and revocation each write an audit entry with an actor and
  a reason. `lastUsedAt` is updated on every successful verification, which is what makes an
  unused key identifiable and therefore safe to revoke.
- **The API key is a documented credential.** `apiKey` was added to the OpenAPI security schemes
  with its own `ApiKey` scheme rather than a second flavour of `Bearer`. Regenerating the
  panel's client produced **no diff**: `openapi-typescript` does not emit security schemes as
  types, because they describe how to authenticate rather than what a payload looks like. The
  panel is unaffected — it authenticates with the session cookie and never holds a key.
- Registered `ApiKeyService` in the module and its indexes in `StartupService`.

**Verified:**

```
backend:   lint clean · typecheck clean · format:check clean
           test:unit 206 passed · test:invariants 29 · test:evaluation 12
           test:integration 14 passed
           test:security 86 passed  (was 48: +4 rotation/CORS, +14 session, +18 API key)
           verify:local 7 of 8 ok; only e2e unimplemented (Phase G)
frontend:  lint clean · build clean · format:check clean · test:unit 35 passed
```

Three guards verified by planting a violation rather than by assuming:

- making `CsrfGuard.canActivate` return `true` unconditionally fails exactly the three CSRF
  refusal tests;
- deleting the revocation check in `ApiKeyService.verify` fails "refuses immediately after
  revocation";
- (from the earlier session) editing the committed OpenAPI document, and adding an undocumented
  route, each fail their own guard.

**Left half-done:** nothing in Phase B. Gate G3 is **Complete** and the active phase pointer now
reads **C**. `phase-c.md` is still an outline; expanding it is the first task of that phase, by
design — its detail depends on what Phase B revealed, and writing it earlier would harden
guesses into instructions.

**Found — three things:**

1. **`format:check` and the OpenAPI drift test contradicted each other.** The generator wrote
   `JSON.stringify(…, null, 2)`, prettier wanted its own layout for the same file, and no
   committed file satisfied both — each check demanded the other's failure. The generator now
   formats its output with the repository's prettier configuration, so there is one right answer.
   Worth remembering for any future generated artefact that prettier also globs.
2. **A test tenant needs more than an entitlement to create a search.** The API key tests first
   failed at 403, then at 422: a tenant must also have an **active taxonomy version and policy
   version**, which only `local:bootstrap` seeds. The tests now use the seeded `tenant-alpha` and
   `tenant-beta` wherever they create a search — inventing a tenant produced a 422 that said
   nothing about the key under test, which would have made a green result meaningless.
3. **`POST /v1/subjects` declares a permission but no scope.** So a key scoped to `search:read`
   can still create a subject, while `POST /v1/searches` correctly refuses it. That may be
   intentional — creating a subject is not running a search — but it is worth a deliberate
   decision rather than an accident of which routes carry `@RequireScope`. Not changed here,
   because changing it silently would alter the machine contract.

**Next session should:** expand `docs/execution/phase-c.md` from an outline into a full brief,
then start C1 — the section 6.3 record schemas, migrations and indexes, with tenant context
leading every key. Note that C4, the matcher-latency workload test, is what settles open
decision **D12**; Meilisearch is still only a working assumption behind the `SEARCH_INDEX_KIND`
seam.

**Decisions touched:** none closed. D-007 is respected — the API key service is provider-side,
and tenant self-service key management still answers 501. The scope question in **Found 3** is
new and unrecorded; it belongs to whoever owns the machine contract.

---

## 2026-09-11 (later) — Phase B steps B1 and B9: the OpenAPI document and the panel's client

**Did:**

- **`packages/contracts/src/openapi/`** — the document is _generated from the zod schemas_,
  never hand-written. `components.ts` converts a registry of twenty schemas in a single pass
  (one pass matters: converting them separately would inline `Alias` into three parents under
  three names instead of referencing one component) and builds the error responses from the
  existing `ERROR_STATUS` map, so nobody chooses a status by hand and a code cannot document
  itself under the wrong one. `document.ts` carries the paths, both security schemes, the
  shared parameters and the examples.
- **Two new contract schemas**, because the panel needs them typed and neither existed:
  `sessionInfoSchema` (`auth/session.ts`) and `healthStatusSchema` / `dependencyHealthSchema`
  (`common/health.ts`). The health and auth controllers now declare these as their return
  types, so a field added to a response without being published fails `pnpm typecheck`.
- **`pnpm openapi:generate`** writes `openapi/openapi.json`. It is committed: a contract change
  arrives as a reviewable diff in the pull request that caused it, rather than as a runtime
  surprise in a consumer.
- **`apps/api/test/openapi-document.test.ts`** — four checks tying the document to reality: the
  committed file matches what the builder produces, every route the controllers serve is
  documented, every method is documented, and nothing is documented that no controller serves.
  Route metadata is read from the controller classes with `Reflect`, not by booting the app —
  a contract check that only runs with MongoDB and Keycloak up is a check that stops running.
- **`packages/contracts/test/openapi.test.ts`** — eleven property checks: every `$ref` resolves,
  operation IDs are unique, every authenticated operation documents 401 and 403, exactly four
  operations are public, every error code appears once under the right status, request bodies
  are strict, and the three result dimensions stay three fields.
- **Frontend `pnpm api:generate`** now works. It emits `src/lib/api/generated/schema.ts` (via
  `openapi-typescript`), `operations.ts` (one function per callable operation, emitted by this
  repository's own script) and `index.ts`, all prettier-formatted and committed. Reserved FR-15
  routes get **no** function — a typed function for a route that answers 501 is an invitation
  to call it — and sign-in is exported as `AUTH_LOGIN_PATH` to navigate to, not a function to
  fetch.
- **`src/lib/api/generated.test.ts`** — seven tests: every published callable operation has a
  function, reserved routes have none, business calls go to `/v1`, auth and health do not, path
  parameters are escaped, and the idempotency key and CSRF token still reach the transport.

**Verified:**

```
backend:   lint clean · typecheck clean · format:check clean
           test:unit 206 passed (+15) · test:invariants 29 · test:evaluation 12
           test:integration 14 passed · test:security 48 passed   (real stack, bootstrapped)
           verify:local  7 of 8 suites ok; only e2e unimplemented (Phase G)
frontend:  lint clean · build clean · format:check clean · test:unit 35 passed (+8)
```

Both new guards were verified by planting a violation, not by assuming they work:

- editing one summary in `openapi/openapi.json` fails the drift test with "run
  `pnpm openapi:generate`"; restoring it passes.
- adding an undocumented `@Get('v1/probe')` to `HealthController` fails the route-coverage test
  naming the route; removing it passes.

**Left half-done — Phase B is still NOT complete.** B1–B9 are done, but three definition-of-done
items remain, and the previous handoff did not name them:

- **T07** — logout, revocation and key rotation. `POST /auth/logout` exists and revokes the
  session, but there is **no test** that old access stops working, and no JWKS rotation test.
- **T08** — CSRF and CORS. The production startup guard rejects a wildcard origin (tested), but
  there is no test that a state-changing request without `X-CSRF-Token` is refused by the
  running API.
- **T68** — environment-scoped API keys do not exist at all. The only API-key surface is the
  reserved route answering 501. B5 asks for hashed material, one-time secret display, rotation,
  revocation, expiry, last-used tracking and scopes.

G3 stays **Partial** in `implementation-status.md` for exactly these three.

**Found — four things, all real:**

1. **`GET /auth/session` was documented without a 403.** The property test caught it: the route
   requires `search:read`, so it can deny. A documented route that omits 401/403 reads as
   public, and the panel would treat a denial as an unexpected failure rather than offering a
   way back in. The document was fixed, not the test.
2. **A zod `.refine` does not survive into JSON Schema.** `createSearchSchema` requires exactly
   one of `subjectRef` and `subjectSnapshot`; that rule is a refinement, so the generated types
   let a caller supply neither or both. The API still rejects it at runtime, but the panel will
   not be stopped at compile time. Worth an explicit runtime check in the page that builds the
   request, and worth remembering before relying on any other refinement for safety.
3. **"Document order" for response statuses is not recoverable from parsed JSON.**
   `Object.keys` returns integer-like keys ascending, so `createSearch` — which declares 202
   then 200 — generated a client typed on the **200 idempotent replay** as its normal outcome.
   The emitter now ranks statuses explicitly (202, 201, 200, …). The generated type happened to
   be identical here, but the documented meaning was the opposite of what the service does.
4. **The hand-written client could only reach `/v1`.** Auth and health are `VERSION_NEUTRAL` on
   the service, so `authSession` would have requested `/v1/auth/session` and 404'd, which reads
   as an outage. `RequestOptions` gained a `basePath` (default `/v1`) and the generated
   operations for those routes pass an empty one. This is the **only** hand-written change to
   `client.ts`; transport, session, CSRF and error typing are untouched.

**Next session should:** close the three remaining Phase B items, in this order — T08 first
(a CSRF-rejection test against the running API, the cheapest and the one protecting a live
surface), then T07 (assert that a revoked session's cookie stops working, and that a rotated
signing key invalidates old tokens), then T68 (build the API key lifecycle from B5). Only then
move the G3 gate to Complete and set the active phase to C.

**Decisions touched:** none closed. D-007 is now visible to integrators rather than implied —
the four reserved routes are published with their 501 and the decision named in the description.

---

## 2026-09-11 — four open decisions closed by product

**Did:** recorded D-009 to D-012 in `docs/decisions.md`, marked D1, D3, D8 and D10 closed in
`docs/open-decisions.md`, and updated the seeded configuration: all seventeen categories,
Costa Rica as the only jurisdiction, Spanish and English requested, evidence retention
configurable at 30 days.

**Verified:** `pnpm local:bootstrap` re-run clean; seeded taxonomy reads 17 categories, CR,
es+en both UNMEASURED, retention 30. `pnpm verify:local` unchanged — 7 of 8 suites ok.

**Left half-done:** nothing from this change. Phase B still needs the OpenAPI document (B1)
and the panel client generation (B9).

**Found — three consequences of the Costa Rica choice that are now critical path:**

1. **Every free source named in the plan is UK or US.** Companies House, SEC EDGAR and
   CourtListener do not cover Costa Rica. CR source discovery is now Phase D critical path,
   not a detail. Candidates listed in decision D-010; none verified, none approved.
2. **The Spanish lexicon cannot be machine-translated** (strategy §6.2). It needs a
   Spanish-reading reviewer, and it is a Phase D deliverable rather than a translation task.
3. **Name-only input means most searches will be unresolved.** Correct behaviour under Axis A,
   but it sets reviewer workload and feeds open decision D5. A Costa Rican name-frequency
   distribution is now worth loading, or the FR-08 frequency penalty never fires for common
   surnames.

**Next session should:** finish Phase B — generate the OpenAPI document, then wire the panel
client. See [`phase-b.md`](./phase-b.md).

**Decisions touched:** D1, D3, D8, D10 all **closed**. D5 (reviewer capacity) is now more
load-bearing than before, because name-only input drives the queue.

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
