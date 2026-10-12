# Integrating with the adverse-search service

For an application that calls this service machine-to-machine. Written for Target Platform; nothing in
it is Target Platform-specific.

**Status:** the service runs end to end in **mock mode**. Every source is a fixture, and every
record carries `mode: "MOCK"`. What is proven today is the pipeline and the contract. Whether
this finds real adverse media about real people is not proven and cannot be until gate G10
(live sources, measured recall).

---

## The shape of an integration

```
POST /v1/subjects              → record who is being screened
POST /v1/searches              → 202 Accepted + searchId   (a receipt, not an answer)
GET  /v1/searches/{id}         → poll until execution is terminal
GET  /v1/searches/{id}/findings     → findings AND coverage, together
GET  /v1/searches/{id}/associations → the frozen FR-02 company graph
```

Use `@adverse-search/client` (in `packages/client`) rather than raw HTTP. A worked example is in
[`examples/target-platform-integration.mjs`](../../examples/target-platform-integration.mjs). The client exists
because four things are easy to get wrong and expensive when wrong; each is listed below.

Authentication is a machine API key: `Authorization: ApiKey erly_<env>_<id>_<secret>`. A key is
scoped to one tenant, one environment and a set of roles. The secret is shown once, at creation,
and is never recoverable.

---

## The four things that matter

### 1. A submitted search is not a result

`POST /v1/searches` returns **202** and a `searchId`. The run is queued.

A queued run reports `findings: NOT_EVALUATED`. Rendering that response — or any summary fetched
before the run is terminal — shows a customer something that reads as "nothing found" about a
search that has not started. `AdverseSearchClient.waitForSearch` exists for this reason, and it
**throws on timeout rather than returning the last summary**, so there is no path in which a
half-finished run is mistaken for a finished one.

Terminal states: `SUCCEEDED`, `PARTIAL`, `FAILED`, `CANCELLED`.

### 2. Findings and coverage are one answer

There is no endpoint that returns findings alone, deliberately. The response carries three
independent dimensions and they must be read together:

| Field           | Answers                                    |
| :-------------- | :----------------------------------------- |
| `execution`     | Did the job finish?                        |
| `findingsState` | Did we find anything?                      |
| `coverage`      | Did we search everything we said we would? |

`SUCCEEDED` + `NO_MATCHES_FOUND` + `INCOMPLETE` means the run finished, found nothing, **and did
not search everything it promised**. That is not a clean result and must never be presented as
one. When `findings` is empty, `noMatchStatement` says in words what was searched and what the
absence does and does not mean. Show it. It never contains the words "clear", "clean" or
"no adverse media", and your UI should not add them.

`rejectedLeads` lists candidates that were found and deliberately not promoted, each with its
reason. They are evidence of diligence, not noise.

### 3. A band is not a score

`band` is one of `CORROBORATED`, `SUPPORTED`, `AMBIGUOUS`, `COMPANY_CONTEXT`, `CONTRADICTED`,
`LEAD_ONLY`. There is **no numeric risk score anywhere in the API**, by design.

Do not rank, average, threshold or colour-scale bands into a number. A band states how well
evidence supports a connection; arithmetic on it is how "two weak leads" becomes "one medium
risk". The example renders findings in production order and explicitly does not sort by band.

Every band arrives with `axes` (the four values that produced it) and `rationale` (every rule
that fired, in order). Show them. A band on its own cannot be reviewed, only believed.

Where `attribution.isInference` is true, `attribution.statement` **must** be displayed beside the
finding: the connection rests on a role or a company association rather than on the document
naming the person.

### 4. Adverse media is not a sanctions list

A designation reported in the media is a **lead to verify against the primary list** — never a
sanctions hit, and never merged into one.

Target Platform keeps its sanctions.io integration for the primary check. Render adverse-search results
and sanctions results as separate, clearly labelled sections. A finding whose
`proceduralStage` is `DESIGNATION_SANCTION` is still an adverse-media finding about a report of
a designation; it is not the designation.

---

## Errors

`AdverseSearchError` carries `status`, `code`, `message` and `correlationId`. **Branch on
`code`** — messages are for people. Quote `correlationId` in any support conversation: it ties
your failure to this service's logs and audit trail.

Codes an integrator meets in normal operation:

| Code                                 | Means                                                |
| :----------------------------------- | :--------------------------------------------------- |
| `ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN` | The tenant is not entitled to this capability        |
| `SANDBOX_CANNOT_ACCESS_LIVE`         | A sandbox key asked for a live search                |
| `INVALID_SCOPE`                      | e.g. a former-director search with no approved scope |
| `REVISION_CONFLICT`                  | An identical idempotent request is still in flight   |
| `VALIDATION_FAILED`                  | The request body was rejected; see `details`         |

`retryable` is true for 5xx and 429. Everything else needs a changed request, not a retry.

---

## Idempotency

`POST /v1/searches` honours an `Idempotency-Key` header. Send **your own case reference**: only
you know what "the same case" means. Without a key, a retry after a network timeout creates a
second run. The client generates one if you omit it, which protects an in-process retry loop but
not a re-submission after a restart.

---

## What is not built yet

Stated plainly, because an integration planned around something that does not exist is worse
than one planned around a gap.

- **No callbacks.** Polling only. Signed webhook delivery with a receiver fixture is the other
  half of gate G9 and is not built.
- **No live sources.** Mock mode only. `mode` on every response says so.
- **No measured recall.** No language is enabled under FR-03, so every result carries
  `unmeasuredLanguages` and coverage is `INCOMPLETE`. That is the service being honest, not a
  defect to work around.
- **Syndicated copies are not yet clustered.** One story carried by two publishers currently
  produces two findings, each reporting one independent source. FR-10's clustering rules exist
  in the domain package and are not yet wired into the pipeline. Do not read
  `axes.independenceCount` as a corroboration count until that lands.
