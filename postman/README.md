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

## 3. Issue an API key

```bash
pnpm key:issue
```

It prints the secret **once**. Only a hash is stored, and there is no recovery path — a
credential the provider can read back is one the provider can leak. Copy it, or issue another.

Other roles when you need them:

```bash
pnpm key:issue --role source_admin --label "postman admin"
pnpm key:issue --list --tenant tenant-alpha
pnpm key:issue --revoke <keyId> --reason "rotated"
```

**Scopes are derived from the roles**, and the script prints them. Scopes narrow a machine key
_below_ its roles and never widen it, so a key with no scopes is refused on every scope-gated
route — `POST /v1/searches` needs `search:write`, the admin routes need `admin:read` /
`admin:write`. Pass `--scope` only when you want a key that can do less than its role allows.

> **A tenant issues its own keys** through `POST /v1/tenant/api-keys` (decision **D-050**).
> This used to return 501 under D-007; it no longer does. The script above is still how the
> _first_ key for a new tenant is issued, because a tenant with no key cannot authenticate to
> ask for one. See folder **12 — Tenant: your own API keys**.

## 4. Import into Postman

Import from this folder:

| File                                               | What it is                                                   |
| :------------------------------------------------- | :----------------------------------------------------------- |
| `erly-adverse-search-full.postman_collection.json` | **All 34 endpoints**, 48 requests, 11 folders. Start here    |
| `erly-adverse-search.postman_collection.json`      | The short version — just the happy path and the refusals     |
| `local.postman_environment.json`                   | `baseUrl`, `apiKey` and the ids the requests fill in for you |

Select the **Erly adverse-search — local** environment, then paste the secret from step 3 into
the `apiKey` variable.

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

Folder **11 — SEC go-live (four eyes)** is the live-source approval path after `pnpm first-contact`
has recorded an allowed robots result. Read [`SEC-GO-LIVE.md`](./SEC-GO-LIVE.md) before running it:
it uses a separate `approverKey`, refuses placeholder approver names, and bails if the source is
already active.

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

Steps 1 to 3 are **not** things a developer does on the way to a demo. Step 1 is the first
deliberate live request this project has ever made, and step 3 needs two different people.

1. `pnpm first-contact` — one `GET https://www.sec.gov/robots.txt`. Requires
   `--yes-contact-the-sec`. **This is the first deliberate live request this project has ever
   made, and the project owner runs it.** It writes `docs/sources/sec-robots-evidence.json` as
   D6 evidence.
2. Update `robotsPosition` on the source record to reflect **what robots.txt actually said** —
   not what you expected it to say. It ships as `NOT_ESTABLISHED`, which the fetch gate refuses,
   and that ordering is deliberate. How that permission is approved and recorded is open
   decision **D6**, and it is the rule governing this write.
3. Propose → approve → activate the source through the admin folder. **This needs four eyes**: the
   proposer and the approver cannot be the same person, and the reason field is mandatory (SEC-06).
   That means a **second named person** has to exist before this step can run at all.
4. Run a search for a subject you have confirmed is in the feed.

**What the first live run will honestly report:** `SUCCEEDED`, coverage `INCOMPLETE`, most rungs
unsearched, one live source, US and English only, every fixture source refused, and a warning that
the extraction was rule-based and unbenchmarked. Expect that, so it does not read as a regression.

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
