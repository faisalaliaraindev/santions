# Onboarding an indexed source

How a publisher's dataset goes from "there is a parser for it" to "a tenant search answers from
it", on a deployment that starts empty.

This is the procedure that was missing. The ten indexed sources existed in code with parsers,
schedules, reviewed row floors and search support, and **not one registry row on a clean
deployment** — so `GET /v1/admin/sources` listed none of them, every refresh answered `FAILED`
before opening a socket, and the only route to a working stack was clicking through Postman
folder 11 ten times or reconstructing a database by hand.

---

## 1. What an indexed source is, and why it is onboarded differently

A **discovery** source is read at query time: one request per planned query, every search.

An **indexed** source is downloaded **whole** on its own reviewed cadence, parsed into a local
snapshot, and searched in our own database. So:

- a tenant search costs it **no publisher request at all**, and
- it keeps answering while the publisher is down, from the last snapshot that was good.

That shape is why publisher contact is concentrated into a scheduled refresh with a named
approval behind it, rather than spread across every customer's search.

---

## 2. The three acts, and why they are three

Onboarding is not one step, and collapsing it is how a registry ends up asserting things nobody
checked.

| Act | What it establishes | Who | Command |
| :-- | :------------------ | :-- | :------ |
| **Evidence** | What the publisher actually says and serves | a person who reads the output | `pnpm indexed:first-contact` |
| **Governance** | That a named person accepted contact, and a second approved the entry | two distinct principals | `pnpm source:onboard` |
| **Data** | That the dataset parses into a usable snapshot | an operator, deliberately | `POST /v1/admin/indexed-sources/{id}/refresh` |

**Writing a connector is not the same event as deciding to call someone.** The registry templates
in `apps/api/src/sources/registry/` therefore ship with `robotsPosition: 'NOT_ESTABLISHED'` and
`accessPolicy.firstContactApproval: null`, and `apps/api/test/indexed-source-config.test.ts` fails
if that stops being true. Do **not** "fix" those values in the template — the governance values are
set on the proposed version, from the evidence file, by the run a named person authorised.

---

## 3. Act one — gather the evidence

```bash
pnpm indexed:first-contact                                   # prints the plan, sends nothing
pnpm indexed:first-contact --yes-contact-publishers          # all ten
pnpm indexed:first-contact --source ofac-sdn --yes-contact-publishers
```

Four reads per source, in the order a polite client would make them, with a four-second floor
between requests to one host:

1. `robots.txt` on the host the artifact lives on, evaluated for the artifact's own path.
2. `robots.txt` on the policy host, when that is a different host. A second host's rules are its
   own and are never inherited.
3. The publisher's policy or terms page, so `licenceTermsVersion` names something somebody loaded.
4. The configured endpoint itself, following up to three redirects. A documented address is a
   guess until it is loaded.

Output goes to `docs/sources/evidence/<sourceId>.json` and is committed. It records **no
approval**: it is what the person taking the approval needs in order to take it, and what a
complaint would be checked against.

A 404 on `robots.txt` is recorded as **absent**, not as read. That distinction matters: an absent
file is the publisher's own choice not to restrict anything; an unreadable one is silence, and
silence is not consent.

### What the evidence found, 2026-09-21

| Outcome | Sources |
| :------ | :------ |
| Clean: robots permits, endpoint serves the expected document | the four RSS feeds, and the EU list once its address was corrected |
| Publisher redirects its documented address to its own signed object store, whose `robots.txt` answers 403 | `ofac-sdn`, `ofac-consolidated-non-sdn`, `unsc-consolidated` |
| Serves the file from a bucket whose `robots.txt` answers 403 | `uk-sanctions-list` |
| Gateway blocked by a WAF and requires a credential this deployment does not hold | `world-bank-debarred` |

The middle two rows are what **decision D6** was opened for — see §6.

---

## 4. Act two — the lifecycle, with two real principals

```bash
pnpm key:issue --tenant tenant-alpha --role source_admin --label "proposer"
pnpm key:issue --tenant tenant-alpha --role source_admin --label "approver"

pnpm source:onboard                                          # plan only, changes nothing
SOURCE_PROPOSER_KEY=erly_... SOURCE_APPROVER_KEY=erly_... pnpm source:onboard --apply
```

`scripts/source-onboard.mjs` is a client of the **public Admin API**. It writes nothing to Mongo,
holds no privileged access of its own, and can do nothing a person with the same two credentials
could not do by hand — so every state change lands in the audit trail with a principal attached.

```
propose (proposer)  →  SUBMIT (proposer)  →  APPROVE (approver)  →  activate (approver)
```

It refuses to run if:

- the two keys are identical — four eyes means two principals, and a lifecycle driven by one pair
  produces an audit trail that says something untrue; or
- `DISABLE_SOURCE_FOUR_EYES_FOR_TESTING` is set — every approval taken under that flag is
  permanently marked as **not** an independent second opinion.

**Idempotent by content, not by count.** It reads the existing versions first: an identical
`ACTIVE` version is left alone, an identical version part-way through is carried forward from
wherever it stopped, and only genuinely different content creates a new version. That is what
makes a re-run after a half-finished onboarding safe, and it is why correcting a reviewed value —
a row floor, a budget — simply produces `v2` through the same four steps.

**It cannot invent permission.** A source whose evidence does not support activation is proposed
and approved and **stopped at `APPROVED`**, with the blocker recorded on the approval reason.
There is no override flag. The thing to change is the evidence, by gathering better evidence.

---

## 5. Act three — the first controlled refresh

```bash
curl -X POST http://127.0.0.1:3000/v1/admin/indexed-sources/ofac-sdn/refresh \
  -H "Authorization: ApiKey $APPROVER_KEY" \
  -H "X-Allow-Publisher-Contact: true" \
  -H "Content-Type: application/json" \
  -d '{"force": true}'
```

Both the `source:approve` permission **and** the header are required. The header is not
authentication — the key already carries the permission. It exists so that a publisher is never
contacted by a request somebody sent to see what it returned.

### A refresh may fail; it may never make things worse

Fetch and parse happen entirely **before** the transaction. Four checks stand between an artifact
and `commitSnapshot`: a 2xx with a body, an accepted content type, a row count at or above the
reviewed `minimumExpectedRows`, and present, unique `sourceRecordId`s. Any failure records refresh
health and **keeps the last-known-good snapshot answering**, reported as `PARTIAL` with the reason
attached.

So `FAILED` here is not a broken build. It is the guarantee working.

---

## 6. D6 — the narrow robots exception

**Closed 2026-09-21 by Faisal Ali, Source admin.**

Four publishers serve their own bulk file from delivery infrastructure whose `robots.txt` answers
403 rather than 404. This service reads an unreadable `robots.txt` as `UNKNOWN` and refuses, which
is right in general and wrong for this one shape: the redirect is issued **by the publisher**, to
**the publisher's own** delivery host, for **one exact file**.

The exception is recorded on the approved version as `accessPolicy.robotsException`, and it is
**host-scoped**:

| Source | Delivery host the exception covers |
| :----- | :--------------------------------- |
| `ofac-sdn`, `ofac-consolidated-non-sdn` | `wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com` |
| `unsc-consolidated` | `unsolprodfiles.blob.core.windows.net` |
| `uk-sanctions-list` | `sanctionslist.fcdo.gov.uk` |

What keeps it narrow is that **the host is matched, not the source**. A hop onto any other host
takes the strict path and is refused even though the source carries an exception, so a publisher
who repoints their redirect needs a newly approved version rather than merely a new `Location`
header. That is enforced in `HttpEvidenceFetchAdapter.robotsDecision`, not promised in this
document, and `assertAuthorised` refuses an exception that names no host at all.

The exception is usable **only on the scheduled-artifact path**. Query-time discovery fetches URLs
nobody listed in advance, so an exception there would have no bounded scope, and
`FetchGateService.robotsPositionFor` is told explicitly which path it is answering for.

---

## 7. Where a deployment ends up

After all three acts, on a clean stack:

```bash
GET /v1/admin/indexed-sources        # platform:read_health
```

reports, per source: `snapshotUsable`, `freshness`, `refreshStatus`, `rowCount`,
`activeSnapshotVersion`, `parserVersion`, `lastSuccessfulRefreshAt` and `lastPrune`.

`snapshotUsable: false` means a search reports that source as a **coverage gap** at rung 0 — never
as a source that looked and found nothing.

Postman folder **16 — Global Indexed Sources E2E** asserts all of this end to end, including that
the tenant search itself caused zero publisher downloads.

---

## 8. Snapshot retention

Every content-changing refresh writes a full new snapshot. Without pruning, a source refreshed
four times a day grows its `indexedSourceRecords` without bound — which is exactly what happened
until 2026-09-21, when nothing in the codebase issued a `deleteMany` against that collection.

`IndexedSourceRepository.pruneSupersededSnapshots` runs after every successful commit and keeps:

- the **active** snapshot, which every search reads; and
- the **most recent completed snapshot behind it**, for rollback and because `commitSnapshot`
  computes inserted/updated/removed counts against it.

Everything older is deleted, **bounded**: ids are read and deleted in pages up to a ceiling, and
whatever is left is picked up by the next pass. The pass reports `complete: false` when it
yielded, and the summary is written to the state record so `GET /v1/admin/indexed-sources` shows
it without database access.

The active snapshot is excluded by **version**, not by ordering, so a clock skew or an equal
`createdAt` cannot promote it into the superseded set. Pruning failures never fail a refresh: the
snapshot is already committed and searchable, and storage growth is an operational problem where a
missing snapshot is a correctness one.

---

## 9. Retention actions

`RetentionSweeper` has existed since Phase C step C5 and, until 2026-09-21, **was called by
nothing outside its own tests** — retention actions were created on schedule and executed never.

`RetentionScheduler` now drives it, started by `worker-main.ts` beside `IndexedSourceScheduler`.
It runs on the **worker** and not the API: deletion is background work with no caller waiting on
it, and one loop per API replica over the same rows is contention for no benefit. A tick drains
until a pass comes back short, up to a ceiling, so a backlog actually shrinks rather than losing
ground a hundred at a time.

---

## 10. Adding an eleventh source

1. Write the parser under `apps/api/src/sources/indexed/parsers/`, producing
   `NormalizedSourceRecord`s. Every field is nullable **because normalising must never turn an
   absence into an invented fact**, and the publisher's own fields survive in `rawEvidence`.
2. Add the registry template with `robotsPosition: 'NOT_ESTABLISHED'` and
   `firstContactApproval: null`. Include a `refreshPolicy` — an indexed connector without one is
   refused by `sourceContentSchema`.
3. Register the schedule in `app.module.ts`. The cadence, staleness horizon and row floor are read
   from the registry template by `INDEXED_SOURCE_REFRESH_POLICIES`; do not restate them, or the
   copies drift and a refusal names a reviewed minimum while reading a number nobody reviewed.
4. Run the three acts above.

**Set the row floor from a measurement, not a guess.** `ofac-consolidated-non-sdn` shipped with a
floor of 1,000 against a list that holds 481 entries, so every correct parse was refused as
too small. A floor guards against a truncated or emptied artifact; it belongs below the real size,
not above it.
