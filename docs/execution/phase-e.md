# Phase E — Query planning, discovery cascade and fetch

**Gate:** G6 · **Status:** brief — expanded 2026-09-14, in progress · **Prerequisite:** Phase D complete (it is; G5 passed 2026-09-14)

---

## Goal

Give the already-tested planning rules somewhere to send queries, and fetch what comes back
without ever turning a blocked source into a clean result.

This is the phase where the service stops being a correct machine operating on fixtures and
starts making outbound requests to publishers who did not ask to hear from it. Everything Phase
D built — the registry, the four-eyes approval, the rights gate, the breakers, the budgets, the
kill switch — exists so that this phase can be built without that being reckless. None of it has
ever been exercised against a real socket.

**No live source has been contacted by this project.** That is still true at the moment this
brief is written, and every step below says explicitly whether it changes that.

## Why the execution order is not the step numbering

The step identities `E1`–`E6` come from `docs/delivery-plan.md` and are **kept unchanged**, so
that the delivery plan and the traceability matrix keep meaning what they say. The order they
are _worked_ in is different, and deliberately so:

| Order | What is built                                                           | Outline step                     |
| :---- | :---------------------------------------------------------------------- | :------------------------------- |
| 1     | `HttpEvidenceFetchAdapter` — the real transport, HTTP only              | **E5**, HTTP half                |
| 2     | The fetch gate as a service, and one honest egress identity             | **E4** gate half, **E3** minimum |
| 3     | News and web discovery connectors, and the seven-rung cascade           | **E2**                           |
| 4     | Relevance filtering before fetch; rejected candidates stored as leads   | **E4**, filter half              |
| 5     | Plan generation finished and proved against the real taxonomy and graph | **E1**                           |
| 6     | Scheduled contract tests for every undocumented source                  | **E6**                           |
| 7     | The egress pool proper: identities, sticky rotation, `ProxyPort` mock   | **E3**                           |
| 8     | Playwright escalation, deterministic and cached per domain              | **E5**, render half              |

**The fetch transport comes first because every other live step is an outbound HTTP request.**
Google News RSS, Bing News RSS, GDELT and SearXNG are not a different kind of I/O from fetching
an article: each one must screen its URL, resolve and screen every address, respect a budget, a
timeout and a byte cap, carry an honest user agent, and check source health immediately before
opening the socket. Writing the discovery connectors first means writing a second HTTP path that
does some of that, and the weaker of two paths is the one that eventually gets used for
something it should not be.

**E1 is already most of the way done** and is worked late for that reason. `buildQueryPlan` runs
in the pipeline today against a real subject, a real graph and a real taxonomy version, and
`boundPlan` throws rather than dropping F1 or F4 (T78, tested). What is left is proving it now
that D6 gave the taxonomy 155 actual terms — before D6 the F3 and F5 families built empty
queries, so "the planner works" was a statement about a plan nobody could execute.

---

## Read before starting

Narrow list. **Do not read the two source documents end to end.**

| What                                                        | Why                                                                            |
| :---------------------------------------------------------- | :----------------------------------------------------------------------------- |
| `docs/execution/handoff-log.md`                             | The top two entries. The fetch plan and D5's point-of-use rule are both there  |
| `packages/domain/src/fetch/url-policy.ts`                   | Read it **fully**. `screenUrl`, `screenResolvedAddress`, `isForbiddenAddress`  |
| `packages/domain/src/fetch/robots.ts`                       | Read it **fully**. Note that `UNKNOWN` is not `ALLOWED`                        |
| `packages/domain/src/reliability/failure-classification.ts` | The FR-06 table. The only failure taxonomy that exists. Do not add a second    |
| `packages/domain/src/reliability/source-health.ts`          | `decideSourceAccess`, `spendAccess`, `observeFailure`. All pure                |
| `apps/api/src/sources/evidence-fetch.port.ts`               | The seam being implemented. Its header states three rules carried in the types |
| `apps/api/src/sources/mock/evidence-fetch.mock.ts`          | The refusals the real adapter must make identically — by sharing the code      |
| `apps/api/src/sources/companies-house.adapter.ts`           | The one existing real adapter. Follow its `get()` shape: facts in, signals out |
| `apps/api/src/sources/source-health.service.ts`             | `checkAccess` / `recordFailure` / `recordSuccess`, and the point-of-use rule   |
| `apps/api/src/pipeline/search-pipeline.service.ts`          | The fetch stage, and the fabricated authorisation that step 2 must replace     |
| `docs/open-decisions.md` **D6**                             | Raised with specifics at the start of this phase. The adapter honours it       |
| `docs/decisions.md` D-031, D-032                            | What source health is, and why access is rechecked at the point of use         |
| `docs/failure-injection-matrix.md`                          | Read the format before appending. This phase adds rows                         |

Spec sections, for exact wording only: **FR-05** (the cascade table and the volatility-control
paragraph), **FR-06** (all of it — it is two pages and it is this phase's specification),
**SEC-02**, §8 G6, and tests **T37, T38, T39, T46, T59, T84–T90** in §9.

---

## What already exists

Do not rebuild any of this.

| Already built                                                 | What it gives this phase                                             |
| :------------------------------------------------------------ | :------------------------------------------------------------------- |
| `screenUrl` / `screenResolvedAddress` / `isForbiddenAddress`  | The whole SEC-02 gate, pure, with 34 tests                           |
| `canonicalise`                                                | Deduplication, so one story is not two independent sources on axis D |
| `parseRobots` / `robotsVerdict` / `crawlDelayFor`             | robots.txt, de facto standard, with the failure case decided         |
| `classifyFailure` + the FR-06 policy table                    | Every retry, rotation and alert decision, as data                    |
| `SourceHealthService`                                         | Breaker, budgets, kill switch, licence clock, coverage outcomes      |
| `buildQueryPlan` / `boundPlan` / `assertPlanIsEntityAnchored` | The eight families and the declared drop order (T78)                 |
| `aggregateRun` / `renderNoMatchStatement`                     | T21, T47, T88 — a blocked source never renders as a clean result     |
| `resolveEffectiveScope`                                       | D6's proof that a disabled category is never queried                 |
| `seed-lexicon.ts`                                             | 155 terms, so F3 and F5 build real queries — **`es` unreviewed**     |
| `MockEvidenceFetchAdapter`                                    | The refusal behaviour the real adapter must match exactly            |

---

## Steps

### Step 1 (E5, HTTP half) — `HttpEvidenceFetchAdapter`

The real `EvidenceFetchPort`. **This is the step that makes a live outbound request possible for
the first time**, so it is also the step where every rule that has so far been a comment becomes
a socket that either opens or does not.

**Use `node:https` with a custom `lookup`, not `fetch`.** This is the load-bearing design choice
and it is not a preference. `screenResolvedAddress` exists to defeat DNS rebinding, and it only
does so if the address that was screened is the address the socket connects to. Screening with
`dns.lookup` and then calling `fetch(hostname)` resolves twice and leaves open exactly the window
the screening was written to close. `https.request` accepts a `lookup` option that the connection
itself calls, so screening **inside** that function means an unscreened address is not reachable
— not because somebody remembered to check, but because the only path to a socket goes through
the check. `servername` stays the hostname, so TLS verification is untouched.

The same choice makes both byte budgets real. Global `fetch` transparently decompresses, so the
wire size is not observable and `maxBytes` and `maxDecompressedBytes` collapse into one number.
With `node:https` the wire bytes are counted as they arrive and the decompressed bytes are
counted out of `node:zlib`, so a small response that inflates to a gigabyte is caught by the
second budget while the first is nowhere near its limit. That is T38.

Behind an `HttpTransport` seam, so that the adapter's logic — gates, robots, redirects, budgets,
health — is unit-testable without opening a socket, and the transport's address screening is
tested by calling its `lookup` directly.

**The order of operations, which is the specification and not an implementation detail:**

1. **Refuse an unauthorised or unattributable request** — identically to the mock, by sharing its
   code rather than by writing a second copy that drifts.
2. **`screenUrl`** on the URL about to be dialled. Applied to hop 0 and to every redirect hop
   through one code path, so there is no screened-redirect path beside an unscreened initial one.
3. **`checkAccess` immediately before the socket opens**, and again before each redirect hop and
   before fetching robots.txt. D5's kill switch is only effective mid-run because of this.
4. **robots.txt**, fetched and cached per host, unless the authorisation carries an approved
   exception with a named approver. `DISALLOWED` refuses. **`UNKNOWN` refuses.**
5. **The request**: honest user agent naming the service with a contact URL, conditional GET
   headers when an ETag or Last-Modified is stored, redirects followed manually.
6. **The budgets**: wire bytes, decompressed bytes, redirect count, total timeout.
7. **Feed health back**: `recordSuccess`, or `recordFailure` with the `FailureSignal` — never a
   class, because the FR-06 table classifies.

**Two judgements to get right, both written down as decisions:**

- **A gate refusal is never recorded as the source's failure.** A robots disallow and an SSRF
  refusal are facts about _one path_ and _one address_; the source answered nothing because we
  chose not to ask it. Handing either to `recordFailure` would classify it `HARD_BLOCK`, whose
  `domainAction` is `SUSPEND` — so one badly-linked article from a news feed would suspend the
  whole feed. The adapter records health only for failures **the server produced**.
- **Who spends the budget.** The budget counts requests put on the wire, so the component that
  opens the socket is the component that spends. `checkAccess` gains an optional `spend` flag;
  the pipeline's pre-fetch check becomes a non-spending rights-and-breaker check, and the adapter
  spends once per actual request — including the robots.txt request, which is a real request to
  the publisher and was not counted at all before.

**Not in this step:** Playwright, rendering, and any escalation. Those are step 8, after
extraction is real, because `CONTENT_BELOW_THRESHOLD` is a judgement about extracted text and the
extractor is still a keyword placeholder.

### Step 2 (E4 gate half, E3 minimum) — the fetch gate as a service

**There is a fabricated record in the pipeline today and it must not survive contact with a real
adapter.** `search-pipeline.service.ts` builds its `FetchAuthorisation` inline with
`urlPolicyPassed: true`, `ssrfValidated: true`, `jurisdictionEnabled: true`,
`sourceVersionId: 'fixture-source-v1'` and `relevanceScore: 0.9` — none of which were derived
from anything. Against the mock that is harmless. Against the real adapter it is a signed
statement that gates were passed which were never run, in the one record whose purpose is to be
audited.

So: a `FetchGateService` that **derives** each field — the active source version and its unexpired
licence terms, jurisdiction and language enablement from the pinned taxonomy and policy, the URL
policy screening, the robots position, and the relevance score from step 4. It is the only thing
permitted to construct a `FetchAuthorisation`.

The **egress minimum** belongs here too: one real egress identity carrying the honest user agent
and contact URL FR-06 requires, so that `egressIdentityId: 'mock-egress-1'` stops being written
into attribution records by a live process. The pool, the rotation and the `ProxyPort` are step 7.

### Step 3 (E2) — discovery connectors and the seven-rung cascade

Rungs 0 through 7 as FR-05 tabulates them, each logged, each descending on its own stated failure.
The connectors: Google News RSS, Bing News RSS, GDELT DOC 2.0 (JSON — no XML parser needed for
it), SearXNG against the instance already in the local stack, and the local index of polled feeds
at rung 0.

**The open dependency decision:** the two RSS rungs need an XML parser and the project has none.
Decide it explicitly rather than by `pnpm add` — a parser that resolves entities or follows
external DTDs is an XXE hole pointed at a third party's feed.

Reaching rung 7 with no candidates produces `NO_MATCHES_FOUND` with `INCOMPLETE` coverage, never a
clean result. An open breaker removes its rung for the cooldown and is reported as a gap (T89).

### Step 4 (E4, filter half) — relevance filtering before fetch

The nine signals FR-06 lists, scored before the fetch gate so that a candidate is refused before a
socket opens rather than after. A rejected candidate is **stored as a lead with its rejection
reason** and is visible in the coverage view. **Filtering never decides adversity** — it decides
whether a document is worth the request, and a reviewer must be able to see what was skipped.

### Step 5 (E1) — plan generation, finished and proved

Prove the eight families against the real taxonomy now that terms exist, per enabled category, per
enabled language, per jurisdiction, with `resolveEffectiveScope` deciding enablement. Prove F1 and
F4 survive truncation against a plan built from a real subject and a real graph rather than from a
fixture. Assert that a disabled category produces no query at all.

### Step 6 (E6) — scheduled contract tests

**Not optional polish.** A silent parse failure on Google News RSS reduces recall to zero, and the
system then reports clean results for everybody it is asked about. This is the detection mechanism
for the worst failure this product has. Keyed off `parserVersion`, alerting on a shape change, and
scheduled rather than run in CI — because the shape changes when the publisher changes it, not
when we commit (T84).

### Step 7 (E3) — the egress pool

Egress identities binding address, user agent, cookie jar, language headers and health state.
Sticky per (domain, job); rotate on rate limit, on cool-down, or after N requests to a domain —
**never per request**. `ProxyPort` with a mock adapter only. This is capacity management and
geographic correctness. It is **not** block evasion, and a rotation triggered by a 403 that then
rotates a second time is evasion whatever it is called (T85).

### Step 8 (E5, render half) — Playwright by exception

Only on one of the four deterministic triggers, logged with its reason, cached per domain, in an
isolated worker with request interception and no shared profile. **No default rendering** (T90).

---

## Definition of done

- [x] Step 1 — `HttpEvidenceFetchAdapter` implements `EvidenceFetchPort`; `node:https` with a screening `lookup` (D-034); both byte budgets, the redirect cap and the timeout enforced; every redirect hop re-screened; robots fetched, cached and honoured with `UNKNOWN` refusing; conditional GET on the first hop only; honest user agent with a contact URL, and the adapter refuses to be constructed without one; `checkAccess` before every external call and `recordSuccess` / `recordFailure` after; returns `FailureSignal` values, never classes. Gate refusals are never recorded against source health, and the pipeline's pre-fetch check no longer spends the budget (D-035)
- [x] Step 1 — the live adapter is wired into `buildSourceAdapters` and is **null unless it can be honest**: no contact URL or no source-health service means no adapter. `FETCH_CONTACT_URL` added to configuration with no default
- [ ] Step 1 remainder — **a live request has still never been made.** The real transport is constructed only by the live composition root; every test runs against an injected one. The first deliberate live request is its own decision (see Decisions below)
- [x] Step 2 — `FetchGateService` derives every `FetchAuthorisation` field from the active approved source version, its unexpired licence terms, the run's pinned scope and taxonomy, `screenUrl` on the URL itself, and the registry's recorded robots position (**D-036**); the pipeline no longer fabricates one, and a scan test keeps the gate the only issuer. A refusal is a rejected lead with a reason, and a source-level refusal is also a `SKIPPED` coverage outcome. One honest egress identity exists (`egress-primary`, user agent built from `FETCH_CONTACT_URL`), `mock-egress-1` is gone, and a live process with no contact URL refuses every fetch rather than making an anonymous one
- [x] Step 2 — an `EXCEPTION_APPROVED` source is **refused** while **D6** is open, and a `FIXTURE_MOCK` source is authorised as `FIXTURE_NOT_A_PUBLISHER` in mock mode and refused in live mode; the live transport refuses a fixture authorisation outright (T55)
- [x] Step 2 — `SourceOutcome.FAILED` carries a required human `detail` (**D-038**), so a robots refusal reads as what it was rather than as "could not be retrieved (HARD_BLOCK)"
- [x] Step 2 — the relevance score is derived and labelled `PRELIMINARY_NAME_PRESENCE_v1`, and **does not gate** (**D-037**); the FR-06 signal set and its threshold are step 4
- [ ] Step 2 remainder — the per-lead relevance **threshold**, the nine FR-06 signals, and the egress **pool** (identities, sticky rotation, `ProxyPort`) are steps 4 and 7, unchanged
- [~] Step 3 — **the XML parser dependency is decided, built and tested** (`fast-xml-parser@4.5.7`
  pinned, behind a DOCTYPE gate this project owns, **D-039**); the **per-domain breaker** is built
  and wired (**D-040**); the **D17 stop conditions** are recorded on the source version, applied by
  `SourceHealthService.recordFailure`, and proved by the trip-wire harness (**D-041**). **The rungs
  and the connectors themselves are not built** — that is where step 3 resumes
- [ ] Step 4 — relevance scored on FR-06's signals before the gate; rejected candidates stored as leads with reasons and visible in coverage
- [ ] Step 5 — the eight families generated from the real taxonomy, graph and subject; F1 and F4 provably survive truncation; a disabled category provably produces no query
- [ ] Step 6 — a scheduled contract test per undocumented source, keyed off `parserVersion`
- [ ] Step 7 — egress identities with sticky rotation; `ProxyPort` with a mock adapter only
- [ ] Step 8 — Playwright escalation on a deterministic logged trigger, cached per domain
- [~] **T37** — the URL half and the redirect half are asserted, and the IPv4-mapped IPv6 bypass found while writing them is closed (`url-policy.ts`). The rebinding half is structural — the screening lives inside the connection's own `lookup` (D-034) — and is asserted on the lookup rather than through a socket. **Not yet proved against a live resolver**, which is G10
- [ ] **T38** — huge, compressed or malformed bodies, endless redirects and slow responses each produce a bounded rejection and a recovered worker
- [ ] **T39** — injection through a search query or filter is validated and bounded
- [ ] **T46** — 429, timeout, invalid credential and malformed payload each classified correctly, with visible coverage
- [ ] **T59** — query, company, page, byte and time limits recorded as truncation with valid evidence retained
- [ ] **T84** — a shape change on an undocumented source alerts before recall degrades
- [ ] **T85** — 429 then 403 across two identities cools down, retries once, then degrades the domain and descends
- [~] **T86** — the exception half is done and tested at the gate: an `EXCEPTION_APPROVED` source is refused while D6 is open, and no authorisation can carry an unnamed exception. The robots-disallow half is asserted against the adapter (step 1); the end-to-end "recorded as a lead with a coverage gap" path needs a discovery connector pointed at a disallowing host, which is step 3
- [~] **T87** — a recognised challenge or interstitial is abandoned after one attempt and reported as a `SOFT_BLOCK`; no solve, no bypass, no retry from another identity. Asserted against the adapter; the paywall and login-wall halves need the extraction step that recognises them
- [x] **T88** — a blocked source renders as a coverage gap, never a clean result (`result-state.test.ts`, done in G0)
- [ ] **T89** — a breaker opening mid-run removes the rung for its cooldown and reports a gap
- [ ] **T90** — Playwright escalation is deterministic, logged and cached per domain; no default rendering
- [x] **D17 closed 2026-09-15** — SEC litigation-releases RSS, approved by name (Faisal Ali, source
      admin), one conditional GET per 15 minutes against a recorded 10 req/s ceiling, four stop
      conditions proved to fire. **No live request has been made**: the source version is written and
      schema-checked but not yet proposed, approved or activated
- [x] Step 3 — the trip-wire harness passes: 403 halts and needs fresh approval, 429 halts after the
      cooldown it asked for, a 5xx streak halts, an oversize body is a bounded rejection that halts
      nothing, a DOCTYPE is refused before parsing, the daily cap holds, and the kill switch stops a
      run in flight. **Not against a self-hosted target** — SEC-02 makes one unreachable by design;
      see the harness header
- [x] Startup refuses to boot without an honest outbound user agent (`assertOutboundUserAgent`)
- [ ] **D6 closed** — how robots exceptions are approved and recorded (raised 2026-09-14; the adapter honours whatever it decides)
- [ ] **D15 closed** — the Costa Rican primary-source evidence base; the cascade's rung tiers encode the answer
- [x] `pnpm openapi:generate` re-run and committed (the source schema gained `accessPolicy`)
- [~] `docs/failure-injection-matrix.md` extended for the fetch boundaries — FI-19, FI-20, FI-21 added
- [ ] `docs/implementation-status.md` moves G6; `START-HERE.md` pointer moved; handoff written

## Do not

- **Do not bypass a CAPTCHA, bot challenge, paywall, login wall or access control, by any path.**
  Not with a rendered browser, not with a different identity, not with a delay, not with a
  third-party service. A challenge is abandoned and recorded as a coverage gap (T87).
- **Do not read robots `UNKNOWN` as permission.** An outage at the publisher is not consent.
- **Do not apply a robots exception without a named approver** in the registry. D6 is open, and
  while it is open no exception can be applied at all.
- **Do not rotate egress identity to get around a block.** Rotation is capacity and geography.
- **Do not cache the DNS resolution** across requests, and do not screen an address that is not
  the address the socket will use.
- **Do not add a second failure taxonomy.** `classifyFailure` decides; adapters report facts.
- **Do not let a gate refusal open the source breaker.** A refusal is our decision not to ask.
- **Do not fabricate a `FetchAuthorisation` field.** If it was not derived, it is not true, and
  this is the record that exists to be audited.
- **Do not make a live call to verify a source's contract.** G10 owns live verification. When a
  live request is first made deliberately, it is a decision that gets written down, not a side
  effect of a test somebody ran.
- **Do not let a blocked, exhausted or breaker-open source produce a clean result.** This is the
  one failure the whole phase is built to prevent.

## Decisions

**Due at G6: D6** (how robots exceptions for official sources are approved and recorded) and
**D15** (the Costa Rican primary-source evidence base). D6 was raised with specifics on
2026-09-14, at the start of the phase rather than when the adapter was half-written, and the
provisional behaviour is recorded in `docs/open-decisions.md`: no exception can be applied today,
and a source needing one is blocked and says so.

**Opened in step 2: D17 — the first deliberate live request.** Which source is contacted first,
under whose named approval, at what rate, and on what stop condition. Written up in
`docs/open-decisions.md` with a recommendation (a single manual robots.txt request, approved by
name, stopped there). **It must close before any live call**, and it gates the desk research both
D6 and D15 need, because reading a publisher's robots.txt is itself an outbound request to them.
**D15 was re-raised on 2026-09-14**: untouched since it was raised, and step 3's rung tiers encode
its answer.

**Opened and closed in step 3:** the XML parser dependency (**D-039**), the per-domain breaker
(**D-040**) and the stop conditions that closed **D17** (**D-041**). **Newly open: D18** — whether to
adopt `fast-xml-parser` v5 once its six 2026-created runtime dependencies have been looked at. Nothing
needs v5, and 4.5.7 is pinned exactly.

## Known risks

| Risk                                                                                  | Mitigation                                                                                                                                 |
| :------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------- |
| The rebinding window is left open because screening and connecting resolve separately | The screening runs inside the `lookup` the connection itself calls. There is no other path to a socket                                     |
| A compressed bomb passes because only one byte budget is real                         | Wire bytes and decompressed bytes are counted separately, by construction, because the transport sees both                                 |
| A robots disallow on one article suspends the whole discovery source                  | Gate refusals are never fed to `recordFailure`. Tested explicitly, because the failure mode is invisible until a source quietly disappears |
| The first live request happens by accident, in a test                                 | Tests run against an injected transport. The real transport is constructed only by the live composition root                               |
| Google News RSS changes shape and recall silently drops to zero                       | E6, keyed off `parserVersion`, scheduled rather than in CI. This is the detection mechanism, not a nice-to-have                            |
| The budget is double-spent, or not spent at all, once two components both check       | One rule, written down: whoever opens the socket spends. The pipeline checks without spending; the adapter spends once per request         |
| `SourceOutcome.FAILED` carries a class but no human detail, so coverage reads thin    | **Closed in step 2 (D-038).** `detail` is a required field and a required argument, so a failure with no explanation does not compile      |

## Expanding this brief further

Three things are deliberately left to the step that does them:

- the exact relevance scoring weights (step 4), which should be set against the FR-16 labelled
  corpus rather than chosen in advance;
- ~~the per-domain breaker's relationship to the per-source one~~ — **settled in step 3 (D-040)**:
  two documents, two questions, both must allow a request, and rights outrank a publisher cooldown
  in what a refusal reports;
- ~~which source receives the first deliberate live request, and under what approval~~ — **settled
  by D17, closed 2026-09-15**.
