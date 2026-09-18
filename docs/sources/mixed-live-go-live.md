# Going live with SEC press releases and GDELT DOC 2.0

What a person has to do before Postman folder **15 — Mixed Live E2E: SEC + GDELT** can run, and
why none of it is automated.

Folder 15 proves an architectural claim that cannot be checked from a list of source ids: that a
`FIXED_FEED` costs one request per poll floor however large the query plan is, and a `QUERY_FEED`
costs one request per planned query bounded by its budget. To prove it live, three sources have to
be **ACTIVE** at once:

| Source id                 | Shape        | Rung | Publisher            | State today                    |
| :------------------------ | :----------- | :--- | :------------------- | :----------------------------- |
| `sec-litigation-releases` | `FIXED_FEED` | 1    | www.sec.gov          | **ACTIVE** since 2026-09-16    |
| `sec-press-releases`      | `FIXED_FEED` | 1    | www.sec.gov          | **proposed in code, not live** |
| `gdelt-doc-v2`            | `QUERY_FEED` | 3    | api.gdeltproject.org | **proposed in code, not live** |

"Proposed in code" means the record content exists in
`apps/api/src/sources/registry/` and parses against the FR-05 schema. It does **not** mean a
version exists in the registry, and it does not mean the fetch gate would permit a request. Both
records are deliberately inert.

---

## Why none of this is a script

Every step below is a statement somebody makes about a third party. A script that performed them
would be this service asserting, on nobody's behalf, that it had read a publisher's robots.txt and
accepted their terms. The four-eyes lifecycle exists so that the record the fetch gate reads names
a person who actually looked.

**Nothing in folder 15 activates a source.** Requests 15.6 and 15.7 read the registry and halt the
folder if a source is not ACTIVE. A test that activated a source to make itself pass would be the
thing that is supposed to be checking the lifecycle bypassing it.

---

## A. SEC press releases

The smaller of the two, because the publisher relationship already exists.

**What is already true.** D17 — closed 2026-09-15 — named this feed: _"the SEC litigation-releases
RSS feed … with the press-releases feed as a second, later."_ So the first-contact approval on the
proposed record is not borrowed, and it is already filled in. The licence terms, the fair-access
ceiling, the stop conditions and the `sec.gov` domain are the same facts as on the litigation feed,
and the record reuses them.

**What is not.** `robotsPosition` is `NOT_ESTABLISHED`. `docs/sources/sec-robots-evidence.json`
records a real read of `https://www.sec.gov/robots.txt` on 2026-09-16 whose body does not disallow
`/news/pressreleases.rss` — but the evidence file's own `feedPathChecked` names the _litigation_
path. Somebody has to read the recorded body against this path and say so.

1. **Establish the robots position.** Read the recorded body in
   `docs/sources/sec-robots-evidence.json` against `/news/pressreleases.rss`, or re-read
   `https://www.sec.gov/robots.txt` if you would rather have fresh evidence. Record what you
   checked. The runtime check is unaffected either way — `HttpEvidenceFetchAdapter` re-reads
   robots at fetch time rather than trusting the record.
2. **Propose the version.** Folder 5, _Propose — the SEC feed (D17)_, with the body taken from
   `SEC_PRESS_RELEASES_CONTENT` and `recordId: sec-press-releases`. Edit the draft to set
   `robotsPosition: HONOURED` and to remove the `ROBOTS POSITION NOT ESTABLISHED FOR THIS PATH`
   sentence from `policySummary` — removing that sentence is the claim that you checked.
3. **Submit and approve.** Four eyes: the approver is not the proposer.
4. **Activate.** The SEC-05 rights gate runs here.

**Expected cost once live:** one poll of the feed per fifteen-minute poll floor, shared by every
search in the process, plus one document fetch per candidate. Its own budget is 6 an hour and 120 a
day, separate from the litigation feed's.

---

## B. GDELT DOC 2.0

The larger of the two, because **this project has never contacted GDELT**. Four separate human acts,
and each one is a refusal the fetch gate is currently making on your behalf.

1. **Read `https://api.gdeltproject.org/robots.txt`** and record the position. This is a first
   contact with a new publisher and should be treated the way D17 treated the SEC's: one request,
   recorded, before anything else. `scripts/first-contact.mjs` is the shape to copy — it is
   hard-coded to the SEC target on purpose and is not a parameterised crawler.
2. **Read and name GDELT's terms.** The proposed record says `licenceTermsVersion: 'UNVERIFIED'`,
   and the gate refuses a source without named terms. Whoever replaces it is stating they read
   them.
3. **Verify the endpoint.** `policySummary` begins `ENDPOINT NOT VERIFIED`. The address
   `https://api.gdeltproject.org/api/v2/doc/doc` is the widely documented one and a widely
   documented address is still a guess until somebody loads it. Removing that sentence is the claim
   that you loaded it.
4. **Record a named first-contact approval.** `accessPolicy.firstContactApproval` is `null`, and
   **the SEC's D17 must never be copied into it.** D17 is a decision about `www.sec.gov`. An
   approval that travelled between publishers would be no approval at all. This needs its own
   decision, its own approver and its own date.

Then propose → approve → activate, as above, with `recordId: gdelt-doc-v2` and the body from
`GDELT_DOC_V2_CONTENT`.

### The budget is deliberately below one full query plan

`freeTierHourlyBudget: 24`. A live plan for one subject in one language and one jurisdiction is
about 53 queries — one F1, one F4, and one per enabled category per top conduct term for F3. So a
single run **will** exhaust the budget and the remaining queries **will** be recorded as
`HOURLY_BUDGET_EXHAUSTED` refusals, and the run will finish `PARTIAL` / `INCOMPLETE`.

That is the intended result, not a fault. Fan-out truncation is the property that separates a query
feed from a fixed feed operationally, and a budget nobody reaches is a budget nobody has tested.
Raising it later is one approved version, not a code change.

---

## C. Before you arm the folder

```bash
pnpm source:health sec-litigation-releases      # breaker, both budget windows, last success
pnpm source:health sec-press-releases
pnpm source:health gdelt-doc-v2
pnpm sec:live-smoke --yes-contact-the-sec       # one request to the SEC, fully reported
```

`pnpm source:health <id> --reset --reason "…"` clears a recorded breaker locally. It has no flag
that disables the breaker, refuses under `NODE_ENV=production`, and refuses a non-local
`MONGODB_URI`.

Then, in the Postman environment:

```
mixedLiveConfirm  = yes-contact-sec-and-gdelt
mixedSubjectName  = <a benign subject>
mixedCompanyName  = <a company that gives F2 something to anchor on, or leave the default>
```

`mixedLiveConfirm` is a **different variable from folder 14's `liveConfirm`**, on purpose: arming
folder 14 must not arm a folder that contacts a publisher this project has no relationship with.
Clear it again afterwards.

**On choosing a subject.** Folder 15 tests transport, planning, coverage and provenance. Do not
point it at a private individual in order to manufacture adverse findings. `NO_MATCHES_FOUND` is a
perfectly good outcome here — every architecture assertion in 15.12 reads request counts and
provenance, none of them reads a finding.

---

## D. What the run should show

Read from `GET /v1/searches/{id}/findings` → `liveDiscovery`:

- `sec-litigation-releases` and `sec-press-releases`: `endpointKind: FIXED_FEED`,
  `requestsIssued: 1` each, `distinctEndpoints: 1`, and `queriesOffered` greater than that — the
  gap is what `FixedFeedPollCache` absorbed.
- `gdelt-doc-v2`: `endpointKind: QUERY_FEED`, `requestsIssued` **equal to** `distinctEndpoints`
  (distinct planned queries were not collapsed), at most the recorded hourly budget, and
  `familiesRequested` containing `F1`, `F3` and `F4` — plus `F2` when the association graph
  resolved a company.
- Two hosts across the whole run: `www.sec.gov` and `api.gdeltproject.org`.

`liveDiscovery` carries no query text and no URLs. Endpoint identity is counted through a one-way
digest, because a planned query is the subject's name plus a conduct term and an audit field is the
wrong place for it.
