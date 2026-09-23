# Live test sequence: one endpoint for everything, then each source on its own

Everything is tested through **one endpoint: `POST /v1/screen`**. You send a name and get the
finished result back **in the same response**. You don't create a subject, poll, or run a worker.
Every source this deployment has is asked in that one call.

The same endpoint also tests **one source at a time**: add `"sources": ["<source id>"]` to the
body. Only that source is asked, and every other source still appears in the result as `SKIPPED`.
A single-source result therefore always says `coverage: INCOMPLETE` and can never be mistaken for
a full screening.

Work top to bottom.

---

## Part 1: Start

### 1. Stop anything old

An old API or worker can answer with old code.

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dev\.mjs|apps[\\/]api[\\/]dist[\\/](main|worker-main)\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

**Check:** no `node` process is running `dev.mjs`, `main.js` or `worker-main.js`.

### 2. Start the infrastructure

```powershell
cd D:\Erly\Projects\sanctions\erly-sanction-service-backend
pnpm local:up
pnpm local:bootstrap
```

**Check:** `docker ps` shows `mongo`, `localstack`, `keycloak`, `meilisearch`, `searxng`,
`fixture-server` and `model-runtime` as healthy. Bootstrap ends with `═══ bootstrap complete ═══`.

### 3. Start the API, LIVE

One terminal, kept open:

```powershell
# Only needed for the Google step (20.4). Harmless otherwise.
$env:ALLOW_LOCAL_GOOGLE_DIAGNOSTIC = 'true'
$env:GOOGLE_DIAGNOSTIC_TENANT_ID   = '<your Zquence tenant id>'
pnpm dev:live
```

**Check:** the log says `API listening on 3000 (development, mode=live)`.

`/v1/screen` runs the search **inside the API process**, so it does not need the worker. `pnpm
dev:live` starts one anyway, and that is fine: it receives the run, sees it has already finished, and
discards it. If you change code, stop the terminal and start it again.

For a run that contacts nobody, start the API in mock mode instead and screen with
`"environment": "sandbox"`:

```powershell
$env:ADVERSE_SEARCH_MODE = 'mock'; pnpm dev:api
```

### 4. Postman

Import `postman/erly-adverse-search-full.postman_collection.json` and
`postman/local.ready.postman_environment.json`, then select that environment.

| Variable            | Value                                                               |
| :------------------ | :------------------------------------------------------------------ |
| `screenConfirm`     | `yes-run-one-endpoint` (the folder sends nothing until this is set) |
| `screenEnvironment` | `live` (real sources) or `sandbox` (fixtures, mock-mode API)        |
| `screenName`        | the name to screen, default `Bernard Madoff`                        |
| `screenSource`      | the one source for 20.3, default `ofac-sdn`                         |
| `zquenceApiKey`     | only for 20.4 (Google). Leave it empty and 20.4 is skipped          |

`apiKey` and `baseUrl` (`http://127.0.0.1:3000`) are already filled in.

---

## Part 2: One-endpoint testing (Postman Folder 20)

Run **Folder `20 - One Endpoint: POST /v1/screen`** with the Collection Runner. It runs in this
order:

| Request | What it does                                                                    | Pass                                                                                                                                         |
| :------ | :------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------- |
| 20.0    | Asks the API which sources it can search                                        | `400` for a made-up id, and the list of searchable ids printed in the console                                                                |
| 20.1    | **All sources, one call**                                                       | `201`; the run did not `FAIL`; **every** searchable source reports an outcome; none was left out by a filter                                 |
| 20.2    | **Each source, one call per source.** Repeats itself until every source is done | For every source: that one was asked, all others are `SKIPPED`, `coverage` is `INCOMPLETE`, and the source answered `COMPLETED` or `PARTIAL` |
| 20.3    | One source you choose (`screenSource`)                                          | `201`, and that source reports an outcome                                                                                                    |
| 20.4    | All sources **plus Google** (local diagnostic, optional)                        | Google `attempted`, `diagnosticOverride: true`, still `REFUSED` in governance                                                                |

The console prints one line per source for every call (outcome, failure class, detail) and one
line per news engine, so **the runner's console is the report.**

### Without Postman

Replace the key with your live key. The response body is the full result.

```powershell
$h = @{ Authorization = 'ApiKey <your live key>' }
$url = 'http://127.0.0.1:3000/v1/screen'

# All sources, one call
$all = Invoke-RestMethod -Method Post -Uri $url -Headers $h -ContentType 'application/json' -Body (@{
  fullName = 'Bernard Madoff'; purpose = 'CUSTOMER_ONBOARDING'; environment = 'live'
} | ConvertTo-Json)
$all | Select-Object execution, findingsState, coverage, elapsedMs
$all.result.sourceOutcomes | Format-Table sourceId, cascadeRung, outcome, failureClass

# One source
$one = Invoke-RestMethod -Method Post -Uri $url -Headers $h -ContentType 'application/json' -Body (@{
  fullName = 'Bernard Madoff'; purpose = 'CUSTOMER_ONBOARDING'; environment = 'live'
  sources = @('sec-litigation-releases')
} | ConvertTo-Json)
$one.result.sourceOutcomes | Format-Table sourceId, outcome, detail
```

Every `/v1/searches/{searchId}` route also works afterwards against the `searchId` the response
returns.

---

## Part 3: Each source, and what a pass looks like

**20.0 prints the exact list for your running stack. Trust it over this table.** An id that is not
on that list is refused with `400` before anything runs, and the refusal names every id that
would have been accepted.

| Source id                                | What it is                                              | Contacts when screened                                                                       | Pass looks like                                                                                                                                                                                                                      |
| :--------------------------------------- | :------------------------------------------------------ | :------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ofac-sdn`                               | US Treasury OFAC SDN list                               | nothing (local snapshot)                                                                     | `COMPLETED` or `PARTIAL`, `Searched local snapshot … (N records)`                                                                                                                                                                    |
| `ofac-consolidated-non-sdn`              | OFAC non-SDN consolidated list                          | nothing                                                                                      | as above                                                                                                                                                                                                                             |
| `uk-sanctions-list`                      | UK FCDO sanctions list                                  | nothing                                                                                      | as above                                                                                                                                                                                                                             |
| `eu-consolidated-financial-sanctions`    | EU financial sanctions                                  | nothing                                                                                      | as above                                                                                                                                                                                                                             |
| `unsc-consolidated`                      | UN Security Council list                                | nothing                                                                                      | as above                                                                                                                                                                                                                             |
| `ftc-consumer-protection-press-releases` | US FTC press releases                                   | nothing                                                                                      | as above                                                                                                                                                                                                                             |
| `doj-fraud-enforcement`                  | US DOJ fraud enforcement                                | nothing                                                                                      | as above                                                                                                                                                                                                                             |
| `fca-warnings`                           | UK FCA warnings                                         | nothing                                                                                      | as above                                                                                                                                                                                                                             |
| `cftc-enforcement-press-releases`        | US CFTC enforcement                                     | nothing                                                                                      | as above                                                                                                                                                                                                                             |
| `world-bank-debarred`                    | World Bank debarment list                               | nothing                                                                                      | **Expected to fail:** `FAILED`, "No usable local snapshot exists". Blocked on a missing API key and a robots 403 (see START-HERE). This is the only expected red in 20.2                                                             |
| `sec-litigation-releases`                | SEC litigation releases feed                            | `www.sec.gov`                                                                                | `COMPLETED`; one request per 15-minute poll floor, so a second run within 15 minutes costs no request                                                                                                                                |
| `sec-press-releases`                     | SEC press releases feed                                 | `www.sec.gov`                                                                                | `COMPLETED`. Budget is 6/hour: `HOURLY_BUDGET_EXHAUSTED` after that is the budget working, not a fault                                                                                                                               |
| `gdelt-doc-v2`                           | GDELT news database                                     | nothing while SUSPENDED                                                                      | Deliberately SUSPENDED, so it may not be on 20.0's list at all (then naming it answers `400`). If it is listed, it reports as suspended or refused and makes zero GDELT requests. Not yet observed through `/v1/screen` in live mode |
| `searxng-adverse-media`                  | News engines via SearXNG, plus Wikinews article reading | Bing, Brave, DuckDuckGo, Reuters and Wikinews through SearXNG; `en.wikinews.org` for fetches | `COMPLETED` or `PARTIAL`. Per-engine rows in `result.searxngDiscovery`. Google shows `DISABLED_BY_POLICY`. Other publishers appear as rejected leads `PUBLISHER_NOT_APPROVED`, which is correct                                      |

**Normal, not a failure:**

- an indexed list showing `PARTIAL` with "Latest refresh status: FAILED". The search ran against
  the last good snapshot, and the result says so. Refresh the list from Folder 16 if you want it
  current.
- one news engine returning `CAPTCHA`, `TIMEOUT` or `CONNECTION_ERROR` while the others answer.
- `findingsState: NO_MATCHES_FOUND` together with `coverage: INCOMPLETE`. Read the three together:
  "found nothing **in what was searched**", and not everything was searched.

**Not a source, and not filterable:** `association-graph` (the company-register lookup, which runs
every time) and `cascade-rung-N` rows (rungs where no source is approved). They appear in every
result and are never counted as a source you asked for.

---

## Part 4: The deeper acceptance folders (optional)

Folder 20 covers every source through the one endpoint. The older folders prove specific
properties over the asynchronous API, and still work:

| Folder | Proves                                                  | Arm value                                             |
| :----- | :------------------------------------------------------ | :---------------------------------------------------- |
| 0      | API up                                                  | none                                                  |
| 16     | Indexed lists cause zero publisher downloads per search | `indexedRefreshConfirm` only for the refresh step     |
| 14     | Signup → live key → real SEC search                     | `liveConfirm = yes-contact-the-sec`                   |
| 15     | SEC vs GDELT request shapes (GDELT is suspended)        | `mixedLiveConfirm = yes-contact-sec-and-gdelt`        |
| 17     | All lists + both SEC feeds, combined acceptance         | `caConfirm = yes-contact-sec-and-indexed`             |
| 18     | News engines, Wikinews article → finding                | `sxConfirm = yes-query-searxng-and-sec`               |
| 19     | Google via the Zquence tenant, over `/v1/searches`      | `googleDiagnosticConfirm = yes-run-google-live-local` |

Folders 14–18 each sign up a fresh tenant, and **signup allows 5 per hour.** Folder 20 signs
nobody up.

---

## Part 5: Stop everything

```powershell
# 1. The API / worker: Ctrl+C in the pnpm dev:live terminal, or:
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dev\.mjs|apps[\\/]api[\\/]dist[\\/](main|worker-main)\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 2. The infrastructure
pnpm local:down
```

**Check:** the first command above finds nothing more to stop, and `docker ps` lists no
`erly-adverse-search-*` container. `local:down` keeps the data volumes, so the indexed snapshots
and tenants are still there next time. `pnpm local:reset` is the one that wipes them. Don't run it
unless you mean to.
