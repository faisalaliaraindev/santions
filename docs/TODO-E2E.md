# TODO — to a complete system you can test end to end in Postman

Date: 2026-09-15

A checklist. Tick top to bottom. Each group is usable on its own.

**Legend:** 🔴 blocker · 🟠 needed for real results · 🟡 needed before production
**Size:** S = under a day · M = a few days · L = a week or more

---

## Group 0 — Make it callable from Postman (mock data)

Goal: you can run the whole API from Postman and get real responses with fake data.

- [ ] 🔴 **S — A script that issues an API key.** `pnpm key:issue --tenant t-1 --env sandbox`,
      prints the key once. Today only `scripts/demo-api.mjs` can mint one, by importing the
      service and talking to Mongo directly.
      _Files:_ new `scripts/issue-api-key.mjs`, uses `apps/api/src/tenancy/api-key.service.ts`

- [ ] **S — A Postman collection committed to the repo.** All 6 caller endpoints, with the API
      key as an environment variable.
      _Files:_ new `postman/erly-adverse-search.postman_collection.json`

- [ ] **S — A Postman environment file.** `baseUrl`, `apiKey`, `tenantId`.
      _Files:_ new `postman/local.postman_environment.json`

- [ ] **S — Write the steps into the README.** `local:up` → `local:bootstrap` → `dev:api` →
      import → set key → send.

**Done when:** a new developer clones the repo and gets a search result in Postman in under
10 minutes.

---

## Group 1 — Make a search actually search

Goal: a search runs through real source logic instead of returning fixtures.

- [ ] 🟠 **L — Build the cascade (rungs 0–7).** Walk the approved sources in order, log each
      rung, descend on failure, stop at rung 7 with `NO_MATCHES_FOUND` + `INCOMPLETE`.
      _Files:_ `apps/api/src/pipeline/search-pipeline.service.ts` (the `discover` method)

- [ ] 🟠 **M — Let the adapter set hold many news sources.** `SourceAdapterSet.newsDiscovery` is
      one nullable port. It needs to be a list, built from the active RSS sources in the registry.
      _Files:_ `apps/api/src/sources/sources.registry.ts`

- [ ] 🟠 **M — Wire `RssNewsDiscoveryAdapter` into the composition root.** Built and tested; not
      connected to anything yet.
      _Files:_ `apps/api/src/sources/sources.registry.ts`, `apps/api/src/app.module.ts`

- [ ] **M — Relevance filter before fetch (FR-06, nine signals).** Score a lead before opening a
      socket. Rejected leads are stored with their reason and shown in coverage.

- [ ] **S — Prove plan generation against the real taxonomy.** The 8 query families, per enabled
      category and language. A disabled category must produce no query at all.

- [ ] **S — Operator view for domain health.** A domain the breaker suspends can only be released
      through the service; no endpoint exposes it, so it is currently a dead end.
      _Files:_ `apps/api/src/sources/domain-health.service.ts` (suspend/release exist)

**Done when:** a Postman search returns leads that came from parsing a feed, not from a fixture
file — still against a local test feed, not the internet.

---

## Group 2 — Go live, one source

Goal: the service makes its first real request, on purpose.

- [ ] 🟠 **S — Write the FI-20 integration test first.** Prove the halt and its audit entry commit
      together in Mongo. Do this **before** anything is polled live.
      _Files:_ new test under `tests/integration/`

- [ ] 🟠 **S — Propose, approve and activate the SEC source.** Through `/v1/admin`, four eyes.
      The record is already written and schema-checked.
      _Files:_ `apps/api/src/sources/registry/sec-litigation-releases.ts`

- [ ] 🟠 **S — A one-shot script for the first robots read.** `GET https://www.sec.gov/robots.txt`,
      records the result. Prepared by us, run by you.
      _Files:_ new `scripts/first-contact.mjs`

- [ ] 🟠 **S — Update `robotsPosition` from what robots.txt actually said.** Through the lifecycle.
      Until this is done the fetch gate refuses the source, which is deliberate.

- [ ] **S — Turn on the 15-minute poll and watch it.** Confirm 304s. Confirm no trip-wire fires
      by accident.

**Done when:** `mode` in the findings response says `LIVE` and one real source has answered.

---

## Group 3 — Make the findings real

Goal: stop returning thin results.

- [ ] 🟠 **M — Choose the extraction model.** Open decision **D7**. Benchmark against the labelled
      set. Not an engineering-only call.

- [ ] 🟠 **L — Real extraction.** Today it is keyword matching. Until this lands, live results will
      be thin and the coverage statement must keep saying so.

- [ ] **M — Wire FR-10 clustering.** Right now a syndicated copy of one story counts as a second
      independent source. That inflates the evidence.

- [ ] 🟡 **M — Measure recall per language (FR-03).** No language is enabled until it has a measured
      figure. Worldwide scope makes this bigger, not smaller.

**Done when:** a finding carries a real category, stage and rationale that a reviewer can check.

---

## Group 4 — Ready for a real integration

Goal: HubSpot, SharePoint or anything else can connect safely. Detail in
[`INTEGRATION-AUDIT.md`](./INTEGRATION-AUDIT.md).

- [ ] 🔴 **S — API key endpoints.** `POST/GET/DELETE /v1/tenant/api-keys`. The service already does
      create, rotate, revoke, list and audit. Only the HTTP door is missing.
      _Files:_ `apps/api/src/tenancy/api-key.service.ts`, new controller

- [ ] 🟡 **M — Rate limiting.** `RATE_LIMITED` exists as an error code and the OpenAPI document
      lists 429. Nothing throws it. A looping caller is currently unlimited.
      _Files:_ `packages/contracts/src/errors/errors.ts` has the code

- [ ] 🟡 **M — Webhook on search completion.** The outbox exists and publishes to the internal
      queue only. Polling works until then.
      _Files:_ `apps/api/src/persistence/outbox.service.ts`

- [ ] 🟡 **M — Report export.** Findings are JSON. A document is needed for a file store, and it
      must carry the coverage statement and the rationale, not just the hits.

- [ ] 🟡 **S — Refuse `MOCK` downstream.** Any integration must hard-fail when `mode !== "LIVE"`.
      A test, not a warning.

**Done when:** a machine client can be given its own key, is rate limited, and cannot write test
data into a real system.

---

## Group 5 — Prove it

- [ ] **S — Run the integration suite.** Needs `pnpm local:up && pnpm local:bootstrap`.
      Never run this session.

- [ ] **S — Run the security suite.** Same. Never run this session.

- [ ] **M — Implement `pnpm test:e2e`.** Exits non-zero on purpose today.

- [ ] **M — Implement `pnpm test:load`.** Same.

- [ ] **S — Fix the stale status doc.** `implementation-status.md` says the integration and
      security suites are unimplemented. `START-HERE.md` says they hold 206 and 106 tests.

**Done when:** `pnpm verify:local` passes without any "unverified" lines.

---

## Shortest path to a demo

If you only want to show it working end to end, in order:

1. Group 0 — all of it. Half a day.
2. Group 1 — the cascade and the two wiring items.
3. Group 2 — all of it.

That gets you a Postman search that reaches a real website and comes back with real leads.
Findings stay thin until Group 3.

---

## Not on this list, on purpose

These are decisions, not tasks. Someone other than a developer has to answer them.

| #   | Question                                    | Who                    |
| :-- | :------------------------------------------ | :--------------------- |
| 1   | The source list — names and feed URLs       | You                    |
| 2   | Which extraction model (D7)                 | Engineering + product  |
| 3   | Whether findings may appear in a CRM at all | Compliance             |
| 4   | How long reports live outside this system   | Compliance             |
| 5   | How robots exceptions get approved (D6)     | Source admin           |
| 6   | The Costa Rican evidence base (D15)         | Product + source admin |
