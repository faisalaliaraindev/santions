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

| Command           | Runs                   | Use it when                                                    |
| :---------------- | :--------------------- | :------------------------------------------------------------- |
| `pnpm dev`        | API + worker, **mock** | Normal development, and everything in Postman except folder 14 |
| `pnpm dev:live`   | API + worker, **live** | Only for a real SEC-backed search. Read the banner it prints   |
| `pnpm dev:api`    | API only               | Debugging the HTTP layer                                       |
| `pnpm dev:worker` | Worker only            | Debugging job handling                                         |

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
| Collection            | `postman/erly-adverse-search-full.postman_collection.json` |
| Environment (sandbox) | `postman/sandbox.ready.postman_environment.json`           |
| Environment (live)    | `postman/live.ready.postman_environment.json`              |

Do **not** import `erly-adverse-search.postman_collection.json` — it is a short demo subset with
no signup flow, no admin and no live folder.

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

**A live search costs three or four requests**: one poll of the feed, one `robots.txt` on a cold
process, one document fetch per candidate.

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
