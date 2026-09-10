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

## D-002 — Search index: deferred to G4, with the workload test that decides it

**Status:** Open · **Gate:** G4

The plan requires a self-hosted search index (OpenSearch or Meilisearch) in the mandatory
local stack, and requires the choice to be recorded here with workload evidence (G4).

The choice is deliberately **not** made yet. Both are free and self-hostable, and the
deciding factor is the FR-08 matcher-latency workload test, which cannot run before the
matcher exists. Making the choice now would be a preference dressed as a decision.

What the test must measure (G4): matcher latency against the index, separately from API
acceptance latency and total search latency, over the FR-16 corpus with the name-form
expansions of FR-08 (transliterations, phonetic keys, word-order permutations).

Working assumption for local compose, to be confirmed or overturned by that test:
Meilisearch, for a materially smaller local footprint. OpenSearch is the likelier answer if
the matcher needs custom analysers or multi-field boolean scoring that Meilisearch cannot
express.

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
