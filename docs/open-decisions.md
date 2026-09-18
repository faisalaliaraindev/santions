# Open decisions

Seeded with D1-D10 from section 12 of the implementation plan, plus decisions this
implementation has surfaced. Each carries an owner and the gate by which it must close.

**Nothing here may harden into an accidental default.** Where a working assumption is in
force, it is stated as such and the code reflects that it is provisional.

| ID        | Decision                                                                                                                               | Owner                                 | Close by                          | Status                                                                                                                                                                                                                                             |
| :-------- | :------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------ | :-------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1        | Which jurisdictions and languages are enabled first                                                                                    | Source/policy admin                   | G5                                | **CLOSED 2026-09-11** — Costa Rica; es + en (D-010). **Scope revised 2026-09-15 to worldwide (D-044)**; the FR-03 language rule is unchanged                                                                                                       |
| D2        | The declared archive horizon, per source, published on every result                                                                    | Source/policy admin                   | G10                               | Open                                                                                                                                                                                                                                               |
| D3        | Which categories are on by default                                                                                                     | Taxonomy admin                        | G5                                | **CLOSED 2026-09-11** — all seventeen (see D-009)                                                                                                                                                                                                  |
| D4        | The exact boundary between adverse media and list matching for designations                                                            | Product + compliance                  | G7                                | Open                                                                                                                                                                                                                                               |
| D5        | The reviewer capacity assumption that thresholds are set against                                                                       | Product + compliance                  | G7                                | Open                                                                                                                                                                                                                                               |
| D6        | How robots exceptions for official sources are approved and recorded                                                                   | Source admin                          | G6                                | Open — **raised with specifics 2026-09-14**, in the direct path                                                                                                                                                                                    |
| D7        | Which open-weight extraction model, benchmarked on the labelled set                                                                    | Engineering                           | G7                                | Open — **blocked, and not on the critical path for the first live run** (see below, 2026-09-15)                                                                                                                                                    |
| D8        | Retention per source and jurisdiction for evidence text                                                                                | Compliance                            | G5                                | **CLOSED 2026-09-11** — configurable, 30-day default (see D-012)                                                                                                                                                                                   |
| D9        | Whether numeric confidence figures are ever shown (default: no)                                                                        | Product                               | G7                                | Open — default no, enforced                                                                                                                                                                                                                        |
| D10       | The minimum identity data the integrating application must supply                                                                      | Product + Zquence                     | G3                                | **CLOSED 2026-09-11** — a name (see D-011)                                                                                                                                                                                                         |
| **D11**   | Whether the results list must render procedural stage and outcome status at the same visual weight as the band                         | Product + design                      | G8                                | Open                                                                                                                                                                                                                                               |
| **D12**   | Search index: OpenSearch or Meilisearch                                                                                                | Engineering                           | G4                                | **CLOSED 2026-09-11** — Meilisearch, on C4's figures (see D-002)                                                                                                                                                                                   |
| **D13**   | Whether search acceptance waits for the index write (~94ms of its latency)                                                             | Engineering + product                 | G8                                | Open — measured in C4, see D-014                                                                                                                                                                                                                   |
| **D14**   | What feeds the FR-02 association graph in Costa Rica, given no free automatable officer register                                       | Product + compliance                  | G5                                | Open — raised by D0, 2026-09-11                                                                                                                                                                                                                    |
| **D15**   | What the Costa Rican primary-source evidence base is, given depersonalised judgments                                                   | Product + source admin                | G6                                | Open — raised 2026-09-11, **untouched; re-raised 2026-09-14**                                                                                                                                                                                      |
| **D16**   | Whether shared source-registry administration should need a platform role rather than any `source_admin`                               | Product + security                    | G8                                | Open — raised by D1, 2026-09-11                                                                                                                                                                                                                    |
| **D17**   | Which source receives this project's **first deliberate live request**, under whose approval, at what rate, and on what stop condition | Source admin (approver) + engineering | G10, **and before any live call** | **CLOSED 2026-09-15** — SEC litigation-releases RSS, approved by Faisal Ali (see below, and D-041)                                                                                                                                                 |
| **D18**   | Whether this service may make its **first live request to `api.gdeltproject.org`**, under whose approval, at what rate                 | Source admin (approver) + engineering | Before any GDELT call             | **CLOSED 2026-09-18** — approved by Faisal Ali, Source admin; see `docs/decisions.md` D18 and `docs/sources/gdelt-evidence.json`                                                                                                                   |
| **D19**   | Whether to adopt `fast-xml-parser` v5, once its six 2026-created runtime dependencies have been looked at                              | Engineering                           | Before v5 is needed               | Open — raised 2026-09-15 by D-039 **as D18**, renumbered 2026-09-18 (see the note below); **4.5.7 is pinned and nothing needs v5**                                                                                                                 |
| **D-051** | Whether customer identity lives in Keycloak or in our own password store                                                               | Engineering + product                 | Before Phase I step I2            | **Closed 2026-09-16** — our own store, in our database, against the recommendation on file. Passwords are argon2id hashes, not reversible encryption; we now own reset, lockout, MFA and breach response. See [decisions.md D-051](./decisions.md) |
| **D-052** | Whether a self-signed-up tenant may hold a live key with no verification, and on what budget                                           | Product + compliance                  | Before Phase I ships              | **Closed 2026-09-16** — live key after email verification; **no** per-tenant live budget in this phase. That leaves the shared 120/hour SEC budget unprotected, so the fixed-feed-per-query fetch must be fixed before live keys are handed out    |
| **D-053** | Whether signup is open to anyone, or invite-only at first                                                                              | Product                               | Before Phase I step I1            | **Closed 2026-09-16** — open, no invite code, both key kinds from day one. Payment and live-key approval are later, and live issuance reads tenant state so the gate is not a retrofit                                                             |

---

## Detail on individual decisions

The seeded decisions (D1-D10) appear here once they are raised with specifics; the rest were
surfaced by the implementation itself.

### D7 — Which open-weight extraction model

**Raised with specifics at the start of Phase F, 2026-09-15.** Two things changed about it.

**It cannot be closed as written.** D7 says "benchmarked on the labelled set".
`packages/evaluation/src/dataset/seed.ts` holds 16 cases carrying document **metadata**
(`documentId`, `tier`, `issuingAuthorityId`) and the **axis inputs** a pipeline would produce.
It carries **no document bodies**. That is correct for what it was built for — D-005 made it the
seam that lets `runAllInvariants` run against real pipeline output without touching the harness —
but you cannot compare extraction models on a corpus with nothing to extract from.

**So D7 has an unscheduled prerequisite: a labelled extraction corpus.** Three options with a
recommendation are in `docs/execution/phase-f.md` §3.1. It is a real decision and belongs in
`docs/decisions.md` when it is made.

**And it is no longer blocking the live path.** D-048 decided that the first live extractor is
**rule-based**, with `modelId: null` because that is the truthful value, so a live end-to-end
search does not wait on a model choice that is itself waiting on a corpus. D7 stays open, with
its real blocker recorded rather than its symptom.

**The risk to watch is the one START-HERE rule 6 names:** "rule-based" becoming permanent by
default. D-048 records the mitigations and states the cost — recall against real prose will be
poor and unmeasured, and must never be reported as a measurement.

### D6 — How robots exceptions for official sources are approved and recorded

**A seeded decision (D1–D10), raised with specifics at the start of Phase E, 2026-09-14.** It is
due at **G6** and it is in the direct path rather than ahead of it: `HttpEvidenceFetchAdapter` is
being written now, and it has to honour whatever this decides.

**What exists in code today, which is two halves that do not meet.**

- `sourceContentSchema.robotsPosition` — an enum, `HONOURED | EXCEPTION_APPROVED |
NOT_ESTABLISHED`, one value per source version. It already travels through the D1 four-eyes
  lifecycle like any other registry content, so changing it is proposed by one person, approved by
  a second, and immutable once active. That part is sound.
- `FetchAuthorisation.robotsExceptionApprovedBy` — a nullable string on the fetch port. The mock
  refuses an `EXCEPTION_APPROVED` authorisation with nobody named, and the real adapter does the
  same, because FR-06 requires the exception be "approved by a named person — never a global
  setting".

**Three gaps between those halves. They are why this cannot be left to a working assumption.**

1. **There is nowhere to record the approver.** The port demands a name; the registry schema has
   no field that holds one. So a source marked `EXCEPTION_APPROVED` today **cannot be fetched at
   all** — there is no value the adapter could put in that field, and a null is refused. The gate
   is safe and the feature is unreachable, which is exactly the state a decision exists to end.
2. **The position is per source, and FR-06 requires per source _and_ per jurisdiction.** A source
   version declares `countries` (up to fifty of them) and a single `robotsPosition`. One field
   spanning a source's whole country list is a smaller global setting, not an exception.
3. **An exception has no scope and no expiry.** `EXCEPTION_APPROVED` currently means "this source,
   all of it, forever". Real robots exceptions are narrower than that: one gazette path, on one
   stated legal basis, reviewed periodically.

**What this decision does _not_ touch**, so it is not asked to carry more than it is. Robots is
honoured by default; `UNKNOWN` refuses rather than being read as permission; and CAPTCHAs, bot
challenges, paywalls, login walls and access controls are never bypassed by any path, exception or
no exception. This is only about the narrow case of an **official publisher whose robots.txt blocks
a document we are entitled to read** — a gazette, a court bulletin, a regulator's enforcement
archive.

**Options.**

1. **Keep the bare enum, add a free-text approver field.** Cheapest. Per-source only, no scope, no
   expiry, and the approver is a string somebody types.
2. **A structured exception record on the source version**: the approver, the approval date, the
   jurisdictions covered, the path prefixes covered, the legal basis relied on, and a review date.
   Carried through the existing four-eyes lifecycle, so the approver is **the person the lifecycle
   recorded** rather than a name typed into a box. The adapter then checks the URL's path against
   the recorded prefixes, so an exception for `/boletines/` does not authorise the rest of the site.
3. **No exceptions at all in the first release.** Robots is honoured absolutely, and a blocked
   official source is a permanent, named coverage gap.

**Recommendation to the decision owner: option 2**, with **option 3 as the honest fallback** if it
turns out no exception is actually needed for Costa Rica. Option 1 is the one that looks like a
record and is not: an unattributed, unscoped, non-expiring exception is the global setting FR-06
names, wearing a record's clothes.

**What engineering does while this is open, stated as provisional so it cannot harden.** The fetch
adapter refuses `UNKNOWN` robots, and refuses `EXCEPTION_APPROVED` with no named approver.
**No exception can be applied today.** A source that needs one is blocked and says so in its
coverage outcome — it is never quietly fetched.

**What the decision owner is being asked, concretely.**

- **Does any approved Costa Rican official source actually block what we need?** This is desk
  research, not a decision, and it should be settled first, because option 3 may turn out to be
  free. Note that reading those robots.txt files is itself an outbound request: **no live source
  has ever been contacted by this project**, so doing it is a deliberate first-contact decision,
  not something engineering should do quietly in the course of answering this question.
- **Who approves an exception** — is the named person the lifecycle's second approver, or a
  separate named legal owner who has to be recorded as well?
- **Is an exception scoped to paths and to one jurisdiction, and does it expire?**

**Must close by G6**, because the fetch adapter's authorisation gate encodes the answer and
shipping the adapter against option 1 makes option 2 a migration rather than a configuration change.

### D11 — Visual weight of stage and outcome status relative to the band

**Raised at:** G2, while reconciling the seed dataset with the banding engine.

A well-evidenced acquittal correctly bands as `CORROBORATED` (see `docs/decisions.md`
D-008): the band states how well the evidence supports the connection, and what is
corroborated is an acquittal. The stage and the outcome status carry the fairness.

That is sound as a data model and is defensible in the evidence-detail view, where all
attributes are shown together. The open question is the **results list**, where a reviewer
scans many findings quickly. If the band is rendered prominently and the stage is rendered
as secondary metadata, a reviewer under time pressure can read `CORROBORATED` as "confirmed
adverse" for a person who was acquitted. That is precisely the unfairness FR-04 F8 and
invariant I7 exist to prevent, reintroduced at the presentation layer.

**Options:**

1. Render band, stage and outcome status at equal visual weight in the results list.
2. Suppress the band in the list for findings whose outcome status is not adverse, showing
   the stage instead.
3. Leave the band prominent and rely on the stage label adjacent to it.

**Recommendation to the decision owner:** option 1. It costs list density and nothing else.
Option 3 is the current implicit default and is the one that fails under time pressure.

**Must close by G8**, because FR-14 page 5 (results) cannot be signed off without it, and
the G8 exit condition requires a human to review a complete search.

### D12 — Search index choice — CLOSED 2026-09-11

**Raised at:** G1, deferred deliberately. **Closed at:** C4, on the measurement it was deferred
to. Full reasoning in `docs/decisions.md` D-002; figures in
[`docs/measurements/c4-search-index.md`](./measurements/c4-search-index.md).

**Meilisearch.** The switch condition D-002 set — OpenSearch if the matcher needs custom
analysers or multi-field boolean scoring Meilisearch cannot express — was tested and not met.
The matcher does need multi-field retrieval (raw-name recall falls from 81.9% to 67.6% between
1,000 and 100,000 subjects); Meilisearch expresses it in one round trip at 6.35ms p95, flat
across that range, at 95.2% recall.

Closed with its limits stated: 100,000 subjects not 10⁷, no concurrency test, the `documents`
index untested, and the non-Latin path unmeasured because no real `TransliterationPort` exists
yet — `TRANSLITERATION` recall is 0% for every strategy and says nothing about the index. The
re-open triggers are listed in D-002 and the seam stays in place to serve them.

### D13 — Whether search acceptance waits for the index write

**Raised at:** C4, from the measurement. See `docs/decisions.md` D-014.

`POST /v1/searches` costs 127ms p50 against Meilisearch and 33ms against the in-process index.
The ~94ms difference is the request waiting for the post-commit index write to become
searchable — something the request is explicitly allowed to lose and which the FI-10 reconciler
already covers.

Keeping the wait guarantees an accepted search is immediately matchable. Dropping it returns in
~33ms and leaves `indexState: 'PENDING'` for the reconciler, at the cost of a window where an
accepted search is not yet matchable. Which is safe depends on whether anything reads the index
between acceptance and the run completing.

**Must close by G8**, with Phase F, because the consumer's ordering is what decides it.

### D14 — What feeds the association graph in Costa Rica

**Raised at:** Phase D step D0, 2026-09-11. Evidence in
[`sources/cr-dossier.md`](./sources/cr-dossier.md).

There is no known free, automatable, officer-level company source in Costa Rica. The Registro
Nacional publishes representatives, but only behind free registration **and a CAPTCHA**, which
this project will not bypass by any path. The free machine-readable alternative,
`api.hacienda.go.cr`, confirms that a company exists and is active and says **nothing about who
directs it**.

So FR-02 — resolve the person to officer records before dispatching company queries — has no
data source in the only enabled jurisdiction.

**The engineering answer is already decided and needs no one's permission:** build the graph,
prove it against a UK adapter, and report CR association coverage as `UNKNOWN` — never asked,
because nothing approved could be asked. That is honest and it is what Phase D will do.

**What actually needs deciding, by someone other than engineering:**

- whether company association screening is in scope for CR customers at all in the first
  release, given that it will return `UNKNOWN` every time;
- whether a paid register is acceptable, which would breach the zero-paid-subscription
  constraint this whole service is built on and is therefore a business decision, not a
  procurement one;
- whether user-supplied companies — which FR-01 already accepts as candidate associations
  labelled as supplied and unverified — are the intended CR path, and if so whether the product
  says so plainly to the reviewer.

**Must close by G5.** Until it does, the CR coverage statement says association coverage is
`UNKNOWN` and why.

**Update, Phase D step D2 (2026-09-14):** the engineering half is now built. The UK Companies
House adapter exists and works against a real contract, and it declares `jurisdictions: ['GB']`
so that asking it about Costa Rica throws rather than returning a coverage gap. Nothing about
that changes the answer for CR, and the decision is unchanged and still open — but it is now
open with the alternative fully built, so closing it is a product call about scope rather than a
question about whether the engineering is feasible.

### D15 — The Costa Rican primary-source evidence base

**Raised at:** Phase D step D0, 2026-09-11. Evidence in
[`sources/cr-dossier.md`](./sources/cr-dossier.md).

The Poder Judicial runs a personal-data regulation over its public databases, a de-identification
protocol, a de-personalising tool and a **Repositorio Único de Sentencias Judiciales
Despersonalizadas**. The likely consequence is that published CR judgments do not carry the names
of the parties.

A depersonalised judgment is not a weak match — it is not a match at all, because there is no
name in it to match against. If that holds across the board, the tier-1 primary source this
product's authority reasoning was designed around does not exist for Costa Rica, and CR adverse
search rests on the Boletín Judicial, La Gaceta, prosecutor and police bulletins, and the press.

**What must be established first, and it is desk research, not a decision:** whether any class of
CR judgment is published with parties named. Do that before deciding anything.

**Then the decision:** whether a CR offering whose highest-authority named evidence is an official
gazette notice or a police bulletin meets the standard this product claims. It changes the FR-08
Axis D profile of every CR result, and it is a product and compliance judgement, not an
engineering one.

**Must close by G6**, because Phase E's cascade rungs and per-source tiers encode the answer.

**Status check, 2026-09-14 (Phase E step 2): untouched, and now the nearer of the two blockers.**
Nothing has moved on D15 since it was raised three days ago — no desk research has been done and no
product position has been taken — while the phase that depends on it is underway. The cascade's
rung tiers are step 3, which is the next step after this one, so this is the point at which an open
D15 starts costing work rather than sitting behind it. Two things the owner should know: the
research question ("is any class of CR judgment published with parties named?") is answered by
reading CR judicial publications, which is **an outbound request to them** and therefore waited on
**D17** — closed 2026-09-15, but closed for the **SEC feed only**: a CR judicial portal is a
different publisher and needs its own named approval before anything is sent to it; and until it closes, step 3 will encode a provisional tier ordering that a later answer
may invalidate, which is a rework cost, not a correctness one.

### D16 — Who may administer the shared source registry

**Raised at:** Phase D step D1, 2026-09-11, while wiring the approval lifecycle.

Taxonomy and policy versions are tenant-owned; **source configuration is shared** (§6.3: shared
source configuration must never contain customer subjects or queries), because a publisher's
licence, authority tier and rate limits are properties of the publisher rather than of a
customer.

That sharing has a consequence the permission model does not currently express. `source_admin`
is a tenant-scoped role, so a source administrator belonging to one customer can propose,
approve and suspend registry entries that **every** tenant screens against. Nothing today
narrows that: `decideAccess`'s tenant comparison does not apply to a record that belongs to no
tenant, so the permission check is the only gate. Every such change is audited under the actor's
own tenant, so it is at least attributable — but attribution is not authorisation.

**The options, and none of them is an engineering preference:**

1. Leave it, and rely on the fact that `source_admin` is granted rarely and audited fully.
2. Add a platform-scoped source administration role, and demote `source_admin` to proposing only.
3. Make registry entries tenant-scoped, accepting that the same publisher is then configured
   repeatedly and can be configured inconsistently between customers.

**Recommendation to the decision owner:** option 2. It keeps one registry — which is the thing
that makes source health, budgets and breaker state meaningful — while making the cross-tenant
blast radius a deliberate grant rather than a side effect of a tenant-scoped role.

**Must close by G8**, because the control panel will render whatever this decides, and shipping
the panel against option 1 makes option 2 a migration rather than a configuration change.

### A note on the D18 number

**`D18` means the GDELT first-contact approval.** It was raised and closed on 2026-09-18 and is
written into the active `gdelt-doc-v2` source version, into its audit trail, and into
`docs/decisions.md`.

The number was already in use: on 2026-09-15, `D-039` opened "whether to adopt `fast-xml-parser`
v5" as D18. That item is **now D19**. It was the one that moved because it is an open engineering
question referenced only in narrative — the phase-E brief and two handoff entries — whereas the
GDELT approval is a governance fact recorded inside an activated source version and an append-only
audit log, where a number cannot be corrected after the fact without rewriting the thing that
exists to be unrewritable.

Handoff entries dated on or before 2026-09-15 that say "D18" mean the parser question, now D19.
They are left as written: a handoff log is a record of what a session actually said.

### D17 — The first deliberate live request — CLOSED 2026-09-15

**Raised at:** Phase E step 2, 2026-09-14. **Closed at:** Phase E step 3, 2026-09-15, by the
source admin. Engineering's half is recorded as `docs/decisions.md` **D-041**.

**The answer, in the four parts the decision was written in.**

1. **Which source.** The **SEC litigation-releases RSS feed**
   (`https://www.sec.gov/enforcement-litigation/litigation-releases/rss`), with the press-releases
   feed as a second, later. It was chosen on the criterion the decision itself set: terms that
   permit automated access in plain words, published by an institution whose expectations are
   written down rather than inferred, so that the first request this project ever makes is one
   nobody has to argue about afterwards. It is **not Costa Rican coverage** and must never be read
   as any — it is the source against which the live path is proved. The CR evidence base is
   **D15**, still open.
2. **Under whose approval.** **Faisal Ali, Source admin, 2026-09-15.** Recorded on the source
   version itself, in `accessPolicy.firstContactApproval`, rather than in a document beside it —
   so the approval travels with the record the fetch gate reads, and a later reader of that record
   does not have to find this file to learn who accepted the request.
3. **At what rate.** The recorded ceiling is the SEC's own published fair-access limit of **10
   requests per second per IP**, aggregated across machines. Actual usage is **one conditional GET
   every fifteen minutes** — about 0.001 req/s, roughly a thousandth of the ceiling — with
   `If-None-Match` / `If-Modified-Since`, so most polls return 304 and no body. The dumb backstop
   underneath is a budget of 6 calls an hour and 120 a day, which D5's breaker already enforces
   without new code.
4. **On what stop condition.** **403 halts**, and resuming requires fresh approval — their policy
   states that a request without a descriptive user agent is refused with 403 and the IP may be
   blocked for about ten minutes, so a 403 is a statement about _us_ and a retry repeats what they
   asked us not to do. **429 halts** after its stated cooldown is honoured in full: being
   rate-limited at a thousandth of the ceiling would mean the recorded rate was wrong, and the
   answer to a wrong rate is to look at it. **Three consecutive server errors halt.** Plus the hard
   daily cap and the global kill switch. All four are recorded on the approved version and are
   proved to fire by the trip-wire harness (`apps/api/test/fetch-tripwires.test.ts`).

**The first live act, when it happens, is a single `GET https://www.sec.gov/robots.txt`.** It is
the smallest possible first contact, and it doubles as the **D6** evidence-gathering step for this
source: reading their robots is itself the outbound request D6's research question needs, against a
publisher whose access policy is already known-permissive. The SEC's policy says it may change, so
robots is re-read at fetch time rather than trusted from the registry record.

**It happened on 2026-09-16T10:56:04.310Z.** `GET https://www.sec.gov/robots.txt`, HTTP 200, 916
bytes, verdict **ALLOWED** for the feed path — recorded by the script at the time in
`docs/sources/sec-robots-evidence.json`. The source version was then approved and activated
through the D1 lifecycle (`source:approve`, `source:activate` at 2026-09-16T11:00:03Z), its
`robotsPosition` moved from `NOT_ESTABLISHED` to `HONOURED` on the strength of what the robots read
actually said, and the feed has been polled successfully since.

That ordering held: the robots read was genuinely first, and the gate's refusal of
`NOT_ESTABLISHED` is what made it impossible to do it the other way round. The full record of what
has been contacted and when is `docs/sources/first-live-contact.md`.

**What closing this does not license.** One source, under one approval. Every other source —
including every Costa Rican one, and including the press-releases feed named above — is a separate
first contact and needs its own named approval before anything is sent to it. **D15**'s desk
research reads a CR judicial portal, which is a different publisher; it is no longer blocked on
"nobody has decided that we may ever contact anyone", but it is not covered by this approval.
