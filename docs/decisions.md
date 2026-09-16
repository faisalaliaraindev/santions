# Decisions

Architecture decisions with their rationale. Every entry names what was decided, why, and
what it costs. A decision without a cost stated is usually a decision that was not made.

---

## D-001 — Two repositories, not the single monorepo the plan assumes

**Status:** Accepted · **Gate:** G0

The implementation plan (section 3.2) specifies one repository containing `apps/api`,
`apps/worker`, `apps/control-panel` and `packages/*`. The workspace provided is two
repositories:

| Repository                       | Contents                                                                |
| :------------------------------- | :---------------------------------------------------------------------- |
| `erly-sanction-service-backend`  | `apps/api`, `apps/worker`, all `packages/*`, `infra/*`, `tests`, `docs` |
| `erly-sanction-service-frontend` | the React control panel (plan's `apps/control-panel`)                   |

**Why:** the repositories already exist with their own remotes and are how the team has
chosen to split ownership and deployment. Collapsing them into one repository would discard
that choice for a structural preference in the plan.

**Cost, and how it is paid:** the plan requires the control panel to use "the same business
API as external clients" and forbids a second matching engine in the browser. Across two
repositories that is no longer enforced by a shared import — it has to be enforced
deliberately:

- `packages/contracts` generates the OpenAPI document; the frontend generates its typed
  client from that document and commits the generated output. The frontend has no other
  route to the API.
- The frontend depends on no domain package. Banding, identity resolution and stage logic
  live only in `packages/domain` and reach the browser only as API responses. A lint rule in
  the frontend forbids importing `@erly/adverse-domain`.
- The G9 contract tests run against the generated client, so a backend contract change that
  breaks the panel fails the backend build rather than being discovered in the browser.

Revisit if contract drift between the repositories causes a released defect.

---

## D-002 — Search index: Meilisearch, confirmed by the C4 workload measurement

**Status:** Accepted · **Gate:** G4 · **Closed:** 2026-09-11 · **Closes D12**

The plan requires a self-hosted search index (OpenSearch or Meilisearch) and requires the choice
to be recorded here **with workload evidence**. Meilisearch was carried from G1 as a working
assumption for its smaller local footprint, explicitly not as a decision.

The switch condition this entry set for itself was specific: **OpenSearch if the matcher needs
custom analysers or multi-field boolean scoring that Meilisearch cannot express.** That condition
was tested in C4 and **was not met**.

Full report: [`docs/measurements/c4-search-index.md`](./measurements/c4-search-index.md). Rerun
with `pnpm bench:search-index`. The figures, at 100,000 subjects, 1,050 samples per strategy:

| Strategy                                  | matcher p95 |    recall |
| :---------------------------------------- | ----------: | --------: |
| naive (raw name, one query)               |      4.33ms |     67.6% |
| expanded (FR-08 forms, one at a time)     |     11.20ms |     95.2% |
| **batched (FR-08 forms, one round trip)** |  **7.05ms** | **95.2%** |

What decided it:

1. **The matcher does need multi-field retrieval.** Retrieving on the raw name loses recall as
   the population grows — 81.9% at a thousand subjects, 67.6% at a hundred thousand — because
   the top _k_ fills with lookalikes. `PARTICLE` recall collapses from 100% to 6.3% over that
   range, and `INITIAL_EXPANSION` sits at 6.3% at every size.
2. **Meilisearch expresses it.** The FR-08 forms issued as one batch hold recall flat at 95.2%
   for 6.35ms p95 retrieval, and that figure is flat from 1,000 to 100,000 subjects (5.65 →
   6.35ms). No custom analyser was needed; the derived name forms the index already stores are
   what supplies the behaviour.
3. **The index is not the cost.** Composed total search latency at 100,000 subjects is ≈132ms,
   of which the matcher is 5.23ms — **4%**. The rest is API acceptance, and three quarters of
   _that_ is the request waiting on the index write (see D-014).

**Cost of the decision:** measured over 100,000 subjects, not 10⁷; single-client latency with no
concurrency test; the `documents` index untested because nothing extracts text yet (Phase F); and
the non-Latin path unmeasured, because the only `TransliterationPort` implementation is
`identityTransliteration` and a Cyrillic or Arabic query is therefore never expanded into the
Latin forms the index holds. `TRANSLITERATION` recall is 0% for every strategy and **that figure
says nothing about Meilisearch.** D12 is closed on the seven name forms that could be measured.

**Re-open if:** a real transliteration provider lands and non-Latin recall is poor (the likeliest
and most consequential); the `documents` index needs analysers or field boosting Meilisearch
cannot express; or a population beyond ~10⁶ subjects or a concurrency test shows degradation the
flat curve does not predict.

The `SearchIndexPort` seam stays exactly as it is. It cost little, it made this decision
measurable rather than theoretical, and the re-open triggers above are real.

---

## D-003 — Node 22 LTS, not the Node 24 planning baseline

**Status:** Accepted · **Gate:** G1

The plan names Node 24 as the _planning_ baseline and instructs verification of supported
status at implementation time. Node 22 is the current Active LTS and is what this project
pins (`engines: >=22.12.0 <25`).

**Why:** LTS is the supported line for a service that will carry regulated data. The upper
bound admits Node 24 so the runtime can move without a package change once 24 enters LTS.

---

## D-004 — The domain core and the evaluation harness perform no I/O

**Status:** Accepted · **Gate:** G2

`packages/domain` and `packages/evaluation` contain pure functions and types only: no
database, no network, no filesystem, and no clock reads (callers pass `asOf` explicitly).

**Why:** the plan requires `pnpm test:invariants` to run the I1-I10 release gate with no I/O
dependency (section 11), and requires that gate on every pull request (section 10.4). A
harness that needs a database running is a harness that gets skipped.

**Cost:** ICU transliteration, libpostal and the NER model cannot be imported by the domain
package. They are injected through ports — see `TransliterationPort` in
`packages/domain/src/identity/transliteration.ts`. `matchNameForms` therefore cannot match
across scripts on its own, and its tests assert that it returns `NO_MATCH` rather than
pretending otherwise.

---

## D-005 — The seed dataset carries axis inputs, not only ground-truth labels

**Status:** Accepted · **Gate:** G2

Each `LabelledCase` carries a `scenario` holding the Axis A/B/C inputs and the clustered
sources a real pipeline would produce, alongside the label describing what a reviewer
decided.

**Why:** G2 must execute I1-I10 before any I/O exists, so the harness needs runnable inputs.
At G7 the same labels are re-applied to axis inputs produced by the real extraction and
classification path and the identical harness runs against them — which is how the G7 exit
condition "I1-I10 pass against real pipeline output, not only against the G2 fixtures" is
actually verified rather than asserted.

---

## D-006 — The event-date cluster bucket is a blocking hint, not cluster identity

**Status:** Accepted · **Gate:** G2

`EventClusterKey.eventDateBucket` is a fixed epoch-aligned bucket used to decide which
candidates are _compared_. It is excluded from `serialiseClusterKey`, and the merge decision
uses `withinEventWindow` on the real dates.

**Why:** this was found by a test during G2. Fixed buckets have a boundary problem: two
reports of the same event dated 14 and 20 May can fall either side of a 30-day boundary and
never be compared. Using the bucket as identity would silently split events — and a split
event under-counts independence, which feeds Axis D and therefore the band.

Index lookups must scan `adjacentBuckets(key)` — the bucket and both neighbours — not the
single bucket.

---

## D-007 — FR-15 commercial layer reduced to structural seams

**Status:** Accepted (carried from the plan) · **Gate:** G3

Per FR-15, this phase builds `Tenant`, `ServiceCapability`, `TenantEntitlementVersion`,
entitlement pinning, the capability check and environment-scoped API key records. It does
**not** build plan CRUD, the usage ledger, overage rules, provider commercial screens or
tenant self-service key management.

Reserved endpoints return `501 Not Implemented`. Tests T61-T70 are retained in
`docs/requirements-traceability.md` as a named deferred set referencing this decision, so
the gap stays visible rather than being forgotten.

---

## D-008 — The band is an evidentiary statement, not a statement of adversity

**Status:** Accepted · **Gate:** G2 · **Related open decision:** D11

A well-evidenced acquittal bands as `CORROBORATED`. This looked wrong when the seed dataset
first disagreed with the banding engine, and it is worth stating explicitly because the label
is easy to misread.

`CORROBORATED` answers "how well does the evidence support the connection between this
subject and this reported matter". For an acquittal reported in a Tier 1 court record naming
the subject with a matching date of birth, the answer is: very well. What is corroborated is
an acquittal.

The fairness is carried by the two attributes displayed alongside the band — the procedural
stage (`ACQUITTAL_DISMISSAL_OVERTURNED`, whose mandatory display rule requires equal
prominence) and the outcome status (`RESOLVED`). Invariant I7 tests that the acquittal
attaches and is never suppressed.

The residual risk is presentational: a reviewer scanning a list of bands without reading the
stage could misread `CORROBORATED` as "confirmed adverse". Open decision D11 records the
question of whether the results list must therefore render stage and outcome status at the
same visual weight as the band, and it must close at G8.

See `packages/evaluation/src/dataset/seed.ts`, case `C011`.

---

## D-009 — All seventeen adverse categories enabled by default

**Status:** Accepted · **Closes open decision D3** · **Decided by:** product, 2026-09-11

Every category in the FR-03 taxonomy is enabled, rather than a conservative subset.

**Why:** it is far easier to notice an irrelevant finding and switch a category off than to
discover months later that a whole class of conduct was never searched for. A disabled
category is invisible in the results — nothing tells a reviewer that violent crime was never
looked for, only the coverage statement, which is easy to skim past.

**What it does not mean.** "All categories" is not "anything goes". The FR-03 exclusion list is
enforced at classification time regardless: political opinion and lawful activism, protected
characteristics, private life absent misconduct, ordinary civil litigation, victim and witness
status, spent matters, conclusively identified namesakes, and satire all remain excluded. The
build-gating lexicon audit still fails if any query term maps to a protected characteristic.

**Cost:** more findings per search, so more reviewer time. Revisit per tenant if the review
queue proves unmanageable — that is a threshold conversation (open decision D5), not a reason
to disable a category silently.

---

## D-010 — Costa Rica first, in Spanish and English

**Status:** Accepted · **Closes open decision D1** · **Decided by:** product, 2026-09-11

The first clients are in Costa Rica. `CR` is the only enabled jurisdiction; `es` and `en` are
the requested languages.

**A distinction that matters, and is enforced in the seed data:** _requested_ is not _enabled_.
FR-03 permits a language only once it carries a measured recall figure from the evaluation set.
Neither Spanish nor English has one, so both are seeded with `measuredRecall: null`, and every
coverage statement must declare them unmeasured until Phase H (G10) measures them. This records
intent, not capability.

### The consequence that needs owning: the free-source stack is UK/US, not Costa Rican

Every free source named in the implementation plan — Companies House, SEC EDGAR, CourtListener
— is a UK or US source. **None of them covers Costa Rica.** Choosing CR first therefore makes
Costa Rican source discovery the critical path, not a detail of Phase D.

Candidate sources to investigate and verify at G5/G10 (none verified, none approved):

| Need                                           | Candidate                                          |
| :--------------------------------------------- | :------------------------------------------------- |
| Company and officer register                   | Registro Nacional de Costa Rica                    |
| Court records and judgments                    | Poder Judicial — Nexus PJ                          |
| Official gazette, insolvency, disqualification | La Gaceta / Imprenta Nacional                      |
| Financial conduct regulator                    | SUGEF, SUGEVAL, CONASSIF                           |
| Prosecutor releases                            | Ministerio Público / OIJ                           |
| Spanish-language press                         | Regional and national mastheads, per FR-05 tiering |

Each needs its contract verified, rate limits measured, robots position confirmed and rights
approval recorded before activation. **Assume none of them behaves like the UK and US APIs the
plan was written around**, and treat officer-level data availability as an open question rather
than an assumption.

### The Spanish lexicon cannot be machine-translated

The Adverse Search Strategy is explicit (§6.2): term lists are authored or reviewed by someone
who reads the language, because legal register differs — the usable Spanish terms for "charged"
or "indicted" in Costa Rican reporting are not dictionary translations of the English words.
This needs a Spanish-reading reviewer, and it is a Phase D deliverable, not a translation task.

---

## D-011 — Minimum identity input is a name

**Status:** Accepted · **Closes open decision D10** · **Decided by:** product, 2026-09-11

An integrating application must supply a full name. Everything else — date of birth, country,
aliases, known companies — is optional. This is what the FR-01 subject schema already
implements, so no rework follows; the decision confirms the built behaviour rather than
changing it.

**What this means in practice, and it should be said plainly:** a name-only search cannot
resolve identity. Under FR-08 Axis A, a name with no corroborating identifier grades `WEAK` at
best, which caps the finding at `AMBIGUOUS`. That is the system working correctly — the
alternative is inventing confidence it has no basis for — but it means **most name-only
searches will return unresolved potential matches rather than confident ones**, and the review
burden lands on a human.

Two consequences worth planning for:

1. **Reviewer workload is set by this decision**, more than by any threshold. It feeds directly
   into open decision D5 (the reviewer capacity assumption thresholds are set against).
2. **A Costa Rican name-frequency distribution is now worth loading.** `NameFrequencyService`
   is built and returns `null` honestly when no distribution exists, which applies no penalty.
   Common Costa Rican surnames — Rodríguez, Jiménez, Vargas, Mora, Solís — will otherwise be
   treated as no more common than rare ones, and the FR-08 frequency penalty that exists to
   catch exactly this will never fire. Sourcing that distribution is a Phase D work item.

Anything beyond a name that Zquence _can_ supply materially improves resolution and should be
sent when available, even though it is not required.

---

## D-012 — Evidence retention is configurable, defaulting to 30 days

**Status:** Accepted · **Closes open decision D8** · **Decided by:** product, 2026-09-11

Retention lives on the policy version as `evidenceRetentionDays`, not in code, so it can be
revised without a deployment and a historical search still explains itself under the retention
that applied when it ran. The agreed starting figure is 30 days.

**This is an operational default, not a legal conclusion.** It has not been reviewed against
Costa Rican data-protection requirements, and SEC-05 requires country enablement to follow
documented privacy and content-rights approval. That approval is still outstanding.

**What implementing it involves — more than a TTL index (SEC-05):**

- deletion must propagate to the **search index** and to any generated exports, not only the
  primary record;
- a **legal hold** overrides expiry, and must be recorded and auditable;
- backups need expiry too, and restoring one must reapply deletion and suppression records —
  otherwise restoring a backup silently resurrects deleted evidence;
- audit records retain minimal permitted facts rather than duplicating evidence text
  indefinitely.

Thirty days is short enough that this must work correctly early rather than being deferred: it
becomes load-bearing within a month of the first real search.

---

## D-013 — The search index gets a batch query, because the measurement asked for one

**Status:** Accepted · **Gate:** G4

`SearchIndexPort.searchSubjectsBatch` issues several subject queries in one round trip, results
returned **positionally**.

Added as a consequence of C4 rather than in anticipation of it. The FR-08 matcher cannot use a
single query — see D-002 — so its real access pattern is one query per name form, every time.
Issued sequentially those cost a round trip each (11.20ms p95 matcher); batched they cost 7.05ms
for identical results, so the sequential version spends 40% of matcher latency on round trips
that buy nothing.

Positional rather than merged: which form produced a hit is evidence the matcher uses to decide
what the agreement is worth (FR-08). Merging here would discard it and force every caller that
needs it to issue the queries separately again.

**Cost:** a third search method on the port, which every adapter must implement. `InMemorySearchIndex`
implements it as a loop — there is no round trip to save in process — but keeps the positional
shape exactly, because a test that passes against a fake with a different shape proves nothing
about the adapter it stands in for.

---

## D-014 — Search acceptance waits for the index write, and that is now a known 94ms

**Status:** Open · **Gate:** G8 · **Raised by:** C4

`POST /v1/searches` takes **127ms p50** against Meilisearch and **33ms p50** against the
in-process index. The difference — roughly 94ms, about three quarters of acceptance latency — is
the request waiting for the post-commit index write to become searchable.

Nothing here is a defect. C3 established that a write is not `INDEXED` until the index confirms
it is searchable (marking on enqueue would record a document as indexed while the matcher cannot
see it — the FI-10 symptom). `SearchesService.create` honours that, after the commit and outside
the transaction, and does not fail the request if the index is unreachable.

But the request still _waits_ for something it is explicitly allowed to lose, and which the FI-10
reconciler already covers. The options are a genuine trade, which is why C4 measured it and did
not decide it:

1. **Keep the wait.** Acceptance costs ~94ms, and a search that has been accepted is guaranteed
   to have its pinned subject version searchable immediately.
2. **Return on commit, leave `indexState: 'PENDING'`, let the reconciler confirm.** Acceptance
   drops to ~33ms, and a search accepted at T may not be matchable until T+ε. Whether that is
   acceptable depends on whether anything reads the index between acceptance and the run
   completing — which Phase F's consumer decides.

**Must close by G8**, with Phase F, because option 2 is only safe once the consumer's ordering is
known. Recorded now so the 94ms has an owner rather than sitting in a measurement with none.

---

---

## D-015 — The orphan sweep deletes only objects this system created

**Status:** Accepted · **Gate:** G4

The FI-03 orphan sweep lists a tenant's object prefix and deletes what no committed reference
names. The question is what "what" means, and the answer is narrower than it first looks: **only
keys matching the exact shape `keyFor` produces** — `evidence/<region>/<tenantId>/<date>/<uuid>`.
Everything else under the prefix is counted as unattributable and left alone.

The first implementation checked only that the key carried the tenant prefix. Writing the test
for it showed why that is worthless: the sweep lists the tenant prefix, so _every_ key it sees
carries that prefix by construction. The guard could never fire. Worse, it would have passed a
test asserting it did fire, because the test's own "foreign" key was itself under the prefix —
the guard and the test were wrong in the same direction, which is how a safety property becomes
decorative.

The useful question is not "is this key under the right prefix" but "**did this system create this
object**". Only `keyFor` creates evidence objects, so only what `keyFor` can produce is eligible
for deletion. An object uploaded by hand, one left by an older key layout, or one whose name
contains a literal `..` (S3 treats key names as opaque text, so this is a real object and not
traversal) is now skipped and counted.

**Cost:** an object written by a future version of this service under a different key layout will
not be swept, and will accumulate until someone notices. That is the right way round — the
alternative failure is a scheduled job deleting objects it did not create, which is a bucket-wide
delete wearing a prefix filter and only has to be wrong once. A key-layout change must therefore
update `tenantOfKey` alongside `keyFor`; they are two halves of one decision and are adjacent in
the file for that reason.

There is also no way to supply the object id to `keyFor`. A test that could pin a key could pin
one `tenantOfKey` does not recognise, and the sweep would then quietly decline to collect exactly
the objects the test created — a hole in the reconciler opened for the convenience of a fixture.

---

## D-016 — The worker is a second entrypoint, not a second application

**Status:** Accepted · **Gate:** G4

The delivery plan named `apps/worker` as a package. It is instead a second entrypoint into
`apps/api`: `worker-main.ts`, which builds the same DI graph with `createApplicationContext`
and starts the polling loop, with no HTTP server.

The worker needs the same configuration, the same Mongo client, the same section 6.3 records,
the same transaction runner and the same ports as the API. A separate package would either
import all of that across an app boundary — a dependency that makes the split cosmetic — or
grow its own copy. The copy is the real cost: tenant scoping, lease fencing and the FR-06
classification would have two homes, and a divergence between them would not fail a test. It
would show up as a worker doing something the API's own tests prove cannot happen.

What is actually wanted from "a separate worker" is operational, and all of it still holds:
separate processes, separate scaling, separate failure domains, and a crash that cannot take
the API down. One image with two entrypoints gives all four.

**Cost:** the API image carries the worker's code and the worker carries the API's. That is
bytes, not risk — the worker never calls `listen`, so no route is reachable from it, and the
process-level separation is unchanged.

**The worker refuses to start today,** because no handler is registered until Phase E. That is
not a placeholder: a handler-less consumer receives every queued search and dead-letters it as
unroutable, so a process that looked healthy would be draining the queue into the DLQ. Refusing
to start and saying why is the honest behaviour, and it matches the rule that an unimplemented
command exits non-zero rather than passing vacuously.

---

## D-017 — An internal defect is not an FR-06 failure class

**Status:** Accepted · **Gate:** G4

The FR-06 table classifies what a **source** did: it refused us, it rate-limited us, it served
something unparsable. When a handler throws something that is not a described failure — a type
error, a null dereference, a bug of ours — the consumer records it with a **null** failure class
and a plain detail, retries it at most three times in case it was environmental, and then
abandons the stage visibly.

The tempting alternative is to map it onto `CONTENT_ERROR`, which is the non-retrying default
for an unrecognised _source_ signal. That would be wrong in a way that reaches the customer:
the coverage statement is assembled from failure classes, so our own defect would be reported
as a fact about the source — a dead lead, with provenance, for a failure the source had no part
in. The publisher would be recorded as having served us something broken when the truth is that
we broke.

**Cost:** one more state for a reader of `StageExecution` to understand — a failed stage whose
`failureClass` is null. That is a small price for never attributing our bugs to someone else's
website.

---

## D-018 — One approval lifecycle for sources, taxonomy and policy, with the rights gate inside it

**Status:** Accepted · **Decided at:** Phase D step D1, 2026-09-11

Sources, taxonomy versions and policy versions share a single lifecycle —
`PROPOSED → AWAITING_APPROVAL → APPROVED → ACTIVATING → ACTIVE`, with `SUSPENDED`, `SUPERSEDED`
and `RETIRED` — implemented once in `packages/domain/src/lifecycle/versioned-lifecycle.ts` and
applied once in `apps/api/src/admin/versioned-record.service.ts`.

**Why one and not three.** Three copies of an approval workflow drift, and the copy that drifts
is the one whose T45 test nobody wrote. The three kinds differ in exactly four declared ways —
collection, permissions, tenant ownership, and which field carries identity — and in nothing
else.

**Four properties that are load-bearing, each because of a specific failure:**

1. **Only `PROPOSED` is editable.** Otherwise the approver approves one thing and a different
   thing activates.
2. **Only `ACTIVE` is usable.** `APPROVED` is permission to activate, not activation. Anything
   that reads a version before querying calls `isUsable` rather than comparing to a string.
3. **Suspension needs no second person; restoring does.** Requiring two people to _stop_ using a
   source is how a source that is harming someone stays live over a weekend. Restoring re-enters
   at `ACTIVATING` so a licence that expired during the suspension cannot be restored past.
4. **Activation is two transitions, not one.** The SEC-05 clearance is evaluated against the
   recorded `ACTIVATING` state and stored on the version whatever it says. A refusal therefore
   leaves evidence — the version falls back to `APPROVED` with the clearance attached — where a
   single-step activation would make the gate an `if` that leaves nothing behind when it says no.

**What this decision replaced.** The seeded collections already keyed on `{sourceId, version}`
and `{tenantId, version}` with the lifecycle in a `status` field. The service writes that exact
shape rather than a parallel one beside it, so the registry an administrator sees is the registry
the system actually uses, and the Phase A fixture sources can be taken through a real approval.
A source's identity is its `sourceId`; **a taxonomy's and a policy's identity is the tenant**,
because a tenant has one taxonomy timeline and one policy timeline and `pinVersions` depends on
that.

---

## D-019 — SEC-05 is an enforcement function, and a DENY is never upgraded by an approval

**Status:** Accepted · **Decided at:** Phase D step D1, 2026-09-11

`decideRights` in `packages/domain/src/rights/rights.ts` is the per-source, per-operation
content-rights decision, returning `ALLOW` / `DENY` / `REQUIRES_APPROVAL` with reason codes and
machine-actionable restrictions. It is pure and lives in the domain package because the same
decision is made by the fetcher, the staging service, the extractor, the exporter and the
indexer, and a second copy is how the export path comes to permit what the display path forbids.

**Three rules worth stating as decisions rather than as code comments:**

- **Default deny.** An operation, classification, region or intended use the policy does not name
  is refused. "Publicly accessible" is not approval for every use. An empty policy is the safest
  possible policy rather than an accidentally permissive one.
- **A `DENY` is never upgraded by an approval.** `CAPTCHA_GATED`, `LOGIN_GATED` and `PAYWALLED`
  are listed as **non-approvable**: attaching an approval reference to a prohibited collection
  method does not make it lawful, and an administrator holding `source:approve` cannot license
  one. Prohibitions are also evaluated _before_ approval, so a prohibited request reports as
  prohibited rather than sending someone to obtain an approval that could never help.
- **A restriction is enforcement, not advice.** `AGGREGATE_ONLY` and `NO_RAW_RECORD_RETENTION`
  are returned to be honoured by the caller, which is what lets a national electoral roll be a
  lawful source of a surname-frequency prior (D-011) while never becoming a stored personal
  record.

**Nothing in the function is jurisdiction-specific**, and that is deliberate: every country
difference arrives as a versioned `RightsPolicy`, so adding a jurisdiction is a data change and a
country-specific branch in this file would be a bug.

---

## D-020 — A missing capability is never an empty result

**Status:** Accepted · **Decided at:** Phase D step D1, 2026-09-11

Per-jurisdiction, per-capability coverage is stored configuration with four statuses —
`SUPPORTED`, `PARTIAL`, `UNKNOWN`, `UNSUPPORTED` — and one function,
`interpretEmptyResult`, decides what an empty result from that capability may be called.
**Only `SUPPORTED` yields `NO_FINDINGS`.** Everything else yields `NOT_ESTABLISHED`.

This exists to stop the worst failure this product has: a capability that was never available
reading as a capability that found nothing. "No officer associations were found" and "we have no
way to look for officer associations here" are the same empty array, and only one of them is a
screening result.

**`UNKNOWN` and `UNSUPPORTED` are not merged**, though it is tempting. `UNSUPPORTED` is a
finished investigation — there is no way to do this here on approved terms. `UNKNOWN` is an
unfinished one. Merging them either claims knowledge nobody has, or hides a gap somebody could
close.

**An unrecorded capability defaults to `UNKNOWN`, never to supported.** An absent row is the most
common way a coverage model ends up claiming capability it does not have.

Costa Rica's rows are seeded from the D0 dossier (`docs/sources/cr-dossier.md`) as data, not
code: officer associations `UNKNOWN` blocked by D14, company registry `PARTIAL`, court records
`UNKNOWN` blocked by D15. Nothing in `packages/domain/src/capability` knows what Costa Rica is.

---

## D-021 — A source adapter returns a four-way outcome, never a list

**Status:** Accepted · **Decided at:** Phase D step D2, 2026-09-14

Every FR-05 port returns `SourceOutcome<T>`: `OK`, `BOUNDED`, `NO_RESULTS` or `FAILED`. A caller
cannot reach the data without first matching on which of the four happened.

The alternative — returning `Officer[]` and throwing on failure — collapses three different
facts into one empty array. A registry that is down, a registry that holds nobody under that
name, and a traversal that stopped at its bound all produce `[]`, and `[]` downstream reads as
"no associations exist". FR-02 closes with the opposite sentence: "No result from a registry does
not prove no associations exist." T20 asks for the three to be separately observable, and a type
that cannot express the difference makes that a matter of discipline at every call site.

`BOUNDED` carries the data **and** the truncation, because a bounded traversal still found real
associations and discarding them would be worse than reporting them with the bound stated.
`leavesCoverageIncomplete` is a one-line helper precisely so the fifteenth caller does not write
`status !== 'OK'` and start reporting an empty answer as a coverage gap.

Classification happens once, inside `failed()`, through the FR-06 table. An adapter reports facts
— a status code, a syscall name, a content type — and never decides its own retry policy.

---

## D-022 — A mock adapter is unreachable in live mode by construction, not by a check

**Status:** Accepted · **Decided at:** Phase D step D2, 2026-09-14

Every mock adapter's constructor requires a `MockModeWitness`. The witness has a private
constructor and one factory, `forMode`, which returns `null` for `LIVE`. A live-mode process
cannot obtain one, so it cannot construct a mock adapter.

The obvious alternative is `if (mode === 'LIVE') throw` at the top of each mock. It works, and it
is forgettable: the check that eventually is not written is the one in the _next_ mock adapter,
written in a hurry six months from now. Omitting the witness does not compile.

T55 — fixture data must never be servable as a live result — is enforced twice over as a result:
on the record, by the `mode` stamp on every provenance; and on the process, by the witness.

The same decision removed `mode` from `sourceContentSchema`. A caller-supplied mode lets a
fixture source declare itself `LIVE` inside a mock stack, which is T55 with the labelling under
the attacker's control. Mode is stamped on the envelope from the running configuration, and
content that carries it is rejected rather than ignored.

---

## D-023 — FR-05 conformance is enforced at submit, not at propose

**Status:** Accepted · **Decided at:** Phase D step D2, 2026-09-14

A source version's content is checked against the full FR-05 field list when it is **submitted
for approval**, and again at **activation** as a backstop. It is not checked when a draft is
proposed or edited.

A draft is allowed to be incomplete — that is what a draft is. Refusing to save a half-filled
twenty-field form is how people end up keeping source configuration in a text file until it is
finished, and then pasting it in all at once with no draft history.

Submission is the right gate because approving is the act that carries responsibility. An
approver must never be asked to approve a record that cannot be interpreted; "I approved it, I
assumed the fields were right" is not a position to put a named person in.

Activation repeats the check because a record can reach `APPROVED` by other routes: the bootstrap
seeds versions directly, and a restore re-enters at the gate. An active source whose fields the
adapters cannot read contributes nothing while still appearing in the coverage statement.

Taxonomy and policy content are **not** checked, and the `switch` in `assertContentConforms` is
exhaustive so that a fourth record kind is a compile error rather than a silent pass. Taxonomy's
field schema lands in D6 with the lexicon audit; policy's with the retention decision (D-012).
Enforcing an invented schema on either now would be enforcing a guess.

---

## D-024 — A register's silence about a resignation is not a confirmed current directorship, and is still in scope

**Status:** Accepted · **Decided at:** Phase D step D3, 2026-09-14

FR-02 says "current confirmed directorships only" and "unknown end dates do not prove current
status". Taken literally together, those two sentences would exclude nearly every directorship
a real register publishes, because a register almost never records an end date for a serving
officer — **absence is how it says "still serving"**.

So currency is four values, not a boolean: `CURRENT_CONFIRMED` (an end date is recorded and has
not arrived), `CURRENT_PER_REGISTER_SILENCE` (an appointment, no resignation), `FORMER`, and
`UNKNOWN` (the dates establish nothing, usually a missing or too-coarse appointment).

Silence-based edges **are** in the default scope. Excluding them would make a current-only
search return nothing at all against most registers, and the honest coverage statement for that
search would have to say we looked at no companies — a clean-looking result produced by not
looking, which is the failure mode this whole service is built against.

They are **never labelled confirmed**. The two current values travel separately all the way to
the reviewer and no code merges them, in the same way `UNKNOWN` and `UNSUPPORTED` are never
merged in D-020.

The proof half of FR-02's sentence is enforced where it actually bites: attaching an _event_ to
a person's tenure goes through `labelTenure`, which answers `UNKNOWN` rather than
`DURING_TENURE` whenever the dates cannot show the person still held the role. That is the case
that attaches a company event to someone who had already left, and it has its own test.

---

## D-025 — An officer resolves through Axis A, and `PARTIAL` does not attach a company

**Status:** Accepted · **Decided at:** Phase D step D3, 2026-09-14

Resolving a subject to an officer record uses `gradeIdentity` — the same FR-08 Axis A grading a
document match uses — over factors built from what the register published. There is no
register-specific notion of "matched enough". A second one would drift from the document one,
and the two would then disagree about the same person in the same run.

The grade maps to what the graph may do:

| Grade          | Status                 | The graph may…                                   |
| :------------- | :--------------------- | :----------------------------------------------- |
| `CORROBORATED` | `RESOLVED`             | attach the companies and anchor queries on them  |
| `PARTIAL`      | `CANDIDATE_FOR_REVIEW` | show the companies, anchor nothing               |
| `WEAK`         | `UNRESOLVED`           | show the officer, attach nothing                 |
| `CONTRADICTED` | `CONTRADICTED`         | nothing — the register says this is someone else |

**`PARTIAL` not attaching is the contested half.** One moderate identifier — a birth month and
year that agrees — feels sufficient when looking at a single candidate. It is not: a register
publishing a birth month and year for a common name in a country of five million will return
several people who agree on it. FR-02 forbids unresolved officers attaching companies
_automatically_, and "automatically" is the operative word — the candidate is surfaced, and a
reviewer may still decide.

**Resolution happens twice per officer, and the ordering is forced by the data.** The officer
search does not say which companies a register attributes to an officer, so the strongest
available signal — the client supplied company X, and the register puts a person of that name in
company X — is not knowable until after the one-hop. The first pass decides only whether asking
is worth a call; the second, with the appointments known, is the one stored on the edges.

A non-contradicted officer is also worth asking about whenever the client supplied known
companies, even at a weak name match, because that is precisely the case the second pass exists
to catch. Where nothing was supplied, a weak name match costs no call at all — so a name shared
by twelve people produces twelve candidates and zero hops.

---

## D-026 — The association snapshot is created empty with the run, and filled in by the worker

**Status:** Accepted · **Decided at:** Phase D step D3, 2026-09-14

`graphSnapshots` gets a `PENDING` row inside the **search-creation transaction**, so the run is
pinned to exactly one snapshot id from the moment it exists. It is populated later by `build()`.

Building it inline in `POST /v1/searches` would put registry latency into search acceptance and,
worse, would make a registry outage a search-creation failure — which FR-02 forbids outright:
"If registry access fails, continue valid person searching and show association coverage as
incomplete."

A `PENDING` snapshot reports coverage `UNKNOWN`, never `COMPLETE` with zero edges. Before
anything has been attempted, "we have not asked" is the only honest answer; `COMPLETE` with an
empty array would read as "this person directs nothing".

**Companies are copied per snapshot rather than shared.** A shared `companies` collection keyed
on the company number is the obvious design and is wrong here: the day a register renames a
company or moves it to `dissolved`, every past search silently starts describing it the new way,
and a report produced in March stops saying what it said in March. Duplication is the price of a
record that stays true. A refresh produces a new snapshot carrying `refreshOfSnapshotId`;
nothing mutates the old one.

---

## D-027 — A former-director search is refused without the entitlement, never silently narrowed

**Status:** Accepted · **Decided at:** Phase D step D3, 2026-09-14

FR-02: "former-director search is selectable only under an approved historical scope." A tenant
without the `historical_directorships` entitlement that sets `includeFormerDirectorships` is
**refused** with `INVALID_SCOPE`, before anything is written.

The alternative — quietly running current-only — produces a result that answers a narrower
question than the one asked while carrying no indication that it did. The caller has no way to
tell, and a reviewer reading the output has less way still. A refusal is visible and fixable; a
silent narrowing is neither.

`tenant-beta` is seeded with the entitlement and `tenant-alpha` without it, so both paths are
exercised against the bootstrapped stack. Granting it to both would leave the refusal untested,
and the refusal is the half that matters.

---

## D-028 — The traversal bounds are policy-version configuration, pinned to the run

**Status:** Accepted · **Decided at:** Phase D step D4, 2026-09-14 · **Supersedes part of D-026**

FR-02's three one-hop bounds — officer candidates, companies per officer, edges per snapshot —
live on the tenant's **policy version** rather than in a constant or an environment variable.

Three consequences, and all three are the reason:

- a customer who screens shell-company networks can have them raised **without a deployment**;
- raising them goes through the D1 four-eyes lifecycle, so it is an approved change with an
  audit entry and a version number rather than a configuration edit nobody reviewed;
- the run **pins** the version, so an old report explains its own truncation under the bounds it
  actually used. A bound raised in October must not change what a search from March is reported
  to have covered, or the truncation note stops matching the graph printed beside it.

The resolved bounds are therefore copied onto the snapshot at creation, exactly as companies are
copied per snapshot (D-026), and read from there at build time.

**A bad bound does not fail the search.** `resolveGraphBounds` falls back to a documented default
per field and returns a problem string that travels into the coverage statement. Throwing would
take a screening run down over a configuration typo, which is the worse failure — but silently
falling back would leave a run whose truncation nobody could explain, so the fallback is stated
rather than quiet. There is also a ceiling per bound: a policy may narrow the traversal, never
remove the limit.

---

## D-029 — The historical-scope approval lives on the policy version, not the entitlement

**Status:** Accepted · **Decided at:** Phase D step D4, 2026-09-14 · **Corrects D-027**

D3 gated a former-director search on a `historical_directorships` **entitlement capability**.
That was the wrong record, and it duplicated a `historicalScopeApproved` field the seeded policy
version already carried.

FR-02 calls it an _approved_ historical scope. An entitlement describes **what a customer
bought**; a policy version describes **what has been approved for them to do**, and the two are
different questions with different owners. The policy version is also the one that goes through
four eyes, writes an audit entry, and is pinned onto the run — so a historical search can cite
the policy version that permitted it, which an entitlement check cannot provide.

The refusal itself is unchanged and still the point: a tenant without the approval is **refused**
with `INVALID_SCOPE`, never silently narrowed to current-only. The error names the policy field,
so an administrator is sent to the record they actually have to change rather than to the
commercial plan.

`tenant-beta` is seeded with the approval and `tenant-alpha` without it, so both paths run
against the bootstrapped stack. The entitlement capability added in D3 has been removed.

---

## D-030 — Only the coverage dimension is written when a source reports in

**Status:** Accepted · **Decided at:** Phase D step D4, 2026-09-14

`recordAssociationCoverage` stores the association source's `SourceCoverageOutcome` on the run,
re-runs `aggregateRun`, and writes **only** `coverage` back. `execution` and `findings` are left
alone.

`aggregateRun` returns all three, and applying all three here would be wrong. Coverage is a
statement about _what was searched_, and this source's contribution to it is settled the moment
the graph is built. Execution and findings are statements about the **whole run** — and with a
single failed source outcome `aggregateRun` correctly concludes `FAILED`, which is right for a
run in which nothing else ran and quite wrong for a real one whose person search is still to
come. Whoever finishes the run owns those two (Phase E).

This is what makes FR-02's degraded execution true in practice: a registry outage records a
`FAILED` source outcome and an `INCOMPLETE` coverage, and there is no path in the method that
fails, deletes or rolls back the run.

Outcomes are keyed by source and replaced rather than appended, so a redelivered message cannot
make one outage look like three.

---

## D-031 — Source health is a separate mutable document, and access is rechecked at the point of use

**Status:** Accepted · **Decided at:** Phase D step D5, 2026-09-14

**The document.** Observed availability, breaker state, budget counters and the kill switch live
in `sourceHealth`, keyed by `sourceId`, referencing the version they observed. They are **not** on
`SourceVersion`.

`SourceVersion` is an immutable approved artefact — the record of what an approver permitted,
frozen so that a search run six months ago can still explain itself under the terms it actually
ran under. Health changes every few seconds and nobody approves it. Putting one inside the other
forces a choice between breaking that immutability and losing the observations, and there is no
version of that choice worth making. **The approved version says what is permitted; health says
what is happening.**

It is **shared, not tenant-owned**, on the same reasoning as source configuration (§6.3): a
publisher's rate limit and a publisher's outage are properties of the publisher. Per-tenant budgets
would let the sum of the tenants exceed the free tier the publisher actually grants. It joins
`capabilityCoverage` and `nameFrequencyProfiles` in the documented cross-tenant collections.

**The recheck.** A run pins its source versions at plan time, and `SourceHealthService.checkAccess`
is called again immediately before **each** discovery query and **each** fetch. Deciding once, at
plan time, would mean a source suspended for a rights violation kept being fetched for the length
of every in-flight run — minutes or hours during which an operator believes they have stopped it.
T36 forbids exactly that, and the point-of-use recheck is what makes the kill switch effective
mid-run.

There is deliberately **no cancellation message** chasing an in-flight run. A cancellation that has
to arrive is one that can fail to arrive; making the run ask, every time, removes the delivery
problem instead of adding a second one. The cost is bounded and stated: at most one request already
on the wire completes after the switch is engaged (failure-injection row FI-18).

**The breaker invents no failure taxonomy.** It reads FR-06's existing table. `domainAction:
'SUSPEND'` or `alertOperator` opens it immediately — the source has told us to stop, or a human has
to know. `domainAction !== 'NONE' || retryable` counts toward the threshold. What that excludes is
the point: a `CONTENT_ERROR` (a 404 on one article) and an `OVERSIZE` (one enormous PDF) are facts
about a **document**, and a breaker that counted them would hold open a source that is working
perfectly and merely being asked for things that are not there.

**Licence expiry is not a special case.** T36 names it explicitly, and `decideSourceAccess` puts it
on the same path as an engaged kill switch: past the recorded `licenceExpiresAt` the source is
refused identically. An expiry that cannot be parsed also refuses — a licence clock nobody can read
is not a licence we can claim to be inside.

**Refusal order is policy.** Rights first (kill switch, licence, an inactive version), then health
(the breaker), then economics (budgets). A suspended source reports as suspended even when its
breaker is also open and its budget also spent, because those are three different things to tell an
operator and only the first is one somebody will be asked about.

**Budget exhaustion is a coverage outcome, not an error** — `PARTIAL` with `TRUNCATED_BY_QUOTA`.
Some of the plan ran. An open breaker is `FAILED` (we asked, repeatedly, and it did not answer);
a kill switch, an expired licence or an inactive version is `SUSPENDED` (we chose not to ask).
**None of the three is ever a silent skip**, because a run that quietly consulted one fewer source
reads to a reviewer as a clean result from a search that was never made.

**Consequence, accepted:** the six D2 fixture adapters are now registered in `sourceVersions` by the
bootstrap. An adapter pointed at a source nobody approved is what the registry exists to prevent,
and that rule has to hold for fixtures too — otherwise the mock stack exercises a path the live one
does not have.

---

## D-032 — A result produced before a suspension is kept, and says so in both places

**Status:** Accepted · **Decided at:** Phase D step D5, 2026-09-14

T36 requires that a result produced under a source that is later suspended is **not**
retro-actively deleted, and that a subsequent read of it shows the source has since been suspended.
The brief asks where that surfaces — coverage view, evidence metadata, or both — and the answer is
**both**, because the two answer different questions.

- `sourceSuspendedSince` on the **finding's document** answers _"can I rely on this finding?"_. A
  reviewer reading one finding must not have to go and check the run's coverage to learn that its
  source is no longer trusted.
- `sinceSuspendedSources` on the **findings page** answers _"has anything about this whole report
  changed since it was written?"_. That is the question somebody re-opening a six-month-old result
  actually asks, and without it they would have to reconstruct the answer by reading every finding.

Not deleting is the substantive half. Deleting would destroy an accurate record of what was found
and when — the result was true about the source at the time it was gathered, and a suspension is a
fact about the present, not a retraction of the past.

The note is computed at **read** time from the current health document rather than stamped onto the
finding at write time, because "since suspended" is a statement about now. A stamped field would be
wrong the moment the source was released, and correcting it would mean rewriting findings — which
is the thing the whole records design refuses to do.

A note is produced **only** when the suspension postdates the result. A result produced _after_ a
suspension should not exist, and labelling it "since suspended" would state something false about
when the data was gathered, so it says nothing at all rather than something wrong.

---

## D-033 — The Spanish lexicon ships unreviewed, and every surface says so

**Status:** Accepted, with a named open action · **Decided at:** Phase D step D6, 2026-09-14

**The state of the world.** `packages/domain/src/taxonomy/seed-lexicon.ts` carries 155 terms
across `en` and `es` — conduct terms for all seventeen categories, procedural terms, and authority
names. **No Spanish reader has reviewed the `es` half.** No Spanish-reading reviewer was available
in this phase, and identifying one is still an open action owned outside engineering.

The phase brief allowed exactly two honest outcomes and forbade the third:

1. a list reviewed by someone who reads the language;
2. an unreviewed list **whose unreviewed state is recorded** in the coverage statement and the
   handoff;
3. a **machine-translated** list — forbidden by D-010, because the usable Costa Rican Spanish
   terms for "charged" or "indicted" are not dictionary translations of the English words, and a
   translated list silently misses every real Costa Rican court report while looking fully
   configured.

This is (2). Nothing here is machine-translated; the terms were authored by hand against Costa
Rican statutory vocabulary — `legitimación de capitales` rather than `lavado de dinero` (Ley 8204),
`imputado` and `acusación formal` for the charge stages — and every one carries
`reviewState: 'UNREVIEWED_AUTHORED'`.

**Where the unreviewed state is recorded**, so that it cannot be lost by somebody forgetting:

- **`TermReviewState` on every term.** A field, not a comment.
- **Activation refuses `MACHINE_TRANSLATED` outright.** Recording provenance only means something
  if one of its values is refused, and that is the one.
- **The FR-13 coverage statement** carries an `Unreviewed term lists:` line naming the languages,
  distinct from the `Unmeasured languages:` line. They are different facts and both are true:
  unmeasured is "we have not checked how much this finds"; unreviewed is "we are not sure we asked
  the right question".
- **Every run's warnings** carry `unreviewedLexiconNote`, and the note **disappears by itself**
  when a language's terms are all `REVIEWED_BY_SPEAKER` — so a review lands by editing the terms,
  not by remembering to delete a warning.
- **The handoff log**, as the brief requires.

**Why ship it rather than ship `es` with no conduct terms.** The other branch the brief allowed is
an empty Spanish list, and that is worse in a way that is easy to miss: with no terms, F3 builds no
category queries at all in Spanish, the run reports nothing unusual, and the gap is invisible
because "no terms" and "terms that found nothing" produce the same empty result. With terms marked
unreviewed, the searches happen, the gap is named on every result, and a reviewer can act on it.

**English is marked unreviewed too.** One engineer wrote both lists, and marking the English one
`REVIEWED_BY_SPEAKER` because its author reads English would be exactly the self-certification the
field exists to prevent. What differs between the two is the _cost_ of being wrong — an English
error is visible to anyone reading the list, a Costa Rican Spanish one is not — and that asymmetry
is what D-010 is about, not the review status itself.

**The open action, stated so it is not lost:** a Spanish-reading reviewer must check the term list,
in the priority order written at the top of `seed-lexicon.ts` — procedural terms first (they decide
whether the Spanish half finds a real CR court report at all), then authority names, then conduct
terms per category. Until they do, the Spanish half of this system may report no findings because
the query was wrong rather than because nothing exists.

---

## D-034 — The live fetch adapter uses `node:https` with a screening lookup, not `fetch`

**Status:** Accepted · **Decided at:** Phase E step 1, 2026-09-14

`HttpEvidenceFetchAdapter` opens its connections through `node:https` and a custom `lookup`,
rather than through the global `fetch`. Two requirements make that a necessity rather than a
preference, and both of them are things `fetch` cannot express.

**1. The address that was screened must be the address the socket uses.**
`screenResolvedAddress` exists to defeat DNS rebinding. Screening with `dns.lookup` and then
calling `fetch(hostname)` resolves the host **twice**, and the second resolution is the attack:
the name that answered publicly a moment ago answers `127.0.0.1` now. `https.request` accepts a
`lookup` function that the connection itself calls, so the screening sits **inside** the only
path from a hostname to a socket. An unscreened address is not reachable — not because somebody
remembered to check first, but because there is no route that skips the check. `servername` stays
the hostname, so TLS verification is unaffected: the certificate is still checked against the
name, never against the address.

The lookup asks for **every** address rather than the first, and **one forbidden address refuses
the whole host**. A host answering with both a public and a private address is a rebinding or
split-horizon signature, not a usable host with one bad entry. A false positive costs one lead; a
false negative costs cloud credentials, and `isForbiddenAddress` is deliberately broad for the
same reason.

**2. Two byte budgets cannot be enforced through one number.** `FetchBudget` declares `maxBytes`
and `maxDecompressedBytes` separately, and it is right to: they defend against different attacks.
`fetch` decompresses transparently, so the wire size is not observable and the two collapse into
one. Here the wire bytes are counted as they arrive — aborting on the chunk that crosses the line,
not after buffering the body — and the decompressed bytes are bounded by `zlib`'s own
`maxOutputLength`, which stops a bomb inside the decompressor rather than by measuring a buffer
that has already been allocated. A 40KB response that inflates to a gigabyte trips the second
budget while the first is nowhere near its limit. That is the compression half of **T38**, and one
budget cannot express it.

**Cost.** More code than `fetch`, and it is ours to maintain: redirects are followed by hand,
headers are flattened by hand, and the timeout is a timer rather than a signal. That cost is paid
deliberately, because following redirects by hand is also what lets **every hop be re-screened** —
a transport that followed them internally would carry a request past the gate without the gate
being consulted, and a `302` to the metadata service is the obvious way to try it.

The residual limit, stated: an IP **literal** in a URL never reaches the lookup at all, because
there is nothing to resolve. `screenUrl` is the only gate on that path, which is why the
IPv4-mapped IPv6 gap found while writing this adapter mattered — see the handoff for 2026-09-14.

---

## D-035 — A gate refusal is never source health, and whoever opens the socket spends the budget

**Status:** Accepted · **Decided at:** Phase E step 1, 2026-09-14

Two rules about what the fetch adapter tells `SourceHealthService`. They were decided together
because both are answers to the same question: what, exactly, is this health record about?

**A gate refusal is never recorded as the source's failure.** A robots disallow and a refused
address both classify as `HARD_BLOCK` through the FR-06 table, and `HARD_BLOCK` carries
`domainAction: 'SUSPEND'`, on which D5's breaker opens **immediately**. So handing either to
`recordFailure` would suspend an entire working news feed because one of the articles it listed
happened to be disallowed or unreachable — and the suspension would then be reported as a coverage
gap for a source that was answering perfectly.

The distinction is the one the whole `sources/` directory already keeps: a gate refusal is **our**
decision not to ask, not the source's failure to answer. So the adapter records health only for
failures the **server produced** — a status code, a reset connection, a timeout, an oversize body.
A refusal is still returned as a `FAILED` outcome, so the lead survives with its reason attached
and the coverage view shows it; it simply does not become evidence that the publisher is unwell.

This exposed a second thing worth writing down: FR-06 asks for per-source **and per-domain**
circuit breakers, and D5 built only the per-source half. For a primary source the two coincide.
For a discovery lead they do not — the `sourceId` is the feed, and the domain is whatever the feed
linked to. Until the per-domain breaker exists (Phase E step 3), this rule is what keeps the
missing half from doing harm.

**Whoever opens the socket spends the budget.** The publisher counts **requests**, so the
component that puts one on the wire is the component that spends. `checkAccess` gained an optional
`spend` flag, defaulting to true. The pipeline's pre-fetch check passes `spend: false` — it is
asking "may this lead be attempted at all?", which is a rights-and-breaker question, not a
request. The adapter then spends once per request it actually issues, **including the robots.txt
fetch**, which is a real request to the publisher and was counted nowhere at all before.

The alternative — leaving the spend in the pipeline — charges for requests that a robots refusal
means we never make, and charges once for a fetch that turns into three (robots, the document, a
redirect hop). Either way the counter stops describing the traffic the publisher sees, which is
the only thing it is for.

**Cost.** Two components now both call `checkAccess`, and the rule for which one spends lives in a
comment and a flag rather than in the type system. A third caller that forgets the rule will
over-count. The mitigation is that the flag is named for what it means and that the default is the
safe direction — a caller that forgets it spends, and over-counting slows fetching down rather
than exceeding a publisher's free tier.

---

## D-036 — Only `FetchGateService` issues a `FetchAuthorisation`, and every field is derived

**Status:** Accepted · **Decided at:** Phase E step 2, 2026-09-14

`SearchPipeline` used to build its `FetchAuthorisation` inline: `sourceVersionId:
'fixture-source-v1'`, `robotsPosition: 'HONOURED'`, `jurisdictionEnabled: true`, `languageEnabled:
true`, `urlPolicyPassed: true`, `ssrfValidated: true`, `relevanceScore: 0.9`. Not one of those was
derived from anything. Against `MockEvidenceFetchAdapter` it was harmless — the mock reads the
record and returns a fixture. Against the real adapter built in step 1 it is a signed statement
that five FR-06 gates were passed which were never run, in the one record whose purpose is to be
audited afterwards. `urlPolicyPassed: true` claimed SEC-02 screening on a URL nothing had screened.

So there is one issuer, and it derives every field: the **active approved source version** and its
recorded, unexpired licence terms; jurisdiction enablement from the run's pinned scope, the
source's approved countries and the pinned taxonomy; language enablement from the lead's declared
language, the taxonomy and the source; `urlPolicyPassed` from `screenUrl` run here on this URL; and
the robots position from what an approver actually recorded.

Three consequences worth stating.

**`ssrfValidated` now means something specific, and the field says what.** The gate runs the
literal half — a URL whose host is an address in a forbidden range is rejected before the field is
set — and the resolved half is structural, performed inside the connection's own `lookup` on every
hop (D-034). No caller can satisfy the field by asserting it.

**A fixture is not a publisher.** The six mock sources are registered with `robotsPosition:
'NOT_ESTABLISHED'`, which is true of them: there is no publisher behind a local fixture with whom a
position could be established. The old inline record said `HONOURED` to get past the gate. The gate
now issues `FIXTURE_NOT_A_PUBLISHER` — **only** in a mock-mode process, **only** for a
`FIXTURE_MOCK` connector — and `HttpEvidenceFetchAdapter` refuses that value outright, so a fixture
authorisation cannot justify a request to a real host (T55, from the other end than
`MockModeWitness`).

**A refusal is recorded twice when it costs a source.** `isSourceLevelRefusal` splits refusals that
are properties of the source (no active version, expired licence, no established robots position,
an unapprovable exception) from those that are properties of one URL (outside the run's scope, a
rejected URL). The first become a `SKIPPED` coverage outcome as well as a rejected lead, because a
source excluded in full is something a reviewer reading a narrow result has to be told. `SKIPPED`
rather than `FAILED`: the source answered nothing because we chose not to ask it.

**Enforcement.** The "only issuer" rule is checked by a test that scans `apps/api/src` for the
`urlPolicyPassed` field outside the gate and the port — the same way decision D-001's boundary is
enforced in the control panel. A rule nobody can check is a rule that lasts until the next hurry.

**Cost.** The gate is another point of failure between a lead and its evidence, and a
misconfigured registry now refuses fetches that previously proceeded on a false record. That is the
intended direction: a refusal is visible, and the coverage statement says what was excluded and
why. It also means the fixture sources' registry rows are load-bearing for mock mode, which was
already true of source health and is now true of the gate.

---

## D-037 — The relevance score is preliminary, is labelled, and does not gate

**Status:** Accepted, provisional · **Decided at:** Phase E step 2, 2026-09-14

`FetchAuthorisation.relevanceScore` was the constant `0.9`. FR-06's nine-signal relevance filter is
step 4 of this phase, and its weights are to be set against the FR-16 labelled corpus rather than
guessed in advance, so step 2 had a choice between three bad options and one adequate one: keep the
constant, invent weights early, refuse every fetch until step 4, or compute something real and say
what it is.

The gate computes a **name-presence score** over the lead's own title and snippet against the
subject's name forms — 1 for a whole name form present, otherwise the best fraction of a name
form's tokens present, 0 for a lead that names nobody — and records it alongside
`relevanceMethod: 'PRELIMINARY_NAME_PRESENCE_v1'`. The method field is the point: 0.4 from FR-06's
nine signals and 0.4 from a name-presence heuristic mean different things, and a bare number in an
audited record cannot be told apart from a measured one.

**It does not gate.** No threshold is applied, because a threshold chosen before the corpus has
been consulted would silently drop real leads on a number nobody validated — and FR-06 is explicit
that relevance filtering decides whether a document is worth the request, never whether it is
adverse. Step 4 replaces the method, adds the threshold, and stores what it rejected as a lead with
its reason.

**Cost.** A score of 0 is recorded against leads that will be fetched anyway, which reads oddly
until step 4 lands. The alternative was a number that reads plausibly and means nothing, which is
worse in the only situation that matters — somebody auditing the record afterwards.

---

## D-038 — A `FAILED` source outcome carries a human detail, not only a class

**Status:** Accepted · **Decided at:** Phase E step 2, 2026-09-14

`SourceOutcome.FAILED` carried a `FailureSignal` and the FR-06 classification, and nothing a person
could read. A lead refused because robots.txt disallowed its path reached a reviewer as "The
document could not be retrieved (HARD_BLOCK)" — which says something went wrong and nothing about
what. The adapter knew the sentence; it logged it, where no reviewer will ever see it.

`detail` is now a **required** field on the `FAILED` variant and a required argument to `failed()`,
so no adapter can produce a failure with no explanation — a compile error at fifteen call sites is
the mechanism, and it is cheaper than a convention. It describes the event, never the subject: a
host, a status code, a robots path, a byte count.

**Cost.** Fifteen call sites had to write a sentence, and the sentences are as good as whoever
wrote them. An optional field would have avoided that and would have been absent everywhere it
mattered.

## D-039 — `fast-xml-parser` 4.5.7, pinned, behind a DOCTYPE gate this project owns

**Status:** Accepted · **Decided at:** Phase E step 3, 2026-09-15

The two RSS rungs of the FR-05 cascade need an XML parser and the project had none. A parser is
not a neutral dependency here: it is pointed at a document a third party controls, where a
resolved entity reads local files (XXE) and a nested one allocates gigabytes from forty bytes
(billion laughs).

**The defence is not a parser option.** Both attacks require a DTD — an XXE payload needs
`<!ENTITY ... SYSTEM ...>`, a laughs payload needs nested `<!ENTITY>` — and there is nowhere else
in an XML document to put either. So `apps/api/src/sources/parse/xml.ts` scans the document before
the parser is called and refuses **any** markup declaration. That rule is ours, it is proved by a
test that never touches the library, and it survives an upgrade that changes what a flag means. A
defence resting on `processEntities: false` does not.

The scan is a scanner and not a substring search, because the two hard cases fail in opposite
directions: `includes('<!DOCTYPE')` false-positives on a feed that quotes HTML inside CDATA, which
would drop real articles, and a regular expression written to avoid that false-negatives on
anything its author did not anticipate — and a false negative here is the whole attack.

**4.5.7 exactly, not 5.x.** Verified 2026-09-15: 4.5.7 declares one runtime dependency (`strnum`);
5.11.1 declares six (`strnum`, `is-unsafe`, `xml-naming`, `fast-xml-builder`, `@nodable/entities`,
`path-expression-matcher`). All six share the package's real maintainer, so this is a
modularisation rather than an injected hostile dependency — but five were created in 2026 with
thin adoption, and `@nodable/entities` points at a GitHub org whose repository name does not match
the package. That thread is worth closing before the dependency is taken, and nothing needs v5.

**Entity processing stays on**, deliberately, and is safe only because of the gate: with no DTD
the only entities a document can contain are the five XML predefines and numeric character
references, each expanding to one character. Turning it off would leave `&amp;` sitting inside
every headline, which is a wrong title rather than a safe one.

**Cost.** A pinned dependency is one somebody has to deliberately advance, and 4.x will eventually
stop receiving fixes. The scan also refuses a legitimate feed that ships a DOCTYPE — some do — and
that feed is reported as a `CONTENT_ERROR` coverage gap rather than parsed. Both are accepted: the
first is a diary entry, the second is visible and is the safe direction.

## D-040 — Two breakers: one for the agreement, one for the publisher

**Status:** Accepted · **Decided at:** Phase E step 3, 2026-09-15

FR-06 asks for a breaker **per source and per domain**. D5 built per-source only, honestly,
because that was what the registry could express. The gap is specific and it is not cosmetic: a
discovery source hands us links to a hundred publishers it does not speak for. When one of those
publishers starts refusing us, recording the fact against the feed suspends a working feed, and
recording it nowhere keeps us calling a host that has already said no.

So `domainHealth` joins `sourceHealth` as a second shared, mutable document, keyed on the
**registrable domain**. `sourceHealth` answers "is this agreement usable?" — licence, budget, kill
switch, version status. `domainHealth` answers "is this publisher willing to hear from us?" Both
must allow a request. Neither invents a taxonomy: both read FR-06's table through the same two
predicates, imported rather than restated.

**Suspension is sticky; degradation expires.** A `DEGRADE` is a wait, and it ends on the
publisher's own clock where they sent a `Retry-After`. A `SUSPEND` is a refusal, paired in FR-06
with `alertOperator`, and nothing about time passing answers the question it raises — so it is
released by an operator, exactly as a source kill switch is. A success closes the breaker and
deliberately does **not** clear a cooldown: one request slipping through a cooldown does not
withdraw the cooldown.

**The key is a rule, not the Public Suffix List.** The PSL is a weekly-changing data file whose
npm distributions are a supply chain this project has not reviewed. `registrableDomain` strips to
two labels, or three where the second level is one a two-letter country code publishes under
(`co.uk`, `go.cr`, `com.mx`). Where the rule is wrong it is wrong **broader** than the truth, so
two publishers share a breaker and one holds the other back — a visible coverage cost. The
opposite error would let us keep calling a publisher who has already refused, and that cost is
paid by somebody who did not ask to hear from us.

**Ordering, found by the trip-wire harness rather than by reasoning.** The first wiring put the
domain gate ahead of the source rights check, and a 403 that halted the source then reported "the
publisher is in a cooldown" on the next request — hiding the halt an operator would be asked
about. Rights now go first, in a **non-spending** check, then the publisher, then robots, then the
spending check. D5's ordering principle — rights, then health, then economics — holds across both
breakers, not only inside one.

**Cost.** A second document, a second collection, and a second thing to look at when a fetch is
refused. The alternative was one breaker that is wrong about one of the two things it is asked.

## D-041 — Stop conditions escalate FR-06 per source, and can only ever stop

**Status:** Accepted · **Decided at:** Phase E step 3, 2026-09-15 · **Closes:** D17

D17 had to record four things about the first source contacted live: which, under whose approval,
at what rate, and on what stop condition. The first three are registry fields. The fourth was not
expressible at all, and the reason it needs to be is specific: FR-06's general answer to a 403 is
"soft block, cool the identity, retry once from another identity", and the SEC's published policy
says a 403 means the user agent is wrong. Retrying it is repeating the thing they asked us not to
do.

So `accessPolicy.stopConditions` sits on the approved source version — beside the licence terms,
carried through the same four-eyes lifecycle, read fresh at the point of use — and
`evaluateStopConditions` applies it. **The invariant that makes a second rule about one failure
safe is that a stop condition can only ever stop:** it never permits a request FR-06 refused,
never lowers a class, never shortens a backoff. It returns "halt" or "nothing to add", and the
FR-06 classification travels with either, because the classification is what the coverage record
and both breakers read. A test asserts that over every signal shape.

**A halt is the kill switch, not a new mechanism.** D5 already built something effective
immediately, effective mid-run because access is rechecked at the point of use, with a mandatory
reason that reaches the coverage statement, and **four eyes to release**. That last property is
what "requires fresh approval" has to mean if it is to mean anything, so a halt engages the kill
switch with `engagedBy: system` and a reason written for whoever will be asked to release it.

**The composition lives in the domain package**, not in the service. `applyObservedFailure`
classifies, folds into health, evaluates the conditions and engages the switch, in that order —
health **before** the halt, so releasing a halt does not release a source whose stored state says
nothing ever went wrong. It is in the pure package so the trip-wire harness and the live service
run the same code; a harness that re-composed those four steps would pass whenever the two
implementations agreed, including when both were wrong.

**Automatic halts are audited under a reserved platform trail** (`__platform__`), because they
have no tenant: nobody asked for them. Writing one into whichever customer's run observed it would
put a cross-tenant fact in one customer's trail; dropping it would leave a service that stopped
calling a source and cannot say why.

**Cost.** A per-source escalation is a second place to look when a source stops, and a badly
recorded stop condition halts a working source. The "can only ever stop" invariant bounds the
damage to over-refusal, which is visible in a coverage statement, and D5's four-eyes release is
what stops an over-eager halt being waved away by the person who caused it.

## D-042 — Every live source needs a named first-contact approval, not just the first one

**Status:** Accepted · **Decided at:** Phase E step 3, 2026-09-15 · **Generalises:** D17

D17 asked who approved the first deliberate live request and was answered for one source. Left
there, it would have been a ceremony performed once: the second source, and the twentieth, would
have gone live because somebody added a registry entry and nobody was asked anything.

So the rule is general. `FetchGateService` refuses any live fetch to a source whose active
approved version carries no `accessPolicy.firstContactApproval` — a named person, their role, the
date, and the decision it closes. The refusal is **source-level**, so it reaches the coverage
statement rather than sitting on one lead.

**Why it is separate from the version's own approval, when the version already goes through four
eyes.** Approving a registry entry says the _configuration_ is right: these domains, these
countries, this budget, this licence terms version. Accepting first contact says something else —
that this service will begin making requests to a third party who did not ask to hear from it, and
that a named person will answer for that. Those are different things to be responsible for, and
one signature covering both makes the second one invisible. The separation also gives an operator
a safe intermediate state that did not exist before: a source can be fully configured, reviewed and
approved, and still unreachable, which is exactly what you want while a publisher's terms are being
read.

**The consequence, stated so it is not discovered as a bug.** Adding a source to the registry is
no longer sufficient to make it reachable. A correctly configured, four-eyes-approved source with
no first-contact approval produces `NO_FIRST_CONTACT_APPROVAL` on every lead and a coverage gap
naming it. That is the intended behaviour and the refusal says what to do about it.

**Read strictly.** `SourceVersionService` resolves an approval with _any_ field missing to null
rather than to a partial one. A half-filled approval the gate accepted would be a live request made
under a name nobody actually wrote down, which is the failure D17 exists to prevent wearing a
record's clothes — the same reasoning D6 gives for refusing an unnamed robots exception.

**Mock mode is exempt**, because no publisher is involved: the fixture gate above it has already
established that a `FIXTURE_MOCK` connector cannot be live (T55).

**Cost.** A second approval step per source, and a failure mode that looks like a misconfiguration
to somebody who has not read this. Against that: the alternative is that the twentieth publisher
this service contacts was contacted because a form was filled in.

## D-043 — A source's endpoint is registry content, not connector code

**Status:** Accepted · **Decided at:** Phase E step 3, 2026-09-15

`accessPolicy.endpointUrl` records the exact URL a polling connector reads. It could have lived in
the connector, and putting it there would have been the obvious thing.

**Two reasons it is registry content instead.** A URL compiled into a connector is a request nobody
approved — it is not in the record an approver signed, it is not in the record an audit reads, and
changing it is a deployment rather than an approval. And it makes connectors per-source: the same
RSS parse then exists three times because three publishers have three addresses, and the third copy
is the one that eventually skips a gate.

With the address in the registry, **one** RSS connector serves every RSS source, and what
distinguishes SEC litigation releases from a Costa Rican gazette is a row somebody approved.

**This does not reopen the "no executable instruction in the registry" rule** (see the
`sourceContentSchema` header: no selector, no script, no template). A URL is validated as a URL,
and every request to it goes through `screenUrl`, the recorded robots position, the live robots
verdict, both breakers, the budget and the stop conditions, exactly like a request to a discovered
link. What the registry grants is an address, not behaviour.

## D-044 — The service is not Costa-Rica-only; scope is worldwide, one approved source at a time

**Status:** Accepted · **Decided at:** Phase E step 3, 2026-09-15 · **Supersedes the scope half of
D-010** · **Decided by:** the source/policy admin (Faisal Ali), not by engineering

D1 was closed on 2026-09-11 as **Costa Rica, es + en** and recorded as D-010. Phases D and E were
built against it: the seed enables `CR`, the capability-coverage rows describe CR, the name-frequency
gap is a CR gap, and D14 and D15 are both CR problems. On 2026-09-15 the policy owner revised it:
**the product is worldwide.**

This is recorded rather than argued. It is the decision of the person the register names as its
owner, and it is the kind of decision the register exists to let them take.

**What it changes, and what it deliberately does not.**

**It does not weaken FR-05's permission rule.** "EU", "MENA", "SEA", "LATAM" and "GLOBAL" are not
source permissions and `countryCodeSchema` still rejects every one of them explicitly. Worldwide
means the _set of approved sources_ is not bounded to one country; it does not mean a source may
claim a region. Each source still declares the countries it actually covers, and
`assertJurisdictionCovered` still refuses a source asked about a country it does not hold records
for. A British registry adapter is still not Costa Rican coverage, and it is still not Brazilian
coverage either.

**It does not weaken the per-source approval.** Every source still needs a named first-contact
approval (**D-042**) before this service will speak to its publisher. Worldwide is more sources to
approve, one at a time, not a blanket permission — and that is precisely why D-042 was generalised
before this decision landed rather than after.

**It does not bend FR-03.** A language is enabled only once it carries a measured recall figure from
the evaluation set. Worldwide means many languages and **none of them is measured**, so the coverage
statement keeps saying so on every run, in more languages than before. That is a real and growing
limit on what the product may claim, and it is the one cost of this decision that gets worse rather
than better with scale. G10 measures; until then, breadth of _sources_ is not breadth of _proven
recall_, and the two must not be allowed to read as the same thing in a coverage statement.

**What it makes easier, which is worth saying because it is the opposite of what a scope widening
usually does.** D14 (no free automatable officer-level source in Costa Rica) and D15 (Costa Rican
judgments likely published depersonalised, so there may be no name to match) are both **Costa
Rica-specific**. They remain open and they remain the answer for CR subjects; they stop being the
thing that bounds the whole product. Global discovery — GDELT is global by construction, Google News
is addressable per edition — has neither problem.

**What it leaves to be done, listed so it is not mistaken for done.**

- The bootstrap seeds `SEED_COUNTRIES = ['CR']` and a taxonomy whose categories enable `CR`. Those
  are configuration and are revised through the admin lifecycle, not through a deployment — but the
  seed is what a fresh stack starts from and it should reflect the decision.
- `capabilityCoverage` holds CR rows only. A jurisdiction with no row is not thereby supported:
  `interpretEmptyResult` already refuses to read a missing capability as an empty result, so the
  safe direction holds by construction. Rows for other jurisdictions are written as sources for
  them are approved.
- `HTTP_EVIDENCE_FETCH_DESCRIPTOR` declared `jurisdictions: ['CR']`, which was wrong under the old
  decision too: a transport is not jurisdiction-bound, and the jurisdiction gate is
  `authorisation.jurisdictionEnabled`, decided upstream by `FetchGateService`. Corrected here.
- No name-frequency distribution is loaded for **any** country, not only Costa Rica. Under the old
  scope that was one gap; under this one it is the general case, and the FR-08 top-decile penalty
  fires nowhere. Unchanged in substance, larger in scope, and printed on every bootstrap.

**Cost.** The honest one: worldwide breadth of sources with no measured recall in any language is a
product that can search widely and cannot yet say how well. Every coverage statement has to carry
that, and the temptation to let source count stand in for recall gets stronger the more sources are
approved. The invariants (I1–I10) are what stop it, and they do not know about countries.

## D-045 — The cascade walks the whole ladder, and it is built from the registry

**Status:** Accepted · **Decided at:** Phase E step 3, 2026-09-15

FR-05 tabulates eight rungs and what each does **on failure**. Two things it does not say had to
be decided, and both change what the product reports.

### What happens on success

The table is silent, and the two readings are different products. **First hit wins** — stop at
the first rung that returns candidates — is cheapest and politest. **Walk the whole ladder** is
broader and costs more requests.

**This walks the whole ladder, and the reason is axis D rather than preference.** FR-11 grants
`CORROBORATED` on one Tier 1 source _or two independent Tier 2–3 sources_. Stopping at the first
rung that returned anything makes the second clause structurally unreachable: a story found at
rung 2 ends the walk, rungs 3 to 6 are never asked, and no second independent source can ever be
found. The banding engine would carry a rule it could never satisfy, and every well-reported
allegation would band one level below what the evidence supports.

Two smaller signals agree. FR-05's own "reaching rung 7 **with no candidates**" implies rung 7 is
reached routinely, with or without them. And FR-10 clustering exists because the same story is
expected from several rungs — which only happens if several rungs are asked.

The cost is real and is bounded by things that already exist: per-source hourly and daily budgets,
both breakers, the stop conditions, and the planner's query cap. It is not bounded by stopping
early, which would have bought politeness with correctness.

### What is on the ladder

**A source sits at the rung its approved version records** — not the rung a connector was written
for. `LadderBuilder` reads `sourceVersions` fresh on every run and matches each approved source to
an adapter by `sourceId`.

That is what makes the ladder configuration. Approving an RSS source at rung 2 puts it on the
ladder; retiring its version removes it; narrowing its countries takes it off the runs it no
longer covers — all through the four-eyes lifecycle, none of it through a deployment. It is the
same rule as D-043 one level up: the _address_ of a source is registry content, and so is its
_position_.

Read fresh rather than cached, for the reason every other registry read in this service is: a
cached ladder keeps asking a source an administrator retired, and that window is the window
somebody asked us to stop.

### The distinction the whole thing exists to keep

**A source that answered "nothing" is not a gap. A rung with nothing behind it is.**

- `EMPTY` — the ladder worked, and this source had nothing. No coverage outcome.
- `NO_SOURCE` — nothing is approved at this rung, so it **was not searched**. A `SKIPPED`
  coverage outcome naming the rung.
- `FAILED` — asked and not answered. A `FAILED` outcome, so nobody investigates an outage at a
  publisher that is working.
- `REFUSED` — health said no: kill switch, licence, budget, breaker. A `SKIPPED` outcome carrying
  the reason verbatim.

Collapsing the first two is how "we did not look" becomes "there is nothing there", and it is the
failure this entire service is built to prevent. The visible consequence is that **mock mode now
admits it searched two rungs of seven**: rungs 0, 1, 3, 4 and 6 have no approved discovery source
and every run says so. Before this, discovery reported one line and the run looked far more
thorough than it was.

### What this deliberately does not do

**It does not invent an adapter to fill a rung.** Rung 0 is a local index of polled feeds and
there is no poller, so rung 0 reports unsearched on every run. An empty local index that always
answered "nothing" would convert a missing capability into a clean answer — the same move as a
mock in live mode, one layer along.

**It does not stop early except where the table says so.** Rung 6 is "record and stop"; every
other rung descends however it went. Stopping on a rung-2 failure would silently narrow coverage
on every subsequent run.

**Cost.** More outbound requests per query than a first-hit cascade, bounded by budgets and
breakers rather than by giving up early. A coverage statement that is longer and less flattering.
And a mock stack that now looks worse than it did yesterday while doing exactly the same work —
which is the point.

## D-046 — A connector type means a response format; a template is not a proposal

**Status:** Accepted · **Decided at:** Phase E step 3, 2026-09-15

Filling rungs 3 and 4 of the FR-05 ladder made two things explicit that D-043 implied.

### Rung 4 cost nothing. Rung 3 cost a parser. That asymmetry is the test.

**Bing News RSS needed no code at all.** It is `NEWS_DISCOVERY_RSS` at a different approved
address, with `endpointKind: QUERY_FEED` so the planned query goes in as one parameter. Adding it
is a registry row somebody approves — which is exactly what D-043 said adding a publisher should
be.

**GDELT needed `GdeltDiscoveryAdapter` and a connector type of its own**, because it returns JSON
rather than a feed and nothing can parse a feed out of JSON.

So the rule, stated so the next person can apply it: **a new connector type means a new response
format, not a new source.** If adding a publisher appears to need one, that is the signal to check
whether it really does. Two types now serve three rungs and will serve any number of RSS
publishers; a third arrives only when something answers in a shape nothing can read.

### The endpoint builder is shared because it carries a security rule

`buildEndpoint` was private to the RSS adapter. GDELT was the second connector to need it, and
copying twenty lines would have been quicker.

It contains the rule that **the query is set as one search parameter on the recorded endpoint,
never spliced into a string** — so a query cannot introduce a path segment, a host, a scheme or a
second parameter, because `URL` does the assembling rather than the escaping being careful. A
security rule that exists in two places is one that eventually disagrees with itself, and the
second copy is always the one that gets it wrong. It now lives in `discovery/endpoint.ts` with
`discovery/lead-mapping.ts` beside it, and both adapters call them.

`leadsFrom` moved for the same reason, carrying three rules that are the product rather than
convenience: a missing date stays null (FR-07), a snippet is never synthesised (FR-06 scores it),
and one story is one lead (FR-10, so axis D cannot count a syndicated copy as independent).

### A template is not a proposal, and is inert twice over

`sec-litigation-releases.ts` is a **proposal**: every fact in it was established by desk research
on a named date and it carries a named first-contact approval. The rung 2, 3 and 4 records are
**templates** — the endpoints are the widely documented ones and **nobody has loaded them**.

A widely documented URL is still a guess until somebody checks it, so each template is inert in
two independent ways: `firstContactApproval: null` (D-042 refuses it) and `robotsPosition:
NOT_ESTABLISHED` (the gate refuses that too). Either alone would be enough; both are there so a
template does not become live because one was edited. A test asserts both, and asserts that the
record itself says `ENDPOINT NOT VERIFIED` in its `policySummary` — in the record, not only in the
file header, because a record is read by whoever approves it and the file is not.

**No rate ceiling is recorded for any of them.** None of those publishers states a numeric limit,
and a guessed ceiling in the registry is a number somebody would later treat as the publisher's
own.

**Cost.** Three records that look ready and are not, which is a state somebody could find
confusing. Against that: the alternative was either three fabricated facts in records an approver
signs, or nothing at all on rungs 2 to 4 — and the second is what "fill the rungs" was asking to
change.

### GDELT's parse fails loudly rather than emptily

`parseGdelt` returns three outcomes, not two: `UNPARSABLE` for a body that is not JSON (GDELT
serves an HTML error page on some failures), `UNRECOGNISED` for JSON with no `articles` array, and
an empty list only for `articles: []`. Only the last means "nothing about this person".

That is the same rule the RSS parser follows and for the same reason — the shape has **not** been
verified against the live service, so a mismatch has to be a failure. A parser returning zero
articles for all three would turn "GDELT changed its response" into clean results for every
subject searched afterwards, silently, with nothing thrown (T84).

The adapter also deliberately ignores GDELT's own tone and theme scores. A discovery source's
opinion about a document is not evidence about a person, and FR-06 is explicit that filtering
never decides adversity.

## D-047 — The relevance filter refuses on facts, never on a score, and never on adversity

**Status:** Accepted · **Decided at:** Phase E step 4, 2026-09-15

FR-06 gives nine signals for deciding whether a candidate is worth a request. It gives no
weights, and no corpus exists yet to derive any. Three rules follow from that.

### It never decides adversity

A candidate that names the subject and no adverse term at all is still fetched. This is the
load-bearing property and it is easy to lose: a filter that required an adverse term would only
ever find evidence confirming a suspicion, and would never find the article that clears someone.
The adverse-term signal is scored as a statement about _topic_ — the signal's own `detail` says
"says nothing about what they did" — so nothing downstream can read proximity as conduct.

The GDELT adapter's refusal to read tone and theme scores (D-046) is the same rule on the other
side of the boundary: a discovery source's opinion about a document is not evidence about a
person.

### The score is recorded, explained, and does not gate

`minimumScore` defaults to 0, so the number never refuses anything unless somebody deliberately
configures a threshold. The method is `FR06_NINE_SIGNAL_UNCALIBRATED_v1` — the word is in the
identifier so it cannot be read as a measured judgement, and so a calibrated successor gets a
new name rather than quietly changing the meaning of stored scores. The score is computed only
over signals that could actually be evaluated, and the ones that could not are listed: a score
from six of nine signals must not be presented as a score from nine.

Refusals are therefore **categorical** — a fact about the candidate: outside the requested
window, not a document, or a copy of an origin already fetched.

### What is _not_ a refusal: the subject's name

The first draft refused a candidate whose title and snippet never named the subject, and the
mock fixtures caught it immediately — every lead was refused and every run returned nothing.

That was wrong for a reason worth recording, because it will look reasonable again. The FR-04
plan has **company-anchored query families**, which exist precisely to find documents naming a
_company_ the subject is associated with: "Fiscalía acusa a directiva de Inversiones Talamanca"
names the company and the role and not the person. Refusing those deletes the entire association
half of the product — silently, while the coverage statement still says the sources were
searched. A headline is also not the document; a name absent from a headline is routinely in the
second paragraph, which is the paragraph that matters.

It is a missing positive signal. The score says so, and the candidate is still fetched.

### The mock corpus now contains something the filter must refuse

`lead-nonarticle-0001` is a tag page — a real URL on a real publisher, naming the subject, with
no article behind it. Web search returns these constantly.

Without a lead of that shape, no mock run exercised a single refusal, and **a filter that never
fires is indistinguishable from one that was never wired in**. There is deliberately no document
at that URL in the fetch mock, so removing the filter turns the lead into a 404 and an INCOMPLETE
run rather than a quiet pass. An integration test asserts it is refused at `RELEVANCE` and _not_
at `FETCH`: a 404 there would mean the request was made before the candidate was judged.

### `RELEVANCE` is its own rejection stage

Not folded into `FETCH`. A reviewer reading "rejected at FETCH" about something that was never
fetched has been told something untrue about what the service did — and the distinction is also
the audit difference between a socket that opened and one that did not.

**Cost.** Recall is deliberately favoured over precision: the filter refuses little, so more is
fetched than a calibrated filter would fetch, against publishers' rate ceilings. That is the
right direction to err while no corpus exists — over-fetching costs requests, and over-refusing
costs findings nobody will ever know were missed. FR-16's labelled dataset is what changes this,
and the method name is what makes the change visible when it comes.

## D-048 — Live mode must never silently have no extractor, and the first live extraction is rule-based

**Status:** Accepted · **Decided at:** Phase F planning, 2026-09-15 · **Supersedes nothing; constrains D7**

### What was found

`sources.registry.ts` returns `extractionModel: null` for live mode, and
`search-pipeline.service.ts` treats a null extractor by rejecting the document:

> "No fetch or extraction adapter is configured in this mode, so the document was …"

So a live run does everything correctly — discovers real leads, filters them, passes the fetch
gate, opens a real socket, commits real evidence — and then rejects **every** document at
`EXTRACTION`. The run ends `SUCCEEDED / NO_MATCHES_FOUND / INCOMPLETE`.

That is the worst shape a failure can take in this product. It is indistinguishable, to anyone
reading the result, from "the source had nothing on this person" — and the coverage statement
would say the source was searched, because it _was_. The rejected leads carry the real reason,
but a reader who looks at the finding count sees a clean negative.

The null was not wrong when it was written. It was honest: no live extractor existed, and
returning the **mock** in live mode would have been far worse (T55 — a fixture must never serve
a live run). The defect is that the honest null produces a dishonest-looking _result_.

### Three decisions follow

**1. A live run with no extractor must fail loudly, not emptily.** The same rule the GDELT parser
follows (D-046): `UNPARSABLE` and `UNRECOGNISED` are distinct from `articles: []`, because only
the last means "nothing about this person". A missing extractor is a **configuration fault**, not
a search result. It belongs in the run's warnings and in the coverage statement as an unsearched
capability — never as a finding count of zero.

**2. The first live extractor is rule-based, and says so.** Not the D7 open-weight model. D7
cannot be closed yet — it requires a benchmark, and the labelled set has no document bodies to
benchmark against (phase-f.md §3.1). Blocking the entire live path on a decision that is itself
blocked on a corpus nobody has built would mean no live e2e for weeks.

So: a **non-mock, rule-based** `ExtractionModelPort` for live mode, with `modelId: null` and
`promptVersion: null` — which is the truthful value for an extraction no model participated in,
exactly as the mock's header already argues. It is not the mock: the mock is `mode: 'MOCK'` and
`jurisdictions: ['CR']`, and both must stay that way so a fixture can never serve a live run.

**3. "Rule-based" must not become permanent by default.** This is the failure mode START-HERE
rule 6 names — an open decision acquiring a silent default. The mitigations are that the
extractor's version string says what it is, every assertion it emits carries `modelId: null`
where a reader will see it, and D7 stays open with its real blocker (the corpus) recorded rather
than the symptom.

### What this costs, stated plainly

A keyword-and-span rule extractor finds what its table already knows and nothing else. Recall
against real prose will be poor, and unmeasured — there is no corpus, so no figure can be quoted.
It is the same honesty problem as the unreviewed Spanish lexicon (D-033): an unreviewed term does
not fail, it returns nothing.

Against that: the alternative is a live path that cannot produce a single finding, and every other
part of it — SEC-02 screening, robots, the breakers, the stop conditions, the relevance filter,
evidence commitment — stays unexercised against a real publisher until it exists. Those are the
parts where a defect is expensive, and the only way to find their defects is to run them.

**The extraction quality must therefore never be reported as a measurement.** FR-03's rule applies
by analogy: no recall figure exists, so none is quoted, and the coverage statement says the
extraction was rule-based and unbenchmarked.

### Built on 2026-09-16

`apps/api/src/sources/rule-based-extraction.adapter.ts`, wired in `sources.registry.ts` for live
mode. `apps/api/test/rule-based-extraction.test.ts` holds the three properties in place: it is
`mode: 'LIVE'` and needs no mock witness, every assertion carries `modelId: null`, and a category
the tenant has not enabled produces no assertion rather than a nearest-neighbour one.

Two rules were added while building it, and both are in the adapter's header. **Proximity, not
presence:** a conduct term is only read as being about the subject when it sits within 600
characters of one of their name forms, because a presence test over a whole page attributes its
sidebar to whoever the page happens to name. **An outcome wins:** where several stage terms are
near, an acquittal or dismissal is taken over a charge — D-047's rule reaching extraction, since a
rule that took the earliest or the highest match would systematically report the accusation and
drop the exoneration.

The missing-extractor half is in `search-pipeline.service.ts`: a null fetch or extraction adapter
now produces a `SKIPPED` coverage outcome named `capability:extraction`, a warning that says it is
a configuration fault rather than a result, and a rejected lead at the stage where it actually
stopped. And because a reader of a result cannot see the adapter, **every run that uses the
rule-based extractor says so in its warnings**, including that its recall has never been measured.

---

## D-049 — Normalisation is ours, the charset is the publisher's, and nothing is sniffed

**Status:** Accepted · **Decided at:** Phase F, F1, 2026-09-16 · **Implements:** phase-f.md §3.2

### What was found

The pipeline satisfied `ExtractionInput.text` — documented as "normalised text, with the offset
mapping back to the original held by the caller" — with one line:

```ts
const text = new TextDecoder().decode(fetched.data.body);
```

Two defects. **Raw markup was handed to the extractor and called text**, so every span a reviewer
would be shown, and every span the FR-07 validator will check, pointed into HTML. And **the
declared encoding was ignored**, so a Spanish page served as ISO-8859-1 decoded to mojibake and
the name-form matching silently stopped matching. Both failures end the same way: a clean
`NO_MATCHES_FOUND` that reads as an absence of news.

Neither had surfaced, because every fetch fixture is UTF-8 and nearly plain text.

### The decisions

**1. The charset comes from a declaration, and the declaration is ranked.** Byte-order mark, then
the `Content-Type` charset parameter, then the document's own `<meta charset>` or XML declaration,
then a default of UTF-8. A BOM outranks a header because it is in the bytes and cannot be a stale
server configuration; the header outranks the document because the transport is what the bytes
arrived under.

**2. Nothing is sniffed.** There is no byte-frequency guess at an undeclared encoding. Guessing is
how a document silently becomes a different document, and the cases where a guess would help are
exactly the cases where nobody can tell it guessed wrong. An undeclared encoding is **recorded as
undeclared** — `charsetSource: 'DEFAULTED'` reaches the finding record and a warning reaches the
run — so a reviewer looking at an accented name can tell whether the encoding was known.

**3. The offset map is kept, and the normalisation is recorded rather than the map.** Spans point
into the normalised text; `mapSpanToOriginal` converts one to offsets in the decoded original. A
finding stores the charset, its source and the normaliser version instead of a per-finding copy of
the map, because that triple plus the stored document reproduces the text exactly, and a stored
map is a second copy of the document in a shape that will drift.

**4. The markup stripper is hand-written, not a DOM library.** Two reasons, and neither is taste.
It cannot fail — real pages are not well-formed, and a parse error here turns a readable document
into a coverage gap — and `textContent` from a DOM library yields **no offsets at all**, which is
the one thing this module exists to produce. Inline elements deliberately do not insert a space:
`<b>Jo</b>hn` is one word, and splitting a name in half looks exactly like the person not being
mentioned.

**5. A body we cannot read says so.** A PDF is reported as `normalisable: false` with a sentence,
and the lead is rejected at `EXTRACTION` naming that reason. PDF and OCR are still unbuilt; what
is not allowed is decoding their bytes as if they were text, or letting "we could not read it"
reach a reader as "it said nothing" (the same rule as D-046 and D-048).

### What this costs

The stripper is a good approximation, not a browser. A page that hides its prose behind a client
render still yields little text — that is what FR-06's render trigger is for, and `allowRender` is
off at this call site. Boilerplate removal is not attempted at all: navigation and footer text is
in the normalised text, which means a keyword in a site's own menu can sit near a name. The
extractor's proximity window is what limits the damage, and it is a limit rather than a fix.

---

## D-050 — Tenant self-service API keys, replacing the D-007 deferral

**Status:** Accepted 2026-09-16. Supersedes the key-management half of **D-007**.

**Context.** D-007 deferred the commercial self-service layer, and recorded that keys were
**provider-managed in this phase**: an operator ran `pnpm key:issue` and handed the secret over.
`POST /v1/tenant/api-keys` returned `501` with that reason. That was right while there was no
commercial layer to hang self-service off.

It stopped being right for a reason that has nothing to do with commerce. A tenant that cannot
issue or rotate its own credential without a human on the provider's side does not rotate it. The
provider becomes the reason a customer's key outlives its usefulness, and "rotate your keys" turns
into advice nobody can act on at the moment they need to.

**Decision.** `POST`, `GET` and `DELETE /v1/tenant/api-keys` are implemented. A tenant holding
`apikey:manage` — which `tenant_admin` has — issues, lists and revokes its own machine keys.

**What self-service deliberately does not include.** Three limits, each a rule rather than an
omission, and each with a test that fails if it is removed:

1. **No escalation.** A key carries only roles the caller already holds. Without that, the weakest
   `tenant_admin` credential mints a `platform_admin` one and the role model is decoration.
2. **No crossing a tenant boundary.** The tenant is taken from the authenticated principal. There
   is no tenant field in the request body to ignore. Revoking a key that is not this tenant's
   answers `404`, not `403` — the second confirms it exists.
3. **No buying live access.** An `environment: "live"` key needs the tenant's entitlement to
   include `live` **and** the calling credential to be live. Entitlement is a commercial act by
   the provider; self-service issues credentials _within_ what was sold, it does not sell.

**What is unchanged.** The secret is returned once and never again. Only a hash is stored, so no
endpoint can return it a second time and no support process can recover it — a credential the
provider can read back is one the provider can leak. Creation and revocation are audited with the
actor and, for revocation, a mandatory reason.

**What this does not decide.** The rest of D-007 stands: plans, usage metering and billing remain
deferred, and `/v1/admin/plans`, `/v1/admin/tenants/{id}/usage` and `/v1/tenant/usage` still
answer `501`. Issuing a credential is not the same as selling one, and only the first is built.

**Consequence for the operator script.** `pnpm key:issue` remains, and remains the only way to
issue the _first_ key for a new tenant — a tenant with no key cannot authenticate to ask for one.
The scope derivation both paths use now lives once, in `packages/domain`, because two copies of
that would drift and the one that drifted would be the one issuing keys quietly wider than
intended.

---

## D-054 — `disabledAt` is a separate, reversible field from `revokedAt`

**Status:** Accepted and implemented 2026-09-16, as Phase I step **I4**.

**Context.** A key had exactly one way to stop working: `revokedAt`, one-way by design, because a
leaked secret must be permanently killable. That left no way to say "off for now" — a paused
integration, a rotation window, a key somebody is unsure about — and the only tool to hand was the
irreversible one.

**Decision.** Two fields, two routes, and they never merge.

| Action  | Field        | Route                                   | Reversible | For                              |
| :------ | :----------- | :-------------------------------------- | :--------- | :------------------------------- |
| Disable | `disabledAt` | `POST /v1/tenant/api-keys/{id}/disable` | Yes        | Pausing an integration, rotation |
| Enable  | `disabledAt` | `POST /v1/tenant/api-keys/{id}/enable`  | —          | Turning it back on               |
| Revoke  | `revokedAt`  | `DELETE /v1/tenant/api-keys/{id}`       | **No**     | A leaked or compromised secret   |

**Why they cannot be one field.** A single switch has to be either reversible or permanent. If it
is reversible, a leaked key can be turned back on and revocation stops meaning anything. If it is
permanent, pausing an integration for an afternoon destroys the credential and the tenant has to
re-issue and re-deploy. Both are wrong, in opposite directions, and no one field is right about
both.

**What follows from that, and is tested.**

- `verify()` refuses a disabled key exactly as it refuses a revoked one — one opaque `401` either
  way. The distinction is for the audit trail and the listing, not for whoever holds the key.
- **A revoked key cannot be enabled**, and cannot be disabled either. Both answer `409
ALREADY_TERMINAL`. Accepting a disable on a revoked key would imply enable could undo it.
- **A disabled key can be revoked.** "Paused" turning out to be "compromised" is exactly the path
  that has to work, and revoking does not clear `disabledAt` — it is a record of what happened.
- **A disabled key can be rotated, and stays disabled.** Disable, replace the secret, enable is
  the ordinary rotation sequence; refusing it would push the tenant to revoke and re-issue
  instead, which changes the key id their configuration holds.
- Both events are audited with an actor and a mandatory reason, and both are idempotent — a second
  disable writes no second entry, so the trail says when the key actually went off rather than
  when somebody last clicked.
- Enabling clears `disabledReason` with `disabledAt`. A stale reason on a working key reads as
  though it were still off; the history lives in the audit trail, which keeps both events.

**`status` in the listing names one reason, and names the actionable one.** A key can be revoked,
expired and disabled at once. The order is `REVOKED` → `EXPIRED` → `DISABLED` → `ACTIVE`, most
permanent first, because that is what the holder must act on: revoked and expired both mean
"issue a new one", disabled means "turn it back on". A key that was paused and has since expired
reads `EXPIRED`, with `disabledAt` still set to say it was also paused.

**Records written before this field existed have no `disabledAt`.** Every read goes through one
helper that treats a missing field as "not disabled". Without it, `undefined !== null` would
refuse every key already in the database the moment this deployed.

---

## D-051 — Customer passwords live in our own database, hashed

**Status:** Decided 2026-09-16 by the product owner, **against** the recommendation on file.
Closes D-051. Blocks nothing further in Phase I step I2, which can now be built.

**The recommendation was Keycloak** — this service has never stored a password, human identity is
OIDC end to end, and its security story is that it holds no credentials. The decision is to store
customer credentials ourselves rather than operate Keycloak for customer identity.

**What we therefore now own**, and each is work that belongs in the I2 estimate rather than
appearing later as a surprise: password reset, lockout and rate limiting on failed attempts,
rotation, MFA if it is ever wanted, and breach response for a credential store that now exists.

**One thing the wording of the decision must not become.** The instruction said "database
encrypted". Encryption is reversible — anything that can decrypt a password can produce it, and a
store the provider can read back is a store the provider can leak, which is the same reason API
key secrets are hashed rather than encrypted here. So passwords are stored as **argon2id hashes**,
which is the one-way version of the same intent, and the API key rule that only a hash is
persisted holds for human credentials too. If reversible storage was genuinely meant, that is a
different decision and needs reopening deliberately.

Unlike an API key secret — 32 bytes of CSPRNG output, where a slow hash would only add latency —
a password is low-entropy human input, so the slow memory-hard hash is exactly right here.

---

## D-052 — Email verification before a live key; no per-tenant live budget yet

**Status:** Decided 2026-09-16 by the product owner. Closes D-052.

**Decision.** A self-signed-up tenant gets a **sandbox key immediately** and a **live key once the
email address is confirmed**. The per-tenant live budget the brief proposed is **not** built in
this phase.

**What that leaves standing.** A verified address is a low bar, and the unmitigated consequence is
the one the brief states plainly: the SEC's free tier is **120 requests an hour for the whole
service**, a single search currently spends about 41 of them, and nothing yet stops one tenant
spending the hour. Our contact URL is in the publisher's logs, so the complaint arrives at us.

**So the fixed-feed fetch stops being an efficiency fix and becomes a prerequisite.** A `FIXED_FEED`
is currently fetched once per planned query rather than once per run. Fixing it cuts the spend of
a search by roughly forty times, and it is the cheapest thing standing between open signup and a
shared budget somebody exhausts. It should land before live keys are issued to tenants nobody at
Erly has spoken to.

---

## D-053 — Signup is open, with both key kinds from day one

**Status:** Decided 2026-09-16 by the product owner. Closes D-053.

**Decision.** Signup is **open to anyone** — no invite code. A new tenant may create **both**
sandbox and live keys, subject to the email verification in D-052. Payment and an approval step
before a live key are **deliberately later**, not now.

**What this means for I1.** `POST /v1/signup` grants `environments: ['sandbox', 'live']` and has
no gate beyond email verification. The tenant id is **generated, never taken from the body** — an
attacker-chosen id is how a signup collides with, or impersonates, an existing tenant.

**What has to be built so the later gate is not a retrofit.** The thing that is expensive to add
afterwards is not the check; it is adding it around tenants that already exist with live keys
issued under no gate. So live-key issuance reads its answer from tenant state — the entitlement
and the verification flag — rather than being unconditional in the route. Turning the gate on
later then means writing a different value into that state, not finding every tenant that was
created while there was no gate.

---

## D-055 — Live access is a value on the tenant record, not a condition in the issuing route

**Status:** Accepted and implemented 2026-09-16, as Phase I step **I1**.

**Context.** D-053 grants a self-signed-up tenant `environments: ['sandbox', 'live']` from the
first minute, and D-052 holds the live key behind a confirmed contact address. Payment and an
approval step are deliberately later. So there is a gate now and there will be more of them, and
the question is where they live.

**Decision.** One pure function, `decideLiveAccess(tenant, entitlement)`, is the only thing that
answers "may this tenant hold a live credential". `POST /v1/tenant/api-keys` calls it; the signup
response reports what it said. Nothing else decides.

**Why not an `if` in the route.** The expensive part of adding a gate later is never the check —
it is applying it to the tenants that already exist, with live keys issued while there was none.
A route-level condition leaves those tenants outside it and turns a future payment gate into a
migration and a hunt. A state-level condition judges every tenant, old and new, on the next call,
so turning a gate on is writing a different value.

**A missing flag means allowed, and that is deliberate.** Tenants provisioned before signup
existed carry no `createdVia` and no `emailVerifiedAt`. Reading that absence as "not verified"
would take live access away from every hand-onboarded customer on deploy — with no verification
email to re-send, because the address was never collected. The gate therefore applies to tenants
marked `createdVia: 'SIGNUP'`, which is exactly the population D-052 was reasoning about: nobody
at Erly has spoken to them. Same shape, and same reason, as `disabledAtOf` in D-054.

**Entitlement is checked first.** A tenant that was never sold live is told that, not told to
check their email — the second describes a route to live access that verifying will not open.

---

## D-056 — Signup is bounded per client address, and the bound is not the abuse answer

**Status:** Accepted and implemented 2026-09-16, as Phase I step **I1**.

**Context.** `POST /v1/signup` is the only route in the service that writes to the database with
no credential. D-053 made it open to anyone.

**Decision.** Attempts are counted per client address in a `signupAttempts` collection with a
one-hour TTL; past five in that window the answer is `429 RATE_LIMITED`, which is the one code in
the contract that promises the same request may work later. The attempt is recorded **before**
the check, so failed signups count too — otherwise a loop sending invalid bodies is unbounded,
which is the cheaper attack. The stored key is an HMAC of the address under the deployment
secret, not the address: a bare SHA-256 of an IPv4 address is four billion values and a laptop
walks it in seconds.

**What this is not.** It is a floor under an open door. It is **not** the per-tenant live budget
D-052 deferred, and it does nothing about the SEC's shared 120-requests-an-hour free tier.

**Two operational consequences, stated rather than discovered.**

1. **Behind a proxy, `req.ip` is the proxy.** Express is not configured to trust one, on purpose —
   `X-Forwarded-For` is whatever the caller typed, and a limiter keyed on a caller-chosen value is
   a limiter the caller opts out of. A deployment behind a load balancer must set `trust proxy`
   **before** this route is exposed, or every customer shares one bucket of five an hour.
2. **A contact address is not unique.** One person may legitimately own two tenants, the thing
   that must be unique is the user credential I2 introduces, and refusing a duplicate would tell
   an anonymous caller which addresses are already customers.

---

## D-057 — Signup says an address is taken; every other account route says nothing

**Status:** Accepted and implemented 2026-09-16, as Phase I step **I2**.

**Context.** The email address is the sign-in identity, so it has to be unique — two users with
one address makes "who is signing in" a question with two answers. That uniqueness is observable:
a second signup with a known address must fail somehow.

**The tension.** This service refuses to be an account-enumeration oracle everywhere else. One
opaque `401` for every credential failure (T03, T68). `404` rather than `403` for another tenant's
key, because the second confirms it exists. A list of this service's customers is a list of
compliance firms, which is worth stealing in a way an ordinary user list is not.

**Decision.** Signup answers `409 EMAIL_ALREADY_REGISTERED`, plainly. Every other account route —
`resend-verification`, `password-reset` — answers **identically** for a known address, an unknown
one and an already-confirmed one: `202`, same body, same sentence, nothing sent for the cases
where nothing should be.

**Why not hide it at signup too.** The only way is to make signup asynchronous: answer `202 check
your email` and deliver the tenant id by mail, so the response carries no evidence either way.
That is a real option and it is the upgrade path if this ever matters, but it costs the property
that makes the current API pleasant to integrate against — a signup that returns the tenant, its
versions and its live-access state in one synchronous response.

**What pays for the leak.** Signup is bounded per client address (D-056), so the route cannot be
walked through a word list quickly; and the fact learned is narrow — that an address is a
customer, not which tenant, nor anything about it.

**This is a trade, recorded as one.** If the customer base ever becomes sensitive enough that
membership alone is the secret, reopen this and make signup asynchronous.

---

## D-058 — No mail transport is configured, and production refuses to start rather than pretend

**Status:** Accepted and implemented 2026-09-16, as Phase I step **I2**.

**Context.** I2's verification and password-reset flows need to deliver a token to an address.
Nothing has decided what sends it — SMTP, SES, or a provider — and guessing would put a dead
configuration key into the schema and a dependency into the build.

**Decision.** `NotificationPort`, with two adapters and a third that deliberately does not exist:

| Adapter                           | Where       | What it does                                                          |
| :-------------------------------- | :---------- | :-------------------------------------------------------------------- |
| `MailboxNotificationAdapter`      | Local, test | Writes to `outboundEmails` and logs. That collection **is** the inbox |
| `UnconfiguredNotificationAdapter` | Production  | Refuses, naming the problem                                           |
| A real transport                  | —           | Not built. Nothing has chosen one                                     |

**Why a refusal and not a no-op.** A no-op mailer produces a deployment where signup looks
healthy, verification emails go into a database nobody reads, and every customer sits unverified
and unable to reach live — with no error anywhere. That is the same class of failure as a fixture
answering as though it were a live source, and this codebase refuses that one loudly too.

**Sending never fails a signup.** The tenant is committed first, and the email goes afterwards,
outside the transaction — the transaction body can run more than once under the retry policy, and
an email sent from inside it would be sent again on each attempt. A failed send leaves the address
unconfirmed, which the response says, and `resend-verification` is the way back.

**`PUBLIC_APP_URL` is optional and is not guessed at.** With no value, the emails carry the token
and the endpoint to send it to rather than a link to a host nobody confirmed. It is deliberately
not derived from `CORS_ORIGINS`: that list says who may call this API, which is a different
question from where the customer's interface lives.
