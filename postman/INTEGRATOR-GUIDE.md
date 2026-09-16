# Integrating adverse search into your platform — testing the flow in Postman first

Written for a **tenant integrating this service into their own product** (Zquence or anyone else).
It walks the exact calls your platform will make, in Postman, before you write a line of code.

By the end you will know: which endpoints you need, what to store on your side, what to show your
users, and what this service deliberately will not tell you.

- Conceptual background: [`../docs/integration/zquence.md`](../docs/integration/zquence.md)
- The same walkthrough in code: [`../examples/zquence-integration.mjs`](../examples/zquence-integration.mjs)
- What each endpoint is for: [`TESTING-GUIDE.md`](./TESTING-GUIDE.md)

---

## 0. What you are in this system

| Concept     | Who that is                                                   |
| :---------- | :------------------------------------------------------------ |
| **Tenant**  | You. Your customers are not tenants — you are                 |
| **API key** | How you authenticate. Your tenant identity is derived from it |
| **Subject** | A person you are screening, stored as a versioned snapshot    |
| **Search**  | One screening run against one subject                         |

**Your tenant is never something you send.** It comes from the key. A caller cannot claim to be
another tenant, and you cannot read another tenant's searches — there is a request in
`10 — Refusals worth seeing` that proves it.

### Getting a key

Keys are **provider-managed** in this phase (decision D-007). `POST /v1/tenant/api-keys` exists and
deliberately returns `501` — self-service key issuance is not built. You ask the provider, who runs:

```bash
pnpm key:issue --role analyst --label "Zquence production"
```

The secret is shown **once** and only a hash is stored. There is no recovery path; if you lose it,
you get a new one. Store it as a secret on your side, never in source control.

Your key carries an **environment**: `sandbox` or `live`. A sandbox key asking for a live search is
refused with `SANDBOX_CANNOT_ACCESS_LIVE`. That is a guard rail, not a bug.

---

## 1. Set up Postman

Import from this folder:

- `erly-adverse-search-full.postman_collection.json`
- `local.ready.postman_environment.json` — then select it in the top-right dropdown

Paste your key into the `apiKey` environment variable and save (Ctrl+S).

Confirm you are connected: **`0 — Health`** → `GET /health/ready` → expect `200 {"status":"ok"}`.

> The health endpoints are **unversioned and unauthenticated** on purpose. A load balancer should
> not need an API version or a credential to ask whether the service is up, and a version bump must
> not silently turn every probe into a 404.

---

## 2. The flow your platform will implement

Four calls. Three if you use the one-call path.

```
  [1] POST /v1/searches                → 202 + searchId
  [2] GET  /v1/searches/{id}           → poll until terminal
  [3] GET  /v1/searches/{id}/findings  → findings AND coverage
  [4] GET  /v1/searches/{id}/associations   (optional)
```

### Step 1 — Start a screening

Open **`3 — Searches`** → **`Create a search (one call - subjectSnapshot)`** → **Send**.

This is **the integrator path**. You send the person's details; the service creates the versioned
subject and queues the screening in the same request:

```json
{
  "subjectSnapshot": {
    "fullName": "Ana Lucía Jiménez Castro",
    "aliases": [],
    "countryContext": ["CR"],
    "externalSubjectRef": "your-customer-id-12345",
    "purpose": "CUSTOMER_ONBOARDING"
  },
  "externalCaseRef": "your-case-ref-abc",
  "requestedScope": {
    "jurisdictions": ["CR"],
    "languages": ["es"],
    "includeFormerDirectorships": false,
    "fromDate": null
  },
  "environment": "sandbox"
}
```

**Expect `202 Accepted`** — not `200`:

```json
{ "searchId": "74fcee64-...", "statusUrl": "/v1/searches/74fcee64-...", "execution": "QUEUED" }
```

Field by field, from an integrator's point of view:

| Field                | You should                                                                                                                                                     |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fullName`           | Send it **as written, in its original script**. Do not split, transliterate or strip accents — the service normalises, and it does it better with the original |
| `externalSubjectRef` | Put **your** customer id here. It is how you tie a screening back to your record                                                                               |
| `externalCaseRef`    | Your case/ticket reference. Comes back on the result                                                                                                           |
| `purpose`            | **Mandatory**, from a fixed list. This is the recorded lawful basis for screening a real person                                                                |
| `jurisdictions`      | ISO 3166-1 alpha-2 country codes. `EU`, `LATAM` and friends are refused — coverage is recorded per country                                                     |
| `environment`        | Must match your key                                                                                                                                            |

**Always send an `Idempotency-Key`.** Use your own case reference — only you know what "the same
case" means. Without one, a retry after a network timeout starts a **second** screening and you pay
for two. With one, you get the same search back.

> **When to use the two-call path instead.** `Create a search` uses `subjectRef` with an existing
> `subjectId`. Use it when you are re-screening someone you already hold and want every run pinned
> to the same identity snapshot. Send exactly one of `subjectRef` or `subjectSnapshot` — the schema
> rejects both and neither.

### Step 2 — Poll until it finishes

Open **`Poll until terminal`** → **Send**. It re-runs itself until the run reaches a terminal state.

**There are no callbacks.** Webhook delivery is not built. Your platform must poll — plan for that,
because an integration designed around a callback that does not exist is worse than one designed
around the gap.

Terminal states: `SUCCEEDED`, `PARTIAL`, `FAILED`, `CANCELLED`. Anything else means keep polling.

### Step 3 — Read the result

Open **`4 — Results`** → **`Findings and coverage`** → **Send**.

The response carries these top-level fields:

| Field                 | What your platform does with it                                  |
| :-------------------- | :--------------------------------------------------------------- |
| `execution`           | Did the job finish?                                              |
| `findingsState`       | Did we find anything?                                            |
| `coverage`            | Did we search everything we said we would?                       |
| `findings`            | The results themselves                                           |
| `noMatchStatement`    | What to display when `findings` is empty — **use this verbatim** |
| `rejectedLeads`       | What was discarded and why                                       |
| `sourceOutcomes`      | Per-source: completed, skipped, failed, suspended                |
| `unmeasuredLanguages` | Languages with no measured recall figure                         |
| `mode`                | `MOCK` or `LIVE`. Never present a `MOCK` result as real          |

---

## 3. The four things integrators get wrong

### 1. A submitted search is not a result

`202` means queued. If your UI shows "screening complete" on the `202`, it is lying. Wait for a
terminal `execution`.

### 2. Findings and coverage are one answer

**Never render findings without coverage.** These three fields must be read together:

```
SUCCEEDED + NO_MATCHES_FOUND + INCOMPLETE
```

means: the run finished, found nothing, **and did not search everything it promised**. That is not
a clean result, and a UI that shows a green tick here is making a claim the service never made.

When `findings` is empty, display **`noMatchStatement`**. It says in words what was searched and
what the absence does and does not mean. It never contains "clear", "clean" or "no adverse media",
and **your platform must not add them**.

### 3. A band is not a score

`band` is one of `CORROBORATED`, `SUPPORTED`, `AMBIGUOUS`, `COMPANY_CONTEXT`, `CONTRADICTED`,
`LEAD_ONLY`. There is **no numeric risk score anywhere in this API**, deliberately.

Do not rank, average, threshold or colour-scale bands into a number. That is how "two weak leads"
becomes "one medium risk" and a reviewer stops looking.

**Show `proceduralStage` next to every band.** Try `subjectName` = `Rodrigo Alberto Vargas Méndez`
and run the flow: you get two findings, and the second is `ACQUITTAL_DISMISSAL_OVERTURNED`. He was
investigated, then cleared. A UI that surfaced only the first would tell your customer a man is
under suspicion when a court has said otherwise.

Every finding carries `axes` (the values that produced the band) and `rationale` (every rule that
fired, in order). Surface them — a band on its own cannot be reviewed, only believed.

### 4. Adverse media is not a sanctions list

This service reports **what was published**. It does not tell you someone is sanctioned. If you
need list matching, that is a different capability with a different failure mode.

---

## 4. Errors your platform must handle

**Branch on `code`, never on `message`** — messages are written for people and will change.
Every error carries a `correlationId`; log it, and quote it to the provider, because it ties your
failure to their logs and audit trail.

| Code                                 | What happened                                       | Retry?       |
| :----------------------------------- | :-------------------------------------------------- | :----------- |
| `VALIDATION_FAILED`                  | Body rejected — read `details`                      | No           |
| `UNKNOWN_FIELD`                      | You sent a field that does not exist — often a typo | No           |
| `UNAUTHENTICATED`                    | Key missing, wrong or revoked                       | No           |
| `FORBIDDEN` / `CROSS_TENANT_DENIED`  | Not yours                                           | No           |
| `ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN` | Tenant not entitled                                 | No           |
| `SANDBOX_CANNOT_ACCESS_LIVE`         | Sandbox key asked for a live search                 | No           |
| `INVALID_SCOPE`                      | e.g. former directorships with no approved scope    | No           |
| `REVISION_CONFLICT`                  | An identical idempotent request is in flight        | Yes, shortly |
| `RATE_LIMITED`                       | Documented as 429                                   | Yes          |
| `NOT_IMPLEMENTED`                    | A reserved endpoint (D-007)                         | No           |

`retryable` on the body is true for 5xx and 429. **Everything else needs a changed request, not a
retry loop.**

> A typo is rejected, not ignored. Send `jurisdiciton` instead of `jurisdiction` and you get
> `UNKNOWN_FIELD`, because a silently dropped filter is a search that did not do what you asked.

Worth running once: folder **`10 — Refusals worth seeing`** exercises each of these deliberately.

---

## 5. What to store on your side

| Store                      | Why                                            |
| :------------------------- | :--------------------------------------------- |
| `searchId`                 | To poll, and to fetch the result again later   |
| `subjectId` + `version`    | To re-screen the same identity snapshot later  |
| Your `externalCaseRef`     | Your own reconciliation                        |
| The `Idempotency-Key` used | So a retry after a restart is still idempotent |

**Do not cache findings as a verdict.** A result is a statement about what was found at a moment,
under a pinned taxonomy and policy version. Re-screen rather than re-display an old answer as a
current one.

---

## 6. What is not built — plan around these, not past them

Stated plainly, because an integration planned around something that does not exist is worse than
one planned around a gap.

| Gap                            | What it means for you                                                                                                        |
| :----------------------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| **No callbacks/webhooks**      | Polling only                                                                                                                 |
| **Mock mode**                  | Every source is a fixture. `mode: "MOCK"` on every response                                                                  |
| **No measured recall**         | Every result carries `unmeasuredLanguages`; coverage stays `INCOMPLETE`                                                      |
| **No clustering yet**          | One story carried by two publishers produces **two** findings. Do not read `axes.independenceCount` as a corroboration count |
| **No rate limiting**           | 429 is documented but nothing throws it yet. Do not design a client that assumes back-pressure exists                        |
| **Findings are undated**       | The FR-07 date fields are not parsed yet — every finding comes back with null dates                                          |
| **No `GET /v1/subjects/{id}`** | You can only read a subject back by id **and** version                                                                       |

---

## 7. From Postman to your code

Once the flow works in Postman, the mapping is direct:

| Postman                       | Your platform                        |
| :---------------------------- | :----------------------------------- |
| `apiKey` environment variable | A secret in your secret manager      |
| `Create a search (one call)`  | Your "screen this customer" action   |
| `Poll until terminal`         | A background job with backoff        |
| `Findings and coverage`       | Your review screen — **render both** |
| `10 — Refusals worth seeing`  | Your error-handling test suite       |

`examples/zquence-integration.mjs` is the same walkthrough in code:

```bash
node examples/zquence-integration.mjs --api-key <key> --name "María Fernanda Solís Rojas"
```

Generate a typed client from `openapi/openapi.json` rather than hand-writing one. The document is
generated from the contract schemas and a test fails if it drifts. **This Postman collection is
hand-written and can drift — where the two disagree, the OpenAPI document is right.**

---

## 8. Test names that exercise each case

Set `subjectName`, `subjectJurisdiction` and `subjectLanguage` in the environment, then run the
flow. Build your UI against all six before you trust it against one.

| Name                              | Juris/Lang | What your UI has to handle                    |
| :-------------------------------- | :--------- | :-------------------------------------------- |
| María Fernanda Solís Rojas        | CR/es      | A fraud charge                                |
| **Rodrigo Alberto Vargas Méndez** | CR/es      | **An acquittal alongside an investigation**   |
| Ana Lucía Jiménez Castro          | CR/es      | A conviction from two independent publishers  |
| Carlos Eduardo Rojas Mora         | CR/es      | A single early-stage report                   |
| James Whitfield Turner            | US/en      | An English-language case                      |
| Wilberth Zamora Quesada           | CR/es      | **Nothing found** — render `noMatchStatement` |

The last two rows are the ones integrations usually get wrong: an empty result is a result, and a
non-Spanish case must not fall out of your rendering.
