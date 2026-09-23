# Source catalogue

Every external source this service knows about, in one table per group: its endpoint, whether it
needs a credential, what its licence position actually is, what fields we get out of it, and what
still stands between it and a live request.

**Written 2026-09-21 from the code, not from a live registry read.** The code is the proposal; the
database holds the decision. Where the two can disagree, this document says so on the row.

> **Superseded in part, later on 2026-09-21.** Section 2's headline — "none of them is in the
> registry" — was true when this was written and is no longer. Nine of the ten indexed sources are
> now ACTIVE with real local snapshots, and the tenth is APPROVED behind an evidenced blocker. The
> per-source endpoint, credential and licence rows below remain accurate and are still worth
> reading; the *state* they describe is not. The live picture is
> [`indexed-source-onboarding.md`](./indexed-source-onboarding.md) and, authoritatively,
> `GET /v1/admin/indexed-sources`.
>
> Two rows changed substantively: `eu-consolidated-financial-sanctions` now points at the
> tokenised distribution URL the Commission's own open-data catalogue publishes (the untokenised
> path answers 403), and `ofac-consolidated-non-sdn`'s row floor is 300 against a measured 481
> entries, not the 1,000 it was guessed at.
Verify the live picture with `GET /v1/admin/sources?limit=200` (needs a `source_admin` credential;
a `tenant_admin`/`analyst` key answers 403) and `GET /v1/admin/indexed-sources`.

## How to read the "ready?" column

A source reaches a publisher only when **all five** of these are true on its ACTIVE version. The
fetch gate checks them immediately before a socket opens, and refuses on any one of them:

1. an **ACTIVE** version, reached through propose → approve (four eyes) → activate;
2. `robotsPosition` is **established**, by a person who read the publisher's robots.txt;
3. `licenceTermsVersion` names **real, unexpired** terms somebody read;
4. `accessPolicy.firstContactApproval` names **a person, a role, a date and a decision** — and it
   is per publisher, never copied between them;
5. the credential, where the publisher requires one, is present in the deployment's environment.

`NOT_ESTABLISHED`, `UNVERIFIED` and `…-REVIEW-REQUIRED` are not oversights. They are the honest
recorded value, and each is a refusal the gate is making on your behalf.

---

## 1. Live today — three sources, ACTIVE

These have been through all five steps. They are the only sources that have ever contacted a
publisher from this project.

| Source id | Publisher | Endpoint | Shape | Rung | Credential | Licence recorded | First contact | Ready? |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `sec-litigation-releases` | US SEC | `https://www.sec.gov/enforcement-litigation/litigation-releases/rss` | `FIXED_FEED` RSS | 1 | none | `sec-fair-access-2026-09-15` | D17, 2026-09-15 | **Live since 2026-09-16** |
| `sec-press-releases` | US SEC | `https://www.sec.gov/news/pressreleases.rss` | `FIXED_FEED` RSS | 1 | none | `sec-fair-access-2026-09-15` | D17 | **Live since 2026-09-18** |
| `gdelt-doc-v2` | The GDELT Project | `https://api.gdeltproject.org/api/v2/doc/doc` (`query=`) | `QUERY_FEED` JSON | 3 | none | `gdelt-terms-of-use-2022-09-03` | D18 — Faisal Ali, source admin, 2026-09-18 | **Live since 2026-09-18** |

**What we get:** article-level leads — headline, link, publication date, publisher domain — which
the pipeline then fetches and puts through the rule-based extractor. Not structured list rows.

**Budgets and pacing.** Each SEC feed: 6 requests/hour, 120/day, 15-minute poll floor, shared by
every search in the process. GDELT: 24/hour, 200/day, and a hard **one request per 5 seconds**
ceiling (`requestCeilingPerSecond: 0.2`) enforced per host by `RequestPacer`. A single GDELT plan
is ~53 queries, so one live run **will** exhaust the budget and finish `PARTIAL`/`INCOMPLETE` with
`HOURLY_BUDGET_EXHAUSTED` refusals. That is the designed result, not a fault.

> **Note on the code vs. the record.** `SEC_LITIGATION_RELEASES_CONTENT` and
> `SEC_PRESS_RELEASES_CONTENT` in `apps/api/src/sources/registry/` still carry
> `robotsPosition: 'NOT_ESTABLISHED'`. That is correct for a *template*: the `HONOURED` value was
> set on the draft at propose time, by the person who read the evidence. Do not "fix" the code to
> match the database — that would make the next proposal assert a robots position nobody checked.

---

## 2. Built, proposed in code, never seeded — ten indexed sources

`apps/api/src/sources/indexed/` downloads a publisher's whole dataset on a reviewed cadence, parses
it into `NormalizedSourceRecord`s and searches it **in our own database**. A search therefore costs
these sources **zero publisher requests**, which is why they answer at cascade rung 0, ahead of
every query-time rung.

**The code templates still carry `firstContactApproval: null` and
`robotsPosition: NOT_ESTABLISHED`, and `indexed-source-config.test.ts` fails the build if that
stops being true.** That is not stale — it is the templates honestly saying that writing a
connector is not the same event as deciding to call someone. The governance values are set on the
*proposed version*, from the evidence file, by the run a named person authorised. Do not "fix" the
templates to match the database; doing so makes the next proposal assert a robots position nobody
checked.

**They are no longer absent from the registry.** `pnpm source:onboard --apply` drives each one
through propose → submit → approve → activate over the real Admin API with two distinct
principals. See [`indexed-source-onboarding.md`](./indexed-source-onboarding.md).

### 2a. Sanctions and debarment lists

| Source id | Publisher | Endpoint | Format | Credential | Licence position | Cadence / min rows | Ready? |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `ofac-sdn` | US Treasury OFAC | `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML` | XML | none | `US-GOVERNMENT-WORK-REVIEW-REQUIRED` | 6h / 10,000 | No — steps 1–4 |
| `ofac-consolidated-non-sdn` | US Treasury OFAC | `…/exports/CONSOLIDATED.XML` | XML | none | `US-GOVERNMENT-WORK-REVIEW-REQUIRED` | 6h / 1,000 | No — steps 1–4 |
| `uk-sanctions-list` | UK FCDO | `https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml` | XML | none | `OPEN-GOVERNMENT-LICENCE-3.0-REVIEW-2026-09-18` — OGL v3.0 covers GOV.UK page content; **dataset reuse still needs confirming** | 6h / 1,000 | No — steps 1–4 |
| `unsc-consolidated` | UN Security Council | `https://scsanctions.un.org/resources/xml/en/name/consolidated.xml` | XML | none | `UN-TERMS-REVIEW-REQUIRED` | 24h / 900 | No — steps 1–4 |
| `eu-consolidated-financial-sanctions` | European Commission, DG FISMA | `https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content` | XML 1.1 | none | `EU-DATASET-LICENCE-REVIEW-REQUIRED` | 24h / 2,000 | No — steps 1–4, **and the endpoint URL itself is unverified** |
| `world-bank-debarred` | World Bank Group | `https://apigwext.worldbank.org/dvsvc/v1.0/json/APPLICATION/ADOBE_EXPRNCE_MGR/FIRM/SANCTIONED_FIRM` | JSON | **`WORLD_BANK_SANCTIONS_API_KEY` — required, currently empty** | `WORLD-BANK-TERMS-REVIEW-REQUIRED` | 3h / 1,000 | No — steps 1–5 |

**What we get from a sanctions list row** — the full `NormalizedSourceRecord` projection, every
field nullable because normalising must never turn an absence into an invented fact:

`sourceRecordId` · `recordType` (PERSON / ENTITY / VESSEL / AIRCRAFT / OTHER) · `primaryName` ·
`aliases` · `originalScriptNames` · `datesOfBirth` (with precision: DAY/MONTH/YEAR/RANGE/UNKNOWN) ·
`placesOfBirth` · `nationalities` · `citizenships` · `countries` · `addresses` ·
`identifiers` (passport, national id, tax id — typed, with issuing country) · `companyIdentifiers` ·
`listingDate` · `programmes` · `sanctionTypes` · `grounds` · `status` · `effectiveDate` ·
`expiryDate` · `publisherUrl` · `sourceDocumentUrl` · and the publisher's own untouched fields in
`rawEvidence`.

On the finding, a reviewer additionally gets `sourceRecordId`, `sourceSnapshotVersion`,
`parserVersion` and `rawEvidenceHash` — enough to name the exact published row a match came from.

**The World Bank key.** `credentialsRef: 'WORLD_BANK_SANCTIONS_API_KEY'` is a *reference*; the
registry never stores the secret (SEC-04). The value is supplied at fetch time as a first-hop-only
header. Blank leaves the source configured and mechanically unable to call the API — which is the
intended state until somebody obtains a key the deployment owns. **Do not copy a third-party key.**

### 2b. Regulator enforcement feeds (`INDEXED_RSS`)

| Source id | Publisher | Endpoint | Credential | Licence position | Ready? |
| :-- | :-- | :-- | :-- | :-- | :-- |
| `doj-fraud-enforcement` | US DOJ | `https://www.justice.gov/news/rss?…` (fraud topic filters) | none | `US-DOJ-WEB-POLICY-REVIEW-REQUIRED` | No — steps 1–4 |
| `cftc-enforcement-press-releases` | US CFTC | `https://www.cftc.gov/RSS/RSSENF/rssenf.xml` | none | `US-CFTC-WEB-POLICY-REVIEW-REQUIRED` | No — steps 1–4 |
| `ftc-consumer-protection-press-releases` | US FTC | `https://www.ftc.gov/feeds/press-release-consumer-protection.xml` | none | `US-FTC-WEB-POLICY-REVIEW-REQUIRED` | No — steps 1–4 |
| `fca-warnings` | UK FCA | `https://www.fca.org.uk/news/warnings/rss.xml` | none | `FCA-COPYRIGHT-REVIEW-REQUIRED` | No — steps 1–4 |

All four are one generic `official-feed` parser with a per-regulator category and default
procedural stage. **What we get:** title, link, publication date, summary text
(`searchableText`, used only for local candidate retrieval), plus `findingMetadata` —
`category`, `proceduralStage` inferred from the text against the regulator's default, and
`partyRole`. Cadence 1 hour, `minimumExpectedRows: 1`.

---

## 3. Seeded as PROPOSED — two query feeds

These are in the registry of every fresh stack as drafts an operator can see and work on. Seeding
them ACTIVE would put two unverified endpoints on the ladder of every stack.

| Source id | Publisher | Endpoint | Rung | Credential | Licence | Ready? |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `google-news-rss-en-us` | Google | `https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en` (`q=`) | 2 | none | **PROHIBITED — D20** | **No, and never.** Terms of Use forbid both commercial use and automated access. **Endpoint deliberately never loaded** |
| `bing-news-rss-en-us` | Microsoft | `https://www.bing.com/news/search?format=RSS` (`q=`) | 4 | none | `UNVERIFIED` | No — steps 1–4, **endpoint not loaded by anyone** |

Budgets 60/hour, 500/day each. **What we would get:** the same article-level leads as the SEC
feeds. Note these are the two rungs where a publisher's terms most plausibly *forbid* automated
querying — the `UNVERIFIED` licence is the substantive blocker, not a formality.

> **That prediction was tested on 2026-09-22, for Google, and it was right.**
>
> **`google-news-rss-en-us` is closed as refused — [D20](../open-decisions.md).** The Google News
> Terms of Use restrict the service to *"your own personal use (i.e., non-commercial use)"* and
> separately prohibit *"any robot, spider, other device or manual process to monitor or copy any
> content"*. Either clause alone excludes this service. It stays **PROPOSED** and no request has
> ever been sent to `news.google.com` — the terms were read first, and loading the endpoint to
> "check" would have been the prohibited act performed in order to decide whether it was prohibited.
>
> A second defect survives the licence question: since late 2024 the feed's `<item><link>` is a
> Google redirect (`/rss/articles/CBMi…`), not the publisher's article URL, and the only ways to
> resolve it are another request to Google or reverse-engineering a signed protobuf token. The
> `<source url>` element yields the publisher's **domain**, never the document — so FR-09 provenance
> cannot be met. Evidence: `evidence/google-news-rss-en-us.json`.
>
> **`bing-news-rss-en-us` has not been examined and must not be activated on the assumption that
> Microsoft's position differs.** The same two questions — commercial use, and whether the link is
> the publisher's — have to be answered for it on its own evidence.

---

## 4. Not a registry source — the company registry seam

| Adapter | Publisher | Endpoint | Credential | Status |
| :-- | :-- | :-- | :-- | :-- |
| `CompaniesHouseAdapter` (`src-companies-house-gb`) | UK Companies House | `https://api.company-information.service.gov.uk` | **`COMPANIES_HOUSE_API_KEY` — required, currently empty** | Live adapter exists; **not constructed** without the key |

**What we get:** officer-level association data for the FR-02 graph — company records, officers,
appointments, and the `DIRECTOR_OF` edges built from them. **GB only.** It is explicitly *not*
coverage for Costa Rica (D-010, D14): CR has no free automatable officer-level source. See
[`cr-dossier.md`](./cr-dossier.md). Without the key the seam is `null`, and FR-02 association data
reports as **unavailable** rather than absent — which is the point.

---

## 5. Fixtures — eight, live-inert by construction

`fixture-newsroom`, `fixture-court`, and six mock adapters (`src-mock-news-discovery`,
`src-mock-web-discovery`, `src-mock-primary`, `src-mock-cr-registry`, `src-mock-fetch`,
`src-mock-extraction`). Seeded ACTIVE because they talk to nothing. Every record they produce is
stamped `MOCK` and T55 refuses to let them shed it; a LIVE process throws before it can construct
one.

---

## 6. Dead environment variables

Present in `.env`, referenced **nowhere** in `apps/`, `packages/` or `scripts/`:

- `COURTLISTENER_API_TOKEN` — no CourtListener adapter exists.
- `SEARXNG_URL` — SearXNG runs in the local compose stack but no code reads this.

Either build the connector or delete the variable. A credential slot with no consumer reads as
coverage that does not exist.

---

## 7. Summary count

| Group | Count | Can reach a publisher today |
| :-- | --: | :-- |
| ACTIVE, live-capable | 3 | **Yes** — SEC ×2, GDELT |
| Indexed, coded, unseeded | 10 | No |
| Seeded PROPOSED query feeds | 2 | No |
| Company registry adapter | 1 | No — key empty |
| Fixtures | 8 | Never, by construction |
| **Real sources with code** | **16** | **3** |

---

## 8. What each blocked source actually needs, in order

Nothing below is a deployment, and none of it is automatable without becoming a lie — each step is
a statement a **person** makes about a third party. `scripts/first-contact.mjs` is the shape to
copy; it is hard-coded to one target on purpose and is not a parameterised crawler.

1. **Read the publisher's `robots.txt`** and record the position with evidence, the way
   `sec-robots-evidence.json` and `gdelt-evidence.json` do.
2. **Read and name the terms.** Replace the `…-REVIEW-REQUIRED` / `UNVERIFIED` placeholder with a
   real, dated identifier. Whoever replaces it is stating they read them.
3. **Verify the endpoint.** Where `policySummary` says `ENDPOINT NOT VERIFIED`, a documented
   address is still a guess until somebody loads it. Removing that sentence is the claim that you
   did.
4. **Record a named first-contact approval** — person, role, date, decision. **Per publisher.** An
   approval that travelled between publishers would be no approval at all.
5. **Supply the credential** where one is needed (World Bank, Companies House), owned by the
   deployment.
6. **Propose → approve → activate** through Postman folder 11. Four eyes: the approver is not the
   proposer. The SEC-05 rights gate runs at activation.

For an indexed source, then run one refresh deliberately:
`POST /v1/admin/indexed-sources/{sourceId}/refresh` with `source:approve` **and** the header
`X-Allow-Publisher-Contact: true` — not authentication, which the key already carries, but a
deliberate act, so a publisher's whole dataset is never downloaded by a request someone sent to see
what it returned.

---

## Related

- [`mixed-live-go-live.md`](./mixed-live-go-live.md) — the SEC + GDELT go-live record and the
  halted-source release procedure.
- [`first-live-contact.md`](./first-live-contact.md) — what was contacted and when.
- [`cr-dossier.md`](./cr-dossier.md) — why Costa Rica has no officer-level source.
