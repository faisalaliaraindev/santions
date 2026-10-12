# Running an adverse search in Postman — step by step

From nothing to a screening result you can read. About ten minutes the first time.

This is the **walkthrough**. For what each endpoint is for, see [`TESTING-GUIDE.md`](./TESTING-GUIDE.md).
For the cast of test people, see [`README.md`](./README.md).

---

## Before you start

You need three terminals' worth of setup, once.

### Step 1 — Start the infrastructure

```bash
pnpm local:up          # Mongo, LocalStack, Meilisearch, Keycloak, SearXNG
pnpm local:bootstrap   # seeds tenants, sources, taxonomy, policy
```

Wait for `Local stack healthy`. Re-running `local:bootstrap` is safe.

### Step 2 — Start the service

```bash
pnpm dev               # API + worker together
```

**Two processes matter here.** The API accepts searches; the **worker** runs them. Without the
worker your search sits at `QUEUED` forever and nothing tells you why.

> **If you change anything in the source registry — activate, suspend, approve — restart
> `pnpm dev`.** The ladder of sources is assembled when the process starts. A registry change made
> while it is running is not picked up, and the symptom is not an error: searches simply start
> coming back `FAILED` with every rung reporting "no approved source". Restarting fixes it.

### Step 3 — Import into Postman

Import both files from the `postman/` folder:

| File                                               | What it is                        |
| :------------------------------------------------- | :-------------------------------- |
| `adverse-search-service-full.postman_collection.json` | The requests                      |
| `local.ready.postman_environment.json`             | Keys and names, already filled in |

Then **select the environment** in the top-right dropdown — "Adverse Search Service — local (ready)".
Most "401 Unauthorized" reports are simply no environment selected.

> That environment file contains working credentials. It is git-ignored deliberately. Do not commit
> it or paste it into a ticket.

---

## Step 4 — Check the service is actually up

Open **`0 — Health`** → **`GET /health/ready`** → **Send**.

| You see               | It means                                  |
| :-------------------- | :---------------------------------------- |
| `200 {"status":"ok"}` | Good, carry on                            |
| `503`                 | Stack not bootstrapped — run step 1 again |
| Connection refused    | The API is not running — run step 2       |

**Do this first every time.** It takes two seconds and rules out the three most common causes of
everything else looking broken.

---

## Step 5 — Choose who to screen

In the environment tab, set **`subjectName`**. It ships as `María Fernanda Solís Rojas`.

For your first run, use the one that shows the most:

```
subjectName          Rodrigo Alberto Vargas Méndez
subjectJurisdiction  CR
subjectLanguage      es
```

**Save the environment** (Ctrl+S). Postman does not use unsaved edits.

Six names work. The full table is in `README.md`; the short version:

| Name                              | What you will see                                      |
| :-------------------------------- | :----------------------------------------------------- |
| María Fernanda Solís Rojas        | A fraud charge                                         |
| **Rodrigo Alberto Vargas Méndez** | **An investigation, then an acquittal**                |
| Ana Lucía Jiménez Castro          | A conviction, two independent publishers               |
| Carlos Eduardo Rojas Mora         | One early-stage investigation                          |
| James Whitfield Turner            | An English case — set jurisdiction `US`, language `en` |
| Wilberth Zamora Quesada           | Nothing found, explained properly                      |

Any other name returns "nothing found" — correctly, not as an error.

---

## Step 6 — Create the subject

Open **`2 — Subjects`** → **`Create a subject`** → **Send**.

**Expect `201 Created`.** The response includes:

```json
{
  "subjectId": "d173fd7d-83e5-48ae-b7cf-f6bd9fb2f3f6",
  "version": 1,
  "fullName": "Rodrigo Alberto Vargas Méndez",
  "normalised": { "folded": "rodrigo alberto vargas mendez", ... }
}
```

Two things worth noticing:

- **`subjectId` is saved automatically.** You do not copy anything; the next request picks it up.
- **`normalised`** shows how the name was folded for matching — accents stripped, lower-cased. This
  is why `María` and `Maria` find the same person.

The subject is **versioned**. A search is pinned to the subject as it was at that moment, so a
result stays reconstructable even after somebody corrects a detail later.

---

## Step 7 — Start the search

Open **`3 — Searches`** → **`Create a search`** → **Send**.

**Expect `202 Accepted`** — not `200`. Nothing has been searched yet:

```json
{
  "searchId": "58888dbc-7691-4de0-98c9-aab763e170d7",
  "statusUrl": "/v1/searches/58888dbc-...",
  "execution": "QUEUED"
}
```

A real screening walks a ladder of sources, fetches documents and reads them. That does not fit
inside one HTTP request, so the API takes the job and hands you an id.

---

## Step 8 — Wait for it to finish

Open **`Poll until terminal`** → **Send**. **It re-runs itself** until the search reaches a final
state, waiting between attempts. Watch the Postman Console (`Ctrl+Alt+C`) to see it progress.

**Expect it to end within a few seconds**, printing something like:

```
SUCCEEDED | findings: POTENTIAL_MATCHES | coverage: INCOMPLETE
```

| If it says                    | Then                                           |
| :---------------------------- | :--------------------------------------------- |
| `Still QUEUED after 30 polls` | The worker is not running. Start `pnpm dev`    |
| `FAILED` on every name        | Restart `pnpm dev` — see the warning in step 2 |

---

## Step 9 — Read the result

Open **`4 — Results`** → **`Findings and coverage`** → **Send**.

### First, read these three fields together

```json
{
  "execution": "SUCCEEDED",
  "findingsState": "POTENTIAL_MATCHES",
  "coverage": "INCOMPLETE"
}
```

| Field           | Answers                                    |
| :-------------- | :----------------------------------------- |
| `execution`     | Did the job finish?                        |
| `findingsState` | Did we find anything?                      |
| `coverage`      | Did we search everything we said we would? |

**`INCOMPLETE` is expected here** and is not a fault. It means some sources were not searched — in
the local stack most are fixtures and some rungs have no source at all. The system is telling you
the truth about its own limits.

The dangerous misreading is `SUCCEEDED` + `NO_MATCHES_FOUND` while ignoring `INCOMPLETE`. That
combination means "finished, found nothing, **and did not look everywhere it promised**". It is not
a clean bill of health.

### Then read the findings

For Vargas you get **two**:

```
band: SUPPORTED   category: FRAUD_FINANCIAL_CRIME   proceduralStage: INVESTIGATION_OPENED
band: AMBIGUOUS   category: FRAUD_FINANCIAL_CRIME   proceduralStage: ACQUITTAL_DISMISSAL_OVERTURNED
```

**This is the whole point of the walkthrough.** He was investigated — and then acquitted. Both come
back. A tool that surfaced only the first would be telling you a man is under suspicion when a
court has already cleared him.

So: **always read `proceduralStage` next to `band`.** The band says how well-evidenced the report
is. It does **not** say whether the person did it.

### `band` is not a score

It is one of `CORROBORATED`, `SUPPORTED`, `AMBIGUOUS`, `COMPANY_CONTEXT`, `CONTRADICTED`,
`LEAD_ONLY`. There is no number anywhere in the API, on purpose. Do not average or threshold bands
into one figure — that is how "two weak rumours" silently becomes "medium risk".

Every finding carries `axes` (the values that produced the band) and `rationale` (every rule that
fired, in order), so a reviewer can check the reasoning rather than trust it.

### When nothing is found

Try `subjectName` = `Wilberth Zamora Quesada` and run steps 6–9 again. You get:

```
SUCCEEDED | NO_MATCHES_FOUND | INCOMPLETE
```

with a **`noMatchStatement`** saying in words what was searched and what the absence does and does
not mean. It never says "clear" or "clean", and nothing downstream should add those words.

---

## Step 9b — Doing it against the real SEC

Everything above is the fixture server, and every record it produced is stamped `MOCK`. The live
version of the same walk is Postman folder **14**, or `SEC_LIVE_E2E=yes-contact-the-sec pnpm
test:live`.

Three things to know before you run either:

1. **Prove the connector first.** `pnpm sec:live-smoke --yes-contact-the-sec` makes **one**
   request, prints the response, the leads it normalised and the request count, and moves the
   source budget by two. That is a far cheaper place to find a problem than an eleven-step folder.
2. **The name never reaches the SEC.** The litigation-releases feed is a `FIXED_FEED`: the whole
   list is polled and matched locally. Take a name from what the smoke test printed, or expect an
   honest `NO_MATCHES_FOUND`.
3. **A 200 proves nothing.** A fixture run returns `SUCCEEDED` too. What tells them apart is
   `mode: LIVE`, `sec-litigation-releases` in the coverage outcomes, and no fixture source id
   anywhere in them. Folder 14.10 asserts all three.

`pnpm source:health sec-litigation-releases` is the first thing to look at when a live run comes
back `PARTIAL` / `UNRESOLVED` with a lead rejected at stage `FETCH`.

## Step 10 — Try the rest

| Try this                                | To see                                               |
| :-------------------------------------- | :--------------------------------------------------- |
| `4 — Results` → `Association graph`     | Company links, and where they are honestly `UNKNOWN` |
| `10 — Refusals worth seeing`            | The API saying no, correctly — worth running once    |
| Change `subjectName` to each of the six | A different shape of answer each time                |

To screen somebody else: change `subjectName`, save, and repeat steps 6 → 9. That is the whole
loop.

---

## Quick troubleshooting

| Symptom                          | Cause                                                          |
| :------------------------------- | :------------------------------------------------------------- |
| 401 on everything                | No environment selected, or `apiKey` empty                     |
| Search stays `QUEUED`            | Worker not running — `pnpm dev`                                |
| Every name returns `FAILED`      | Stale worker after a registry change — restart `pnpm dev`      |
| 403 on admin requests            | Wrong role for that folder — see `TESTING-GUIDE.md`            |
| 403 on `/admin/source-health`    | Needs `{{operatorKey}}`, not `{{apiKey}}`                      |
| 503 on `/health/ready`           | `pnpm local:up && pnpm local:bootstrap`                        |
| Accented name finds nothing      | Body not sent as UTF-8. Postman is fine; Windows `curl` is not |
| Edits to the environment ignored | Unsaved. Ctrl+S                                                |

---

## What you are actually looking at

The service runs in **mock mode**. Every source is a fixture, every record is stamped
`mode: "MOCK"`, and **nothing leaves your machine**. The _shape_ of every response is real; the
content is invented test data about invented people.

Searching real sources is a separate, deliberate process with named human approval at two points.
That is folder **`11 — Source go-live (four eyes)`**, and it is not part of this walkthrough.
