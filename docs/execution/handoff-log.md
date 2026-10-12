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

## 2026-10-12 — test UI built; adverse-search delivery plan for Target Platform

**Asked:** Build a simple standalone test UI so the Target Platform test team can search any name
independently before the full Target Platform integration goes live. Deliver adverse-search (news
sources only) today. Google News RSS to be activated. SearXNG (Bing, DuckDuckGo, Reuters,
Brave, Wikinews) to be activated.

**Did:**

- Written `apps/test-ui/index.html` — a zero-dependency standalone HTML page. Opens in any
  browser directly (no server needed). The test team enters the API server URL and API key,
  types a name, picks purpose and environment, submits to `POST /v1/screen`. Results render
  as band-colour-coded finding cards (title, source, stage, authority tier, rationale, link).
  Coverage banner, counts bar, and collapsible lead/source-outcome sections included.
  localStorage saves the last server URL, API key, and environment setting across reloads.

**Left half-done / next steps (in order):**

1. **Activate `searxng-adverse-media`** — the source is built (`apps/api/src/sources/registry/
   searxng-adverse-media.ts`) but not active. All five SearXNG engines (Bing, DuckDuckGo,
   Reuters, Brave, Wikinews) have `governanceStatus: 'PERMITTED'` and `defaultEnabledForDiscovery:
   true` in `engine-governance.ts`. Activation needs the four-eyes lifecycle (propose → submit →
   approve → activate). User runs it; session should not fire first contact.

2. **Google News RSS** — `google-news-rss-en-us` template exists in `discovery-rungs.ts` but
   `firstContactApproval: null` and `robotsPosition: 'NOT_ESTABLISHED'`. Activation requires:
   (a) new decision record accepting ToS risk (commercial automated use), (b) fix redirect
   resolution in the RSS connector so `/rss/articles/CBMi<token>` links are followed to the
   real publisher URL, (c) four-eyes activation lifecycle. Do NOT edit `firstContactApproval`
   or `robotsPosition` directly — that bypasses the lifecycle.

3. **Expose service** — backend only runs locally. For today's delivery to Target Platform test team,
   use Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`) or ngrok. Give the
   resulting URL to the test team as their server URL in the test UI.

4. **Provision Target Platform tenant** — create a tenant + API key (sandbox for testing, then live).
   Hand the key to the test team to paste into the test UI API Key field.

5. **Target Platform integration** — once test team validates, integrate `POST /v1/screen` into the
   Target Platform onboarding flow with `purpose: 'CUSTOMER_ONBOARDING'` and `environment: 'live'`.

**Not run this session:** no live requests made. User triggers first contact per memory rule.

**Found:** No new defects. The test UI is a file-protocol page; if the browser blocks `fetch`
to `http://` from `file://` (common in Chrome for mixed-content), the test team should either
open it via a local `http-server` or configure the CORS header on the API to allow `null`
origin. Noted in the error message in the page itself.

**Decisions touched:** none. D20 (Google REFUSED) unchanged. SearXNG activation pending (no
decision record number assigned yet).

---

## 2026-09-23 (thirtieth) — one endpoint for everything: `POST /v1/screen`, all sources or each source

**Asked:** "everything running from one endpoint; stop everything; update the document with
one-point testing and each-source testing."

**Did:**

- `POST /v1/screen` is now the single endpoint. It already ran every source in one call; it now
  also honours `X-Local-Discovery-Diagnostic` (Google, local only), through a helper shared with
  `POST /v1/searches` — `apps/api/src/searches/local-diagnostic-request.ts`. The searches
  controller lost its copy.
- New optional **`sources`** (screen body) / **`requestedScope.sources`** (searches): restrict a run
  to named source ids. Contract in `packages/contracts/src/searches/{search,screen}.ts`; OpenAPI
  regenerated. Plumbed run → `search-job.handler.ts` → `SearchPipeline.execute({ sourceFilter })`
  → ladder filter in `discover()` and `onlySourceIds` in `IndexedSourceSearchService.search`.
- Every source left out is reported `SKIPPED` with the filter named (`sources/source-filter.ts`),
  so a single-source run is `INCOMPLETE` by construction. **Unknown ids → 400 at the door**, listing
  the searchable ids (`SearchesService.assertKnownSources`, fed by `LadderBuilder.sourceIds()` +
  `IndexedSourceSearchService.sourceIds()` in `app.module.ts`). Recorded as **D-066**.
- Postman **Folder 20 — One Endpoint** (5 requests): 20.0 lists searchable sources, 20.1 all sources
  in one call, 20.2 each source (loops itself), 20.3 one named source, 20.4 all + Google (skipped
  unless `zquenceApiKey` is set). Armed by `screenConfirm = yes-run-one-endpoint`. Variables added
  to `local.postman_environment.json` (and the git-ignored `.ready` one). Collection diff purely
  additive.
- `docs/testing/live-test-sequence.md` rewritten around the one endpoint: start, one-endpoint
  testing, a per-source table with what a pass looks like, the older folders as optional, stop.

**Verified:** typecheck clean, lint clean; unit+invariants+evaluation **1255 passed (76 files)**;
integration **240/240**; security **190/190** (9 files); e2e-api **34/34**. New tests: 2 unit in
`indexed-source-search.test.ts`, 2 integration in `pipeline.test.ts`, 4 HTTP in
`tests/security/local-google-diagnostic.test.ts` (`/v1/screen` block), 7 in
`apps/api/test/postman-folder-20.test.ts`. Folder 20 run with newman against a **mock-mode API only,
no worker**, `screenEnvironment=sandbox`: **15 requests, 82 assertions, 1 failure**. The failure is
correct: `world-bank-debarred` has no snapshot (known blocker), so its single-source test is red.

**Not run:** Folder 20 in LIVE mode, and 20.4 (Google). Nothing live was contacted this session.
The user runs it per the doc.

**Found:**

1. The first version reported an unknown source id as `SKIPPED` in the run. The integration test
   showed that run returning `NO_MATCHES_FOUND`, because the association-graph outcome counts as
   "something answered". Fixed by refusing at the door (D-066). **This is still possible at
   run time** if a named source is retired between acceptance and execution. It is narrow and
   reported, but not closed.
2. `tests/integration/search-index.test.ts` (Meilisearch "not indexed until searchable") failed once
   in the full suite and passed 17/17 twice alone and 240/240 on the re-run. Timing.
3. In the mock run, `ofac-sdn` reported `PARTIAL` — "Latest refresh status: FAILED; HARD_BLOCK:
   circuit breaker half-open". It searched the last good snapshot, which is correct behaviour, but
   the refresh breaker on the local DB is half-open. Not investigated.
4. Folder 19's test asserted it was the **last** folder; changed to "directly after 18".

**Stopped:** no `dev.mjs`/`main.js`/`worker-main.js` node process; `pnpm local:down` run — no
`adverse-search-service-*` container. Volumes kept. `postgresDB` (not this project) left running.

**Next session should:** if the user reports a Folder 20 LIVE result, start from the per-source
table in `docs/testing/live-test-sequence.md` Part 3. Otherwise nothing is queued.

**Decisions touched:** D-066 added. D20 unchanged (Google still REFUSED, default off).

## 2026-09-23 (twenty-ninth) — Target Platform tenant Google acceptance flow (local diagnostic only)

**Did:** a request-scoped, local-only override that lets the real local Target Platform LIVE tenant run
one normal adverse search with `GOOGLE_NEWS` added, plus Postman Folder 19 to run it.

- `apps/api/src/sources/searxng/local-diagnostic.ts` — the five conditions (not production;
  loopback Host **and** socket; `ALLOW_LOCAL_GOOGLE_DIAGNOSTIC=true`; tenant ==
  `GOOGLE_DIAGNOSTIC_TENANT_ID`; header `X-Local-Discovery-Diagnostic: GOOGLE_NEWS`) and an
  in-memory widening that can only ever touch `GOOGLE_NEWS`.
- `config.ts` — the two variables; **production refuses to start** with the flag set.
- `searches.controller.ts` — decides before anything is written. Header present + any condition
  failing → `403 FORBIDDEN` (no reason in the body). Granted + non-live → `400`.
- The run record carries `localDiscoveryDiagnostic: { engines: ['GOOGLE_NEWS'] }`; the job handler
  and pipeline pass it to `DiscoveryRunContext.diagnosticEngines`; the SearXNG adapter **re-checks
  the process conditions** before honouring it. A stale worker or one without the flag runs the
  search without Google.
- Engine diagnostics: the Google row gains `diagnosticOverride`, `diagnosticOnly`,
  `effectiveEnabled` (all `true`), only on a diagnostic run; `governanceStatus` stays `REFUSED`.
  Contract fields optional; OpenAPI regenerated.
- **Not changed:** D20, `governanceStatus`, `defaultEnabledForDiscovery`, `tenantEnabled`,
  `searxngEngineSettings`, FetchGate, any source.
- Postman Folder `19 - Target Platform LIVE Google Diagnostic` (12 requests, 19.0–19.10), folder-level
  guard, template env vars. Collection-level `apiKey` check exempts `19.*` requests only.
- `docs/testing/google-live-local.md` — how to start the stack and run it.

**Verified** (no `dev:live` stack running): `pnpm typecheck` 0, `pnpm lint` 0; unit **1203/1203**
(73 files), invariants **31/31**, evaluation **12/12**, integration **238/238**, security
**186/186**, e2e-api **34/34**. New tests:
`apps/api/test/local-google-diagnostic.test.ts` (14), `apps/api/test/postman-folder-19.test.ts`
(23, executes the folder's scripts in a `pm` sandbox), `tests/security/local-google-diagnostic.test.ts`
(5, real HTTP + Mongo).

**Not run:** the live Google request. No Target Platform credentials exist in this session, and the user
drives it: start the stack per the doc, enter `zquenceApiKey` + `zquenceTenantId`, run Folder 19.

**Found:** there is no worker health endpoint, so Folder 19 proves worker currency indirectly —
19.5 (a worker consumed the job) and 19.7 (`diagnosticOverride` can only be set by a current
worker with the env). Not added, per "do not redesign".

**Also in this commit:** the twenty-eighth session's Wikinews work was still uncommitted in the
working tree, and the user asked for one commit — so it is included here.

**Next session should:** nothing is queued from this commit. If the user reports a Folder 19
failure, start from its "If it fails" table.

**Decisions touched:** none. D20 unchanged.

## 2026-09-23 (twenty-eighth) — the chain is proven: SearXNG → Wikinews → fetch → finding

**The one-line state.** D22 was approved and carried out, `wikinews-en` is **ACTIVE** through a
genuine four-eyes lifecycle, and **one real article was fetched and became one real finding**.
Folder 18: **50 requests, 47 assertions, 0 failures, 18.7s**. Getting there uncovered **two real
defects that had nothing to do with governance** and were each presenting as a governance refusal.

### 1. The two defects, because they are the important part

**Defect A — `loadActiveByDomain` matched nothing, ever.** The publisher-authorisation lookup
queried a **top-level** `canonicalDomains`, but version documents carry
`content.canonicalDomains` — which is where the in-memory matching loop immediately below the
query correctly reads it from. The query returned zero documents and the function returned null
before the good loop ever ran.

So **every** discovered candidate was refused `PUBLISHER_NOT_APPROVED`, including ones with a
perfectly good ACTIVE record. `wikinews-en` was taken all the way to ACTIVE and the Madoff article
was *still* refused with "No approved source record covers en.wikinews.org" — the one sentence
guaranteed to send the reader off to audit the registry rather than the query. The twenty-fifth
session's "46 per-candidate refusals" and the twenty-seventh's "0 findings" were both this bug
wearing a governance costume.

Fixed to match `content.canonicalDomains` **and** the legacy top-level shape, because
`mapActiveVersion` already tolerates both (`document['content'] ?? document`) — narrowing the
query to one while the mapper accepts two is how they drifted apart.

**Why no test caught it: nine unit-test files stub `loadActiveByDomain`, and all nine passed.**
They have to — they test the gate's behaviour *given* an answer, not how the answer is fetched.
Another unit test would not have caught it either. The defect lived in the shape of a real
document, so `tests/integration/publisher-domain-lookup.test.ts` (8 tests) uses real documents in
a real collection. Verified by reverting the fix: **3 of the 8 fail.** It also pins the refusals —
look-alike suffixes, non-ACTIVE versions, bare TLDs — so widening the field path did not widen the
status filter with it.

**Defect B — every MediaWiki page on earth read as a bot challenge.** With A fixed, the fetch was
attempted and came back `SOFT_BLOCK: matched "captcha"`. It was a **200, 85KB, fully-served
article**. `detectChallenge` scanned the first 4KB for bare substrings, and MediaWiki embeds a
config blob in `<head>`: `wgConfirmEditCaptchaNeededForGenericEdit`, `wgConfirmEditHCaptchaSiteKey`
— a statement about what *editing* would require, inside a `<script>`.

Fixed by stripping `<script>` blocks before scanning. **This is not a loosening.** A real
interstitial exists to be read by a person, so its text is in the title and the visible body and
survives script-stripping; what does not survive is a publisher's JavaScript mentioning a captcha
it would use somewhere else. The conservative bias is untouched. An unterminated `<script>` at the
window edge is dropped whole, so a marker cannot hide in a tail the window cut in half. Three
tests added to `http-evidence-fetch.test.ts`, including the real Wikinews `<head>` and a
real-shaped Cloudflare interstitial that must still be caught.

### 2. D22 — approved, and carried out narrowly

Three serial GETs to two hosts: `en.wikinews.org/robots.txt` (200, 4427B, `/wiki/`: **ALLOWED**),
`foundation.wikimedia.org/robots.txt` (200, 3880B, **ALLOWED**), Terms of Use (200, 37610B).

**The verdict was checked against the exact article path and it discriminates:** the Madoff
article and `/wiki/` are ALLOWED; `/w/index.php`, `/wiki/Special:Random`,
`/wiki/Wikinews:Story_preparation/` and `/api/rest_v1/…` are DISALLOWED. No `Crawl-delay` for any
agent. Full robots body in `docs/sources/evidence/wikinews-en.json`.

`wikinews-en` v1 ACTIVE via propose → submit → approve → activate, **two distinct principals**:
SUBMIT `api-key:4f93491691d8c22e`, APPROVE `api-key:b49936006e34f1ae`. The activated version
carries `firstContactApproval.decision: "D22"` — **not D19** — and
`permittedCollectionMethods: ["HTML_FETCH"]`, both of which are the twenty-seventh session's fixes
proving out on a real record.

**The narrowness is visible in the numbers.** 63 unique candidates discovered, **1** fetched, 47
leads refused `PUBLISHER_NOT_APPROVED` by publisher — `www.reuters.com` (20), `finance.yahoo.com`,
`www.bloomberg.com`, `time.com` and the rest. That is the intended outcome, not a coverage gap.

### 3. The real finding — the whole chain, in one row

`searchId 75693931-f796-4853-87d4-0a2900e569d2`, `findingId 4d945910-…` (chain run).

```
SearXNG            discoverySource  searxng-adverse-media
  -> Wikinews      discoveryEngines ["WIKINEWS"]        engine RETURNED_RESULTS, 9 results, 4 unique
  -> authorisation wikinews-en v1 ACTIVE, D22, robots HONOURED, tier 4
  -> fetch         articlesFetched 1, mode LIVE, retrievalDate 2026-09-23
                   https://en.wikinews.org/wiki/Madoff_jailed_after_pleading_guilty_to_%2450_billion_fraud_scheme
  -> extraction    subjectMentionSpans [1561-1575, 5016-5030], conductSpan [1690-1706]
                   extractorVersion rule-based-1-unbenchmarked
  -> FR-08         EXACT_COMMON_NAME / WEAK — "Bernard Madoff" matched as written
  -> classification category MONEY_LAUNDERING_TF, attribution DIRECT_PERSONAL
  -> FR-10         cluster-1: 2 documents, independent corroboration 0, 2 excluded as copies
  -> finding       band AMBIGUOUS
```

**AMBIGUOUS is the correct band and it is worth saying why**, because a weaker system would have
said CONFIRMED. The name matched exactly, but the document states no date of birth, identifier,
company or country the subject record also states — so identity rests on a name alone and Axis A
is WEAK. Party role is UNSPECIFIED, which caps at AMBIGUOUS under FR-09. And FR-10 counted **0**
independent corroboration, excluding both documents in the cluster as copies or non-independent
tiers. The system declined to overclaim on its own first end-to-end finding.

### 4. One Postman assertion was wrong and was corrected, not deleted

18.16 `a metasearch document is lead-only authority` asserted `authorityTier === 5` exactly. It
passed for three sessions only because **nothing was ever fetched**: every metasearch document was
a tier-5 snippet from the discovery layer itself. Now that a candidate can be fetched from an
approved publisher, the document carries **that publisher's** tier from its own registry record
(Wikinews is 4), with the channel recorded separately in `discoverySource`. Pinning it to 5 would
force the publisher's tier to be overwritten by the finder's — the opposite of what FR-09
provenance is for.

It now asserts the property the name actually claims: `authorityTier >= 4` (discovery never buys
authority — never regulator- or wire-grade) and `namingAuthority === null`. The collection was
edited at `indent=2`; `git diff --stat` shows ~12 added lines, no reflow.

### 5. Verified — every number, with the stack stopped for the suites

```
typecheck   clean                     lint        clean (0 errors)
unit        71 files, 1166 tests      invariants  31          evaluation  12
security    8 files, 181              integration 15 files, 238
e2e-api     3 files, 34

Folder 18 (newman, final)   50 requests, 47 assertions, 0 failures, 18.7s, 243.34kB
                            avg 24ms, min 7ms, max 218ms
```

Per-engine on the final run — 104 raw, 63 unique, 41 collapsed:

| engine | outcome | results | unique | governance |
| :-- | :-- | --: | --: | :-- |
| BING_NEWS | INTERNAL_ERROR | 13 | 1 | PERMITTED |
| BRAVE_NEWS | TIMEOUT | 0 | 0 | PERMITTED |
| DUCKDUCKGO_NEWS | RETURNED_RESULTS | 33 | 20 | PERMITTED |
| GOOGLE_NEWS | **DISABLED_BY_POLICY** | 0 | 0 | **REFUSED** |
| REUTERS | RETURNED_RESULTS | 49 | 27 | PERMITTED |
| WIKINEWS | RETURNED_RESULTS | 9 | 4 | PERMITTED |

**The twenty-seventh session's Google change is confirmed in production**, from the live control
API: `GOOGLE_NEWS default false, tenant false, effective false, REFUSED` — while the other five
read `default true, tenant true, effective true`. Zero Google requests.

**The dev:live stack was stopped before the suites**, as instructed. That confirms the previous
entry's diagnosis outright: with it running, integration and e2e failed on outbox assertions with
a different set of tests each run; with it stopped, **238/238 and 34/34, first time, no re-runs**.

### 6. Found — things a future session needs

1. **A running `dev:live` stack serves a stale build.** It ran from 18:50 on 2026-09-22 and did
   not carry the Google default change made at ~20:00. `GOOGLE_NEWS` reported `tenantEnabled=true`
   and it took a rebuild plus restart to see the truth. **Before believing any live diagnostic,
   check the stack's start time against your last build.**
2. **`dev.mjs` listens on 3000 unless `PORT` is exported.** Earlier entries say 28081; that came
   from the operator's environment, not from the repo.
3. **The signup limiter is 5/hour per hashed address and diagnostic probes spend it.** Folder 18
   signs up a real tenant, so a burst of probing blocks the acceptance run with a 429. The
   limiter is working correctly; I deleted my own probe rows from `attemptLog` on the local dev
   database to restore the pre-probe state. **No code, policy or window was changed.**
4. **Two stale-health artefacts had to be cleared, both created by defect B**: a `domainHealth`
   cooldown for `wikinews.org` and an OPEN `sourceHealth` breaker on `searxng-adverse-media` from
   2 HARD_BLOCKs. They recorded blocks that never happened. Deleted on the local database only.
5. **Folder 18's `sxEmail` must not contain `+`.** 18.3 interpolates it into a query string
   unencoded, so `+` decodes as a space, the lookup misses, and the *latest* verification token
   for some other address is returned — which then verifies a different tenant and leaves yours
   unverified, surfacing three steps later as a 403 on live-key issuance. Cost about twenty
   minutes. Worth encoding in the collection; not done, because the collection is shared with
   sixteen other folders and that is a change to make deliberately.
6. `sec-press-releases` reported `HOURLY_BUDGET_EXHAUSTED` (6/hour) during the middle runs. The
   budget working, not a fault.
7. The security suite failed **once** on `login.test.ts` I3 and **once** on `api-keys.test.ts`
   T68 — a different test each time, both passing in isolation, and **181/181 on two consecutive
   clean runs**. Same shared-Mongo parallel-suite class as the outbox contention.

**Next session should:** nothing is blocked. The acceptance milestone is closed. If more
adverse-media coverage is wanted, the next act is a **second publisher approval** under its own
decision — `scripts/lib/first-contact-approvals.mjs` throws for a source no decision names, so
that is a deliberate act and cannot be done by accident. `www.reuters.com` is the highest-value
candidate on the evidence: 49 results, 27 unique, 20 refused leads in one run.

**Decisions touched:** **D22 CLOSED — approved and carried out**, scoped to `en.wikinews.org`
alone. **D20 unchanged**, Google still REFUSED and now also default-OFF, zero requests.
**D21 as amended** by the twenty-seventh entry, confirmed live. **D-042 vindicated rather than
weakened**: the one approval authorised one publisher and refused 47 leads from everybody else.

## 2026-09-22 (twenty-seventh) — Google's default switched OFF; Wikinews built up to the request and stopped

**The one-line state.** Google is now blocked by **two independent gates** instead of one, with a
regression test that holds the second against a *simulated* future permission. The Wikinews
publisher approval is built end to end — evidence script, onboarding wiring, decision record — and
**deliberately not run**: no request has been made to `en.wikinews.org`, so the rung-5 chain is
still unproven past discovery, and folder 18 was **not** re-run.

### 1. The Google safety change, and what it is not

`GOOGLE_NEWS.defaultEnabledForDiscovery` is **`false`**. It is the only `false` in the matrix.

**Why the old `true` was a latent problem rather than a present one.** While Google is `REFUSED`,
`effectiveEnabled` is false whatever the switch says, so the default's value is *unobservable* —
and it becomes load-bearing on the single day somebody edits the reading, which is the worst
possible moment to find out it was wrong. With the default at `true`, one edit to
`governanceStatus` — one field, in one review framed as a governance decision — would have taken
Google from "queried by nobody" to "queried on every search of every tenant who never configured
an engine", in one release, with no tenant having asked. A governance decision and a fleet-wide
activation are two different acts and must not be spendable with one keystroke.

**It is a blast-radius control, not a second refusal.** A reader who mistakes it for one will
conclude the refusal is redundant and delete a gate. D20 is untouched, not reopened, not weakened.

**The D20-A diagnostic moved nothing.** Google returning HTTP 200 with original-publisher URLs is
evidence about Google's *infrastructure*, never about Google's *terms*. It did retire one of D20's
two objections for this route — the FR-09 provenance objection was about the RSS feed's
`news.google.com/rss/articles` redirects and does **not** carry over to the SearXNG scrape — so the
licence objection is now the whole of the refusal. That is recorded in the evidence note so the
next reader does not cite a retired objection or infer permission from a status code.

**Confirmed state:** `integrated=true`, `defaultEnabledForDiscovery=false`,
`governanceStatus=REFUSED`, `effectiveEnabled=false`, zero Google production queries. Google is
still *reported* in full — `DISABLED_BY_POLICY`, never absent — because the adapter derives that
outcome from `!effectiveEnabled`, so the diagnostic rows are unchanged.

### 2. The regression test, and proof that it bites

`apps/api/test/searxng-google-default-off.test.ts` — 7 tests. The load-bearing ones resolve
against a matrix where Google's reading has been moved to `PERMITTED` **and nothing else has**,
using `vi.doMock` plus a dynamic import so the *real* `EngineEnablementService.resolveFor` runs.
The rule is not re-implemented in the test; a test that recomputed
`integrated && tenantEnabled && status !== 'REFUSED'` itself would keep passing if that expression
were deleted from the service.

It asserts that after the simulated edit an unconfigured tenant still has
`tenantEnabled: false, effectiveEnabled: false`; that the other five engines are untouched (a fix
that also silenced the working engines would be a regression dressed as caution); and that
activation then requires a named tenant's API call with a reason, reaching that tenant only.

**Verified by planting the violation:** restoring `defaultEnabledForDiscovery: true` fails **5 of
the 7**. Restored afterwards.

### 3. Wikinews — everything except the request

**`pnpm wikinews:first-contact`** (`scripts/wikinews-first-contact.mjs`). Three serial GETs to two
hosts, >=4s apart: `en.wikinews.org/robots.txt` evaluated for `/wiki/`;
`foundation.wikimedia.org/robots.txt` evaluated for the terms path, because **a second host's
rules are its own and are never inherited**; then the Terms of Use page, so `licenceTermsVersion`
names something somebody actually loaded. Each step is skipped when the step authorising it did
not permit it. Writes `docs/sources/evidence/wikinews-en.json` and stops.

**It deliberately does not fetch an article.** The thing to prove is *SearXNG -> publisher
authorisation -> FetchGate -> fetch -> extraction -> finding*, and an article pulled down by this
script would be a fetch that went **round** the gate rather than through it.

Why it is its own script rather than `--source` on `indexed-first-contact.mjs`: that script's
fourth step is "load the configured endpoint", and Wikinews has none by design (`endpointUrl:
null`, D-043 — it is never polled). Passing it through would either crash on the null or invite
somebody to invent an endpoint so the script would run.

**Verified unarmed: prints the plan, sends nothing.**

### 4. The onboarding wiring, and the false-signature defect it closes

`wikinews-en` now goes through `source-onboard.mjs`. Four changes, and the third is the one that
matters:

1. Registered from the compiled registry, beside `searxng-adverse-media` rather than covered by it.
2. `EVIDENCE_FETCH_HTTP` -> collection method **`HTML_FETCH`**. It was falling through to the
   `BULK_DOWNLOAD` default, which would have put a **false declaration on an approved version**:
   the rights policy would clear a method this source never performs and not clear the one it does.
3. **First-contact approvals are now per source, with no fallback.** `contentFor` wrote
   `FIRST_CONTACT_APPROVAL` — D19, dated 2026-09-21, naming ten indexed publishers — onto *every*
   proposal, and the submit/approve **audit reasons** named D19 too. Onboarding Wikinews would
   have recorded D19's signature for a publisher D19 never mentions: a specific, checkable, false
   claim about a real person, which is worse than a missing approval. Now in
   `scripts/lib/first-contact-approvals.mjs`: D19's ten sources are **enumerated**, later
   publishers carry their own decision, and anything covered by neither **throws**. Adding a
   publisher therefore cannot be done without deciding under whose authority it may be contacted.
   The operator banner and both audit reasons resolve per source.
4. `jurisdictionFor`'s null-endpoint comment claimed only internal services reach it. Now names
   both cases.

`apps/api/test/source-onboard-config.test.ts` (7 tests) holds all of it, including that a source
no decision names throws rather than defaulting, and that the approval stays one domain —
`en.wikinews.org`, no wildcard.

**The eleven existing sources plan identically to before** — 9 ACTIVE, `world-bank-debarred`
blocked on its own robots verdict, `searxng-adverse-media` ACTIVE.

### 5. Verified — every number run

```
typecheck   clean                      lint        clean (0 errors)
unit        71 files, 1163 tests       invariants  31          evaluation  12
security    8 files, 181               integration 14 files, 230 (clean on re-run, see below)
e2e-api     3 files, 34                (clean on re-run, see below)

wikinews:first-contact, unarmed       plan printed, 0 requests sent
source:onboard --source wikinews-en   APPROVED (blocked), banner reads "D22, Faisal Ali, 2026-09-22"
source:onboard (all 12)               11 unchanged; banner "D19 ... | D22 ..."
regression test, violation planted    5 of 7 fail; restored
```

Unit went 69 files/1149 -> 71/1163: +7 for the Google default test, +7 for the onboard config test.

**A `dev:live` stack was running throughout, and it contaminates integration and e2-api.** First
integration run: 2 failed. Second run of identical code: **3 failed, different tests** —
`persistence.test.ts` FI-04 (`expected +0 to be 1`), `transactions.test.ts` FI-05 ("The publisher
never reached the event under test") and the commit-together test (`expected <timestamp> to be
null`). e2e-api: 2 failed, then **34/34 on re-run**.

Every one of them is an **outbox-publishing** assertion, and the cause is the one the
`vitest.config.mts` e2e comment already spells out: `OutboxPublisher.publishOnce` claims whatever
is due and has no deployment filter — correctly, because in production many API instances publish
from one outbox. The running dev stack (`scripts/dev.mjs --live`, PID 49180, plus
`apps/api/dist/main.js`) is a second live publisher against the same Mongo, so it drains events
the tests are about to assert are unpublished. The failure names the victim, never the thief.

Diagnosed rather than assumed: the two failing files **pass in isolation, 52/52**, and full
re-runs are **230/230** and **34/34**. Nothing in this session touches outbox, transaction or
persistence code.

**If a future session sees outbox assertions failing, check for a running `dev.mjs` before
touching the outbox.** It is not a flake in the sense the twenty-fourth and twenty-fifth entries
used the word — it is deterministic given a live stack, and it goes away when there is not one.

### 6. Left half-done — one act, and it is the user's

**No request has been made to `en.wikinews.org`, so the second half of the chain is still
unproven, and folder 18 was not re-run.** Re-running it now would have spent SEC budget to
reproduce the recorded 0-findings result, and the brief sequences it *after* the approval.

The blocker is **D22**, open, and it is a source-admin act with two distinct principals — not an
engineering step. `wikinews-en.ts` still ships `robotsPosition: 'NOT_ESTABLISHED'` and
`firstContactApproval: null`, and `wikinews-en-proposal.test.ts` still asserts both, so these are
**not unfinished fields to tidy up**. Filling them by editing the file bypasses the lifecycle.

```
pnpm wikinews:first-contact                        # prints the plan, sends nothing
pnpm wikinews:first-contact --yes-contact-wikimedia

SOURCE_PROPOSER_KEY=... SOURCE_APPROVER_KEY=... \
  pnpm source:onboard --apply --source wikinews-en
```

The second refuses if both keys resolve to one principal and stops before activation if the
evidence does not support it. No flag overrides either.

**Then, and only then:** re-run the adverse-media flow for the Madoff candidate already discovered
by the `WIKINEWS` engine
(`en.wikinews.org/wiki/Madoff_jailed_after_pleading_guilty_to_%2450_billion_fraud_scheme`), re-run
folder 18, and report the real finding with exact Newman totals. The Target Platform readiness verdict
waits on that chain, because until one article is fetched the honest answer is that the last hop
is unproven.

### 7. Found

1. **The false-signature defect in section 4.3.** Pre-existing, latent while every onboarded
   publisher happened to be one D19 names. Wikinews was the first source that would have exposed
   it, and it would have exposed it silently, on an approved version and in the audit trail.
2. **`EVIDENCE_FETCH_HTTP` had no collection-method branch** (section 4.2) — the first fetch-only
   publisher to go through this script.
3. CLAUDE.md rule 3 still said the SEC was "the only source ever contacted", which stopped being
   true at D18 (GDELT) and again at D20-A. Corrected, with the Wikinews act named as the open one.
4. **A running `dev:live` stack makes integration and e2e-api fail on outbox assertions**, with a
   different set of tests each run. Diagnosed in section 5; worth knowing before anyone concludes
   the outbox broke.

**Next session should:** nothing on Google — it is finished and must be left alone. Take the D22
first-contact decision with the user, in the order in section 6.

**Decisions touched:** **D21 amended** — Google's default switch is now OFF; the readings are
untouched and D20 is not reopened. **D22 opened** — first contact with `en.wikinews.org`, scoped
to that one domain, explicitly not a blanket approval for SearXNG-discovered publishers.
**D20 unchanged.**

## 2026-09-22 (twenty-sixth) — D20-A: the one Google diagnostic, and Google worked

**The one-line state.** Under a narrow amendment to D20, **one** request was issued to Google News
through our own SearXNG instance. **It succeeded** — HTTP 200, 10 results, 10 unique, 1107ms, no
CAPTCHA, and every URL an original publisher's. **Nothing was enabled.** Google is still
`REFUSED`, still `effectiveEnabled: false`, still unreachable from any tenant search.

### 1. Why the diagnostic was needed

Neither of the two previous observations answered the engineering question. The twenty-fourth
session saw `CAPTCHA` at 6ms. The twenty-fifth saw `DISABLED_BY_POLICY` at **0ms** — a better
behaviour, because the governance gate now refuses before the socket opens, and one that erased
the observation along with the request. So acceptance was about to close on an engine whose
technical state nobody had actually seen: integrated-and-unusable, or integrated-and-would-work?

### 2. What was authorised, and what was not — D20-A

`docs/open-decisions.md` now carries **D20-A**, an amendment under D20 rather than a reopening of
it. It permits **a single bounded request for technical verification** and lists what it does not
permit: a second diagnostic, a scheduled one, any Google request from the tenant search path,
activation of `google-news-rss-en-us`, or any edit to the Google row in the engine matrix.

**D20's answer is unchanged.** The refusal, `governanceStatus: 'REFUSED'` and
`effectiveEnabled: false` were all untouched, and the runner asserts each of them **before and
after** the request — so a run that happened to coincide with somebody flipping a flag could not
be mistaken for this one.

### 3. How it reached an engine the instance has disabled

It did **not** reconfigure anything. `infra/local/searxng/settings.yml` still carries
`google news: disabled: true`, and that file's own comment already documented the property used
here: the engine "never runs for a request that merely names `categories=news`; only a request
naming the engine explicitly could reach it, and our connector's allowlist will not name it." The
connector still will not name it. `tests/live/searxng-google-diagnostic.test.ts` names it, once.

Three gates on that file: it is in the `live` vitest project, it is armed by
`SEARXNG_GOOGLE_DIAGNOSTIC=yes-one-google-request-under-d20a` — **a different variable from**
`SEARXNG_LIVE_SMOKE`, so arming the routine smoke can never arm this — and it `skipIf`s itself
rather than throwing, so `pnpm test:live` does not break for anyone who did not ask for it.
Verified: unarmed, it skips, and zero requests leave.

### 4. The result

```
attempted          true
request            /search?q=%22Bernard+Madoff%22+fraud&format=json&engines=google+news&pageno=1&language=en
outcome            RETURNED_RESULTS
http status        200
upstream           SUCCESS — no CAPTCHA, no 429, no 403, no timeout
duration           1107 ms
raw results        10
unique results     10
duplicates         0
unresponsive       (none)
engines credited   google news only  (asserted: the instance ran no engine we did not name)
```

**Suspension state.** Not suspended before: the 3600s cooldown from the 10:51 CAPTCHA had expired
about two hours earlier, so the request genuinely reached Google rather than our own breaker —
worth checking before any repeat, because a suspended engine makes the diagnostic measure
SearXNG instead of Google. **Not suspended after:** `docker logs … | grep -i google` shows
exactly two entries, 09:30:52 and 10:51:32, both predating this run — it wrote none. `GET
/stats/errors` moved `google news` from **100% to 50%** on the same single `ErrorContext`, which
is one success recorded beside one historical error. Cooldown after the run: **0s**.

No retry was issued, no proxy or alternate egress was used, no CAPTCHA was solved or submitted,
and no header was forged — the request carried exactly what `NodeSearxngTransport` sends every
other engine.

### 5. The finding that actually matters, and it is not the success

**All 10 URLs were original publisher URLs. Zero Google-hosted redirects.** Bloomberg, the
Guardian, Reuters, CNBC, SCMP, Time, the Independent, ABC, Dawn.

D20 recorded a **second, independent defect** beside the licence one: a Google News RSS
`<item><link>` is a `news.google.com/rss/articles/CBMi<token>` redirect rather than the
publisher's article URL, so the feed could not meet FR-09 provenance *even with permission*.

**That defect is specific to the RSS feed and does not carry over to this route.** The SearXNG
`google news` engine scrapes `google.com/search?tbm=nws`, which returns publisher URLs directly.
Anyone reopening this must not cite the provenance objection as though it still applied here.

**The licence objection is untouched, and it is now the whole of the refusal.** Personal
non-commercial use only; no robot or automated process to monitor or copy content. Scraping the
news results page is if anything further from permitted than the RSS feed D20 examined.

### 6. What this does NOT do

**It does not make Google `PERMITTED`.** Inferring permission from an engine having worked is the
exact inversion `engine-governance.ts` was written to prevent — its file header says so in as many
words. The reading moves when somebody reads the terms and decides, not when a request returns
200.

**Nothing became tenant data.** No lead, no candidate, no fetched document, no finding, no
database row. The ten URLs exist in the evidence file and in the run's console output, nowhere
else.

**Tenant production is unchanged.** `effectiveEnabled` is `integrated && tenantEnabled &&
governanceStatus !== 'REFUSED'`, so the REFUSED reading blocks execution whatever a tenant switch
says. The diagnostic bypassed that gate only inside its own file, which nothing on the request
path can reach.

### 7. Verified

```
pnpm typecheck                       clean
diagnostic unarmed                   1 test file, 1 skipped, 0 requests
diagnostic armed                     1 test file, 1 passed, 1113ms, exactly 1 upstream request
```

**Files added:** `tests/live/searxng-google-diagnostic.test.ts`,
`docs/sources/evidence/google-news-searxng-diagnostic.json`.
**Files edited:** `docs/open-decisions.md` (D20-A and the D20 summary row), this log.
**No production source file was touched.** `engine-governance.ts`,
`engine-enablement.service.ts`, `searxng-client.ts`, the connector and `settings.yml` are all
unchanged **by this session**. `git diff --stat -- apps/api/src/sources/searxng/` is empty;
`settings.yml` does show a diff against HEAD, but that is the twenty-fourth session's
`keep_only` work sitting uncommitted in a dirty tree, and `google news: disabled: true` is
still on line 76. Confirmed after the run rather than assumed:
`integrated=true, governanceStatus=REFUSED, tenantEnabled=true, effectiveEnabled=false`.

**Next session should:** still the Wikinews first-contact decision from the twenty-fifth entry —
read `en.wikinews.org/robots.txt`, then propose → submit → approve → activate with two distinct
principals, then re-run folder 18 for the Madoff article. **The user drives first contact.** The
Google diagnostic did not displace that and did not touch it.

**Decisions touched:** **D20 amended by D20-A** — one bounded diagnostic permitted, the refusal
itself unchanged. **D20 NOT reopened**; its answer is still no. **A new question is raised and
deliberately left open:** Google works from this egress with usable provenance, so the refusal now
rests on the licence alone. Whether to reopen D20 on the clauses it quoted, or to take the
documented licensed alternative (Programmable Search Engine / Custom Search JSON API, paid beyond
a free allowance), is a **separate production-governance decision and has not been taken.** **D21
untouched.**

## 2026-09-22 (twenty-fifth) — D21 closed, and publisher-fetch permission split from discovery permission

**The one-line state.** The 12-source stack is live and honestly reported, but the chain is proven
end to end *except the last hop*: SearXNG discovery works, and **no article is fetched yet**,
because the fetch gate now — correctly — demands an approval for the publisher's own domain, and
only one candidate publisher has been proposed for one.

### 1. Runtime first, because the previous run's results were invalid

**Two full `dev:live` stacks were running against one queue.** Stack A (12:59) and stack B
(16:23), both reading the same `.env`, so both workers polled `adverse-search-jobs`. Stack A's
worker was loaded from a build predating the D20 enforcement fix, so it could have processed an
acceptance job under pre-fix code. Proof it was stale: `GET /v1/tenant/discovery/engines` returned
**404** on stack A (route absent from its loaded build) and **401** on stack B. Stack A was killed
as a tree.

**The SQS queues did not exist.** `ListQueues` returned empty and `GetQueueAttributes` returned
`NonExistentQueue`; the worker had been failing every poll since LocalStack last restarted. Fixed
by calling `bootstrapAws()` from `scripts/bootstrap/aws.mjs` directly — bucket and queues only, no
data seeding. The worker recovered on its next poll (`ReceiveMessage => 200`).

**If a future session finds adverse-search jobs never completing, check for a second `dev.mjs`
tree, then check the queue exists.** Both were wrong today and neither was visible from the API.

### 2. D21 closed — five engines PERMITTED

`engine-governance.ts`: `BING_NEWS`, `BRAVE_NEWS`, `DUCKDUCKGO_NEWS`, `REUTERS`, `WIKINEWS` moved
`PENDING` to `PERMITTED`, with `reviewedBy` naming the product owner. **Google untouched** — still
`REFUSED` under D20, `effectiveEnabled: false`, `DISABLED_BY_POLICY`, zero upstream requests.

Each `evidenceNote` now opens by saying the decision is a **recorded acceptance of residual risk,
not a completed legal review by counsel**, then retains its original limitation verbatim. Nothing
was softened to justify the change, which is the point of recording it rather than assuming it.

**A test went vacuous and was strengthened rather than left green.** `never records a reviewer for
an engine nobody has reviewed` guarded an empty set once no engine was `PENDING`. It now also
asserts the converse — a decided reading must name its decider — and that all six are decided.

### 3. A reporting defect: an engine that returned 49 results said ZERO_RESULTS

`worstOutcome` ranked `ZERO_RESULTS` as *more severe* than `RETURNED_RESULTS`, so Reuters — which
returned 49 results across 5 of its 12 queries — aggregated to `ZERO_RESULTS`. Folder 18 passed
anyway, because no assertion checked the substance. The ordering is swapped. Every genuine failure
still outranks both, so the property the ordering exists for is unchanged.

### 4. The architectural change: discovery permission is not publisher-fetch permission

**The defect.** All 46 fetchable candidates were refused because `searxng-adverse-media` carried
`firstContactApproval: null`. The obvious fix — record one on that source — was **rejected by the
product owner**, and rightly: it would have turned one signature on our own internal record into an
approval to fetch from every publisher on the open web.

**What was built instead.** `SourceVersionReader.loadActiveByDomain(domain)` and
`domainMatchCandidates`, matching **whole labels**, most specific first — so `sec.gov` covers
`www.sec.gov`, `notsec.gov` matches nothing, and a bare TLD is never a candidate.
`FetchGateInput.publisherDomain` makes the gate authorise a **discovered document** against the
registry record for the domain being contacted, never the source that named it. A domain no record
covers is refused `PUBLISHER_NOT_APPROVED`.

**That refusal is per candidate, never per source** (`isSourceLevelRefusal` returns false).
Source-level would report the discovery service as a coverage gap on every run and hide the engines
that worked behind a whole-source exclusion. Confirmed live: `searxng-adverse-media` now reports
`COMPLETED` with 46 per-candidate refusals beside it.

**Mock mode is exempt**, on the rule D-042 already uses: no publisher is involved. Fixture leads
name invented domains (`nacion-example.cr`) while fixture sources register `fixtures.local`, so
resolving by publisher in mock mode refuses every fixture — and refuses a publisher that does not
exist. Found by `tests/integration/pipeline.test.ts` dropping to zero findings.

**Diagnostics now carry** `publisherDomain`, `fetchAttempted` and `discoveredByEngines` on every
rejected lead, so an unapproved publisher is visible rather than merely absent. Read defensively in
`searches.service.ts`, so rows written before these fields existed still read.

### 5. Left half-done — one thing, and it needs a person

**No article has been fetched, so the fetch → extraction → FR-08 → FR-10 → finding half of the
chain is still unproven against a real article.** The blocker is one narrowly scoped approval.

`apps/api/src/sources/registry/wikinews-en.ts` is written and schema-valid: `en.wikinews.org` only,
`authorityTier: 4`, `EVIDENCE_FETCH_HTTP`, never polled. It is **deliberately not activatable** —
`robotsPosition: 'NOT_ESTABLISHED'` and `firstContactApproval: null` — and
`wikinews-en-proposal.test.ts` asserts both, so a future session cannot read them as unfinished
fields to tidy up.

The candidate it would unlock is real and already discovered:
`https://en.wikinews.org/wiki/Madoff_jailed_after_pleading_guilty_to_%2450_billion_fraud_scheme`,
surfaced by the `WIKINEWS` engine. Wikinews was chosen because its access is the one reading in the
D21 matrix resting on published evidence: the documented MediaWiki Action API, Wikimedia's API
etiquette contemplating automated clients, and CC BY 2.5 content.

**The next session must NOT fill those two fields by editing the file.** It needs a first read of
`en.wikinews.org/robots.txt` and then propose → submit → approve → activate with two distinct
principals. The user drives first contact.

### 6. Verified — every number run today

```
typecheck   clean                    lint        clean (0 errors)
unit        69 files, 1149 tests     invariants  31        evaluation  12
security    8 files, 181             integration 14 files, 230
e2e-api     3 files, 34
```

`tests/integration/jobs.test.ts` FI-09 failed once under full-suite load and passed in isolation
and on a full re-run — the **same pre-existing flake** the twenty-fourth entry recorded, not new.

**Live SearXNG smoke** (`SEARXNG_LIVE_SMOKE=yes-query-the-instance`): GOOGLE_NEWS
`DISABLED_BY_POLICY`, 0 results, **0ms**. Worth noting it was `CAPTCHA` at 6ms before, which meant
a request *was* being sent; it now makes none. BING 7, BRAVE `CONNECTION_ERROR`, DDG 17, REUTERS
20, WIKINEWS 4. 48 raw, 42 unique, 6 collapsed.

**Folder 18**, three runs against port 28081; final run **47 requests, 47 assertions, 0 failures,
17.3s**. 104 raw → 62 unique → 42 collapsed → 46 `PUBLISHER_NOT_APPROVED` → 0 fetched → 0 findings.
On the third run `sec-press-releases` reported `SKIPPED — hourly free-tier budget of 6 spent`,
which is the budget working rather than a fault.

### 7. Folder 18 collection defects found and fixed

1. **`caToken` leaked in from folder 17.** 18.3 wrote it and 18.4 read it, so the two folders
   shared one verification token. Renamed to `sxToken`; folder 17 verified untouched.
2. **The collection-level pre-request guard throws unless `apiKey` is set** for any `/v1` path, and
   folder 18 authenticates with `sourceAdminKey` and `sxLiveKey`. Satisfied from the
   **environment** rather than by weakening a guard shared with sixteen other folders.
3. The preflight route (`GET /v1/admin/sources?recordId=…`) was already correct — verified live.
4. `baseUrl` still defaults to `:3000` at collection level and the environment overrides it to
   `:28081`. Left alone deliberately: it is shared with every other folder.

**A formatting trap worth knowing:** rewriting that collection with `json.dumps(indent=1)` reflowed
all 15k lines. It is `indent=2`. Check `git diff --stat` after any scripted edit to it.

**Next session should:** take the Wikinews first-contact decision — robots read, then the four-eyes
lifecycle — then re-run folder 18 and prove SearXNG → publisher → FetchGate → fetch → extraction →
FR-08 → classification → FR-10 → finding for the Madoff article. Everything else on the
twenty-fifth brief is done.

**Decisions touched:** **D21 CLOSED on all six readings** — five PERMITTED, Google REFUSED under
D20. **D20 unchanged and not reopened.** **D-042 strengthened, not weakened**: it now binds the
publisher rather than the discoverer.

## 2026-09-22 (twenty-fourth) — SearXNG multi-engine adverse-media discovery, rung 5

**Did:**

*Audit first.* Found the existing SearXNG (compose service `searxng`, `127.0.0.1:28888`, JSON
already the only format) and read `GET /config`. Two real defects:

1. **The instance was running 267 engines, not the two its settings file claimed.**
   `use_default_settings: true` MERGES an `engines:` block with the upstream defaults rather
   than replacing them, so the comment reading "an approved engine list, not everything SearXNG
   supports" described the intent and the deployment did the opposite. Fixed with
   `use_default_settings.engines.keep_only` — 267 → 11.
2. **`engines=` is a UNION with `categories=`, not a filter on it.** A request naming one engine
   *and* `categories=news` runs every news engine. The milestone brief specifies
   `categories=news`; sending it would have made the engine allowlist decorative. **The connector
   names one engine per request and never names a category.** Evidence in
   `docs/sources/evidence/searxng-adverse-media.json`.

*New code.* `apps/api/src/sources/searxng/`: `engine-governance.ts` (the six-engine matrix),
`engine-enablement.service.ts` (per-tenant switches + resolution), `engine-health.ts` (typed
per-engine outcomes, run summary, derived source outcome), `searxng-client.ts` (internal
transport + JSON parse), `searxng-discovery.adapter.ts` (the connector).
`apps/api/src/tenancy/discovery-engines.controller.ts` is the control API.
`registry/searxng-adverse-media.ts` is the source proposal. Also:
`NEWS_DISCOVERY_SEARXNG` connector type; `FetchGateService.authoriseInternalDiscoveryService`;
`INTERNAL_SERVICE_NOT_A_PUBLISHER` robots position; `DiscoveryAttribution` on `Lead`;
`discoverySource`/`discoveryEngines` on findings; `searxngDiscovery` on the findings response;
`SEARXNG_URL` in config; ladder-builder wiring; `source-onboard.mjs` now carries this source.

*Three design decisions worth knowing about, because each looks wrong at a glance.*

- **One request per engine, not one merged request.** A merged request cannot give per-engine
  timing, fails as a unit (losing engines that had already answered), and cannot distinguish
  `ZERO_RESULTS` from "never ran". **It costs the upstreams nothing**: a merged request forwards
  to all six anyway, so each engine sees the same one query. Only loopback traffic multiplies.
- **It does NOT go through `EvidenceFetchPort`.** SEC-02 refuses http and refuses loopback,
  correctly — it exists to stop us dialling an address a *third party* named. The SearXNG base URL
  is ours, from configuration. Routing it through the publisher gate would have meant punching a
  loopback exception into the one function that stops a news feed reaching our database. Instead
  there is a narrow transport that addresses one configured host and re-checks it before the
  socket opens. **The leads it returns are screened normally** and article fetches go through
  FetchGate untouched.
- **The QUERY_FEED "must record an endpoint" schema rule moved** from
  `sourceAccessPolicySchema` to `sourceContentSchema.superRefine`, where `connectorType` is in
  scope. It is not weakened: an internal service must record NO endpoint (a loopback URL on an
  approved version reads as a publisher's published address), and a publisher claiming the
  exemption is refused. Both directions are tested.

**Verified** (all run, all numbers real):

- `pnpm typecheck` — clean. `pnpm lint` — 0 errors.
- `pnpm test:unit` — **67 files, 1130 tests, all passing** (was 64/1061).
- `pnpm test:invariants` — 31 passing. `pnpm test:evaluation` — 12. `pnpm test:security` — 181.
- `pnpm test:integration` — 230 passing. `pnpm test:e2e:api` — 34 passing.
- **Live smoke**, `SEARXNG_LIVE_SMOKE=yes-query-the-instance pnpm exec vitest run --project live
  tests/live/searxng-live-smoke.test.ts`, one bounded query per engine for "Bernard Madoff" fraud:

  | engine | outcome | results | ms |
  | :-- | :-- | --: | --: |
  | GOOGLE_NEWS | CAPTCHA | 0 | 6 |
  | BING_NEWS | RETURNED_RESULTS | 7 | 691 |
  | BRAVE_NEWS | CONNECTION_ERROR | 0 | 134 |
  | DUCKDUCKGO_NEWS | RETURNED_RESULTS | 17 | 522 |
  | REUTERS | RETURNED_RESULTS | 20 | 1276 |
  | WIKINEWS | RETURNED_RESULTS | 4 | 740 |

  48 raw results, 42 unique, 6 duplicates collapsed, source outcome `PARTIAL`. Four engines
  returned and two failed in two different ways, in one run, and every candidate from the four
  that worked was retained. An earlier run had Reuters failing with `HTTP error` and three
  engines returning — the failures are transient, which is the point.

**Left half-done:**

- **Postman folder 18 has never been executed.** It is written (18 steps, folder 17 untouched)
  and it has not been run, because it needs `pnpm source:onboard --apply` to have activated
  `searxng-adverse-media` first and that has not been done either. Arm with
  `sxConfirm = yes-query-searxng-and-sec`.
- **`searxng-adverse-media` is proposed but not ACTIVE.** Until it is, the rung reports as
  unsearched. `pnpm source:onboard --apply` will take it through propose → submit → approve →
  activate with four eyes; its evidence file already records `activationSupported: true`.
- **No end-to-end run has yet produced a metasearch *finding*.** The smoke test proves discovery;
  the fetch → extraction → FR-08 → FR-10 half of the path is wired and unit-tested but has not
  been exercised against a real article from this source.

**Found:**

1. The two audit defects above.
2. **A fixed feed only serves F1 queries.** `RssNewsDiscoveryAdapter` declines a `FIXED_FEED` for
   any family but F1 — correct (polling the publisher's whole list again per conduct term is the
   same bytes 50 times) and it silently made an F3-based isolation test look like "the SEC had
   nothing". Cost an hour. The test now uses F1 and says why.
3. **The "only the gate issues a FetchAuthorisation" test greps for a literal string.** A *comment*
   mentioning `urlPolicyPassed:` fails it. Worth knowing before writing prose near that file.
4. Two integration tests flaked once each under parallel load (`jobs.test.ts` FI-09;
   `search-index.test.ts` Meilisearch searchability) and both passed in isolation and on re-run.
   Shared-Mongo/Meili timing, unrelated to this work, but worth a look if they recur.

**Next session should:** run `SOURCE_PROPOSER_KEY=... SOURCE_APPROVER_KEY=... pnpm
source:onboard --apply --source searxng-adverse-media`, confirm it reaches ACTIVE, then run
Postman folder 18 and record the per-engine table it prints.

**Decisions touched:**

- **D21 opened** — the per-engine governance matrix. It is deliberately **not** one decision.
- **All six engines are integrated and default to ON**, by the product owner's decision this
  session. That is a *switch*, not a *reading*: five readings are `PENDING` and Google's is
  `REFUSED` under **D20**, and none was rewritten. The disagreement on Google is carried
  explicitly — `overridesRefusal: true` on every control-API response, a warning log and an audit
  entry when a tenant enables it, and the `REFUSED` reading in every per-engine diagnostic row.
  Google is additionally `disabled: true` on the instance, so in practice it returns CAPTCHA.
- **D20 unchanged.** Nothing here reopened it.

## 2026-09-22 (twenty-third) — Google News RSS refused before contact; the stack is live and armed

**The one-line state.** `google-news-rss-en-us` is **closed as refused (D20)** on Google's own
published terms, without a single request ever being sent to `news.google.com`; the local stack is
up in **live** mode with SEC healthy and today's feed read; and the combined Postman acceptance
(folder 17, 9 indexed + 2 SEC) is armed and **waiting on the user**, who is driving the tenant
signup by hand.

---

### 1. Google News RSS — asked for, audited, refused

The ask was to add Google as an adverse-media **discovery** source: tier-5 provenance, not an
evidence authority, graded through the same FR-08 resolver as SEC, clustered by FR-10, isolated on
failure, with its own budget and breaker. Mechanically all of that was already possible —
`GOOGLE_NEWS_RSS_TEMPLATE` has existed as PROPOSED since the discovery rungs were written, and its
`connectorType` is `NEWS_DISCOVERY_RSS`, the **same connector the SEC feeds use**. No connector
work was ever the blocker.

**The blocker is the right to call it, and the answer is no.** Google's News Terms of Use:

> "You may only display the content of the Service for your own personal use (i.e.,
> non-commercial use)"

> "use any robot, spider, other device or manual process to monitor or copy any content from the
> Service"

This is a commercial screening product that would poll automatically. Either clause alone excludes
it. **The endpoint being undocumented is not a loophole** — an undocumented endpoint carries no
separate grant, so the general terms are the only terms in force.

**No request was made to `news.google.com`, deliberately.** Act one of the onboarding procedure
normally loads robots.txt, the terms page and the endpoint. Here the terms answered the question
*before* the endpoint was reached, and the answer was a prohibition on automated access. Loading
the feed to "verify" it would be performing the prohibited act in order to decide whether the act
is prohibited. `robots.txt` was not read either: it governs crawling and cannot grant what the
terms withhold.

Verified in the database after the fact: `google-news-rss-en-us` is still **PROPOSED v1**, zero
`sourceHealth` rows, zero `sourceDocumentVersions` mentioning `news.google.com`.

### 2. A second defect that outlives the licence question

Even with permission, the feed **cannot meet FR-09 provenance**. Since late 2024 a Google News RSS
`<item><link>` is not the publisher's article URL but a Google redirect,
`news.google.com/rss/articles/CBMi<token>?oc=5`. The only two ways to recover the real article URL
are (a) follow the redirect — another automated request to Google, the prohibited act — or (b)
decode the token, whose base64 payload is a protobuf holding Google's *internal article id* and
needs a signature that cannot be computed offline. The `<source url>` element gives the publisher's
**domain**, never the document.

So the requirement "resolve the original publisher/article URL where safely possible" has a real
answer: **it is not safely possible.** A finding that names a domain and cannot name the document
is one a reviewer cannot check. This is worth keeping in mind for *any* aggregator proposed later —
the question "does the link go to the publisher?" is now a standing onboarding question.

### 3. What was written

- **`docs/sources/evidence/google-news-rss-en-us.json`** — the evidence, in a deliberately
  different shape from every other file in that directory. It carries `method:
  "DESK_RESEARCH_ONLY"` and `endpointContacted: false` with the reason, and records **no**
  httpStatus, wireBytes or body hash, because none was observed. The file says in as many words
  that a future reader must not treat those absences as an unfinished evidence run to be completed.
- **`docs/open-decisions.md`** — **D20** added to the index and given a full detail section.
- **`docs/sources/source-catalogue.md`** — the Google row now reads `PROHIBITED — D20`. The section
  already predicted this outcome ("these are the two rungs where a publisher's terms most plausibly
  forbid automated querying"); the note now records that the prediction was tested and was right.
- **`apps/api/src/sources/registry/discovery-rungs.ts`** — the template carries the refusal in its
  header comment **and in `policySummary`, which is the version content an administrator actually
  reads before approving**. A comment alone would not have been enough.
- **`apps/api/test/discovery-rungs.test.ts`** — three new tests (12 → **15 passed**) asserting the
  refusal survives in `policySummary`, that `firstContactApproval` is still null and
  `robotsPosition` still `NOT_ESTABLISHED`, and that no licence version is named.

**Why the test matters more than it looks.** Google is the one template in that file whose evidence
*has* been gathered. Without a test, the next person tidying the file reads `UNVERIFIED`, takes it
to mean "go and verify it", and the source becomes activatable. The tests make the refusal
load-bearing.

### 4. NOT done for Google, deliberately

No version proposed, approved or activated. No connector written. **No four-eyes step bypassed —
because no lifecycle step was taken at all.** No live smoke test. No Postman folder. The eight
proofs that were asked for (real candidates, publisher URLs preserved, no fixtures, article-based
identity matching, duplicate clustering, failure isolation, indexed sources silent, SEC healthy)
were **not run and cannot be run**, because running them requires making the request that the terms
forbid. Reporting them as untested is the honest outcome, not a gap.

**`bing-news-rss-en-us` (rung 4) was not examined** and must not be activated on the assumption
that Microsoft's position differs. The same two questions — commercial use, and whether the link is
the publisher's — have to be answered for it on its own evidence.

**The legitimate alternative**, recorded so it is not re-derived: Google's Programmable Search
Engine / Custom Search JSON API is documented, licensed for commercial use, and returns publisher
URLs directly. It is paid beyond a small free allowance, which makes it a commercial decision and
puts it outside this project's free-and-open-source constraint.

### 5. Stack state, and one thing that bit

`pnpm local:up` brought all seven containers healthy. **Mongo persisted across the Docker restart;
LocalStack did not** — the SQS queues were gone and the worker logged `QueueDoesNotExist` on every
poll. `pnpm local:bootstrap` **refuses to run while `ADVERSE_SEARCH_MODE=live`** (seeding is
mock-only, T55), so it was run as `ADVERSE_SEARCH_MODE=mock node scripts/local-bootstrap.mjs` to
recreate the queues and S3 bucket. Every write is an upsert; no live record was touched. The worker
recovered on its next poll and has logged no failure since.

If a future session finds a live-mode worker failing every poll after a Docker restart, this is why.

### 6. SEC live smoke — one run, healthy

```
node scripts/sec-live-smoke.mjs --yes-contact-the-sec     PASSED
```

25 leads normalised, `mode: LIVE`, 965ms, outcome OK. Budget moved by **2** (the feed poll plus a
cold-process `robots.txt`), daily spend 2 of 120, breaker CLOSED, no kill switch. Today's feed:
`lr-26644` Michael T. Christensen (new, published 2026-09-21), `lr-26643` Michael Ayala / Wavemark
Capital, `lr-26642` Ellen Polcari.

### 7. Folder 17 — armed, NOT run

An armed environment was written to the scratchpad (`folder17.env.json`): `local.ready` plus
`caConfirm = yes-contact-sec-and-indexed` and `caSecSubjectName = Ellen Polcari` — chosen because
it is the case proven to grade in the 2026-09-21 acceptance run and is still in today's feed, so a
failure points at the pipeline rather than at name-form matching. The repo's
`local.ready.postman_environment.json` was **not** modified.

**The user is creating the tenant themselves from Postman, so newman was not run.** One field still
needs setting by hand: **`caEmail`** — nothing in folder 17 generates it, and 17.5 reads the
verification token back out by that exact address.

Because Google is refused, the "combined" acceptance is folder 17 exactly as it already stands:
**9 indexed + 2 SEC discovery, GDELT suspended.** No assertion was weakened and no Google section
was added.

### 8. Verified — exact commands and figures

```
pnpm typecheck                                          clean
eslint discovery-rungs.ts discovery-rungs.test.ts       clean
vitest --project unit apps/api/test/discovery-rungs.test.ts    15 passed (was 12)
node scripts/sec-live-smoke.mjs --yes-contact-the-sec   PASSED, 25 leads, budget +2
```

Registry read from Mongo and over the Admin API, agreeing: **11 ACTIVE real sources** (9 indexed +
2 SEC), 8 fixture/mock ACTIVE, `gdelt-doc-v2` SUSPENDED, `world-bank-debarred` APPROVED-blocked,
`google-news-rss-en-us` and `bing-news-rss-en-us` PROPOSED. 33,619 indexed rows.
`source:four_eyes_bypassed_for_testing` count **0**.

### 9. Next session should

1. **Run folder 17** (set `caEmail` first) and confirm 52 assertions still pass against today's
   live SEC feed. That is the gate the user set before Target Platform onboarding starts.
2. Then **Target Platform**, where the real distance is. Note in particular that
   `docs/integration/target-platform.md` still opens with *"the service runs end to end in mock mode. Every
   source is a fixture"* — **stale since 2026-09-16** and actively misleading to a first client.
   Fix that header before the document is sent anywhere. There is also no Target Platform tenant (203
   tenants, none matching), and `pnpm demo:target-platform` is still a stub that exits 1.
3. **F3** — the eight FR-07 validation rules — is still unwritten. `grep validateAssertion` still
   returns nothing.

### 10. Decisions touched

**D20 opened and closed the same day — refused.** D6, D17, D18 unaffected. No four-eyes step was
taken for Google, so no approval exists to audit. D7 (extraction model) remains the blocker behind
discovery findings carrying a name and nothing else.

---

## 2026-09-21 (twenty-second) — Queue isolation, SEC discovery restored, and the combined acceptance run is green

**The one-line state.** The e2e suites can no longer have their jobs stolen — by a `pnpm dev`
worker or by each other; `sec-litigation-releases` and `sec-press-releases` are **ACTIVE** again
through the real four-eyes lifecycle; `gdelt-doc-v2` is still **SUSPENDED** and was never
contacted; and a new combined acceptance suite plus Postman folder 17 assert the nine claims of
this milestone against a live deployment. Everything is green: lint, typecheck, 1101 pure, 411
integration+security, **34/34 e2e**, **11/11 live acceptance**, **52/52 Postman assertions**.

---

### 1. The blocker the last entry left, and what it actually was

The last session left `pnpm test:e2e:api` failing intermittently and attributed it to a stale
`pnpm dev` stack holding pre-refactor code. That was **half right**, and the other half is the
part worth reading.

**Cause one — the dev worker.** A `pnpm dev` stack polls `adverse-search-jobs` from `.env`, in
whatever mode and whatever build it booted with, for as long as somebody leaves it open. On
2026-09-21 that was a **live** worker, and a live worker handed a fixture search refuses every
source (T55) and returns zero findings. Stopping it was step one and it was necessary.

**It was not sufficient.** With the dev stack stopped, the suites still crossed — and the symptom
moved to a different file each run, which is what makes this class of bug expensive.

**Cause two — the shared outbox, and this is the one nobody had found.** The three `tests/e2e`
suites run against one database and therefore one `outboxEvents` collection.
`OutboxPublisher.publishOnce` calls `findDue` and claims whatever is pending — it has **no
deployment filter, and it is right not to have one**: in production many API instances publish
from one outbox into one queue, which is exactly how horizontal scaling works. What cannot happen
in production is several instances sharing an outbox while each holds a *different*
`JOBS_QUEUE_URL`. Run the three files concurrently and that is precisely the arrangement: the
indexed suite (a **live**-mode worker) picks up a mock suite's `search.queued` row and posts it to
the indexed suite's queue, where its own live worker takes it, refuses every fixture source, and
settles the run in ~600ms with zero findings.

Both failure modes name the **victim**, never the thief:
`expected 0 to be greater than 0` in `tenant-onboarding-e2e`, or a search that never leaves
`QUEUED`. Neither says anything about the run that took the message.

**Diagnosis that settled it:** running `tenant-onboarding-e2e.test.ts` alone passed 16/16, and the
stolen run's record showed `discovery SKIPPED — no approved source sits on the FR-05 discovery
ladder in this process` — which is correct for a live worker (`SourceAdapterSet` returns
`newsDiscovery: []` in live mode) and impossible for the mock suite that submitted it.

### 2. What was built for it

**`tests/e2e/support/queues.ts`** — one queue per suite, created in `beforeAll`, plus its own dead
letter queue. `indexed-adverse-search-e2e.test.ts` had done this privately; the module generalises
it and the other two suites now use it rather than rediscovering the hazard.

The generic `JOBS_QUEUE_URL` is **deliberately not consulted** as a fallback. A suite that reads it
rejoins the shared queue the moment anything exports it — a shell that sourced `.env`, a CI job
setting it for the integration suite — so each suite reads **its own** variable
(`API_LIFECYCLE_E2E_QUEUE_URL`, `TENANT_ONBOARDING_E2E_QUEUE_URL`, `INDEXED_E2E_QUEUE_URL`) and an
override has to name the suite it is overriding.

**`--no-file-parallelism` on the `test:e2e:api` script** closes the outbox half. One publisher live
at a time means the event and the queue belong to the same suite by construction.

> **`fileParallelism: false` set on a vitest _project_ is accepted silently and does not take
> effect.** The files still overlap. The only way to notice is that the summed test time exceeds
> the wall-clock duration — 108s of tests inside a 72s run. That is why the flag is in
> `package.json` and why `vitest.config.mts` carries a paragraph saying so. If it is ever dropped,
> the suites start crossing their own searches again.

Cost: ~145s serial against ~70s concurrent. Tests *within* a file still run in order, as before.

**Proof, not assertion:** `pnpm test:e2e:api` was run **five consecutive times clean (34/34)**, and
then once more **with a live `pnpm dev` worker running on the shared queue** — also 34/34.

### 3. SEC discovery restored

Both versions went SUSPENDED → ACTIVE over the **real Admin API**, with a credential distinct from
the version's `proposedBy`:

| Source | Version | Before | After |
| :-- | :-- | :-- | :-- |
| `sec-litigation-releases` | v5 | SUSPENDED | **ACTIVE** |
| `sec-press-releases` | v1 | SUSPENDED | **ACTIVE** |
| `gdelt-doc-v2` | v1 | SUSPENDED | **SUSPENDED**, daily spend 0 |

`db.auditEvents.countDocuments({action: 'source:four_eyes_bypassed_for_testing'})` is still **0**.

**`scripts/source-restore.mjs` (`pnpm source:restore`)** is new, and is a separate script from
`source:onboard` on purpose. Onboarding walks a source *into* the registry and is content-driven;
restoring acts on a version that already exists and was already approved. Folding the two together
would mean either proposing a duplicate version of something already correct, or an onboarding
script with two modes — and a script with two modes is one nobody reads carefully before running.

**`RESTORE` is not a status flip**, and the lifecycle is right to make it three things at once:
four eyes (checked against `proposedBy`), a mandatory reason recorded permanently in the version
history, and the SEC-05 rights clearance re-evaluated — a licence that lapsed during the suspension
must not be restored past. The restore reason recorded on both versions names the defect that was
fixed, states that the publisher's position is unchanged, and says plainly that it was executed by
an automated session using the approver credential rather than by a second human reviewer.

### 4. The combined acceptance run

**`tests/live/acceptance/combined-adverse-search.test.ts`**, its own vitest project
(`live-acceptance`), armed by `COMBINED_LIVE_ACCEPTANCE=yes-contact-the-sec` — deliberately **not**
`SEC_LIVE_E2E`, because arming one live suite must never arm another.

```
COMBINED_LIVE_ACCEPTANCE=yes-contact-the-sec pnpm test:live:acceptance     # 11 passed
```

Nine indexed sources from local snapshots and both SEC feeds live, in one deployment. What it
proved, with the witness in each case:

| Claim | Witness |
| :-- | :-- |
| Indexed sources issue **zero** publisher requests during a tenant search | `GET /v1/admin/indexed-sources` before and after: `lastAttemptAt`, `httpStatus`, `refreshStatus`, `activeSnapshotVersion` all unmoved, while the search returned findings |
| SEC discovery grades through the shared FR-08 resolver | The live finding's only factor is `EXACT_COMMON_NAME`/WEAK with a real span and a detail naming both sides; **no** `RARE_FULL_NAME_PLUS_CITY` |
| Name-only discovery stays AMBIGUOUS | `axes.identity = WEAK`, `band = AMBIGUOUS` on a real SEC litigation release |
| Year-only DOB is never `FULL_DOB`/STRONG | Subject and OFAC row both at YEAR precision; the DOB factor is not `FULL_DOB` and not STRONG |
| Authority tier comes from the source version | `document.authorityTier = 1` and `axes.authorityTier = 1` — the old hardcoded value was 2 |
| FR-10 clustering is live in the runtime | Findings carry `FR-10 cluster cluster-2: 2 document(s) about this event` — a line emitted only for a cluster with more than one member |
| A duplicate does not inflate corroboration | The injected duplicate joined the same cluster; `independenceCount` stayed **1**, note reads `counted: 1 (1 issuing authority` |
| Independent authorities stay independent | OFAC and EU each kept their own finding for one cross-listed person; every cluster note reads `0 excluded as copies` |
| Indexed findings survive a SEC failure | SEC kill switch engaged; the indexed finding survived, SEC reported by name with a reason, run not `NO_MATCHES_FOUND` and coverage not `COMPLETE` |
| No fixture id anywhere | Every outcome and every finding checked against `/fixture|mock/i`; every finding `mode: LIVE` |

**Real evidence, not a shape:** the graded SEC finding is `lr-26642` on `www.sec.gov`, `mode:
LIVE`, subject `Ellen Polcari`, retrieved live during the run.

### 5. Two things the acceptance run taught us that were not known before

1. **Copy *suppression* cannot be exercised in this deployment, and that is by design.**
   `assignClusters` never demotes an independent authority record to a copy — it re-reads
   `DUPLICATE_DOCUMENT`/`SYNDICATED_COPY` as `SAME_EVENT`. Indexed records are all
   `isIndependentAuthority: true`, discovered ones are so when `authorityTier === 1`, and **every
   ACTIVE source here is tier 1**. So no suppressible copy can arise. The first draft of this suite
   asserted "the duplicate collapses to one finding" and failed — correctly, against correct code.

   The suite now asserts the half that actually protects a subject (a duplicate must not inflate
   the independence count), states the limitation in its own header, and carries a test that
   **fails the day a source below tier 1 is activated**, so the reasoning cannot expire silently.
   Suppression itself stays proved over constructed candidates in
   `packages/domain/test/clustering/assign.test.ts`.

2. **Releasing a kill switch is four-eyes in its own right.** `the person who suspended a source
   may not release it`. The first draft engaged and released with one credential; the release was
   refused with 403, the test's `finally` did not assert it, and the switch stayed engaged on a
   shared source record — so the *next* run failed at `engage` with `ALREADY_TERMINAL`, an error
   about the test's own leftovers. The suite now uses two distinct `source_admin` principals,
   asserts the release, and confirms `killSwitch` is null afterwards.

   The rule is right: a source switched off because it was harming somebody should not be switched
   back on by the one person who decided it was harmful.

### 6. Postman — folder 17

**`17 — Combined Live Acceptance: 9 indexed + 2 SEC discovery`**, 19 requests, armed by
`caConfirm = yes-contact-sec-and-indexed` (not folder 14's `liveConfirm`, not folder 15's
`mixedLiveConfirm`). Verified with newman against the running stack: **41 requests, 52 assertions,
0 failures**. Unarmed it stops after one request and fails loudly, contacting nobody.

It activates nothing and suspends nothing. 17.1 **fails if `gdelt-doc-v2` is ACTIVE**.

**It uses two subjects, and that is the honest part.** The indexed lists and the SEC feeds are
about different people — somebody on the OFAC SDN list is almost never a current SEC defendant. The
first draft used one subject, passed, and graded **zero** SEC findings. So the SEC half now has its
own subject (`caSecSubjectName`), and **17.18 fails rather than passing vacuously** when there is
nothing to grade. Set it from `pnpm sec:live-smoke --yes-contact-the-sec`, which makes one counted
request and prints the current entries.

### 7. Verified — exact commands and figures

```
pnpm lint                                              clean
pnpm typecheck                                         clean
vitest --project unit --project invariants --project evaluation    66 files, 1101 passed
vitest --project integration --project security                    22 files,  411 passed
pnpm test:e2e:api                                      34 passed — 5 consecutive clean runs,
                                                       plus one with a live `pnpm dev` worker up
COMBINED_LIVE_ACCEPTANCE=yes-contact-the-sec pnpm test:live:acceptance    11 passed
newman … --folder "17 - Combined Live Acceptance…"     41 requests, 52 assertions, 0 failures
```

SEC budget after everything: daily spend 30, breaker CLOSED, kill switch not engaged. GDELT daily
spend 0. No `-acceptance-copy` rows left in `indexedSourceRecords`; no four-eyes bypass events.

### 8. NOT done

- **`pnpm dev` still polls the shared `adverse-search-jobs` queue.** The isolation was built on the
  **test** side, which is where the user asked for it and where it belongs — the dev stack is
  behaving correctly for a dev stack. A future session may still want `pnpm dev` to take its own
  queue so two developers on one LocalStack do not consume each other's work.
- **Folder 15 (SEC + GDELT) was not re-run**, because GDELT stays suspended by instruction.
- **F3, the eight FR-07 validation rules, is still unwritten** — `grep validateAssertion` still
  returns nothing. It remains the next thing Phase F owes.
- **Subject-side identifiers are still always empty** and **discovery-side DOB/country/identifiers
  still come only from `identityAttributes`**, which the rule-based extractor returns empty. So a
  discovery finding still carries the name and nothing else, and lands AMBIGUOUS. Unchanged from
  the twenty-first entry, and still the honest outcome rather than a gap.

### 9. Next session should

1. Re-run the health check. If `pnpm test:e2e:api` is anything but 34/34, read §2 before assuming
   the pipeline broke — check whether `--no-file-parallelism` is still on the script.
2. Decide on GDELT: folder 15 and `gdelt-doc-v2` are ready to restore with
   `pnpm source:restore --apply --source gdelt-doc-v2`, and D18 already covers first contact. It
   was left suspended by instruction, not by a blocker.
3. Then **F3** — the eight FR-07 validation rules.

### 10. Decisions touched

None closed. **D6, D17, D18 unaffected.** The restore re-ran the SEC-05 rights clearance and
passed on the publisher's existing position; no new rights position was recorded and no
first-contact approval was created or copied.

---

## 2026-09-21 (twenty-first) — The discovery identity matcher is fixed and FR-10 clustering is in the runtime path

**The one-line state.** The subject-name-to-itself comparison is gone, the fabricated
`RARE_FULL_NAME_PLUS_CITY` factor is gone, the hardcoded `authorityTier: 2` is gone, both the
indexed and discovery paths now grade identity through **one** shared FR-08 resolver, and FR-10
clustering has a real runtime caller for the first time. Typecheck, lint, unit, invariants,
evaluation, integration and security are all green (1101 + 411). **The SEC sources were NOT
re-activated and no live search was run** — see §6.

---

### 1. What was wrong, and what replaced it

`pipeline/search-pipeline.service.ts` built its own Axis A input inline:

```ts
matchNameForms(normaliseName(subject.fullName),
               normaliseName(spans.length > 0 ? subject.fullName : ''))
```

The subject's name compared to **itself** — so any document carrying a mention span matched
`EXACT` whatever it said — followed by one hardcoded MODERATE `RARE_FULL_NAME_PLUS_CITY` factor
asserting a city check that ran on neither side. One moderate identifier is Axis A `PARTIAL`, and
`PARTIAL` is enough for `SUPPORTED`. A document that merely contained the subject's name became a
supported adverse finding, with a rationale describing evidence nobody had looked at.

Replaced by **`packages/domain/src/identity/evidence.ts`** — `resolveIdentityEvidence(subject,
document)`. Two structurally distinct input types, so the defect is no longer expressible: there
is no path through the module where the same string reaches both sides unless the document
genuinely contains it. It asserts a factor **only when both sides had a value and they were
compared** — absence produces no factor at all, not an `ABSENT` placeholder.

What it evaluates: exact/variant name, aliases (with origin), original-script names,
transliteration (via the existing port), DOB, year-only DOB, country/nationality,
company/association evidence, identifiers.

`RARE_FULL_NAME_PLUS_CITY` is **deliberately not implemented**. `subjectVersionSchema` carries
`countryContext` and no city, so there is no subject-side city to compare. A branch that can never
be true is how a fabricated factor comes back — the next reader assumes the check runs and stops
looking. The file says so explicitly.

Both callers now project into it: `indexed-source-search.service.ts` lost its private copy of the
factor logic (correct but duplicated — two implementations of one rule is how the wrong one
survives), and the discovery path builds its document side from **`text.slice(span.start,
span.end)`**, the document's own bytes at the extractor's offsets.

### 2. Two real defects found while doing it

1. **A year-only DOB agreement was asserted as `FULL_DOB`/STRONG.** `datesAgree` compared years
   when the *publisher* declared YEAR precision and then labelled the result a full date-of-birth
   agreement. OFAC publishes year-only dates for many listings (`Abu ABBAS`, `1948-01-01`,
   precision YEAR). So **any namesake born in the same year as a listed person reached
   `CORROBORATED` identity.** Now compared at the coarser of the two declared precisions: a year
   agreement is `DOB_YEAR_MONTH`/MODERATE, only a day-precision agreement is `FULL_DOB`/STRONG.
   The band for the OFAC case is still `SUPPORTED`, so nothing stops reaching a reviewer — the
   finding just no longer claims the full dates agree when only the years do.
2. **The subject's own DOB precision was ignored.** `datesAgree` took the subject date as a raw
   string and only consulted the *source* precision, so a subject declared at YEAR precision was
   compared as if it were a full date.

Also fixed: the indexed publication path matched subject names into feed text with a bare
`indexOf`, which puts "Ana" inside "Santana". Now word-bounded, matching what the discovery
extractor has always done.

### 3. Authority tier

`authorityTier: 2` was hardcoded at two points on the discovery path, so a tier-1 court document
and a tier-5 forum post banded identically and `assignBand` rule 4 (tier 5 ⇒ LEAD_ONLY) could
never fire. The tier now comes from `gate.sourceVersion.authorityTier` — the active approved
version the fetch gate authorised the request against — through `clampTier`, which maps an
out-of-range registry value to **5** rather than a permissive default: a configuration fault must
not resolve in the source's favour.

### 4. FR-10 clustering, wired

`decideClustering` and `computeAuthority` were both correct and `decideClustering` had **no
caller**; `computeAuthority` was called per finding with a hardcoded one-element array. Every
document in a run was its own independent corroboration.

- **`packages/domain/src/clustering/assign.ts`** — `assignClusters`, a run-level greedy
  assignment over the pairwise rules.
- **`packages/domain/src/clustering/near-duplicate.ts`** — SimHash over 5-word shingles.
  `ClusterCandidate.nearDuplicateKey` had been documented since the rules were written as
  "assigned by the provider layer" and **no provider ever assigned one**, so the
  `MERGE_SYNDICATION_FAMILY` branch was unreachable in production.
- **`SearchPipeline.clusterFindings`** — step 7 of `execute()`, over indexed **and** discovery
  findings together, because a syndicated copy of an SEC release is only recognisable as a copy
  if the release is in the same comparison.

The distinction that matters: **copies collapse, independent authorities cluster.** A copy
(identical document, identical canonical URL, or matching fingerprint) is removed from the result
and excluded from the independence count. An SEC action, DOJ prosecution, FCA warning and OFAC
designation about one event **each keep their own finding and each contribute their own
authority** — guarded by `isIndependentAuthority`, and asserted with a shared `contentHash` so the
strongest possible duplicate signal still does not fold an authority record away.

**The near-duplicate threshold is measured, not assumed.** The conventional 3-of-64 is for long
documents and rejected genuine syndication outright. Measured at real news-item length:

| pair | distance |
| :-- | --: |
| one story, syndicated with a new headline | 6 |
| one story, heavier edit plus house note | 9 |
| **different** action, identical publisher boilerplate | 21 |
| unrelated stories | 34 |

Threshold **12**, in the gap with margin both ways. All four figures are pinned as tests, so a
change to the hash, shingle width or token rules fails rather than silently moving the boundary
between "copy" and "independent report".

Indexed findings are **re-counted but not re-banded**: `IndexedSourceSearchService` bands by its
own narrow rule that never consults Axis D, so re-running `assignBand` there would mean this
method deciding something that service owns, from axis results it never produced. Their
`independenceCount` (a hardcoded `1`) is corrected and the correction is stated in the rationale.

### 5. Verified — exact commands

```
pnpm typecheck            clean
pnpm lint                 clean
pnpm test:unit + invariants + evaluation   66 files, 1101 passed   (was 66/1056 → +45 new)
pnpm test:integration + security           22 files,  411 passed
pnpm test:e2e:api         34 tests — see §7, blocked by a stale dev worker, not by code
```

New tests: `packages/domain/test/identity/evidence.test.ts` (25) and
`packages/domain/test/clustering/assign.test.ts` (20). They assert **bands**, not only factor
lists — a correct-looking factor list with a wrong band is exactly what shipped before.

### 6. NOT done

- **SEC was not re-activated.** `sec-litigation-releases` (v5) and `sec-press-releases` (v1) are
  still SUSPENDED, `gdelt-doc-v2` still SUSPENDED. No live search was run, so none of the live
  acceptance claims in the brief are proved.
- **No Postman work.** Folder 16 is untouched and still passing as of the twentieth entry; no new
  live acceptance flow was written.
- **Subject-side identifiers are always empty.** `subjectVersionSchema` has no identifier field,
  so `GOVERNMENT_OR_PASSPORT_ID` can never fire in production today. The resolver supports and
  tests it so the grading is right the day the schema gains one.
- **Document-side DOB/country/identifiers on the discovery path come only from
  `identityAttributes`,** and `RuleBasedExtractionAdapter` returns `[]` for it. So a discovery
  finding today has the name and nothing else — which is why it lands AMBIGUOUS. That is the
  honest outcome, not a gap to paper over: prose is not mined for a birth year, because a
  four-digit number near a name is not a date of birth.

### 7. The blocker the next session hits first

`pnpm test:e2e:api` fails **intermittently**, and not because of any code in this entry. A
**`pnpm dev` stack is running** (`apps/api/dist/main.js`, `apps/api/dist/worker-main.js`, started
13:21) holding **pre-refactor compiled code in memory**, in **LIVE mode** from `.env`
(`ADVERSE_SEARCH_MODE=live`), polling the **shared** `adverse-search-jobs` queue. It steals
messages from the mock-mode e2e suites; a live worker handed a fixture search refuses every source
and returns zero findings. Symptoms seen, all explained by this:

- `api-lifecycle` and `tenant-onboarding` fail with `expected 0 to be greater than 0`, and which
  one fails changes run to run;
- the run record shows `discovery SKIPPED — no approved source sits on the FR-05 discovery
  ladder`, which is correct for a **live** worker and wrong for the mock suite that submitted it;
- a finding came back carrying `'Publisher name matched as EXACT: …'`, a rationale string this
  session **deleted** — proof the code that produced it was the in-memory stale build.

Proved not to be this session's work by bypassing `clusterFindings` entirely and re-running: still
zero findings.

**First action next session: stop the `pnpm dev` stack (or restart it so it loads current code),
then re-run `pnpm test:e2e:api`.** The suite header of `indexed-adverse-search-e2e.test.ts`
already documents the shared-queue hazard; this is that hazard, with a long-running process rather
than a second suite as the other consumer. Worth considering giving `pnpm dev` its own queue for
the same reason the indexed e2e suite has one.

### 8. Next session should

1. Restart or stop `pnpm dev`; re-run `pnpm test:e2e:api` and confirm 34/34.
2. Then re-activate `sec-litigation-releases` and `sec-press-releases` through the four-eyes
   lifecycle (`pnpm source:onboard`), keeping `gdelt-doc-v2` suspended.
3. Run a real live search over the two SEC discovery sources plus the nine indexed sources and
   prove the six claims in the brief's §6.
4. Only then the Postman live acceptance flow, and only after that re-evaluate GDELT.

### 9. Decisions touched

None closed. **D7 unaffected** — the resolver takes the transliteration port as a parameter and
the discovery path passes none, so no model or ICU dependency was introduced.

---

## 2026-09-21 (twentieth) — The indexed adverse-search engine is real: nine sources ACTIVE, 33,544 records, searched locally, contacting nobody

**The one-line state.** Nine of the ten indexed sources are ACTIVE with real snapshots from their
real publishers; a tenant search answers from those snapshots and makes **zero** publisher
requests; snapshot growth is bounded; the retention sweeper runs; and Postman folder 16 proves all
of it in 135 assertions. The tenth source (`world-bank-debarred`) is APPROVED behind an evidenced
credential blocker, on purpose.

**Two decisions were taken by Faisal Ali (Source admin) during the session, and everything below
rests on them.** **D19** authorised first contact with nine publishers this project had never
called — read robots, read terms, verify the configured endpoint, one controlled initial refresh.
**D6** (open since the plan was written) was closed: a robots exception is a host-scoped record on
the approved version, usable only on the scheduled-artifact path.

---

### 1. What is now true at runtime

| Source id | v | State | Rows | Snapshot |
| :-- | :-- | :-- | --: | :-- |
| `ofac-sdn` | 2 | ACTIVE | 19,393 | `ofac-sdn:30c2a70887d694f7242254e9` |
| `uk-sanctions-list` | 2 | ACTIVE | 6,340 | `uk-sanctions-list:ca9f5e90f94b12a6994865a5` |
| `eu-consolidated-financial-sanctions` | 2 | ACTIVE | 6,234 | `eu-consolidated-financial-sanctions:0c83e632fea7709d9c75bdd1` |
| `unsc-consolidated` | 2 | ACTIVE | 1,011 | `unsc-consolidated:72c1897b5b3a55bfc01310a0` |
| `ofac-consolidated-non-sdn` | 2 | ACTIVE | 481 | `ofac-consolidated-non-sdn:1344d77c708ae327d9021e91` |
| `ftc-consumer-protection-press-releases` | 2 | ACTIVE | 30 | `...:99fab514507b5dc3bc3ad0e6` |
| `doj-fraud-enforcement` | 2 | ACTIVE | 25 | `...:849ecdd99facfe294ae15134` |
| `fca-warnings` | 2 | ACTIVE | 20 | `...:1de56810b21fb126e7251f2f` |
| `cftc-enforcement-press-releases` | 2 | ACTIVE | 10 | `...:12a735d7367f2ed93922e29f` |
| `world-bank-debarred` | 2 | **APPROVED** | 0 | none — blocked |

All ten reached v2: v1 was proposed and approved with the values as shipped, then real refreshes
disproved three of those values (see §4) and the corrections went through the lifecycle again.
Every version was proposed by `api-key:3944ab75080b3ebc` and approved by
`api-key:92206fac8c98f816` — two genuinely distinct principals.
**`DISABLE_SOURCE_FOUR_EYES_FOR_TESTING` is now `false` in `.env`** and
`db.auditEvents.countDocuments({action: 'source:four_eyes_bypassed_for_testing'})` is still `0`.

**Discovery is SUSPENDED.** `sec-litigation-releases` (v5), `sec-press-releases` (v1) and
`gdelt-doc-v2` (v1) were ACTIVE from earlier sessions and were suspended through the lifecycle,
with the reason recorded on the version: the discovery matcher at
`pipeline/search-pipeline.service.ts:1036` compares the subject's name **to itself** and can reach
`CONFIRMED` on a name alone. **Do not re-activate them before that is fixed.**

### 2. The repeatable path — this is the deliverable, not the data

`docs/sources/indexed-source-onboarding.md` is the document to read. Two new scripts:

- **`pnpm indexed:first-contact`** — one generalised evidence gatherer for all ten, four reads per
  source with a 4s per-host floor, writing `docs/sources/evidence/<sourceId>.json`. Records **no
  approval**.
- **`pnpm source:onboard`** — drives propose → SUBMIT → APPROVE → activate over the **public Admin
  API** with two distinct keys. Writes nothing to Mongo. **Idempotent by content**: an identical
  ACTIVE version is left alone, a half-finished one resumes from where it stopped, a changed
  reviewed value produces a new version. Refuses identical principals and refuses to run under the
  four-eyes bypass. A source whose evidence does not support activation stops at `APPROVED` with
  the blocker on the approval reason — there is no override flag.

### 3. D6, and why four sources needed it

OFAC (both lists) and the UN redirect their documented address to a **signed, one-hour
object-store URL**; the FCDO serves from a bucket directly. Those delivery hosts answer
`robots.txt` with **403**, which this service reads as `UNKNOWN` and refuses — correctly in
general, wrongly for a redirect the publisher itself issues to its own infrastructure for one
exact file.

The exception is `accessPolicy.robotsException` on the approved version, carrying approver, role,
date, decision, scope **and `deliveryHosts`**. It is matched **per host, not per source**: a hop to
any unnamed host takes the strict path and is refused even though the source carries an exception.
`assertAuthorised` refuses an exception naming no host; `readRobotsException` returns null for a
partial record; and `FetchGateService.robotsPositionFor` is told explicitly whether the caller is
the scheduled-artifact path, so query-time discovery can never use one.

### 4. Defects found by actually running it

Every one of these was invisible until a real publisher answered.

1. **`sourceRecordId`, `sourceSnapshotVersion`, `parserVersion` and `rawEvidenceHash` were dropped
   by the read path.** Stored on the finding, present in the contract, and simply never added to
   the field-by-field `document` mapper in `searches.service.ts`. Every indexed finding reached
   the API with `sourceRecordId: undefined`, so a reviewer had no way back to the publisher's row.
   **This is the one that would have failed an audit.**
2. **An exact name match could be crowded out of candidate retrieval.** `repository.search` ran
   one `$or` of name-key and token clauses under one `limit(250)`, filled in natural collection
   order. "Abu ABBAS" matched hundreds of records on tokens and its own exact SDN entry fell
   outside the cap — subject on the list, row in the index, **nothing returned**. Now two bounded
   queries, exact first.
3. **The UK list could never parse.** Its `<Names>` block sometimes opens with an empty
   `<Name><NameType>Primary Name</NameType></Name>`; the parser selected by label, got the empty
   carrier, and threw — failing the whole 21MB artifact over one publisher-side artefact.
4. **The UN list could never parse.** `INDIVIDUAL_DOCUMENT` entries carry a document type with no
   number; `requireText` made that fatal. Such an identifier is now dropped, which loses nothing a
   matcher could use.
5. **The FTC feed was refused as malformed.** fast-xml-parser's default `maxTotalExpansions: 1000`
   is a billion-laughs proxy — and billion laughs needs a DTD, which `parseXmlDocument` refuses
   before the library sees the text. 1,016 ordinary `&amp;` sequences tripped it. Raised, with the
   reasoning; `maxExpandedLength` still bounds the work.
6. **Free-tier budgets made a refresh impossible.** A refresh is not one request: robots, the
   artifact, and for some publishers the artifact again at the redirect. Budgets of 1–2/hour meant
   `HARD_BLOCK` before the first snapshot. Raised to 6/hour with daily figures matched to cadence.
7. **A row floor above the real list size.** `ofac-consolidated-non-sdn` was floored at 1,000
   against a list of **481**, so every correct parse was refused. Now 300, from measurement.
8. **The reviewed refresh policy was duplicated** in `app.module.ts` as call arguments. Correcting
   the floor on the version did nothing because the scheduler read its own copy — and the failure
   message said "the reviewed minimum" while quoting a number nobody had reviewed. Schedules now
   read `INDEXED_SOURCE_REFRESH_POLICIES`, derived from the registry templates.
9. **The EU endpoint was simply wrong.** The bare path answers `403`. The Commission's own
   open-data catalogue publishes a tokenised download URL; verified (HTTP 200, `application/xml`,
   6,234 entities) and corrected in the registry.

### 5. Storage and retention — both audit gaps closed

- **`IndexedSourceRepository.pruneSupersededSnapshots`.** Keeps the active snapshot and one
  previous; deletes older ones in bounded pages with a per-pass ceiling, reporting
  `complete: false` when it yields. The active snapshot is excluded **by version, not by
  ordering**. Called after every successful commit, outside the transaction, and never fails a
  refresh. The summary is written to the state record and surfaces as `lastPrune` on
  `GET /v1/admin/indexed-sources`.
- **`RetentionScheduler`** (new) drives `RetentionSweeper`, started by `worker-main.ts` beside
  `IndexedSourceScheduler`. Worker role only, one loop per process, drains up to 20 batches per
  tick, clean shutdown. `sweepOnce` had **no caller anywhere** before this.

### 6. The contract defect the audit flagged

`SANCTIONS_DESIGNATION` was emitted as a **free string**, and `category` was `z.string()` in the
contract — so no generated client could switch on it. Fixed as a closed enum rather than a second
product: `DESIGNATION_CATEGORIES` (`SANCTIONS_DESIGNATION`, `DEBARMENT_EXCLUSION`,
`REGULATORY_WARNING_LIST`) sits beside the seventeen FR-03 conduct categories, and
`FINDING_CATEGORIES` is their union. They are deliberately **not** three more `ADVERSE_CATEGORIES`:
those exist to be recognised in running text, carry lexicon terms in every enabled language, and
`activation.ts` refuses a taxonomy leaving one without terms. A designation is matched by name
against a list we already hold. Parsers now declare `listingCategory`, so the World Bank list is
`DEBARMENT_EXCLUSION` and the FCA warning list is `REGULATORY_WARNING_LIST` (it was
`CONSUMER_HARM_MISSELLING`, which asserted a mis-selling finding the FCA has not made).

`SourceCoverageOutcome` also gained `snapshotVersion`, `freshness` and `snapshotRowCount`, so
"searched and current", "searched but stale", "no snapshot" and "refresh failed" are four
distinguishable states for a program, not four shades of English prose.

### 6b. Last-known-good, proved against the running system

Not asserted from the code path — driven. `cftc-enforcement-press-releases` held a real snapshot
(10 records, `...:12a735d7367f2ed93922e29f`). The kill switch was engaged on it as a **controlled
injected failure** (no publisher response was faked), then a refresh was forced:

```
kind FAILED
  snapshot retained: cftc-enforcement-press-releases:12a735d7367f2ed93922e29f
  rows 10 | status FAILED | freshness CURRENT
  reason HARD_BLOCK: Suspended by api-key:92206... No request was made to this source.
```

A tenant search then ran against it and still answered from the snapshot:

```
CFTC outcome: PARTIAL | snapshot ...:12a735d7367f2ed93922e29f | fresh CURRENT | rows 10
  detail: Searched last-known-good snapshot ... (10 records). Latest refresh status: FAILED; ...
findingsState CONFIRMED_MATCHES_FOUND | coverage INCOMPLETE
  SUPPORTED | ofac-sdn | rec 2674 | snap ofac-sdn:30c2... | parser ofac-legacy-xml-1
```

So: the failure is recorded, the snapshot keeps answering, the outcome degrades to `PARTIAL` and
names why, coverage is `INCOMPLETE` rather than clean, and **another source's finding is
untouched**. The kill switch was then released — by the *other* principal, because release is
four-eyed too — and the next refresh returned `NOT_MODIFIED`, restoring health.

### 7. Verified — exact commands and counts

```
pnpm typecheck            clean
pnpm lint                 clean
pnpm format:check         FAILS — 61 files, pre-existing (measured on the tree with this
                          session's changes stashed). Files touched here were formatted.
pnpm test:unit            62 files, 1013 passed
pnpm test:invariants       1 file,    31 passed
pnpm test:evaluation       1 file,    12 passed
pnpm test:integration     14 files,  230 passed   (was 13/215)
pnpm test:security         8 files,  181 passed
pnpm test:e2e:api          3 files,   33 passed   (was 2/10)
                          ---------------------
                          total     1500 passed, 0 failed
```

Postman folder 16, against the running stack: **16 requests, 135 assertions, 0 failures, 2.4s**
(a second run showed 17/136 — 16.14 re-polls until the search settles, so the request count varies
by one).

Three suites were **fixed, not weakened**, and each fix is a real defect:

- `tests/e2e/api-lifecycle.test.ts` never set `FIXTURE_SERVER_URL`, so its fixture discovery found
  nothing. Its sibling's header has named this file as missing it since it was written.
- Both pre-existing e2e suites asserted `execution === 'SUCCEEDED'`, which encoded an assumption
  about the *environment* — that the registry holds only fixtures. `expectPipelineRan` now accepts
  `PARTIAL` **only** when every degraded source is an indexed one with no snapshot, and still
  refuses `FAILED`. That is strictly stronger than what it replaced.
- `tenant-onboarding` cleared the SIGNUP attempt bucket but not LOGIN, so a second run inside the
  window failed with a 429 about nothing under test. Both buckets, loopback only.
- `local-stack.test.ts` shelled out to the bootstrap inheriting `ADVERSE_SEARCH_MODE`, so an
  idempotence test began failing with a message about seeding once the stack went live. It now
  passes `mock` explicitly.

**A live-mode e2e suite must not share the job queue with mock-mode ones.** A live worker handed a
fixture search refuses every source and returns zero findings, failing the *other* suite.
`indexed-adverse-search-e2e.test.ts` creates and uses `adverse-search-jobs-indexed-e2e`. This cost
an hour to find; do not undo it.

### 8. Left half-done / not done

- **`world-bank-debarred` is APPROVED, not ACTIVE.** Needs `WORLD_BANK_SANCTIONS_API_KEY` **and**
  a robots position — `apigwext.worldbank.org/robots.txt` answers 403 from a WAF, so even with a
  key the gate refuses it. Both facts are on the version and in the evidence file.
- **`pnpm format:check` is red** (61 files, pre-existing). Not touched: reformatting 60 unrelated
  files would bury this session's diff. Worth a dedicated commit.
- **The discovery matcher is still broken.** Unchanged by instruction. The three discovery sources
  are suspended so it cannot reach a customer.
- **FR-10 clustering still has no runtime caller**, and `authorityTier` is still hardcoded on the
  discovery path. Both are audit findings 2 and 3 from the nineteenth entry, both on the discovery
  path, both out of scope here.
- **Budget spend is still not atomic** (audit finding 6). Untouched.

### 9. Next session should

Fix the **discovery identity matcher** — `pipeline/search-pipeline.service.ts:1036` — using
`indexed-source-search.service.ts:270-330` as the template, which does it correctly. Then
re-activate `sec-litigation-releases`, `sec-press-releases` and `gdelt-doc-v2` through the
lifecycle, and only then let folder 15 back into acceptance. Nothing about the indexed path needs
to change for that.

### 10. Decisions touched

**D6 — CLOSED** (2026-09-21, Faisal Ali, Source admin). Host-scoped robots exception on the
approved version; scheduled-artifact path only. Recorded in `docs/open-decisions.md`.
**D19 — new** (2026-09-21, Faisal Ali, Source admin). First contact with nine indexed publishers,
scoped to robots, terms, endpoint verification, one controlled refresh, and recording the result.
Recorded on every one of the ten versions as `accessPolicy.firstContactApproval`.

---

## 2026-09-21 (nineteenth) — Audit only: architecture/product audit of the adverse-search product

**Did.** No production code changed, no docs rewritten, no source activated, nothing contacted.
Full code-first audit (runtime path, sources, indexed ingestion, matching, classification, result
semantics, resilience, API, control plane) answering "can we offer our own adverse-search API
without buying sanctions.io adverse search". Findings delivered in-session; this entry is the
durable record.

**Verified.** `npx vitest run --project unit --project invariants` → **63 files, 1044 tests, all
passing, 8.46s**. (The eighteenth entry recorded 1013/62 — the tree has grown by 31 tests.)
Integration/e2e/security/live NOT run: Docker Desktop is not running on this machine. `.env` is
still `ADVERSE_SEARCH_MODE=mock`, `COMPANIES_HOUSE_API_KEY` and `WORLD_BANK_SANCTIONS_API_KEY`
empty.

**Found.** Six things that are not in any existing doc:

1. **The discovery-path identity matcher is degenerate.** `pipeline/search-pipeline.service.ts:1036`
   calls `matchNameForms(normaliseName(subject.fullName), normaliseName(subject.fullName or ''))`
   — the subject's name compared to **itself**. Spans present ⇒ always `EXACT`. It then asserts one
   hardcoded factor `RARE_FULL_NAME_PLUS_CITY` / MODERATE / CORROBORATING (`:1043`). Consequences:
   DOB, country, nationality, address, identifiers and aliases are never consulted on this path;
   axis A is always `PARTIAL`; `bands.ts:162` treats PARTIAL as sufficient for `SUPPORTED`; so a
   **name-only subject yields CONFIRMED_MATCHES_FOUND**. The only brake is the top-decile frequency
   penalty and no distribution is loaded, so it never fires. The served rationale claims a city
   check that never ran — the hardest thing to defend in an audit. NOT FIXED.
   The indexed path (`indexed-source-search.service.ts:270-330`) does this correctly and is the
   template to copy.
2. **`authorityTier: 2` is hardcoded** at `search-pipeline.service.ts:1116`, so tier-1 court
   documents and tier-5 blogs band identically and `canSupportFinding: false` for tier 5 is never
   enforced on the discovery path.
3. **FR-10 clustering has no runtime caller.** `packages/domain/src/clustering/rules.ts` is
   exercised only by its own unit tests; `computeAuthority` is called with a hardcoded
   single-element tier-2 array. Ten syndicated copies of one story are ten findings.
4. **`RetentionSweeper.sweepOnce()` has no caller anywhere.** It is wired as a provider
   (`app.module.ts:527`) and never started — `worker-main.ts` starts only `WorkerRuntime` and
   `IndexedSourceScheduler`. Retention actions are scheduled and never executed.
5. **Indexed snapshots are never pruned.** No `deleteMany` on `indexedSourceRecords`. Every
   content-changing refresh writes a full new snapshot and keeps the old one forever.
6. **Budget spend is not atomic.** `source-health.service.ts:167-176` is load → spendAccess →
   `$set` save. Concurrent replicas lose increments. Together with the process-local `RequestPacer`
   (`request-pacer.ts:147`, and `app.module.ts:868` does not even pass a pacer to `LadderBuilder`)
   and in-process `FixedFeedPollCache`, **two replicas violate a publisher's ceiling together**.
   For GDELT (`haltOnRateLimit: true` + `requiresFreshApprovalOnHalt: true`) that is a
   self-inflicted outage requiring a human to release.

Also confirmed, contradicting existing docs: `reserved.controller.ts:29` claims usage "counters are
recorded but not yet exposed" — **no counters are recorded anywhere**. And the eighteenth entry's
note that the SEC database records say `robotsPosition: HONOURED` is now moot: no database exists,
so a fresh deployment gets the code value `NOT_ESTABLISHED` and a refused source.

Confirmed healthy and worth not re-auditing: result/coverage semantics (`domain/coverage/
result-state.ts`) are correct on all five scenarios; `NO_MATCHES_FOUND` **cannot** coexist with an
AMBIGUOUS finding (`describeFindings` + `assertNoMatchIsHonest` + the read-path self-correction at
`searches.service.ts:778`). The indexed refresh lifecycle is genuinely production-shaped: DB lease
claim is cross-replica safe, validation is entirely pre-transaction, last-known-good is preserved,
stale-but-valid stays searchable. Tenant/search scoping has no contamination path.

**The source situation in one line.** Zero real sources are usable. All ten indexed sources (OFAC
SDN + non-SDN, UK, UN, EU, World Bank, DOJ, CFTC, FTC, FCA) have parser + schedule + search code
and **no registry row at all** — `scripts/bootstrap/seed-data.mjs` seeds only fixtures plus
google-news and bing-news as PROPOSED. Every real source ships `firstContactApproval: null` AND
`robotsPosition: 'NOT_ESTABLISHED'`, either of which the fetch gate refuses
(`fetch-gate.service.ts:373,380`).

**Left half-done.** Nothing started. This was audit-only by instruction.

**Next session should:** implement **P0-1 + P0-3** — register and activate the ten indexed sources
end to end (repeatable seeding path, real first-contact approvals, robots read and recorded through
the four-eyes lifecycle), and bound snapshot growth + start the retention sweeper. Leave `sec-*`,
`gdelt-doc-v2`, `google-news-*` and `bing-news-*` PROPOSED until the discovery matcher (finding 1)
is fixed — the indexed path has its own correct matching, so activating it does not expose the bug.
First contact itself is the user's to trigger.

**Decisions touched.** None closed. D7 (extraction model) still open and still blocked on a labelled
corpus. D12 unchanged. D-042/D-048 both confirmed as still-accurate descriptions of the code.

---

## 2026-09-21 (eighteenth) — Audit only: the four pure gates re-run clean, and every source is now in one catalogue

**Did.** No production code changed. Wrote
[`docs/sources/source-catalogue.md`](../sources/source-catalogue.md): all sixteen real sources plus
the eight fixtures, in five groups, each row carrying endpoint URL, credential requirement, the
recorded licence position, what the source actually yields, and which of the five go-live
preconditions it is still missing. Section 8 is the ordered work each blocked source needs.

**Verified.** On the tree as found, nothing started, no publisher contacted:

- `pnpm typecheck` — clean. `pnpm lint` — clean.
- `pnpm test:unit` — **1013 passed, 62 files**. `pnpm test:invariants` — **31 passed**.
  `pnpm test:evaluation` — **12 passed**. Identical to the seventeenth entry's numbers.
- **Nothing live was run.** Docker Desktop is not running, so no stack exists; and `.env` is
  `ADVERSE_SEARCH_MODE=mock` with `DISABLE_SOURCE_FOUR_EYES_FOR_TESTING=true`, which is a
  fixtures-only configuration. Folder 16 is still unrun and folder 15 is still owed.

**Found.**

1. **`COURTLISTENER_API_TOKEN` and `SEARXNG_URL` are in `.env` and read by nothing** — no grep hit
   anywhere in `apps/`, `packages/` or `scripts/`. SearXNG is in the compose stack but unwired. A
   credential slot with no consumer reads as coverage that does not exist. Either build the
   connector or delete the variable; recorded in catalogue §6, not acted on.
2. **The live `.env` cannot test any source.** Mock mode, four-eyes disabled, and
   `COMPANIES_HOUSE_API_KEY` / `WORLD_BANK_SANCTIONS_API_KEY` / `SEC_EDGAR_USER_AGENT` all empty.
   `FETCH_CONTACT_URL` and `OUTBOUND_USER_AGENT` are set. Going live is a deliberate `.env` change,
   not a flag someone will hit by accident — which is the intended shape, but it means "run folder
   15" is three steps, not one.
3. **The SEC registry templates in code still say `robotsPosition: 'NOT_ESTABLISHED'`** while the
   database records say `HONOURED`. That is correct and must stay: the `HONOURED` value was set on
   the draft by the person who read the evidence. A future session must not "fix" the code to match
   the database — doing so makes the next proposal assert a robots position nobody checked. Flagged
   in catalogue §1.

**Left half-done:** nothing started. The catalogue is complete as written.

**Next session should:** start Docker Desktop, `pnpm local:up && pnpm dev`, and run Postman folder
16 unarmed (16.1–16.4), pasting 16.1's table into this log — still the seventeenth entry's next
action, still undone.

**Decisions touched:** none.

---

## 2026-09-20 (seventeenth) — A source can be read on a schedule into a local snapshot; ten of them exist and none can call anyone

**Context this entry has to give first: the previous session ran out of budget mid-stream and
wrote no handoff.** Everything described below was found in the working tree, uncommitted, with
the last file written at 2026-09-18 23:27 and the last commit (`812b0d6`) at 22:04. This session
verified it, finished it and committed it. If something here reads as under-explained, that is
why — the intent was reconstructed from the code, the tests and the source contract, not from a
brief.

**Did.**

1. **A second source shape: the indexed source.** `apps/api/src/sources/indexed/` (13 files).
   A publisher's dataset is downloaded **whole** on its own reviewed cadence, parsed into
   `NormalizedSourceRecord`s, stored as a snapshot and searched in our own database. A search
   costs such a source **no publisher request at all**, so it answers at **cascade rung 0**,
   ahead of every query-time rung. `IndexedSourceScheduler` (a five-minute due check owning no
   cadence of its own), `IndexedSourceRefreshService` (the lifecycle, with a ten-minute database
   lease and an in-process promise map so two callers make one attempt),
   `ScheduledArtifactTransportAdapter`, `IndexedSourceRepository`, `IndexedSourceSearchService`.

2. **Ten sources proposed, in code, inert.** OFAC SDN and consolidated non-SDN, the UK Sanctions
   List, the UNSC consolidated list and the EU consolidated financial sanctions list
   (`INDEXED_BULK_XML`); the World Bank debarred-firms list (`INDEXED_BULK_JSON`); the DOJ, CFTC,
   FTC and FCA warning feeds (`INDEXED_RSS`). Every one carries `firstContactApproval: null` and
   `robotsPosition: NOT_ESTABLISHED`, and `indexed-source-config.test.ts` fails if that stops
   being true. **No bootstrap seeds any of them**, so none appears in `GET /v1/admin/sources`
   until a person proposes it through folder 11.

3. **Seven parsers**, all producing the one projection: OFAC XML (both lists share a parser
   version), UK Sanctions List XML, UNSC XML, EU XML, World Bank JSON, and a generic official-feed
   RSS parser instantiated four times with a per-regulator category and default stage. Every
   normalised field is nullable **because normalising must never turn an absence into an invented
   fact**, and the publisher's own fields survive untouched in `rawEvidence`.

4. **A refresh may fail; it may never make things worse (D-063).** Fetch and parse happen
   entirely before the transaction. Four checks stand between an artifact and `commitSnapshot`:
   2xx with a body, an accepted content type, a row count at or above the reviewed
   `minimumExpectedRows`, and present, unique `sourceRecordId`s. Any failure records refresh
   health and **keeps the last-known-good snapshot answering**, reported as `PARTIAL` with the
   reason attached. A `304` when we hold no snapshot is an error, not a no-op. An identical
   artifact hash is treated exactly like a `304`.

5. **A search never mistakes an empty shelf for an empty answer.** `IndexedSourceSearchService`
   emits a rung-0 outcome per source whether or not the ladder ran: `FAILED` with no usable
   snapshot, `PARTIAL` when stale or when the last refresh failed, `COMPLETED` otherwise — and
   the detail line always names the snapshot version and the row count it actually read.

6. **Provenance on the finding.** `sourceRecordId`, `sourceSnapshotVersion`, `parserVersion` and
   `rawEvidenceHash` are now optional fields on the finding document, present for snapshot
   records and absent for fetched pages, so a reviewer can name the row of the published list a
   match came from.

7. **A separate fetch-gate entrance for scheduled artifacts (D-065).** A refresh has no tenant,
   subject or taxonomy, and inventing them to pass the document gate would put false provenance on
   every refresh. `authoriseScheduledArtifact` relaxes **nothing** source-level: address policy,
   ACTIVE version, the exact recorded endpoint URL, unexpired licence terms, a named first-contact
   approval, an established robots position, an attributable egress identity.

8. **`jurisdictionScope` (D-064).** The gate refused any source whose `countries` did not include
   the subject's jurisdiction, which no global list can satisfy honestly. Source content now
   carries `NAMED_COUNTRIES` (the default, and the behaviour that existed) or `GLOBAL`, and the
   contract makes them mutually exclusive: `NAMED_COUNTRIES` with no countries is rejected, and so
   is `GLOBAL` that also names some. `jurisdictionScope` and `refreshPolicy` joined
   `LOAD_BEARING_SOURCE_FIELDS`, so changing either needs a fresh four-eyes approval.

9. **A publisher secret is supplied at fetch time, never stored on the version.**
   `requestHeaders` rides the first hop only, and `HttpEvidenceFetchAdapter` throws on any
   caller-supplied header it manages itself (`host`, `user-agent`, `if-none-match`,
   `if-modified-since`). `WORLD_BANK_SANCTIONS_API_KEY` is the one new environment variable; blank
   leaves that source configured and mechanically unable to call the API.

10. **Two admin routes.** `GET /v1/admin/indexed-sources` (`platform:read_health`, `admin:read`)
    reports usability, freshness, row counts and the last failure per source.
    `POST /v1/admin/indexed-sources/{sourceId}/refresh` (`source:approve`, `admin:write`) runs one
    refresh now and **additionally requires the header `X-Allow-Publisher-Contact: true`** — not
    authentication, which the key already carries, but a deliberate act, so a publisher's whole
    dataset is never downloaded by a request someone sent to see what it returned.

11. **This session's own work, on top of the above:** fixed the 15 lint errors the previous
    session left (all in the two new test files plus one async factory in `app.module.ts`);
    **Postman folder 16 — Admin: indexed sources (local snapshots)**, six requests; three new
    environment variables in all four environment files; and the documentation below.

**Verified.**

- `pnpm typecheck` — clean. `pnpm lint` — **clean** (was 15 errors).
- `pnpm test:unit` — **1013 passed, 62 files** (was 994/56 at the sixteenth entry).
- `pnpm test:invariants` — 31 passed. `pnpm test:evaluation` — 12 passed.
- `pnpm openapi:generate` — regenerates `openapi/openapi.json` byte-identically to what was in the
  tree, so the committed document matches the contracts.
- **Postman folder 16 has NOT been run against a live stack by this session.** No stack was
  started and no publisher was contacted. See below.

**Left half-done.**

- **Folder 16 is unrun.** It needs `pnpm local:up && pnpm dev`, then:

  ```
  pnpm dlx newman@6 run postman/adverse-search-service-full.postman_collection.json \
    -e postman/local.ready.postman_environment.json \
    --folder "16 - Admin: indexed sources (local snapshots)"
  ```

  Unarmed, 16.4 halts the folder before 16.5, so 16.1–16.4 are the run. Expect 16.1 to list ten
  sources with `snapshotUsable: false` — no source has ever refreshed. Arming
  `indexedRefreshConfirm` and running 16.5 against a source with no ACTIVE version is still safe:
  the gate refuses before a socket opens, and that refusal is the assertion.

- **The live folder-15 run from the sixteenth entry is still owed**, and is unaffected by any of
  this.

- **No snapshot has ever been built**, so the search path over real records has only been
  exercised against test doubles (`indexed-source-search.test.ts`). The parsers have been
  exercised against fixtures, not against a publisher's actual file, and a real OFAC SDN download
  is the first thing that will tell us whether `minimumExpectedRows` and the accepted content
  types were set sensibly.

**Found.**

- **The previous session left the work uncommitted and unhandoffed, and the state was recoverable
  only because the tests it wrote were complete.** `typecheck` and all three pure suites passed on
  the tree as found; only lint failed. That is the argument for the handoff rule, not against it:
  the code survived, the *reasoning* did not, and this entry had to be reconstructed.
- **`edit11.py` is a leftover from the fifteenth/sixteenth session** — a throwaway script that
  rewrote Postman folder 11 from "SEC go-live" to a generic "Source go-live". Its edit is already
  in the committed collection. Deleted.
- **Nothing seeds the ten proposals into the registry.** Whether that stays true is a real
  decision, not an oversight to be tidied away: a seeded proposal is one approval away from being
  live, and the current design keeps the code and the decision to call a publisher separate
  events. If a future session adds seeding, it must not also add an approval.

**Next session should:** start the local stack and run Postman folder 16 unarmed
(16.1–16.4), and paste 16.1's table into this log — that is the first check that the ten schedules
register and report state at all. Then pick **one** source for a real first contact, most sensibly
`ofac-sdn`, and walk it through the go-live runbook.

**Decisions touched:** **D-062**, **D-063**, **D-064** and **D-065** opened and closed.

---

## 2026-09-18 (sixteenth) — A failed source no longer discards another source's findings; the no-match claim is now checked, not just worded

**Did.**

1. **`sourceOutcomes` became one entry per source.** Discovery walks the ladder once per planned
   query, and the old de-duplication keyed on `rung:sourceId:outcome`, so a source that answered
   forty queries and was rate-limited on the forty-first appeared **twice** — once `COMPLETED`,
   once `FAILED`. Every consumer had to pick one, and neither was true.
   `mergeSourceCoverageOutcomes` (`packages/domain/src/planning/cascade.ts`) collapses per
   `(sourceId, cascadeRung)` and answers `PARTIAL`, which `aggregateRun` counts **both** as a
   source that answered and as a coverage gap. `SearchPipeline.discover` now calls it.

2. **The findings state stopped being computed from two bands out of six.**
   `supportedFindingCount` counted only `CORROBORATED`/`SUPPORTED`, so a run whose only result
   was an `AMBIGUOUS` finding reported `NO_MATCHES_FOUND` while serving that finding from
   `/findings`. `FINDINGS_STATES` now distinguishes `CONFIRMED_MATCHES_FOUND`,
   `AMBIGUOUS_MATCHES_FOUND` and `NO_MATCHES_FOUND`; `POTENTIAL_MATCHES` stays **readable only**,
   for runs stored before the change, and is never newly produced.

3. **`findingCounts` is published** (`confirmed`, `ambiguous`, `other`, `total`,
   `unresolvedLeads`) on the search summary and the findings page, so a client never infers
   "is there anything to look at?" from a state name. Written by the job handler, and
   **recomputed from the stored findings on read** — the findings are the evidence.

4. **`failureClass` rides on every coverage outcome.** Carried from the FR-06 table through
   `RungAttempt` to the wire, so `gdelt-doc-v2 = SKIPPED` can also say `RATE_LIMITED`. Null for
   every refusal we imposed on ourselves (kill switch, licence, inactive version, spent budget) —
   see D-061 for why that null is load-bearing. `SourceAccessDecision` gained the same field and
   fills it only for `BREAKER_OPEN`.

5. **I10 now checks the claim, not only its wording.** It used to verify that a no-match
   *statement* named its coverage and its failed sources, and never asked whether the run was
   entitled to say "no matches" at all — so the contradicting run passed the gate.
   `NoMatchRunSample` gained `findingCount` and `unresolvedLeadCount`; a non-zero either refuses.
   `assertNoMatchIsHonest` is the single definition, and `SearchesService.findingsFor` runs it
   before serving, correcting the pair in favour of the evidence and logging it as a defect.

6. **`SearchPipeline.discover` no longer dies with the ladder.** A throw from `ladder.build()`
   used to take the run down and discard the association-graph outcome already recorded. It is
   now a `SKIPPED` outcome with the reason.

7. **New suite: `apps/api/test/partial-results.test.ts`** — 13 tests over the **real**
   `LadderBuilder`, `CascadeService`, merge and `aggregateRun`, with only the socket doubled.
   Covers all five required regressions plus T47 and the fixed-feed subtlety below.

8. **Postman:** the partial-result block was added to `4 - Results / Findings and coverage`,
   `14.10` and `15.12`. It asserts `findingCounts` against `findings.length`, refuses
   `NO_MATCHES_FOUND` over a non-empty list, and — when a run has both an answering and a failing
   source — asserts `PARTIAL`/`INCOMPLETE`, that every answering source is still reported, that
   the failure names its reason, that it did not put a `failureClass` on a healthy source, and
   that findings from an answering source keep band, provenance, attribution and source.

**Verified.**

- `pnpm test:unit` — **994 passed, 56 files** (was 981/55).
- `pnpm test:invariants` — **31 passed** (was 29; two are the new I10 refusals).
- `pnpm test:evaluation` — 12 passed.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm openapi:generate` — all clean.
- **The live Postman run has NOT been done by this session.** See below.

**Left half-done.**

**The live folder-15 run.** The stack running at the time (`pnpm dev:live`, started 20:32) was
serving pre-change code from `apps/api/dist`, which was rebuilt at 21:26 but not reloaded. The
run needs: restart `pnpm dev:live`, then

```
pnpm dlx newman@6 run postman/adverse-search-service-full.postman_collection.json \
  -e postman/live.ready.postman_environment.json \
  --folder "15 - Mixed Live E2E: SEC + GDELT" \
  --timeout-request 180000 --timeout-script 900000 --timeout 1500000
```

`mixedLiveConfirm` is already `yes-contact-sec-and-gdelt` in `live.ready`. Note
`mixedGdeltHourlyBudget` is **empty** in that environment, so 15.12's budget-ceiling assertion is
skipped; set it to `24` to exercise it.

**Found.**

- **A fixed feed answers `noResults` for every FR-04 family but F1 without opening a socket.**
  Those are real answers, so a totally unreachable SEC feed comes out `PARTIAL`, not `FAILED`, on
  a full plan. That is correct — the source did tell the run something — and it cost a first
  attempt at the T47 regression test, which had assumed `FAILED`. The suite now narrows that one
  case to F1 queries and asserts the `PARTIAL` behaviour separately rather than leaving it as a
  trap.
- **A cancelled run that found nothing must stay `NOT_EVALUATED`.** Routing cancellation through
  the new count-based mapping made it `NO_MATCHES_FOUND`, which claims a finished search. Caught
  by the existing domain test; the cancelled branch now maps only when findings exist.
- **`postman/adverse-search-service.postman_collection.json` was reformatted and then restored to
  HEAD** by this session. It is the demo subset the README marks "not kept up to date", but if it
  held uncommitted work before 2026-09-18 21:32, that work is gone.

**Next session should:** restart `pnpm dev:live` and run the newman command above, then paste
15.12's `PARTIAL-RESULT SUMMARY` line into this log. If every source answers, the partial path is
not exercised — the block says so in the console rather than passing vacuously.

**Decisions touched:** **D-061** opened and closed (a source failure narrows what a run may claim;
it never subtracts from what it found).

---

## 2026-09-18 (fifteenth) — Three sources ACTIVE; a recorded ceiling made real; GDELT reached, then refused

**Did.**

1. **Gathered the evidence, live, that the two new sources needed.** Two new hard-coded scripts,
   siblings of `first-contact.mjs` rather than parameters on it:
   `scripts/sec-press-first-contact.mjs` (`pnpm sec:press-contact`) and
   `scripts/gdelt-first-contact.mjs` (`pnpm gdelt:first-contact`).

   - `www.sec.gov/robots.txt` re-read (HTTP 200, 916B) and evaluated for `/news/pressreleases.rss`:
     **ALLOWED**. The feed loaded: HTTP 200, `application/rss+xml`, 25 items. The 2026-09-16
     evidence names the _litigation_ path, so it was re-read rather than re-interpreted. Recorded
     in `docs/sources/sec-press-robots-evidence.json`.
   - **First contact with GDELT**, the second publisher this project has ever called.
     `api.gdeltproject.org/robots.txt` returned **HTTP 404**, recorded as _absent_ (RFC 9309 full
     allowance) rather than as a file that was read. `gdeltproject.org/robots.txt` returned 200
     with `Disallow: /data/` only. Terms read at `gdeltproject.org/about.html` (Last-Modified
     2022-09-03, sha256 `384754b5…`). Endpoint verified: HTTP 200 `application/json`. Recorded in
     `docs/sources/gdelt-evidence.json`.

2. **All three sources are ACTIVE**, read back from `GET /v1/admin/sources`:

   | Source                    | Version | Connector              | Endpoint kind | Rung | proposedBy / approvedBy                 |
   | :------------------------ | :------ | :--------------------- | :------------ | :--- | :-------------------------------------- |
   | `sec-litigation-releases` | **v5**  | `NEWS_DISCOVERY_RSS`   | `FIXED_FEED`  | 1    | `4f93491691d8c22e` / `b6966983c269badd` |
   | `sec-press-releases`      | **v1**  | `NEWS_DISCOVERY_RSS`   | `FIXED_FEED`  | 1    | `4f93491691d8c22e` / `b49936006e34f1ae` |
   | `gdelt-doc-v2`            | **v1**  | `NEWS_DISCOVERY_GDELT` | `QUERY_FEED`  | 3    | `4f93491691d8c22e` / `b49936006e34f1ae` |

   Both new versions are stamped `mode: LIVE`, carry `robotsPosition: HONOURED`, a rights clearance
   of `ALLOW`, and `queryParam: query` on GDELT. **Four eyes was satisfied genuinely** — proposer is
   not the approver on either — and
   `db.auditEvents.countDocuments({action: 'source:four_eyes_bypassed_for_testing'})` is **0**.

3. **`DISABLE_SOURCE_FOUR_EYES_FOR_TESTING`**, added on request, and in the end **not needed**.
   Default false; **setting it in production fails startup** (`config.ts`, beside the T09 checks).
   It forgives an identity and nothing else: the permission checks, the reason requirement, the
   FR-05 conformance check and the SEC-05 rights clearance are untouched, and it does not apply to
   `TAXONOMY` or `POLICY`. Every approval taken under it is marked twice and permanently — in the
   version's own history reason, and as its own audit action
   `source:four_eyes_bypassed_for_testing`. Tests:
   `tests/integration/four-eyes-testing-bypass.test.ts` (9) and
   `apps/api/test/four-eyes-flag-config.test.ts` (6).

4. **D18 — and a number collision that had to be resolved.** GDELT first contact is **D18**,
   approved by Faisal Ali, Source admin, 2026-09-18. D17 covers `www.sec.gov` only and was not
   copied into it. **D18 was already taken** by "adopt `fast-xml-parser` v5" (opened 2026-09-15 by
   D-039); that item is **now D19**. The engineering question is the one that moved, because it is
   referenced only in narrative, whereas the GDELT approval is recorded inside an activated source
   version and an append-only audit log. `docs/open-decisions.md` carries a note so that handoff
   entries dated on or before 2026-09-15 saying "D18" stay interpretable.

5. **`requestCeilingPerSecond` was recorded on every source since FR-05 and enforced nowhere.** Not
   a theory — `grep` found it only in registry records and contracts. It did not matter while every
   live source was a `FIXED_FEED`; it matters immediately for a `QUERY_FEED` dispatched from a loop
   with no gap in it. `apps/api/src/sources/request-pacer.ts` now enforces it, **inside
   `HttpEvidenceFetchAdapter`, keyed on the host**, for every outbound request — the document
   fetch, each redirect hop, and the robots.txt read before them. Driven from the approved version
   through the new `FetchAuthorisation.requestCeilingPerSecond`, never from a constant.

   **GDELT publishes the number in the body of its own 429** — "one every 5 seconds" — so the
   template's `requestCeilingPerSecond: null` ("they publish no numeric ceiling") was false, and the
   approved version records `0.2`.

6. **Two robots defects, both found by the live run, both fixed.**

   - **An unreadable robots.txt was cached for the full 24-hour TTL.** One transient 429 on
     `api.gdeltproject.org/robots.txt` therefore refused that publisher for the rest of the run.
     Only a **known** answer is cached now; a 404 is a known answer (the site restricted nothing)
     and is cached like any other. The branch fifteen lines above already declined to cache a
     budget refusal for exactly this reason.
   - **The robots read and the document fetch paced on different keys**, so two requests left with
     no gap between them — which is _how_ the 429 happened. One host key now.

7. **`requestsIssued` was counting attempts, not requests.** The GDELT connector recorded the
   attempt _before_ calling `fetch`, so a run in which every query was refused by a domain cooldown
   reported **53 requests issued against a budget of 24** to a publisher that had seen none of them.
   It now records after the fetch returns, with `issued: false` for a refusal before the socket —
   which is what `servedWithoutRequest` has always been documented to mean.

8. **Postman.** Folder 15 had two defects that stopped it before any live traffic: 15.9 sent
   `registrationNumber: null` into a `.strict()` schema requiring a non-empty string (400), and 15.5
   asserted a `tenantId` that `issuedApiKeySchema` does not carry. Both fixed; a new
   `mixedCompanyNumber` variable was added to all four environments. Poll cap 90 → **400**, because
   a paced GDELT run is minutes long. `adminKey` in `live.ready` was a `tenant_admin`/`analyst` key
   — authenticated but **not permitted** to read the source registry — so 15.6 got a 403 and
   reported "a required source is not ACTIVE", which is misleading; it is now a `source_admin` key.

**Verified.** unit **981** (was 960), invariants 29, security 181, evaluation 12, integration 224,
e2e-api 26, lint clean, format clean, collection and all four environments parse. New suites:
`request-pacing.test.ts` (13), `four-eyes-flag-config.test.ts` (6),
`four-eyes-testing-bypass.test.ts` (9), plus two robots regressions in
`http-evidence-fetch.test.ts`.

**Found — GDELT is refusing this egress address, and pacing did not fix it.** Folder 15 ran LIVE end
to end (2m58s, 181 assertions, 5 failures, all five about GDELT counts). Both SEC feeds worked:
`requestsIssued: 1` and `distinctEndpoints: 1` each, `www.sec.gov` reached. GDELT got **one**
request away and was then 429'd, which engaged the kill switch and a 600-second domain cooldown, so
the remaining 16 planned queries were recorded as `servedWithoutRequest`.

A controlled probe from cold settles what pacing can and cannot do here: request #0 returned **HTTP
200**; request #1, **25 seconds later**, returned **429**; #2 likewise. Their stated ceiling is one
every five seconds and a twenty-five-second gap was refused, so this is a longer-lived per-IP
penalty — most plausibly earned by the unpaced bursts earlier in the day, before defect 6 was fixed.
Hourly spend reached 18/24 largely on 429s, which count.

**Left half-done: the GDELT fan-out has never been observed live.** `requestsIssued > 1`,
`distinctEndpoints === requestsIssued`, and F1/F3/F4 reaching the wire are still unproven **against
the live publisher**. They are proven against an injected fetch port in `mixed-live-sources.test.ts`
and `request-pacing.test.ts`, which is a different claim and should not be reported as the same one.

**Next session should:** run folder 15 once, at the top of an hour, after a long GDELT-silent
period, and read `liveDiscovery` before anything else. If GDELT still 429s a single request, then
the approved `0.2` is not the operative limit for this address, and the honest next step is a **v2
of `gdelt-doc-v2` through the lifecycle** with a lower ceiling — not a code change, and not a retry
loop. Do not raise the 24/hour budget to compensate: a 429 spends budget, so a larger budget buys
more refusals.

**Decisions touched:** **D18 closed** (GDELT first contact). **D19** is the renumbered
`fast-xml-parser` question. D17 unchanged and still about `www.sec.gov` only.

---

## 2026-09-18 (fourteenth) — Folder 11 made generic; proposal payloads prepared; nothing proposed

**Did.** No governance action was taken. Nothing was written to Mongo, no source version was
proposed, approved or activated, and folder 15 was not run. What changed is Postman and its docs.

`postman/adverse-search-service-full.postman_collection.json`, folder 11:

- Renamed `11 - SEC go-live (four eyes)` → `11 - Source go-live (four eyes)`.
- All four requests had `sec-litigation-releases` hard-coded in the path. They now use
  `{{recordId}}`, `{{recordVersion}}` and `{{recordRevision}}` — the same three variables folder 5
  already uses, so **no new variable was introduced for the path** and the environments' existing
  defaults (`sec-litigation-releases` / `5` / `2`) keep the SEC behaviour byte-for-byte. The
  now-unused `{{secVersion}}` / `{{secRevision}}` are gone from the collection; the env keys are
  left in place, harmless.
- The APPROVE reason no longer hard-codes the SEC's robots evidence. Sending
  "robots.txt read live on 2026-09-16 … docs/sources/sec-robots-evidence.json" while approving
  GDELT would have been a fabricated attestation. It is now
  `Approved by {{approverName}}, {{approverRole}}, for source {{recordId}} v{{recordVersion}}.
{{approvalEvidenceNote}}`, and the pre-request script refuses a blank or `CHANGE ME`
  `approvalEvidenceNote` the same way it already refuses a placeholder approver name.
- **No source-specific request was added.** Propose / edit-draft / submit stay in folder 5, whose
  bodies are data the operator pastes.

`approvalEvidenceNote` added (value `CHANGE ME …`) to all four
`postman/*.postman_environment.json`. `postman/README.md`, `postman/SEC-GO-LIVE.md` and
`postman/ADVERSE-SEARCH-WALKTHROUGH.md` updated to the new folder name and variables.

Ready-to-use propose payloads written to the session scratchpad (not committed), with every
missing human decision left as an obvious `<HUMAN_…>` placeholder rather than a plausible value:
`propose-sec-press-releases.json` (two placeholders) and `propose-gdelt-doc-v2.json` (nine).

**Verified.** Collection and all four environment files re-parse as JSON; folder count still 16;
zero remaining `secVersion` references; the 18 remaining `sec-litigation-releases` strings are all
in folders 5, 8, 14 and 15, where they belong. Both payload files parse. No test suite was run —
nothing outside `postman/` and `docs/` was touched, and no test reads those files (`grep` for
`postman_collection` under `tests/`, `apps/api/test/` and `scripts/` returns nothing).

**Left half-done: nothing.** The two proposals are still unproposed, deliberately.

**Found — the activation rule, read from the code rather than assumed.** `VersionedRecordService`
never calls `canApprove` on the activation path: `activate()` authorises only
`this.authorise(kind, principal, definition.approve)`, and `ruleFor` marks both `BEGIN_ACTIVATION`
and `COMPLETE_ACTIVATION` `requiresFourEyes: false`. So **activation may be performed by the
approver, by the proposer, or by any third principal — the only requirement is `source:approve`,
the `admin:write` scope and a tenant context for the audit entry.** Four eyes binds `APPROVE` and
`REQUEST_CHANGES` only, and it binds on `principal.subject`, not on role. Folder 11 sends activate
on `{{approverKey}}`; that is a convention, not an enforced rule.

**Found — `licenceTermsVersion: 'UNVERIFIED'` is not refused by anything.** The fetch gate checks
`licenceTermsVersion === null` (`LICENCE_TERMS_NOT_RECORDED`) and `licenceExpiresAt` in the past
(`LICENCE_EXPIRED`). The literal string `UNVERIFIED` is neither, and no gate greps for it. GDELT is
stopped by `NO_FIRST_CONTACT_APPROVAL` and `ROBOTS_POSITION_NOT_ESTABLISHED`, not by its unread
terms. If somebody ever records a first-contact approval and a robots position while leaving
`UNVERIFIED` in place, the source would fetch. Not fixed here — it is a one-line refusal in
`fetch-gate.service.ts` but it is a new gate, and this session was scoped to not change gates.

**Found — the SEC press-releases endpoint has never been loaded either.**
`docs/sources/first-live-contact.md` records exactly two SEC URLs ever requested:
`https://www.sec.gov/robots.txt` and the litigation feed. `https://www.sec.gov/news/pressreleases.rss`
is not among them. `mixed-live-go-live.md` lists endpoint verification as a GDELT act only. It is
the same act for this feed; nothing in code enforces it, so it is a checklist gap rather than a
blocker.

**Next session should:** not propose anything until the two SEC placeholders are filled by a
person. The first concrete action is unchanged from the thirteenth entry — someone reads the
recorded body in `docs/sources/sec-robots-evidence.json` against `/news/pressreleases.rss` and
states the position — and the second is adding endpoint verification of
`https://www.sec.gov/news/pressreleases.rss` to `mixed-live-go-live.md` section A.

**Decisions touched:** none closed. D17 remains about `www.sec.gov` only; GDELT still needs its own
first-contact decision, its own approver and its own date.

---

## 2026-09-18 (thirteenth) — Folder 15 not run: both new sources still have no registry version

**Did.** No code changed. This session was a verification pass over the twelfth session's claim,
plus a full regression re-run, plus a reading of the registry through the live admin API rather
than from the handoff log.

HEAD is `7a82a9a`, working tree clean, nothing material changed since the previous report.

**Verified — the registry, read over HTTP, not from Mongo and not from the log.**
`GET /v1/admin/sources?limit=200` with `proposerKey` against the running API:

```
sec-litigation-releases  v1-v4 AWAITING_APPROVAL, v5 ACTIVE
                         NEWS_DISCOVERY_RSS | FIXED_FEED | rung 1 | tier 1 | queryParam null
                         robots HONOURED | licence sec-fair-access-2026-09-15 | 120/hour
                         firstContactApproval Faisal Ali / Source admin / 2026-09-15 / D17
                         proposedBy api-key:4f93491691d8c22e
                         approvedBy  api-key:b6966983c269badd   (four eyes, distinct)
sec-press-releases       NO VERSION OF ANY STATUS EXISTS
gdelt-doc-v2             NO VERSION OF ANY STATUS EXISTS
```

Neither new source is even `PROPOSED`. Folder 15 halts at 15.6, as designed.

Health, read with `pnpm source:health` and from `domainHealth`:

```
sec-litigation-releases  breaker CLOSED, 0 consecutive failures, last success 2026-09-17,
                         hourly 3, daily 7, kill switch not engaged
sec-press-releases       no health record - never called
gdelt-doc-v2             no health record - never called
domainHealth sec.gov                 CLOSED, lastFailureAt null, last success 2026-09-17
domainHealth api.gdeltproject.org    NO RECORD - never contacted
```

Both breakers therefore permit execution. Nothing was reset and nothing was bypassed.

**Verified — regression, all of it re-run on 2026-09-18.**

```
lint clean | typecheck clean | format:check clean
unit            960 passed (53 files)      invariants  29 passed
evaluation       12 passed                 security   181 passed
e2e (API)        26 passed                 integration 215 passed (see the flake below)
focused: mixed-live-sources 19, live-source-proposals 24,
         discovery-rungs + fixed-feed-amplification + sec-source-config 31
postman collection  16 folders, 93 requests, 68 scripts, 0 parse errors, schema v2.1.0
newman folder 13    12 requests, 28 assertions, 0 failed
newman folder 14    halted at 14.0, 1 request, no SEC contact
newman folder 15    halted at 15.0, 1 request, no SEC and no GDELT contact
folder 14 is byte-identical between HEAD~1 and HEAD (compared as parsed JSON)
```

**Found — 1: a pre-existing order-dependent flake in the outbox integration tests.** Five runs of
`pnpm test:integration`: three at 215/215, two with one failure each, and **a different test each
time** — `transactions.test.ts > leaves a failed publication in the outbox and backs it off`, then
`persistence.test.ts > counts committed-but-unpublished events (FI-04)`. Both pass in isolation.

The cause is that both reach past their own tenant. `outbox.countUnpublished(now)` is a global
count, and FI-04 samples it, appends one event and asserts `after === before + 1`. `OutboxPublisher`
likewise drains every pending event, not the calling tenant's, so `queue.failNextPublish` — which
fails only the _next_ publish — can be spent on another file's event, leaving the event under test
published and `attempt` at 0. Vitest runs the integration files concurrently against one Mongo, so
whichever file is mid-flight decides it.

**This is not a regression from the SEC/GDELT work.** Neither file was touched by `7a82a9a`; they
were last changed at `139e956` and `646ba90`. Left unfixed deliberately — the fix is tenant-scoping
those two assertions, which is test-isolation work outside this task's scope.

**Found — 2: `mixed-live-go-live.md` is missing a prerequisite, and it is the one that would fail
at the last step.** The runbook lists four human acts for GDELT (robots, terms, endpoint,
first-contact approval) and none for the rights artifacts. But `VersionedRecordService.clear()`
returns `verdict: DENY, policyId: 'none'` when `rightsPolicy` or `dataProfile` is null, and
`activate` sends the version back to `APPROVED` on a DENY. So a GDELT version proposed with content
alone would pass propose and approve and then be **refused at activation**, after both people had
signed.

`sec-litigation-releases` v5 carries both (`policyId: sec-fair-access-2026-09-15`, classification
`PUBLIC_RECORD`, collectionMethod `PUBLISHED_FEED`, region `eu-west-2`, 30-day retention, no raw
personal data). `sec-press-releases` can reuse them verbatim — same publisher, same policy page,
same licence version the record already reuses. **GDELT has no rights policy anywhere in the
repository**, and one cannot be derived from the SEC's: a different publisher, different terms, and
`PUBLISHED_API` rather than `PUBLISHED_FEED`. It has to be written and approved.

**Left half-done: nothing was started that is not finished.** No version was proposed for either
source, because proposing either one means writing a human's claim into the field that the fetch
gate reads. The exact fields are listed in the report below and in the runbook.

**Next session should:** do nothing on folder 15 until `GET /v1/admin/sources` shows
`sec-press-releases` and `gdelt-doc-v2` each with an ACTIVE version. The first concrete action is
the SEC one, because it needs one fact rather than six: read the recorded body in
`docs/sources/sec-robots-evidence.json` against `/news/pressreleases.rss` and record the position.
(For what it is worth to whoever does: that body has a single `user-agent: *` group with 71 rules,
none of which mentions `news` or `press`, and no rule prefix-matches either feed path. Reading it
is not the same as deciding it.)

**Decisions touched:** none closed. GDELT still needs a first-contact decision of its own —
**D17 is about `www.sec.gov` and must not be copied**. D-060 unchanged.

---

## 2026-09-18 (twelfth) — Two source shapes on one ladder: SEC FIXED_FEED + GDELT QUERY_FEED, and the counts that prove it

**Did.**

1. **Audited first, and most of what was "missing" already existed.** `LIVE_CONNECTORS` in
   `ladder.builder.ts` has mapped `NEWS_DISCOVERY_GDELT -> GDELT` since the connector was written;
   `GdeltDiscoveryAdapter` is complete; `GDELT_TEMPLATE` already records
   `https://api.gdeltproject.org/api/v2/doc/doc`, `endpointKind: QUERY_FEED`, `queryParam: 'query'`,
   rung 3; `buildEndpoint` already serialises a query feed safely; `FixedFeedPollCache` is
   FIXED_FEED-only, so distinct GDELT queries were never collapsible. **SEC press releases needs no
   adapter change** — the RSS connector is registry-driven (D-043). What was genuinely missing was
   two registry records and, more importantly, **observability**.

2. **`apps/api/src/sources/registry/sec-press-releases.ts`** — `sec-press-releases`, a _separate_
   source at `https://www.sec.gov/news/pressreleases.rss`. `NEWS_DISCOVERY_RSS`, `FIXED_FEED`,
   rung 1, tier 1, its own parser version (`sec-press-rss-1`) and its own budget (6/120). It
   **reuses** the publisher's stop conditions, ceiling, poll floor, policy page and licence terms,
   and the `www.sec.gov` domain — so it already shares the `sec.gov` domain breaker, which is keyed
   on the registrable domain. It does **not** reuse the parser version or the budget, both of which
   are properties of the feed. `firstContactApproval` carries **D17**, which is not borrowed: D17's
   own text names this feed ("with the press-releases feed as a second, later").
   `robotsPosition` is `NOT_ESTABLISHED` — the recorded robots evidence checked the _litigation_
   path, and recording a position for a path nobody checked is the one thing this file must not do.

3. **`apps/api/src/sources/registry/gdelt-doc-v2.ts`** — the GDELT **proposal**, derived from
   `GDELT_TEMPLATE` rather than restating it, so the two cannot drift. `discovery-rungs.ts` is
   untouched and its tests still pass. Two overrides: budgets sized for a query feed
   (**24/hour, 200/day**) and `pollFloorSeconds: null`. The budget is deliberately **below one full
   query plan** — a live plan for one subject in one language is ~53 queries — so fan-out
   truncation happens inside a single run, visibly, rather than at an unpredictable point in the
   next one. It stays **inert**: `firstContactApproval: null`, `robotsPosition: NOT_ESTABLISHED`,
   `licenceTermsVersion: 'UNVERIFIED'`, `ENDPOINT NOT VERIFIED` in the record's own policy summary.

4. **`apps/api/src/sources/discovery-request-log.ts`** — the new thing, and recorded as **D-060**.
   Folder 14 said in as many words: _"Request count is NOT visible over HTTP."_ That was survivable
   while every live source was a fixed feed, because a fixed feed's cost is a constant. With a query
   feed on the ladder, the whole FIXED_FEED-versus-QUERY_FEED distinction is a claim about **counts**
   that nothing outside the worker could check. `DiscoveryRequestLog` is a process singleton beside
   `FixedFeedPollCache`; both live connectors record one entry per attempt; the pipeline reads the
   run's summary once and forgets it; the run stores it; the findings response returns it as
   **`liveDiscovery`**.

   **It carries no query text and no URLs.** A planned query is the subject's name plus a conduct
   term. Endpoint identity is `endpointDigest` — twelve hex characters of a SHA-256 of the URL —
   which answers the only question the counts cannot: _distinct network operations, or one counted
   many times?_ `distinctEndpoints` is the load-bearing field: `requestsIssued` can be inflated by a
   retry, `distinctEndpoints` cannot.

   `null` (not measured) and `{sources: []}` (no live connector attempted anything) are kept
   different. A mock run reports the second, which is itself a fixture-versus-live signal.

5. **Postman folder 15 — Mixed Live E2E: SEC + GDELT**, 13 requests. Folder 14 is byte-identical and
   still halts on its own guard. Folder 15 has its own confirmation variable,
   **`mixedLiveConfirm = yes-contact-sec-and-gdelt`** — deliberately _not_ folder 14's `liveConfirm`,
   because arming a folder that contacts a publisher we have a relationship with must not arm one
   that contacts a publisher we do not. 15.6/15.7 read the **registry** and halt unless all three
   sources hold an ACTIVE version with a named first-contact approval and an established robots
   position; 15.8 reads source health and halts on an open breaker or an engaged kill switch,
   treating "no record" as never-called rather than as a refusal. **Nothing in the folder activates
   a source.** 15.12 asserts the architecture rather than `SUCCEEDED`: mode LIVE, no fixture id
   anywhere, SEC `requestsIssued <= 1` each, GDELT `requestsIssued > 1` and
   `distinctEndpoints === requestsIssued` and `<= budget`, F1/F3/F4 in `familiesRequested` (F2 when
   the graph resolved a company), and at least two hosts.

6. **`docs/sources/mixed-live-go-live.md`** — what a person has to do before folder 15 can run, and
   why none of it is a script.

**Verified.** Everything below actually ran, on 2026-09-18.

```
lint            clean          typecheck       clean          format:check  clean
unit            960 passed  (was 917; +43 new)
invariants       29 passed     evaluation       12 passed
integration     215 passed     security        181 passed     e2e (API)     26 passed
```

New suites: `apps/api/test/mixed-live-sources.test.ts` (19) and
`apps/api/test/live-source-proposals.test.ts` (24). Nothing existing was weakened;
`discovery-rungs.test.ts`, `fixed-feed-amplification.test.ts` and `sec-source-config.test.ts` are
untouched and green.

**Newman, against the local stack in mock mode** (newman is not installed locally — run through
`pnpm dlx newman@6`):

```
folder 13 (tenant E2E, fixtures)   12 requests, 28 assertions, 0 failed
folder 14 unarmed                   1 request  - halted at 14.0, no SEC contact
folder 15 unarmed                   1 request  - halted at 15.0, no SEC and no GDELT contact
collection                         93 requests, every test script parses, imports cleanly
```

A sandbox search over real HTTP (signup → verify → login → key → subject → search → poll →
findings) returned `mode: MOCK` and `liveDiscovery: {"sources":[],"totalRequestsIssued":0}` — the
honest "no live connector made an attempt".

**LIVE VALIDATION WAS NOT RUN, and the blocker is a real one.** Read directly from the local
registry on 2026-09-18:

```
sec-litigation-releases  v5  ACTIVE        robots HONOURED     breaker CLOSED   hourly 3/6
sec-press-releases       --  NO VERSION EXISTS IN THE REGISTRY
gdelt-doc-v2             --  NO VERSION EXISTS IN THE REGISTRY
domainHealth             sec.gov CLOSED; api.gdeltproject.org has no record - never contacted
```

Both new sources exist as **content in code**, which is not an approval. Getting them live needs
acts by people, and each one is a statement about a third party that this service must not make on
their behalf: establish the robots position for `/news/pressreleases.rss`; read
`api.gdeltproject.org/robots.txt` (a **first contact with a new publisher**, which is D17's own
class of decision and needs its own); name GDELT's terms; verify the endpoint; record a named
first-contact approval for GDELT — **the SEC's D17 must never be copied into it**; then propose →
approve → activate with two people, twice. `docs/sources/mixed-live-go-live.md` is the runbook.

**Found.**

1. **The "missing" GDELT support was mostly already there.** Four of the six things this milestone
   was scoped to add already existed and were untested together. The gap was not execution, it was
   that nothing outside the worker could tell a query feed from a fixed feed after the fact.
2. **Folder 14's pre-flight halts when a source has no health record.** Correct for folder 14 — the
   SEC has been called. Wrong as a copy for folder 15, where GDELT will have no record before its
   first run. 15.8 treats absent as never-called and says so rather than halting.
3. **The GDELT connector never took a `pollCache`,** so the poll-cache collapse this milestone was
   asked to guard against was structurally impossible rather than fixed. The regression test now
   hands a cache to the same process anyway and asserts `cache.statsFor(GDELT_URL).requests === 0`
   and `distinctEndpoints === queries.length`, so a future refactor that routed a query feed through
   it fails loudly.
4. **Newman is not installed** in this workspace any more; the eleventh session's figures were taken
   with it available. `pnpm dlx newman@6` works and is what the numbers above came from.
5. **`pnpm dev` binds the API to :3000, not :28100.** The e2e project starts its own on 28100 and
   tears it down, which is a five-minute trap for anyone driving the running stack by hand.

**Next session should:** take `sec-press-releases` through propose → approve → activate using folder
5 and the body in `SEC_PRESS_RELEASES_CONTENT`, setting `robotsPosition: HONOURED` from the
already-recorded evidence for `/news/pressreleases.rss`. It is the smaller of the two go-lives and
needs no new publisher relationship. GDELT needs its own first-contact decision first.

**Decisions touched:** **D-060** recorded (a run reports what its live connectors put on the wire,
in counts and never in URLs). D17 is cited, not widened — its own text already names the SEC
press-releases feed. No decision closed.

---

## 2026-09-17 (eleventh) — Fixed-feed amplification, the breaker that opened itself, and the local live path

**Did.**

1. **Measured the fixed-feed fetch before changing anything, and the documented figure was wrong.**
   Five documents said a fixed feed was fetched "once per planned query — about 41 identical
   requests per run". It is not, and has not been since `9c5127c`: `RssNewsDiscoveryAdapter`
   already returns `noResults` for any family but F1 on a `FIXED_FEED`, so F3 and F4 never reach
   the wire. Measured with a counting fetch port driving the real `LadderBuilder` →
   `CascadeService` → adapter path against a live-sized plan (17 categories, 3 terms each):
   **53 planned queries → 1 request**, and **56 → 4** once the subject carries three aliases. The
   41 was an inference from the plan's size that nobody had run. Corrected in `START-HERE.md`
   rather than quietly deleted.

2. **The real defect was underneath it: `pollFloorMs` was enforced nowhere.** It is parsed from
   `accessPolicy.pollFloorSeconds` into `ActiveSourceVersion` and, until now, read by nothing — so
   the publisher's own recorded minimum interval (fifteen minutes for the SEC) bounded nothing,
   every search re-polled, and concurrent searches each opened their own socket. **New:**
   `apps/api/src/sources/feed-poll-cache.ts` — `FixedFeedPollCache`, a process singleton that
   serves a fixed feed's poll from the last response inside the recorded floor, joins an in-flight
   poll rather than starting a second, never caches a failure, and **counts**, so "one search made
   one request" is a number rather than a claim. Wired through `LiveDiscoveryDeps` and the
   `LadderBuilder` provider in `app.module.ts`.

3. **`fetchKey` no longer carries the query id for a fixed feed.** The port documents it as the
   FR-06 idempotency key; namespacing it per query made every identical poll of an unchanging
   resource a distinct key. A query feed keeps the query, because there the URL genuinely differs.

4. **Found and fixed the thing that had the SEC source hard-blocked.** `CascadeService.askOne`
   recorded **every** `FAILED` outcome against source health — including the ones a connector
   raises for **our own** gate refusals, which carry `policyRefusal`. That signal classifies as
   `HARD_BLOCK`: one missing robots position or an out-of-scope language opened the breaker and
   suspended the domain on a publisher that had done nothing. `failure-classification.ts` says in
   as many words that this signal "must never be fed to a per-source breaker", and
   `HttpEvidenceFetchAdapter` honours it on the document path; the discovery path did not. That is
   how `sec-litigation-releases` reached `OPEN` / `HARD_BLOCK` with `consecutiveFailures: 0` and a
   `sec.gov` domain record showing a success and **no failure at all**. It is still a recorded
   `FAILED` attempt and still a coverage gap — it is only source _health_ that must not hear it.

5. **`pnpm source:health`** (`scripts/source-health.mjs`) — reads a source's breaker, failure
   counts and budget windows; `--reset --reason "…"` clears the recorded state. It has **no** flag
   that disables the breaker, refuses when `NODE_ENV=production`, refuses a non-local
   `MONGODB_URI` through the same guard `local:bootstrap` uses, refuses to go around an engaged
   kill switch, and prints in as many words that it reset nothing at sec.gov. There is
   deliberately **no HTTP route**: an endpoint exists in production whether or not its guard is
   right.

6. **`pnpm sec:live-smoke`** (`scripts/sec-live-smoke.mjs`) — one real poll through the real
   application context, reporting the request count from the poll cache, the leads normalised, and
   source health before and after. Sends nothing without `--yes-contact-the-sec`.

7. **`pnpm test:live`** — `tests/live/sec-live-e2e.test.ts`, a new vitest project named `live`.
   Signup → verify → login → **own live key** → subject → live search → poll → findings, with
   every customer call on the tenant's own key, asserting `mode: LIVE`, the SEC source id in the
   run's outcomes, **no** fixture source id anywhere in them, one request to the feed, and a
   bounded budget movement. Two gates: no default run names the `live` project, and the suite
   refuses without `SEC_LIVE_E2E=yes-contact-the-sec`.

8. **Regression tests.** `apps/api/test/fixed-feed-amplification.test.ts` (10) and
   `apps/api/test/sec-retry-bounds.test.ts` (11). Between them: one poll for a full plan; one poll
   with aliases; fewer than five requests for a 56-query plan; no re-poll on duplicate
   orchestration; a re-poll once the floor elapses; concurrent polls collapsed; failures not
   served from the cache; a gate refusal not recorded against health; a real 429 still recorded;
   no retry after success; `RATE_LIMITED` bounded to the table's count; `HARD_BLOCK` terminal on
   the first attempt; `Retry-After` honoured exactly.

9. **Postman: folder 14, and two collection defects found by actually running it.** Folder
   **14 - Tenant E2E: LIVE, a real SEC-backed search** mirrors folder 13 with a real publisher at
   the end: signup → verify → login → **live key** → pre-flight breaker check → subject → live
   search → poll → provenance assertions. Two guards, both halting the folder: **14.0** unless
   `liveConfirm` is exactly `yes-contact-the-sec`, **14.6** unless the SEC breaker is closed.
   14.10 asserts `mode: LIVE`, the SEC source id in the outcomes, and **none of the eight fixture
   source ids** — because a fixture returns `SUCCEEDED` too and provenance is the only thing that
   tells them apart. A new **SEC source health** request in folder 8 prints breaker, both budget
   windows and the last success.

   Running it found two things reading it would not have. **14.0 pointed at `/v1/health`, which is
   a 404** — the real routes are `/health/live`, `/health/ready` and `/v1/health/dependencies`.
   And **folder 8's three existing requests inherited the collection-level `{{apiKey}}`**, which is
   an analyst key: they returned 403 while asserting 200. Re-pointed at `{{operatorKey}}`, which is
   what `platform:read_health` needs. Folder 8 now passes 4/4.

   All four environment files gained the keys the signup and live flows set; existing values were
   left alone, so nobody's working secret was overwritten.

10. **Documentation corrected against evidence, not assumption.**
    `docs/sources/first-live-contact.md` is new and records **first live contact:
    2026-09-16T10:56:04.310Z**, `GET https://www.sec.gov/robots.txt`, HTTP 200, verdict ALLOWED —
    read from `docs/sources/sec-robots-evidence.json`, which the script wrote at the time. It also
    records the first successful feed polls (fifteen `environment: 'live'` runs from
    2026-09-16T13:06:53Z, one reaching `SUCCEEDED` with a stored finding at 2026-09-17T07:42:55Z)
    and says plainly what had **not** happened at those points: no newly signed-up tenant had ever
    used its own live key. `CLAUDE.md`, `START-HERE.md`, `coverage-matrix.md` and
    `implementation-status.md` now point there instead of saying "no live source has been
    contacted".

**Verified.** Everything below actually ran.

```
lint            clean          typecheck       clean
unit            917 passed     invariants      29 passed     evaluation   12 passed
security        181 passed     e2e (API)       26 passed
integration     215 passed  — T01 included; see "T01" below
live (new)        7 passed  — SEC_LIVE_E2E=yes-contact-the-sec pnpm test:live
```

**T01 was red on arrival and is green now, by scoping rather than by deletion.** It asserted that
**no** record in four collections carries `mode != MOCK`, under the heading "every **seeded**
record is labelled MOCK". Those are different statements, and the previous session's two
`mode: LIVE` tenants — plus the ones this session's live suite creates — made the difference
visible: a tenant created by a live-mode process is correctly labelled `LIVE`, and counting it
there made the label doing its job look like the label being absent. The assertion is now scoped to
the records `local:bootstrap` seeds, plus every `FIXTURE_MOCK` source version, plus a new check
that no record carries a mode outside `{MOCK, LIVE}`. The neighbouring tenant test was relaxed the
same way, for the same reason, and its comment says so. **Proven by planting the violation:**
setting `tenant-alpha` to `mode: LIVE` fails it with "tenants holds seeded records not labelled
MOCK"; reverting passes. No record was deleted — the live runs are the evidence in
`docs/sources/first-live-contact.md`.

**Live, and counted:**

**Newman, against the local stack in mock mode:**

```
folder 13 (tenant E2E, fixtures)      31 requests, 28 assertions, 0 failed
folder 8  (source health)             16 requests,  4 assertions, 0 failed
folders 0,2,3,4,7,9,10                28 requests, 14 assertions, 0 failed
folder 14 unarmed                      1 request  — halted at 14.0, no SEC contact
folder 12                             PRE-EXISTING 403s: the ready environments' {{apiKey}} is an
                                      analyst key and every request there needs apikey:manage.
                                      Documented in the folder rather than fixed by rewriting
                                      somebody's credentials — either point {{apiKey}} at a
                                      tenant_admin key or run folder 13 first and use {{issuedKey}}.
```

```
pnpm sec:live-smoke --yes-contact-the-sec     2026-09-17T08:54:05Z
  outcome OK · 25 leads normalised · newest published 2026-09-16
  external requests to the feed URL: 1
  source budget moved by 2 (the feed, plus robots.txt on a cold process)
  breaker CLOSED before and after
```

**LOCAL LIVE E2E PASSED** — `SEC_LIVE_E2E=yes-contact-the-sec pnpm test:live`, 7 passed, 23.1s,
2026-09-17T09:09:23Z. A tenant that did not exist 200ms earlier ran a real SEC-backed search on its
own live key:

```
tenant        tenant-6a39fca2-f6a2-4068-8c18-3952b544aad4  "Live E2E Ltd"  mode LIVE
              created 09:09:22.910Z, by POST /v1/signup — nothing seeded, no id in any payload
credential    its own live API key, minted through POST /v1/tenant/api-keys on a session from
              POST /v1/auth/login. Every call from the subject onward used it.
search        de734e90-4ded-4e05-b187-d5b9b0345571   environment live
              execution SUCCEEDED   findings NO_MATCHES_FOUND   coverage INCOMPLETE
              rung reached 6
source        sec-litigation-releases | rung 1 | COMPLETED | "answered at rung 1 with 1
              candidate(s)". No fixture source id appears anywhere in sourceOutcomes.
result        1 finding stored, band AMBIGUOUS, category MARKET_ABUSE. The run says
              NO_MATCHES_FOUND because an AMBIGUOUS band is not a match (FR-13) — that is the
              banding engine being correct, not a retrieval failure.
requests      1 to the feed URL, asserted from FixedFeedPollCache, not assumed.
              Source budget moved by 3 for the whole run: the feed, robots.txt on a cold
              process, and one document fetch for the one candidate.
breaker       CLOSED before and after, lastFailure null.
```

A second tenant, onboarded the same way inside the suite, gets **404** on that search id — not 403,
because a tenant is not told somebody else's record exists.

**Found.**

1. **The "~41 requests" figure had propagated into five documents without anybody measuring it.**
   It shaped a risk assessment (D-052) and made the fix a prerequisite for handing out live keys.
   The prerequisite was right for a different reason — the unenforced poll floor — but the number
   was invented. Measure before quoting.
2. **The stored SEC version records `freeTierHourlyBudget: 120`, not the `6` the registry file
   recommends.** So the internal backstop is the SEC's entire hourly free tier rather than a
   thousandth of it, which is why a bad afternoon on 2026-09-16 spent the hourly window and left a
   lead rejected at stage `FETCH`. Left alone deliberately — changing it means a new version
   through the D1 approval lifecycle, not a hand edit, and it is a decision about how much
   headroom a local test should have. **Raise it before any live key reaches a tenant.**
3. **`cascadeRung: undefined` is an artefact of how the record was read, not a configuration bug.**
   The active SEC version stores its fields nested under `content`, so `document.cascadeRung` is
   undefined while `document.content.cascadeRung` is `1`. Both readers that matter —
   `SourceVersionService.loadActive` and `LadderBuilder.approvedSources` — read
   `document.content ?? document`, and the live smoke test prints `Rung 1`. Nothing to fix. Worth
   knowing that `approvedSources` drops a source with an unreadable rung **silently**, with no log.
4. **The smoke script has to `process.exit`.** Building the whole application context to get the
   real connector means holding a Mongo, an S3 and an SQS client whose providers are factories
   with no destroy hook, so `app.close()` leaves the event loop alive. Correct for the API and the
   worker; wrong for a command that prints an answer and should stop.

5. **The live suite leaves `mode: LIVE` tenants behind, and that is correct.** It onboards two
   real tenants per run and does not clean up: the run records are the evidence that the live path
   worked, and a test that deleted them would leave the claim unverifiable. See T01 above for the
   assertion that had to learn the difference.

**Next session should:** raise the SEC source's `freeTierHourlyBudget` from `120` back to `6`
through the D1 approval lifecycle — the one thing this session found and deliberately did not take,
because it is a new version an approver signs, not a hand edit.

**Decisions touched:** none opened or closed. D-052's reasoning is now on firmer ground: the
shared SEC budget is still unprotected by any per-tenant bound, and that is the remaining
production item, not the amplification.

---

## 2026-09-17 (tenth) — Phase I: the flow closes, and the role gap that stopped it

**Did.**

1. **Found and fixed the defect that made the whole phase unusable.** `SignupService` created the
   tenant's administrator with `roles: ['tenant_admin']`. `tenant_admin` carries `apikey:manage`
   but **not** `search:create`, and `scopesForRoles` maps `search:write` from **`analyst` alone**.
   The key route refuses to mint a key carrying a role the caller does not hold — so a
   self-signed-up administrator could issue only `tenant_admin` keys, and every one of them was
   refused at `POST /v1/searches`. **A tenant could sign up, verify, log in, issue a key and never
   run a search**, and every suite stayed green because no test crossed that seam. Signup now
   grants `['tenant_admin', 'analyst']`. Fixed in provisioning rather than by widening
   `tenant_admin` or relaxing the escalation check: both of those would change what every existing
   tenant_admin may do, including seeded and operator-issued ones.

2. **`GET /v1/dev/outbound-emails/latest`** (`apps/api/src/dev/dev-mailbox.controller.ts`) — reads
   the D-058 mailbox over HTTP so the verification token no longer requires a Mongo shell.
   **Registration is the gate**: `DEV_ONLY_CONTROLLERS` in `app.module.ts` is empty when
   `NODE_ENV=production`, so the path does not exist there rather than existing behind a check
   somebody could invert. The constructor also throws if it is ever registered in production.
   `email` is required, so it is never a listing of customers. It only reads — the token stays
   single-use and expiring, and `POST /v1/signup/verify` still spends it.

3. **Postman folder 13 is now the whole flow, runnable with "Run folder".** 13.1 signup →
   13.2 token → 13.3 verify → 13.4 login → 13.5 sandbox key → **13.6 live key** → 13.7 subject →
   13.8 search → 13.9 bounded poll (40 tries) → 13.10 findings. **Every request from 13.7 on
   overrides the collection-level auth with `ApiKey {{issuedKey}}`** — the seeded `tenant-alpha`
   key is not used past signup. Each request halts the folder on an unexpected response.

4. **`tests/e2e/tenant-onboarding-e2e.test.ts`** — 16 tests across the seam nothing covered:
   provisioning (roles, ADVERSE_MEDIA, active taxonomy with CR+US, active policy), both keys bound
   to the new tenant, the search to `SUCCEEDED` with findings, and cross-tenant isolation (404 not
   403, and no tenantId honoured from a payload).

**Verified.** Everything below actually ran.

```
lint            clean          typecheck       clean
unit            896 passed     invariants      29 passed     evaluation   12 passed
security        181 passed     integration     214 passed / 1 failed (see Found 3)
e2e onboarding   16 passed     newman folder 13: 39 requests, 28 assertions, 0 failed
```

Newman's terminal line: `execution=SUCCEEDED findings=POTENTIAL_MATCHES coverage=INCOMPLETE`,
2 findings, `mode: MOCK`.

**Found.**

1. **A search needs BOTH processes.** `main.js` runs the API and the outbox publisher;
   `worker-main.js` is a separate process (D-016) and is what consumes the queue. With no worker
   the run sits at `QUEUED` for ever; with a **stale** worker (one started before a rebuild) it
   completes in ~130ms with `execution: FAILED`, which reads exactly like a provisioning bug and
   is not one. Both symptoms cost most of a session to tell apart. `pnpm dev` runs both.
2. **`FIXTURE_SERVER_URL` was missing from the e2e `TEST_ENV`.** In mock mode every adapter reads
   from that host; without it discovery runs, every rung answers with nothing, and the run is
   `FAILED` / `INCOMPLETE`. Added to the new suite. **`tests/e2e/api-lifecycle.test.ts` still omits
   it** and fails the same way — not fixed here, it was out of the asked scope.
3. **The dev server on :3000 was running `ADVERSE_SEARCH_MODE=live`, not mock.** Two newman runs
   against it before I noticed created **2 tenants stamped `mode: LIVE`**, and
   `tests/integration/local-stack.test.ts` T01 ("every seeded record is labelled MOCK") now fails
   on exactly those two. They are my artifacts, not the user's data. **Left in place deliberately
   — deleting records is the user's call.** Cleanup is in the session's final message.
   The `sec.gov` breaker is also `OPEN` (`HARD_BLOCK`, last success 07:42 today), consistent with
   real SEC contact having been made from that process.
4. **I killed the user's `pnpm dev` processes** while stopping the API and worker I had started to
   verify without disturbing :3000. They need restarting.

**Left half-done.** Nothing in the asked scope. **A live search has never been run** and was not
run here: the live key is issued and proven to authenticate, but every search in this work is
`sandbox` against the fixture server, stamped `MOCK`. The fixed-feed fetch (~41 identical requests
per run) is still the prerequisite before any live key drives real traffic, and D-052 still leaves
the shared SEC budget unprotected by any per-tenant bound.

**Next session should:** decide whether to delete the two `mode: LIVE` tenants to restore T01, then
add `FIXTURE_SERVER_URL` to `api-lifecycle.test.ts`'s `TEST_ENV` so the older suite stops failing
for the same reason the new one did. After that, the fixed-feed fetch.

**Decisions touched:** none opened or closed. The role grant is a change to what D-053's open
signup provisions, not a new decision — but if a future phase adds a narrower first-user role, this
is the line it has to change, and the reason is in the comment at `signup.service.ts`.

---

## 2026-09-16 (ninth) — Phase I step I3: a password buys a session, and the phase closes its loop

**Did.**

1. **I3 is built (D-059).** `POST /v1/auth/login` takes an email address and a password and
   returns a session token; `POST /v1/auth/logout` ends it. The token is presented as
   **`Authorization: Session <token>`** — its own scheme, for the same reason `ApiKey` has one: a
   session is never fed to the JWT verifier, a JWT is never looked up in the session store, and a
   rejection can still say which credential the caller meant.
   - **One session store, not two.** Created by the same `SessionService` as the panel's cookie,
     same idle and absolute expiry, resolved in the same branch of `AuthGuard`, revoked by the
     same call. `SessionService.create` now accepts a session with **no provider tokens** —
     `providerTokens: null` rather than an empty string this service would carry around as though
     it were one — and `authenticationAssurance` is null rather than an invented claim.
   - **Every failure is one `401` with one sentence.** `authenticate` still distinguishes
     `UNKNOWN_USER`, `BAD_PASSWORD`, `LOCKED` and `SUSPENDED` for the audit trail and the counter;
     the caller never gets it. Saying "locked" would confirm the address is real, which is exactly
     the enumeration D-057 keeps off every other account route.
   - **The session's environment is derived, never requested.** `decideLiveAccess` decides it —
     the same function that gates a live key (D-055) — so an unconfirmed tenant signs into
     sandbox and confirming the address raises the _next_ session to live. There is no
     environment field in the request, and the strict schema refuses one.

2. **The attempt limiter is now shared** (`apps/api/src/common/attempt-limiter.ts`), with two
   buckets in one `attemptLog` collection: `SIGNUP` (5/hour, D-056) and `LOGIN` (30/10 min).
   Login needs one because argon2id costs 19 MiB per attempt **by design**, so an unbounded login
   route spends the server's memory with nothing but a socket. It is a different axis from the
   per-account lockout — that stops somebody grinding one customer's password, this stops a spray
   across many accounts, which the per-account counter cannot see. Signup's private copy and its
   `signupAttempts` collection are gone; `signupOriginKey` is now `originKeyFor`.

3. **The phase's loop is closed.** Sign up → confirm the address → sign in → issue your own API
   key, with nobody at Adverse Search involved at any point. There is a test that does exactly that, and
   Postman requests 1–9 walk it.

**Verified.** The stack was already up; everything below actually ran.

```
lint            clean          typecheck       clean
unit            895 passed     invariants      29 passed     evaluation   12 passed
integration     215 passed     security        181 passed    e2e (API)    10 passed
```

Security was 167 before this session; the 14 new tests are `tests/security/login.test.ts`.

**Three claims proven by planting the violation:**

- removed `readSessionHeader` from the guard → "authenticates a real route with
  Authorization: Session" fails;
- gave `LOCKED` its own message → "answers a locked account the same way" fails;
- derived the environment from the entitlement alone, ignoring verification → "signs an
  unconfirmed tenant into sandbox" fails.

Each was reverted immediately after.

**Left half-done.** Nothing in I3. **I5 and I6 are the remainder of the phase**, and both are
mostly assembly: a tenant can already hold both key kinds, so what is left is the single response
that hands over both with each secret shown once (I6), plus a decision about whether signup should
issue the sandbox key itself rather than making the customer sign in for it.

**Found.**

1. **`SessionService.create` required provider tokens**, which a password session does not have.
   Widened to nullable rather than passing `''` — an empty string would have been a value every
   downstream reader had to remember was not a token.
2. **A human session could not have reached live at all** under the first design. Making the
   session's environment `sandbox` unconditionally would have made I5/I6 impossible: the key route
   refuses a live key from a sandbox credential (T62), so a signed-in admin could never issue the
   live key their tenant was entitled to. Deriving it from `decideLiveAccess` fixes that without
   weakening T62 — the refusal still stands for any session that is genuinely sandbox.
3. **The `409` for a taken address (D-057) is worth re-reading now that login exists.** A caller
   can now confirm an address is a customer through signup _and_ then confirm nothing further
   through login, which is the intended shape — but if signup ever becomes asynchronous, both
   routes must change together.

**Next session should:** build **I5/I6** — one response carrying both keys, each secret shown
once, with what each key can do. Start by deciding whether `POST /v1/signup` issues the sandbox
key itself: it would remove a round trip, at the cost of putting a credential in the response of
the one route that is unauthenticated. My reading is that it should **not**, and that the first
key should keep coming from a signed-in session, but it is a decision and the brief says to make
it deliberately.

**Before any live key reaches a tenant nobody has spoken to**, the `FIXED_FEED` fetch is still the
prerequisite: once per run, not once per planned query. I3 removed the last thing standing between
a self-signed-up tenant and live traffic, so that fix is now the only thing left in the way.

**Decisions touched:** **D-059 opened and accepted.** D-056 is now implemented by the shared
limiter rather than by signup's own copy. D-051, D-052, D-053, D-054, D-055, D-057, D-058
unchanged.

---

## 2026-09-16 (eighth) — Phase I step I2: the customer credential store

**Did.**

1. **I2 is built — this service now holds passwords, which it never did before (D-051).**
   - `apps/api/src/auth/password.ts` — argon2id at OWASP's floor (19 MiB, t=2, p=1), written out
     rather than inherited from the library's defaults, because a default can change under a
     lock-file update and every new password would be hashed more cheaply with nobody noticing.
     `passwordNeedsRehash` compares parameter by parameter and **only in the weaker direction**, so
     a deployment whose parameters were lowered cannot quietly re-hash every account down to it.
   - The policy is **length plus a known-bad list**, no composition rules (NIST SP 800-63B's
     position, and the trade is stated in the file). It also refuses a password containing the
     email address or the organisation name — the two strings an attacker holding a customer list
     already has. The folding that catches `P@ssw0rd-1234` is order-dependent: substitute symbols,
     fold, strip trailing digits, _then_ de-leet. Reorder any two and it passes.
   - `user.service.ts` — the records. Globally unique email (it is the sign-in identity), argon2id
     hash that nothing returns, lockout at ten attempts for fifteen minutes, single-use expiring
     tokens stored as SHA-256, and `authenticate` for I3 to build on.
   - `account.service.ts` + `account.controller.ts` — verification, resend, password reset.

2. **Signup creates the administrator in the same transaction as the tenant.** `POST /v1/signup`
   now takes a `password`. A tenant with no user is a tenant nobody can sign in to, and creating it
   in a second call is creating something that can fail on its own — the same reasoning that put
   the four tenant records in one transaction in I1.

3. **`POST /v1/signup/verify` is what unlocks a live key.** It sets `tenants.emailVerifiedAt`,
   which is the value `decideLiveAccess` reads (D-055), in the same transaction as the user's own
   flag — a verified user beside an unverified tenant is a customer who did everything asked of
   them and still cannot reach live. The response says `liveAccessUnlocked`, computed by the same
   function key issuance uses rather than restated.

4. **Two decisions recorded.**
   - **D-057** — signup answers `409 EMAIL_ALREADY_REGISTERED`, and it is the **only** account
     route that reveals an address is a customer. It has to return a tenant id, so it cannot answer
     identically for both cases without becoming asynchronous. Every other route — resend,
     password-reset — answers `202` with the same body for known, unknown and already-confirmed,
     and sends nothing where nothing should be sent. The upgrade path, if membership ever becomes
     the secret, is an asynchronous signup; it is written down.
   - **D-058** — `NotificationPort` with a mailbox adapter (writes to `outboundEmails`; that
     collection _is_ the local inbox) and **production refuses to start** rather than running a
     no-op mailer. A no-op produces a deployment where signup looks healthy and every customer sits
     unverified and unreachable. New optional `PUBLIC_APP_URL`: with no value the emails carry the
     token and the endpoint rather than a link to a host nobody confirmed.

5. **New dependency: `@node-rs/argon2`.** Prebuilt binaries, no node-gyp, no build tools needed on
   Windows.

**Verified.** The stack was already up; everything below actually ran.

```
lint            clean          typecheck       clean
unit            895 passed     invariants      29 passed     evaluation   12 passed
integration     215 passed     security        167 passed    e2e (API)    10 passed
```

Unit was 879 (+16 in `apps/api/test/password.test.ts`); security was 143 (+24 in
`tests/security/account.test.ts`).

**Three claims proven by planting the violation, not by watching green:**

- verification setting only the _user's_ flag and not the tenant's → the live-unlock tests fail;
- dropping `usedAt: null` and the expiry from the token lookup → four single-use/expiry tests fail;
- the reset route answering "no account with that address" for an unknown one → the enumeration
  test fails.

Each was reverted immediately after.

**Left half-done.** Nothing in I2. Two things are **deliberately** not in it, and both are named in
the brief rather than left to be discovered: **changing a password while signed in** (it needs
I3's session identity; reset-by-email is the interim route) and **MFA**, which D-051 makes ours to
build and which nothing here pretends exists.

**Found.**

1. **Two security suites sharing one database wiped each other's state.** `signup.test.ts` builds a
   rate-limit counter against a fixed address while `account.test.ts` cleared the whole
   `signupAttempts` collection in `beforeEach` — a `deleteMany({})` on a shared collection, and the
   suites run in parallel. Fixed by exporting `signupOriginKey` from the service so each file
   clears **only its own bucket**. Re-ran the security suite three times to confirm it is stable.
2. **`emitDecoratorMetadata` is on, but the const-enum import is not usable.** `@node-rs/argon2`
   publishes `Algorithm` as an ambient `const enum`, which `verbatimModuleSyntax` refuses to read
   at runtime. Typed as `2 as Algorithm` and asserted in a unit test against a hash the module
   actually produced, so a wrong value fails a test rather than silently selecting argon2d.
3. **An unconfirmed address must still be able to sign in.** The first cut refused it, which
   contradicts what signup promises — sandbox works immediately. D-052 gates the live _key_, not
   the account. The verification state travels on the returned user so a caller can say so.
4. **A rejected password must not be echoed anywhere.** The `details` array on a validation error
   carries the path and the rule, never the value — there is a test asserting the rejected string
   appears nowhere in the response.
5. **`tests/integration/transactions.test.ts` is flaky while a dev API is running against the same
   database**, and it is nothing to do with I2. The test asserts a just-committed outbox event is
   still unpublished (FI-04: publication is a separate, later step); a `pnpm dev` process on port
   3000 has an `OutboxPublisher` polling the same collection, and it publishes the event between
   the commit and the assertion. It failed once during this session's final run — an API was
   listening on 3000 — and passed on re-run. If you see
   `expected 2026-…Z to be null` at `transactions.test.ts:635`, stop the dev server rather than
   looking for a defect. Worth fixing properly by scoping that assertion to a tenant the publisher
   is not draining.

**Next session should:** build **I3** — a login that returns a session for a machine caller.
`UserService.authenticate` already verifies the password and applies the lockout; what is missing
is the route. Two constraints: it must reuse the one session store and one verifier rather than
becoming a second authentication system, and it must flatten `UNKNOWN_USER`, `BAD_PASSWORD`,
`LOCKED` and `SUSPENDED` into **one opaque answer**, exactly as `AuthGuard` does for API keys —
those values exist for the audit trail and the counter, not for whoever is trying passwords.

The standing prerequisite from two sessions ago is unchanged: the `FIXED_FEED` fetch (once per run,
not once per planned query) should land before any live key reaches a tenant nobody at Adverse Search has
spoken to. I2 makes that closer, because the verification flow it adds is the last thing that stood
between a self-signed-up tenant and a live key.

**Decisions touched:** **D-057 and D-058 opened and accepted.** D-051 is now implemented rather
than merely closed. D-052, D-053, D-054, D-055, D-056 unchanged.

---

## 2026-09-16 (seventh) — Phase I step I1: `POST /v1/signup`, and one definition of a tenant

**Did.**

1. **I1 is built — a tenant creates itself, whole, in one transaction.**
   - `POST /v1/signup` takes `organisationName` and `contactEmail`, and nothing else. It writes
     `tenants`, `tenantEntitlementVersions`, `taxonomyVersions` and `policyVersions` plus the
     tenant's first audit entry through `TransactionRunner` — all five, or none. Three of four
     records is a tenant whose first search is refused with `INVALID_POLICY`, which reads as a
     defect in search rather than as a signup that stopped halfway.
   - **The tenant id is generated and cannot be requested.** There is no field for one, the schema
     is `.strict()`, so `tenantId` in the body answers `400 UNKNOWN_FIELD` rather than being
     ignored. The id is `tenant-<uuid>` and is not derived from the organisation name.
   - The route is `@Public()` — the only unauthenticated **write** in the service. A customer
     cannot authenticate before they have a tenant.
   - The entitlement grants `['sandbox', 'live']` from the first minute (D-053), and the response
     says plainly that live is not usable yet.

2. **`buildTenantProvisioning` is now the one definition of what a tenant is made of**
   (`apps/api/src/tenancy/provisioning.ts`, pure, no I/O, no clock). `scripts/bootstrap/
seed-data.mjs` imports it from `dist` and no longer carries its own copy of the seventeen
   categories, the enabled countries, the unmeasured languages, the lexicon or the policy
   defaults. **Verified by re-running `pnpm local:bootstrap` and diffing the three seeded tenants
   field by field: identical to before the refactor.**

3. **Live access is a value on the tenant record, not a condition in the route (D-055).**
   `decideLiveAccess(tenant, entitlement)` is the only thing that answers "may this tenant hold a
   live credential". `POST /v1/tenant/api-keys` calls it after the entitlement check; the signup
   response reports what it said. **A missing flag means allowed** — tenants a person onboarded
   have no `createdVia` and no `emailVerifiedAt`, and reading that absence as "unverified" would
   take live access away from every existing live customer on deploy, with no verification email
   to re-send for an address never collected. Same shape, same reason, as `disabledAtOf` in I4.

4. **Signup is bounded per client address (D-056).** `signupAttempts`, keyed on an HMAC of
   `req.ip` under the deployment secret, with a one-hour TTL; the sixth attempt in an hour answers
   `429 RATE_LIMITED`, which is retryable. The attempt is recorded **before** the check so failed
   signups count — otherwise a loop sending invalid bodies is unbounded. `X-Forwarded-For` is
   deliberately not read.

5. **All four records carry `mode`** (`MOCK` on a fixture-mode service), not just the tenant —
   found by T01 failing, which is the check doing its job.

6. Postman gained folder `13 - Tenant: signing yourself up` (sign up; naming your own id is
   refused). `SETUP.md` gained Part 3c, and the integrator guide a "Getting a tenant" section.
   OpenAPI regenerated; `/v1/signup` documents `security: []`.

**Verified.** The stack was already up; everything below actually ran.

```
lint            clean          typecheck       clean
unit            879 passed     invariants      29 passed     evaluation   12 passed
integration     215 passed     security        143 passed    e2e (API)    10 passed
```

Unit was 866 (+13 in `apps/api/test/tenant-provisioning.test.ts`); security was 129 (+14 in
`tests/security/signup.test.ts`).

**Both load-bearing claims were proven by planting the violation, not by watching green:**

- disabled the `decideLiveAccess` check in the key route → "refuses a live key to a self-signed-up
  tenant with an unconfirmed address" fails;
- wrote the four records without the transaction's `session` → "leaves nothing behind when a write
  inside the transaction fails" fails, finding the four orphans it is there to catch.

Each mutation was reverted immediately after, and the orphan rows the second one left were removed.

**Left half-done.** Nothing in I1. I2, I3, I5 and I6 are untouched.

**Found.**

1. **`emitDecoratorMetadata` is on, but a controller constructor still needs `@Inject`.** A
   plainly-typed `constructor(private readonly signups: SignupService)` resolved to `undefined` at
   runtime and every request answered 500. Every other controller in this codebase injects by
   token; the new one now does too.
2. **`packages/contracts/test/openapi.test.ts` asserts the exact list of unauthenticated routes**,
   and failed the moment `/v1/signup` was documented. That is the test working — the list is meant
   to be hard to grow — and it now names signup with the reason it is there.
3. **T01 counts records not labelled `MOCK`.** Signup stamped the tenant and not the other three,
   so the integration suite failed on 60 unlabelled taxonomy versions. Fixed at the source, and
   the test file now cleans up the tenants it creates: a suite that writes to the shared database
   and leaves litter eventually fails a _different_ suite, and whoever debugs that wrote neither.
4. **The rate limiter is per address, and behind a load balancer every customer is one address.**
   Express is not configured to trust a proxy, on purpose. A deployment behind one must set
   `trust proxy` **before** this route is exposed, or the whole service shares one bucket of five
   signups an hour. Recorded in D-056; it is a deployment prerequisite, not a code gap.
5. **Signup issues no credential, and nothing yet sets `emailVerifiedAt`.** So a self-signed-up
   tenant today has sandbox only, and still needs its first key from `pnpm key:issue`. Both are
   I2's and I3's work, and the ordering is deliberate: with no per-tenant live budget (D-052), one
   unverified tenant can spend the SEC's whole 120-request hour.

**Next session should:** build **I2** — the customer credential store in our own database,
argon2id (D-051). It owns password reset, lockout, rotation, and the **email verification that
writes `emailVerifiedAt`** — the flag I1 left unset, and the only thing standing between a
self-signed-up tenant and a live key. Note the standing prerequisite from the session before: the
`FIXED_FEED` fetch (once per run, not once per planned query) should land before any live key
reaches a tenant nobody at Adverse Search has spoken to.

**Decisions touched:** **D-055 and D-056 opened and accepted** in this session. D-051, D-052 and
D-053 unchanged and still closed; D-007 unchanged — plans, metering and billing still deferred.

---

## 2026-09-16 (sixth) — Phase I step I4: `disabledAt`, and all three gating decisions closed

**Did.**

1. **I4 is built — a reversible off switch that is not revocation (recorded as D-054).**
   - `ApiKeyRecord` gains `disabledAt` and `disabledReason`, **separate from `revokedAt`**, which
     stays one-way. `ApiKeyService.disable()` and `.enable()` sit beside `revoke()`; both are
     audited with an actor and a mandatory reason, and both are idempotent, so a second call
     writes no second audit entry and the trail keeps saying when the key actually went off.
   - `verify()` refuses a disabled key exactly as it refuses a revoked one — new rejection
     `DISABLED`, still one opaque `401` to the caller.
   - `POST /v1/tenant/api-keys/{keyId}/disable` and `.../enable`, both `@HttpCode(200)` because
     nothing is created. Same ownership check as `DELETE`: another tenant's key answers `404`, not
     `403`. A **revoked** key answers `409 ALREADY_TERMINAL` on both routes.
   - The listing carries `disabledAt`, `disabledReason` and a `DISABLED` status. `status` names
     one reason, ordered by what the holder must act on: `REVOKED` → `EXPIRED` → `DISABLED` →
     `ACTIVE`. A key that was paused and has since expired reads `EXPIRED`, with `disabledAt`
     still set to say it was also paused.
   - Three things that are deliberate and are each tested: a **disabled key can be revoked**
     ("paused" turning out to be "compromised"), a **disabled key can be rotated and stays
     disabled** (disable → rotate → enable is the ordinary sequence), and a **revoked key can be
     neither enabled nor disabled**.
   - Records written before this field existed have no `disabledAt`. Every read goes through one
     helper that reads a missing field as "not disabled" — without it, `undefined !== null` would
     have refused every key already in the database on deploy. There is a test that plants exactly
     that shape.

2. **The three decisions are closed**, answered by the product owner this session. Full records in
   `docs/decisions.md`; the table in `docs/open-decisions.md` is updated.
   - **D-053 — open signup.** No invite code. Both sandbox and live key kinds from day one.
     Payment and live-key approval come later.
   - **D-051 — our own password store, in our database.** Against the recommendation on file,
     which was Keycloak. I2 therefore owns reset, lockout, rotation, MFA and breach response.
     **The instruction said "encrypted"; the decision is recorded as argon2id hashes** — anything
     that can decrypt a password can produce it, which is the same reason API key secrets are
     hashed here. If reversible storage was genuinely meant, that reopens D-051 deliberately.
   - **D-052 — email verification before a live key; no per-tenant live budget.**

3. **Postman and the operator script.** Added `5. Pause it` and `6. Turn it back on` to the full
   collection's key folder (revoke renumbered to 7). `pnpm key:issue --list` now prints `disabled`
   as its own state — it reported a paused key as `active`, which would send an operator looking
   for a fault that is not there.

**Verified.** The stack was already up; everything below actually ran.

```
lint            clean          typecheck       clean
unit            866 passed     invariants      29 passed     evaluation   12 passed
integration     215 passed     security        129 passed    e2e (API)    10 passed
```

Security was 114 before this session; the 15 new tests are the `I4 —` describe block in
`tests/security/api-keys.test.ts`.

**Both halves of the claim were proven by planting the violation, not by watching green:**

- removed the `disabledAt` check from `verify()` → the suite fails;
- let `enable` clear `revokedAt` and dropped its revoked guard → "will not enable a revoked key
  back into service" and "answers 409 rather than reviving a revoked key" both fail.

Each mutation was reverted immediately after.

**Left half-done.** Nothing. I4 is complete; I1, I2, I3, I5 and I6 are untouched.

**Found.**

- **`POST` on a Nest route defaults to 201.** `disable` returned `201 Created` for a call that
  creates nothing — caught by a test expecting 200, fixed with `@HttpCode(200)`. Worth remembering
  for I1's sub-routes.
- **START-HERE's expected test counts had drifted** — it said 829 unit / 106 security against an
  actual 866 / 114 before this session's work. All four figures are now re-measured and updated. A
  stale expected count is worse than none: the next session either "fixes" a phantom regression or
  stops trusting the number.
- **The main Postman collection still described `GET /v1/tenant/api-keys` as "Reserved endpoint →
  501"**, which D-050 made untrue last session. Its test passed only because the collection's
  analyst key lacks `apikey:manage`, so the 403 satisfied an assertion written for a 501. Renamed
  and rewritten to assert the permission refusal it is actually demonstrating.
- **D-052 turns the fixed-feed fetch into a prerequisite, not an optimisation.** With no
  per-tenant budget, one self-signed-up tenant can spend the SEC's whole 120-request hour, and a
  single search currently spends about 41 of them because a `FIXED_FEED` is fetched once per
  planned query instead of once per run. This should land **before** live keys reach tenants
  nobody at Adverse Search has spoken to.

**Next session should:** build **I1** — `POST /v1/signup` creating `tenants`,
`tenantEntitlementVersions`, `taxonomyVersions` and `policyVersions` in **one transaction** via
`TransactionRunner`, with a **generated** tenant id that the request body can never name, and
`environments: ['sandbox', 'live']` on the entitlement. Have live-key issuance read its answer
from tenant state (entitlement plus a verification flag) rather than being unconditional, so that
D-053's later payment gate is a value written into that state and not a hunt for every tenant
created while there was no gate.

**Decisions touched:** **D-051, D-052, D-053 closed.** **D-054 opened and accepted** in the same
session (disable/enable distinct from revoke). D-007 unchanged: plans, metering and billing are
still deferred.

---

## 2026-09-16 (fifth) — Phase I planned: tenant self-service onboarding

**No code. This entry exists so the next session starts in the right place.**

**Did.** Wrote [`phase-i-tenant-onboarding.md`](./phase-i-tenant-onboarding.md) — the brief for
replacing seed-file tenant provisioning with self-service signup. Raised **D-051**, **D-052** and
**D-053** in `open-decisions.md`.

**The target, as instructed.** A customer signs up through the API, sets a password, logs in, gets
a session, and issues their own **sandbox and live** keys with nobody at Adverse Search involved. Keys can
be disabled and re-enabled; newly created keys are active immediately; sandbox and live are
separate credentials. Metering and payment gating come later — both key kinds are available now.

**Start with I4, not I1.** Disable/enable is small, self-contained, useful on its own, and proves
the key-state change before any signup machinery depends on it.

**Three things the brief flags rather than assumes.**

- **D-051 — where the password lives.** Recommendation: **Keycloak**. This service has never
  stored a password; human identity is OIDC end to end and the panel holds no secrets. Building
  our own store means owning reset, lockout, MFA and breach response in a service whose security
  story is that it holds no credentials.
- **D-052 — a self-signed-up tenant with a live key drives real traffic to real publishers under
  _our_ identity.** Our contact URL is in their logs, so a complaint arrives at us; the SEC's free
  tier is 120 requests an hour for the **whole service** and one search spends about 41 of them;
  and every first-contact approval was given on an assumption about use that open signup changes.
  The brief builds it as instructed and proposes two cheap mitigations — email verification before
  a live key, and a per-tenant live budget under the shared one. Neither blocks a real customer.
- **D-053 — open signup or invite-only.** Same endpoint either way, very different abuse surface,
  and retrofitting the check later means retrofitting it around tenants that already exist.

**Do not conflate disable and revoke.** Revoke is one-way on purpose: a leaked key must be
permanently killable. Disable must be a separate, reversible field, or either a leaked key can be
switched back on or a routine pause is irreversible.

**Next session should:** read the brief, get a decision on **D-053** (ten minutes, and it shapes
I1), then build **I4** — `disabledAt` distinct from `revokedAt`, refused by `verify()` the same
way, and visible as its own status in the listing.

**Decisions touched:** D-051, D-052, D-053 opened. D-007 remains only half superseded — D-050 took
key issuance; plans, metering and billing are still deferred.

---

## 2026-09-16 (fourth) — Live search works end to end; tenant self-service keys (D-050)

**Two things happened this session: the live path started returning real findings, and four
defects were found by running it rather than reading it.**

**Did.**

1. **The live path works.** A search against the SEC litigation-releases feed now returns a real
   finding — real request, real feed, real document fetched, extracted, banded. Getting there
   needed a live key, a tenant entitled to live (`tenant-live`, seeded), the SEC source restored
   and activated, and `pnpm dev:live`.

2. **Four defects, each found only by running it.**
   - `GET /v1/admin/sources`, `/taxonomy` and `/policies` returned **500** on any bootstrapped
     stack. `toRecord` cast four timestamp fields straight to `Date`; lifecycle-written records
     store `Date`s and `local-bootstrap` stores ISO **strings**. Normalised at the read boundary.
   - **A successful run reported `FAILED`.** `cascadeCoverageOutcomes` emitted only _gaps_, so a
     rung that answered emptily recorded nothing, and `aggregateRun` read that gap list as a
     census. A run that polled a publisher, got a valid response and found no match was filed as
     a failure. Every rung walked is now named; an `EMPTY` answer records `COMPLETED`.
   - **Every live SEC search returned a false "nothing found".** The planner writes the subject as
     a quoted phrase and appends conduct terms bare (`"Jon P. Kipp" fraud`). Those bare terms are
     hints addressed to a _search engine_; applied as filters against the publisher's own list —
     items titled with just the defendant's name — they discarded the very entry being looked
     for. This was the worst shape a bug here takes: confident, well-formed, entirely wrong.
     Fixed-feed matching now uses the quoted phrases.
   - `POST /v1/searches` accepted **any two characters** as a jurisdiction. `EU`, `ZZ` and `99`
     all returned 202, consumed a job, and surfaced as a run that `FAILED` on polling.

3. **FI-20 written and proven** (`tests/integration/source-halt.test.ts`, six tests): the
   automatic halt and its audit entry commit together, neither lands when the audit write fails,
   and the halt is re-derived from the next identical failure. Verified by planting the
   violation.

4. **Tenant self-service API keys — D-050, superseding the key half of D-007.**
   `POST`/`GET`/`DELETE /v1/tenant/api-keys` are implemented; the `501` stub is gone. A tenant
   holding `apikey:manage` (which `tenant_admin` has) issues, lists and revokes its own keys.

   Three limits, each with a test that fails if removed: **no escalation** (a key carries only
   roles the caller already holds), **no crossing a tenant boundary** (tenant comes from the
   principal; revoking another tenant's key answers 404, not 403), and **no buying live access**
   (a live key needs the tenant entitled to live _and_ the calling credential to be live —
   entitlement is sold by the provider, self-service issues within what was sold).

   `scopesForRoles` moved into `packages/domain` because the operator script and the endpoint
   both derive it, and the copy that drifted would be the one issuing keys quietly wider than
   intended.

5. **Fixtures, registry and Postman.** Five more demo people (an acquittal that survives, a
   conviction corroborated by two publishers, a lone early-stage report, an English case). Rungs
   2 and 4 seeded `PROPOSED` and inert. Separate sandbox and live Postman environments, with
   `environment` now a variable. `SETUP.md`, `TESTING-GUIDE.md`, `ADVERSE-SEARCH-WALKTHROUGH.md`
   and `INTEGRATOR-GUIDE.md` written.

**Verified.**

```
pnpm verify:local   lint · typecheck · unit · invariants · evaluation ·
                    integration · security · e2e (API)      all ok
                    end-to-end (browser)                     n/i — G8, the intended failure
security 26 (was 18)      unit 895+      integration 214
newman: folder 12, 8 assertions, 0 failures
```

Every fix was proven by **reverting it and watching the test fail**, not by watching it pass.

The live run that produced a finding:
`SUCCEEDED / INCOMPLETE / mode LIVE`, one finding, `AMBIGUOUS | MARKET_ABUSE | ALLEGATION`.

**Found.**

- **A `FIXED_FEED` is fetched once per planned query** — about 41 identical requests per run,
  retrieving the same bytes each time and matching each copy against a different query. That
  exhausts the SEC's 120/hour budget in two or three searches, and the symptom is `PARTIAL` /
  `UNRESOLVED` with a rejected lead at stage `FETCH`. It should be fetched once per run and
  matched many times. **This is the most valuable thing left on the live path.**
- **A stale worker silently breaks everything.** The source ladder is assembled at process start,
  so any registry change while it runs is not picked up — and the symptom is not an error, it is
  every search returning `FAILED` with every rung reporting "no approved source".
- `findingsState` says `NO_MATCHES_FOUND` while `findings` holds one entry, because `AMBIGUOUS`
  does not meet the "supported" bar. Defensible, contradictory to read, and an integrator will
  trip on it. Not changed — it is a product decision.
- `pnpm dev` and the test suites consume the same SQS queue and steal each other's jobs.

**Left half-done.** Nothing. The fixed-feed fetch above is a known gap, not a half-built thing.

**Next session should:** fix the fixed-feed-per-query fetch, then **F3 — the eight FR-07
validation rules** in `packages/domain`, pure, from scratch. `grep validateAssertion` still
returns nothing.

**Decisions touched.**

- **D-050 recorded and implemented** — tenant self-service keys, superseding the key-management
  half of D-007. The rest of D-007 stands: plans, usage metering and billing remain deferred and
  still answer 501.
- **The SEC approval was not genuine four-eyes.** It was executed by an automated session using
  the approver credential on the project owner's explicit instruction, and that is written into
  the audit reason verbatim so the trail is not read as independent review. If anything real
  depends on this source, redo the approval with a second person.
- **D6** remains the open decision sitting in the path of any further live source.

---

## 2026-09-16 (third) — Postman is testable end to end with six people; four defects found by running it

**Did.** Ran the collection instead of reading it, which found four real defects, then made the
mock corpus answer to more than one name.

1. **`GET /v1/admin/sources`, `/taxonomy` and `/policies` returned 500** on any bootstrapped
   stack — the first admin request anybody makes. `toRecord` cast four timestamp fields straight
   to `Date`, and the cast was false for half the database: lifecycle-written records store
   `Date`s, `local-bootstrap` stores ISO **strings**, so `.toISOString()` threw. Fixed at the read
   boundary (`versioned-record.service.ts`, `dateOrNull`) rather than per mapper, so the declared
   type stops lying and both call sites are covered. `history.at` one line above had already been
   patched for this same class and the fix was never carried down.

2. **`POST /v1/searches` accepted any two characters as a jurisdiction.** `EU`, `ZZ` and `99` all
   returned 202, consumed a job, and surfaced as a run that `FAILED` on polling. The admin surface
   validated this properly all along; the caller's own entry point did not. `search.ts` now uses a
   real ISO-3166 check and refuses regional groupings by name, sharing `REGIONAL_PSEUDO_CODES` with
   the admin schema so the two cannot drift. OpenAPI regenerated.

3. **A run that produced a finding reported `FAILED / NOT_EVALUATED`.** `aggregateRun` derives
   "did anything answer?" from `sourceOutcomes`, but for the cascade that list is a list of _gaps_
   — `cascadeCoverageOutcomes` filters on `isGap`, so a rung that answered records nothing. The
   only component emitting `COMPLETED` was the company register, so any jurisdiction without one
   reported every source as failed **while returning a finding in the same response**. `anySucceeded`
   now also counts findings and unresolved leads, which cannot exist unless something answered.
   T47 is untouched: a run holding a finding is not one where every source failed.

4. **Two collection defects.** The Source health script did `rows.forEach` on the body, so a 403
   threw `TypeError` and the refusal never surfaced as a failure — it now asserts the status first.
   And the poll loop re-fired itself with **no delay**, so all 30 attempts finished in milliseconds
   and reported "still QUEUED" while the worker was still picking the job up; it now waits between
   attempts. That one made every headless run of folder 3 fail.

5. **A demo cast of six people** (`discovery-fixtures.ts`, `evidence-fetch.mock.ts`). One subject
   proved the pipeline runs; it could not show what the pipeline _says_. Added: an investigation
   **followed by an acquittal** (both come back — the case that matters most), a conviction
   corroborated by two publishers in different words as against the existing syndicated pair, a
   lone early-stage report, and an English-language indictment. `DEMO_SUBJECTS` documents what each
   one is for. Every person, publisher and domain is invented.

6. **The collection is parameterised.** `subjectName`, `subjectJurisdiction` and `subjectLanguage`
   drive both bodies, so testing a different person is one variable rather than an edited body.

7. **The README's role guidance was wrong** and is corrected with a role-per-folder table.
   `GET /v1/admin/source-health` needs `platform:read_health` (`platform_operator`), **not**
   `source_admin`, and no single key runs the whole collection — that is T06 working.

**Verified.**

```
pnpm verify:local   lint · typecheck · unit · invariants · evaluation · integration ·
                    security · e2e (API)      all ok
                    end-to-end (browser)      n/i — G8, the intended failure
integration 214 (was 213)   unit 865   invariants 29
newman, full collection: 76 requests, 45 test scripts, 0 assertion failures
newman, folders 2→3→4 for each of the six people: 0 failures, 5 assertions each
```

Fix 1 was proven by reverting it — the regression test fails with
`expected '2026-09-10T…' to be an instance of Date` and passes when restored.

**Found.**

- **`pnpm dev` and the test suites fight over the same SQS queue.** Running `verify:local` with
  `pnpm dev` up fails `integration` for no visible reason: both workers consume the same queue and
  steal each other's jobs. It passed alone and failed under the gate purely for this. Added to the
  README troubleshooting table.
- **The seeded source covered `CR, GB`; the seeded taxonomy enabled `CR, US`.** A lead only
  survives the fetch gate where the two overlap, so the only English demo possible was refused
  either as `SOURCE_DOES_NOT_COVER_JURISDICTION` (US) or `JURISDICTION_NOT_ENABLED` (GB). Both
  refusals were correct; the fixture was claiming to serve `en` while covering nowhere `en` could
  be searched. The fixture source now covers `CR, GB, US`.
- **`sources: 0` on every finding.** The findings come back with an empty source array in the
  wire shape I read them through. Not investigated — it may be the field name in my probe rather
  than the payload. Worth ten minutes before anybody demos evidence provenance.

**Left half-done.** Nothing from this session. The 409 on the source-registry **approve** request
is still unexplained — it is a revision conflict from a stale `recordRevision` collection variable,
**not** four-eyes, and it was left alone because chasing it means approving the SEC source, which
is the decision below.

**Next session should:** build **F3 — the eight FR-07 validation rules** in `packages/domain`,
pure, from scratch. `grep validateAssertion` still returns nothing. Unchanged from two entries ago.

**Waiting on you.** Unchanged, and still not engineering:

1. **A second named person** for four eyes (SEC-06). Two `source_admin` keys now exist —
   `4f93491691d8c22e` (proposer) and `b49936006e34f1ae` (approver) — but the check compares
   credentials, not humans, so the second identity existing is not the same as a second person
   deciding.
2. **`pnpm first-contact`**, which the project owner runs, then `robotsPosition` from what
   robots.txt actually said, then propose → approve → activate. The propose and submit steps were
   exercised this session against the real API and both returned 201.

**Decisions touched:** none closed. **D6** is still the decision sitting directly in the path of
step 2 above. A one-off three-role smoke key was issued to run the whole collection at once and
**revoked immediately**; the README says not to keep one, because it is exactly the combination
the roles exist to separate.

---

## 2026-09-16 (later) — FI-20 written and proven; the two stale Postman documents corrected

**Read this first. Every engineering blocker on the live Postman path is now closed. What
remains is three things only you can do, listed at the bottom.**

**Did.** Two things, in this order, and nothing else.

1. **Corrected two documents that had gone stale within a day and would have misled the next
   reader.** `postman/README.md` still carried a section headed "What blocks a live run today"
   saying live mode has no extractor and the pipeline hands raw HTML to it. Both were closed
   earlier the same day by D-048 and D-049. Anyone following it would either not attempt a live
   run at all, or would read a genuine live result as the known blocker. That section is now
   "What a live run will and will not tell you", and it states the three things that are actually
   true of the rule-based extractor and are easy to misread as absence: **recall has never been
   measured**, the term tables are **English and Spanish only**, and **every finding it produces
   is undated** because the four FR-07 date fields are not parsed. `docs/TODO-E2E.md` had the
   relevance filter (D-047) still unchecked, and its "real extraction" row still described live
   mode as having none; both corrected, and the missing FR-07 date-field work is now its own row
   rather than a sentence inside another one.

2. **`tests/integration/source-halt.test.ts` — FI-20, six tests.** The row was on the checklist as
   "write this first, before anything is polled live", and it was still unwritten while the live
   path was otherwise ready. `grep stop_condition_halt` returned exactly one hit — the service
   that writes it — so the automatic-halt persistence boundary had no integration coverage at all.
   The pure half (`applyObservedFailure`) was already covered in `apps/api/test/fetch-tripwires.test.ts`;
   what was missing is the half only a real replica set shows.

   What it asserts: the halt and its audit entry both land when a recorded stop condition fires;
   **neither** lands when the audit write fails; the same refusal re-derives the halt afterwards,
   which is what bounds FI-20's window to one request rather than forever; a re-derived halt
   **keeps the first record** rather than moving the timestamp an operator was alerted about; the
   halt refuses at the point of use through a freshly constructed service as `SUSPENDED` carrying
   the reason verbatim; and the shared `__platform__` hash chain still verifies afterwards.

**Verified.** Everything below was run in this session against the real stack, started for the
purpose (Docker was not running; `local:up` then `local:bootstrap`):

```
pnpm verify:local
  lint · typecheck · unit · invariants · evaluation · integration · security · e2e (API)  all ok
  end-to-end (browser)  n/i — G8, the intended failure; verify:local exits non-zero
integration   213  (was 207; +6 new)        API e2e   10
```

**The FI-20 suite was proven by planting the violation, not by watching it pass.** Moving the
health write out of the transaction in `source-health.service.ts` makes exactly the two
atomicity tests fail — a halted source persisted with no audit entry explaining it — and
restoring it makes all six pass. A test that has never failed proves nothing.

**No live source was contacted, and `pnpm first-contact` was not run.**

**Left half-done.** Nothing. Both items finished.

**Found.**

- **The suite deliberately deletes nothing from `auditEvents`.** A halt writes to `__platform__`,
  which is a hash chain, and no test had ever written to that chain before this one. Removing an
  entry from the middle of a chain to tidy up is precisely the tampering the chain exists to
  detect, and would leave every later verification failing for a reason nobody could find. The
  entries are real platform events, they stay, and the suite asserts the chain still verifies on
  the way out. Source state is this suite's own and is cleaned up as usual.
- The seeded version is written in the **nested `content` shape** the admin lifecycle produces
  rather than the flat shape the older fixtures use. `versionFacts` reads both; seeding the flat
  shape would have tested the compatibility branch instead of the real one.
- `RATE_LIMITED` exists in `packages/contracts` and the OpenAPI document lists 429 on
  `POST /v1/searches`, but **nothing throws it** — confirmed by grep, not inferred. A Postman
  test for 429 cannot pass today, and a looping caller is unbounded. Already on the list as a
  Group 4 item; noted here because it is the kind of thing a first integrator finds.

**Next session should:** build **F3 — the eight FR-07 validation rules** in `packages/domain`,
pure, from scratch. `grep validateAssertion` still returns nothing. Unchanged from the previous
entry: the brief puts the validator before the model deliberately, because rules written after a
model get written around whatever that model produced.

**Waiting on you, not on code.** This is now the whole of what stands between the project and a
live Postman run, and none of it is engineering:

1. **A second named person.** Taking the SEC source live is four eyes — the proposer cannot be
   the approver (SEC-06). Nothing in the sequence below can start without this.
2. **`pnpm first-contact` against the SEC feed.** One `GET https://www.sec.gov/robots.txt`,
   requires `--yes-contact-the-sec`. It has never been run, and the project owner runs it — not a
   session. Then `robotsPosition` updated on **what robots.txt actually said**, then propose →
   approve → activate.
3. **A subject actually present in the SEC feed** on the day of the demo. It is a `FIXED_FEED`:
   the name never reaches the SEC, the feed is polled whole and matched locally, so a Costa Rican
   name against it gives a correct, well-reasoned `NO_MATCHES_FOUND`.

**What the first live run will honestly report**, unchanged: coverage `INCOMPLETE`, most rungs
unsearched, one live source, US and English only, every fixture source refused, a warning that
the extraction was rule-based and unbenchmarked — and every finding undated.

**Decisions touched:** none closed. **D6** (how robots exceptions are approved and recorded,
owner source admin, due G6) is now the decision directly in the path: step 2 above writes a
`robotsPosition` that permits fetching, and D6 is the rule governing that write. **D4** still has
a waiting input — the two Costa Rican sanctions spreadsheets, no file paths supplied. **D7** open
and still not on the critical path.

---

## 2026-09-16 — Phase F, the two engineering P0s for the live path

**Read this, then [`phase-f.md`](./phase-f.md) §4 for what comes next. The live path's remaining
blockers are not code.**

**Did.** Both P0 items from the previous entry, and nothing else.

1. **The live rule-based `ExtractionModelPort` (D-048).**
   `apps/api/src/sources/rule-based-extraction.adapter.ts` — a **non-mock** adapter, `mode: 'LIVE'`,
   `modelId: null` and `promptVersion: null` on the adapter and on every assertion it emits. Wired
   into `sources.registry.ts`, which returned `extractionModel: null` before. The mock is
   untouched: still `mode: 'MOCK'`, still `jurisdictions: ['CR']`, still requires a
   `MockModeWitness` a live process cannot construct (T55).

   Two rules beyond what D-048 asked for, both in the adapter's header and both tested.
   **Proximity, not presence:** a conduct or stage term counts only within 600 characters of one
   of the subject's name forms, because a presence test over a whole page attributes its sidebar
   and its "related articles" list to whoever the page happens to name. **An outcome wins:** where
   an acquittal and a charge are both near, the acquittal is taken — D-047's rule reaching
   extraction, since taking the earliest or the highest match would systematically report the
   accusation and drop the exoneration. Name matching is word-bounded, so "Ana" no longer matches
   inside "Santana".

2. **A missing extractor is now a configuration fault** (`search-pipeline.service.ts`). A null
   fetch or extraction adapter produces a `SKIPPED` coverage outcome named `capability:extraction`
   (or `capability:fetch`), a run warning saying in words that it is a misconfiguration and not a
   result, and a rejected lead at **the stage where it actually stopped** — it used to say `FETCH`
   even when the fetcher existed and the extractor did not. Extraction `FAILED` is now also
   distinct from "read it and it said nothing", per D-046's rule.

   And because a reader of a result cannot see the adapter: **every run using an extractor with a
   null model id now carries a warning** saying the extraction was rule-based, that its recall has
   never been measured, and that a category it has no term for returns nothing rather than failing.

3. **F1 normalisation and charset (§3.2, recorded as D-049).**
   `apps/api/src/pipeline/normalise-document.ts` replaces `new TextDecoder().decode(body)`. Markup
   is stripped (script and style contents dropped whole, block elements become line breaks, inline
   elements do **not** split a word, character references decoded, whitespace collapsed); the
   charset comes from a BOM, then the `Content-Type` parameter, then `<meta charset>` or the XML
   declaration, then a recorded default; **nothing is sniffed**; and every output character carries
   the index of the original character that produced it. `mapSpanToOriginal` converts a span. A
   finding now records `textNormalisation` (charset, which declaration said so, normaliser version)
   and `originalSpans`, so a surface showing the stored bytes can highlight the same passage.

**Verified.** Everything below was run in this session, with the local stack already up:

```
lint · typecheck               clean
unit          865  (was 829; +36 new)      invariants   29      evaluation   12
integration   207      security   106      API e2e      10
```

The four suites that need infrastructure were run against the running stack, not skipped. **No
live source was contacted, and `pnpm first-contact` was not run.** The extractor was exercised
only against strings written in its own test file and against the existing fixtures.

**Left half-done.** Nothing is half-built, but F1 is only half-**done**: PDF and OCR are not
built (such a body is reported as unreadable rather than decoded as if it were text), no
boilerplate removal is attempted, and **the four FR-07 date fields are still never parsed** — the
rule-based extractor leaves all four null, which is correct under FR-07 and means every finding it
produces is undated. That is the rest of F1 and it is listed as such in the brief's checklist.

**Found.**

- The mock fixtures are HTML, so normalisation changes what the **mock** extractor sees too. It
  still finds everything it found before — checked directly against the fixture bodies, and the
  207 integration tests still produce findings — but a fixture written to be found by an offset
  will now be found at a different offset.
- `apps/api/test/source-adapters.test.ts` asserted `live.extractionModel` was null. That assertion
  was the old behaviour, not a safety property, and it now asserts the opposite plus the two
  things that **are** safety properties: the adapter is not the mock, and its model id is null.
- The rule-based extractor's term tables are English and Spanish. A document in any other
  language yields no assertions, and that reads as "nothing found" rather than as "not read". It
  is the same blindness as the unreviewed Spanish lexicon (D-033) and it is not fixed here; the
  run-level warning about unbenchmarked rule-based extraction is the only thing currently saying
  so.

**Next session should:** build **F3 — the eight FR-07 validation rules** in `packages/domain`,
pure, from scratch (`grep validateAssertion` still returns nothing), each with a test proving it
rejects its own failure case. The brief's execution order puts the validator before the model
deliberately: rules written after a model get written around whatever that model produced. The
rule-based extractor is now a real thing for those rules to be applied to.

**Waiting on the user, not on code** — unchanged from the previous entry, and now the **only**
thing between this project and a live Postman run:

1. `pnpm first-contact` against the SEC feed. **It has never been run, and the project owner runs
   it — not a session.** Then `robotsPosition` updated on what robots.txt actually said, then
   propose → approve → activate with four eyes.
2. A subject actually present in the SEC feed for the demo. It is a `FIXED_FEED`: the name never
   reaches the SEC, the feed is polled whole and matched locally. A Costa Rican name against it
   gives a correct, well-reasoned `NO_MATCHES_FOUND`.
3. Verified endpoints and named first-contact approvals for rungs 2, 3 and 4.
4. The two Costa Rican sanctions spreadsheets — list matching, not adverse media (**D4**).

**What the first live run will honestly report**, unchanged: coverage `INCOMPLETE`, most rungs
unsearched, one live source, US and English only, every fixture source refused — plus, now, a
warning that the extraction was rule-based and unbenchmarked.

**Decisions touched:** **D-048** implemented, with a "Built" section added recording the two rules
added while building it. **D-049 recorded** — normalisation is ours, the charset is the
publisher's, nothing is sniffed. **D7** still open and still blocked on a corpus; it is not on the
critical path. D9 and D4 open and due at G7.

---

## 2026-09-15 (session close) — **Start here: the live extractor is the one thing blocking a live Postman search**

**Read this, then [`phase-f.md`](./phase-f.md) §3.3, then start work. Nothing else is needed to
begin.**

**Did.** No code. This session finished the FR-06 relevance filter (D-047), expanded Phase F into
a real brief, then traced the live path end to end to answer "what do we need for a Postman e2e
against real sources". That trace found the blocker below. Documents updated: `phase-f.md`,
`START-HERE.md`, `implementation-status.md`, `open-decisions.md`, `postman/README.md`,
`decisions.md` (**D-048**).

**State of the tree.** Clean, committed, green:

```
lint · typecheck · format     clean
unit          829      invariants     29      evaluation     12
security      106      integration   207      API e2e        10
```

`pnpm verify:local` still fails by design — the browser e2e suite is unimplemented and exits
non-zero rather than passing vacuously. **No live source has been contacted by this project.**

---

### The blocker

`sources.registry.ts:209` returns `extractionModel: null` in live mode.
`search-pipeline.service.ts:477` rejects the document when the extractor is null.

So a live run today does everything right — discovers real leads, filters them through FR-06,
passes the fetch gate, opens a real socket, commits real evidence — and then rejects **every
document** at `EXTRACTION`, ending `SUCCEEDED / NO_MATCHES_FOUND / INCOMPLETE`.

**To anyone reading that result it is indistinguishable from "the source had nothing on this
person"**, and the coverage statement says the source was searched, because it was. That is the
worst shape a failure can take in this product.

The null was not wrong when written — it was honest, and returning the **mock** in live mode would
have been far worse (T55). The defect is that an honest null produces a dishonest-looking result.

**Discovery is fine.** `ladder.builder.ts:271` builds live `RssNewsDiscoveryAdapter` and
`GdeltDiscoveryAdapter` instances per activated source. Extraction is the only null.

**D-048 decides it.** Read it before building: a non-mock rule-based adapter with `modelId: null`
and `promptVersion: null`; the mock stays `mode: 'MOCK'` / `jurisdictions: ['CR']` so a fixture can
never serve a live run; and a missing extractor becomes a loud configuration fault in warnings and
coverage, never a finding count of zero. D-048 also states what rule-based extraction costs, which
is real, and why "rule-based" must not become permanent by default.

---

### Priority order for a live Postman e2e

| P      | What                                                          | Whose            | Notes                                                                                                                                          |
| :----- | :------------------------------------------------------------ | :--------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | Live rule-based `ExtractionModelPort`                         | Engineering      | D-048. Unblocks everything below. Small.                                                                                                       |
| **P0** | F1 normalisation + charset                                    | Engineering      | phase-f.md §3.2. SEC serves real HTML; today the pipeline hands **markup** to the extractor, and `TextDecoder()` ignores the declared charset. |
| **P1** | `first-contact` → `robotsPosition` → propose/approve/activate | **Source admin** | Four eyes; proposer ≠ approver; reason mandatory (SEC-06).                                                                                     |
| **P1** | Search a subject actually in the SEC feed                     | Demo runner      | See below.                                                                                                                                     |
| **P2** | One `QUERY_FEED` source (rung 2 or 4)                         | Source admin     | Only if you want name search to reach a publisher. **No code** (D-046) — a verified endpoint and a named approval.                             |

**Not on the critical path:** D7 model selection, the extraction benchmark corpus, FR-10
clustering, F5–F7. Clustering matters for band correctness — a syndicated copy still counts as a
second independent source on axis D — but with one live source there is nothing to cluster.

### The thing that will look like a bug and is not

**The SEC feed is not searchable by name.** The record is `endpointKind: 'FIXED_FEED'`,
`queryParam: null` — the litigation-releases list, not a search endpoint. The name never reaches
the SEC; the feed is polled whole and matched locally
(`rss-news-discovery.adapter.ts:302`). Search a Costa Rican name against it and you get a correct,
well-reasoned `NO_MATCHES_FOUND`. **For a first live demo that shows a finding, take a defendant's
name from the feed as it stands that day.**

And coverage will report `INCOMPLETE` — one live source, US and English only, every fixture source
refused, most rungs unsearched. That is truthful, not broken. A live stack reporting `COMPLETE`
here would be the thing to worry about.

### Two more blockers, further out (both in phase-f.md §3)

- **D7 cannot be closed as written.** It says "benchmarked on the labelled set"; the labelled set
  has **no document bodies**. A labelled extraction corpus has to be built first — options and a
  recommendation in §3.1. D-048 is what stops this blocking the live path.
- **Build the FR-07 validator before the model** (F3 before F2). Rules written after a model get
  written around whatever it produced. **No FR-07 validation module exists anywhere in the repo** —
  `grep validateAssertion` returns nothing. From-scratch, in `packages/domain`, pure.

**Next session should:** run the health check in `START-HERE.md`, read D-048, then build the live
rule-based `ExtractionModelPort`. Then F1.

**Waiting on the user, not on code:**

1. Verified endpoints **and named first-contact approvals** for rungs 2, 3 and 4.
2. The source list as `name | endpoint URL | countries | languages | kind`.
3. SEC live activation — `pnpm first-contact` is written and has **never been run**.
4. The two Costa Rican sanctions spreadsheets. **List matching, not adverse media** — open
   decision **D4**, due at this gate. No paths supplied yet.

**Decisions touched:** **D-048 recorded.** **D7** re-raised with its real blocker and marked off
the critical path. D9 and D4 open and due at G7. D15 still the nearer blocker for live Costa Rican
sources.

---

## 2026-09-15 (end of day) — **Session close: Phase E paused, extraction is next**

**Read this one first if you are starting cold, then read
[`phase-f.md`](./phase-f.md), which was expanded into a real brief today.**

**Did.** Nothing new built. This entry exists to hand over cleanly. The work of the day is in the
two entries below it: live mode and rungs 3–4 (D-046), then the FR-06 relevance filter (D-047).

**State of the tree.** Clean, committed, everything green:

```
lint · typecheck · format     clean
unit          829      invariants     29      evaluation     12
security      106      integration   207      API e2e        10
```

`pnpm verify:local` still fails by design — `end-to-end (browser)` is unimplemented and exits
non-zero rather than passing vacuously.

**Still true, and check it is still true before you claim otherwise: no live source has been
contacted by this project.**

---

### What the next session is starting: the extraction model (Phase F)

The pipeline currently calls `MockExtractionModel` — rule-based, keyword-driven, honest about it
(`modelId` and `promptVersion` are null on every assertion). It only ever finds what its keyword
table already knows, so **the pipeline has never been run against extraction it could be
surprised by.** That is the single biggest thing between here and a Postman result worth
believing.

**`docs/execution/phase-f.md` is now a full brief, not the outline.** It carries the execution
order, the exact files, and the two blockers below. Work from it.

### Two blockers I found while writing that brief — both would cost hours if hit cold

**1. D7 says "benchmarked on the labelled set". The labelled set has no document text.**
`packages/evaluation/src/dataset/seed.ts` has 16 cases carrying document _metadata_ and the _axis
inputs_ a pipeline would produce — by design (D-005), because that is the seam that lets
`runAllInvariants` run against real output without touching the harness. But there are **no
bodies**, so there is nothing to extract from and D7 cannot be executed as written. A labelled
**extraction** corpus has to be decided and built first. Three options and a recommendation are in
phase-f.md §3.1. **Do not start F2 before it is settled** — the benchmark's shape determines the
adapter's whole test surface.

**2. The pipeline hands raw HTML to the extractor and calls it normalised text.** One line in
`search-pipeline.service.ts` (~665):

```ts
const text = new TextDecoder().decode(fetched.data.body);
```

- **No normalisation.** `ExtractionInput.text` is documented as normalised text with the caller
  holding the offset map. There is neither. Spans therefore point into **raw HTML** — every offset
  shown to a reviewer, and every offset the FR-07 validator would check. Hidden only because the
  fetch fixtures are effectively plain text; the first real HTML page breaks it.
- **No charset handling.** `TextDecoder()` is UTF-8 and ignores the declared charset. A Spanish
  page served as ISO-8859-1 — common on Latin American news sites — decodes to mojibake and name
  matching silently stops matching. Same failure class as the `María` → `Mar?a` shell issue in
  `postman/README.md`, and the same symptom: a clean `NO_MATCHES_FOUND` that reads as an absence
  of news.

Both are **F1**, which is why F1 comes before any model work.

### One more thing the brief changes: build the validator before the model

The outline numbers validation F3, after the model at F2. Work it **F1 → F3 → F2**. The eight
FR-07 rules are what make a model's output checkable, and written second they get written against
whatever the model happened to produce; written first they are its acceptance criteria. Note that
**no FR-07 validation module exists anywhere in the repo** — `grep validateAssertion` returns
nothing. It is a from-scratch step in `packages/domain` (pure, no I/O), not a wiring step.

**Next session should:** run the health check in `START-HERE.md`, then open `phase-f.md` and start
**F1** — the normalisation and charset fix at `search-pipeline.service.ts` ~665, with an offset
map so spans point into text rather than markup.

**Waiting on the user, not on code** (unchanged, none of it blocks extraction):

1. Verified endpoints **and named first-contact approvals** for cascade rungs 2, 3 and 4. The
   three registry records are inert templates and stay refused until someone checks the addresses.
2. The source list as `name | endpoint URL | countries | languages | kind`.
3. SEC live activation — `pnpm first-contact` is written and has never been run.
4. The two Costa Rican sanctions spreadsheets. **List matching, not adverse media** — that is
   open decision **D4**, due at this same gate. No paths supplied yet.

**Decisions touched:** none closed. **D7** and **D9** are the two due at G7 and both are open;
**D4** is also due at G7. **D15** remains the nearer blocker for live Costa Rican sources.

---

## 2026-09-15 (late) — **The FR-06 relevance filter** (D-047)

**Did.** `packages/domain/src/planning/relevance.ts` — pure, nine FR-06 signals, `assessRelevance`.
Wired into `SearchPipelineService.discover()` between the ladder walk and the fetch gate. Added
`RELEVANCE` to the rejected-lead `stage` enum in `packages/contracts` (regenerated
`openapi/openapi.json`) and to `findings.service.ts`. Added `lead-nonarticle-0001` to the mock
discovery fixtures. D-047 in `docs/decisions.md`.

**Verified.** lint, typecheck, format clean. 829 unit, 29 invariants, 12 evaluation, 106
security, **207 integration (207/207 — the Meilisearch write-visibility test that flaked last
session passed both runs today)**, 10 API end-to-end. No live source has been contacted.

**Found — the mistake worth reading, because it will look reasonable again.**

My first draft made _"the subject's name appears in the title or snippet"_ a **categorical
rejection**. The mock fixtures caught it within minutes: every lead refused, every run returning
zero findings, integration at 204/206.

It was not a fixture problem. The FR-04 plan has **company-anchored query families**, which exist
precisely to find documents naming a _company_ the subject is associated with — the fixture
headline is _"Fiscalía acusa a directiva de Inversiones Talamanca por presunto fraude"_, which
names the company and the role and not the person. Refusing those deletes the entire association
half of the product, **silently**, while the coverage statement still says the sources were
searched. A headline is also not the document: a name absent from a headline is routinely in the
second paragraph. FR-06 lists the name as a _signal_ and makes only the window a _gate_; I had
promoted it. It is now a missing positive signal and the score reflects it.

**Found — a filter that never fires looks exactly like one that was never wired in.**

With that fixed, nothing in the mock corpus was refused at all, so no mock run exercised the
filter end to end. Added `lead-nonarticle-0001`: a tag page, a real URL on a real publisher,
naming the subject, with no article behind it — what web search returns constantly. There is
**deliberately no document at that URL** in `evidence-fetch.mock.ts`, so deleting the filter
turns the lead into a 404 and an INCOMPLETE run rather than a quiet pass. The new integration
test asserts it is refused at `RELEVANCE` and **not** at `FETCH`, because a 404 there would mean
the request was made before the candidate was judged.

**Left half-done.** Nothing in this change. The score is uncalibrated by construction
(`FR06_NINE_SIGNAL_UNCALIBRATED_v1`, `minimumScore` defaults to 0 so it gates nothing) and stays
that way until FR-16 produces a labelled corpus. Recall is deliberately favoured over precision
meanwhile: over-fetching costs requests, over-refusing costs findings nobody would know were
missed.

**Next session should:** pick up the remaining TODO groups — the extraction model (**D7**, still
open and now the largest gap between here and a useful e2e result), then FR-10 clustering.

**Still waiting on the user, not on code:**

1. Verified endpoints **and named first-contact approvals** for rungs 2, 3 and 4. The three
   registry records are inert templates (`firstContactApproval: null`, `robotsPosition:
NOT_ESTABLISHED`) and stay refused until someone checks the addresses.
2. The source list in the agreed shape: `name | endpoint URL | countries | languages | kind`.
3. The SEC live activation — `pnpm first-contact` is written and has never been run.
4. The two Costa Rican sanctions spreadsheets. **That is list matching, not adverse media** —
   open decision **D4**, and no paths supplied yet.

**Decisions touched:** **D-047 recorded.** D7 and D4 still open.

## 2026-09-15 (evening) — **Group 1, the cascade**: the FR-05 ladder, and mock mode stops flattering itself

**Context.** The parser, both breakers, the D17 stop conditions and the RSS connector were all
built earlier in the day and **nothing called them**. This is the piece that joins them to the
pipeline. Also ran the integration and security suites for the first time, and built the API
end-to-end suite.

---

### Two suites that had never been run

206 integration and 106 security tests, all passing. They were the largest untested surface in the
repo and needed two commands with the stack up.

### The API end-to-end suite — `pnpm test:e2e:api`

Ten tests. In through the HTTP door and out through it, with the real outbox, the real SQS queue
and a real worker in between. `tests/integration/pipeline.test.ts` drives the handler directly,
which is right for what it asserts — but nothing proved the pieces were _joined_.

**It is not the browser e2e suite and `pnpm test:e2e` is still red.** That one is G8 and mostly
lives in the frontend repo. Pointing it at this suite would have made `verify:local` green and
been exactly the failure `verify-local.mjs` says it exists to prevent, so there are two entries
now and one is honestly unimplemented.

Two things writing it exposed, both worth keeping:

- **Starting only the worker leaves every search at `QUEUED`.** `OutboxPublisher` turns the
  committed row into an SQS message and only `main.ts` starts it. Either process missing gives the
  identical symptom and no log line explaining it.
- **The `afterAll` hook timed out at Vitest's 10s default while every test passed.** The consumer
  long-polls SQS with `WaitTimeSeconds: 20`, so a drain takes that long.

### The cascade — D-045

`packages/domain/src/planning/cascade.ts` is the FR-05 table and every decision about it, pure,
23 tests. `CascadeService` does the I/O and nothing else. `LadderBuilder` reads the registry.

**Two things FR-05 does not say had to be decided.**

**What happens on success.** The table only says what happens on _failure_. This walks the whole
ladder rather than first-hit-wins, and the reason is axis D: FR-11 grants `CORROBORATED` on two
independent Tier 2–3 sources, and stopping at the first rung that returns something makes that
clause structurally unreachable. The banding engine would carry a rule it could never satisfy.

**What is on the ladder.** A source sits at **the rung its approved version records**, read fresh
every run. Approving a source at rung 2 puts it on the ladder; retiring its version removes it.
Same rule as D-043 one level up.

**The distinction the whole thing exists to keep:** a source that answered "nothing" is not a gap;
a rung with nothing behind it is. `EMPTY` produces no coverage outcome, `NO_SOURCE` produces a
`SKIPPED` one naming the rung as unsearched, `FAILED` stays `FAILED` so nobody investigates an
outage at a publisher that is working.

### What changed visibly, verified against the running stack

Mock mode now **admits it searches two rungs of seven**. A real search over HTTP returns the same
2 findings it always did, and its coverage now names rungs 0, 1, 3, 4 and 6 as unsearched, by
name. Before this, discovery reported one line and the run looked considerably more thorough than
it was.

Also corrected: the mock web adapter serves rungs 5 and 6 and was **seeded at rung 3**, so mock
mode was rehearsing a ladder that does not exist.

### Verified

```
lint / typecheck / format   clean
unit            777   (was 754)
invariants       29
evaluation       12
integration     206
e2e-api          10
```

Plus a real HTTP search returning 2 findings with per-rung gaps in its coverage.

`verify:local` passes everything except the browser e2e suite, and fails on that, correctly.

### Left half-done

- **Rung 0 has no adapter** and reports unsearched on every run. There is no feed poller. That is
  deliberate — an empty local index that always answered "nothing" would convert a missing
  capability into a clean answer — but it is a real gap in what the ladder can reach.
- **Rungs 3 and 4 have no adapter either.** GDELT is JSON and needs no XML parser; Bing News RSS
  can reuse `RssNewsDiscoveryAdapter` unchanged. Both are now small: the ladder will pick them up
  from the registry the moment a source is approved at that rung.
- **`RssNewsDiscoveryAdapter` is still not constructed in live mode.** `buildSourceAdapters`
  returns an empty news list, so a live process has an empty ladder. Building one adapter per
  approved RSS source is the remaining wiring, and it needs the registry read that `LadderBuilder`
  already does — the two should probably meet.
- **The relevance filter (step 4) is still not built**, so every discovered lead goes to the fetch
  gate.

### Next session should

1. **Construct `RssNewsDiscoveryAdapter` per approved source in live mode.** Without it the live
   ladder is empty and every rung reports unsearched — honest, and useless.
2. Then Group 2: propose/approve/activate the SEC source, and the first `GET /robots.txt`.

### Decisions touched

**D-045** added. **D-043** extended in spirit: not just a source's address but its _position_ on
the ladder is registry content.

## 2026-09-15 (late) — **Group 0 of the E2E plan**: the API is callable, and two defects the docs were hiding

**Context.** The earlier part of this session built the XML parser, both breakers, the D17 stop
conditions and the RSS connector. This part made the service **actually usable by a person**, and
then ran it to find out whether that was true.

---

### The gap was not capability

`ApiKeyService` already did create, verify, rotate, revoke, list and audit, all tested. There was
simply **no way to reach it** without writing a throwaway script against Mongo — which is what
`demo-api.mjs` does, and what anyone wanting to try the API had to copy.

**`pnpm key:issue`** fills that. It is a **script and not an endpoint on purpose**:
`POST /v1/tenant/api-keys` returns 501 because **D-007** defers the commercial self-service layer
and records that keys are provider-managed this phase. A script an operator runs is what
provider-managed means; building the endpoint would have quietly closed a decision nobody has
taken. It imports the **compiled** service rather than reimplementing the hashing, so the key it
mints is the key the API accepts, and it carries the same local-only guard as `local:bootstrap`.

Also added: a Postman collection and environment, `postman/README.md`, and a "Calling the API"
section in the root README.

### Then it was run, and it did not work

Both defects are the kind that only surface when you run the thing.

**1. `dev:api` and `dev:worker` could not start at all.** They ran `node dist/main.js` directly and
nothing loaded `.env`, so the boot-time configuration check refused — correctly — for want of five
variables. Only `pnpm dev` loaded the file, and it started the API alone. The path documented in
the README and in `postman/README.md` was broken, and the failure read as a configuration mistake
by the reader rather than a missing step in the script.

The refusal stays; it is right. A service that starts with a missing session secret generates one,
and a generated session secret is a session that survives a restart by accident. What was wrong was
that nothing supplied the values. Both now go through `scripts/dev.mjs`, and **`pnpm dev` runs the
API and the worker together** — which also keeps the "search sits at QUEUED because nothing is
consuming" state visible instead of mysterious.

**2. `key:issue` issued keys with no scopes.** The comment claimed empty meant "whatever the roles
allow". It means **nothing**: scopes narrow a machine key below its roles and never widen it. The
key created a subject and was then refused the search with `MISSING_SCOPE`. Scopes are now derived
from the roles, printed on issue, and narrowable with `--scope`. The vocabulary
(`search:read`, `search:write`, `admin:read`, `admin:write`) was read off `@RequireScope` across
the controllers rather than invented.

### Verified — against a real stack, not asserted

```
pnpm local:up && pnpm local:bootstrap     stack healthy, seeded
pnpm dev                                  API + worker both start
pnpm key:issue                            key issued, scopes printed
POST /v1/subjects                         201
POST /v1/searches                         202
GET  /v1/searches/{id}                    QUEUED → SUCCEEDED
GET  /v1/searches/{id}/findings           2 findings, 1 rejected lead
```

The findings carried bands (`SUPPORTED`), categories (`FRAUD_FINANCIAL_CRIME`), procedural stages
(`CHARGE_INDICTMENT`) and publishers. `mode: MOCK` throughout. The startup user-agent assertion
added earlier in this session logs on every boot.

Non-live gate unchanged: lint clean, typecheck clean, format clean, **754 unit**, 29 invariants,
12 evaluation.

### Found, documented rather than fixed

**The first run returned `NO_MATCHES_FOUND`, and the service was right.** The Windows shell mangled
`María` into `Mar?a` in the request body; it folded to `mar a` and matched no fixture. Postman
sends UTF-8 correctly so the collection is fine, but it is now in the troubleshooting table,
because it generalises: **a name that loses its accents in transit is a name the service will
honestly report as not found**, and that looks like a matching bug when it is an encoding one a
layer up.

**The first search also returned `SUCCEEDED` + `NO_MATCHES_FOUND` + `INCOMPLETE`** — the exact
combination every document warns about. The `noMatchStatement` said what was searched, that both
languages are unmeasured, and that the Spanish term list is unreviewed. It behaved as designed.

### Left half-done

- **Group 1 is the next work and is untouched**: the seven-rung cascade, making
  `SourceAdapterSet.newsDiscovery` a list, and wiring `RssNewsDiscoveryAdapter` into the
  composition root. The connector is built and tested and **nothing calls it**.
- **The integration and security suites were still not run.** The stack was up this session, so
  this was possible and was not done. Do it first next session — it is two commands.
- **`docs/implementation-status.md` is still stale** (lists G0–G3, says the integration and
  security suites are unimplemented). The README's stale parts were fixed; that file was not.

### Next session should

1. Run `pnpm test:integration` and `pnpm test:security` with the stack up. Two commands, and they
   are the largest untested surface in the repo.
2. Build the cascade (Group 1). The parser, both breakers, the stop conditions and the RSS
   connector are all in place and unwired; the cascade is what joins them to the pipeline.
3. Then Group 2 — the first live request, which is one `GET /robots.txt`.

### Decisions touched

None closed. **D-007** was read and honoured rather than worked around: key issuance is a script
because that decision says keys are provider-managed in this phase.

New docs, for a reader who is not an engineer: `docs/SIMPLE-STATUS.md`, `docs/SIMPLE-FLOW.md`,
`docs/TODO-E2E.md`, `docs/INTEGRATION-AUDIT.md`, `postman/README.md`.

---

## 2026-09-15 — **Phase E step 3 (part 1)**: the XML parser, the per-domain breaker, the D17 stop conditions, and the trip-wires

**Context.** Step 2 built the fetch gate and opened **D17** — which source is contacted first,
under whose approval, at what rate, on what stop condition. This session closed D17, built the
three things it needed underneath it, and proved each stop condition fires. **No live request has
been made. That claim is still true.**

**Read this first if you are picking up cold:** the next concrete action is at the bottom.

---

### What was decided, and what that cost

Three decisions, written up in full in `docs/decisions.md`:

**D-039 — `fast-xml-parser@4.5.7`, pinned exactly, behind a DOCTYPE gate this project owns.** The
two RSS rungs need a parser and a parser pointed at a stranger's document is an XXE hole and a
billion-laughs hole. Both attacks **require a DTD**, so the defence is not a parser option: before
the library is called, `apps/api/src/sources/parse/xml.ts` scans the document and refuses **any**
markup declaration. The scan is a scanner and not `includes('<!DOCTYPE')`, because a feed that
quotes HTML inside CDATA legitimately contains that string and refusing it would drop real
articles. Nine tests assert the gate **without touching the library**, which is the point — a
defence resting on `processEntities: false` stops meaning anything the day an upgrade changes what
the flag does.

**Not v5.** Verified 2026-09-15 against the registry: 4.5.7 declares one runtime dependency
(`strnum`), 5.11.1 declares six, five of them created in 2026 with thin adoption, one
(`@nodable/entities`) pointing at a GitHub org whose repo name does not match the package. Same
maintainer, so a modularisation and not an injection — but worth looking at before it is taken.
That is now **open decision D18**. The lockfile diff was checked: exactly two packages added,
`fast-xml-parser@4.5.7` and `strnum@1.1.2`.

**D-040 — two breakers.** FR-06 asks for per source **and** per domain; D5 built per-source only.
The gap is real: a discovery source hands us links to a hundred publishers it does not speak for,
and when one of them refuses us, recording it against the feed suspends a working feed while
recording it nowhere keeps us calling a host that has said no. `domainHealth` is now a second
shared document keyed on the **registrable domain**. Suspension is sticky (released by an
operator); degradation expires on the publisher's own clock; a success closes the breaker and
deliberately does not clear a cooldown.

**D-041 — stop conditions, which closed D17.** `accessPolicy.stopConditions` on the approved
source version, applied by `SourceHealthService.recordFailure`. The invariant: **a stop condition
can only ever stop** — never permits what FR-06 refused, never lowers a class. A halt is the D5
kill switch, because it is already effective immediately, effective mid-run, reason-mandatory, and
**four eyes to release**, which is what "requires fresh approval" has to mean.

---

### Did

- `pnpm --filter @adverse-search/api add -E fast-xml-parser@4.5.7`. Lockfile verified: two packages.
- **`apps/api/src/sources/parse/xml.ts`** — the one XML module. `findMarkupDeclaration` (the gate),
  `parseXmlDocument`, `decodeXml` (honours a declared `ISO-8859-1`, which CR and ES publishers
  still serve — decoding one as UTF-8 silently costs recall on accented names), and `parseFeed`
  for RSS 2.0 and Atom 1.0. An unrecognised root returns `UNRECOGNISED`, **never an empty feed**,
  because "zero items" and "I did not understand this" are the two facts T84 exists to keep apart.
- **`packages/domain/src/reliability/registrable-domain.ts`** — the breaker key. A rule, not the
  Public Suffix List (a weekly-changing data file whose npm distributions this project has not
  reviewed). Where the rule is wrong it is wrong **broader** than the truth, which costs coverage
  visibly rather than letting us call a publisher who refused us.
- **`packages/domain/src/reliability/domain-health.ts`** — the per-domain breaker, pure, reading
  FR-06's table through the same two predicates `source-health.ts` uses. Nothing restated.
- **`packages/domain/src/reliability/stop-conditions.ts`** — `evaluateStopConditions` and
  `applyObservedFailure`. The second is the composition `SourceHealthService.recordFailure` runs
  **and** the trip-wire harness runs, deliberately: a harness that re-composed those four steps
  would pass whenever the two implementations agreed, including when both were wrong.
- **`apps/api/src/sources/domain-health.service.ts`** — persistence for the above, plus manual
  suspend (one person) and release (four eyes when a person engaged it).
- **`apps/api/src/sources/platform-audit.ts`** — `__platform__`, the reserved audit trail for
  cross-tenant records. An automatic halt has no tenant; writing it into whichever customer's run
  observed it would put a cross-tenant fact in one customer's chain, and dropping it would leave a
  service that stopped calling a source and cannot say why.
- **`packages/contracts` — `sourceAccessPolicySchema`**, optional on source content: the ceiling,
  the poll floor, conditional GET, the user-agent requirement, the policy summary in the approver's
  own words, the stop conditions, and `firstContactApproval`. `pnpm openapi:generate` re-run.
- **`apps/api/src/sources/registry/sec-litigation-releases.ts`** — the D17 source version content,
  written down so the record an approver signs can be read in a diff. **It is a proposal, not an
  activation.**
- **`assertOutboundUserAgent`** in `egress-identity.ts`, called by `StartupService` **before any
  index**: a live process with no honest user agent now refuses to boot, rather than starting and
  reporting fetching as quietly unavailable.
- Wired the domain breaker into `HttpEvidenceFetchAdapter` and made `buildSourceAdapters` refuse to
  construct the live adapter without it, on the same rule as the contact URL.

### Verified — the numbers, not "tests pass"

```
pnpm lint          clean
pnpm typecheck     clean
pnpm test:unit     726 passed (39 files)   — was 644 (33)
pnpm test:invariants   29 passed
pnpm test:evaluation   12 passed
```

New tests: 82 — 22 XML parse, 17 domain health, 14 stop conditions, 10 registrable domain, 10
trip-wires, 9 SEC source config.

**`pnpm test:integration` and `pnpm test:security` were NOT run** — they need the stack up
(`pnpm local:up && pnpm local:bootstrap`) and it was not started this session. They are the suites
that would exercise `DomainHealthService` and the halt path **against Mongo**, which is the gap
below.

### Found

**1. A real ordering bug, found by the trip-wire harness rather than by reasoning.** The first
wiring put the domain gate ahead of the source rights check. A 403 halted the source correctly —
and the _next_ request then reported "sec.gov is in a cooldown", hiding the halt an operator would
be asked about. Fixed: a **non-spending** rights check now runs first, then the publisher, then
robots, then the spending check. D5's ordering principle (rights, then health, then economics)
holds across both breakers, not only inside one. This is why the harness was worth building before
the connectors and not after.

**2. The plan asked for trip-wires "against a controlled / self-hosted target". That is impossible
by design, and the design is right.** A self-hosted target lives at `127.0.0.1` or a private
address, and the fetch path refuses both twice over: `screenUrl` permits https on port 443 alone
and rejects loopback literals, and `screeningLookup` refuses any host that _resolves_ privately,
inside the connection's own lookup (D-034). The only target the real transport can reach is a real
third party — which is the thing the trip-wires exist to make safe. So the controlled target is an
injected `HttpTransport`, and the honesty rests on where the seam is: everything above the socket
is the real adapter, the real order of operations, the real FR-06 classification, and the same pure
composition the live service runs. The harness header says all of this, including what it does
**not** prove.

**3. `isServerError` and FR-06 disagree about 500, and FR-06 is left alone.** `classifyFailure`
treats 502/503/504 as `TRANSIENT_NETWORK` and 500 falls through to the non-retrying
`CONTENT_ERROR` default. The stop-condition streak counts 500 as a server error anyway, because a
publisher returning 500 repeatedly is a publisher whose site is down whatever we retry. Not
reconciled, deliberately — changing the FR-06 table to make a streak counter tidier is the wrong
direction of fix.

### Left half-done

- **Step 3's actual subject — the rungs and the connectors — is not started.** The parser exists
  and nothing calls it. Rungs 0–7, Google News RSS, Bing News RSS, GDELT and SearXNG are all still
  to write. This session built the three things step 3 needed underneath it, and D17 needed closing
  before any of them could be pointed anywhere.
- **The halt path is not tested against Mongo.** `applyObservedFailure` is proved pure and proved
  through the adapter; that `SourceHealthService` persists the kill switch and the platform audit
  entry in one transaction is **FI-20** and belongs in `tests/integration/`. Write it before the
  first live poll, not after.
- **There is no operator view over `domainHealth`.** A domain the FR-06 table suspends can only be
  released through the service, and no controller exposes it. That is a dead end for an operator
  and it needs a route. `DomainHealthService.suspend`/`release` exist and are ready for one.
- **The SEC source version is not in the registry.** It is a TypeScript record checked against the
  schema. Proposing, approving and activating it is the source admin's act through
  `/v1/admin`, and it deliberately carries `robotsPosition: NOT_ESTABLISHED` — which the fetch gate
  refuses — so the feed cannot be polled until the robots read has happened and the position has
  been updated on what it actually said.

### Next session should

**The user's stated goal is a live adverse search driven from Postman.** The shortest honest path
to it, in order:

1. **Build the discovery connector for the SEC RSS feed** and rungs 0–7 of the FR-05 cascade
   (step 3 proper). The parser, both breakers and the stop conditions are in place; what is
   missing is the thing that turns a feed into `Lead`s and the cascade that logs each rung and
   descends on its own stated failure. Reaching rung 7 with nothing produces `NO_MATCHES_FOUND`
   with `INCOMPLETE` coverage, never a clean result.
2. **Write the FI-20 integration test** (the halt persists, with its audit entry, in one
   transaction) before anything is polled live.
3. **Then Phase B of the live plan, which is one request**: propose → approve → activate the SEC
   source version, then `GET https://www.sec.gov/robots.txt`. Record the result as the **D6**
   evidence for this source and update `robotsPosition` through the lifecycle on what it says.
   Enable the 15-minute conditional-GET poll and watch the first cycles: confirm 304s and that no
   trip-wire fires spuriously.

Extraction is still a keyword placeholder (Phase F), so the first live results will be thin. Say so
in the coverage statement rather than letting thin read as clean.

### Addendum, same session — D-042 and D-043

The user's stated goal is a **live adverse search driven from Postman, against all sources**, not
only the one D17 approved. Taken as direction, with one thing generalised rather than assumed.

**D-042 — every live source needs a named first-contact approval, not just the first one.** D17
answered "who approved this?" for one source. Left there it would have been a ceremony performed
once, and the twentieth publisher this service contacted would have been contacted because somebody
filled in a form. So `FetchGateService` now refuses any live fetch to a source whose approved
version carries no `accessPolicy.firstContactApproval` — a named person, their role, the date, and
the decision. It is a **source-level** refusal, so it reaches the coverage statement. Read strictly:
any missing field resolves the whole approval to null, because a half-filled approval the gate
accepted would be a live request made under a name nobody wrote down.

The consequence is deliberate and will look like a misconfiguration to somebody who has not read
D-042: **adding a source to the registry is no longer enough to make it reachable.** A correctly
configured, four-eyes-approved source with no first-contact approval refuses every lead and says
why. That is what lets every source be configured now and approved one at a time.

**D-043 — a source's endpoint is registry content** (`accessPolicy.endpointUrl`), not connector
code. One RSS connector then serves every RSS source, and what distinguishes the SEC from a Costa
Rican gazette is a row somebody approved rather than a URL somebody compiled in. It does not reopen
the "no executable instruction in the registry" rule: a URL is validated as a URL and every request
to it goes through the same gates as a discovered link.

**Verified after the addendum:** lint clean, typecheck clean, format clean, **729 unit**, 29
invariants, 12 evaluation. `pnpm openapi:generate` re-run.

**What is deliberately NOT in this commit, and why.** Registry records for Google News RSS, Bing
News RSS and Costa Rican publishers. Their endpoint shapes have **not been verified** — no request
has been made to any of them, and writing a guessed feed URL into a source version would be putting
a fabricated fact into the record an approver signs, which is the thing this project refuses to do
everywhere else. The SEC's two feed URLs were verified by desk research on 2026-09-15 and are the
only addresses recorded. The next session should ask the user to name the CR publishers they want
and establish each endpoint before writing its record.

### Second addendum, same session — D-044, the scope is worldwide

The policy owner revised **D1** (closed 2026-09-11 as Costa Rica, es + en) to **worldwide**. Recorded
as **D-044**, with what it does and does not change spelled out there. The short version for a cold
reader:

- FR-05's permission rule is unchanged: "EU", "LATAM", "GLOBAL" are still not source permissions,
  and every source still declares the countries it actually covers.
- **D-042 is unchanged and is the mechanism that makes worldwide safe**: more sources to approve,
  one named approval at a time, not a blanket permission. It was generalised _before_ this decision
  landed rather than after, which is why the widening costs nothing in safety.
- **FR-03 is unchanged and this is the real cost.** No language has a measured recall figure, so the
  coverage statement must now say so in more languages than before, and the temptation to let source
  count stand in for recall gets stronger with every source approved. G10 measures.
- **D14 and D15 stop bounding the product.** Both are Costa Rica-specific. They remain the answer
  for CR subjects and are no longer the ceiling on everything.

Corrected while there: `HTTP_EVIDENCE_FETCH_DESCRIPTOR` declared `jurisdictions: ['CR']`. Wrong under
the old decision too — a transport is not jurisdiction-bound, and naming a country made it look like
Costa Rican coverage, which is a stronger and falser claim than no claim. Now empty; a coverage view
groups by the **source's** countries.

**Left undone by D-044 and listed in it so it is not mistaken for done:** the bootstrap still seeds
`CR` only, `capabilityCoverage` holds CR rows only, and no name-frequency distribution is loaded for
any country (which was already true, and is now the general case rather than one gap).

### Third addendum, same session — the RSS discovery connector

`RssNewsDiscoveryAdapter` is built and tested (25 tests, no socket opened). It is the **RSS
connector**, not a per-publisher one: the address, countries, languages, budgets, stop conditions
and first-contact approval all come from the active source version, read fresh on every call
(**D-043**). Adding a publisher is an approval, not a deployment.

**It has no HTTP path of its own.** Every byte comes through `EvidenceFetchPort`, so it inherits
the transport, the SEC-02 lookup screening, robots with `UNKNOWN` refusing, both byte budgets, both
breakers and the stop conditions. The only thing it adds is authorisation of its own poll, via the
new `FetchGateService.authoriseEndpoint`, which runs every gate a document fetch runs.

Three things in it worth not undoing:

- **`FIXED_FEED` vs `QUERY_FEED` is recorded, not inferred**, because the difference is the _rate_:
  a fixed feed costs one request per poll however many searches are running; a query feed costs one
  per planned query, which for a bounded plan is dozens.
- **The query is one search parameter, never a string splice.** The registry records the
  parameter's _name_; the connector parses the recorded endpoint, sets that parameter and
  serialises. A hostile query string cannot introduce a path, a host, a scheme or a second
  parameter — there is a test that tries.
- **A parse failure is `FAILED`, never `NO_RESULTS`.** A shape change yields zero items with
  nothing thrown, and reporting it as "no news about this person" is the worst failure this product
  has. `contractProbe` runs the same parser through the same gate and calls zero items unstable.

Supporting changes worth knowing about: `FetchAuthorisation.relevanceScore` is now **nullable** —
a feed poll has judged nothing, and a 1 chosen to satisfy the type would be a judgement recorded in
the record that exists to be audited. `DiscoveryQuery` now carries the run's pinned scope (`run`),
required of mocks too, because an optional gate context is a gate somebody forgets.

**Not wired into `buildSourceAdapters` yet, and that is the next step rather than an oversight.**
`SourceAdapterSet.newsDiscovery` is a single nullable port and `search-pipeline.service.ts` reads it
at rung 2. The cascade has to enumerate the _active RSS sources_ in the registry and walk rungs 0–7
over them, which is the refactor step 3 actually is. The connector is the substrate for it and is
deliberately finished first, tested, and committed on its own.

### The blocker the next session starts on

**The user will supply the source list.** They asked to give it rather than have it researched, in
this shape:

```
source name | feed or endpoint URL | countries | languages | kind (news / gazette / court / regulator)
```

Nothing further should be written into the registry until it arrives: a guessed feed URL in a source
version is a fabricated fact in the record an approver signs, and the two SEC feed URLs are the only
addresses this project has established.

**The connector was deliberately not started without it**, and the reason is not caution. The
`NewsDiscoveryPort` shape is one adapter per source, and `SourceAdapterSet.newsDiscovery` is a single
nullable port that `search-pipeline.service.ts` reads at rung 2. Turning that into the real
seven-rung cascade over _many_ approved sources is the refactor step 3 actually is — and its shape
depends on whether the supplied sources are RSS, JSON (GDELT-style), or search endpoints (SearXNG),
because those are three connectors and not one. Building an RSS-only cascade before seeing the list
risks building the wrong seam and then widening it under pressure, which is how the weaker of two
HTTP paths gets created.

### Decisions touched

- **D17 — CLOSED 2026-09-15.** SEC litigation-releases RSS; approved by Faisal Ali, source admin;
  one conditional GET per 15 minutes against a recorded 10 req/s ceiling; four stop conditions,
  each proved to fire. Closing it licenses **one source under one approval** — every other source,
  including every Costa Rican one, is a separate first contact.
- **D-039, D-040, D-041** added to `docs/decisions.md`.
- **D18 opened** — whether to adopt `fast-xml-parser` v5, after its dependency chain is looked at.
- **D6** is unblocked in the sense that reading a publisher's robots is now permitted for the SEC,
  which is the evidence-gathering step it needed; the approval/record **mechanism** is still open
  and is still not engineering's.
- **D15** is no longer blocked on "nobody has decided we may contact anyone", but it is **not**
  covered by D17's approval: a CR judicial portal is a different publisher. Still untouched.

---

## 2026-09-14 (late) — **Phase E step 2**: the fetch gate, one honest egress identity, and D17 opened

**Context.** Step 1 built the real fetch adapter. This session built the thing that is allowed to
authorise it, and deleted the record that was authorising it falsely.

---

### The fabricated authorisation is gone

`search-pipeline.service.ts` used to build its `FetchAuthorisation` inline:
`sourceVersionId: 'fixture-source-v1'`, `robotsPosition: 'HONOURED'`, `jurisdictionEnabled: true`,
`languageEnabled: true`, `urlPolicyPassed: true`, `ssrfValidated: true`, `relevanceScore: 0.9`, and
`egressIdentityId: 'mock-egress-1'` in attribution. None of it derived. `urlPolicyPassed: true`
claimed SEC-02 screening on a URL nothing had screened.

**`FetchGateService`** (`apps/api/src/sources/fetch-gate.service.ts`) is now the only issuer, and
derives every field — decision **D-036**:

| Field                                    | Derived from                                                                                       |
| :--------------------------------------- | :------------------------------------------------------------------------------------------------- |
| `sourceVersionId`, `licenceTermsVersion` | the **active approved version**, read per lead, terms checked unexpired against `now`              |
| `jurisdictionEnabled`                    | the run's pinned scope ∩ the source's approved countries ∩ `resolveEffectiveScope` on the taxonomy |
| `languageEnabled`                        | the lead's **declared** language ∩ the taxonomy's ∩ the source's — never inferred from the text    |
| `urlPolicyPassed`                        | `screenUrl`, run here, on this URL                                                                 |
| `ssrfValidated`                          | the literal half here; the resolved half structural inside the transport's `lookup` (D-034)        |
| `robotsPosition`                         | what an approver recorded in the registry                                                          |
| `relevanceScore`                         | computed from the lead's own title and snippet against the subject's name forms                    |

**Enforcement is a scan test**, following the control panel's precedent for D-001: no file in
`apps/api/src` outside the gate and the port may contain the `urlPolicyPassed` field. A rule nobody
can check is a rule that lasts until the next hurry.

**A refusal is recorded, never skipped.** Every refusal becomes a rejected lead carrying the gate's
own sentence. `isSourceLevelRefusal` splits refusals that cost the **whole source** (no active
version, expired or unrecorded licence terms, no established robots position, an unapprovable
exception, a fixture in live mode, no egress identity) from those that cost **one URL** (outside the
run's scope, a rejected URL). The first also produce a `SKIPPED` coverage outcome — `SKIPPED`, not
`FAILED`, because the source answered nothing on account of our decision not to ask it.

### Two things that were true and are now said

**A fixture is not a publisher.** The six mock sources are seeded with `robotsPosition:
'NOT_ESTABLISHED'` — correct, because there is no publisher behind a local fixture. The inline
record said `HONOURED` to get past the gate. The gate now issues a new value,
**`FIXTURE_NOT_A_PUBLISHER`**, only in a mock-mode process and only for a `FIXTURE_MOCK` connector;
`HttpEvidenceFetchAdapter` refuses that value outright (`assertNotFixtureAuthorisation`), so a
fixture authorisation cannot justify a request to a real host. That is T55 from the opposite end to
`MockModeWitness`.

**`EXCEPTION_APPROVED` is refused while D6 is open**, at the gate, with a sentence naming D6 and
saying a source admin owns it — rather than being refused three layers down by `assertAuthorised`
with no explanation a reviewer can read.

### One honest egress identity (the E3 minimum)

`apps/api/src/sources/egress-identity.ts`. In live mode: `egress-primary`, whose user agent is
**built from `FETCH_CONTACT_URL`** and is byte-identical to the one `HttpEvidenceFetchAdapter`
sends, so the record and the wire cannot disagree about who called. **A live process with no contact
URL gets no identity and the gate refuses every fetch** — the same rule `buildSourceAdapters`
already applies to the adapter. In mock mode: `egress-mock-fixture`, named so it cannot be mistaken
for a live identity in a stored record. `mock-egress-1` no longer exists.

The pool, the sticky per-(domain, job) binding and `ProxyPort` are **step 7**, untouched.

### The relevance score: derived, labelled, and not a gate

Decision **D-037**. `relevanceScore` was the constant `0.9`. It is now a name-presence score over the
lead's own title and snippet — 1 for a whole name form present, otherwise the best fraction of a name
form's tokens, 0 for a lead naming nobody — carried with a new `relevanceMethod` field set to
`PRELIMINARY_NAME_PRESENCE_v1`. **It does not gate**: FR-06's nine signals and the threshold are
step 4, and their weights belong against the FR-16 corpus rather than guessed now. A bare number in
an audited record cannot be told apart from a measured one; the method field is what makes it
honest, and step 4 replaces the method.

### The gap step 1 left open, closed

Decision **D-038**. `SourceOutcome.FAILED` now carries a **required** `detail`, and `failed()` takes
it as a required argument — so a failure with no explanation does not compile, at all fifteen call
sites. A robots refusal used to reach a reviewer as "could not be retrieved (HARD_BLOCK)"; it now
says robots.txt at that host disallows that path.

### D17 opened, and D15 re-raised

**D17 — the first deliberate live request** is written up in `docs/open-decisions.md` with an owner
(source admin as the approver, with engineering), a closing gate (**G10, and before any live call**),
and four things to decide: which source, under whose **named** approval, at what rate, and on what
stop condition. Recommendation: a **single manual request to one source's robots.txt**, approved by
name, logged, stopped there — before any connector is switched on. **No call was made. No live
source has been contacted by this project.** What stops one now is a configuration value and a
decision, not a technical block, which is exactly why it is written down.

**D15 was re-raised** with a status check: untouched since 2026-09-11, and step 3's rung tiers encode
its answer. Its desk research is itself an outbound request, so it waits behind D17.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         644 passed  (was 614: +30 fetch gate)
test:invariants    29 passed
test:evaluation    12 passed
test:integration  206 passed  (stack up and bootstrapped)
test:security     106 passed
pnpm demo:api      runs end to end through the real gate; findings unchanged
```

**Left half-done:** nothing in step 2. Steps 3 through 8 are untouched.

**Found — one thing worth knowing before step 3.** The gate reads the **shared** `sourceVersions`
collection, which means the six fixture sources' registry rows are now load-bearing for mock mode: a
mock run whose source rows are missing is refused at the gate rather than silently fetching. That was
already true of source health (D5) and is now true of the gate as well, so `pnpm local:bootstrap` is
a prerequisite for the integration suite in a stronger sense than before. The integration suite
constructs the gate explicitly, and the seeded rows are what it authorises against.

**Also worth knowing:** `robotsPosition` is per source, and for a discovery lead the source is the
**feed** while the fetched host is the **publisher**. The gate therefore records the feed's position,
and the adapter separately reads the actual host's robots.txt at fetch time — both must pass. FR-06
wants the exception process per source _and_ per jurisdiction, which is one of the three gaps D6 has
to close.

**Next session should: build step 3 — the discovery connectors and the seven-rung cascade.** The
first concrete action is deciding the **XML parser dependency explicitly** rather than by
`pnpm add`: the two RSS rungs need one, and a parser that resolves entities or follows external DTDs
is an XXE hole pointed at a third party's feed. Then rungs 0–7 with per-rung logging, the Google
News / Bing News / GDELT / SearXNG connectors, and the per-domain breaker half FR-06 asks for that D5
did not build. Do not make a live call: **D17 is open**, and that is the decision it exists to
protect.

**Decisions touched:** **D-036**, **D-037**, **D-038** recorded. **D17 opened** — the first
deliberate live request, owner source admin, due before any live call. **D15 re-raised**, still open,
still untouched by its owner. **D6 still open** and still refusing every exception. Nothing closed.

**Still true:** **no live source has been contacted by this project.** No language is enabled. The
Spanish lexicon is still unreviewed (D-033). FR-10 clustering is still not wired. No CR
name-frequency distribution is loaded.

---

## 2026-09-14 (night, later) — **Phase E begins**: D6 raised, the brief expanded, and the real fetch adapter built

**Context.** Phase D closed and G5 passed earlier the same day. This session started Phase E in the
order `START-HERE.md` and the previous handoff both specified: raise the open decision first, expand
the outline into a brief second, build the adapter third.

---

### D6 raised, before a line of the adapter was written

`docs/open-decisions.md` now carries a full **D6** section — how robots exceptions for official
sources are approved and recorded. **It needs a source admin and it is still open.** Raising it
meant writing down what the decision is actually about, which turned out to be three concrete gaps
rather than one abstract question:

1. **There is nowhere to record the approver.** `FetchAuthorisation.robotsExceptionApprovedBy`
   demands a name and `sourceContentSchema` has no field that holds one — so a source marked
   `EXCEPTION_APPROVED` **cannot be fetched at all** today. The gate is safe and the feature is
   unreachable, which is exactly the state a decision exists to end.
2. **`robotsPosition` is per source, and FR-06 requires per source _and_ per jurisdiction.** One
   field spanning a source's whole `countries` list is a smaller global setting, not an exception.
3. **An exception has no scope and no expiry** — it currently means "this source, all of it,
   forever".

Three options are written out with a recommendation: a structured exception record carried through
the existing four-eyes lifecycle, so the approver is the person the lifecycle recorded rather than a
name typed into a box. The provisional behaviour is recorded so it cannot harden into a default:
**no exception can be applied today**, `UNKNOWN` robots refuses, and a source needing an exception
is blocked and says so.

One thing the decision owner should see. The first question — "does any approved CR official source
actually block what we need?" — is desk research, **but reading those robots.txt files is itself an
outbound request**. No live source has been contacted by this project, so that is a deliberate
first-contact decision, not something to do quietly while answering the question.

### `phase-e.md` expanded from an outline into a brief

53 lines to ~290. The substantive addition is an **execution order that is not the step numbering**.
`E1`–`E6` are kept exactly as `docs/delivery-plan.md` names them, so the plan and the traceability
matrix keep meaning what they say, and a separate table says which order they are worked in and why.

The fetch transport (E5's HTTP half) is worked **first** because every other live step is an
outbound HTTP request: Google News RSS, GDELT and SearXNG each have to screen a URL, screen every
resolved address, respect a budget and a timeout, carry an honest user agent, and check source
health before opening a socket. Writing the connectors first means writing a second, weaker HTTP
path — and the weaker of two paths is the one that ends up used for something it should not be.

---

### `HttpEvidenceFetchAdapter` — the real `EvidenceFetchPort`

`apps/api/src/sources/http-evidence-fetch.adapter.ts` and `http-transport.ts`.

**It uses `node:https` with a custom `lookup`, not `fetch`, and that is the load-bearing choice**
(decision **D-034**). Two reasons, both requirements rather than preferences:

- **The address that was screened must be the address the socket uses.** Screening with `dns.lookup`
  and then calling `fetch(hostname)` resolves twice, and the second resolution **is** the rebinding
  attack. `https.request` takes a `lookup` that the connection itself calls, so the screening sits
  inside the only path from a hostname to a socket. `servername` stays the hostname, so TLS is
  untouched. Every address is screened, and **one forbidden address refuses the whole host** — a
  host answering with both a public and a private address is a signature, not a usable host with one
  bad entry.
- **Two byte budgets cannot be enforced through one number.** `fetch` decompresses transparently, so
  wire size is unobservable and `maxBytes` and `maxDecompressedBytes` collapse into one. Here wire
  bytes are counted as they arrive — aborting on the chunk that crosses the line, not after
  buffering the body — and decompressed bytes are bounded by `zlib`'s own `maxOutputLength`, which
  stops a bomb inside the decompressor rather than by measuring a buffer already allocated. A 40KB
  body that inflates to a gigabyte trips the second while the first is nowhere near its limit. That
  is T38's compression half.

**Redirects are followed by the adapter, one hop at a time, never by the transport** — which is what
lets every hop be re-screened, re-checked against robots for its possibly different host, and
re-checked against source health. A transport that followed them would carry a request past the gate
without the gate being consulted, and a `302` to the metadata service is the obvious way to try it.

**What it refuses**, in order: an unauthorised or unattributable request (throws — a caller that
cannot name its authorisation has a bug); a URL the SEC-02 policy rejects; a source whose health
refuses right now; a robots `DISALLOWED`; and a robots **`UNKNOWN`**, because an outage at the
publisher is not consent. A 404 robots.txt is permission; an HTML error page served as a 200
robots.txt is **unreadable**, not "no rules" — that is the commonest way a robots fetch succeeds
while telling us nothing, and parsing it would find no rules and read as permission.

**The two health rules — decision D-035. The first is the one that matters most:**

- **A gate refusal is never recorded as the source's failure.** A robots disallow and a refused
  address both classify as `HARD_BLOCK`, whose `domainAction` is `SUSPEND`, on which D5's breaker
  opens **immediately**. Feeding either to `recordFailure` would suspend an entire working news feed
  because one article it listed was disallowed. Health hears only what the **server** did: a status
  code, a reset connection, a timeout, an oversize body. A refusal is still returned as `FAILED`, so
  the lead survives with its reason and the coverage view shows it — it just never becomes evidence
  that the publisher is unwell.

  This surfaced a real gap worth knowing about: **FR-06 asks for per-source _and per-domain_ circuit
  breakers, and D5 built only the per-source half.** For a primary source the two coincide. For a
  discovery lead they do not — the `sourceId` is the feed, the domain is whatever the feed linked
  to. This rule is what keeps the missing half harmless until step 3 builds it.

- **Whoever opens the socket spends the budget.** `checkAccess` gained an optional `spend` flag
  (default true). The pipeline's pre-fetch check now passes `spend: false` — it asks "may this lead
  be attempted at all?", a rights-and-breaker question rather than a request. The adapter spends
  once per request it actually issues, **robots.txt included**, which is a real request to the
  publisher and was counted nowhere at all before.

**Deliberately absent:** Playwright, rendering, any escalation. Three of FR-06's four render triggers
are judgements about extracted text, and the extractor is still a keyword placeholder; inventing a
trigger would put a fabricated justification into a record that exists to be audited. `allowRender`
is accepted and ignored, and `renderTrigger` is always null, which is the truth. A recognised
challenge is abandoned after one attempt — no solve, no bypass, no retry from a second identity.

**One gate, not two copies.** `assertAuthorised` / `assertAttributable` moved out of the mock into
`apps/api/src/sources/fetch-authorisation.ts`, and both adapters call them. The port's own header
warns about "a second, subtly different copy of the gate growing inside the HTTP client", and two
copies is how the live one ends up the more permissive.

**Wired into `buildSourceAdapters`, and null unless it can be honest.** It needs a contact URL
(`FETCH_CONTACT_URL`, new, **no default**) and a source-health service. Missing either means no
adapter and a logged reason: an anonymous crawler and an unthrottled one are both things the
requirements forbid, not degraded modes. The constructor also throws on an empty contact URL.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         614 passed  (was 571: +31 fetch adapter, +11 url-policy, +1 classification)
test:invariants    29 passed
test:evaluation    12 passed
test:integration  206 passed
test:security     106 passed
coverage          94.07% statements / 90.46% branches (gate 85/80)
pnpm verify:local  every suite ok except end-to-end, still [n/i] and still exits non-zero
pnpm demo:api      runs end to end, unchanged
```

**Left half-done:** nothing in step 1. Steps 2 through 8 of the brief are untouched.

**Found — one real defect, fixed, and worth reading.**

**`screenUrl` passed `https://[::ffff:127.0.0.1]/` as a public host.** `isForbiddenIpv6` matched the
dotted form `::ffff:127.0.0.1`, but the WHATWG URL parser canonicalises that host to
`[::ffff:7f00:1]` — the same address in hex groups — and the hex form matched nothing. `::7f00:1`
(IPv4-compatible) got through the same way. **For an IP literal there is no DNS step, so `screenUrl`
is the only gate that exists on that path**, and loopback, the metadata service and every private
range were reachable through a URL literal. Found because a parameterised SSRF test in the new
adapter suite asserted the mapped form and failed.

Fixed in `packages/domain/src/fetch/url-policy.ts`: the address is expanded to its eight groups and
judged **numerically**, so the notation cannot decide the answer — matching a shape is what let the
hex spelling through. Regression tests cover every spelling of the same address, and the opposite
mistake too: a genuine public IPv6 address with a dotted tail (`2001:db8::192.0.2.1`) must still be
allowed.

**Also found — a dead configuration placeholder, replaced.** `.env.example` carried
`OUTBOUND_USER_AGENT="ErlyAdverseSearch/0.1 (+https://example.com/bots/adverse-search)"`, written
for exactly this purpose at some earlier point and **read by nothing**. It is now replaced by
`FETCH_CONTACT_URL` rather than adopted, and the file says why: a free-text user agent can be set to
a string with no contact URL in it at all, which is the dishonest case FR-06 forbids. Configuring the
contact URL instead means it can be validated as a URL and the user agent is built from it, so an
honest one is the only one that exists. Leaving both would have meant an operator eventually setting
the one that does nothing.

**Also found, left as a known gap rather than fixed:** `SourceOutcome.FAILED` carries a failure class
but no human detail, so a rejected lead reads as "could not be retrieved (HARD_BLOCK)" rather than
saying robots disallowed it. The adapter logs the detail; the coverage record does not get it. Step 2
should add it, and the brief's risk table says so.

**Next session should: build step 2 — `FetchGateService`.** The first concrete action is to delete
the fabricated `FetchAuthorisation` in `search-pipeline.service.ts` and derive it instead. Today that
object is built inline with `urlPolicyPassed: true`, `ssrfValidated: true`,
`jurisdictionEnabled: true`, `sourceVersionId: 'fixture-source-v1'` and `relevanceScore: 0.9` — none
of it derived from anything. Against the mock that was harmless. Against the adapter that now exists
it is a signed statement that gates were passed which were never run, in the one record whose whole
purpose is to be audited. The same step wants one honest egress identity, so that
`egressIdentityId: 'mock-egress-1'` stops being written into live attribution records.

Then, in brief order: step 3 (discovery connectors and the cascade — decide the XML parser dependency
explicitly; a parser that resolves entities is an XXE hole pointed at a third party's feed), step 4
(relevance filtering before the gate), step 5 (plan generation proved against the now non-empty
taxonomy), step 6 (contract tests — the detection mechanism for the worst failure this product has).

**Decisions touched:** **D-034** and **D-035** recorded. **D6 raised with specifics and still open** —
it needs a source admin and is due at G6. **D15** is also due at G6 and is untouched. Nothing closed.

**Still true:** **no live source has been contacted by this project.** The real transport is
constructed only by the live composition root; every test in the new suite runs against an injected
one, and the suite's header says why. No language is enabled. The Spanish lexicon is still unreviewed
(D-033). FR-10 clustering is still not wired.

---

## 2026-09-14 (night) — **Phase D complete, gate G5 passed**: D5 source health, D6 the lexicon and its activation audit

**Context.** The session before this one built two pure modules for the live fetch gate and then
stopped, because the project owner decided to finish Phase D first. This session did that. D5 and
D6 are done, G5 is passed, and the live-source work is now unblocked rather than parked.

---

### D5 — source health: breaker, budgets, kill switch

**The trap the brief warned about, and how it was avoided.** `SourceHealth` is a **separate
mutable collection** (`sourceHealth`, `_id` = `sourceId`) holding breaker state, budget counters,
the kill switch and the licence clock. It is **not** on `SourceVersion`, which is an immutable
approved artefact. There is an integration test that asserts exactly this: suspending a source
leaves the `sourceVersions` document byte-identical. The approved version says what is
_permitted_; health says what is _happening_. Decision **D-031**.

It is **shared, not tenant-owned** — a publisher's rate limit is a property of the publisher, and
per-tenant budgets would let the sum of the tenants exceed the free tier the publisher grants.

**The breaker invents no failure taxonomy.** It reads the existing FR-06 table and derives
everything from two properties of a `FailurePolicy`:

- `domainAction === 'SUSPEND' || alertOperator` → opens **immediately** (hard block, revoked
  credential). Five more requests at a source that has already refused is what the hard
  constraints exist to prevent.
- `domainAction !== 'NONE' || retryable` → counts toward the threshold (default 3).

What that **excludes** is the point: a `CONTENT_ERROR` (a 404 on one article) and an `OVERSIZE`
(one enormous PDF) are facts about a **document**. A breaker that counted them would hold open a
source that is working perfectly and merely being asked for things that are not there. There is a
test that fires ten content errors in a row and asserts the breaker stays closed.

`HALF_OPEN` exists so a recovering source is not knocked over by the whole backlog at the end of
the cooldown; it admits exactly one probe, and a failed probe re-opens the breaker at once.

**Budgets** are fixed clock windows (hourly, daily), read fresh from the **active version** on
every check — so an administrator lowering a budget takes effect without a restart, and there is a
test for that. Spent **before** the call, not after: the publisher counts requests, not successes,
and a budget decremented on success would let a failing source be called without limit.
**Exhaustion is a coverage outcome, not an error** — `PARTIAL` with `TRUNCATED_BY_QUOTA`.

**The kill switch is effective mid-run (T36), and this is the part worth understanding.** The
pipeline calls `SourceHealthService.checkAccess` immediately before **each** discovery query and
**each** fetch, not at plan time. There is deliberately **no cancellation message** chasing an
in-flight run: a cancellation that has to arrive is one that can fail to arrive, and making the
run ask every time removes the delivery problem instead of adding a second one. The cost is
bounded and written down — at most one request already on the wire completes after the switch is
engaged.

**Licence expiry is the same path.** T36 names it explicitly; past a recorded `licenceExpiresAt`
the source is refused exactly as a suspended one is. An expiry that cannot be parsed also refuses.
`licenceExpiresAt` was added to `sourceContentSchema` as an optional nullable field.

**Refusal order is policy:** rights (kill switch, licence, inactive version) → health (breaker) →
economics (budgets). A suspended source reports as suspended even when its breaker is also open
and its budget also spent, because only the first is a reason somebody will be asked about.

**No refusal is ever a silent skip.** Each produces a `SourceCoverageOutcome`: `SUSPENDED` (we
chose not to ask), `FAILED` (we asked and it did not answer), `PARTIAL`/`TRUNCATED_BY_QUOTA` (the
budget ran out). Un-fetched leads are kept as **rejected leads carrying the suspension as their
reason**, so nothing is lost.

**T36's "or after result" half** (decision **D-032**): a result produced before a suspension is
**not deleted** — deleting it would destroy an accurate record of what was found and when — and a
later read shows `sourceSuspendedSince` on the finding's document **and** `sinceSuspendedSources`
on the findings page. Both, because they answer different questions: "can I rely on this finding?"
and "has anything about this whole report changed?". Computed at read time from current health,
never stamped at write time, because "since suspended" is a statement about now.

**Routes:** `GET /v1/admin/source-health` (needs `platform:read_health`, so an operator can see
breaker state without being handed evidence access), `POST /v1/admin/sources/{id}/kill-switch`
(one person — stopping is the safe direction, and requiring a second approver means the fetching
continues while they are found) and `.../kill-switch/release` (**four eyes**, and refused to
whoever engaged it).

**Failure-injection rows FI-17 and FI-18** appended in the existing format, with the row-to-test
map and the where-tested table updated. FI-18's reconciler is the point-of-use recheck, not a
sweeper, for the reason above.

---

### D6 — the lexicon audit on the activation path, and the term lists

**`auditTaxonomyForActivation` now blocks `ACTIVE`** on four things. `assertLexiconClean` already
failed CI, and CI catches a term an engineer commits — it catches nothing a `taxonomy_admin` types
into the admin API. Refused:

1. a **protected-characteristic term** (T79, SEC-05);
2. a **`MACHINE_TRANSLATED`** term (D-010) — recording provenance means nothing unless one of its
   values is refused;
3. a **recall figure an administrator authored**. `measuredRecall` is settable only by an
   evaluation run (FR-16), enforced by comparing the candidate's language profiles against the
   currently active version: any difference is an admin edit, because the admin API is the only
   thing that produced this version. Until the FR-16 evaluation seam exists (G10), **no language
   can become enabled** — which is the honest state and exactly what the coverage statement says.
4. a **category enabled for a country with no approved active source** — enablement without
   sources produces a category that is searched for and never found, which reads as a clean result
   for that category.

**The denial is audited in its own transaction**, following the D1 pattern: a denial written
inside the transaction that then throws is rolled back with it and leaves no trace, which is the
opposite of what SEC-06 wants.

**`resolveEffectiveScope` is exposed pure**, so "a disabled category is never queried" is provable
**here** rather than being an assertion about Phase E code. It also reports what a coverage
statement needs: enabled categories with no term to search with, and requested languages the
taxonomy does not declare at all — both silent narrowings if nobody reports them.

**The lexicon is no longer empty.** `packages/domain/src/taxonomy/seed-lexicon.ts` carries **155
hand-authored terms** across `en` and `es`: conduct terms for all seventeen categories, Costa Rican
procedural vocabulary (`imputado`, `acusación formal`, `allanamiento`, `prisión preventiva`,
`sobreseimiento`), and authority names (`Ministerio Público`, `OIJ`, `Sala Tercera`, `Contraloría
General de la República`). It lives in the pure package so `auditLexicon` gates it in CI. F3
category queries are now actually built; before this they were not, because the list was empty.

**⚠️ NO SPANISH READER HAS REVIEWED THE SPANISH TERMS.** This is the brief's second allowed
outcome — an unreviewed list whose state is recorded — taken because no Spanish-reading reviewer
was available. It is **not** the forbidden third option: nothing is machine-translated, and
activation refuses `MACHINE_TRANSLATED` outright. Recorded in five places so it cannot be
forgotten: `reviewState` on every term; the activation refusal; an `Unreviewed term lists:` line
in the FR-13 coverage statement (distinct from the unmeasured-languages line — unmeasured is "we
have not checked how much this finds", unreviewed is "we are not sure we asked the right
question"); a warning on every run; and decision **D-033**. The note **disappears by itself** when
terms become `REVIEWED_BY_SPEAKER`, so a review lands by editing terms rather than by remembering
to delete a warning.

**English is marked unreviewed too** — one engineer wrote both lists, and marking English reviewed
because its author reads English is exactly the self-certification the field exists to prevent.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         571 passed  (was 509: +32 source-health, +27 taxonomy activation, +3 coverage)
test:invariants    29 passed
test:evaluation    12 passed
test:integration  206 passed  (was 189: +12 source-health, +5 taxonomy-activation)
test:security     106 passed
coverage          94.21% statements / 91.14% branches (gate 85/80)
pnpm verify:local  every suite ok except end-to-end, still [n/i] and still exits non-zero
pnpm demo:api      runs end to end; findings, associations, rejected leads and coverage printed
```

**Left half-done:** nothing in code. The **open action** is the Spanish review (D-033), which is
not engineering work and is owned outside engineering.

**Found — three things worth knowing:**

1. **A real defect, fixed.** `TaxonomyService` read only the _flat_ field shape the bootstrap
   writes. A version proposed through `/v1/admin/taxonomy` stores its fields nested under
   `content`, so an administrator could take a taxonomy all the way through four-eyes approval and
   activation, see the API report success, and have the pipeline keep running under the seeded
   version — silently. Both shapes are now read, nested first. Caught only because the D6
   integration test loaded an activated version through the service the pipeline uses rather than
   asserting on the raw document.
2. **The six D2 fixture adapters had no registry entry.** D5 makes an unregistered source a
   refusal — an adapter pointed at a source nobody approved is what the registry exists to
   prevent — so the mock stack broke until the fixtures were seeded into `sourceVersions` like any
   other source. That is the right fix rather than weakening the gate: otherwise the mock stack
   exercises a path the live one does not have.
3. **`pnpm local:bootstrap` now runs `pnpm build` first**, because the seed lexicon is imported
   from the built domain package rather than copied into the script. Copying it would create a
   second term list beside the one CI gates, and the copy is the one that acquires a
   protected-characteristic term nobody checks.

**Next session should: expand `docs/execution/phase-e.md` into a full brief, then build
`HttpEvidenceFetchAdapter`** — the real `EvidenceFetchPort`, replacing the mock. Everything else in
the live work depends on it. The parked plan below is still the right plan and is now unblocked,
with one addition D5 makes mandatory:

**The fetch adapter must call `SourceHealthService.checkAccess` immediately before every external
call**, and feed the result back with `recordFailure` (passing the `FailureSignal`, never a class —
the FR-06 table classifies) or `recordSuccess`. Not at plan time. That is what makes the kill
switch, the breaker and the budgets real rather than decorative.

Then, in order:

1. Resolve the host with `node:dns` and call `screenResolvedAddress` on **every** returned address
   before connecting. Do not cache the resolution.
2. Fetch and cache robots.txt per host; `UNKNOWN` refuses unless the source registry carries an
   approved exception (`robotsPosition: EXCEPTION_APPROVED` with a named approver — the field
   already exists). **Raise open decision D6 — how robots exceptions are approved and recorded —
   with a source admin at the start of the phase**, not when the adapter is half-written.
3. Enforce the byte, decompressed-byte, redirect and timeout budgets. Re-screen the URL on
   **every** redirect hop: a 302 to `http://169.254.169.254/` is the obvious bypass.
4. Conditional GET with stored ETag / Last-Modified.
5. An honest user agent naming the service with a contact URL (FR-06 requires it).
6. Return `FailureSignal` values, never classes.

Then: news discovery connectors (Google News RSS, Bing News RSS, GDELT — GDELT has a JSON mode, so
only the two RSS sources need an XML parser and that dependency decision is still open); the
SearXNG connector against the instance already in the local stack; then real extraction to replace
the keyword placeholder.

**The largest remaining quality gap is now FR-10 clustering**, which is still not wired: a
syndicated copy counts as a second independent source on axis D. The lexicon was the other one and
is closed.

**Decisions touched:** **D-031**, **D-032** and **D-033** recorded. **D6** (robots exceptions) is
now in the direct path and due at G6 — raise it early. **D-010** is now enforced in code rather
than only written down. Nothing closed, nothing newly blocked.

**Still true:** no live source has been contacted by this project. No language is enabled — none
has a measured recall figure. Every seeded record is stamped `MOCK`.

---

## 2026-09-14 (late) — Started the live fetch gate: URL policy and robots, both pure

**Context for whoever picks this up.** The session before this one built the search pipeline and
a working end-to-end demo **on fixture data**. The customer conversation that followed asked for
a **realistic test on real adverse media**, so the work now is connecting real sources. This
entry is the first increment of that, and it is deliberately a small, complete one: two pure
modules with their tests, committed green, with no half-written adapter left behind.

**Did — two pure modules, no I/O.**

**1. `packages/domain/src/fetch/url-policy.ts` — the SEC-02 gate.** Decides whether a URL may be
fetched at all: https only, port allowlist, no embedded credentials, and IP-literal screening
against loopback, private, link-local (including `169.254.169.254`, the cloud metadata service),
carrier-grade NAT, multicast, IPv6 unique-local and IPv4-mapped IPv6.

**The split that matters and must not be collapsed.** `screenUrl` judges what the string alone
can show. It **cannot** stop `news.example.com` resolving to `127.0.0.1`, because that needs DNS.
So the gate has two halves and the adapter must call both: `screenUrl` before resolving, and
`screenResolvedAddress` on **every** address DNS returns, immediately before connecting. The
second half is what defeats DNS rebinding, and `isForbiddenAddress` is exported separately so
the adapter cannot quietly skip it.

Canonicalisation is here too, and it is not cosmetic: it lower-cases the host, drops the
fragment and tracking parameters, and sorts the query — so the same article reached through two
feeds deduplicates to one lead. Without it, axis D counts one story as two independent sources.
The path is left exactly as written, because paths are case-sensitive and "normalising" one
turns a working URL into a 404.

**2. `packages/domain/src/fetch/robots.ts` — robots.txt, parsed and applied.** De facto standard:
`Allow` honoured, `*` and `$` wildcards, longest match wins, `Allow` beats `Disallow` on a tie,
stacked `User-agent` lines share a group, unknown directives ignored rather than failing the file.

**The decision worth arguing with is the failure case.** A robots.txt that times out, 500s or
returns an HTML error page yields `UNKNOWN`, **not** `ALLOWED`. Reading "no rule found" as
permission makes an outage at the publisher into consent. A genuine 404 is different and is
treated as permission — the publisher chose not to write one.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         509 passed  (was 475: +34 for url-policy and robots)
test:invariants    29 passed
test:evaluation    12 passed
test:integration  189 passed
test:security     106 passed
pnpm verify:local  every suite ok except end-to-end, still [n/i]
```

**Left half-done:** nothing. Both modules are complete and tested; no adapter was started, so
there is no partial I/O code to untangle.

**Next session should: finish Phase D — D5 then D6.** This was decided by the project owner on
2026-09-14, after the demo, in preference to continuing straight down the live-source path. The
reasoning is sound and worth restating so nobody re-opens it: **D5 is source health — rate
limits, circuit breakers, per-source budgets and a mid-run kill switch — and the moment a real
source is dialled it stops being a later phase.** Building the live fetch adapter first would
mean pointing an unthrottled fetcher at Google News and getting blocked. D6 is the lexicon and
its activation-path audit, which is the largest quality gap in the whole system: the term list
is empty, so today a search only looks for the bare name.

So the order is now:

1. **D5** — `SourceHealth` as a **separate mutable document** keyed by source. The phase brief's
   "trap to avoid first" is explicit: it must not live inside the immutable `SourceVersion`, or
   you are choosing between breaking immutability and losing the data. Breaker over the existing
   `failure-classification.ts` classes — it invents no new ones. Per-source hourly and daily
   budgets the planner spends against. A kill switch effective **mid-run**, not at the next run
   (T36). Two new rows appended to `docs/failure-injection-matrix.md` — read the format there
   before appending.
2. **D6** — the lexicon audit wired into the activation path (`assertLexiconClean` already exists
   and already gates CI; D6 adds the call at activation), plus the Spanish and English term
   lists. **The Spanish list must be reviewed by a Spanish reader before it goes live, or its
   unreviewed state must be recorded in the coverage statement and the handoff** — the brief
   allows either, but not silence.
3. Then G5 closes and Phase D is complete.

**After Phase D**, resume the live-source work below. It is still the right plan and nothing
about it has changed.

---

**The live-source plan, parked until Phase D closes.** Build `HttpEvidenceFetchAdapter` — the
real `EvidenceFetchPort`, replacing the mock. Everything else in the live work depends on it.
Concretely:

1. Resolve the host with `node:dns` and call `screenResolvedAddress` on **every** returned
   address before connecting. Do not cache the resolution.
2. Fetch and cache robots.txt per host; `UNKNOWN` refuses unless the source registry carries an
   approved exception (`robotsPosition: EXCEPTION_APPROVED` with a named approver — the field
   already exists on the source schema).
3. Enforce the byte, decompressed-byte, redirect and timeout budgets. Re-screen the URL on
   **every** redirect hop: a 302 to `http://169.254.169.254/` is the obvious bypass.
4. Conditional GET with stored ETag / Last-Modified.
5. An honest user agent naming the service with a contact URL (FR-06 requires it).
6. Return `FailureSignal` values, never classes — the FR-06 table classifies.

Then, in order: news discovery connectors (Google News RSS, Bing News RSS, GDELT — GDELT has a
JSON mode, so only the two RSS sources need an XML parser and that dependency decision is still
open); the SearXNG connector against the instance already running in the local stack; the
taxonomy lexicon (**the largest quality gap — the term list is empty, so today the system only
searches the bare name**); then real extraction to replace the keyword placeholder.

**The plan these steps come from** is in the conversation and summarised here so it is not lost:
Stage 0 — real company data, needs only a free Companies House key. Stage 1 — the block above,
roughly 5–8 working days, which is what produces the first genuine result on a real person.
Stage 2 — source health, breakers and budgets (D5), before any sustained live running. Stage 3 —
clustering and richer identity matching. Stage 4 — labelled cases and the accuracy measurement,
which can start now because it needs no code.

**Decisions touched:** none recorded. **D6 is now directly in the path** — the lexicon is the
next quality blocker and the audit must gate activation before any term reaches an outbound
query. **D5 is no longer optional**: the moment a real source is dialled, rate limits and
breakers stop being a later phase.

**Still true and worth repeating:** no live source has been contacted by this project. Nothing
in this entry changes that — both modules are pure and neither opens a socket.

---

## 2026-09-14 (evening) — **Out of phase order, for a demo**: the search pipeline, the findings API, and the Target Platform client

**Read this first.** The phase order was broken deliberately. D5 and D6 are **not** done; this
session jumped to a compressed slice of **Phase E** because a customer call needed something
demonstrable. What exists now is a working end-to-end search in mock mode and a typed client for
an integrator. What does not exist is everything D5 and D6 were going to build — source health,
breakers, budgets, the kill switch, the lexicon audit on the activation path, and the Spanish
lexicon. Phase D is **not** complete and gate G5 is **not** passed.

**Did — four things.**

**1. The search pipeline, and the first job handler this service has ever had.**
`apps/api/src/pipeline/`. Phase C built the consumer and registered nothing against it (D-016),
so an accepted search returned `QUEUED` and stayed there forever. A search now runs:
associations → bounded query plan → discovery → fetch into committed evidence → extraction →
four-axis banding → completion.

Almost none of this is new logic. `buildQueryPlan` is new and pure; everything else —
`boundPlan`, `gradeIdentity`, `gradeAttribution`, `classifyEvent`, `computeAuthority`,
`assignBand`, `aggregateRun`, `renderNoMatchStatement` — was written and tested in Phase G0 and
**had no caller**. The pipeline sequences them and records what happened; every judgement stays
a pure function, so a bug in the pipeline produces a wrong record rather than a wrong rule.

**2. `GET /v1/searches/{id}/findings`**, as a first-class contract schema so the control panel
can generate its client from it later. Findings arrive **with** the three result dimensions,
because a caller holding an empty array and no coverage cannot tell a clean run from one where
every source was blocked. No numeric score anywhere (I9). Every claim carries spans into the
stored document. Rejected leads are returned with reasons rather than discarded (FR-06).

**3. `pnpm demo:api`** — one command that drives the whole thing over real HTTP with a machine
API key, faking no step. It starts the API and worker if they are not running, issues a key,
creates a subject, submits, polls, and prints findings, associations, rejected leads, coverage
and a plain statement of what the run is and is not.

**4. `@adverse-search/client` + `examples/target-platform-integration.mjs` + `docs/integration/target-platform.md`.**
The G9 pull half: a typed Node client, a worked example, and the integration contract written
down. Per the G9 brief these live in this repository until Target Platform workspace access is granted.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         475 passed  (was 460: +15 client tests)
test:invariants    29 passed
test:evaluation    12 passed
test:integration  189 passed  (was 179: +9 pipeline, +1 fence regression)
test:security     106 passed
coverage          93.56% statements / 90.73% branches (gate 85/80)
pnpm verify:local  every suite ok except end-to-end, still [n/i]
```

Run against the real stack, and the demo run was watched end to end: a search submitted over
HTTP came back `SUCCEEDED / POTENTIAL_MATCHES / INCOMPLETE` with two findings, their reasoning,
one rejected lead and an honest coverage statement.

**Found — five bugs, four of them latent for phases.**

1. **`renewLease` invalidated the fence it was supposed to protect.** It increments the stage's
   `revision`; `completeFenced` fences on the revision captured at lease time. So **any handler
   that heartbeats invalidated its own completion**: the work succeeded, the fence refused it,
   the result was discarded and the message was redelivered. Nothing caught it for three phases
   because no handler existed to call `heartbeat()`. The fence now advances with the lease
   owner's own renewals and with nothing else. Regression test added in `jobs.test.ts`.
2. **My handler incremented the run's `revision`**, which is the consumer's fence field. Two
   writers on one counter is exactly the drift the fence exists to prevent. The handler now
   guards on `execution !== 'CANCELLED'` (T30) and leaves the revision alone.
3. **The mock extractor invented category ids that matched nothing.** It used kebab-case
   (`fraud-financial-crime`) while the taxonomy uses `FRAUD_FINANCIAL_CRIME`, so every extraction
   was silently dropped as "category not enabled". It typechecked because the field is a string,
   and no unit test saw it because both halves were internally consistent. Now typed as
   `AdverseCategory`.
4. **An optional env var written `VAR=` failed `.min(1)`** instead of reading as unset, which
   stopped the API and the worker booting from the committed `.env.example`. Blank is now absent,
   for every optional variable.
5. **The discovery mock matched queries by whole-string equality**, so it answered exactly one
   hard-coded string and nothing a real planner produces. It now matches on required terms.

**Also corrected:** coverage now reports `INCOMPLETE` when a searched language has no measured
recall figure. Every source completing says the _sources_ worked; it says nothing about whether
queries in an unmeasured language find what exists.

**Left half-done — read this before the next session builds on it.**

- **Syndicated copies are not clustered.** One story carried by two publishers currently produces
  **two findings**, each reporting `independenceCount: 1`. `decideClustering` and the FR-10 rules
  exist in the domain package and the pipeline does not call them. This is visible in the demo
  and is documented as a known gap in `docs/integration/target-platform.md`. It was left rather than
  rushed: a wrong independence count inflates bands, which is worse than a visible duplicate.
- **Axis A is thin.** The pipeline builds a single identity factor from "the document names the
  subject". The real identifier extraction (dates of birth, roles, places in the text) is not
  wired, so identity grades are `PARTIAL` where they should often be stronger or weaker.
- **Axis D is single-document.** Authority is computed per finding over one source, so
  independence is always 1. Real independence needs the clustering above.
- **One job, one stage.** The pipeline runs as a single `search:execute` stage rather than the
  FR-09 stage ladder. The consumer's guarantees apply at search level, which is sound, but
  progress reporting is coarse (`stagesCompleted: 6` is hard-coded).
- **No callbacks.** Polling only; the signed-webhook half of G9 is not built.
- **D5 and D6 are untouched.**

**Next session should:** decide explicitly whether to finish Phase D (D5 source health and
breakers, D6 the lexicon audit on the activation path) or to continue Phase E properly. If the
demo leads to more integration work, the highest-value single fix is **wiring FR-10 clustering
into the pipeline** — it is the difference between "two articles" and "one story, two
publishers", and it is what `axes.independenceCount` is supposed to mean. Start at
`SearchPipeline.assess`, where findings are currently produced one per extracted assertion.

**Decisions touched:** none recorded, and that is deliberate — this session implemented against
existing decisions rather than taking new ones. **D-016 is now satisfied** (a handler exists, so
the worker starts). **D-011 unchanged**: no name-frequency distribution is loaded, so every
identity grade in Costa Rica is computed without the top-decile penalty. **D2 unchanged**: no
archive horizon is measured, and the no-match statement says so rather than naming a date.

---

## 2026-09-14 (later still) — Phase D step **D4 done**: configurable bounds, visible truncation, and association coverage that reaches the run

**Did — four things, one of which corrects D3.**

**1. The three FR-02 traversal bounds are configuration, not constants.**
`maxOfficerCandidates`, `maxCompaniesPerOfficer` and `maxEdgesPerSnapshot` now live on the
tenant's **policy version**, read through a new `PolicyService`, and are **pinned onto the
snapshot at creation**. Decision **D-028**.

Pinning is the load-bearing half. A bound raised in October must not change what a search from
March is reported to have covered, or the truncation note stops matching the graph printed beside
it. `loadPinned` reads by version with **no `status` filter** for the same reason: a superseded
version is still the one that run used, and refusing to read it would make an old search
unexplainable the moment its policy was revised.

A bad bound never fails a search: `resolveGraphBounds` falls back to a documented default per
field and returns a problem string that travels into the coverage statement. Stated, not silent —
a run that quietly fell back is a run whose truncation nobody can explain. Each bound also has a
**ceiling**; a policy may narrow the traversal, never remove the limit.

`maxEdgesPerSnapshot` is new — D3 had only two bounds. It is the backstop on the other two: a
handful of officers each with a few hundred directorships passes both per-call caps and still
produces a graph nobody can review.

**2. A bound that binds is a record, not a sentence.** Every bound produces a structured
`BoundApplication` — which bound, its limit, how many existed (**null** when the source does not
say, which is a different fact), and what it applied to. D3 stored only the rendered sentence,
which meant the only way to ask "did the edge cap bind?" was to match on a string.

**3. Association coverage reaches the run.** `summariseAssociationCoverage` is the pure mapping
from the graph's three outcomes into a `SourceCoverageOutcome`, and
`SearchesService.recordAssociationCoverage` stores it on the run and re-runs `aggregateRun` —
which existed, was tested, and had **no caller in the application** until now.

| Graph outcome | Meaning                                  | Run outcome          |
| :------------ | :--------------------------------------- | :------------------- |
| `COMPLETE`    | Answered, within bounds                  | `COMPLETED`          |
| `INCOMPLETE`  | Asked; something failed or a bound bound | `FAILED` / `PARTIAL` |
| `UNKNOWN`     | **Never asked** — no register covers it  | `SKIPPED`            |

Both `INCOMPLETE` and `UNKNOWN` make the run's coverage `INCOMPLETE`, which is correct — but they
map to **different** source outcomes with **different** details, so "we never asked" and "we asked
and it failed" never become the same fact. A bound is `PARTIAL` with `TRUNCATED_BY_PLAN`, not
`FAILED`: a bounded traversal still produced real associations.

**Only the `coverage` dimension is written back** (decision **D-030**). `aggregateRun` also
returns `execution` and `findings`, and applying those here would be wrong: with a single failed
source outcome it correctly concludes `FAILED`, which is right for a run in which nothing else ran
and quite wrong for a real one whose person search is still to come. That is what makes FR-02's
degraded execution real — a registry outage leaves the run alive with honest coverage, and no path
in that method fails, deletes or rolls back the run.

**4. Corrected D3: the historical-scope approval was on the wrong record.** See "Found" below.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         460 passed  (was 442: +18 domain tests for bounds and coverage mapping)
test:invariants    29 passed
test:evaluation    12 passed
test:integration  179 passed  (was 170: +9, all in associations.test.ts)
test:security     106 passed  (unchanged)
coverage          94.92% statements / 90.72% branches (gate 85/80)
pnpm verify:local  every suite ok except end-to-end, still [n/i] and still exits non-zero
```

Run against the real stack: `pnpm local:up` and `pnpm local:bootstrap`.

**Found — three things.**

1. **D3 gated the historical scope on the wrong record, and duplicated a field that already
   existed.** I added a `historical_directorships` **entitlement capability** in D3. The seeded
   policy version has carried `historicalScopeApproved` since Phase A, and nothing read it. FR-02
   calls it an _approved_ historical scope: an entitlement describes what a customer **bought**, a
   policy version describes what has been **approved** for them to do, and those are different
   questions with different owners. The policy version is also what goes through four eyes, writes
   an audit entry and is pinned to the run — so a historical search can cite the version that
   permitted it. Moved to the policy, entitlement capability removed, error message now names the
   policy field so an administrator is sent to the record they actually have to change. Decision
   **D-029**. The refusal itself is unchanged and still the point.
2. **A missing entry in a Nest `inject` array is a runtime error, not a compile error.** Adding
   `PolicyService` to the `AssociationGraphService` factory's parameters without adding it to
   `inject` typechecked cleanly and failed at container construction with
   `Cannot read properties of undefined (reading 'mode')` — a message that points at the last
   argument rather than the missing one. Only the security suite caught it, because it is the only
   suite that builds the real module. Worth knowing: the factory signature and the `inject` array
   are two lists that must agree and nothing checks that they do.
3. **A test regex that was wrong in a way that looked like a code failure.** My assertion that no
   coverage detail ever claims "no associations exist" used a negative lookahead for the denial —
   but the denial ("no result from a registry does not prove...") _precedes_ the phrase, so it
   failed against correct text. Fixed the assertion, not the message. The rewritten version is
   also clearer about what it wants: any mention of the phrase must be a denial of it.

**Left half-done:** nothing in D4, but **T20 stays `[~]`** and the reason is unchanged from D3 —
the graph half is fully done (outage, empty answer and bound overrun are three distinct outcomes,
each with honest coverage on both the snapshot and the run, and the run provably survives the
outage), but "the person search itself completes" needs the Phase E job handler. There is no
person search to complete yet, so claiming that half would be claiming a test nobody can run.

`recordAssociationCoverage` has no caller in the running service either: the worker will call it
when Phase E registers a handler. Today it is driven by tests, the same arrangement `build()` and
`JobConsumer.handle()` use.

**Next session should:** start **D5** — `SourceHealth` as a separate mutable document keyed by
source (never inside the immutable `SourceVersion`; the brief's "trap to avoid first" is explicit
about this), the FR-06 breaker over the existing `failure-classification.ts` classes, per-source
hourly and daily budgets the planner spends against, and a kill switch that takes effect
**mid-run** rather than at the next run (T36). D5 also appends two rows to
`docs/failure-injection-matrix.md` — read the format there before appending. See
[`phase-d.md`](./phase-d.md) step D5.

**Decisions touched:** **D-028, D-029, D-030 recorded.** D-029 **corrects D-027** (the
historical-scope approval moved from the entitlement to the policy version); D-028 supersedes part
of D-026 on where bounds come from. No open decision closed. **D-011 is unchanged and still the
most consequential open item for identity quality** — no Costa Rican name-frequency distribution
is loaded, so the top-decile penalty never fires for CR names, and the bootstrap says so on every
run.

---

## 2026-09-14 (later) — Phase D step **D3 done**: sourced identity resolution, the `DIRECTOR_OF` edges, and the frozen snapshot

**Did — five things.**

**1. Resolution is an identity grade, in `packages/domain/src/association/`.** `resolveOfficer`
builds an Axis A `IdentityFactor` list out of what a register published and hands it to the
**same `gradeIdentity`** a document match uses. No register-specific notion of "matched enough"
exists, deliberately: a second one drifts from the document one, and the two then disagree about
the same person inside one run. The grade decides what the graph may do:

| Grade          | Status                 | The graph may…                                   |
| :------------- | :--------------------- | :----------------------------------------------- |
| `CORROBORATED` | `RESOLVED`             | attach the companies and anchor queries on them  |
| `PARTIAL`      | `CANDIDATE_FOR_REVIEW` | show the companies, anchor nothing               |
| `WEAK`         | `UNRESOLVED`           | show the officer, attach nothing                 |
| `CONTRADICTED` | `CONTRADICTED`         | nothing — the register says this is someone else |

**`PARTIAL` not attaching is the contested decision and it is deliberate.** One moderate
identifier — a birth month and year that agrees — feels sufficient when you are looking at one
candidate. It is not: a register publishing a month and year for a common name in a country of
five million returns several people who agree on it. Decision **D-025**.

**2. Currency is four values, not a boolean** (`scope.ts`, decision **D-024**). This is the one
place I read the brief carefully rather than literally, so it is worth the paragraph. FR-02 says
both "current confirmed directorships only" and "unknown end dates do not prove current status".
Taken literally together those exclude nearly every directorship a real register publishes,
because a register almost never records an end date for a serving officer — **absence is how it
says "still serving"**. A current-only search would then return nothing against most registers,
and the honest coverage line would be that we looked at no companies: a clean-looking result
produced by not looking. So `CURRENT_PER_REGISTER_SILENCE` is **in** the default scope and is
**never** labelled confirmed; the two current values travel separately to the reviewer and
nothing merges them. The proof half of the rule is enforced where it actually bites — attaching
an _event_ to a tenure goes through `labelTenure`, which answers `UNKNOWN` rather than
`DURING_TENURE` when the dates cannot show the person still held the role. That case has its own
test, as the brief asked.

**3. The three records, in `apps/api/src/associations/association-graph.service.ts`.**
`graphSnapshots` gets a `PENDING` row **inside the search-creation transaction**, so the run is
pinned to one snapshot id from the moment it exists; `build()` populates it later, off the
request path, because FR-02 forbids a registry outage failing the search. Companies are **copied
per snapshot** rather than shared — the day a register renames a company or moves it to
`dissolved`, a shared collection would silently rewrite every past search. A refresh links via
`refreshOfSnapshotId`; nothing mutates. Decision **D-026**.

**4. `GET /v1/searches/{searchId}/associations`** serves the frozen graph: edges with their
tenure, currency, scope decision and the full identity-factor list, the companies as observed,
and the unresolved candidates. OpenAPI regenerated and committed.

**5. The name-frequency prior — absence recorded, not filled in.** `assignDeciles` is pure and
tested; `scripts/bootstrap/name-frequency.mjs` is the loader and **refuses to run without a real
counts file**. Nothing is loaded, and the bootstrap prints why and what it costs on every run.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         442 passed  (was 395: +47 domain tests for resolution, scope and deciles)
test:invariants    29 passed
test:evaluation    12 passed
test:integration  170 passed  (was 147: +23 in tests/integration/associations.test.ts)
test:security     106 passed  (unchanged)
coverage          94.75% statements / 90.52% branches (gate 85/80)
pnpm verify:local  every suite ok except end-to-end, still [n/i] and still exits non-zero
```

Run against the real stack: `pnpm local:up` (7/7 healthy) and `pnpm local:bootstrap`.

**Found — four things, one of them a flaw in my own first design.**

1. **The known-company signal cannot be applied before the hop that reveals the companies.** My
   first cut resolved each officer once, from the officer search alone — and the officer search
   does not say which companies a register attributes to an officer. So the strongest signal
   available (the client supplied company X; the register puts a person of that name in company
   X) could never fire, and nothing ever reached `RESOLVED`. Caught by the one integration test
   that asserted a resolution _should_ succeed; every other test passed, because they all assert
   that something does **not** attach. **Resolution now runs twice**: the first pass decides
   whether asking is worth a call, the second — with the appointments known — is the one stored.
   Worth remembering: a suite full of "must not attach" assertions passes perfectly on a
   resolver that can never attach anything.
2. **Which officers are worth a second registry call is a real bound, not a detail.** Hopping for
   every weak name match spends a call per namesake. Hopping only for already-actionable
   statuses means a subject with a supplied company and a register that publishes no date of
   birth is never resolved at all — the common case in a register that publishes little. The rule
   is now: never a contradicted officer; always a resolved or reviewable one; **and** any
   non-contradicted one when the client supplied known companies. With nothing supplied, twelve
   namesakes still cost zero hops.
3. **Deciles must be drawn on population mass, not on the surname ranking.** My first
   implementation placed each name by the midpoint of its own mass, which puts a surname carried
   by 45% of a population into decile 8 — so the single most common name in the country would
   not be flagged top-decile. Now placed by where its mass starts, which is also monotonic: a
   rarer name can never receive a higher decile than a more common one. Both properties have
   tests.
4. **Two existing integration suites requested a historical scope they were not entitled to.**
   `transactions.test.ts` and `jobs.test.ts` both set `includeFormerDirectorships: true` against
   `tenant-alpha`, which was harmless while nothing checked it. As of D3 that is refused, so both
   were changed to current-only with a pointer to the suite that tests the refusal. `tenant-beta`
   is now seeded **with** `historical_directorships` and `tenant-alpha` without it, so both paths
   are exercised; granting it to both would have left the refusal untested, and the refusal is
   the half that matters (decision **D-027**).

**Left half-done:** nothing in D3, but two things are scoped to D4 and should not be mistaken for
gaps here. The **bounds** are implemented and reported (`coverage.boundsApplied` names every
bound that bound) but are not yet configurable per tenant — that is D4. And **person-only
degraded execution** is only half-demonstrable today: the graph already survives a registry
outage and reports `INCOMPLETE` without throwing, but there is no job handler yet (Phase E), so
"the run completes anyway" has no run to complete. T20 is therefore still `[~]` in the brief.

`build()` is called directly by tests rather than by a worker, for the same reason: the handler
seam exists and nothing is registered against it until Phase E.

**Next session should:** start **D4** — make the one-hop bounds configurable (maximum companies
per subject, maximum officers per company, maximum edges per snapshot), surface them in the same
spirit as `TRUNCATED_BY_PLAN`, and wire association coverage into the run's own
`SourceCoverageOutcome` so a bounded or failed graph shows up in the search's coverage statement
rather than only on the snapshot. `DEFAULT_GRAPH_BOUNDS` in `association-graph.service.ts` is
where the hard-coded values live today. See [`phase-d.md`](./phase-d.md) step D4.

**Decisions touched:** **D-024, D-025, D-026, D-027 recorded** (four currency states with
silence never confirmed; Axis A resolution with `PARTIAL` not attaching; the snapshot created
with the run and companies copied per snapshot; a historical scope refused rather than narrowed).
**D-011 is unchanged and still open**, and is now the single most consequential open item for
identity quality in Costa Rica: until the SEC-05 aggregate-only approval for the TSE padrón
exists, no distribution is loaded, the top-decile penalty never fires for CR names, and a common
name reaches a higher identity grade than it should. That is stated in the bootstrap output, in
the architecture document and here, rather than being quietly absent.

---

## 2026-09-14 — Phase D step **D2 done**: the six FR-05 seams, six deterministic mocks, one real registry adapter, and the conformance gate D1 left open

**Did — four things.**

**1. All six FR-05 ports, in `apps/api/src/sources/`.** `NewsDiscoveryPort`,
`WebDiscoveryPort`, `PrimarySourcePort`, `CompanyRegistryPort`, `EvidenceFetchPort`,
`ExtractionModelPort`. Defined together and now, rather than one at a time as adapters arrive,
because a seam invented at the moment its first adapter is written is shaped by that adapter.
Three things are shared and live in `source-adapter.ts`:

- **`SourceOutcome<T>` — four statuses, never a list** (`OK` / `BOUNDED` / `NO_RESULTS` /
  `FAILED`). A caller cannot reach the data without first matching on what happened. An adapter
  returning `Officer[]` collapses "the registry is down", "the registry holds nobody by that
  name" and "we stopped at the bound" into one empty array, and an empty array downstream reads
  as _no associations exist_ — the sentence FR-02 explicitly closes by forbidding. Decision
  **D-021**.
- **Provenance rides with the data** — adapter id, source id, parser version, stability class,
  mode, retrieval time. FR-05's volatility control keys off the parser version and D5's breaker
  off the stability class; both are useless if they have to be recovered from the registry after
  the fact.
- **`MockModeWitness`** — decision **D-022**, below.

**2. Deterministic mocks for all six, with the fixtures authored from T14/T15/T20 first.**
`apps/api/src/sources/mock/`. The registry corpus is CR (D-010 enables Costa Rica only), sorted
before return, and stamped from an injected fixed clock — a mock with incidental ordering makes a
graph test fail once a fortnight and look like a resolution bug every time.

- **T14** — two officers under one **byte-identical** name (`María Fernanda Solís Rojas`), with
  different partial dates of birth and **disjoint** companies. A fixture using "María" and
  "Maria" would be testing the name matcher instead and would pass for the wrong reason. One of
  the two publishes no `appointmentCount`, because registers vary and a bound check that reads
  that field must cope with the register that does not say.
- **T15** — five directorships that produce all five tenure labels through `labelTenure`,
  including the appointment known only to the **year** and the directorship with **no
  resignation at all**. The probe events live beside the tenures rather than in the test,
  because they are half of the same design.
- **T20** — the registry can be made to fail, holds a name with nothing under it, and holds a
  name matched by twelve officers. Three outcomes, separately asserted, and asserted to be
  three _different_ statuses.

**3. One real adapter: UK Companies House** (`companies-house.adapter.ts`) — and it is **not**
Costa Rican coverage. `jurisdictions: ['GB']`, and asking it about CR **throws** rather than
returning a `FAILED` outcome, because a coverage gap would put a line in a coverage statement
implying CR officer data was attempted when it was never attempted at all. D14 stands unchanged.

**4. FR-05 content conformance — the half of D1 that was left open.**
`apps/api/src/admin/source-content.ts`, enforced at **submit** and again at **activation**, never
at propose. A draft is allowed to be incomplete; a version put in front of an approver is not,
because approving is the act that carries responsibility. Decision **D-023**.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         395 passed  (was 338: +57 in apps/api/test/source-adapters.test.ts)
test:invariants    29 passed
test:evaluation    12 passed
test:integration  147 passed  (was 141: +6 for FR-05 conformance)
test:security     106 passed  (unchanged)
coverage          94.69% statements / 90.47% branches (gate 85/80) — unchanged; the new code
                  is in apps/api, which this project's coverage include does not measure
pnpm verify:local  every suite ok except end-to-end, still [n/i] and still exits non-zero
```

Run against the real stack: `pnpm local:up` (7/7 healthy) and `pnpm local:bootstrap` before the
integration and security suites. Docker was not running at the start of the session and was
started for this.

**Found — four things, two of them latent defects on any already-seeded database.**

1. **`mode` was a caller-supplied field on `sourceContentSchema`.** So a source version proposed
   through the admin API in a mock stack could declare itself `LIVE` — T55 with the labelling
   under the proposer's control. Removed from the schema; the service stamps mode on the
   envelope from the running configuration, and `.strict()` now rejects content that carries it
   rather than ignoring it. OpenAPI regenerated and committed.
2. **`mode` and `seededAt` were leaking into version _content_.** They were not in
   `ENVELOPE_KEYS`, and a seeded record stores its fields flat, so `splitContent` was putting
   both into content. Harmless while nothing read content; the moment conformance was enforced,
   every seeded source failed for carrying a `mode` it never declared. Both are envelope fields.
3. **Two renamed fields survived on this machine's database, because the bootstrap is an
   upsert and `$set` never deletes.** `approvalState` (renamed to `status` in **D1**) and
   `sourceType` (renamed to `connectorType` in D2) were both still sitting on the seeded
   sources. This only became visible because the new integration test holds every seeded source
   to the same conformance standard as an administered one — and it failed, correctly, naming a
   field nobody in the current code has ever written. The bootstrap now unsets both explicitly
   rather than leaving it to a `local:reset` somebody may reasonably never run. **Worth
   remembering for every future rename: the seed file changing is not the database changing.**
4. **A mock-mode check inside each adapter is a check that eventually is not written.** The
   first design had `if (mode === 'LIVE') throw` at the top of each mock. It works, and the one
   that gets omitted is the one in the _next_ mock adapter, six months from now. Replaced with
   `MockModeWitness`: a private constructor, one factory returning `null` for `LIVE`, and every
   mock constructor requiring one. Omitting it does not compile.

**Left half-done:** nothing in D2 — but read the scope line in the Phase D brief carefully.
T14, T15 and T20 are marked `[~]`, not `[x]`, and deliberately: D2 built the **fixtures and the
seams** that make those tests possible, not the behaviour they ultimately assert. That the wrong
person's companies do not attach is **D3** (the resolver does not exist yet). That the person
search completes through a registry outage is **D4**. Marking them done here would be claiming
a test passes that has not been written.

Five of the six ports have **no live adapter**, by design — they are Phase E. In live mode
`buildSourceAdapters` returns `null` for them rather than a mock or an empty stub, so a caller
must handle "this capability has no source" explicitly. An empty stub would make a live process
report clean results from sources that were never consulted.

**Next session should:** start **D3** — `Company`, `AssociationAssertion` and `GraphSnapshot`,
with resolution as an **identity grade** (axis A with the name-frequency prior), not a string
comparison, and the snapshot frozen and pinned to the run the way `EntitlementsService.pinVersions`
pins versions. The T14 fixture is waiting for exactly this: two officers, one name, disjoint
companies, and nothing on `OfficerCandidate` that would let a resolver attach either. See
[`phase-d.md`](./phase-d.md) step D3.

**Decisions touched:** **D-021, D-022, D-023 recorded** (four-way outcome; the mock-mode witness
and mode off the content schema; conformance at submit rather than propose). **D14 updated, not
closed** — the engineering alternative it was waiting on is now built and proven against a real
register, so what remains is a product call about CR scope rather than a feasibility question.
**D7** (which extraction model) is untouched and still open; `ExtractionModelPort` exists
precisely so Phase F can benchmark candidates that are interchangeable, and the mock is honestly
labelled rule-based with a null `modelId` rather than pretending to be a model.

---

## 2026-09-11 (late) — Phase D: brief expanded, **D0 done** (CR source dossier), **D1 done** (approval lifecycle + SEC-05 gate + capability coverage)

**Did — three things.**

**1. Expanded `docs/execution/phase-d.md`** from a ~4KB outline into a full brief in the Phase C
format, adding a step the outline did not have — **D0, the Costa Rica source dossier, before any
adapter** — because D-010 makes CR the only enabled jurisdiction and every free source this plan
was written around (Companies House, EDGAR, CourtListener) is UK or US.

**2. D0 — `docs/sources/cr-dossier.md`, v1.** Desk research only: **no source was contacted** —
search-engine queries, no endpoint call, no page fetch, no robots.txt read. Every claim labelled
`DOCUMENTED` / `INFERRED` / `UNKNOWN`; nothing marked verified. Three findings changed the phase:

- **No free automatable officer-level source exists in Costa Rica.** The Registro Nacional
  publishes company representatives only behind free registration **and a CAPTCHA** — a hard stop
  under FR-06, not an engineering problem. `api.hacienda.go.cr` is free and machine-readable but
  returns entity status and economic activity and **nothing about directors**. FR-02 therefore has
  no data source in the only enabled jurisdiction. Raised as **D14**.
- **Published CR judgments are probably depersonalised** — the Poder Judicial runs a
  de-identification protocol, a de-personalising tool and a repository of depersonalised
  judgments. A judgment with the names stripped is not a weak match; there is no name in it to
  match. Raised as **D15**.
- **The TSE padrón electoral solves the D-011 name-frequency gap**, under an aggregate-only
  constraint: derive the surname counts, **discard the roll**, name the use in the SEC-05 approval.

**3. D1 — the administrative spine.** Pure decisions in
`packages/domain/src/{lifecycle,rights,capability}/`; persistence and routes in
`apps/api/src/admin/`. Reasoning in `docs/decisions.md` **D-018/D-019/D-020**, mechanics in
`docs/architecture.md` under "Administrative records and the rights gate".

- **One lifecycle for three record kinds** — `PROPOSED → AWAITING_APPROVAL → APPROVED →
ACTIVATING → ACTIVE`, plus `SUSPENDED` / `SUPERSEDED` / `RETIRED` — wiring the existing pure
  `canApprove` rather than writing a second four-eyes check.
- **SEC-05 as an enforcement function**, not metadata: `decideRights` returns
  `ALLOW` / `DENY` / `REQUIRES_APPROVAL` with reason codes and machine-actionable restrictions,
  over jurisdiction, source, intended use, classification, collection method, retention, raw
  personal data, approval requirement and approval evidence. Default-deny throughout.
  `clearForActivation` is the gate in front of `ACTIVE`.
- **Capability coverage** per jurisdiction — `SUPPORTED` / `PARTIAL` / `UNKNOWN` / `UNSUPPORTED`
  — stored, surfaced on `GET /v1/admin/coverage/{jurisdiction}`, with one function
  (`interpretEmptyResult`) deciding what an empty result may be called. **Only `SUPPORTED` yields
  `NO_FINDINGS`.**
- **CR constraints are seeded data, not code.** `packages/domain/src/capability` contains no
  mention of Costa Rica; the nine CR rows live in `scripts/bootstrap/seed-data.mjs` with their
  rationales and the decision each is blocked by.
- Routes: `/v1/admin/{sources,taxonomy,policies}` with propose / list / read / edit-draft /
  transitions / activate, plus the coverage read and declare. OpenAPI regenerated and committed.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         338 passed  (was 283: +55 domain tests for lifecycle, rights, capability)
test:invariants    29 passed
test:evaluation    12 passed
test:integration  141 passed  (was 120: +21 in tests/integration/admin-lifecycle.test.ts)
test:security     106 passed  (was  95: +11 in tests/security/admin-routes.test.ts)
coverage          94.69% statements / 90.47% branches (gate 85/80)
pnpm verify:local  every suite ok except end-to-end, still [n/i] and still exits non-zero
```

**Found — five things worth knowing, three of them defects in my own first design:**

1. **A denial audited inside the transaction that refuses is rolled back with it.** The four-eyes
   refusal returned a correct 403 and left **no audit entry at all** — the opposite of what SEC-06
   wants, since an attempt to approve one's own version is exactly what an auditor needs to see.
   Fixed by writing denials in their own transaction after the business one aborts. Found only
   because the test asserted the audit entry existed rather than asserting the 403.
2. **A parallel `recordId` scheme collided with the existing unique indexes.** `sourceVersions`
   keys on `{sourceId, version}` and `taxonomyVersions`/`policyVersions` on `{tenantId, version}`,
   with the lifecycle in a `status` field. So **a taxonomy's identity is the tenant**, not a free
   id — `pinVersions` depends on one taxonomy timeline per tenant. The service now writes the
   shape that already exists, which means the Phase A fixture sources are administrable rather
   than sitting beside a second registry. (`approvalState` on seeded sources was normalised to
   `status`; nothing read the old name.)
3. **`/v1/admin/:collection` shadowed the reserved `/v1/admin/plans`**, turning a documented 501
   into a 403. Nest matches in registration order: `ReservedController` must be registered first.
   Test added.
4. **One route-level permission cannot serve three record kinds.** `@RequirePermission` now
   accepts alternatives and admits a caller holding any of them, with the service enforcing the
   exact one against the loaded record; otherwise a `taxonomy_admin` was locked out of taxonomy
   administration by a `source:propose` gate. Single-permission routes behave exactly as before.
5. **Records created through the admin API carried no `MOCK` label and broke T55.** A version
   proposed through the API in a mock stack is as much a fixture as a seeded one, so the service
   now stamps the operating mode on every version it writes. My security suite also left records
   in `tenant-alpha` — the same shared-fixture mistake C6 warned about — and now cleans up.

**Left half-done:** D1's FR-05 field list exists as a validated contract schema
(`sourceContentSchema`, with alpha-2 validation rejecting "EU"/"MENA"/"SEA" and no free-text field
that becomes a fetch), but the service stores version **content as an opaque object and does not
yet enforce conformance**. That lands in D2, when the adapters that consume those fields exist and
can say which are load-bearing. `SourceHealth`, budgets and breaker state are D5 and deliberately
not on the immutable version.

**Next session should:** start **D2** — define the six FR-05 ports
(`NewsDiscoveryPort`, `WebDiscoveryPort`, `PrimarySourcePort`, `CompanyRegistryPort`,
`EvidenceFetchPort`, `ExtractionModelPort`), deterministic mocks for all six, and one real
`CompanyRegistryPort` adapter. Author the fixtures from T14/T15/T20 **before** writing the
resolver. Per D0, the real registry adapter cannot be Costa Rican: use UK Companies House as the
proving ground and label it out-of-jurisdiction.

**Decisions touched:** **D-018, D-019, D-020 recorded** (one lifecycle; SEC-05 as enforcement with
non-approvable prohibitions; a missing capability is never an empty result). **D14, D15 and D16
opened.** D16 is new from D1 and needs product and security: any tenant's `source_admin` can
change shared registry entries that **every** tenant screens against, because source config is
shared and `decideAccess`'s tenant comparison does not apply to a record owning no tenant. The
recommendation in `docs/open-decisions.md` is a platform-scoped source role, closing by G8 before
the panel renders whatever this decides. **D6** (robots exceptions) still wants a source admin
during this phase; `robotsPosition` is already a field on the source schema, so the record exists
to carry the answer.

---

## 2026-09-11 (night) — Phase C step C6: the consumer, fencing, cancellation and the dead letter. **Gate G4 passed.**

**Did:**

- **`apps/api/src/jobs/job-consumer.ts`** — the one place a queued message becomes work. One
  fixed sequence: parse → poison check → ownership (SEC-01) → receipt (FI-07) → stage identity
  (FI-07) → lease (FI-11) → work → fenced write (FI-11/FI-12) → acknowledge. `handle()` returns
  a **disposition** (`ACKNOWLEDGE` / `RETRY_LATER` with a delay / `DEAD_LETTER` with a reason)
  and performs no transport call, which is what makes the interesting cases assertable without
  a queue.
- **`worker-runtime.service.ts`** — the loop that carries dispositions out, the FI-11 lease
  sweep, and a drain-on-shutdown that lets the in-flight message finish. It **refuses to start
  with no handlers registered**; see "left deliberately unbuilt" below.
- **`dead-letter.port.ts`** — an explicit DLQ send with a reason, alongside (not instead of) the
  SQS redrive policy. `JOBS_DEAD_LETTER_QUEUE_URL` is now a production startup guard.
- **`job-handler.ts`** — the `JobHandler` seam a phase registers work against, plus `JobFailure`,
  which carries an FR-06 `FailureSignal` rather than a class: the handler observes, the table
  classifies.
- **`QueuePort.release(handle, delaySeconds)`** — the FR-06 backoff is served as the message's
  visibility timeout rather than by sleeping in the worker. `ReceivedMessage.envelope` is now
  nullable and carries the raw `body`, so a malformed message reaches the consumer as a decision
  instead of being dropped inside the SQS adapter.
- **Cancellation, end to end.** `POST /v1/searches/{searchId}/cancel` with a **required**
  `If-Match`; `GET /v1/searches/{searchId}` now returns the revision as an `ETag`, and
  `SearchSummary` carries `revision`. A stale `If-Match` returns 409 with a new `conflict`
  object on the error envelope (`expectedRevision`, `currentRevision`, `currentState`).
- **`worker-main.ts`** — the worker entrypoint. Same image, same DI graph, no HTTP server
  (decision **D-016**; there is no `apps/worker` package and will not be one). `pnpm dev:worker`.
- Config: `JOBS_DEAD_LETTER_QUEUE_URL`, `JOB_LEASE_MS`, `JOB_MAX_EXECUTION_MS`,
  `JOB_MAX_DELIVERIES`, with two production guards (no DLQ; an execution bound shorter than one
  lease).
- Docs: `architecture.md` gains "Consuming a message: one sequence, and why it is in that order"
  and "Two dead-letter mechanisms"; `decisions.md` D-016 and **D-017**; phase-c.md's definition
  of done fully ticked; `implementation-status.md` moves **G4 to Complete**; `START-HERE.md`
  points at Phase D.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         283 passed  (was 260: +23 in apps/api/test/job-consumer.test.ts)
test:invariants    29 passed
test:evaluation    12 passed
test:integration  120 passed  (was 101: +19 in tests/integration/jobs.test.ts)
test:security      95 passed  (was  93: +2 new production guards)
coverage          94.07% statements / 89.46% branches (gate 85/80)
pnpm verify:local  every suite ok except end-to-end, still [n/i] and still exits non-zero
```

T24, T29, T30, T31 and T41 all have named tests. Three properties were verified by planting the
failure rather than by asserting the happy path:

1. **The receipt is not the guard.** A test commits a stage, then **deletes the receipt
   outright**, then redelivers — and the second attempt is still refused, by stage identity. If
   it had passed only because a receipt existed, it was testing the cheap layer.
2. **A late completion loses.** The cancellation lands _while the handler is running_. The
   worker finishes, its fenced write is refused, the result is discarded and counted in
   `discardedAttempts`, and the run stays `CANCELLED` with `findings: NOT_EVALUATED` — not
   re-opened, not `PARTIAL`. A stage that had already succeeded is left byte-identical.
3. **Retry-After is honoured exactly.** With jitter forced to 1%, a `Retry-After: 30` still
   produces a 30-second delay, asserted on the delay the transport was actually asked for.

**Left half-done:** nothing in C6. What is **deliberately unbuilt** is the first job handler —
the worker refuses to start without one, because a handler-less consumer receives every queued
search and dead-letters it as unroutable, and a process that looks healthy while draining the
queue into the DLQ is worse than one that will not start. Registering the first handler is
Phase E.

**Found — five things worth knowing:**

1. **This suite broke another file's test, and the failure appeared in the other file.** The
   first version borrowed the seeded `tenant-alpha`; `transactions.test.ts`'s T63 asserts that a
   refused entitlement leaves `tenant-alpha`'s audit trail unchanged, and these tests — running
   in parallel against the same database — were writing to it. Fixed by seeding a tenant of this
   suite's own in `beforeAll` and deleting it in `afterAll`. Worth remembering when adding any
   integration suite: **borrowing shared fixture state makes some other file fail.**
2. **A stage is only claimable once it is due,** so a fencing test cannot arrange an expired
   lease by passing a `now` in the past — the claim fails for a reason unrelated to what is
   being tested. Move the _sweep's_ clock forward instead, not the claim's.
3. **A sweep assertion must not be a count.** `findExpiredLeases` is cross-tenant and bounded,
   so `swept.returned >= 1` really measures how much unrelated work the shared local database
   happens to be holding. The test asserts membership of the sweep's own query instead.
4. **The C0 matrix's row-to-test map had T31 pointing at FI-16** — notification delivery, which
   nothing in Phase C touches. T31 is repeated and out-of-order _queue_ deliveries, which is
   FI-07. Corrected in `docs/failure-injection-matrix.md`, along with a new table saying which
   file tests each row, and an explicit note that FI-14 and FI-16 have no coverage yet.
5. **An internal defect is not an FR-06 class** (decision **D-017**). Mapping a type error onto
   `CONTENT_ERROR` — the non-retrying default for an unrecognised _source_ signal — would put
   our own bug into the coverage statement as a dead lead attributed to the publisher. It is
   recorded with a null class, retried three times in case it was environmental, then abandoned.

**Next session should:** start Phase D by **expanding [`phase-d.md`](./phase-d.md) from an
outline into a brief** — it is not yet one, and the outline itself says what expanding it
involves.

**Decisions touched:** **D-016** (the worker is a second entrypoint, not a second application)
and **D-017** (an internal defect is not an FR-06 class) recorded. D12 stays closed on C4's
numbers.

**A correction to an earlier claim in this entry, and to the phase brief.** An earlier draft of
this handoff said D1, D3 and D8 still carry placeholders and close in Phase D. That is wrong:
all three closed on 2026-09-11 (D-010 Costa Rica with es+en requested but not enabled, D-009 all
seventeen categories, D-012 configurable 30-day retention). `phase-d.md`'s "Decisions to close"
section had gone stale the same way and has been corrected — **no decision is due at G5**. The
lesson for the next session: `docs/open-decisions.md` is the register, and a phase brief's list
is a copy that can rot. Read the register.

The nearest live decision is **D6** (how robots exceptions for official sources are approved and
recorded), due G6 but shaped by the source registry Phase D builds — raise it with a source admin
during Phase D, not at the start of Phase E. **D11** (a well-evidenced acquittal banding as
`CORROBORATED`) is still open and must close by Phase G.

---

## 2026-09-11 (late night) — Phase C step C5: evidence staging, the orphan sweep and retention deletion

**Did:**

- **`apps/api/src/storage/object-store.port.ts`** — the seam, plus `InMemoryObjectStore`. Holds
  `keyFor` (the **only** place an object key is constructed) and `tenantOfKey` (what the orphan
  sweep is allowed to delete). Keys are `evidence/<region>/<tenantId>/<YYYY-MM-DD>/<uuid>` with
  no caller input anywhere in them (SEC-03).
- **`S3ObjectStoreAdapter`** — the AWS SDK, for the reason `SqsQueueAdapter` uses it and not for
  convenience: SigV4 over a rotating role credential is a security control that should be used
  rather than re-implemented. Every write sends `ChecksumSHA256`, every read asks for
  `ChecksumMode: ENABLED`, and the listing paginates to the end — a truncated listing would make
  the orphan sweep silently skip everything past the first page, and the symptom of that is
  storage cost rather than an error, so nobody would notice.
- **`EvidenceStagingService`** — FI-03. Stage, verify against the store's own checksum and byte
  count, then commit the reference. Plus `sweepOrphans`, which reads the committed key set
  **after** listing the bucket, never before.
- **`RetentionSweeper`** — FI-15. Mark the reference expired, then delete the object, and close
  the action only once the object is confirmed gone. The legal hold is re-read from the document
  at the point of deletion.
- Config: `S3_EVIDENCE_BUCKET` and `OBJECT_STORE_KIND`, with two production guards. Wiring in
  `app.module.ts`. `@aws-sdk/client-s3` added to `apps/api`.
- Docs: `docs/architecture.md` gains "Evidence objects: stage, verify, commit — and never the
  inverse" and "A batched sweep over shared state needs a bounded drain";
  `docs/decisions.md` D-015; phase-c.md C4 and C5 ticked; `START-HERE.md` and
  `implementation-status.md` moved to C6.

**The rule both rows enforce, stated once:** an orphaned object costs a few kilobytes and is
invisible to every user; a reference to bytes that are not there is a screening product telling a
reviewer that evidence exists when it does not. Both orderings are chosen so the _object_ is the
thing left wrong and never the _reference_. One of those failure modes gets investigated; the
other gets believed.

**Three properties, each verified by planting a violation:**

1. **Nothing is committed unless the object verified.** With a store that reports a checksum not
   matching the bytes, `stageAndCommit` throws **and** `sourceDocumentVersions` holds zero records
   for the tenant. The count assertion is the load-bearing one — a staging bug that throws _and_
   commits would pass a test that only checked the throw, and the record it left behind is the
   dangling success.
2. **The orphan sweep never deletes a referenced object, however old.** A committed document
   aged 400 days survives a sweep. The reconciler _for_ FI-03 deleting a referenced object would
   cause the exact failure FI-03 exists to prevent.
3. **A retention action does not close while the object is still present.** Against a store whose
   `remove` silently does nothing, the action ends `FAILED` with `completedAt` null and
   `lastError` containing "still present" — because "I asked for a delete" is not "the object is
   gone", and an action closing there reports a retention obligation as discharged while the
   bytes sit in the bucket.

Also tested directly: the legal hold raised **after** the action was scheduled still stops the
deletion (the only case that matters — a hold placed when litigation starts must protect the
evidence that litigation is about), a failed delete is retried rather than lost, and the key
carries no publisher, URL or path fragment even when the caller's `sourceUrl` contains
`../../etc/passwd`.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         260 passed
test:invariants    29 passed
test:evaluation    12 passed
test:integration  101 passed  (was 83: +18 in tests/integration/evidence-storage.test.ts)
test:security      93 passed  (was 91: +2 new production guards)
coverage          94.75% statements / 89.43% branches (gate 85/80)
```

The staging and retention paths run against the **real LocalStack S3**, not a fake — that the
store computes its own checksum, that a delete is idempotent, and that a listing paginates are
properties of S3 and not of our code. Failure injection uses the in-process store, because making
a real bucket corrupt bytes on demand means breaking it.

**Left half-done:** nothing within C5, with one thing deliberately not built: **neither sweep is
scheduled in-process.** `sweepOrphans`, `sweepOnce` and `overdue` exist and are called by tests,
ready for a scheduler; C6 owns the scheduling alongside retries and leases. Also **nothing calls
`stageAndCommit` in production yet** — nothing fetches documents until Phase F. The path is built
and tested; it is not yet on a request path. **C6 is not started**: no FR-06 classification, no
DLQ, no lease fencing, no cancellation.

**Found — three things:**

1. **The first version of the orphan sweep's safety guard could never fire, and the test I wrote
   for it was wrong in the same direction.** The guard checked that a key carried the tenant
   prefix — but the sweep _lists_ that prefix, so every key it sees carries it by construction.
   The test's "foreign" key was itself under the prefix, so the test asserted the guard fired when
   it could not. Fixed by asking the narrower and actually useful question: **did this system
   create this object?** Only `keyFor` creates evidence objects, so only keys matching its exact
   shape are eligible for deletion. Recorded as **D-015**. The general lesson is worth more than
   the fix: a guard that cannot fire and a test that cannot fail will agree with each other
   forever.
2. **A batched sweep over shared state, for the third time.** The C4 entry said "expect it a
   third time"; here it is. `RetentionSweeper.sweepOnce` sweeps due actions cross-tenant, so run
   from one integration file it completed the retention fixtures another file was still asserting
   on — two failures that passed in isolation and failed in the suite. Fixed by giving
   `sweepOnce` an optional `tenantId`; the scheduled sweeper omits it, because retention is an
   obligation across every tenant and a per-tenant schedule is a list of tenants to forget to add
   to, while a targeted run (an erasure request, or draining one tenant) passes it. **The rule and
   all three instances are now a table in `docs/architecture.md`**, which is where it should have
   been written after the first one.
3. **`keyFor` had a test-only escape hatch for the object id, and it was a hole in the
   reconciler.** A test that pinned a key could pin one `tenantOfKey` does not recognise, and the
   sweep would then quietly decline to collect exactly the objects that test created. Removed;
   nothing was using it.

Still open and still unaddressed, carried from six previous entries: **`POST /v1/subjects`
declares a permission but no scope**, so a key scoped to `search:read` can create a subject while
`POST /v1/searches` refuses it. It belongs to whoever owns the machine contract.

Carried from C4 and unchanged: **D13 / D-014** — three quarters of search acceptance latency is
the request waiting for the index write. Closes by G8 with Phase F.

**Next session should:** start **C6**. Read `docs/failure-injection-matrix.md` rows FI-06, FI-07,
FI-08, FI-11, FI-12, FI-13 and FI-16 first — they are the specification for its tests. Begin with
the **FR-06 failure classification table as written** (transient network, rate limited, soft
block, hard block, content error — three of the five must not be retried at all); do not invent a
second taxonomy. Every fencing test must have **two workers racing**: a single-worker test proves
nothing about staleness.

**Decisions touched:** **D-015 added** (the orphan sweep deletes only objects this system
created). No open decision closed. D13 / D-014 still open, closing by G8.

---

## 2026-09-11 (night) — Phase C step C4: the workload measurement that closes D12

**Did:**

- **`packages/evaluation/src/workload/population.ts`** — a deterministic, pure generator for the
  haystack the FR-16 names have to be found in. The FR-16 corpus holds sixteen cases, which is a
  correctness fixture and not a workload: every index answers sixteen documents instantly, so a
  latency taken over it would have closed D12 on noise. The sixteen names became the **queries**
  — they were chosen to be hard — and the generator builds the population around them: two exact
  collisions per target, a shared surname, a shared given name, a phonetic neighbour and a
  one-edit neighbour, so retrieval is a discrimination problem rather than a lookup. Eight query
  classes, one per FR-08 name form.
- **`packages/evaluation/src/workload/stats.ts`** — nearest-rank quantiles, `isDecisive` (a
  stated noise margin, so "unconvincing" has a definition rather than a feeling), and `recallOf`,
  which returns `NaN` and never `1` for a class nothing was queried in. A 100% that means
  "untested" is the most dangerous number the file could produce.
- **`scripts/workload/search-index.mjs`** (`pnpm bench:search-index`) — three strategies (naive /
  expanded / batched), three population sizes, recall@k by name form, and API acceptance measured
  against **both** index kinds so the index's contribution is attributable rather than merely
  present. Writes `docs/measurements/c4-search-index.json`.
- **`SearchIndexPort.searchSubjectsBatch`** plus the Meilisearch `/multi-search` implementation —
  added **because the measurement asked for it**, not in anticipation. Decision D-013.
- **`MeilisearchAdapter` now sends `Accept-Encoding: identity`.** See finding 1.
- Docs: `docs/measurements/c4-search-index.md` (the report), `docs/decisions.md` D-002 closed
  with figures plus new D-013 and D-014, `docs/open-decisions.md` D12 closed and D13 opened,
  `START-HERE.md` and `implementation-status.md` moved to C5.

**D12 is closed: Meilisearch.** Not by preference and not by inertia — D-002 set a specific
switch condition (OpenSearch if the matcher needs analysers or multi-field boolean scoring
Meilisearch cannot express), and that condition was tested and **not met**. At 100,000 subjects,
1,050 samples per strategy:

| Strategy                            | matcher p95 |    recall |
| :---------------------------------- | ----------: | --------: |
| naive (raw name, one query)         |      4.33ms |     67.6% |
| expanded (FR-08 forms, sequential)  |     11.20ms |     95.2% |
| **batched (FR-08 forms, one trip)** |  **7.05ms** | **95.2%** |

The matcher **does** need multi-field retrieval — raw-name recall falls 81.9% to 67.6% from
1,000 to 100,000 subjects as the top _k_ fills with lookalikes, and `PARTICLE` recall collapses
100% to 6.3% over that range. Meilisearch **expresses** it, in one round trip, flat across two
orders of magnitude (retrieval p95 5.65 to 6.35ms). No `OpenSearchAdapter` was written;
`SEARCH_INDEX_KIND=opensearch` still throws its not-implemented error.

Closed with limits stated, in D-002: 100,000 subjects not 10⁷, no concurrency test, the
`documents` index untested (nothing extracts text until Phase F), and **the non-Latin path
unmeasured** — `TRANSLITERATION` recall is 0% for every strategy because the only
`TransliterationPort` implementation is `identityTransliteration`, so a Cyrillic query is never
expanded into the Latin forms the index holds. That figure says nothing about Meilisearch, and it
is the likeliest re-open trigger.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         260 passed  (was 241: +19 in packages/evaluation/test/workload)
test:invariants    29 passed
test:evaluation    12 passed
test:integration   83 passed  (was 78: +5 for the batch path)
test:security      91 passed
coverage          94.75% statements / 89.43% branches (gate 85/80)
pnpm bench:search-index --sizes=1000,10000,100000 --repeats=10   full run recorded
```

**Left half-done:** nothing within C4. **C5 and C6 are not started** — no S3 staging, no
reference commit, no consumer loop, no DLQ, no fencing, no cancellation.

**Found — three things, two of them defects:**

1. **A flat ~45ms stall on every gzip response through the Docker Desktop port proxy — and the
   first run nearly recorded it as Meilisearch's latency.** The first measurement put retrieval
   at 47ms p50. It was not query work: `/health` answered in 1.8ms while every search took 45ms;
   32 concurrent searches finished in the same wall time as one, so it was a wait and not work;
   the stall switched on between 967 and 1,256 bytes of response body, 25/25 deterministic; the
   same query from **inside** the Docker network took 2.2ms; and `Accept-Encoding: identity`
   removed it entirely (48.06ms to 3.20ms, 0/20 slow). Node's `fetch` asks for gzip by default,
   so every call the adapter made was paying it. The adapter now asks for `identity`, which is
   right on its own merits — a service-to-service hop carrying small JSON gains nothing from
   compression. Matcher p95 went 52.76ms to 4.38ms. **Worth knowing generally: this is a
   property of the Docker Desktop port proxy on Windows and macOS, not of Meilisearch, and any
   other adapter that talks HTTP to a container from the host will hit it the same way.**
2. **A batched sweep over shared state asserted in one pass — the same trap as the C3
   reconciler, in a second place.** Adding these measurements pushed the outbox past
   `OutboxPublisher`'s batch of 50 and three tests in `tests/integration/transactions.test.ts`
   started failing intermittently. `publishOnce` sweeps the outbox **globally**, so with vitest
   running integration files in parallel a single pass need not reach the event under test — and
   `queue.failNextPublish` could be absorbed by another file's event entirely, which is why the
   test saw `attempt: 0`. Fixed with a bounded drain, and _verified by planting 300 due events_:
   the old tests fail 4 of 14 against that backlog, the fixed ones pass. **The rule, now written
   into both places: a batched sweep over shared state needs a bounded drain, never a single
   call.** This has now cost two sessions; expect it a third time.
3. **Three quarters of search acceptance is the request waiting for the index write.**
   `POST /v1/searches` is 127ms p50 against Meilisearch and 33ms against the in-process index.
   The ~94ms is the post-commit index write being awaited — something the request is explicitly
   allowed to lose and which the FI-10 reconciler already covers. Not changed here: dropping the
   wait trades C3's rule 2 (a write is not `INDEXED` until it is searchable) for latency, and
   that depends on whether anything reads the index between acceptance and the run completing,
   which Phase F's consumer decides. Raised as **D13 / D-014**, closing by G8. The composed total
   search latency is roughly 132ms, of which the matcher is 5.23ms — **4%**. Whatever is worth
   optimising in the search path, it is not the index.

Still open and still unaddressed, carried from five previous entries: **`POST /v1/subjects`
declares a permission but no scope**, so a key scoped to `search:read` can create a subject while
`POST /v1/searches` refuses it. It belongs to whoever owns the machine contract.

**Next session should:** start **C5** — S3 staging and reference commit. Read
`docs/failure-injection-matrix.md` first; it is the specification for the C5 and C6 tests, and
writing either without it means guessing at the boundaries they exist to cover.

**Decisions touched:** **D12 closed — Meilisearch**, recorded with figures in `docs/decisions.md`
D-002 and in `docs/measurements/c4-search-index.md`. **D-013 added** (the port gets a batch query,
because the measurement asked for one). **D-014 / D13 opened** (whether acceptance waits for the
index write; closes by G8 with Phase F). D7 and D11 untouched.

---

## 2026-09-11 (evening) — Phase C step C3: the search index behind the D12 seam

**Did:**

- **`SearchIndexPort`** (`apps/api/src/search-index/search-index.port.ts`) — the application-side
  half of the seam Phase A established in `scripts/bootstrap/search-index.mjs`. Nothing outside
  that directory names a concrete index, which is what keeps **D12 open on the numbers** rather
  than on the cost of changing. Carries the subject and document index shapes, a mandatory
  `tenantId` on every query, and `InMemorySearchIndex` for wiring tests.
- **`MeilisearchAdapter`** — talks to the HTTP API directly. Deliberately _not_ the official
  client, and deliberately the opposite trade from the SQS decision: there the dependency buys
  SigV4 over a rotating credential, which is a security control; here it would buy a thin wrapper
  over four endpoints.
- **`IndexerService`** — projection, write, reconciliation, gate check and tenant rebuild. The
  FI-10 reconciler, which is the row whose symptom is a clean screening result.
- **Wiring:** `SEARCH_INDEX_KIND` / `MEILI_HOST` / `MEILI_MASTER_KEY` in config;
  `SEARCH_INDEX_PORT` provided in `app.module.ts` (`opensearch` throws a clear
  not-implemented error rather than silently falling back, so the configuration cannot lie);
  `IndexerService.ensureIndexes` in `StartupService`; and `SearchesService.create` indexes the
  pinned subject version **after** the commit, outside the transaction, without failing the
  request if the index is unreachable.

**Three properties that carry the weight, each verified by planting a violation:**

1. **A write is not `INDEXED` until the index says it is searchable.** Meilisearch writes are
   asynchronous — the document is not findable when the HTTP call returns. The adapter waits for
   the task. Making it report the enqueue as success fails five tests, including the one that
   searches immediately with no polling.
2. **Every index query filters by tenant.** Removing the filter fails three tests, including two
   tenants holding deliberately identical names.
3. **The reconciler sweeps `indexState: { $ne: 'INDEXED' }`, not a list of states.** Subject
   versions written before C3 carry no `indexState` field at all; changing the sweep to
   `$in: ['PENDING', 'FAILED']` fails the legacy-record test. This is the additive-only migration
   decision from C1 being paid for in practice.

A fourth, not plantable but tested directly: **a search the index cannot answer throws.** An
outage returned as an empty list is "no matches found" for a person nobody actually searched for.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         241 passed
test:invariants    29 passed
test:evaluation    12 passed
test:integration   78 passed  (was 66: +12 in tests/integration/search-index.test.ts)
test:security      91 passed  (was 89: +2 new production guards)
coverage          93.74% statements / 91.33% branches (gate 85/80)
```

The index tests run against the **real Meilisearch** in the local stack, not a fake. Two of the
properties above — asynchronous writes, and whether a filter expression genuinely isolates
tenants — are properties of Meilisearch rather than of our code, and a fake would assert that the
fake works. Failure injection uses the in-process port, because making a real index fail on demand
means breaking it.

**Left half-done:** nothing within C3. **C4, C5 and C6 are not started.** Specifically: no
scheduled reconciler runs in-process (`reconcile()` and `countUnindexed()` exist and are called by
tests, ready for a scheduler); the corpus index is exercised through the record's own fields
because nothing extracts document text yet — Phase F owns supplying `title` and `text`; and no
consumer loop, no S3 staging, no DLQ.

**Found — three things:**

1. **The reconciler is batched, and a test that assumed one pass was wrong.** `reconcile()` moves
   at most 100 records so a backlog cannot monopolise the process — correct — but the shared local
   database has accumulated unindexed subject versions from every previous test run, so a single
   pass never reached the record under test. The tests now drain in a bounded loop. Worth knowing
   for **C4 and for the G4 exit check**: "no unindexed committed documents" is only true after the
   reconciler has actually run to completion, and on this machine that currently means several
   passes. The backlog is local test residue, not a defect, and `pnpm local:reset` clears it.
2. **Adding production guards broke the T09 fixture again, correctly** — the same pattern as C2.
   `SEARCH_INDEX_KIND` defaults to `meilisearch`, so production now demands `MEILI_HOST`, and
   `in-memory` is refused outright in production: it would answer every screening query from a map
   that is empty at startup, which reads as a clean result rather than as an outage. Fixture
   updated, both new guards tested.
3. **`indexState` on `subjectVersions` is a second additive field with the same trap as the
   first.** Any future sweep over an additive status field must exclude the terminal state rather
   than enumerate the others, or it skips every record written before the field existed. That rule
   is now written into the code comment and into this entry, because it will come up a third time.

Still open and still unaddressed, carried from four previous entries: **`POST /v1/subjects`
declares a permission but no scope**, so a key scoped to `search:read` can create a subject while
`POST /v1/searches` refuses it. It belongs to whoever owns the machine contract.

**Next session should:** start **C4**, which **closes D12** — the matcher-latency workload test.
Measure three latencies **separately** over the FR-16 corpus in `packages/evaluation`, with the
FR-08 name-form expansions including transliteration and phonetic keys, since those are what a
naive index handles badly: matcher latency, API acceptance latency, and total search latency.
Record the numbers in `docs/decisions.md` and close D12 there **with the figures**, not as a
preference. The brief's own expectation is that OpenSearch is the likelier answer if the matcher
needs custom analysers or multi-field boolean scoring — and if the measurement says switch, then
writing `OpenSearchAdapter` next to `MeilisearchAdapter` is this phase's work, not a note for
later. State the corpus size and the confidence with the numbers; an unconvincing measurement
leaves D12 open, which is an honest outcome.

**Decisions touched:** none closed. **D12 remains open** and is now genuinely decidable — the seam
is real, both sides of it are small, and C4's numbers are the only thing left. One architecture
note added to `docs/architecture.md` ("The search index is derived state"), recording that MongoDB
wins every disagreement, that a write is only indexed once confirmed searchable, and that an index
outage raises rather than returning an empty result.

---

## 2026-09-11 (later still) — Phase C step C2: transactions, the outbox and the queue seam

**Did:**

- **`TransactionRunner`** (`apps/api/src/persistence/transaction.runner.ts`) — the one place that
  opens a MongoDB transaction, written out rather than delegated to the driver's
  `withTransaction`, because §6.3 asks for three cases to be handled **explicitly** and the
  helper hides the one that matters:
  - a **transaction conflict** (`TransientTransactionError`) retries the whole body — nothing
    committed, so re-running is safe;
  - an **unknown commit outcome** (`UnknownTransactionCommitResult`) retries **the commit alone,
    never the body**. The work may already be durable; re-running it is how duplicate work gets
    committed. When both labels are present, unknown wins — an outcome we did not hear is not an
    outcome we know did not happen. If the deadline passes with the outcome still unknown, the
    caller gets `UnknownCommitOutcomeError`, which says "check the record", not "it failed";
  - a **duplicate key** is surfaced immediately and never retried. It is deterministic, and two
    services in this codebase deliberately _use_ it as their "somebody already did this" signal.
  - Bounded attempts (5), bounded deadline (15 s, shorter than the driver's 120 s because this
    sits behind an HTTP request), full-jitter backoff, injected `sleep`/`random` so the policy is
    testable without waiting for it.
- **Search creation now commits run, audit entry and outbox event together.**
  `SearchesService.create` does its read-only work first — sandbox/live check, entitlement check,
  pinned versions — then opens one transaction that inserts the `SearchRun`, appends the SEC-06
  `AuditEvent` and appends the `OutboxEvent` that will start the work. The subject snapshot is
  resolved **inside** the session (`SubjectsService.create` gained an optional `session`), so a
  snapshot and the run citing it commit together; matrix row FI-02 was updated to say that gap is
  now closed on the search path and why it deliberately stays open on `POST /v1/subjects`.
- **`QueuePort`** (`apps/api/src/jobs/queue.port.ts`) — the job envelope as a contract, a
  defensive `parseEnvelope` that rejects an unknown `envelopeVersion` rather than half-reading it,
  and an `InMemoryQueueAdapter` for tests.
- **`SqsQueueAdapter`** — the production implementation, using `@aws-sdk/client-sqs` (a new
  dependency; see **Found 2**). Long polling at 20 s and batched sends of ten, both cost decisions
  taken now because they are far cheaper to build in than to retrofit. Partial batch failure is
  reported per entry rather than treated as all-or-nothing.
- **`OutboxPublisher`** — the FI-04 reconciler. Polls committed-and-due events, publishes, then
  marks. **Publishes before marking**, deliberately: a crash between them republishes (FI-05),
  which the consumer deduplicates, whereas marking first would lose the event outright. Failed
  publications get a full-jitter backoff and stay in the outbox. Started from `main.ts`, not from
  the module, so importing the app in a test does not silently start draining whatever database
  that test is pointed at.
- **`verifyJobOwnership`** (SEC-01) — the only place allowed to turn an envelope into a tenant.
  It loads the aggregate **by ID alone** and takes the tenant from the record, so a forged
  envelope produces a `TENANT_MISMATCH` security event rather than cross-tenant work. A loader
  scoped by the envelope's own tenant would make the check a tautology, and a test asserts the
  loader is called with the aggregate ID and nothing else. Also returns `STALE_REVISION` for an
  out-of-order delivery (T31).
- **Config and startup guards:** `JOBS_QUEUE_URL`, `AWS_REGION`, `AWS_ENDPOINT_URL`, static AWS
  credentials and `OUTBOX_POLL_MS`. Production startup now **refuses** an endpoint override, a
  static access key, or a missing queue URL — see **Found 1**.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         241 passed  (was 221: +20 transaction/envelope/ownership policy)
test:invariants    29 passed
test:evaluation    12 passed
test:integration   66 passed  (was 52: +14 in tests/integration/transactions.test.ts)
test:security      89 passed  (was 86: +3 new production guards)
coverage          93.74% statements / 91.33% branches (gate 85/80), via CI's own invocation
```

The write-conflict test is a real conflict, not a simulated one: two sessions read-then-write the
same document under snapshot read concern, and the run log shows
`test.conflict.b: conflict on attempt 1; retrying the transaction`. Both increments land and the
counter reaches 2.

Three guards verified by planting a violation:

- making `classifyCommitError` return `RETRY_TRANSACTION` for an unknown commit outcome fails
  exactly the two tests that say the commit is retried and never the work;
- deleting the duplicate-key branch from `classifyBodyError` fails "never retries a duplicate
  key";
- making `verifyJobOwnership` skip its tenant comparison fails "refuses a forged tenant instead
  of doing that tenant work".

**Left half-done:** nothing within C2. **C3 through C6 are not started.** There is still no
consumer loop — `QueuePort.receive` and `verifyJobOwnership` exist and are tested, but nothing
dequeues in a running process, so nothing yet advances a `StageExecution`. No index writer, no S3
staging, no sweeper, no DLQ handling, and the FR-06 classification table is still unused by any
retry path.

**Found — three things:**

1. **Adding a production guard broke a passing test, correctly.** `T09 — accepts a properly
configured production environment` failed once startup began requiring `JOBS_QUEUE_URL`. The
   fixture was updated rather than the rule relaxed: a production API that accepts searches with
   no queue publishes every job into an in-process array that vanishes at restart, so the customer
   is told "queued" and nothing is queued. Two further guards were added alongside it and tested —
   `AWS_ENDPOINT_URL` set in production (that override exists for LocalStack; in production it can
   only mean AWS traffic is being redirected) and static AWS credentials present (a long-lived key
   in an environment variable is what an instance role exists to remove).
2. **`@aws-sdk/client-sqs` is a new dependency in a deliberately lean set** (24 packages). The
   reasoning, now recorded in `docs/architecture.md` under "Jobs and the queue": the bootstrap
   scripts avoid the SDK so a stray profile cannot point them at real AWS, but the application has
   the opposite requirement — it must authenticate with a rotating role credential, and SigV4 over
   a rotating credential is a security control to use rather than re-implement. If that trade is
   ever revisited, the port is the seam and `SqsQueueAdapter` is the only file affected.
3. **The integration duplicate-key test does not prove the duplicate-key guard.** Planting the
   violation showed it still passing: in this MongoDB version a duplicate key inside a transaction
   does not carry `TransientTransactionError`, so the error falls through to `FAIL` whether or not
   the explicit branch exists. The unit test with a synthetic error carrying **both** labels is
   what actually holds the guard. The integration test is still worth keeping — it asserts the
   error reaches the caller in one attempt and quickly — but it should not be cited as the proof.

Still open and still unaddressed, carried from three previous entries: **`POST /v1/subjects`
declares a permission but no scope**, so a key scoped to `search:read` can create a subject while
`POST /v1/searches` refuses it. It belongs to whoever owns the machine contract.

**Next session should:** start **C3** — the search index behind the `SEARCH_INDEX_KIND` seam
Phase A established, with MongoDB as the system of record and the index as derived state. The
reconciliation is a deliverable, not a follow-up: `SourceDocumentService.findUnindexed` and
`countUnindexed` already exist and already treat a `FAILED` index write as unindexed, so what C3
owes is the writer, the re-indexer that drains `indexState: PENDING`, and the gate check that
"no unindexed committed documents" is a query rather than an assumption (matrix row FI-10). Keep
index-specific code inside the seam — C4's measurement may send this to OpenSearch, and code
outside the seam is what would make that migration expensive enough to skip, which decides D12 by
inertia.

**Decisions touched:** none of D1–D12 closed. **D12 stays open**, still closed by C4's measurement
with numbers. Two decisions recorded in `docs/architecture.md` rather than `docs/decisions.md`,
both architecture rather than product: the AWS SDK behind `QueuePort` with its credential
reasoning, and the two SQS cost levers (long polling, batched sends). A missing queue is a startup
refusal rather than a silent fallback, which is a third and is recorded with them.

---

## 2026-09-11 (later) — Phase C steps C0 and C1: the failure matrix and the section 6.3 records

**Did:**

- **C0 — `docs/failure-injection-matrix.md`.** Sixteen rows, FI-01 to FI-16, one per point where
  this service writes to two systems that cannot commit together. Each row states the orphan, the
  named reconciler, the grace window with its basis, and what the user sees in §6.2 vocabulary
  while it is unreconciled. Three ordering rules sit above the table and decide every row:
  **prefer an orphan to a dangling reference** (an orphaned S3 object is swept up; a committed
  reference to an object that was never written tells a reviewer evidence exists when it does
  not); **every reconciler needs a grace window longer than the longest legitimate in-flight gap**
  (a sweep that deletes "orphans" younger than the slowest healthy upload deletes live work, and
  does it under load); and **no unreconciled state may overstate knowledge** — a run may report
  `RUNNING`/`INCOMPLETE`, never `NO_MATCHES_FOUND`. A row-to-test map ties FI rows to T22, T23,
  T24, T29, T30, T31, T41, the G4 exit condition, SEC-06 and D-012, and the file names the four
  boundary families it deliberately does **not** cover (fetch, extraction, export, multi-node) so
  their absence is a decision rather than an oversight.
- **C1 — the section 6.3 records this phase needs**, in `apps/api/src/persistence/`:
  - **`StageExecutionService`** — `(tenantId, runId, stageKey)` unique, which _is_ the
    duplicate-work guard rather than an optimisation; lease acquisition as one atomic
    `findOneAndUpdate`; `completeFenced` checking lease token **and** revision; `cancelRun`
    bumping revision so a late completion fails its fence; `reclaimExpiredLease` returning or
    abandoning; and `discardedAttempts`, so a refused write is visible rather than silent.
  - **`OutboxService`** — `append` takes a `ClientSession` as a **required** parameter, so an
    outbox event written outside its transaction is a type error rather than a code-review note.
  - **`InboxReceiptService`** — generalises the old `idempotencyKeys` into `inboxReceipts` with a
    `channel` (`http-idempotency`, or `queue:<consumer>`). `IdempotencyService` is now a thin
    HTTP wrapper that keeps the canonical request hash and the 409; the queue path will use the
    same claim protocol, so the two cannot drift into disagreeing about "already done".
  - **`SourceDocumentService`** — refuses outright to commit a reference whose stored object was
    never verified; commits `indexState: 'PENDING'` so an unindexed document is findable;
    `findUnindexed` counts `FAILED` as unindexed, because excluding it would make the gate check
    pass by omitting exactly the documents it asks about. Four date fields, each with precision,
    and a missing date stays null.
  - **`AuditService`** — per-tenant gapless sequence, hash chain, `append` requiring a session,
    no update or delete method at all, and `verifyChain` returning `SEQUENCE_GAP`, `BROKEN_LINK`,
    `ALTERED_ENTRY` or `CHECKPOINT_MISMATCH`. See **Found 1**.
  - **`RetentionService`** — mark the reference, then delete the object; the action is not closed
    until the object is gone; a hold stops it where it stands; overdue past the window is an
    operator concern, not a silent retry.
- **FR-06 failure classification moved into the pure package**,
  `packages/domain/src/reliability/failure-classification.ts`: the seven classes with their
  policies as data, `classifyFailure`, full-jitter `backoffDelayMs` with injected randomness, and
  `shouldRetry`. C6 wires it instead of writing a second taxonomy next to the retry loop.
- **The migration and audit-integrity decisions** are written into `docs/architecture.md` under
  a new "Persistence conventions (Phase C)" section, along with a table of the **five** indexes
  that deliberately do not lead with `tenantId` and why each one cannot.

**Verified:**

```
lint clean · typecheck clean · format:check clean
test:unit         221 passed  (was 206: +15 FR-06 classification)
test:invariants    29 passed
test:evaluation    12 passed
test:integration   52 passed  (was 14: +38 in tests/integration/persistence.test.ts)
test:security      86 passed  (unchanged - the idempotency refactor regressed nothing)
coverage          93.74% statements / 91.33% branches, via CI's own invocation
                  (vitest --project unit --project invariants --project evaluation --coverage)
                  gate is 85/80
```

Three guards were verified by planting a violation rather than by assuming:

- deleting the `leaseToken` and `revision` conditions from `completeFenced` fails exactly the two
  fencing tests (FI-11 stale worker, FI-12 cancellation) and nothing else;
- dropping `result` from the audited hash fails "detects an altered entry (SEC-06)";
- making the unverified-reference check unreachable fails "refuses to commit a reference whose
  object was never verified (FI-03)".

A caution about coverage for the next session: `vitest run --project unit --coverage` alone
reports 84.56% and fails the gate, because domain code is also exercised by the invariants and
evaluation projects. The CI line above is the real gate. Do not "fix" a coverage failure that is
really a wrong invocation.

**Left half-done:** nothing within C0 or C1. **C2 through C6 are not started.** Specifically:
there is no transaction runner, so nothing yet commits state, audit and outbox together; nothing
calls any of the new records from a real code path — `searchRuns` is still created and never
advanced, no stage is ever ensured, no audit entry is written by a real action; there is no
publisher, no queue consumer, no index writer, no S3 staging and no sweeper. The reconcilers the
matrix names are specified, not built.

**Found — three things:**

1. **SEC-06 cannot be satisfied by code in this repository, and the design now says so.** A hash
   chain detects a removed or altered entry. It does not detect an attacker with the entry
   writer's credentials rewriting an entry and recomputing every hash after it — the chain then
   verifies. So `AuditCheckpointWriter` is a port; the only implementation,
   `LocalAuditCheckpointWriter`, shares MongoDB and its credentials with the entry writer and
   stamps every checkpoint `protection: 'NONE_LOCAL_STACK'`, so nothing built on these records can
   claim tamper-evidence this deployment does not have. A test asserts that value, and another
   test demonstrates the wholesale-rewrite attack being caught **only** by the checkpoint. What
   production must supply is enumerated in `docs/architecture.md`; G11 verifies it.
2. **The migration question answered itself during C1.** Renaming `idempotencyKeys` to
   `inboxReceipts` is exactly the kind of change `StartupService`'s idempotent index creation
   cannot handle — it transforms nothing and silently abandons the old collection. It was safe
   only because the data was local, disposable and at most 24 hours old. The recorded decision is
   **additive-only, no migration runner, until the first deployment holding data anyone depends
   on**, with four concrete requirements listed for the runner that must land before then. The
   old `idempotencyKeys` collection still exists in the local database with stale documents; it
   is unread and `pnpm local:reset` clears it.
3. **The audit sequence serialises audited writes per tenant.** A gapless per-tenant sequence
   needs an `$inc` on a counter inside the same transaction, so two audited writes for one tenant
   conflict and one retries. That cost was accepted deliberately: allocating the sequence outside
   the transaction leaves a hole whenever a transaction aborts, which is indistinguishable from a
   deletion and would make the tamper signal useless by crying wolf. If C2's transaction-conflict
   retry policy shows this to be a real throughput problem, the fix is a per-tenant batched
   sequence — not a non-gapless one.

Still open and still unaddressed, carried from the previous two entries: **`POST /v1/subjects`
declares a permission but no scope**, so a key scoped to `search:read` can create a subject while
`POST /v1/searches` refuses it. It belongs to whoever owns the machine contract.

**Next session should:** start **C2** — the transaction runner. One place that opens a MongoDB
transaction and one retry policy around it, handling transaction conflicts, **unknown commit
outcomes** (the one people forget: a commit whose result never came back is not a failure, and
treating it as one is how work gets duplicated) and duplicate-key errors explicitly. Then wire
the first real caller through it: a search creation that commits the `SearchRun`, its
`StageExecution` rows, its `AuditEvent` and its `OutboxEvent` together. The seams are already in
place — `OutboxService.append` and `AuditService.append` both require a `ClientSession`, and
every other write accepts an optional one. Read `docs/failure-injection-matrix.md` rows FI-04,
FI-05 and FI-09 before writing it; they are the specification.

**Decisions touched:** none closed. **D12 stays open** and is still closed by C4's measurement
with numbers in `docs/decisions.md`; Meilisearch remains a working assumption behind the
`SEARCH_INDEX_KIND` seam and nothing in C1 touched it. **D-012** (30-day evidence retention) now
has a record that can carry it out, but the retention _policy value_ is unchanged and still
placeholder-flagged. Two new decisions are recorded in `docs/architecture.md` rather than in
`docs/decisions.md`, because both are architecture rather than product: additive-only migrations
until first deployment, and the audit checkpoint as a port with an honestly-labelled local
implementation.

---

## 2026-09-11 (end of session) — Phase C brief expanded; nothing in C started

**Did:**

- **Expanded `docs/execution/phase-c.md` from an outline into a full brief**, in the shape of
  `phase-a.md`. It was deliberately left an outline until Phase B's real schemas existed, and
  they do now. The brief adds:
  - a **"What already exists"** table mapping all eleven collections Phase B created to their
    §6.3 record names, with honest state notes — `searchRuns` is created but never advanced and
    its `revision` field is unused, `idempotencyKeys` is only partly an `InboxReceipt`, and
    `apiKeyAuditEvents` is append-only in practice but not enforced;
  - the conventions worth keeping, including the **two deliberate exceptions** to
    tenant-leading indexes and why each exists;
  - a new **C0 — write the failure-injection matrix first**, ahead of the original C1–C6, as
    `docs/failure-injection-matrix.md`. The outline already required it before C6; it is now its
    own step because it is equally the specification for C2 and C5, and a matrix written
    afterwards describes the code that was written rather than the property that was wanted;
  - scope discipline made explicit: build the §6.3 records **this** phase needs, not all
    thirty-five. `AssociationAssertion`, `GraphSnapshot`, `Finding`, `QueryPlan`, `QueryExecution`
    and `EgressIdentity` are named as Phase D–F's, with "do not build them because the schema felt
    incomplete" in the Do-not list.
- **Renamed `api_keys` → `apiKeyCredentials` and `api_key_audit` → `apiKeyAuditEvents`.** That
  snake_case was introduced earlier the same day and was the only pair not following the
  convention every other collection uses (the §6.3 record name, camelCase, plural). Fixed now so
  C1 does not inherit two conventions and then have to pick one.
- Moved the `START-HERE.md` brief pointer to say the brief is expanded and to start at C0.

**Verified:** `lint`, `typecheck`, `format:check` clean; `test:security` 86 passed after the
rename; `test:unit` 206. No behaviour changed — the rename is a collection name and its two test
references.

**Left half-done — nothing. No Phase C code exists.** C0 has not been started: there is no
`docs/failure-injection-matrix.md` yet. The brief is a plan, not progress, and G4 is still
**Not started** in `implementation-status.md`.

**Found — two things the brief now carries, that the outline did not:**

1. **SEC-06 rules out the obvious audit implementation.** It states that a hash chain stored with
   the same unrestricted writer is _not sufficient by itself_, and that business roles must not be
   able to update or delete entries. So C1's `AuditEvent` needs its integrity checkpoint designed
   before it is written, and if a local stack cannot protect one properly, the honest output is a
   recorded statement of what production needs — not a chain that only looks tamper-evident.
2. **There is no migration runner.** `StartupService` creates indexes idempotently, which is fine
   for additive indexes and not fine for any change that has to transform existing documents. C1
   must decide whether Phase C needs a real runner or whether additive-only is honest, and record
   the answer in `docs/architecture.md`. Right now "we can migrate" is untested.

Also still open from the previous entry, and not addressed: **`POST /v1/subjects` declares a
permission but no scope**, so a key scoped to `search:read` can create a subject while
`POST /v1/searches` refuses it. Possibly intended, but currently an accident of which routes
carry `@RequireScope`. It belongs to whoever owns the machine contract.

**Next session should:** start Phase C at **C0** — write `docs/failure-injection-matrix.md`, one
row per two-system boundary (after S3 upload / before reference commit; after reference commit /
before outbox publish; after outbox read / before delivery; after delivery / before receipt write;
after stage state write / before acknowledgement; after external request / before
acknowledgement), each with what is orphaned, what reconciles it, and what the user sees while it
is unreconciled. Then C1. Read `docs/execution/phase-c.md` first — its "Read before starting"
list is narrow on purpose, and the two source specification documents in the parent directory
must not be read end to end.

**Decisions touched:** none. **D12 stays open** and is closed by C4's measurement, with numbers
in `docs/decisions.md` — not by preference, and not by inertia. Meilisearch remains a working
assumption behind the `SEARCH_INDEX_KIND` seam; if C4 favours OpenSearch, switching is Phase C's
work rather than a note for later.

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

**Next session should:** ~~expand `docs/execution/phase-c.md`~~ — done in the entry above. Start
at C0, then C1 — the section 6.3 record schemas, migrations and indexes, with tenant context
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
  should be confirmed by product and Target Platform rather than hardened by silence.
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
- **D10** still needs product and Target Platform, and it shapes the Phase B subject schema.

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

The D-001 boundary test was verified by planting a violation: importing `@adverse-search/domain`
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
