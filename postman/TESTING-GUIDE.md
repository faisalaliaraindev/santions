# Which API to call, in which order, and what each one proves

A walkthrough of the whole service from an empty stack to a finished search. Every row says what
the call is **for**, not just what it returns — the order matters and several of the steps only
make sense in terms of the one before.

**Import these two files:**

| File                                               | What it is                                                      |
| :------------------------------------------------- | :-------------------------------------------------------------- |
| `adverse-search-service-full.postman_collection.json` | All 38 requests, 12 folders                                     |
| `local.ready.postman_environment.json`             | Every key and name already filled in. **Contains real secrets** |

> `local.ready.postman_environment.json` is git-ignored on purpose. It holds working credentials.
> Do not commit it, paste it into a ticket, or send it over chat.

Before anything: `pnpm local:up && pnpm local:bootstrap`, then `pnpm dev`.

---

## The short version

If you only want to see the thing work, it is three requests:

1. **`0 — Health`** → `GET /health/ready`
2. **`2 — Subjects`** → `POST /v1/subjects`
3. **`3 — Searches`** → `POST /v1/searches`, then `Poll until terminal`, then
   **`4 — Results`** → `GET /v1/searches/{id}/findings`

Everything below is the same journey with the reasons attached.

---

## Stage 1 — Is the service actually up?

| #   | Request                       | What it proves                                                                                |
| :-- | :---------------------------- | :-------------------------------------------------------------------------------------------- |
| 1   | `GET /health/live`            | The process is running. Nothing more — it does not touch the database                         |
| 2   | `GET /health/ready`           | Mongo, the queue and the index all answer. **A 503 here means the stack is not bootstrapped** |
| 3   | `GET /v1/health/dependencies` | Which dependency is unhappy, by name, when `ready` says no                                    |

**Start here every time.** Most "authentication is broken" reports are a stopped worker or an
un-bootstrapped stack, and these three calls separate those cases in about five seconds.

---

## Stage 2 — Create the person being screened

| #   | Request                                    | What it proves                                               |
| :-- | :----------------------------------------- | :----------------------------------------------------------- |
| 4   | `POST /v1/subjects`                        | A subject exists and is versioned. Saves `subjectId` for you |
| 5   | `GET /v1/subjects/{id}/versions/{version}` | You can read back exactly what was screened, forever         |

**Why subjects are versioned.** A search is pinned to the subject _as it was when the search ran_.
If somebody corrects a date of birth next week, last week's result still says what it was actually
based on. A screening you cannot reconstruct is a screening you cannot defend.

**`purpose` is mandatory** and comes from a fixed list. There is no "because I felt like it" —
every screening of a real person records why it was lawful to do.

Change **`subjectName`** in the environment to screen somebody else. The six names the fixture
corpus answers to are in `README.md` — including one who was **acquitted**, which is the case worth
looking at.

---

## Stage 3 — Run the search

| #   | Request                         | What it proves                                                       |
| :-- | :------------------------------ | :------------------------------------------------------------------- |
| 6   | `POST /v1/searches`             | Accepted — **202, not 200**. The work has not happened yet           |
| 7   | `Poll until terminal`           | Re-runs itself until the run finishes. Needs the worker (`pnpm dev`) |
| 8   | `GET /v1/searches?limit=20`     | Every run for the tenant                                             |
| 9   | `POST /v1/searches/{id}/cancel` | A run in flight can be stopped, and says so rather than vanishing    |

### Two ways to start a search

`subjectRef` and `subjectSnapshot` are mutually exclusive — send exactly one.

| You send                             | Use it when                                                                       | Calls |
| :----------------------------------- | :-------------------------------------------------------------------------------- | :---- |
| `subjectSnapshot` (the name itself)  | **The integrator path.** A tenant just wants "screen this name"                   | **1** |
| `subjectRef` (an existing subjectId) | You already hold a subject and want repeat screenings pinned to the same identity | 2     |

With `subjectSnapshot` the service creates the versioned subject **and** queues the search in one
request. The subject is still versioned and still reconstructable — you just did not have to make
a separate call to get one. Both return **202**.

The collection has both: `Create a search` and `Create a search (one call - subjectSnapshot)`.

**Why it is asynchronous.** A real screening walks a cascade of sources, fetches documents and
reads them. That does not fit in one HTTP request, so the API takes the job and hands back an id.
**If the search never leaves `QUEUED`, the worker is not running.**

Send the same `Idempotency-Key` twice and you get the _same_ search back, not a second one — so a
retrying client cannot bill you twice for one screening.

---

## Stage 4 — Read the result properly

| #   | Request                              | What it proves                                           |
| :-- | :----------------------------------- | :------------------------------------------------------- |
| 10  | `GET /v1/searches/{id}/findings`     | The findings **and** the coverage, together, never apart |
| 11  | `GET /v1/searches/{id}/associations` | Company links, and where they are unknown                |

### The three fields that must be read together

| Field           | Answers                                    |
| :-------------- | :----------------------------------------- |
| `execution`     | Did the job finish?                        |
| `findingsState` | Did we find anything?                      |
| `coverage`      | Did we search everything we said we would? |

`SUCCEEDED` + `NO_MATCHES_FOUND` + `INCOMPLETE` means: it finished, found nothing, **and did not
search everything it promised**. That is not a clean result. Reading only the first two fields is
the single most dangerous way to misuse this API.

### A band is not a score

`band` is one of `CORROBORATED`, `SUPPORTED`, `AMBIGUOUS`, `COMPANY_CONTEXT`, `CONTRADICTED`,
`LEAD_ONLY`. There is no numeric risk score anywhere, deliberately. Do not average, threshold or
colour-scale them into one — that is how "two weak rumours" becomes "medium risk".

**Always read `proceduralStage` next to the band.** An investigation and an acquittal can both be
`SUPPORTED`; the band says how well-evidenced the report is, not whether the person did it.

When `findings` is empty, `noMatchStatement` says in words what was searched and what the absence
does and does not mean. It never says "clear" or "clean", and nothing downstream should add it.

---

## Stage 5 — The refusals (run once, deliberately)

Folder **`10 — Refusals worth seeing`**. These are the API being correct, and each one is a real
protection:

| Request                  | What it protects                                                              |
| :----------------------- | :---------------------------------------------------------------------------- |
| No purpose → 422         | Nobody is screened without a recorded lawful reason                           |
| Misspelled field → 422   | A typo is rejected, not silently ignored — a dropped filter is a wrong search |
| Regional code → 422      | `EU` is not a jurisdiction; coverage is recorded per country                  |
| Another tenant's search  | Customers cannot see each other's screenings                                  |
| Unknown search → 404     | No information leaks through an error message                                 |
| Admin route without role | Roles are enforced per route, not per login                                   |

---

## Stage 6 — Admin, and who is allowed to do what

**No single key runs the whole collection, and that is the point.** T06 exists so that somebody who
can watch source health cannot thereby read a customer's findings.

| Folder                       | Environment variable | Role                                 |
| :--------------------------- | :------------------- | :----------------------------------- |
| Subjects, Searches, Results  | `{{apiKey}}`         | `analyst`                            |
| Source registry, kill switch | `{{apiKey}}`         | `source_admin`                       |
| **Source health**            | `{{operatorKey}}`    | `platform_operator`                  |
| **SEC approval**             | `{{approverKey}}`    | `source_admin`, **different person** |

| Request                        | What it is for                                                            |
| :----------------------------- | :------------------------------------------------------------------------ |
| `GET /v1/admin/sources`        | Every source and its lifecycle state                                      |
| `GET /v1/admin/source-health`  | Breaker state and budget spend. Needs `{{operatorKey}}`                   |
| `GET /v1/admin/coverage/CR`    | What the service can and cannot do in a country — **before** promising it |
| `POST .../kill-switch`         | Stop a source now. One person, because stopping is the safe direction     |
| `POST .../kill-switch/release` | Restart it. **Four eyes** — the releaser cannot be the engager            |

---

## Stage 6b — Managing your own API keys (folder 12)

Self-service issuance, decision **D-050**. Needs `apikey:manage`, which `tenant_admin` holds.

| Request                              | What it proves                                        |
| :----------------------------------- | :---------------------------------------------------- |
| `POST /v1/tenant/api-keys`           | A tenant issues its own key. **Secret returned once** |
| `GET /v1/tenant/api-keys`            | The listing carries no secret and no hash of one      |
| Escalation attempt                   | A key cannot carry roles the caller does not hold     |
| Live key from a sandbox credential   | Entitlement is sold, not granted by asking            |
| `DELETE /v1/tenant/api-keys/{keyId}` | Revocation is immediate, and the reason is audited    |

The two refusals are worth running once: they are the difference between self-service and
self-promotion.

---

## Stage 6c — The whole customer join (folder 13), and the live one (folder 14)

**Folder 13** is signup → verification token → verify → sign in → sandbox key → live key → subject
→ search → poll → findings, against the fixture server. Every request from the subject onward
authenticates with the key the tenant minted for itself seconds earlier — no seeded credential, no
JWT, no tenant id in a payload. Runnable with **Run folder**: 31 requests, 28 assertions.

It proves the seam nothing else crossed: a tenant can be provisioned with everything except the
one thing that makes the product work. It was, once — signup granted `tenant_admin` but not
`analyst`, so the administrator could issue keys and every one of them was refused at
`POST /v1/searches`.

**Folder 14 is the same join with a real publisher at the end of it, and it contacts the SEC.**

| Guard | What it does                                                           |
| :---- | :--------------------------------------------------------------------- |
| 14.0  | Halts the folder unless `liveConfirm` is exactly `yes-contact-the-sec` |
| 14.6  | Halts it if the SEC source's breaker is not `CLOSED` or `HALF_OPEN`    |

Before running it: the API and worker must be in live mode (`pnpm dev:live`), and
`pnpm sec:live-smoke --yes-contact-the-sec` should have passed. The smoke test makes **one**
request and prints the names currently in the feed — set `liveSubjectName` to one of them, because
a `FIXED_FEED` is matched locally and a name that is not in the list returns an honest
`NO_MATCHES_FOUND`.

**What 14.10 asserts, and why a 200 is not enough.** A fixture run returns `SUCCEEDED` too. So the
assertions are about provenance: `mode` is `LIVE`, `sec-litigation-releases` appears in the
coverage outcomes, and none of the eight fixture source ids appears anywhere in them.

The headless equivalent, with the same two gates, is
`SEC_LIVE_E2E=yes-contact-the-sec pnpm test:live`.

## Stage 7 — Taking a real source live (folder 11)

This is the only part that reaches outside the machine, and two steps are not developer actions.

| #   | Step                                                           | Who                                                                   |
| :-- | :------------------------------------------------------------- | :-------------------------------------------------------------------- |
| 1   | `pnpm first-contact` (**not Postman**)                         | **The project owner.** The first live request this service ever makes |
| 2   | Record `robotsPosition` from what robots.txt **actually said** | Source admin                                                          |
| 3   | Propose → Submit                                               | Proposer, `{{proposerKey}}`                                           |
| 4   | **Approve**                                                    | **A second person**, `{{approverKey}}`                                |
| 5   | Activate                                                       | Rights clearance gate (SEC-05)                                        |

**Set `approverName` and `approverRole` before step 4.** The audit trail stores the _key id_, not a
person, so the reason text is the only place a human name is ever recorded.

**The four-eyes check compares credentials, not people.** Two keys held by one person will pass it.
The control is only real if the second person holds `{{approverKey}}` themselves.

---

## When it does not work

| Symptom                                      | Cause                                                             |
| :------------------------------------------- | :---------------------------------------------------------------- |
| 401 everywhere                               | `apiKey` empty or revoked                                         |
| 403 on admin                                 | Wrong role for that folder — see the table above                  |
| 403 on `/admin/source-health`                | Needs `platform_operator`, not `source_admin`                     |
| Search stays `QUEUED`                        | Worker not running. `pnpm dev`                                    |
| 503 on `/health/ready`                       | `pnpm local:up && pnpm local:bootstrap`                           |
| Integration tests fail while `pnpm dev` runs | Both workers eat the same queue. Stop `pnpm dev` first            |
| Accented name finds nothing                  | Body not sent as UTF-8. Postman is fine; `curl` on Windows is not |
| 501 on a reserved path                       | Deliberate — D-007                                                |
