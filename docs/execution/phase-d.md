# Phase D — Sources, association graph and taxonomy administration

**Gate:** G5 · **Status:** IN PROGRESS — D0 through D3 done, D4 next · **Prerequisite:** Phase C complete (it is)

---

## Goal

The source registry with four-eyes approval, the sourced association graph, and runtime
taxonomy administration — all versioned, all pinned to the searches that used them.

Phase C can accept a search, commit it durably and turn it into a survivable unit of work.
Nothing yet tells that work **where to look**, **under whose approval**, or **which companies
belong to the person**. This phase builds the configuration the rest of the system reads, and
the graph that decides which entities a search is even allowed to ask about.

Two properties make this phase different from the three before it. First, almost everything it
builds is **operated by a person who is not an engineer** — a `source_admin` or a
`taxonomy_admin` — so the safety of the system stops being a property of the code and becomes a
property of what the code will let an administrator do at runtime. Second, its central output
is a claim about **a specific named human being**: that this person is that officer of that
company. Every other phase can be wrong and produce a bad result. This one can be wrong and
produce a bad result _about somebody else_.

## Why this before planning and the cascade

Phase E generates the eight query families and runs the seven-rung cascade. Every one of its
inputs is built here:

- **F2 and F6 are company-anchored.** Without the graph there is nothing to anchor them to, and
  a planner written against a placeholder company list gets rewritten when the real resolution
  semantics arrive — particularly the unresolved-candidate case, which is not an edge case but
  the common one for a name-only search (D-011).
- **F3 and F5 are taxonomy-anchored**, per enabled category, per enabled language, per
  jurisdiction. The cascade cannot be bounded by a registry that does not exist yet, and
  "which sources may I ask, at which rung, under which licence" is precisely the registry.
- **The cascade logs a rung per source.** A rung with no `SourceVersion` behind it has nothing
  to log against, and coverage — the thing that stops a blocked source from reading as a clean
  result — is assembled out of per-source outcomes.

The ordering also protects the G5 exit condition itself. "A disabled category is never queried"
is only provable if the thing that decides enablement exists before the thing that queries.

## Read before starting

Narrow list. **Do not read the source specification end to end.**

| What                                             | Why                                                                         |
| :----------------------------------------------- | :-------------------------------------------------------------------------- |
| `docs/execution/handoff-log.md`                  | The last two entries. C6's notes on integration-test isolation apply here   |
| `packages/domain/src/access/permissions.ts`      | `canApprove` — four-eyes is already written and pure. Read it fully         |
| `packages/domain/src/tenure/tenure.ts`           | `labelTenure` and `isConfirmedCurrent`. D3 feeds these, never reimplements  |
| `packages/domain/src/taxonomy/types.ts`          | `TaxonomyVersion`, `isLanguageEnabled`, `enabledCategories`                 |
| `packages/domain/src/taxonomy/lexicon-audit.ts`  | `auditTaxonomy` / `assertLexiconClean` — D6 wires these into activation     |
| `apps/api/src/subjects/subjects.service.ts`      | The versioned immutable-record pattern D1 generalises to three record types |
| `apps/api/src/tenancy/entitlements.service.ts`   | `pinVersions` — the pattern D3's frozen `GraphSnapshot` follows             |
| `apps/api/src/persistence/transaction.runner.ts` | The only place a transaction opens. Activation commits through it           |
| `apps/api/src/persistence/audit.service.ts`      | Every admin action writes here (SEC-06)                                     |
| `scripts/bootstrap/seed-data.mjs`                | `SEED_SOURCES` and the `mode: "MOCK"` stamp D2 must preserve (T55)          |
| `docs/decisions.md` D-009, D-010, D-012          | The three decisions this phase must honour. D-010 is the consequential one  |
| `docs/failure-injection-matrix.md`               | D adds rows to it; read the format before appending                         |

Spec sections, only for exact wording: **FR-02** (association graph), **FR-03** (taxonomy,
exclusions, version pinning, the language rule), **FR-05** (the registry field list and the
runtime-administration paragraph — the last three paragraphs are the load-bearing part),
**SEC-05** (per-source per-field rights), **SEC-06** (audit), §4.2 (roles and four-eyes), §6.1
(the `/v1/admin/*` row), §6.3 (record list), §8 G5, and tests **T14, T15, T20, T36, T45, T79**
in §9.

---

## What already exists

Do not rebuild any of this. Three of the six steps are mostly _wiring_ pure code that is
already written and tested.

| Already built                                           | What it gives this phase                                         |
| :------------------------------------------------------ | :--------------------------------------------------------------- |
| `canApprove(approver, proposedBy, permission)`          | T45 in one call. Enforced on identity, not role                  |
| `labelTenure` / `isConfirmedCurrent`                    | All five T15 labels, with date precision widened correctly       |
| `auditLexicon` / `auditTaxonomy` / `assertLexiconClean` | T79, already gating CI. D6 adds the activation call              |
| `enabledCategories` / `isLanguageEnabled`               | The G5 exit condition, as a pure function                        |
| `permissions.ts` roles                                  | `source:propose/approve`, `taxonomy:*`, `policy:*` already exist |
| `TransactionRunner`                                     | Activation + audit + outbox commit together, with retries        |
| `AuditService`                                          | SEC-06 records, with the checkpoint seam                         |
| `failure-classification.ts`                             | FR-06 classes. D5's breaker consumes these; it invents no others |

Persisted today, and extended rather than restarted by this phase:

| Collection         | State                                                                    |
| :----------------- | :----------------------------------------------------------------------- |
| `sourceVersions`   | Two seeded fixture sources, ~9 fields. FR-05 requires roughly twenty     |
| `taxonomyVersions` | Seeded v1 active, all seventeen categories (D-009), `es`/`en` unmeasured |
| `policyVersions`   | Seeded v1 active, carrying `evidenceRetentionDays` (D-012)               |

All three are **seeded by the bootstrap and never written by the application**. There is no
admin route, no draft state, no approval path, no supersede-on-activate. That is D1.

---

## Steps

### D0 — The Costa Rica source dossier, before any adapter is written

**This step exists because of D-010 and it is the highest-risk unknown in the phase.**
Costa Rica is the only enabled jurisdiction, and **none of the free sources this plan was
written around covers it** — Companies House is UK, EDGAR and CourtListener are US. Writing a
`CompanyRegistryPort` adapter first would mean designing the graph around a registry contract
nobody has confirmed exists.

Produce `docs/sources/cr-dossier.md`. One entry per candidate from D-010's table (Registro
Nacional, Poder Judicial / Nexus PJ, La Gaceta, SUGEF/SUGEVAL/CONASSIF, Ministerio Público/OIJ,
and the press mastheads), each recording:

- what the source actually publishes, and specifically **whether officer-level company data
  exists at all** — not whether a company register exists, which is a different question;
- access method (documented API, bulk file, HTML only), and the **stability class**: documented
  and stable, versus undocumented and volatile;
- published rate limits and fair-use terms, licence/terms version, robots position;
- language and script of the published content;
- what approval would have to be recorded before activation (SEC-05), and who grants it.

**Every line in the dossier is marked `DOCUMENTED` (stated in the source's own published
terms), `INFERRED` or `UNKNOWN`. Nothing is marked verified.** No live call is made in this
phase — G10 owns live verification, and the project rule that no source has ever been contacted
live stays true. A dossier that claims verification it does not have is worse than no dossier,
because Phase E will plan against it.

**The decision D0 is likely to surface, and it should be raised the day it appears:** if no
free Costa Rican officer-level register exists, the association graph has **no data source in
the only enabled jurisdiction**. The graph machinery is still built — it is required by FR-02
and it is what makes UK/US expansion possible — but for CR it will report association coverage
as `UNKNOWN` rather than `INCOMPLETE`, and the product must say so in the coverage statement.
Raise it as a new open decision (next free number, currently **D14**) in
`docs/open-decisions.md`, naming the owner as product, not engineering. Do not quietly
substitute a paid register, and do not quietly let the graph look empty as though it had been
searched.

Also record here: the **name-frequency distribution for Costa Rican surnames** (D-011).
`NameFrequencyService` already returns `null` honestly when no distribution exists, which
applies no penalty — meaning Rodríguez currently scores like a rare name and the FR-08
frequency penalty that exists to catch exactly this never fires. The dossier names a candidate
public source for that distribution; D3 loads it.

**Done (2026-09-11), v1.** [`docs/sources/cr-dossier.md`](../sources/cr-dossier.md). No source
was contacted: search-engine queries only, no endpoint call, no page fetch, no `robots.txt`
read. Three findings change the rest of the phase, and each is written up there with its label:

1. **No free automatable officer-level source exists.** The Registro Nacional publishes
   representatives only behind free registration **and a CAPTCHA**, which is a hard stop, not an
   engineering problem. `api.hacienda.go.cr` is free and machine-readable but returns entity
   status and economic activity — **nothing about directors**. So FR-02 has no data source in
   the only enabled jurisdiction. Raised as **D14**; D4's `UNKNOWN` coverage outcome is now the
   live CR path, not a defensive branch.
2. **Published CR judgments are likely depersonalised** — the Poder Judicial runs a
   de-identification protocol, a de-personalising tool and a repository of depersonalised
   judgments. A judgment with no name in it is not a weak match, it is not a match. Raised as
   **D15**; whether any class of judgment names parties is the highest-value open question.
3. **The TSE padrón electoral is a real free source for the D-011 name-frequency prior** — with
   the constraint that it is bulk personal data: derive the aggregate counts, **discard the
   roll**, and name the use in the SEC-05 approval.

Two consequences for later phases, cheaper to know now: the real `CompanyRegistryPort` adapter
cannot be Costa Rican (use UK Companies House as the proving ground, exactly as D2 anticipated,
and consider `api.hacienda.go.cr` as a genuinely Costa Rican **corroboration** adapter — which
is not a registry), and the CR extraction path is **PDF-first**, because La Gaceta and the
Boletín Judicial are PDF publications rather than HTML articles.

**What v1 deliberately did not do:** enumerate the press mastheads with FR-05 authority tiers.
A partial masthead list invites someone to treat it as the list. The dossier's closing section
lists what the next revision must establish, in value order, and marks which of it is desk
research and which belongs to G10.

### D1 — Versioned approval: draft → propose → approve → activate, with four eyes

Three record types (`SourceVersion`, `TaxonomyVersion`, `PolicyVersion`) share one lifecycle.
**Write it once.** Three copies of an approval workflow drift, and the copy that drifts is the
one whose T45 test nobody wrote.

`apps/api/src/admin/versioned-approval.service.ts` — generic over the record type:

- A **draft** is mutable and belongs to its proposer. An **active** version is immutable;
  editing it creates a new draft.
- Activation calls `canApprove`, then commits the new active version, the supersede of the
  previous one, the `AuditEvent` and any `OutboxEvent` **in one transaction** through
  `TransactionRunner`.
- `SUSPENDED` is reachable from `ACTIVE` and does **not** require four eyes. Suspension is a
  safety action; requiring a second person to stop using a bad source is how a bad source stays
  live over a weekend. Re-activation does require four eyes.
- Every transition writes an audit entry with actor, target, version, **reason** and result. A
  reason is required on approve, suspend and restore; an approval with no reason is a 422, not
  a nullable column.

Routes, per §6.1 — `/v1/admin/sources`, `/v1/admin/policies`, `/v1/admin/taxonomy`, each with
draft / version / approve / activate / suspend. Permissions come from `permissions.ts` as they
stand; do not add roles.

**`SourceVersion` gets the full FR-05 field list**, not the seeded subset: source ID, source
type, publisher, canonical domains, authority tier 1–5, countries (**ISO alpha-2 only — "EU",
"MENA" and "SEA" are not source permissions and must fail validation**), languages, access
method, credentials _reference_ (never a secret), free-tier hourly and daily budget, stability
class, parser version, freshness state, licence/terms version, approval state and kill switch.

Note what is deliberately **not** on it: the reliability profile. See D5.

**The second half of D1 is the SEC-05 rights engine**, and it is easy to mistake for a display
concern. It is a pure decision function — put it in `packages/domain/src/rights/` next to
`permissions.ts`, for the same reason: the same decision is made by the API, the worker, the
exporter and the indexer, and one place is the only way it stays consistent.

```
decideFieldUse({ source, field, operation, region }) -> Allowed | Denied(reason)
```

Operations: collect, process, store, **model disclosure**, display, export, retention,
permitted regions. **Unknown operations default to deny.** "Publicly accessible" is not
approval for every use — a source may permit display and forbid export, or permit storage in
one region only. Model disclosure is its own operation because sending evidence text to an
extraction model is a disclosure to a third party even when the model runs locally today, and
Phase F will want that decision to already exist.

**Done (2026-09-11).** `apps/api/src/admin/` holds `VersionedRecordService` (one lifecycle for
all three kinds), `CapabilityCoverageService` and `AdminController`; the pure decisions are
`packages/domain/src/lifecycle/versioned-lifecycle.ts`, `rights/rights.ts` and
`capability/capability.ts`. Reasoning in `docs/decisions.md` **D-018**, **D-019** and **D-020**;
mechanics in `docs/architecture.md` under "Administrative records and the rights gate".

Six things worth not re-deriving:

1. **The lifecycle writes the records that already exist.** `sourceVersions` keys on
   `{sourceId, version}` and `taxonomyVersions`/`policyVersions` on `{tenantId, version}`, with
   the lifecycle in a `status` field. A taxonomy's identity is therefore **the tenant**, not a
   free-chosen id — `pinVersions` depends on one taxonomy timeline per tenant. A parallel
   `recordId` scheme was tried first and collided with both unique indexes.
2. **Activation is two transitions**, so a refused activation leaves the clearance on the record
   and falls back to `APPROVED` rather than vanishing into an `if`.
3. **A denial must be audited outside the transaction that refused.** Appending it inside means
   it is rolled back with the abort, and the refusal leaves no trace — found by asserting the
   audit entry existed rather than asserting the 403.
4. **Suspension takes one person, restoring takes two**, and restoring re-enters at `ACTIVATING`
   so an expired licence cannot be restored past.
5. **Every version the service writes is stamped `MOCK`/`LIVE`** (T55). A version proposed through
   the API in a mock stack is as much a fixture as a seeded one.
6. **`ReservedController` must be registered before `AdminController`** or `/v1/admin/:collection`
   shadows the reserved `/v1/admin/plans`. There is a test for it.

**What D1 deliberately did not do:** `SourceVersion`'s FR-05 field list exists as a validated
contract schema (`sourceContentSchema`), but the service stores version content as an opaque
object and does not yet require sources to conform to it — that lands with D2, when the adapters
that consume those fields exist and can say which are load-bearing. `SourceHealth`, budgets and
the breaker are D5, and the reliability profile is deliberately **not** on the immutable version.

### D2 — The six ports, free adapters, and deterministic mocks

Define **all six** FR-05 seams now — `NewsDiscoveryPort`, `WebDiscoveryPort`,
`PrimarySourcePort`, `CompanyRegistryPort`, `EvidenceFetchPort`, `ExtractionModelPort` — and
implement **deterministic mock counterparts for all six**, but only one real adapter:
`CompanyRegistryPort`, because it is the only one the graph needs and the only one whose real
contract this phase can settle.

**Do not build discovery or fetch adapters here.** Those are Phase E, behind these same seams,
and building them now means building them before the cascade, the budgets, the breakers and
the egress identities they have to cooperate with.

Mock rules, all of which have bitten this project before:

- **Deterministic**: the same input returns the same result, including ordering. A mock with
  incidental ordering makes a graph test flaky in a way that looks like a resolution bug.
- Every record produced carries `mode: "MOCK"` (T55), and mock adapters are unreachable in live
  mode by construction, not by a runtime check that can be forgotten.
- The fixtures **are** the test corpus for D3 and D4, so author them against the tests:
  **T14** needs two officers who genuinely share a name, with different identifiers and
  different companies; **T15** needs directorships producing all five tenure labels, including
  one with an appointment date at `YEAR` precision and one with no resignation date at all;
  **T20** needs a registry that can be made to fail, to return zero results, and to exceed the
  graph bound — three different outcomes that must not collapse into one.
- Every adapter declares its **parser version** and **stability class**, which is what D5's
  volatility handling and Phase E's contract tests key off.

If D0 concludes a real free CR registry adapter cannot be written, `CompanyRegistryPort`'s real
implementation is a **UK Companies House adapter** used as the proving ground for the port and
the graph, explicitly labelled as out-of-jurisdiction for the current tenant and **not enabled
for CR searches**. Say that plainly in the handoff rather than letting a UK adapter look like
coverage.

### D3 — Sourced identity resolution, edges, tenure, and the frozen snapshot

Records: `Company`, `AssociationAssertion`, `GraphSnapshot`.

**Resolution is an identity grade, not a string comparison.** An officer record matches the
subject only through the same corroboration reasoning FR-08 Axis A uses — name form plus at
least one disambiguating attribute. A name match alone yields `UNRESOLVED`, and that is the
expected outcome for a name-only search (D-011), not a failure to handle later.

Every `AssociationAssertion` stores, per FR-02: source, jurisdiction, company identifier,
appointment date, resignation date, **date precision on each**, observed date, and resolution
status. Tenure labels come from `labelTenure`; the default scope is `isConfirmedCurrent` only,
and former-director search is selectable only under an approved historical scope.
**An unknown end date is not a current directorship** — this is the single most common way a
company event is attached to a person who had already left, and it must have its own test, not
just a branch inside a bigger one.

The `GraphSnapshot` is **frozen at search start and pinned to the run**, exactly as
`pinVersions` pins entitlement, taxonomy and policy versions. A registry correction next month
must not rewrite what a historical search explained, and a refresh produces a _new_ linked
snapshot rather than mutating the old one. `GET /v1/searches/{searchId}/associations` serves
the frozen graph: edges with tenure labels, unresolved candidates, and the scope that was
omitted.

D3 also loads the **Costa Rican name-frequency distribution** identified in D0 into
`nameFrequencyProfiles`. Note the existing convention and do not break it: that collection is
deliberately **shared, not tenant-owned** — population data is not customer data, and making it
tenant-owned means re-measuring the same surname once per customer.

### D4 — Bounds, unresolved candidates, and person-only degraded execution

One-hop traversal with configurable bounds: maximum companies per subject, maximum officers
considered per company, maximum edges in a snapshot. **When a bound binds it is recorded and
surfaced**, in the same spirit as `TRUNCATED_BY_PLAN` — a silently truncated graph is a
narrower search reported as a complete one.

Three outcomes that must stay distinguishable in `SourceCoverageOutcome`, because collapsing
them is the T20 failure:

| Outcome      | Meaning                                                                      |
| :----------- | :--------------------------------------------------------------------------- |
| `COMPLETE`   | The registry answered and the answer was within bounds                       |
| `INCOMPLETE` | We asked and something failed, or a bound bound. Names the source and reason |
| `UNKNOWN`    | We never asked — no approved registry exists for this jurisdiction at all    |

**`UNKNOWN` is the Costa Rica case** if D0 concludes what it may well conclude, and reporting it
as `INCOMPLETE` would imply an attempt that never happened. Neither is ever `NO_ASSOCIATIONS`:
no result from a registry does not prove no associations exist.

Degraded execution: a registry outage does not fail the search. Person searching continues, the
run completes, and association coverage reports accurately. An **unresolved officer never
attaches a company automatically** — the company surfaces as a candidate for review, and
nothing anchors a query to it (T14).

### D5 — Source health: reliability profile, breaker, kill switch, mid-run suspension

**The trap to avoid first.** The reliability profile — observed availability, latency, block
rate, breaker state — is continuously changing runtime observation, and `SourceVersion` is an
immutable approved artefact. Putting one inside the other forces a choice between breaking
immutability and losing the data. Keep a separate mutable `SourceHealth` document keyed by
`sourceId`, referencing the version it observed. The approved version says what is _permitted_;
health says what is _happening_.

- Breaker states and transitions consume the existing FR-06 classification table. Do not invent
  a second taxonomy — a soft block, a hard block and a content error already have different
  policies, and three of the five classes do not retry at all.
- Budgets from D1 (free-tier hourly and daily) are enforced here as counters, and exhaustion is
  a coverage outcome, not an error.
- **The kill switch takes effect mid-run (T36).** A run pins a source version at plan time; it
  must **recheck access at the point of use**, not only at plan time, or a source suspended for
  a rights violation keeps being fetched for the length of every in-flight run. The blocked
  action is recorded as a coverage gap naming the suspension — never silently skipped.
- **Licence expiry behaves exactly like a kill switch.** T36 names it explicitly.
- T36 also says _"or after result"_: a result produced under a source that is later suspended is
  **not** retro-actively deleted, but a subsequent read of it must show that the source has
  since been suspended. Decide where that surfaces — coverage view, evidence metadata, or both
  — and write the decision down.

Append the two new boundaries to `docs/failure-injection-matrix.md` in its existing format:
registry read → snapshot commit (what a crash between them orphans, and what reconciles it),
and source suspension → in-flight run (what the run does with work already dispatched).

### D6 — The lexicon audit on the activation path, and the Spanish lexicon itself

`assertLexiconClean` already fails CI. D6 makes it fail **activation**, so a taxonomy edited at
runtime by a `taxonomy_admin` cannot introduce a protected-characteristic term that CI would
have caught (T79). Blocking at activation, warning at draft save: an admin should see the
problem while editing, but the enforcement point is the transition that makes it queryable.

Activation must also refuse two things that are easy to let through:

1. **Enabling a language with no measured recall figure.** FR-03 and D-010 are explicit, and
   the seed deliberately carries `es` and `en` as _requested, unmeasured_. An admin toggle that
   flips that to enabled would erase the distinction the whole coverage statement rests on.
   `measuredRecall` is settable only by an evaluation run (FR-16), never by an admin edit.
2. **A category enabled for a country with no approved source coverage** — enablement without
   sources produces a category that is searched for and never found, which reads to a reviewer
   as a clean result for that category.

Then expose the pure resolution Phase E will consume — the effective scope of a search given a
taxonomy version and a country — so that "a disabled category is never queried" is provable
here rather than being an assertion about code that does not exist yet.

**The part that is not engineering work, and must be started on day one of the phase.** D-010
records that the Spanish lexicon **cannot be machine-translated**: the usable Costa Rican
Spanish terms for "charged" or "indicted" are not dictionary translations of the English words,
and the strategy document requires terms authored or reviewed by someone who reads the
language. This is a Phase D deliverable that needs **a Spanish-reading reviewer**, not an
engineer with a dictionary. Identify that person in week one. If no reviewer is available, the
honest outcome is that `es` ships with no conduct terms and the coverage statement says the
Spanish lexicon is unreviewed — which is bad, and is still far better than a machine-translated
term list that silently misses every real Costa Rican court report while looking fully
configured.

---

## Definition of done

- [x] D0 — `docs/sources/cr-dossier.md` exists; every claim labelled `DOCUMENTED` / `INFERRED` / `UNKNOWN`; no live call made; the CR officer-data question raised as **D14**, and the depersonalised-judgments question as **D15**
- [x] D1 — one versioned-approval service serving sources, taxonomy and policy; draft mutable, active immutable, suspend without four eyes, restore with; reason required and audited
- [x] D1 — the full FR-05 field list exists as `sourceContentSchema` and alpha-2 validation rejects "EU" / "MENA" / "SEA"; **conformance is enforced as of D2** at submit and at activation (decision D-023)
- [x] D1 — the rights engine is `decideRights` / `clearForActivation` in `packages/domain/src/rights/`, default-deny, with model disclosure as its own operation, and prohibited collection methods non-approvable (named `decideFieldUse` in the outline)
- [x] D2 — all six ports defined; deterministic mocks for all six; one real `CompanyRegistryPort` adapter (UK Companies House, **GB only, not CR coverage**); every record carries `mode: "MOCK"` where applicable, and a mock cannot be constructed in live mode at all (decision D-022)
- [x] D3 — `Company`, `AssociationAssertion`, `GraphSnapshot`; resolution is an identity grade through Axis A (decision D-025); the snapshot is created in the search-creation transaction and never rewritten (D-026); `GET /v1/searches/{searchId}/associations` serves it
- [~] D3 — **absence recorded, which is the branch the brief allows.** No distribution is loaded: the TSE padrón needs the SEC-05 aggregate-only approval (D-011), which does not exist. `scripts/bootstrap/name-frequency.mjs` is the loader, refuses to invent data, and prints the gap and its cost on every bootstrap; the decile derivation is pure and tested
- [ ] D4 — configurable one-hop bounds, visible when they bind; `COMPLETE` / `INCOMPLETE` / `UNKNOWN` kept distinct; person-only degraded execution
- [ ] D5 — `SourceHealth` separate from the immutable version; breaker over the FR-06 classes; budgets enforced; kill switch effective **mid-run**; licence expiry equivalent
- [ ] D5 — two new rows appended to `docs/failure-injection-matrix.md`
- [ ] D6 — lexicon audit blocks activation; a language cannot be enabled without a measured recall figure; effective-scope resolution exposed for Phase E
- [ ] D6 — Spanish lexicon reviewed by a Spanish reader, **or** its unreviewed state recorded in the coverage statement and the handoff
- [x] **T14** — two officers share a byte-identical name; the contradicted one is excluded, the near match is a `CANDIDATE_FOR_REVIEW` that attaches nothing, and only a second independent signal resolves either. Asserted in the pure resolver and against the real replica set
- [x] **T15** — all five tenure labels; `YEAR`-precision appointment and missing resignation stored with their precision and never backfilled; approved historical scope enforced and refused without the entitlement (D-027)
- [~] **T20** — outage, empty answer and bound overrun are three distinct statuses, tested separately, and each produces its own honest coverage on the snapshot without throwing. **That the person search itself completes in all three is D4**, when there is a run to complete
- [ ] **T36** — a source suspended mid-run stops being used within that run; blocked actions and coverage gaps reported; a result produced before suspension is unchanged but reads as sourced from a since-suspended source
- [x] **T45** — the proposer of a source, taxonomy or policy version cannot approve it; the denial is audited (and the audit survives the aborted transaction)
- [ ] **T79** — a protected-characteristic term fails the build **and** is refused at activation
- [ ] `pnpm openapi:generate` re-run and `openapi/openapi.json` committed, so the panel's generated client sees the admin routes
- [ ] `verify:local` reports every suite green except end-to-end, which stays `[n/i]` and still exits non-zero
- [ ] `docs/implementation-status.md` moves G5 to Complete with the commands as evidence
- [ ] `START-HERE.md` active-phase pointer moved to Phase E
- [ ] Handoff entry written

## Do not

- **Do not build the cascade, the planner or any fetch.** The seams are defined here; Phase E
  fills them. A discovery adapter written before the budgets, breakers and egress identities it
  must cooperate with gets rewritten.
- **Do not make a live call to any candidate source.** G10 owns live verification. The dossier
  records documented claims, marked unverified.
- **Do not attach a company from an unresolved officer**, however strong the name match. This
  is the one failure in this phase that harms a person who was never searched for.
- **Do not treat a missing resignation date as proof of a current directorship** (FR-02).
- **Do not put the reliability profile on the immutable `SourceVersion`.**
- **Do not let an admin enable a language without a measured recall figure**, or flatten
  "requested" into "enabled" anywhere in the registry, the API or the panel contract.
- **Do not allow free-form connector configuration**: no executable code, no SQL or JavaScript
  snippets, no unrestricted fetch URLs, no unapproved model endpoints (FR-05). Runtime
  administration selects from reviewed connector types and validated domain configuration — a
  text field that becomes a URL that becomes a fetch is an SSRF hole with an approval workflow
  in front of it.
- **Do not reimplement** `canApprove`, `labelTenure`, `isConfirmedCurrent`, the FR-06
  classification table, or the lexicon audit. All five are written, pure and tested.
- **Do not define Phase E and F records** — `QueryPlan`, `QueryExecution`, `EgressIdentity`,
  `EvidenceSpan`, `Assertion`, `Event`, `Finding` — because the schema feels incomplete. C1 held
  this line and it was right: records are defined with the code that produces them.
- **Do not borrow seeded `tenant-alpha` state in a new integration suite.** C6 learned this the
  expensive way: it broke a test in another file. Seed the suite's own tenant and delete it.

## Decisions

**None close at G5.** The three this phase was once meant to close — D1 (jurisdictions and
languages), D3 (categories on by default) and D8 (retention) — all closed on 2026-09-11 as
D-010, D-009 and D-012. This phase's job is to **honour** them, which is different work and
easier to skip:

- **D-010** — CR only, with `es` and `en` _requested but not enabled_. The registry, the
  taxonomy admin and the API must keep that distinction visible. D-010 also makes CR source
  discovery the critical path of this phase, which is why D0 exists.
- **D-009** — all seventeen categories on by default. D6 wires the lexicon audit into activation
  so a runtime edit cannot introduce what CI would have caught.
- **D-012** — retention configurable per policy version, 30-day default, legal hold overriding.
  Phase C built the deletion machinery; D1's `PolicyVersion` and D5's per-source rights give it
  the values that make it mean something.

**Raise early, do not wait for Phase E: D6 — how robots exceptions for official sources are
approved and recorded.** It is due at G6, but it is shaped by the registry built here and it
needs a source admin rather than an engineer. Raising it at the start of Phase E is raising it
too late to influence the record it has to live in. The registry field that carries it should
exist before the first source version is approved, or every existing version needs revising.

**Expect to open D14** (what feeds the association graph in Costa Rica) from D0, and possibly a
second on who reviews the Spanish lexicon and by when. Record both in `docs/open-decisions.md`
with a named owner outside engineering. An open decision with no owner acquires a silent
default, which is the one thing `START-HERE.md` rule 6 forbids.

## Known risks

| Risk                                                                                     | Mitigation                                                                                                                                                      |
| :--------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D0 concludes there is no free CR officer register, and the phase feels blocked           | It is not blocked. Build the graph, prove it on a UK adapter, and report CR association coverage as `UNKNOWN`. The honest gap is the deliverable                |
| The graph looks correct against mocks authored by the same person who wrote the resolver | Author the fixtures from the test catalogue (T14, T15, T20) before writing the resolver, not after                                                              |
| Four-eyes is enforced in the service but bypassable by a direct repository write         | Enforce it at the one activation path and keep every other writer out of `status: ACTIVE`. Test by attempting the bypass, not only the happy path               |
| Mid-run suspension passes because the test run is too short ever to recheck              | The T36 test must suspend the source **after** dispatch and **before** the next point of use, at the seam. A fast happy path proves nothing                     |
| The rights engine becomes a display filter                                               | SEC-05 is enforced at collection, processing, storage, model disclosure and export — not at render. Test the export and index paths specifically                |
| The Spanish lexicon is quietly machine-translated to unblock the phase                   | Explicitly forbidden by D-010. Shipping `es` with no conduct terms and saying so is the acceptable degraded outcome; a plausible-looking translated list is not |
| Admin routes grow their own ad-hoc permission checks                                     | Every route decides through `decideAccess` / `canApprove`. A second authorisation path is how `platform_operator` eventually reads evidence                     |

## Expanding this brief further

It is now a brief, not an outline. Three things are deliberately left to the step that does
them, because they depend on what that step finds:

- the exact field list of `AssociationAssertion` and `GraphSnapshot`, which follows from what D0
  establishes a real registry actually publishes;
- the identity-grade threshold at which an officer is `RESOLVED`, which should be set against
  the D2 fixtures and the FR-16 corpus rather than chosen in advance;
- where a since-suspended source surfaces on a historical result (D5), which depends on how the
  coverage view is assembled.
