# First live contact

For five phases this project's documents said, in several places, **"no live source has been
contacted."** That stopped being true on **2026-09-16**. This file is the record of when, what,
and on what evidence — written because the sentence it replaces was load-bearing, and replacing it
on an assumption would have been worse than leaving it wrong.

Nothing here is inferred from the fact that live code exists. Every line below names the artefact
it was read from.

---

## What has been contacted

**One source: the SEC litigation-releases RSS feed** (`sec-litigation-releases`), under decision
**D17**, approved by Faisal Ali (Source admin) on 2026-09-15.

No other publisher has ever received a request from this service.

---

## The three events, with their evidence

### 1. First live request — 2026-09-16T10:56:04.310Z

`GET https://www.sec.gov/robots.txt`, one request, made by `pnpm first-contact
--yes-contact-the-sec`.

- **HTTP 200**, 916 bytes, `text/plain`
- Verdict for `/enforcement-litigation/litigation-releases/rss`: **ALLOWED**
- User agent: `ErlyAdverseSearch/1.0 (+https://erlystage.com/bots/adverse-search)`

**Evidence:** [`sec-robots-evidence.json`](./sec-robots-evidence.json), written by the script at
the time of the request. This is the moment the sentence stopped being true.

### 2. First successful poll of the feed itself — 2026-09-16, during the afternoon

The source version was approved and activated (`source:approve`, `source:activate` at
2026-09-16T11:00:03Z in `auditEvents`), `robotsPosition` moved to `HONOURED` on the strength of
the robots read above, and live searches followed.

**Evidence:** fifteen `searchRuns` records carrying `environment: 'live'`, the earliest at
2026-09-16T13:06:53.753Z. The `sourceHealth` record for `sec-litigation-releases` carries
`lastSuccessAt`, and `domainHealth` carries a record for `sec.gov` with `lastSuccessAt` and no
recorded failure.

One of those runs — `bb15f120-181c-40dd-98c1-65a210bb8204`, 2026-09-17T07:42:55.658Z — reached
`SUCCEEDED` and stored **one finding** drawn from the feed. A second, on 2026-09-16, recorded a
rejected lead at stage `FETCH` against
`https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26640` with the reason "the
hourly free-tier budget of 120 call(s) is spent" — which is both proof that real documents were
being fetched and the first concrete sign of the request-rate problem.

### 3. First counted, deliberate smoke test — 2026-09-17T08:54:05.280Z

`pnpm sec:live-smoke --yes-contact-the-sec`, after the fixed-feed poll cache landed.

- One request to the feed URL, reported by `FixedFeedPollCache` rather than assumed
- **25 leads** normalised into our own structure, the newest published 2026-09-16
- Source budget moved by **2** — the feed, plus `robots.txt` on a cold process
- Breaker `CLOSED` before and after

---

### 4. First search by a tenant on its own live key — 2026-09-17T09:09:23.121Z

`SEC_LIVE_E2E=yes-contact-the-sec pnpm test:live`.

Tenant `tenant-6a39fca2-f6a2-4068-8c18-3952b544aad4` ("Live E2E Ltd") was created by
`POST /v1/signup` at 09:09:22.910Z — 211ms before the search — confirmed its address, signed in,
minted its own live key, and used **that key** for the subject, the search, the poll and the
result. Search `de734e90-4ded-4e05-b187-d5b9b0345571`: `environment: live`,
`execution: SUCCEEDED`, `findings: NO_MATCHES_FOUND`, `coverage: INCOMPLETE`, with
`sec-litigation-releases` recorded at rung 1 as `COMPLETED`, "answered at rung 1 with 1
candidate(s)", and no fixture source id anywhere in the run's outcomes. One request to the feed
URL; three against the source's budget for the whole run.

**Evidence:** the run record itself, and `tests/live/sec-live-e2e.test.ts`, which asserts each of
those rather than printing them.

---

## What had **not** happened before event 4

**The full local live path had not been proven.** Every live run in events 1–3 was started by a
script or by a dev process using a seeded or hand-made credential. None of them was a **newly
signed-up tenant using its own live API key**. Until event 4, "the live path works" meant "the
connector works", not "a customer can use it".

**No coverage claim follows from any of this.** One US enforcement feed, in English, is not
coverage of anything. No language has a measured recall figure, so none is enabled (FR-03), and
the coverage statement every run produces still says so.

---

## The rule this replaces

`CLAUDE.md` and `START-HERE.md` used to say "no live source has been contacted" as a standing
fact. They now point here instead. The rule that survives is the stronger one it was protecting:

> **Never claim a source was verified live beyond what was actually run.**

If you contact a second publisher, add it here with its evidence, the same way.
