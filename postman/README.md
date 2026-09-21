# Testing the API in Postman

Five steps, about ten minutes from a clean checkout.

---

## 1. Start the stack

```bash
pnpm install
pnpm local:up          # Docker: Mongo, LocalStack, Meilisearch, Keycloak, SearXNG
pnpm local:bootstrap   # seeds tenants, sources, taxonomy, policy
```

`local:bootstrap` refuses to run against anything that is not local. That is deliberate — a
seeding script that can reach a real endpoint eventually seeds one.

## 2. Start the API and the worker

Two processes. The API accepts searches; the worker runs them. Without the worker your searches
stay `QUEUED` forever.

```bash
pnpm dev:api      # terminal 1
pnpm dev:worker   # terminal 2
```

## 3. Get your first API key

One command, once. **Every key after this one is issued from Postman**, through the API.

```bash
pnpm key:issue --role tenant_admin --label "postman, your name"
```

Ask for `tenant_admin`: it carries `apikey:manage`, which is what lets you issue the rest
yourself. It prints the secret **once** — only a hash is stored, and there is no recovery path,
because a credential the provider can read back is one the provider can leak.

**Why this one is a command.** A key is what authenticates you, so a tenant holding none cannot
call an endpoint to ask for one. That is the only thing the script is for. In production the
provider runs it once, when a customer is onboarded.

### From here on, use folder 12

**`12 — Tenant: your own API keys`** (decision **D-050**) replaces the script:

| Instead of                      | Send                                 |
| :------------------------------ | :----------------------------------- |
| `pnpm key:issue --role analyst` | `POST /v1/tenant/api-keys`           |
| `pnpm key:issue --list`         | `GET /v1/tenant/api-keys`            |
| `pnpm key:issue --revoke <id>`  | `DELETE /v1/tenant/api-keys/{keyId}` |

This is the path your customers use, so it is the one worth knowing. It also does two things the
script cannot: set an expiry, and show you which keys have never been used and are therefore safe
to revoke.

You can only grant roles you already hold, and a `live` key additionally needs your tenant to be
entitled to live. Both refusals have a request in folder 12 — worth running once.

**Scopes are derived from the roles** either way. Scopes narrow a machine key _below_ its roles
and never widen it, so a key with no scopes is refused on every scope-gated route: `POST
/v1/searches` needs `search:write`, the admin routes need `admin:read` / `admin:write`. Send an
explicit `scopes` list only when you want a key that can do **less** than its roles allow.

## 4. Import into Postman

### Import exactly two files

**One collection:**

| File                                                   | What it is                                                                                                                           |
| :----------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------- |
| **`erly-adverse-search-full.postman_collection.json`** | **Import this one.** 80 requests, 15 folders, sandbox **and** live. It is the only collection kept up to date                        |
| `erly-adverse-search.postman_collection.json`          | A short happy-path subset kept for demos. It has no signup flow, no live folder and no admin. Do not use it to test sandbox and live |

**One environment** — these are mutually exclusive, so import the one you want and select it:

| File                                         | Select it when                                                                            | `apiKey`                       | Subject                         |
| :------------------------------------------- | :---------------------------------------------------------------------------------------- | :----------------------------- | :------------------------------ |
| **`sandbox.ready.postman_environment.json`** | **Testing sandbox.** Start here                                                           | seeded `tenant-alpha`, sandbox | María Fernanda Solís Rojas (CR) |
| **`live.ready.postman_environment.json`**    | **Testing live**, after sandbox works                                                     | seeded `tenant-live`, live     | Jon P. Kipp (US)                |
| `local.ready.postman_environment.json`       | A mixed working file. Same keys as sandbox, but `environment` is `live` — easy to confuse | —                              | —                               |
| `local.postman_environment.json`             | You are starting from scratch and want to paste your own keys                             | empty                          | —                               |

The `.ready.` files are **gitignored and hold working secrets**. They are not in the repository;
they are on the machine that ran `pnpm key:issue`.

### The keys, and why there are four

No single key runs the collection — see the role table below. Each ready environment carries all
four, already filled in:

| Variable      | Role                       | Used by                                              |
| :------------ | :------------------------- | :--------------------------------------------------- |
| `apiKey`      | `analyst`                  | Subjects, searches, results — the collection default |
| `adminKey`    | `tenant_admin` + `analyst` | Folder 12, which needs `apikey:manage`               |
| `operatorKey` | `platform_operator`        | Folder 8, source health                              |
| `approverKey` | `source_admin`             | Folder 11, the four-eyes approval                    |

If one is empty, mint it:

```bash
pnpm key:issue --tenant tenant-alpha --env sandbox --role tenant_admin --role analyst --label postman
```

### Then run, in this order

1. **Folder 0 — Health.** If this fails, nothing else will, and it will not be an auth problem.
2. **Folder 13 — Tenant E2E**, with **Run folder**. The whole customer join against fixtures:
   signup → verify → sign in → both keys → subject → search → findings. 31 requests, 28
   assertions. This is the best single proof that sandbox works.
3. **Folders 2, 3, 4** for the individual endpoints, then 8, 9, 10, 12 for admin and refusals.
4. **Folder 14 — LIVE**, only once sandbox is green and only deliberately. See the live section
   below.

**Run collection** over the whole file works, but folders needing a different key will show 403s.
That is the role separation, not a fault. Run folder by folder.

**Signup is bounded at 5 per origin per hour (D-056)**, so a sixth run of folder 13 or 14 inside
the hour returns 429 and halts. Wait, or clear the bucket on a local stack:

```bash
mongosh "$MONGODB_URI" --eval 'db.attemptLog.deleteMany({bucket:"SIGNUP"})'
```

## 4b. Who you can search for

Set **`subjectName`**, **`subjectJurisdiction`** and **`subjectLanguage`** in the environment, then
run folders 2 → 3 → 4. The subject and search bodies read all three, so testing a different person
is one variable, not an edited body.

| `subjectName`                   | Juris. | Lang.  | What it demonstrates                                                                                                                                         |
| :------------------------------ | :----- | :----- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `María Fernanda Solís Rojas`    | CR     | es     | A fraud charge — **plus** the awkward cases: one story syndicated to a second domain, a tag page that is not a document, an item with no snippet and no date |
| `Rodrigo Alberto Vargas Méndez` | CR     | es     | An investigation **and then an acquittal**. Both come back; read the stage                                                                                   |
| `Ana Lucía Jiménez Castro`      | CR     | es     | A money-laundering conviction, two independent publishers in different words                                                                                 |
| `Carlos Eduardo Rojas Mora`     | CR     | es     | One early-stage bribery investigation, one publisher, nothing else                                                                                           |
| `James Whitfield Turner`        | **US** | **en** | An English-language indictment                                                                                                                               |
| `Wilberth Zamora Quesada`       | CR     | es     | `NO_MATCHES_FOUND`, with a `noMatchStatement` saying what was searched                                                                                       |

**The acquittal is the one worth looking at.** Vargas returns two findings, and the second is
`ACQUITTAL_DISMISSAL_OVERTURNED`. A screening tool that surfaced only the investigation would be
telling you he is under suspicion when a court has said otherwise. Read `proceduralStage` on every
finding — the band alone does not carry it.

**These are invented people.** Every name, publisher and case in the fixture corpus is fabricated
and every domain is an `example` host that resolves nowhere. Do not put a real person's name into
the corpus: a fixture is an allegation stored with a test fixture's care.

**Any other name returns `NO_MATCHES_FOUND`** — correctly. The fixture corpus answers to these six
and nothing else, so an unrecognised name is a genuine, well-formed empty result rather than an
error. That is worth seeing once, which is what the last row is for.

Jurisdiction and language are not free-form. A lead survives the fetch gate only where the
**source's countries** and the **taxonomy's enabled countries** overlap; the seeded stack overlaps
on `CR` and `US`. Ask for somewhere else and you get `SOURCE_DOES_NOT_COVER_JURISDICTION` or
`JURISDICTION_NOT_ENABLED` — both are the gates working, not missing fixtures.

---

## 5. Run the folders in order

| Folder           | What it does                                                                             |
| :--------------- | :--------------------------------------------------------------------------------------- |
| **0 — Health**   | Confirms the API is up before you debug an auth problem that is really a stopped process |
| **1 — Subject**  | Creates the person being screened. Saves `subjectId` automatically                       |
| **2 — Search**   | Starts a run, then polls until it finishes. Saves `searchId` automatically               |
| **3 — Results**  | Findings, coverage and the association graph                                             |
| **4 — Admin**    | Source health, coverage, kill switch. See the role table below — not one key             |
| **5 — Refusals** | The API saying no, correctly. Worth running once                                         |

The full collection adds folders for auth, the taxonomy and policy lifecycles, capability
coverage, the reserved 501 endpoints, and — in **5 — Admin: source registry** — the SEC source
proposal, submit, approve and activate requests, with the body already filled in from
`apps/api/src/sources/registry/sec-litigation-releases.ts`. That is the first two steps of taking
a source live, ready to send.

Folder **11 — Source go-live (four eyes)** is the approve → activate path for **any one** source
version, once the robots/access position for that source's own path has been established and
recorded on it. It is driven by `{{recordId}}`, `{{recordVersion}}` and `{{recordRevision}}` — the
same three variables folder 5 uses — so it serves `sec-press-releases` and `gdelt-doc-v2` as well
as the SEC litigation feed, which is what it still defaults to. Read
[`SEC-GO-LIVE.md`](./SEC-GO-LIVE.md) before running it: it uses a separate `approverKey`, refuses
placeholder approver names, refuses a placeholder `approvalEvidenceNote`, and bails if the source
is already active.

Folder **13 — Tenant E2E: signup to adverse search** is the whole customer join against the
fixture server: signup → verification token → verify → sign in → **sandbox and live keys** →
subject → search → poll → findings, with every call from the subject onward on the tenant's own
key. Runnable with **Run folder**; 31 requests, 28 assertions.

Folder **14 — Tenant E2E: LIVE, a real SEC-backed search** is the same join with a real publisher
at the end of it. **It contacts the SEC.** It will not run by accident: request 14.0 halts the
folder unless the environment variable `liveConfirm` is exactly `yes-contact-the-sec`, and 14.6
halts it again if the source's breaker is open. Read
[the live section below](#testing-against-real-sources-live-mode--read-before-you-try) first, and
run `pnpm sec:live-smoke --yes-contact-the-sec` before it — one request, counted, with everything
about it printed.

Folder **16 — Admin: indexed sources (local snapshots)** covers the **second way a source can be
read**. Folders 14 and 15 search publishers at query time, one request per planned query. An
*indexed* source is downloaded whole on a schedule, parsed into a local snapshot and searched in
our own database, so a search costs it no publisher request at all. Ten are proposed in code —
OFAC SDN and non-SDN, the UK Sanctions List, the UNSC and EU consolidated lists, the World Bank
debarred-firms list, and the DOJ, CFTC, FTC and FCA feeds — and **none of them is in the
registry**: every one ships with no first-contact approval and no established robots position, so
nothing in the folder can reach a publisher until somebody walks that source through folder 11.

**Folder 16 is the primary acceptance test for the locally indexed adverse-search engine.** It is
seventeen requests and 136 assertions, and it proves, in order: health and readiness;
authentication; that all ten indexed sources exist in the registry with real governance and reached
the state their evidence supports; refresh status, snapshot usability and row counts; a controlled
publisher refresh **only when explicitly armed**; a real tenant created through public signup; a
real subject; a LIVE adverse search polled to terminal; findings carrying full local-index
provenance; coverage semantics that distinguish searched, stale, absent and failed; no fixture
source ids; and finally that the tenant search itself caused **zero publisher downloads**.

Everything except 16.6 contacts nobody. That is the claim under test: an indexed source is
downloaded on a schedule and searched locally, so a customer's search costs it no publisher
request at all. 16.5 halts before 16.6 unless `indexedRefreshConfirm` is exactly
`yes-contact-the-publisher`, because 16.6 downloads a publisher's entire dataset — tens of
megabytes for OFAC SDN. Leave it unset and the rest of the folder still runs.

```bash
pnpm dlx newman@6 run postman/erly-adverse-search-full.postman_collection.json   -e postman/local.postman_environment.json   --folder "16 - Global Indexed Sources E2E"   --env-var "baseUrl=http://127.0.0.1:3000"   --env-var "operatorKey=$OPERATOR_KEY"   --env-var "approverKey=$APPROVER_KEY"   --env-var "apiKey=$ANALYST_KEY"
```

It needs a populated stack. If 16.4 reports no usable snapshots, the sources have not been
onboarded yet — see
[`../docs/sources/indexed-source-onboarding.md`](../docs/sources/indexed-source-onboarding.md),
which is three commands.

Read `snapshotUsable` in 16.4 before anything else. `false` means that source has never produced a
snapshot, so a search reports it as a **coverage gap**, not as a source that looked and found
nothing.

`ixSubjectName` and `ixSubjectDob` choose who 16.12 screens. Point them at someone actually on one
of the indexed lists and the run demonstrates a real `SUPPORTED` finding with full provenance;
point them at anyone else and it demonstrates that `NO_MATCHES_FOUND` is reported honestly against
a snapshot that was really searched. Both are valid runs.

**Folder 15 is live discovery and is a different thing.** Do not add indexed-source assertions to
it.

### No single key runs the whole collection, by design

The folders need **different roles**, and that separation is a security property rather than an
inconvenience: T06 exists so that somebody who can see breaker and budget state cannot thereby
read a customer's findings.

| Folder                              | Role needed         | Permission                          |
| :---------------------------------- | :------------------ | :---------------------------------- |
| Subjects, Searches, Results         | `analyst`           | `search:create`                     |
| Admin: source registry, kill switch | `source_admin`      | `source:propose` / `source:approve` |
| Admin: source health                | `platform_operator` | `platform:read_health`              |

`source_admin` is **refused** on `GET /v1/admin/source-health` — it is not an oversight, and a
key with every role is not the answer for anything but a smoke test.

So **Run collection** over the whole file will show refusals in whichever folders your key does
not cover. Either run folder by folder with the matching key, or accept those 403s and read them
as the role separation working. For a one-off smoke test of everything at once:

```bash
pnpm key:issue --role analyst --role source_admin --role platform_operator --label "smoke test"
```

Do not keep that key. It is a credential that can start work, change the source registry and read
platform health at once, which is exactly the combination the roles exist to prevent.

---

## What you are actually looking at

The service runs in **mock mode**. Every source is a fixture, every record is stamped
`mode: "MOCK"`, and nothing leaves your machine. The _shape_ of every response is real; the
content is test data.

### The one thing not to misread

Three independent fields come back and they must be read together:

| Field           | Answers                                    |
| :-------------- | :----------------------------------------- |
| `execution`     | Did the job finish?                        |
| `findingsState` | Did we find anything?                      |
| `coverage`      | Did we search everything we said we would? |

`SUCCEEDED` + `NO_MATCHES_FOUND` + `INCOMPLETE` means: the run finished, found nothing, **and did
not search everything it promised**. That is not a clean result, and the collection's test script
prints a warning when it sees that combination.

When `findings` is empty, `noMatchStatement` says in words what was searched and what the absence
does and does not mean. It never contains the words "clear", "clean" or "no adverse media", and
nothing downstream should add them.

### A band is not a score

`band` is one of `CORROBORATED`, `SUPPORTED`, `AMBIGUOUS`, `COMPANY_CONTEXT`, `CONTRADICTED`,
`LEAD_ONLY`. There is no numeric risk score anywhere in the API, by design. Do not rank, average,
threshold or colour-scale bands into a number — that is how "two weak leads" becomes "one medium
risk".

Every band arrives with `axes` (the four values that produced it) and `rationale` (every rule that
fired, in order). A band on its own cannot be reviewed, only believed.

---

## When something does not work

| Symptom                                       | Cause                                                                                                               |
| :-------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| 401 on everything                             | `apiKey` is empty or the key was revoked                                                                            |
| 403 on admin requests                         | Wrong role for that folder — see the role table above                                                               |
| 403 on `/admin/source-health`                 | Needs `platform_operator`, **not** `source_admin`                                                                   |
| 403 releasing a kill switch                   | Four eyes. The releaser must be a different key from the engager                                                    |
| Search stays `QUEUED`                         | The worker is not running. `pnpm dev:worker`                                                                        |
| Integration tests fail while `pnpm dev` is up | Both workers consume the **same** SQS queue and steal each other's jobs. Stop `pnpm dev` before `pnpm verify:local` |
| 503 on `/health/ready`                        | Stack not bootstrapped. `pnpm local:up && pnpm local:bootstrap`                                                     |
| 501 on a reserved path                        | Deliberate. See D-007                                                                                               |
| `MISSING_SCOPE` in the log                    | The key was issued with narrower `--scope` than the route needs                                                     |
| Accented name finds nothing                   | The request body was not sent as UTF-8 — see the note below                                                         |
| Connection refused                            | API not started. `pnpm dev:api`                                                                                     |

### Accented names and encoding

The seeded fixtures respond to **María Fernanda Solís Rojas**. Postman sends UTF-8 correctly, so
the collection works as shipped.

If you reproduce a request with `curl` from a Windows shell, the accents can be mangled in
transit — `María` arrives as `Mar?a`, folds to `mar a`, and matches no fixture. The search then
returns `NO_MATCHES_FOUND`, which looks like a bug in matching and is really an encoding problem
one layer up. Send the body from a file with `--data-binary @body.json` if you need to.

That is worth knowing beyond the fixtures: a name that loses its accents in transit is a name the
service will honestly report as not found.

---

## Testing against real sources (live mode) — read before you try

Live mode is `pnpm dev:live`. It refuses to start without `FETCH_CONTACT_URL` and prints what
changes.

**As of 2026-09-16 nothing in the code blocks a live end-to-end search.** The two engineering
blockers that used to live in this section — live mode having no extractor, and the pipeline
handing raw HTML to it — are both closed (**D-048**, **D-049**). What is left is operational, and
it is listed under "the order of operations" below.

### What a live run will and will not tell you

**The extractor is rule-based, and its recall has never been measured.** Live extraction is
`rule-based-extraction.adapter.ts`: term tables, proximity-bounded to within 600 characters of one
of the subject's name forms, with `modelId: null` and `promptVersion: null` on every assertion it
emits. Choosing and benchmarking a real model is open decision **D7**.

Three consequences, and the API says all three out loud rather than leaving you to infer them:

- **Every run using it carries a warning** that the extraction was rule-based and unbenchmarked,
  and that a category it has no term for returns nothing rather than failing.
- **Its term tables are English and Spanish only.** A document in any other language yields no
  assertions, and that reads as "nothing found" when it means "not read".
- **Every finding it produces is undated.** The four FR-07 date fields are not parsed yet and are
  left null, which is correct under FR-07 — a missing date is never backfilled with retrieval
  time — but it means you cannot test recency behaviour against a live result today.

**A document it cannot decode is reported as unreadable, not as empty.** PDF and OCR are not built
(the rest of Phase F step F1).

**A `SKIPPED` outcome named `capability:extraction` or `capability:fetch` is a misconfiguration,
not a result.** A rejected lead now records the stage where it actually stopped, and extraction
`FAILED` is distinct from "read it and it said nothing".

### Two things that are not bugs, and will look like bugs

**1. The SEC feed is not searchable by name.** The record is `endpointKind: "FIXED_FEED"` with
`queryParam: null` — it is the litigation-releases list, not a search endpoint. The name you type
**never reaches the SEC**: the feed is polled whole and matched locally. Search a Costa Rican name
against it and you get a correct, well-reasoned `NO_MATCHES_FOUND`.

**For a first live demo that actually shows a finding, take a defendant's name from the SEC
litigation-releases feed as it stands that day.**

If you want a name search that genuinely reaches a publisher, that needs a `QUERY_FEED` — cascade
rung 2 or 4 (Google/Bing News RSS). Per D-046 that needs **no code**, only a verified endpoint and
a named first-contact approval.

**2. Coverage will say `INCOMPLETE`, and should.** One live source, US and English only, every
fixture source refused in live mode, most rungs unsearched. That is the system being truthful, not
broken. A live stack that reported `COMPLETE` here would be the thing to worry about.

### The order of operations

**Steps 1 to 3 have already been done on this database** — 2026-09-16, recorded in
[`../docs/sources/first-live-contact.md`](../docs/sources/first-live-contact.md). They are kept
here because they are what a fresh database needs, and because step 1 is not a thing a developer
does on the way to a demo.

1. `pnpm first-contact` — one `GET https://www.sec.gov/robots.txt`. Requires
   `--yes-contact-the-sec`. **This was the first deliberate live request this project ever made,
   and the project owner ran it**, at 2026-09-16T10:56:04Z. It wrote
   `docs/sources/sec-robots-evidence.json` as D6 evidence: HTTP 200, verdict **ALLOWED**.
2. Update `robotsPosition` on the source record to reflect **what robots.txt actually said** —
   not what you expected it to say. It ships as `NOT_ESTABLISHED`, which the fetch gate refuses,
   and that ordering is deliberate. How that permission is approved and recorded is open
   decision **D6**, and it is the rule governing this write.
3. Propose → approve → activate through the admin folder (folder 11). **This needs four eyes**:
   the proposer and the approver cannot be the same person, and the reason field is mandatory
   (SEC-06).
4. **`pnpm sec:live-smoke --yes-contact-the-sec`** — one poll of the feed, through the real
   connector, with the request count read from the poll cache rather than assumed. Do this before
   anything longer: it is the cheapest place to find a problem, and it prints the names currently
   in the feed, which is what step 6 needs.
5. **`pnpm source:health sec-litigation-releases`** if the smoke test reports a blocked breaker.
   `--reset --reason "why"` clears our own record; it weakens nothing and resets nothing at
   sec.gov.
6. Run folder **14** with `liveConfirm=yes-contact-the-sec` and `liveSubjectName` set to a name
   step 4 printed. Or run the whole thing headlessly:
   `SEC_LIVE_E2E=yes-contact-the-sec pnpm test:live`.

**What a live run honestly reports:** `SUCCEEDED`, coverage `INCOMPLETE`, most rungs unsearched,
one live source, US and English only, every fixture source refused, and a warning that the
extraction was rule-based and unbenchmarked. Expect that, so it does not read as a regression.

**A run can store a finding and still say `NO_MATCHES_FOUND`.** An `AMBIGUOUS` band is not a match
(FR-13). That is the banding engine being correct, not retrieval failing.

### How many requests a live search costs

One poll of the feed, one `robots.txt` on a cold process, and one document fetch per candidate —
three or four, out of a free tier of **120 an hour for the whole service**.

That is worth stating because it used to be wrong in the other direction. Until 2026-09-17 several
documents claimed a fixed feed was fetched "once per planned query, about 41 identical requests per
run". The figure was never measured and was not what the code did. The real defect was that the
publisher's own recorded **poll floor** — fifteen minutes, in the source record — was enforced
nowhere, so every search re-polled and concurrent searches each opened a socket.
`FixedFeedPollCache` now holds that floor, and `pnpm sec:live-smoke` prints the count so the claim
is checkable rather than asserted.

**What is still unbounded is per tenant.** Nothing limits how many searches one self-signed-up
tenant runs in an hour (D-052 deferred the per-tenant live budget). That is the remaining
production item, and no change to the fetch path addresses it.

## Folder 15 — Mixed Live E2E: SEC + GDELT

The folder that proves the architectural claim a list of source ids cannot: that a `FIXED_FEED`
costs one request per poll floor however large the query plan is, and a `QUERY_FEED` costs one
request per planned query bounded by its budget. It needs **three** live sources at once.

### What it verifies before it contacts anybody

| Request | Checks                                                                                                                                      |
| :------ | :------------------------------------------------------------------------------------------------------------------------------------------ |
| 15.0    | `mixedLiveConfirm` is armed, required variables set, service ready                                                                          |
| 15.6    | both SEC sources ACTIVE, `NEWS_DISCOVERY_RSS`, `FIXED_FEED`, rung 1, named first-contact approval, robots established                       |
| 15.7    | `gdelt-doc-v2` ACTIVE, `NEWS_DISCOVERY_GDELT`, `QUERY_FEED`, rung 3, **`queryParam === 'query'`**, approval, robots, hourly budget recorded |
| 15.8    | breakers CLOSED and no kill switch on either domain; "no health record" is read as never-called, not as a refusal                           |
| 15.12   | mode LIVE, no fixture source id anywhere, per-source request counts, distinct endpoints, budget, families, hosts                            |

**Nothing in the folder activates a source.** 15.6 and 15.7 halt the run if one is not ACTIVE. A
test that activated a source to make itself pass would be the thing meant to be checking the
lifecycle bypassing it.

### Arming it

```
mixedLiveConfirm   = yes-contact-sec-and-gdelt
mixedSubjectName   = <a benign subject>
mixedCompanyName   = <a company for F2 to anchor on>
mixedCompanyNumber = <its registration number>
registryKey        = <a source_admin key>   # 15.6/15.7 read the source registry
operatorKey        = <a platform_operator key>
```

`mixedLiveConfirm` is a **different variable from folder 14's `liveConfirm`**, deliberately:
arming a folder that contacts a publisher we have a relationship with must not arm one that
contacts a publisher we do not. Clear it again afterwards.

**`registryKey` must be a `source_admin` credential.** 15.6 and 15.7 read the source registry, which
a `tenant_admin`/`analyst` key is authenticated for and not permitted to do — it answers `403` and the folder halts with "a required source is not ACTIVE", which is misleading. This caught us on
2026-09-18.

**`mixedCompanyNumber` is required, not optional.** `companyIdentifierSchema` is `.strict()` and
`registrationNumber` is a non-empty string; the folder used to send `null` and got a `400`.

### It is slow, on purpose

GDELT publishes a ceiling of one request every five seconds and the service now honours it, so a
run that reaches GDELT's 24-request hourly budget spends about two minutes in discovery alone.
Folder 15 polls up to **400** times, and `JOB_LEASE_MS` / `JOB_MAX_EXECUTION_MS` in `.env` were
raised to match. A run that finishes in seconds did **not** reach GDELT — read `liveDiscovery` and
the source outcomes before believing it did.

### `PARTIAL` / `INCOMPLETE` is a pass

Every assertion in 15.12 reads request counts and provenance. **None of them reads a finding.**
`NO_MATCHES_FOUND` is a perfectly good outcome, and so is a source that failed, provided the
coverage state says so truthfully. Do not point this folder at a private individual in order to
manufacture adverse findings.

### If GDELT halts

A 429 from GDELT engages the kill switch (`haltOnRateLimit` with `requiresFreshApprovalOnHalt`)
and starts a 600-second **domain** cooldown. Releasing needs a named person who has first
established why the publisher refused; the domain cooldown is separate and is waited out, not
cleared. `docs/sources/mixed-live-go-live.md` section F has the commands.

```bash
pnpm dlx newman@6 run postman/erly-adverse-search-full.postman_collection.json   -e postman/live.ready.postman_environment.json   --folder "15 - Mixed Live E2E: SEC + GDELT"   --timeout-request 180000 --timeout-script 900000 --timeout 1500000
```

## Keeping the collection honest

The OpenAPI document is generated from the contract schemas and a test fails if it drifts:

```bash
pnpm openapi:generate
```

This collection is hand-written and **is not** generated, so it can drift. If a request here
disagrees with `openapi/openapi.json`, the OpenAPI document is right.

---

## Related reading

| File                                                               | For                                                                                  |
| :----------------------------------------------------------------- | :----------------------------------------------------------------------------------- |
| [`INTEGRATOR-GUIDE.md`](./INTEGRATOR-GUIDE.md)                     | **Integrating as a tenant** — the calls your platform makes, tested in Postman first |
| [`ADVERSE-SEARCH-WALKTHROUGH.md`](./ADVERSE-SEARCH-WALKTHROUGH.md) | Step by step: run your first search                                                  |
| [`TESTING-GUIDE.md`](./TESTING-GUIDE.md)                           | Which endpoint does what, in order                                                   |

| File                               | What is in it                                 |
| :--------------------------------- | :-------------------------------------------- |
| `docs/SIMPLE-STATUS.md`            | Where the project is, in plain words          |
| `docs/SIMPLE-FLOW.md`              | The same, as diagrams                         |
| `docs/TODO-E2E.md`                 | What is left to build                         |
| `docs/integration/zquence.md`      | The four things machine integrators get wrong |
| `examples/zquence-integration.mjs` | The same walkthrough in code                  |
