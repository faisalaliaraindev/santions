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
| D6        | How robots exceptions for official sources are approved and recorded                                                                   | Source admin                          | G6                                | **CLOSED 2026-09-21** — Faisal Ali, Source admin. Host-scoped exception on the approved version; scheduled-artifact path only                                                                                                                       |
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
| **D20**   | Whether Google News RSS may be activated as an FR-05 rung-2 discovery source                                                           | Source admin (approver) + product     | Before any `news.google.com` call | **CLOSED 2026-09-22 — NO.** Google's own Terms of Use restrict the service to personal, non-commercial use and prohibit automated access. Stays **PROPOSED**; no request has ever been made. **Amended 2026-09-22 (D20-A)** to permit a *single bounded technical diagnostic* through our own SearXNG instance — the refusal, the governance status and `effectiveEnabled: false` are all unchanged by it. See below, `docs/sources/evidence/google-news-rss-en-us.json` and `docs/sources/evidence/google-news-searxng-diagnostic.json`                     |
| **D21**   | The per-engine governance matrix for SearXNG adverse-media discovery — one reading per engine                        | Source admin (approver) + product     | Per engine, before it is relied on | **CLOSED on all six readings, 2026-09-22.** All six engines are **technically integrated**. Five default to ON and a tenant narrows that through `PUT /v1/tenant/discovery/engines`; **Google defaults to OFF** (amended later on 2026-09-22) so that a future governance edit alone cannot activate it fleet-wide. The readings: Google is **REFUSED (D20)** and blocked at execution; the other five are **PERMITTED under D21**, as a recorded product-owner acceptance of residual risk rather than a completed legal review — each engine's limitation is retained verbatim in its `evidenceNote`. See below |
| **D22**   | Whether this service may make its **first live requests to `en.wikinews.org`**, and fetch articles from that one domain | Source admin (approver)               | Before any `en.wikinews.org` call | **CLOSED 2026-09-23 — approved by Faisal Ali, Source admin.** Evidence read: robots `ALLOWED` for `/wiki/`, Wikimedia Terms of Use loaded. `wikinews-en` v1 is **ACTIVE** through propose → submit → approve → activate with **two distinct principals**. Scoped to `en.wikinews.org` ALONE — explicitly **not** a blanket approval for SearXNG-discovered publishers, which remain `PUBLISHER_NOT_APPROVED` per candidate. See `docs/sources/evidence/wikinews-en.json` and below |
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

> **CLOSED 2026-09-21 by Faisal Ali, Source admin.**
>
> **The decision.** An exception is a record on the approved source version,
> `accessPolicy.robotsException`, carrying the approver's name and role, the date, the decision
> reference, the scope in the approver's own words, and — the part that makes it an exception
> rather than a smaller global setting — **`deliveryHosts`, the exact hosts it covers**. Bare
> hostnames, never patterns: `*.amazonaws.com` is most of the internet.
>
> **What it permits.** A hop onto a named host may proceed without an established robots position,
> on the **scheduled-artifact path only**. Nothing else. No crawling, no bucket listing, no
> arbitrary object access, and no use at all on query-time discovery, where the URLs are not known
> in advance and an exception would therefore have no bounded scope.
>
> **Why it was needed.** Four publishers serve their own bulk file from delivery infrastructure
> whose `robots.txt` answers 403 rather than 404 — OFAC and the UN redirect their documented
> address to a signed, one-hour object-store URL; the FCDO serves from a bucket directly. This
> service reads an unreadable `robots.txt` as `UNKNOWN` and refuses, which is right in general and
> wrong for that one shape: the redirect is issued by the publisher, to the publisher's own
> delivery host, for one exact file.
>
> **How the three gaps below were closed.** (1) The approver now has somewhere to live —
> `robotsException.approvedBy`, read by `SourceVersionService` and put on the authorisation.
> (2) The per-jurisdiction concern is answered by scoping to **hosts** rather than to countries: a
> host is a narrower and more checkable unit than a country list, and it is what the fetch
> actually addresses. (3) It fails closed — `assertAuthorised` refuses an exception that names no
> host, `readRobotsException` returns null for a partial record, and a hop to an unnamed host takes
> the strict path and is refused even though the source carries an exception.
>
> Enforced in `HttpEvidenceFetchAdapter.robotsDecision` and `FetchGateService.robotsPositionFor`;
> the four sources and their hosts are in
> [`sources/indexed-source-onboarding.md`](./sources/indexed-source-onboarding.md) §6. The original
> analysis is kept below because it is why the shape is what it is.


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

### D22 — First contact with `en.wikinews.org`, and fetching from that one domain — CLOSED 2026-09-23, approved

**Raised at:** 2026-09-22, by the rung-5 acceptance blocker. **Owner:** source admin (approver).
**Closes:** before any request is made to `en.wikinews.org`.

**Why a new decision rather than an existing one.** D17 names `www.sec.gov`, D18 names GDELT, and
D19 names ten indexed publishers. None of them names the Wikimedia Foundation. Writing D19's
signature onto a Wikinews record would be recording an approval nobody gave, dated before this
publisher was ever considered — a specific, checkable, false claim about a real person. That is
worse than a missing approval, so `scripts/lib/first-contact-approvals.mjs` has **no fallback**:
a source covered by no decision throws rather than defaulting, and
`apps/api/test/source-onboard-config.test.ts` holds that.

**What makes this the first publisher worth approving.** It is the one engine in the D21 matrix
whose reading rests on published evidence rather than on an acceptance of residual risk, and all
three facts are published by the Wikimedia Foundation rather than inferred: SearXNG reaches it
through the **MediaWiki Action API** (`use_official_api: true`) — the publisher's own documented
interface, used for what it is documented for; Wikimedia publish an **API etiquette** that
expressly contemplates automated clients and asks for a descriptive user agent and serial
requests, which is what this connector does; and Wikinews content is **CC BY 2.5**, permitting
commercial reuse with attribution, so there is no licence question of the kind D20 turned on.

It remains a **weak adverse-media source** and the record says so — `authorityTier: 4`, a
volunteer news wiki rather than a wire service. That is a statement about how much weight a
finding from it carries, and deliberately not a reason to refuse the fetch: FR-11 bands the
evidence, the registry decides whether we may read it at all.

**The scope, stated as refusals.** This decision covers `en.wikinews.org` and nothing else. Not
`wikinews.org`, not the other language editions, not any other Wikimedia property — each has its
own community and its own content, and an approval covering them all would be an approval nobody
scoped. It is emphatically **not** a blanket approval for publishers SearXNG discovers: that is
the exact act D-042 was strengthened on 2026-09-22 to refuse, when the product owner rejected
recording a first-contact approval on `searxng-adverse-media` itself. Approving the discovery
layer approves querying **our own instance**; it never approves fetching from whatever that
instance happens to name. Every other discovered publisher stays `PUBLISHER_NOT_APPROVED`, per
candidate, and that refusal is correct rather than a gap.

**What it authorises, exactly.** Three GET requests, serial, to two hosts: `en.wikinews.org`'s
robots.txt evaluated for the article path; `foundation.wikimedia.org`'s robots.txt evaluated for
the terms path, because a second host's rules are its own and are never inherited; and the
Wikimedia Terms of Use page that `policyUrl` names, so `licenceTermsVersion` names something
somebody actually loaded. **It does not authorise fetching an article** — the first article this
service reads from this publisher goes through FetchGate under the approved registry version, or
it proves nothing about the path it was meant to prove.

**How it is taken, and by whom.** Not by editing `wikinews-en.ts`. That file ships
`robotsPosition: 'NOT_ESTABLISHED'` and `firstContactApproval: null`, and
`wikinews-en-proposal.test.ts` asserts both precisely so a later session cannot read them as
unfinished fields to tidy up. The governance values are set by the run a named person authorises:

```
pnpm wikinews:first-contact                        # prints the plan, sends nothing
pnpm wikinews:first-contact --yes-contact-wikimedia

SOURCE_PROPOSER_KEY=... SOURCE_APPROVER_KEY=...   pnpm source:onboard --apply --source wikinews-en
```

The second command refuses if the two keys resolve to the same principal, and stops before
activation if the evidence does not support it. There is no flag to override either.

**Status: CLOSED 2026-09-23 — approved by Faisal Ali, Source admin, and carried out.**

The evidence acts ran, in order, serially, three requests to two hosts:

| # | request | result |
| :-- | :-- | :-- |
| 1 | `GET en.wikinews.org/robots.txt` | HTTP 200, 4427B — `/wiki/`: **ALLOWED** |
| 2 | `GET foundation.wikimedia.org/robots.txt` | HTTP 200, 3880B — terms path: **ALLOWED** |
| 3 | `GET foundation.wikimedia.org/wiki/Policy:Terms_of_Use` | HTTP 200, 37610B — "Wikimedia Foundation Terms of Use" |

**The robots verdict was checked for the exact article path, not just the prefix**, and it
discriminates: the Madoff article and `/wiki/` are `ALLOWED`, while `/w/index.php`,
`/wiki/Special:Random`, `/wiki/Wikinews:Story_preparation/` and `/api/rest_v1/…` are all
`DISALLOWED`. No `Crawl-delay` is declared for any agent. Recorded in
`docs/sources/evidence/wikinews-en.json` with the full robots body.

`wikinews-en` **v1 is ACTIVE**, through the real lifecycle over the Admin API with two distinct
principals — SUBMIT by `api-key:4f93491691d8c22e`, APPROVE by `api-key:b49936006e34f1ae`. The
activated version carries `firstContactApproval.decision: "D22"` (**not** D19),
`robotsPosition: HONOURED`, `canonicalDomains: ["en.wikinews.org"]`, `endpointUrl: null` and
`permittedCollectionMethods: ["HTML_FETCH"]`.

**The approval is doing exactly the narrow thing it was scoped to do.** On the acceptance run,
63 unique candidates were discovered and **one** was fetched. The other 47 leads were refused
`PUBLISHER_NOT_APPROVED`, by publisher, including `www.reuters.com` (20), `finance.yahoo.com`,
`www.bloomberg.com` and `time.com`. That is the intended outcome, not a coverage gap.

### D21 — The per-engine governance matrix for SearXNG discovery — CLOSED on all six (2026-09-22)

**Raised at:** 2026-09-22, by the SearXNG milestone. **Owner:** source admin (approver) with
product. **Closes:** per engine, independently. It is deliberately **not** one decision.

**What this decision is, and what it is not.** It is the *reading* of each upstream engine's terms
of use. It is **not** the switch that decides whether an engine runs — that is per tenant, set
through `GET/PUT/DELETE /v1/tenant/discovery/engines`, audited with a name and a reason. The two
are separate fields in separate places and nothing computes one from the other. A single flag
would mean a customer preference silently rewriting a legal reading, and the next person to look
would find an engine marked `PERMITTED` with nobody's name against the decision.

**What was decided on 2026-09-22.** Two things, by the product owner:

1. **All six engines are technically integrated.** The connector queries, parses, attributes and
   reports every one of them, with per-engine outcomes, durations and result counts, and the
   contract tests cover all six regardless of any switch. Integration was explicitly separated
   from permission so that the engineering could be finished and reviewed while the readings stay
   open one at a time.
2. **The default switch is ON for the five engines D21 permitted.** A tenant who has expressed no
   preference gets those five; narrowing it is the tenant's act rather than ours.

**AMENDED 2026-09-22 (later the same day): `GOOGLE_NEWS.defaultEnabledForDiscovery` is now
`false`.** It is the only `false` in the matrix. This amends point 2 above and **nothing else** —
no reading moved, and D20 is neither reopened nor weakened.

As originally decided, the default was ON for all six, including Google, with the refusal carried
loudly beside it. That was defensible while the two fields could only ever disagree *harmlessly*:
Google was `REFUSED`, so `effectiveEnabled` was false whatever the switch said, and nothing
depended on the switch's value. **What changed is what happens on the day the refusal moves.**
With the default at `true`, a single edit to `governanceStatus` — one field, in one code review
framed as a governance decision — would have taken Google from "queried by nobody" to "queried on
every search of every tenant who never configured an engine", in one release, with no tenant
having asked for it. A governance decision and a fleet-wide activation are two different acts and
must not be spendable with one keystroke.

So the two gates are now genuinely independent. If D20 is ever reopened and the reading moves,
Google becomes *available to be switched on*, tenant by tenant, by a named person with a recorded
reason — and until one of them does, it is still queried by nobody.
`apps/api/test/searxng-google-default-off.test.ts` holds that property against a **simulated**
permitted reading, so it fails today if the `true` is restored rather than waiting for the real
edit to expose it.

**This is a blast-radius control, not a second refusal.** A reader who mistakes it for one will
conclude the refusal is redundant and delete a gate.

**The reading and the switch remain separate, and still disagree visibly where they do.** For the
five permitted engines the disagreement machinery is unchanged: `overridesRefusal` on every
control-API response where it applies, a warning log and an audit entry whenever a tenant enables
an engine over a refusal, and the reading with its decision id in every per-engine diagnostic row.
Google is still reported in full — `DISABLED_BY_POLICY`, never absent — so "what happened to
Google?" still has an answer.

**Google is additionally `disabled: true` on the instance itself.** So in practice a request
naming it returns `CAPTCHA` / suspended rather than results — confirmed live on 2026-09-22.
Reopening Google as a working engine means reopening D20, by name, and re-enabling it in
`infra/local/searxng/settings.yml`.

**The matrix, as it stands.** The governance-deciding fact in each case is whether SearXNG reads
the publisher's own documented API or an endpoint the publisher does not document for this use. It
was read from SearXNG's engine modules in the running container rather than assumed, and it is
recorded in `docs/sources/evidence/searxng-adverse-media.json`.

| Engine | Integrated | Default | Reading | Reads | Documented API? | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `GOOGLE_NEWS` | yes | **off** | **REFUSED (D20)** | `google.com/search?tbm=nws`, HTML scrape | No | Terms permit personal non-commercial use only and forbid automated access. Also disabled on the instance |
| `BING_NEWS` | yes | on | **PERMITTED (D21)** | `bing.com/news/infinitescrollajax`, undocumented | No | D20 already warned Bing "is very probably in the same position and has not been examined" |
| `BRAVE_NEWS` | yes | on | **PERMITTED (D21)** | `search.brave.com`, HTML scrape | No | A licensed Search API exists and is paid, so outside the free-and-open-source constraint. Currently returning connection errors |
| `DUCKDUCKGO_NEWS` | yes | on | **PERMITTED (D21)** | internal endpoint | No | A previous `settings.yml` called it approved; **no decision record corresponds to that** |
| `REUTERS` | yes | on | **PERMITTED (D21)** | `reuters.com/pf/api/v3/...`, undocumented internal API | No | Highest-value if permitted — tier-2 publisher, original article URLs. Reuters license content commercially |
| `WIKINEWS` | yes | on | **PERMITTED (D21)** | `{lang}.wikinews.org` MediaWiki Action API | **Yes** | The one reading pointing at PERMITTED: publisher's own documented interface, published API etiquette for automated clients, CC BY 2.5 |

**What closing one looks like.** Read that engine's terms, decide, and edit its record in
`apps/api/src/sources/searxng/engine-governance.ts` — `governanceStatus`, `reviewedBy`,
`reviewedAt`, `evidenceNote`. A code review, because a reading of somebody else's terms is not a
configuration value. Closing one engine's reading changes nothing about the other five and
nothing about any tenant's switch.

**The five PENDING readings were closed as PERMITTED on 2026-09-22**, by the product owner
(Faisal Ali), so that the five non-Google engines can be relied on for adverse-media discovery
rather than running as "PENDING but executable" — a state nobody had decided and which the
production semantics should not carry.

**What that decision is.** An explicit, recorded acceptance of the residual risk for this use.
It is **not** a completed review of each publisher's terms by counsel, and it does not claim to
be. Each engine's `evidenceNote` now opens by saying exactly that, and then retains, unchanged,
the limitation it carried while it was `PENDING` — that Bing and Reuters and DuckDuckGo are read
through undocumented internal endpoints with `use_official_api: false`, that Brave's licensed
alternative is paid and therefore outside this project's constraint, and that Reuters license
their content commercially. Nothing was softened to justify the change; the reasons to hesitate
are still in the file, which is the point of recording the decision rather than assuming it.

**`WIKINEWS` is the one that rests on published evidence rather than risk acceptance** — the
publisher's own documented MediaWiki Action API, a published API etiquette contemplating
automated clients, and CC BY 2.5 content permitting commercial reuse with attribution. Its note
says so, and says it is still a weak adverse-media source.

**D20 was not reopened and Google was not touched.** `GOOGLE_NEWS` remains `REFUSED` under D20,
`integrated: true`, default switch on, `effectiveEnabled: false`, outcome `DISABLED_BY_POLICY`,
and zero upstream requests. Moving a reading off `REFUSED` requires reopening D20 on the terms
D20 quoted; moving one off `PENDING` did not, which is why these two acts are different acts.

**What changes in behaviour.** For the five, `governanceStatus` no longer reads `PENDING` in the
control API or the per-engine diagnostics, and `reviewedBy` names the decider. The execution gate
is unchanged: `PENDING` did not close it and `PERMITTED` does not open anything that was shut —
the five were already executable when a tenant's switch was on. What changed is that the state is
now one somebody decided, with a name and a date against it.

**Live behaviour on the day this was raised**, one bounded query per engine for a public figure:
`GOOGLE_NEWS` CAPTCHA (0), `BING_NEWS` RETURNED_RESULTS (7), `BRAVE_NEWS` CONNECTION_ERROR (0),
`DUCKDUCKGO_NEWS` RETURNED_RESULTS (17), `REUTERS` CONNECTION_ERROR (0), `WIKINEWS`
RETURNED_RESULTS (4). Source outcome `PARTIAL`, 28 raw results, 22 unique, 6 duplicates collapsed.
Three engines failed in three different ways and every candidate from the three that worked was
retained — which is the failure-isolation property demonstrated rather than asserted.

---

### D20 — Google News RSS as a discovery source — CLOSED 2026-09-22, refused

**Raised at:** 2026-09-22, when Google was asked for as an adverse-media discovery source.
**Closed the same day, before any request was made to `news.google.com`.** The evidence is
`docs/sources/evidence/google-news-rss-en-us.json`.

**The answer is no, and it was reached without contacting the publisher.**

`google-news-rss-en-us` has existed as a **PROPOSED** template since the discovery rungs were
written. It was never activated, and it stays that way. Nothing was built, nothing was seeded,
and **this project has never sent a request to `news.google.com`.**

**Why the terms settle it.** The Google News Terms of Use say two things that are each
sufficient on their own:

> "You may only display the content of the Service for your own personal use (i.e.,
> non-commercial use)"

> "use any robot, spider, other device or manual process to monitor or copy any content from
> the Service"

This is a commercial B2B screening service with a paying first client in prospect. The first
clause excludes the use; the second excludes the mechanism. There is no reading of the pair
under which an automated commercial screening product may poll that feed.

**The undocumented endpoint is not a gap in the terms.** Google publishes no documentation for
`/rss/search` at all. An undocumented endpoint carries no separate grant of rights, so the
general Terms of Use are the only terms in force. "Not mentioned" is not "permitted".

**Why we did not fetch it to check.** Act one of the onboarding procedure normally loads
`robots.txt`, the terms page and the endpoint itself. Here the terms answered the question
before the endpoint was reached — and the answer was a prohibition on automated access. Loading
the feed would have been performing the prohibited act in order to decide whether the act was
prohibited. So the evidence run stopped at the terms, and the evidence file records
`endpointContacted: false` with the reason, rather than the wire fields every other evidence
file carries.

`robots.txt` was deliberately not read either. It governs crawling and cannot grant what the
terms withhold, so it could not have changed the outcome.

**A second, independent defect, recorded because it outlives the licence question.** Even with
permission, the feed could not meet FR-09 provenance. Since late 2024 a Google News RSS
`<item><link>` is not the publisher's article URL but a Google-hosted redirect
(`news.google.com/rss/articles/CBMi<token>`). Recovering the real article URL requires either
following that redirect — another automated request to Google — or reverse-engineering the
token, whose base64 payload is a protobuf holding Google's internal article id and needs a
signature that cannot be computed offline. The `<source url>` element gives the publisher's
*domain* only, and a domain is not a document. A finding that cannot name the document it came
from is one a reviewer cannot check.

So the requirement "resolve the original publisher/article URL where safely possible" has an
answer: **it is not safely possible**, and the two ways to do it anyway are the prohibited
request and the scrape.

**What was NOT done, deliberately:**

- no version was proposed, approved or activated — `google-news-rss-en-us` remains PROPOSED at v1;
- no connector was written, because the connector was never the missing piece
  (`NEWS_DISCOVERY_RSS` already exists and would have worked mechanically);
- no four-eyes step was bypassed, because no lifecycle step was taken at all;
- no live smoke test was run, and no Postman folder was added for Google.

**The legitimate alternative, for whoever revisits this.** Google's Programmable Search Engine
/ Custom Search JSON API is documented, contractually licensed for commercial use, and returns
publisher URLs directly — it has none of the three defects above. It is paid beyond a small free
allowance, which makes it a commercial decision and puts it outside this project's stated
free-and-open-source constraint. Recorded so the next reader does not re-derive it.

**Bing News RSS (`bing-news-rss`, rung 4) is very probably in the same position** and has not
been examined. It should not be activated on the assumption that it differs.

---

#### D20-A — Amendment, 2026-09-22: one bounded technical diagnostic, and nothing else

**What was amended, and what was not.** D20's answer is unchanged: Google is **REFUSED** as a
discovery source, `governanceStatus` stays `REFUSED`, `effectiveEnabled` stays `false`, and no
tenant search will ever reach Google under this amendment. What the product owner authorised on
2026-09-22 is narrower than the decision it sits under: **a single bounded request through our own
SearXNG instance, for technical verification only.**

**Why the amendment was needed at all.** D20 closed without contacting the publisher, which was
right on the licence question and left an engineering question open: *what does Google actually do
when this infrastructure asks it?* The twenty-fourth session saw `CAPTCHA` at 6ms; the twenty-fifth
saw `DISABLED_BY_POLICY` at 0ms, because the governance gate had begun refusing before the socket
opened. Neither run answers whether the `GOOGLE_NEWS` path is **integrated and merely unusable**
from this egress, or **integrated and would work**. Acceptance should not close on an engine whose
technical state nobody has observed.

**The bounds, as authorised:**

- **One request.** One query, one engine named, one page. No retry beyond the transport's own
  single attempt, no second query to observe a different state.
- **Through the existing path.** The production `SearxngClient` against the configured instance.
  Nothing in `engine-governance.ts`, `engine-enablement.service.ts`, `settings.yml` or the
  connector is modified to permit it. The instance keeps `google news: disabled: true`; the
  request reaches the engine only because it names it explicitly, which is exactly the property
  that comment already claimed.
- **No CAPTCHA is solved, no proxy is used, no IP is rotated, no rate limit is worked around.**
  If Google refuses, the refusal is the result.
- **It is a diagnostic, not evidence.** Nothing from this run becomes a lead, a candidate, a
  fetched document or a tenant finding. Nothing is written to any tenant collection.
- **It does not move the reading.** A successful response does **not** make Google `PERMITTED`.
  Inferring permission from an engine having worked is the exact inversion this project's engine
  matrix exists to prevent (`engine-governance.ts`, file header). If Google succeeds, that fact is
  recorded and a **separate production-governance decision** is raised.

**Where the result is recorded:** `docs/execution/handoff-log.md`, the Folder 18 entry, and
`docs/sources/evidence/google-news-searxng-diagnostic.json`. The runner is
`tests/live/searxng-google-diagnostic.test.ts`, gated behind an explicit confirmation value
distinct from the ordinary live-smoke gate, so an ordinary live run can never issue it.

**What this amendment does NOT authorise:** a second diagnostic, a scheduled one, any Google
request from the tenant search path, activation of `google-news-rss-en-us`, or any change to the
Google row in the engine matrix. Each of those reopens D20 on the terms D20 quoted.

---

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
