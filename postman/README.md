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

> `POST /v1/tenant/api-keys` exists and returns **501**. That is not a bug. Decision **D-007**
> defers the commercial self-service layer, so keys are provider-managed in this phase, and a
> script an operator runs is what provider-managed means.

## 4. Import into Postman

Import both files from this folder:

- `erly-adverse-search.postman_collection.json`
- `local.postman_environment.json`

Select the **Erly adverse-search — local** environment, then paste the secret from step 3 into
the `apiKey` variable.

## 5. Run the folders in order

| Folder           | What it does                                                                             |
| :--------------- | :--------------------------------------------------------------------------------------- |
| **0 — Health**   | Confirms the API is up before you debug an auth problem that is really a stopped process |
| **1 — Subject**  | Creates the person being screened. Saves `subjectId` automatically                       |
| **2 — Search**   | Starts a run, then polls until it finishes. Saves `searchId` automatically               |
| **3 — Results**  | Findings, coverage and the association graph                                             |
| **4 — Admin**    | Source health, coverage, kill switch. Needs a `source_admin` key                         |
| **5 — Refusals** | The API saying no, correctly. Worth running once                                         |

Or use **Run collection** and let it walk the whole thing.

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

| Symptom                     | Cause                                                             |
| :-------------------------- | :---------------------------------------------------------------- |
| 401 on everything           | `apiKey` is empty or the key was revoked                          |
| 403 on admin requests       | Your key has the wrong role. `pnpm key:issue --role source_admin` |
| 403 releasing a kill switch | Four eyes. The releaser must be a different key from the engager  |
| Search stays `QUEUED`       | The worker is not running. `pnpm dev:worker`                      |
| 503 on `/health/ready`      | Stack not bootstrapped. `pnpm local:up && pnpm local:bootstrap`   |
| 501 on a reserved path      | Deliberate. See D-007                                             |
| `MISSING_SCOPE` in the log  | The key was issued with narrower `--scope` than the route needs   |
| Accented name finds nothing | The request body was not sent as UTF-8 — see the note below       |
| Connection refused          | API not started. `pnpm dev:api`                                   |

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

## Keeping the collection honest

The OpenAPI document is generated from the contract schemas and a test fails if it drifts:

```bash
pnpm openapi:generate
```

This collection is hand-written and **is not** generated, so it can drift. If a request here
disagrees with `openapi/openapi.json`, the OpenAPI document is right.

---

## Related reading

| File                               | What is in it                                 |
| :--------------------------------- | :-------------------------------------------- |
| `docs/SIMPLE-STATUS.md`            | Where the project is, in plain words          |
| `docs/SIMPLE-FLOW.md`              | The same, as diagrams                         |
| `docs/TODO-E2E.md`                 | What is left to build                         |
| `docs/integration/zquence.md`      | The four things machine integrators get wrong |
| `examples/zquence-integration.mjs` | The same walkthrough in code                  |
