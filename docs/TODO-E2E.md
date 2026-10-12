# TODO — production ready, and testable end to end in Postman

Date: 2026-09-16

A checklist. Work top to bottom. Each group is useful on its own, so you can stop at any group
boundary and still have something that works.

**Legend:** 🔴 blocker · 🟠 needed for real results · 🔵 needed for production
**Size:** S = under a day · M = a few days · L = a week or more

---

## What "production ready" means here

Three separate things, and the project reports them separately on purpose. All three must be true.

|                          | Today       | Needed                                          |
| :----------------------- | :---------- | :---------------------------------------------- |
| **Local verified**       | Partial     | Every suite runs and passes on a clean checkout |
| **Live source verified** | Not started | Real sources contacted, recall measured         |
| **Production approved**  | Not started | Deployed, observed, backed up, signed off       |

The project's own gates run to **G11**. This list maps onto them so it does not compete with
`docs/delivery-plan.md`.

| Group                    | Phase / gate |
| :----------------------- | :----------- |
| 0 — Postman today        | — ✅ done    |
| 1 — Real search          | E / **G6**   |
| 2 — First live source    | H / G10      |
| 3 — Real findings        | F / **G7**   |
| 4 — API surface          | H / G9       |
| 5 — Run it in production | H / G11      |
| 6 — See what it is doing | H / G11      |
| 7 — Prove it             | all gates    |
| 8 — Legal before go-live | G10 / G11    |

---

## Group 0 — Postman working today, on mock data ✅ DONE 2026-09-15

Goal: anyone can drive the whole API from Postman and get real responses with fake data.

- [x] **A script that issues an API key.** `pnpm key:issue`. Prints the secret once; only a hash
      is stored. Also does `--list` and `--revoke`. Refuses to run against a non-local database
      unless you pass `--i-am-sure`.
      _Built as a script, not an endpoint:_ decision **D-007** defers the commercial self-service
      layer and records that keys are provider-managed in this phase. A script an operator runs is
      what provider-managed means. Building the endpoint would have quietly closed a decision
      nobody has taken.
      _File:_ `scripts/issue-api-key.mjs`

- [x] **A Postman collection in the repo.** Six folders: health, subject, search, results, admin,
      and the refusals worth seeing once. Ids are captured between requests, the search poll
      re-runs itself until terminal, and the test scripts warn when findings are empty **and**
      coverage is incomplete — which is not a clean result.
      _File:_ `postman/adverse-search-service.postman_collection.json`

- [x] **A Postman environment file.**
      _File:_ `postman/local.postman_environment.json`

- [x] **The steps written down**, with a troubleshooting table for the seven things that actually
      go wrong.
      _Files:_ `postman/README.md`, and a "Calling the API" section in the root `README.md`

**Verified against a real stack on 2026-09-15**, not assumed: `local:up` → `local:bootstrap` →
`dev:api` + `dev:worker` → `key:issue` → subject → search → findings. The run returned
**2 findings and 1 rejected lead**, with bands, categories, procedural stages and publishers.

Two defects were found by running it, and both are fixed:

- **`dev:api` and `dev:worker` could not start.** They ran `node dist/main.js` directly, and
  nothing loaded `.env` — so the boot-time configuration check refused, correctly, for want of
  five variables. The documented path was broken and the failure read as the reader's mistake.
  Both now go through `scripts/dev.mjs`, which loads `.env`; `pnpm dev` runs both together.
- **`key:issue` issued keys with no scopes.** Scopes narrow a machine key _below_ its roles and
  never widen it, so an empty list is **nothing**, not everything: the key could create a subject
  and was then refused the search with `MISSING_SCOPE`. Scopes are now derived from the roles and
  printed, with `--scope` to narrow further.

**Done when:** a new developer clones the repo and gets a search result in Postman in under ten
minutes. ✅

---

## Group 1 — Make a search actually search (G6)

Goal: a search runs through real source logic instead of returning fixtures.

- [x] **Build the cascade, rungs 0 to 7.** Done 2026-09-15 (**D-045**). Walk the approved sources in order, log each
      rung, descend on its own stated failure, and stop at rung 7 with `NO_MATCHES_FOUND` +
      `INCOMPLETE` — never a clean result.
      _File:_ `apps/api/src/pipeline/search-pipeline.service.ts`, the `discover` method

- [x] **Let the adapter set hold many news sources.** `SourceAdapterSet.newsDiscovery` is
      a single nullable port. It must become a list built from the active RSS sources in the
      registry.
      _File:_ `apps/api/src/sources/sources.registry.ts`

- [x] **Wire `RssNewsDiscoveryAdapter` into the composition root.** `LadderBuilder` constructs one
      per approved `NEWS_DISCOVERY_RSS` source — it was already reading the registry to decide
      rungs, so this is the same read answering one more question.
      _File:_ `apps/api/src/pipeline/ladder.builder.ts`

- [x] **Relevance filter before fetch.** Done 2026-09-15 (**D-047**). The nine FR-06 signals,
      scored before a socket opens. Rejected leads stored with their reason and visible in
      coverage. The filter decides what a document is _about_, never whether the subject is
      guilty — an acquittal passes it as readily as an accusation.

- [ ] **S — Prove plan generation against the real taxonomy.** Eight query families, per enabled
      category and language. A disabled category must produce no query at all.

- [ ] **S — Operator view for domain health.** A domain the breaker suspends can only be released
      through the service, and no endpoint exposes it. That is a dead end today.
      _File:_ `apps/api/src/sources/domain-health.service.ts` — suspend and release exist

**Done when:** a Postman search returns leads parsed from a feed, not read from a fixture file.

---

## Group 2 — First live source (G10)

Goal: the service makes its first real request, deliberately.

- [x] **Write the FI-20 integration test first.** Done 2026-09-16, before anything is polled
      live. Six tests proving the halt and its audit entry commit together in Mongo: both land
      when a recorded stop condition fires; **neither** lands when the audit write fails; the
      same refusal re-derives the halt afterwards (which is what bounds the window to one
      request); a re-derived halt keeps the first record rather than moving the timestamp an
      operator was alerted about; the halt refuses at the point of use through a freshly
      constructed service, `SUSPENDED` with the reason verbatim; and the shared `__platform__`
      hash chain still verifies.
      _Verified by planting the violation_ — moving the health write outside the transaction
      makes exactly the two atomicity tests fail with a halted source and no audit entry, and
      restoring it makes them pass. The suite deletes nothing from `auditEvents`: removing an
      entry from the middle of a hash chain is the tampering the chain exists to detect.
      _File:_ `tests/integration/source-halt.test.ts`

- [ ] 🟠 **S — Propose, approve and activate the SEC source.** Through `/v1/admin`, four eyes.
      The record is written and schema-checked already.
      _File:_ `apps/api/src/sources/registry/sec-litigation-releases.ts`

- [x] **One-shot script for the first robots read.** `pnpm first-contact` — prints exactly what it
      will do and sends nothing without `--yes-contact-the-sec`. Uses the real transport with the
      real screening lookup, so if the address screening or the user agent were wrong, that shows
      up on the first request rather than the hundredth. Writes the result to
      `docs/sources/sec-robots-evidence.json` as D6 evidence. **Prepared; not run.**
      _File:_ `scripts/first-contact.mjs`

- [ ] 🟠 **S — Update `robotsPosition` from what robots.txt actually said.** Through the
      lifecycle. Until then the fetch gate refuses the source, which is deliberate.

- [ ] **S — Turn on the 15-minute poll and watch it.** Confirm 304s. Confirm no trip-wire fires
      by accident.

- [x] **A live-mode stack.** `pnpm dev:live` — sets the mode, refuses to start without
      `FETCH_CONTACT_URL`, and prints what changes, because two of the differences look like
      breakage. The seeded taxonomy now enables `US` as well as `CR` (D-044): a source whose
      countries the pinned taxonomy enables nothing for is refused `JURISDICTION_NOT_ENABLED`,
      which reads like a bug.

- [x] **Rungs 3 and 4 filled.** Rung 4 (Bing News RSS) needed **no code** — the RSS connector at
      another approved address. Rung 3 (GDELT) needed a JSON parser and a connector type
      (**D-046**). Templates for rungs 2, 3 and 4 are written and **inert**: no first-contact
      approval, no robots position, and `ENDPOINT NOT VERIFIED` in the record itself.
      _Files:_ `gdelt-discovery.adapter.ts`, `registry/discovery-rungs.ts`

- [ ] 🔵 **M — Verify the rung 2, 3 and 4 endpoints and approve them.** The addresses are the
      widely documented ones and **nobody has loaded them**. Each needs its endpoint confirmed, a
      robots read, and a named first-contact approval before it can be used.

- [ ] 🔵 **M — Repeat for every other source you want.** Each one needs its own named approval.
      Blocked on your source list.

**Done when:** `mode` in the findings response says `LIVE` and a real source has answered.

---

## Group 3 — Make the findings real (G7)

Goal: stop returning thin results.

- [ ] 🟠 **M — Choose the extraction model.** Open decision **D7**. Benchmark against the
      labelled set.

- [ ] 🟠 **L — Real extraction.** Partly addressed 2026-09-16 (**D-048**): live mode now has a
      _rule-based_ extractor rather than none, so a live run no longer rejects every document at
      `EXTRACTION`. It is still keyword matching — proximity-bounded to 600 characters of a name
      form, English and Spanish term tables only, `modelId: null`, **recall never measured**.
      Every run using it carries a warning saying so. Until a benchmarked model lands (D7), live
      results are thin and the coverage statement must keep saying so.
      _File:_ `apps/api/src/sources/rule-based-extraction.adapter.ts`

- [ ] 🟠 **M — The four FR-07 date fields.** The rule-based extractor leaves all four null, which
      is correct under FR-07 — a missing date is never backfilled with retrieval time — and means
      **every finding it produces is undated**. Recency behaviour cannot be tested against a live
      result until this lands. The rest of Phase F step F1, with PDF and OCR.

- [ ] **M — Wire FR-10 clustering.** A syndicated copy of one story currently counts as a second
      independent source. That inflates the evidence behind a finding.

- [ ] 🔵 **M — Measure recall per language.** No language is enabled without a measured figure
      (FR-03). Worldwide scope makes this bigger, not smaller.

**Done when:** a finding carries a real category, stage and rationale a reviewer can check.

---

## Group 4 — Complete the API surface (G9)

Goal: every documented endpoint either works or says clearly why it does not, and a machine
client can be run safely.

- [ ] 🔵 **S — Decide the eight reserved endpoints.** `/v1/admin/plans`,
      `/v1/admin/tenants/{id}/usage` and `/v1/tenant/usage` return **501** (`/v1/tenant/api-keys`
      no longer does — implemented by **D-050**)
      with a documented reason, deferred by **D-007**. Either implement them or retire them from
      the contract. Leaving a documented endpoint permanently unimplemented is the thing that
      makes an OpenAPI document untrustworthy.
      _File:_ `apps/api/src/common/reserved.controller.ts`

- [ ] 🔵 **M — Rate limiting.** `RATE_LIMITED` exists as an error code and the OpenAPI document
      lists 429 on `POST /v1/searches`. **Nothing throws it.** A looping caller is unlimited.
      _File:_ `packages/contracts/src/errors/errors.ts` has the code

- [ ] 🔵 **M — Webhook on search completion.** The outbox exists and publishes only to the
      internal queue, so polling is the only way to learn a run finished. Fine at low volume.
      _File:_ `apps/api/src/persistence/outbox.service.ts`

- [ ] **S — Read a subject without knowing its version.** Only
      `GET /v1/subjects/{id}/versions/{version}` exists. A caller holding just an id cannot read
      one back.

- [ ] **S — Endpoints for domain health.** The per-domain breaker can suspend a publisher and
      only the service can release it. Nothing exposes that, so it is a dead end for an operator.
      _File:_ `apps/api/src/sources/domain-health.service.ts` — suspend and release exist

**Done when:** every path in `openapi.json` does what it says, and no caller can run the service
out of budget by accident.

---

## Group 5 — Run it in production (G11)

Goal: it runs somewhere other than a laptop.

**Nothing in this group exists today.** `infra/` contains a local docker-compose stack and
nothing else.

- [ ] 🔵 **L — Infrastructure as code.** Terraform or CDK for: the API service, the worker, Mongo,
      SQS, S3, Meilisearch, the OIDC provider. No hand-made consoles.
      _Today:_ `infra/local/docker-compose.yml` only

- [ ] 🔵 **M — Deployment pipeline.** Build an image, run the gates, deploy, roll back.
      CI runs format, lint, typecheck, unit, invariants, evaluation, coverage, dependency audit
      and licence inventory. It does not build or deploy anything.
      _File:_ `.github/workflows/ci.yml`

- [ ] 🔵 **M — Secrets from a secret manager.** Configuration is read from environment variables
      today. `FETCH_CONTACT_URL`, the Companies House key, the OIDC client secret and the session
      secret must not live in a file.

- [ ] 🔵 **S — TLS and ingress.** The API should not be on the public internet unless it has to
      be.

- [ ] 🔵 **M — Backups and a restore drill.** Mongo and the evidence store. A backup nobody has
      restored is not a backup.

- [ ] 🔵 **M — Runbooks.** What to do when: a source starts refusing us, the breaker suspends a
      publisher, the queue backs up, a worker loses its lease, a publisher complains.

- [ ] 🔵 **S — Worker scaling and lease tuning.** Under real load, not guessed.

**Done when:** you can deploy a change, see it live, and roll it back.

---

## Group 6 — See what it is doing (G11)

Goal: you find out about a problem before a customer does.

**Nothing in this group exists today.** No metrics, no tracing, no alerting.

- [ ] 🔵 **M — Metrics.** Searches started and finished, queue depth, worker lag, source breaker
      state, budget spend per source, fetch failures by FR-06 class.

- [ ] 🔵 **M — Tracing.** One search id traceable from the API call to the worker to each source
      request.

- [ ] 🔵 **S — Structured logging with redaction.** **Nothing redacts today.** This service
      handles names of people being screened; a name in a log is that name copied to every place
      logs go.

- [ ] 🔵 **M — Alerts that matter.** A source halted. A breaker suspending a publisher. A feed
      whose shape changed — that one is silent and drops recall to zero.

- [ ] 🔵 **S — The scheduled contract test running on a schedule.** `contractProbe` is built.
      Nothing runs it yet. It is the detection mechanism for the worst failure this product has.

**Done when:** a feed shape change pages someone, instead of quietly returning clean results.

---

## Group 7 — Prove it

- [x] **Run the integration suite.** 206 passing, 2026-09-15.

- [x] **Run the security suite.** 106 passing, 2026-09-15.

- [x] **An API end-to-end suite.** `pnpm test:e2e:api` — 10 tests. In through the HTTP door and
      out through it, with the real outbox, the real SQS queue and a real worker in between.
      Nothing before it proved the pieces were joined.
      _File:_ `tests/e2e/api-lifecycle.test.ts`

- [ ] 🔵 **M — Run both in CI.** CI runs neither today, because neither has a stack.

- [ ] 🔵 **M — Implement `pnpm test:e2e`** — the **browser** suite, gate G8, mostly in the
      frontend repo. Still exits non-zero on purpose. The API suite above does not and must not
      stand in for it: that would be a gate going green without being met.

- [ ] 🔵 **M — Implement `pnpm test:load`.** Same. Needed before anyone promises a throughput
      number.

- [x] **Fix the stale status doc.** `implementation-status.md` claimed all four extra suites were
      unimplemented long after two of them were written. Corrected with the real numbers.

- [ ] 🔵 **S — Penetration test.** Before real customer data.

**Done when:** `pnpm verify:local` passes with no "unverified" lines, and CI runs every suite.
As of 2026-09-15 it reports **one** unverified line — the browser end-to-end suite — and passes
everything else.

---

## Group 8 — Legal and compliance before go-live

Not code. Still blocking.

- [ ] 🔵 **M — Erasure path.** A person asks to be deleted. Prove it works here, and anywhere the
      data was copied.

- [ ] 🔵 **S — Verify retention actually deletes.** 30 days by default, and a legal hold
      overrides it. Test the sweep against real data, not fixtures.

- [ ] 🔵 **S — Confirm every source's licence terms are recorded and unexpired.** The gate reads
      these on every fetch.

- [ ] 🔵 **M — Decide what a customer is told about coverage.** A search that missed half its
      sources must never read as clean. That is a wording decision as much as a code one.

- [ ] 🔵 **S — Sign-off on "production approved".** Named person, recorded — the same shape as
      the source approvals.

---

## Shortest path, if you want it demoable first

1. ~~**Group 0**~~ — done. Postman works propadverse-search.
2. **Group 1** — the cascade and the two wiring items.
3. **Group 2** — all of it. One real source answers.

That is a Postman search reaching a real website and returning real leads. Findings stay thin
until Group 3, and it is **not production ready** until Groups 5 to 8 are done.

---

## Rough shape of the work

| Group                 | Size                          |
| :-------------------- | :---------------------------- |
| 0 — Postman today     | ~1 day                        |
| 1 — Real search       | 1–2 weeks                     |
| 2 — First live source | 2–3 days                      |
| 3 — Real findings     | 2–4 weeks                     |
| 4 — Integration ready | 1–2 weeks                     |
| 5 — Run in production | 2–4 weeks                     |
| 6 — Observability     | 1–2 weeks                     |
| 7 — Prove it          | 1–2 weeks                     |
| 8 — Legal             | parallel, not engineering-led |

These are shapes, not commitments. Group 3 is the one most likely to be wrong, because model
choice and measured recall are not schedulable.

---

## Not on this list, on purpose

Decisions, not tasks. Someone other than a developer answers them.

| #   | Question                                              | Who                    |
| :-- | :---------------------------------------------------- | :--------------------- |
| 1   | The source list — names and feed URLs                 | You                    |
| 2   | Which extraction model (D7)                           | Engineering + product  |
| 3   | Whether findings may appear in a CRM at all           | Compliance             |
| 4   | How long reports live outside this system             | Compliance             |
| 5   | How robots exceptions get approved (D6)               | Source admin           |
| 6   | The Costa Rican evidence base (D15)                   | Product + source admin |
| 7   | Reviewer capacity the thresholds are set against (D5) | Product + compliance   |
| 8   | Whether numeric confidence is ever shown (D9)         | Product                |
