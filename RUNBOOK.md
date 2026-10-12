# Runbook — what to start, in what order, and why

From a machine with nothing running to a Postman request that works.

`SETUP.md` is the long version and explains the reasoning. This is the short one: every command,
what it is for, how long it takes, and how you know it worked.

---

## The mental model: three layers

Start them in this order. Each one needs the one above it.

| Layer                | What it is                         | Command                | Survives a reboot?       |
| :------------------- | :--------------------------------- | :--------------------- | :----------------------- |
| **1. Containers**    | Databases and emulators in Docker  | `pnpm local:up`        | Data yes, containers no  |
| **2. Seed data**     | Tenants, keys, sources, **queues** | `pnpm local:bootstrap` | Mongo yes, **queues no** |
| **3. App processes** | The API and the worker             | `pnpm dev`             | No                       |

**The one that catches everybody is layer 2.** Mongo keeps its data across a container recreate,
so it looks like bootstrap is a one-time thing. It is not: **LocalStack loses its SQS queues every
time its container is recreated**, and without the queue the worker logs `QueueDoesNotExist` every
two seconds and every search sits at `QUEUED` for ever. Run `pnpm local:bootstrap` after every
`local:up`. It is idempotent and takes three seconds.

---

## Start, in order

### 0. Prerequisites — once per machine

```bash
corepack enable          # pnpm 10.15.0, pinned in package.json
pnpm install             # Node >=22.12 <25
```

Docker Desktop must be running. Nothing else is needed — no global CLIs.

### 1. `pnpm local:up` — the containers

**~45 seconds.** Starts seven containers and waits for each one's own healthcheck.

```bash
pnpm local:up
```

| Service            | Host port | What it is for                                                                                                                                       |
| :----------------- | :-------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| **mongo**          | 28017     | Every record. A single-node **replica set**, because the state/outbox/audit commit is one transaction and a standalone mongod cannot do transactions |
| **localstack**     | 28566     | **S3** (evidence) and **SQS** (the job queue the worker consumes). Without it a search is accepted and never runs                                    |
| **meilisearch**    | 28700     | The search index behind subjects and documents                                                                                                       |
| **keycloak**       | 28080     | OIDC for **human** sessions — the control panel. API keys do not touch it                                                                            |
| **fixture-server** | 28090     | Serves the synthetic sources. **This is what "sandbox" searches actually read.** Unreachable from a live run by design                               |
| **searxng**        | 28888     | Self-hosted metasearch, cascade rung 5                                                                                                               |
| **model-runtime**  | 28434     | Ollama, for extraction. **No model is pulled** — which model is open decision D7                                                                     |

Ports are 280xx rather than the defaults because this machine runs other stacks and a screening
service fighting an unrelated project for 27017 is a miserable thing to debug.

**Worked when:** it prints `Local stack healthy:` and lists all seven URLs.

### 2. `pnpm local:bootstrap` — seed data and queues

**~3 seconds. Run this every time, after every `local:up`.**

```bash
pnpm local:bootstrap
```

Creates the S3 bucket, **the SQS queue and its dead-letter queue**, the Meilisearch indexes, the
Keycloak-side expectations, and the seeded records: 3 tenants, 10 mock sources, the taxonomy, the
policies. Every write is an upsert, so re-running is safe and changes nothing that already exists.

**Worked when:** it prints `═══ bootstrap complete ═══` and names the bucket and both queues.

### 3. `pnpm dev` — the API and the worker

**~15 seconds** (it builds first).

```bash
pnpm dev                 # both processes, mock mode — what you usually want
```

| Command           | Runs                   | Use it when                                                            |
| :---------------- | :--------------------- | :--------------------------------------------------------------------- |
| `pnpm dev`        | API + worker, **mock** | Normal development, and everything in Postman except folders 14 and 15 |
| `pnpm dev:live`   | API + worker, **live** | **Required for folders 14 and 15.** Read the banner it prints          |
| `pnpm dev:api`    | API only               | Debugging the HTTP layer                                               |
| `pnpm dev:worker` | Worker only            | Debugging job handling                                                 |

**Both processes are required for a search to finish**, and this is the single most common
confusion in this project:

- **The API** accepts `POST /v1/searches`, writes the run and an outbox row, and returns `202`. It
  is a receipt, not an answer.
- **The worker** is a separate process (decision D-016) that consumes the queue and runs the
  pipeline.

With no worker, a search stays `QUEUED` for ever. With a **stale** worker — one started before a
rebuild — the run completes in about 130ms as `FAILED`, which reads exactly like a provisioning
bug and is not one. If you have rebuilt, restart both.

**Worked when:** the log says `API listening on 3000 (development, mode=mock)` **and**
`Worker started. Draining on SIGTERM.`

### 4. Check it before you open Postman

```bash
curl http://127.0.0.1:3000/health/ready      # expect 200
```

The route is `/health/ready`, not `/v1/health`. Postman folder **0 — Health** does the same three
checks.

---

## Now Postman

Import **one collection** and **one environment**:

| Import                | File                                                       |
| :-------------------- | :--------------------------------------------------------- |
| Collection            | `postman/adverse-search-service-full.postman_collection.json` |
| Environment (sandbox) | `postman/sandbox.ready.postman_environment.json`           |
| Environment (live)    | `postman/live.ready.postman_environment.json`              |

Do **not** import `adverse-search-service.postman_collection.json` — it is a short demo subset with
no signup flow, no admin and no live folder.

**Re-import after pulling.** The collection and the environments are separate imports and Postman
does not refresh either one on its own, so a stale environment is the commonest cause of a folder
that used to work failing on a variable. Both changed on 2026-09-18 (folder 15, `registryKey`,
`mixedCompanyNumber`).

Then run **folder 13 — Tenant E2E** with **Run folder**. It is the best single proof that
everything above is working: signup → verify → sign in → both keys → subject → search → findings,
31 requests, 28 assertions, all on the tenant's own key.

Details, the four API keys and why no single one runs the whole collection:
[`postman/README.md`](./postman/README.md).

---

## Live mode — the extra steps

Live mode contacts real publishers under our user agent, against a free tier of **120 requests an
hour for the whole service**. Everything below is deliberate.

```bash
pnpm sec:live-smoke                        # says what it would do, sends nothing
pnpm sec:live-smoke --yes-contact-the-sec  # ONE request, counted, fully reported
```

Do this **before** any longer live run. It prints the response, the leads it normalised, the
request count and source health before and after — a far cheaper place to find a problem than an
eleven-step flow. It also prints the names currently in the SEC feed, which is what you need next:
the feed is a `FIXED_FEED`, so the name you search **never reaches the SEC**; the whole list is
polled and matched locally.

```bash
pnpm source:health sec-litigation-releases                          # breaker, budgets, last success
pnpm source:health sec-litigation-releases --reset --reason "why"   # clear OUR record, locally
```

The reset clears the recorded breaker, failure counts and budget windows. It does **not** weaken
the breaker — the next failure opens it again on the same terms — and it **resets nothing at
sec.gov**. A closed breaker is our willingness to try, not their permission.

Then, with `pnpm dev:live` running, either Postman folder **14** (set `liveConfirm` to
`yes-contact-the-sec`) or:

```bash
SEC_LIVE_E2E=yes-contact-the-sec pnpm test:live
```

**A live SEC search costs three or four requests**: one poll of the feed, one `robots.txt` on a
cold process, one document fetch per candidate.

### Folder 15 — the mixed live test, across two publishers

Since 2026-09-18 there are **three** live sources across **two** publishers. Folder 15 exercises
all three at once and is the only thing that contacts GDELT.

| Source                    | Ver | Endpoint kind | Rung | Publisher              |
| :------------------------ | :-- | :------------ | :--- | :--------------------- |
| `sec-litigation-releases` | v5  | `FIXED_FEED`  | 1    | `www.sec.gov`          |
| `sec-press-releases`      | v1  | `FIXED_FEED`  | 1    | `www.sec.gov`          |
| `gdelt-doc-v2`            | v1  | `QUERY_FEED`  | 3    | `api.gdeltproject.org` |

Arm it in the **live** environment — note these are **not** folder 14's variables, deliberately:

```
mixedLiveConfirm   = yes-contact-sec-and-gdelt
mixedSubjectName   = <a benign subject>
mixedCompanyName   = <a company for F2 to anchor on>
mixedCompanyNumber = <its registration number>      # required; the schema rejects null
registryKey        = <a source_admin key>           # 15.6/15.7 read the source registry
operatorKey        = <a platform_operator key>      # 15.8 reads source health
```

**`registryKey` must be `source_admin`.** A `tenant_admin`/`analyst` key is authenticated but not
permitted to read source versions; it answers `403` and the folder reports "a required source is
not ACTIVE", which sends you to the registry instead of to the credential.

Check the three sources **and both domains** first. These are two different records and a
clean source reading does not imply a clean domain one:

```bash
pnpm source:health sec-litigation-releases
pnpm source:health sec-press-releases
pnpm source:health gdelt-doc-v2
pnpm source:health sec.gov --domain
pnpm source:health gdeltproject.org --domain
```

`sourceHealth` is keyed on the source id and carries that feed's budgets and kill switch.
`domainHealth` is keyed on the registrable domain and is what two feeds on one host share. A
source can read **entirely healthy and still be refused before a socket opens**, because the
domain breaker is checked separately — which is exactly what happened to `gdeltproject.org` on
2026-09-18.

> **Defect, open:** `decideDomainAccess` refuses while `breaker === 'OPEN'` and nothing in the
> read path moves an open breaker to `HALF_OPEN`. Once opened it stays open: no request is
> permitted, so none can succeed, so nothing closes it — and the refusal still says "requests are
> held until the cooldown elapses" after the cooldown has elapsed. Until a half-open probe is
> added on the read path, the way source health already does it, the only way back is:
>
> ```bash
> pnpm source:health <domain> --domain --reset --reason "why"
> ```
>
> It refuses a domain a person deliberately suspended — that one is released through the admin
> API by a named operator — and it changes nothing at the publisher.

```bash
pnpm dlx newman@6 run postman/adverse-search-service-full.postman_collection.json \
  -e postman/live.ready.postman_environment.json \
  --folder "15 - Mixed Live E2E: SEC + GDELT" \
  --timeout-request 180000 --timeout-script 900000 --timeout 1800000
```

**It is slow on purpose.** GDELT publishes a ceiling of one request every five seconds and the
service honours it (`RequestPacer`, driven from `accessPolicy.requestCeilingPerSecond` on the
approved version). A run that reaches GDELT's 24-request hourly budget spends about two minutes in
discovery alone, which is why folder 15 polls up to 400 times and why `JOB_LEASE_MS` /
`JOB_MAX_EXECUTION_MS` are raised in `.env`. **A run that finishes in seconds did not reach
GDELT** — read `liveDiscovery` in the findings response before believing it did.

**`PARTIAL` / `INCOMPLETE` is a pass.** Every assertion in 15.12 reads request counts and
provenance; none reads a finding. `NO_MATCHES_FOUND` is a perfectly good outcome.

**If GDELT returns 429** it halts the source, not just the request: the kill switch engages and a
600-second **domain** cooldown starts. Releasing needs a named person who has first established
_why_ the publisher refused; the domain cooldown is separate and is waited out, not cleared.
`docs/sources/mixed-live-go-live.md` section F has the commands.

> **Known, as of 2026-09-18:** `api.gdeltproject.org` is rate-limiting this egress address more
> strictly than the ceiling it publishes — measured from cold, one request succeeded and the next,
> 25 seconds later, was refused. Expect GDELT to contribute one request and then halt. Both SEC
> feeds work normally.

---

## Indexed sources — the ones read on a schedule, not per search

Ten sources are read the other way round: downloaded whole on their own cadence into a local
snapshot, then searched in our own database. A search costs them **no publisher request**. They
are OFAC SDN and consolidated non-SDN, the UK Sanctions List, the UNSC and EU consolidated lists,
the World Bank debarred-firms list, and the DOJ, CFTC, FTC and FCA feeds.

**Nine of the ten are ACTIVE and hold real snapshots** — 33,544 records as of 2026-09-21.
`world-bank-debarred` is APPROVED and deliberately not active: its gateway needs
`WORLD_BANK_SANCTIONS_API_KEY`, which this deployment does not hold.

On a **clean** deployment none of them is in the registry, because no bootstrap seeds a real
source — seeding one ACTIVE would be seeding around the approval lifecycle. Three commands put
them there, and they are documented in full in
[`docs/sources/indexed-source-onboarding.md`](./docs/sources/indexed-source-onboarding.md):

```bash
pnpm indexed:first-contact --yes-contact-publishers          # evidence: robots, terms, endpoint
pnpm key:issue --tenant tenant-alpha --role source_admin --label proposer
pnpm key:issue --tenant tenant-alpha --role source_admin --label approver
SOURCE_PROPOSER_KEY=... SOURCE_APPROVER_KEY=... pnpm source:onboard --apply
```

`source:onboard` is a client of the public Admin API — it writes nothing to Mongo and does nothing
a person with those two credentials could not do by hand. It refuses to run if the two keys are the
same principal, or if `DISABLE_SOURCE_FOUR_EYES_FOR_TESTING` is set. Re-running it is safe: it
compares content, so an identical ACTIVE version is left alone and a changed reviewed value
produces a new version through the same four steps.

### Filling a snapshot

```bash
curl -X POST http://127.0.0.1:3000/v1/admin/indexed-sources/ofac-sdn/refresh   -H "Authorization: ApiKey $APPROVER_KEY"   -H "X-Allow-Publisher-Contact: true"   -H "Content-Type: application/json" -d '{"force": true}'
```

Both the `source:approve` permission **and** the header are required. The header is not
authentication; it exists so a publisher is never contacted by a request somebody sent to see what
it returned.

`HARD_BLOCK: the hourly free-tier budget of N call(s) is spent` is not a publisher refusing us — it
is our own self-imposed cap, and a refresh costs two to three requests (robots, the artifact, and
for some publishers the artifact again at a redirect). `pnpm source:health <sourceId> --reset
--reason "..."` clears the local record without weakening the breaker.

### Snapshot growth is bounded

The active snapshot and one previous are kept; everything older is deleted in a bounded pass after
each successful refresh. `lastPrune` on the operator view below shows what the last pass did. There
is no unbounded delete anywhere in the request path.

### Retention actions actually run

`RetentionScheduler` is started by the **worker** (`worker-main.ts`), not the API, and drives
`RetentionSweeper` every five minutes. Before 2026-09-21 the sweeper had no caller at all and
retention actions were scheduled and never executed.

### What an operator looks at

```bash
# usable? fresh? how many rows? what failed last time?
curl -s -H "Authorization: ApiKey $OPERATOR_KEY" \
  http://127.0.0.1:3000/v1/admin/indexed-sources | jq '.sources[] |
  {sourceId, snapshotUsable, freshness, refreshStatus, rowCount, failureReason}'
```

Read `snapshotUsable` first. `false` means that source has never produced a snapshot, so a search
reports it as a **coverage gap** — never as a source that looked and found nothing. `freshness` is
about the snapshot's age against its reviewed staleness threshold and is independent of whether
the last refresh attempt succeeded; either being bad turns the source's search outcome `PARTIAL`
rather than hiding it.

### Forcing one refresh

```bash
curl -s -X POST \
  -H "Authorization: ApiKey $APPROVER_KEY" \
  -H "X-Allow-Publisher-Contact: true" \
  -H "Content-Type: application/json" \
  -d '{"force": true}' \
  http://127.0.0.1:3000/v1/admin/indexed-sources/ofac-sdn/refresh
```

The header is **not** authentication — the key already carries `source:approve`. It is there so a
publisher's whole dataset is never downloaded by a request somebody sent to see what it returned.
Without it: `400 VALIDATION_FAILED`.

Five answers, all honest: `SUCCEEDED`, `NOT_MODIFIED` (a 304, or identical bytes),
`SKIPPED_NOT_DUE`, `SKIPPED_IN_FLIGHT`, `FAILED`. **`FAILED` is the expected answer today**, with
a reason naming the control that refused.

A failed refresh **never** empties or replaces a usable snapshot. A bad content type, a row count
below the reviewed minimum, or duplicate record ids all fail the refresh and leave the
last-known-good snapshot answering searches. Being visibly stale beats being invisibly empty.

The scheduler checks what is due every five minutes and refreshes sources **sequentially**, so a
tick cannot become a burst at a publisher hosting several of our sources. The cadence itself is
approved registry data, not a constant in the scheduler.

`WORLD_BANK_SANCTIONS_API_KEY` in `.env` is needed only by `world-bank-debarred`. Blank leaves
that source configured and mechanically unable to call the API — a safe state, and the refresh
says so rather than failing obscurely.

Postman folder **16** does all of the above with assertions attached.

---

## Stopping

```bash
# 1. The app processes — Ctrl+C in the pnpm dev terminal, or:
#    (Windows PowerShell)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dev\.mjs|main\.js|worker-main' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 2. The containers — keeps all data
pnpm local:down

# 3. Only if you want a genuinely empty database — deletes the volumes
pnpm local:reset
```

`local:down` keeps your volumes, so Mongo data survives. **`local:reset` does not** — it asks for
an explicit typed confirmation because it throws away every tenant, key and search.

`local:down` only touches this project's containers. Anything else on your machine is left alone.

---

## When something does not work

| Symptom                                               | Cause                                                                 | Fix                                                                                                   |
| :---------------------------------------------------- | :-------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| Search stays `QUEUED` for ever                        | No worker, **or** no SQS queue                                        | `pnpm dev` runs both. If the worker logs `QueueDoesNotExist`, run `pnpm local:bootstrap`              |
| Worker logs `Poll failed; continuing` every 2s        | LocalStack was recreated and the queue is gone                        | `pnpm local:bootstrap`                                                                                |
| Search completes in ~130ms as `FAILED`                | Stale worker, started before a rebuild                                | Restart `pnpm dev`                                                                                    |
| `429` on signup                                       | Signup is bounded to 5 per origin per hour (D-056)                    | Wait, or `mongosh "$MONGODB_URI" --eval 'db.attemptLog.deleteMany({bucket:"SIGNUP"})'`                |
| `403` on folder 12                                    | Those routes need `apikey:manage`; `{{apiKey}}` is an analyst key     | Use `{{adminKey}}`, already in the ready environments                                                 |
| `403` on folder 8                                     | Source health needs `platform:read_health`                            | Use `{{operatorKey}}`, already in the ready environments                                              |
| API refuses to start, "not safe for this environment" | You ran `node apps/api/dist/main.js` directly; nothing loaded `.env`  | Use `pnpm dev`. The refusal is correct — a service that starts without a session secret generates one |
| Port 3000 already in use                              | An old API process survived                                           | Kill it (see **Stopping**)                                                                            |
| Live search rejected at stage `FETCH`                 | Budget spent, or the breaker is open                                  | `pnpm source:health sec-litigation-releases`                                                          |
| Everything returns `NO_MATCHES_FOUND` in sandbox      | `FIXTURE_SERVER_URL` is unset, so the mock adapters read from nowhere | It is in `.env`; use `pnpm dev`, which loads it                                                       |

---

## Things you do **not** need to do

- **Pull an Ollama model.** None is pulled on purpose — which model is open decision **D7**.
  Extraction is rule-based today and every run says so in its warnings.
- **Configure email.** The local stack writes to an `outboundEmails` collection, and
  `GET /v1/dev/outbound-emails/latest` reads the verification token over HTTP. That route does not
  exist in production — it is absent from the module, not hidden behind a flag.
- **Create a tenant by hand.** `POST /v1/signup` does it, in one transaction, with a generated
  tenant id the request body cannot name.
- **Run `pnpm first-contact`.** It has already been run: 2026-09-16, recorded in
  [`docs/sources/first-live-contact.md`](./docs/sources/first-live-contact.md).

---

## The whole thing, copy-pasteable

```bash
pnpm install                 # once
pnpm local:up                # ~45s   containers
pnpm local:bootstrap         # ~3s    seed data AND queues — every time
pnpm dev                     # ~15s   API + worker, mock mode
curl http://127.0.0.1:3000/health/ready
# → Postman: import the full collection + sandbox.ready environment, run folder 13
```

Verified end to end on 2026-09-17 from a fully stopped stack: `local:down` → `local:up` →
`local:bootstrap` → `pnpm dev` → Postman folder 13, 28 assertions, 0 failures, search terminal
after 4 polls.
