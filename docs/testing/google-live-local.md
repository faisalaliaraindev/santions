# Google live, local — Target Platform tenant acceptance (Postman Folder 19)

One LIVE adverse search, run by the real local Target Platform tenant through the normal tenant API, with
`GOOGLE_NEWS` added **for that one request only**. Local diagnostic testing only.

Google stays `REFUSED` under D20 and `defaultEnabledForDiscovery: false`. Nothing here changes an
engine setting, a governance reading or a tenant switch. After the run, the control API still shows
Google disabled — Folder 19 checks this in 19.10.

## How the override works

The API grants the diagnostic only when **all** of these hold. If any one fails, a request that
carries the header is refused with `403`; it is never quietly run without Google.

| Condition                                          | Where it is set                                                                       |
| :------------------------------------------------- | :------------------------------------------------------------------------------------ |
| Runtime is not production                          | `NODE_ENV` is `development` in `.env`. Production refuses to start with the flag set. |
| The request is local                               | `baseUrl` is `127.0.0.1` / `localhost`, and the request comes from loopback           |
| `ALLOW_LOCAL_GOOGLE_DIAGNOSTIC=true`               | The environment of the API **and** the worker                                         |
| Tenant = `GOOGLE_DIAGNOSTIC_TENANT_ID`             | The environment of the API **and** the worker                                         |
| Header `X-Local-Discovery-Diagnostic: GOOGLE_NEWS` | Sent by Folder 19, request 19.4                                                       |

The worker checks the first, third and fourth conditions again before it runs Google. A worker
without the flag runs the search without Google.

Publisher FetchGate does not change. When Google finds an article from a publisher that is not
approved (Bloomberg, Reuters and others), the run keeps it as a rejected lead with
`PUBLISHER_NOT_APPROVED`, does not fetch it, and carries on. Indexed, SEC and Wikinews results do
not depend on Google.

## Start stack

### 1. Stop old API and worker processes first

An old worker on the same queue (`adverse-search-jobs`) can pick up the job. It does not have
this build or this environment, so it runs the search **without** Google, and 19.7 fails with
"Stop old workers".

PowerShell:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'dev\.mjs|apps[\\/]api[\\/]dist[\\/](main|worker-main)\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Git Bash:

```bash
ps -W | grep -i node   # then: taskkill //PID <pid> //T //F  for each dev.mjs / main.js / worker-main.js
```

After this, no `node` process should be running `dev.mjs`, `main.js` or `worker-main.js`.

### 2. Start the local infrastructure (if it is not already up)

```bash
pnpm local:up
pnpm local:bootstrap   # re-creates the SQS queues if LocalStack was recreated
```

`docker ps` should show `mongo`, `localstack`, `keycloak`, `meilisearch` and `searxng` as healthy.

### 3. Start one current API and one current worker, in LIVE mode

Set these in the **same shell** that runs `pnpm dev:live`. `dev.mjs` passes them to both the API
and the worker, and a value set in the shell wins over `.env`.

PowerShell:

```powershell
$env:ALLOW_LOCAL_GOOGLE_DIAGNOSTIC = 'true'
$env:GOOGLE_DIAGNOSTIC_TENANT_ID   = '<actual local Target Platform tenant id>'
pnpm dev:live
```

Git Bash:

```bash
ALLOW_LOCAL_GOOGLE_DIAGNOSTIC=true \
GOOGLE_DIAGNOSTIC_TENANT_ID='<actual local Target Platform tenant id>' \
pnpm dev:live
```

`pnpm dev:live` builds first, then starts the API and the worker with `ADVERSE_SEARCH_MODE=live`.
The values it takes from `.env` are already right: `NODE_ENV=development`,
`SEARXNG_URL=http://127.0.0.1:28888`, `FETCH_CONTACT_URL` and `JOBS_QUEUE_URL`. The API listens
on `http://127.0.0.1:3000` unless `PORT` is set.

Run exactly **one** `pnpm dev:live`. Two stacks share one queue, and the result depends on which
worker gets the job.

## Postman

Import (or re-import) the current files from `postman/`:

- collection: `adverse-search-service-full.postman_collection.json`
- environment: `local.ready.postman_environment.json` (or the template, `local.postman_environment.json`)

Environment values. The first four are already set. Enter the last two:

| Variable                  | Value                                                               |
| :------------------------ | :------------------------------------------------------------------ |
| `baseUrl`                 | `http://127.0.0.1:3000`, or your local port                         |
| `googleDiagnosticConfirm` | `yes-run-google-live-local`                                         |
| `googleSubjectName`       | `Bernard Madoff`                                                    |
| `googleSubjectDob`        | `1938-04-29` (optional; clear it to search by name only)            |
| `googleSubjectCountry`    | `US`                                                                |
| `searxngUrl`              | `http://127.0.0.1:28888`                                            |
| **`adverseSearchApiKey`**       | **the existing local Target Platform LIVE tenant API key**                  |
| **`adverseSearchTenantId`**     | **the Target Platform tenant id**; must equal `GOOGLE_DIAGNOSTIC_TENANT_ID` |

The key must be a LIVE key with the `tenant_admin` role, because 19.1 and 19.10 read the
discovery-engine control API.

Run the folder **`19 - Target Platform LIVE Google Diagnostic`** with the Collection Runner.

A folder-level guard runs before every request. If `baseUrl` is not local, the confirmation value
is wrong, or either Target Platform value is empty, nothing is sent. Request 19.0 also stops the folder if
the key belongs to a different tenant or is not a LIVE key.

| Step  | What it does                                                                                                                                                             |
| :---- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19.0  | Guard: the key authenticates as `adverseSearchTenantId`, in `live`                                                                                                             |
| 19.1  | Google normal state: `integrated`, `REFUSED`, default off, not effective                                                                                                 |
| 19.2a | API ready                                                                                                                                                                |
| 19.2b | SearXNG `/healthz`                                                                                                                                                       |
| 19.3  | Create the subject, with a stable `externalSubjectRef` (`target-platform-google-diagnostic:bernard-madoff`)                                                                      |
| 19.4  | `POST /v1/searches`, `environment: live`, with `X-Local-Discovery-Diagnostic: GOOGLE_NEWS`                                                                               |
| 19.5  | Poll `GET /v1/searches/{id}` until the search reaches a terminal state                                                                                                   |
| 19.6  | `GET /v1/searches/{id}/findings`                                                                                                                                         |
| 19.7  | Google row: attempted, `diagnosticOverride`, `RETURNED_RESULTS`, results > 0, duration > 0                                                                               |
| 19.8  | Provenance: `GOOGLE_NEWS` is recorded as the channel, the publisher URL is kept, Google is never the publisher, no search URL becomes a finding, FetchGate still applies |
| 19.9  | Isolation: indexed, SEC and (if present) Wikinews results survive                                                                                                        |
| 19.10 | Google is still `REFUSED`, default off, not effective. The row matches 19.1 exactly.                                                                                     |

There is no worker health endpoint. 19.5 shows that a worker took the job. 19.7 shows that the
worker is current, because an old worker cannot set `diagnosticOverride`.

Google's result count changes between runs. The folder requires at least one result, not a
specific number.

## PASS means

Every test in Folder 19 is green, which proves:

- **Google was contacted.** `GOOGLE_NEWS` `attempted: true`, `durationMs > 0` (19.7).
- **Google returned live results.** `outcome: RETURNED_RESULTS`, `resultsReturned > 0` (19.7).
- **The result URLs are real publisher URLs.** No candidate URL or `publisherDomain` is a Google
  host (19.8).
- **The engine diagnostics show `GOOGLE_NEWS`.** `diagnosticOverride: true`, `diagnosticOnly: true`,
  `effectiveEnabled: true`, and `governanceStatus` is still `REFUSED` (19.7). Candidates list
  `GOOGLE_NEWS` in `discoveryEngines` / `discoveredByEngines` (19.8).
- **The request used the real Target Platform tenant.** `/auth/session` returns `adverseSearchTenantId`, in
  `live` (19.0).
- **The normal adverse-search API was used.** `POST /v1/subjects`, `POST /v1/searches`,
  `GET /v1/searches/{id}` and `/findings`. No Google-specific endpoint exists or was called.
- **Google is disabled again afterwards.** The control API shows `REFUSED`, default off, not
  effective, unchanged from 19.1 (19.10).
- **No paid service or API was used.** No paid provider appears anywhere in the run (19.9).
  SearXNG is self-hosted.
- **Other sources' results survive on their own.** Indexed and SEC outcomes are present, the run
  is not `FAILED`, and every non-Google finding is intact (19.9).

## If it fails

| Symptom                                  | Cause                                                                                                                           |
| :--------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------ |
| Every request errors with "not armed"    | `adverseSearchApiKey` / `adverseSearchTenantId` are empty, or `baseUrl` is not local                                                        |
| 19.0 fails on the tenant id              | The key belongs to another tenant. Fix `adverseSearchTenantId` or the key                                                             |
| 19.1 returns 403                         | The key does not have `tenant_admin`                                                                                            |
| 19.4 returns 403                         | The API process does not have `ALLOW_LOCAL_GOOGLE_DIAGNOSTIC=true`, or `GOOGLE_DIAGNOSTIC_TENANT_ID` does not equal this tenant |
| 19.5 stays `QUEUED`                      | No worker is running, or the queue is missing. Run `pnpm local:bootstrap`                                                       |
| 19.7: "Stop old workers"                 | An old worker, or a worker without the two variables, took the job. Go back to step 1 of Start stack                            |
| 19.7: outcome `CAPTCHA` / `RATE_LIMITED` | Google blocked this request. The diagnostic worked, and the run shows the block instead of hiding it. Wait before running again |
