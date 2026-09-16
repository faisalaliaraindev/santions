# Setting this up on your machine, from nothing

For a developer who has never seen this project. Follow it top to bottom.

**Sandbox takes about 15 minutes.** Live takes another 10 and needs one decision from a human.

- **Sandbox** = fake data, fake sources, nothing leaves your machine. Use this for everything.
- **Live** = real HTTP requests to real publishers. Deliberate, gated, and not the default.

---

# Part 1 — What you need installed

| Tool               | Version | Check with       |
| :----------------- | :------ | :--------------- |
| **Node.js**        | 22 LTS  | `node --version` |
| **pnpm**           | 9+      | `pnpm --version` |
| **Docker Desktop** | current | `docker info`    |
| **Git**            | any     | `git --version`  |

If `pnpm` is missing: `npm install -g pnpm`

**Docker Desktop must actually be running** before you start. `docker info` failing is the single
most common reason step 3 below hangs.

Two repositories, side by side in the same parent folder:

```
sanctions/
  erly-sanction-service-backend/     <- the API and worker
  erly-sanction-service-frontend/    <- the control panel
```

---

# Part 2 — Backend, sandbox mode

## Step 1 — Install

```bash
cd erly-sanction-service-backend
pnpm install
```

## Step 2 — Create your `.env`

```bash
cp .env.example .env
```

**That is all you need to change for sandbox — nothing.** Every value in `.env.example` is a
working local default pointing at the Docker stack. There are no keys to obtain, no accounts to
create, and no external service to sign up for.

The file is git-ignored. Never commit it.

## Step 3 — Start the infrastructure

```bash
pnpm local:up
```

Starts seven containers: MongoDB (as a replica set), Meilisearch, LocalStack (S3 + SQS),
Keycloak, SearXNG, a model runtime, and a fixture web server. Wait for `Local stack healthy`.

> **Ports are in the 280xx range** (mongo 28017, keycloak 28080, meilisearch 28700…), not the
> defaults, so this does not collide with other stacks on your machine.

If it hangs, Docker Desktop is not running.

## Step 4 — Seed the database

```bash
pnpm local:bootstrap
```

Creates tenants, sources, the taxonomy, policies and fixture data. Safe to re-run — every write is
an upsert.

## Step 5 — Start the API and the worker

```bash
pnpm dev
```

Runs **both** processes. The API accepts searches; the **worker** executes them. Without the
worker a search sits at `QUEUED` forever and nothing tells you why.

Leave this running. Check it:

```bash
curl http://127.0.0.1:3000/health/ready     # expect {"status":"ok"}
```

## Step 6 — Get your first API key

**Run this command once. After that you never need it again** — every further key is issued
through the API, from Postman.

```bash
pnpm key:issue --role tenant_admin --label "your name, local dev"
```

**Ask for `tenant_admin`.** That role carries `apikey:manage`, which is what lets you issue your
own keys from then on. Start with a narrower role and you will be back at the command line for the
second one.

**The secret prints once and is never recoverable** — only a hash is stored. Copy it now.

### Why this one is a command and not a request

A key is what authenticates you. A tenant that holds no key cannot call an endpoint to ask for one,
so the very first key has to come from outside the API. That is the only thing this script is for.

In production, it is the provider who runs it, once, when a customer is onboarded.

### Everything after that is Postman

Once you hold that first key, use folder **`12 — Tenant: your own API keys`**:

| Instead of                      | Use                                  |
| :------------------------------ | :----------------------------------- |
| `pnpm key:issue --role analyst` | `POST /v1/tenant/api-keys`           |
| `pnpm key:issue --list`         | `GET /v1/tenant/api-keys`            |
| `pnpm key:issue --revoke <id>`  | `DELETE /v1/tenant/api-keys/{keyId}` |

```json
POST /v1/tenant/api-keys
{ "label": "ci pipeline", "roles": ["analyst"], "expiresInDays": 90 }
```

This is the path your customers use, so it is the one worth learning. It also does things the
script cannot: expiry dates, and a listing that shows which keys have never been used and are
therefore safe to revoke.

You can only grant roles you already hold — see Part 3b.

**No single key covers everything, on purpose.** Source health is deliberately not readable by a
`source_admin` — see `postman/TESTING-GUIDE.md`.

## Step 7 — Check it works

```bash
pnpm verify:local
```

Everything should pass **except `end-to-end (browser)`**, which is not built yet and fails on
purpose. That means the command exits non-zero even when all is well. That is intended: an
unimplemented suite is reported as unverified rather than quietly passing.

> **Stop `pnpm dev` before running this.** Your worker and the test worker consume the same queue
> and steal each other's jobs, which fails the integration suite for no visible reason.

---

# Part 3 — Testing in Postman (sandbox)

## Step 8 — Import

Import **two** files from `erly-sanction-service-backend/postman/`:

| File                                               | What                                            |
| :------------------------------------------------- | :---------------------------------------------- |
| `erly-adverse-search-full.postman_collection.json` | The requests                                    |
| `local.postman_environment.json`                   | The environment template — **no secrets in it** |

Select the environment in the top-right dropdown, then paste your key from step 6 into `apiKey`
and **save (Ctrl+S)**. Postman ignores unsaved edits.

## Step 9 — Run a search

1. `0 — Health` → `GET /health/ready`
2. `2 — Subjects` → `Create a subject`
3. `3 — Searches` → `Create a search (one call - subjectSnapshot)` → then `Poll until terminal`
4. `4 — Results` → `Findings and coverage`

Full walkthrough with expected output: **`postman/ADVERSE-SEARCH-WALKTHROUGH.md`**

## Step 10 — Try the test people

Change `subjectName` in the environment and re-run. Six names work:

| Name                              | Juris/Lang | Shows                                    |
| :-------------------------------- | :--------- | :--------------------------------------- |
| María Fernanda Solís Rojas        | CR / es    | A fraud charge                           |
| **Rodrigo Alberto Vargas Méndez** | CR / es    | **An investigation AND an acquittal**    |
| Ana Lucía Jiménez Castro          | CR / es    | A conviction, two independent publishers |
| Carlos Eduardo Rojas Mora         | CR / es    | One early-stage investigation            |
| James Whitfield Turner            | US / en    | An English-language case                 |
| Wilberth Zamora Quesada           | CR / es    | Nothing found, properly explained        |

Any other name returns "nothing found" — correctly. These are **invented people**; every domain is
an `example` host that resolves nowhere.

---

# Part 3b — Issuing your own keys, without an operator

Once you hold a key with the `apikey:manage` permission — which `tenant_admin` has — your tenant
manages its own credentials. No provider involvement, and nothing to wait for.

| Request                              | Does                                    |
| :----------------------------------- | :-------------------------------------- |
| `POST /v1/tenant/api-keys`           | Issue a key. **Secret returned once**   |
| `GET /v1/tenant/api-keys`            | List your keys. No secrets, no hashes   |
| `DELETE /v1/tenant/api-keys/{keyId}` | Revoke one. Immediate, reason mandatory |

Postman folder **`12 — Tenant: your own API keys`** drives all three, plus the two refusals worth
seeing once.

```bash
curl -X POST http://127.0.0.1:3000/v1/tenant/api-keys \
  -H "Authorization: ApiKey <your tenant_admin key>" \
  -H "Content-Type: application/json" \
  -d '{"label":"ci pipeline","roles":["analyst"],"expiresInDays":90}'
```

**Three things it will not do**, each deliberate:

- **It will not give you roles you do not already hold.** Asking for `platform_admin` from a
  `tenant_admin` key is refused, naming the role. Otherwise the weakest admin credential is a
  path to every role in the system.
- **It will not cross a tenant boundary.** The tenant comes from your credential; there is no
  field in the body to put one in. Revoking another tenant's key answers `404`, not `403` — the
  second would confirm it exists.
- **It will not sell you live access.** An `environment: "live"` key needs your tenant to be
  entitled to live **and** your own credential to be live. Entitlement is a commercial act by the
  provider; self-service issues within what was sold.

---

# Part 4 — The frontend (control panel)

```bash
cd ../erly-sanction-service-frontend
pnpm install
cp .env.example .env.local
pnpm dev
```

`.env.local` needs nothing changed — it points at `http://127.0.0.1:3000` and Vite proxies `/v1`
and `/auth` so the session cookie stays same-origin.

**The panel holds no secrets.** It authenticates through the API's backend-for-frontend session,
so machine credentials never reach the browser bundle. There is no API key to paste here.

> The FR-14 results page is **not built yet**. The panel currently has the foundation, routing and
> the typed API client only. Don't expect a working screening UI.

`pnpm api:generate` regenerates the typed client from the backend's `openapi/openapi.json`.

---

# Part 5 — Live mode (real sources)

**Stop here unless you specifically need live.** Everything above is enough to develop against.

Live mode makes real HTTP requests to real publishers under their terms. It is gated in four
independent ways, and all four must be satisfied.

## Step 11 — Set the contact URL

In `.env`:

```
FETCH_CONTACT_URL=https://your-domain/bots/adverse-search
```

**Live mode refuses to start without it.** The outbound user agent is _built from_ this URL, so
the service always identifies itself honestly with a way to be contacted. It is not a free-text
user agent you can set to something anonymous — that is the dishonest case the requirement
forbids.

## Step 12 — A tenant entitled to live

Entitlement to the live environment is granted **per tenant**, and `tenant-alpha` is sandbox-only.
`pnpm local:bootstrap` seeds `tenant-live` for this. Then:

```bash
pnpm key:issue --tenant tenant-live --env live --role tenant_admin --label "live testing"
```

This is the script again rather than the API, and for the same reason as Step 6: `tenant-live` is
a different tenant, and a new tenant holds no key it could authenticate with. Once it has this
one, it issues its own live keys through the API like any other.

A live key on a sandbox tenant is refused with `SANDBOX_CANNOT_ACCESS_LIVE`, which reads like a
broken key and is not one.

## Step 13 — A source approved for live use

A source is only reachable when **all** of these are recorded on its approved version:

| Requirement                            | Why                                                       |
| :------------------------------------- | :-------------------------------------------------------- |
| Status `ACTIVE`                        | Approved through propose → approve → activate             |
| `robotsPosition` not `NOT_ESTABLISHED` | Somebody has read the publisher's robots.txt              |
| `firstContactApproval` not null        | A **named person** accepted that we start making requests |
| Rights clearance `ALLOW`               | SEC-05 gate at activation                                 |

The SEC litigation-releases feed is the one source set up for this. Its first-contact evidence is
in `docs/sources/sec-robots-evidence.json`.

**Approval is four eyes**: the person who proposes a version cannot approve it. See
`postman/SEC-GO-LIVE.md`.

## Step 14 — Start in live mode

```bash
pnpm dev:live
```

Read the banner it prints. **Two of the differences look like breakage and are not:**

- **Every fixture source is refused.** All six demo people above return nothing, because a fixture
  must never be servable as a live result.
- **Coverage always says `INCOMPLETE`.** One live source, US and English only. That is the system
  being truthful.

> **Restart `pnpm dev` / `pnpm dev:live` after any registry change.** The ladder of sources is
> assembled at process start. Activate or suspend a source while it is running and the change is
> not picked up — searches simply start returning `FAILED` with every rung reporting "no approved
> source".

## Step 15 — Search someone who is actually there

The SEC feed is a **`FIXED_FEED`**: the name you type never reaches the SEC. The feed is polled
whole and matched locally. So search a name that is **in the feed today**:

```
https://www.sec.gov/enforcement-litigation/litigation-releases/rss
```

Take a current defendant name from it. The feed rotates — a name that worked last week will not
work today. In Postman use `postman/live.ready.postman_environment.json` (you create this; see
below), or set `environment` to `live` and `subjectJurisdiction` to `US`.

---

# Part 6 — Where the keys go

## The short answer

**For sandbox: nowhere. There are no keys to obtain.** Everything runs against local fixtures.

## The `.env` keys, and what each is for

All live in `erly-sanction-service-backend/.env`. **Blank means the capability is unavailable and
reports as a coverage gap — never as a zero result.** That distinction is deliberate: "we could not
look" must never render as "there is nothing there".

| Variable                  | Needed for                      | How to get it                                      |
| :------------------------ | :------------------------------ | :------------------------------------------------- |
| `FETCH_CONTACT_URL`       | **Any live fetching**           | A URL on your domain describing the bot            |
| `COMPANIES_HOUSE_API_KEY` | UK company/officer associations | Free: developer.company-information.service.gov.uk |
| `COURTLISTENER_API_TOKEN` | US court records                | Free: courtlistener.com                            |
| `SEC_EDGAR_USER_AGENT`    | SEC EDGAR bulk endpoints        | Just a contact string they require                 |
| `MEILI_MASTER_KEY`        | Search index                    | Local default is fine                              |
| `OIDC_CLIENT_SECRET`      | Panel login                     | Local default is fine                              |
| `SESSION_SECRET`          | Session cookies                 | Local default is fine                              |

## Google / Bing news keys — you do **not** need them

A common assumption worth correcting: **rungs 2 and 4 use Google News RSS and Bing News RSS, which
are public feeds requiring no API key at all.** There is no billing account to set up and no quota
to buy.

What they _do_ need is not a key — it is three human steps:

1. Somebody loads the endpoint and confirms it returns what is expected
2. Somebody reads that publisher's `robots.txt` and records the result
3. A **named person** records a first-contact approval

Both are already in the registry as `PROPOSED` drafts (`google-news-rss-en-us`,
`bing-news-rss-en-us`), deliberately inert, with `ENDPOINT NOT VERIFIED` written on the record
itself. Until those three steps are done the fetch gate refuses them.

## Budgets

Per-source rate limits live **on the source version record**, not in `.env`:

```
freeTierHourlyBudget: 120
freeTierDailyBudget: 500
```

Change one through the admin API (propose → approve → activate), not by editing a file. Lowering a
budget takes effect without a deployment.

> **Known issue:** a `FIXED_FEED` is currently fetched once per planned query — about 41 identical
> requests per run — so the SEC's 120/hour budget is exhausted after two or three live searches.
> When that happens the symptom is `PARTIAL` / `UNRESOLVED` with a rejected lead at stage `FETCH`.

## Never commit

| File                                       | Contains                |
| :----------------------------------------- | :---------------------- |
| `.env`                                     | All of the above        |
| `postman/*.ready.postman_environment.json` | Working API key secrets |
| `.env.local` (frontend)                    | Frontend config         |

All three are git-ignored. The committed `postman/local.postman_environment.json` is a template
with every secret left empty — keep it that way.

---

# Part 7 — When something does not work

| Symptom                                      | Cause                                                            |
| :------------------------------------------- | :--------------------------------------------------------------- |
| `pnpm local:up` hangs                        | Docker Desktop is not running                                    |
| Port already in use                          | Another stack on 280xx. `pnpm local:down` first                  |
| 503 on `/health/ready`                       | Not bootstrapped. `pnpm local:bootstrap`                         |
| Search stays `QUEUED` forever                | The worker is not running. `pnpm dev`                            |
| 401 on everything                            | No environment selected in Postman, or `apiKey` empty            |
| 403 on admin routes                          | Wrong role — see `postman/TESTING-GUIDE.md`                      |
| 403 on `/v1/admin/source-health`             | Needs `platform_operator`, **not** `source_admin`                |
| Integration tests fail while `pnpm dev` runs | Both workers eat the same queue. Stop `pnpm dev` first           |
| **Every** search returns `FAILED`            | Stale worker after a registry change — restart `pnpm dev`        |
| `SANDBOX_CANNOT_ACCESS_LIVE`                 | Sandbox key or sandbox tenant asking for live                    |
| Live search finds nothing                    | Normal — fixtures are refused live, and the feed is a fixed list |
| Accented name finds nothing                  | Body not sent as UTF-8. Postman is fine; Windows `curl` is not   |
| `verify:local` exits non-zero                | Expected — the browser e2e suite is not built                    |
| 501 on an endpoint                           | Deliberate. Decision D-007                                       |

---

# Part 8 — Where to read next

| File                                    | For                                           |
| :-------------------------------------- | :-------------------------------------------- |
| `docs/execution/START-HERE.md`          | **Read first if you are picking up the work** |
| `docs/execution/handoff-log.md`         | What the last session did, newest first       |
| `postman/ADVERSE-SEARCH-WALKTHROUGH.md` | Run your first search, step by step           |
| `postman/TESTING-GUIDE.md`              | Which endpoint does what, in order            |
| `postman/INTEGRATOR-GUIDE.md`           | Integrating as a tenant                       |
| `postman/SEC-GO-LIVE.md`                | Taking a real source live                     |
| `docs/open-decisions.md`                | D1–D18, each with an owner                    |
| `CLAUDE.md`                             | The three rules that override convenience     |

## Three things to understand before changing anything

1. **Never weaken an invariant to make a gate pass.** `pnpm test:invariants` runs I1–I10 with no
   I/O. A failure means the system can state something it has no basis to state. Fix the code.
2. **A suite that does not exist fails; it never passes vacuously.** That is why `verify:local`
   exits non-zero today.
3. **Never claim verification that did not happen.** If you did not run it, say so.

## The one idea the whole service is built around

A result has **three** independent fields and they must be read together:

| Field           | Answers                                    |
| :-------------- | :----------------------------------------- |
| `execution`     | Did the job finish?                        |
| `findingsState` | Did we find anything?                      |
| `coverage`      | Did we search everything we said we would? |

`SUCCEEDED` + `NO_MATCHES_FOUND` + `INCOMPLETE` means _finished, found nothing, and did not look
everywhere it promised_. That is **not** a clean bill of health, and any UI that renders it as one
is making a claim this service never made.
