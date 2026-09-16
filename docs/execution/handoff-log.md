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
  nobody at Erly has spoken to.

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
a session, and issues their own **sandbox and live** keys with nobody at Erly involved. Keys can
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

- `pnpm --filter @erly/adverse-api add -E fast-xml-parser@4.5.7`. Lockfile verified: two packages.
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
`OUTBOUND_USER_AGENT="ErlyAdverseSearch/0.1 (+https://erlystage.com/bots/adverse-search)"`, written
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

## 2026-09-14 (evening) — **Out of phase order, for a demo**: the search pipeline, the findings API, and the Zquence client

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

**4. `@erly/adverse-client` + `examples/zquence-integration.mjs` + `docs/integration/zquence.md`.**
The G9 pull half: a typed Node client, a worked example, and the integration contract written
down. Per the G9 brief these live in this repository until Zquence workspace access is granted.

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
  and is documented as a known gap in `docs/integration/zquence.md`. It was left rather than
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
