# Open decisions

Seeded with D1-D10 from section 12 of the implementation plan, plus decisions this
implementation has surfaced. Each carries an owner and the gate by which it must close.

**Nothing here may harden into an accidental default.** Where a working assumption is in
force, it is stated as such and the code reflects that it is provisional.

| ID      | Decision                                                                                                       | Owner                  | Close by | Status                                                            |
| :------ | :------------------------------------------------------------------------------------------------------------- | :--------------------- | :------- | :---------------------------------------------------------------- |
| D1      | Which jurisdictions and languages are enabled first                                                            | Source/policy admin    | G5       | **CLOSED 2026-09-11** — Costa Rica; es + en requested (see D-010) |
| D2      | The declared archive horizon, per source, published on every result                                            | Source/policy admin    | G10      | Open                                                              |
| D3      | Which categories are on by default                                                                             | Taxonomy admin         | G5       | **CLOSED 2026-09-11** — all seventeen (see D-009)                 |
| D4      | The exact boundary between adverse media and list matching for designations                                    | Product + compliance   | G7       | Open                                                              |
| D5      | The reviewer capacity assumption that thresholds are set against                                               | Product + compliance   | G7       | Open                                                              |
| D6      | How robots exceptions for official sources are approved and recorded                                           | Source admin           | G6       | Open                                                              |
| D7      | Which open-weight extraction model, benchmarked on the labelled set                                            | Engineering            | G7       | Open                                                              |
| D8      | Retention per source and jurisdiction for evidence text                                                        | Compliance             | G5       | **CLOSED 2026-09-11** — configurable, 30-day default (see D-012)  |
| D9      | Whether numeric confidence figures are ever shown (default: no)                                                | Product                | G7       | Open — default no, enforced                                       |
| D10     | The minimum identity data the integrating application must supply                                              | Product + Zquence      | G3       | **CLOSED 2026-09-11** — a name (see D-011)                        |
| **D11** | Whether the results list must render procedural stage and outcome status at the same visual weight as the band | Product + design       | G8       | Open                                                              |
| **D12** | Search index: OpenSearch or Meilisearch                                                                        | Engineering            | G4       | **CLOSED 2026-09-11** — Meilisearch, on C4's figures (see D-002)  |
| **D13** | Whether search acceptance waits for the index write (~94ms of its latency)                                     | Engineering + product  | G8       | Open — measured in C4, see D-014                                  |
| **D14** | What feeds the FR-02 association graph in Costa Rica, given no free automatable officer register               | Product + compliance   | G5       | Open — raised by D0, 2026-09-11                                   |
| **D15** | What the Costa Rican primary-source evidence base is, given depersonalised judgments                           | Product + source admin | G6       | Open — raised by D0, 2026-09-11                                   |

---

## Detail on the decisions this implementation has surfaced

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
