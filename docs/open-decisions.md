# Open decisions

Seeded with D1-D10 from section 12 of the implementation plan, plus decisions this
implementation has surfaced. Each carries an owner and the gate by which it must close.

**Nothing here may harden into an accidental default.** Where a working assumption is in
force, it is stated as such and the code reflects that it is provisional.

| ID      | Decision                                                                                                       | Owner                | Close by | Status                                                            |
| :------ | :------------------------------------------------------------------------------------------------------------- | :------------------- | :------- | :---------------------------------------------------------------- |
| D1      | Which jurisdictions and languages are enabled first                                                            | Source/policy admin  | G5       | **CLOSED 2026-09-11** — Costa Rica; es + en requested (see D-010) |
| D2      | The declared archive horizon, per source, published on every result                                            | Source/policy admin  | G10      | Open                                                              |
| D3      | Which categories are on by default                                                                             | Taxonomy admin       | G5       | **CLOSED 2026-09-11** — all seventeen (see D-009)                 |
| D4      | The exact boundary between adverse media and list matching for designations                                    | Product + compliance | G7       | Open                                                              |
| D5      | The reviewer capacity assumption that thresholds are set against                                               | Product + compliance | G7       | Open                                                              |
| D6      | How robots exceptions for official sources are approved and recorded                                           | Source admin         | G6       | Open                                                              |
| D7      | Which open-weight extraction model, benchmarked on the labelled set                                            | Engineering          | G7       | Open                                                              |
| D8      | Retention per source and jurisdiction for evidence text                                                        | Compliance           | G5       | **CLOSED 2026-09-11** — configurable, 30-day default (see D-012)  |
| D9      | Whether numeric confidence figures are ever shown (default: no)                                                | Product              | G7       | Open — default no, enforced                                       |
| D10     | The minimum identity data the integrating application must supply                                              | Product + Zquence    | G3       | **CLOSED 2026-09-11** — a name (see D-011)                        |
| **D11** | Whether the results list must render procedural stage and outcome status at the same visual weight as the band | Product + design     | G8       | Open                                                              |
| **D12** | Search index: OpenSearch or Meilisearch                                                                        | Engineering          | G4       | Open — decided by the G4 workload test, see D-002                 |

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

### D12 — Search index choice

**Raised at:** G1, deferred deliberately. See `docs/decisions.md` D-002.

Both OpenSearch and Meilisearch are free and self-hostable. The deciding evidence is the
G4 matcher-latency workload test, which cannot run before the FR-08 matcher exists. Local
compose carries a working assumption (Meilisearch, smaller footprint) that the G4 test may
overturn.

**Must close by G4**, with the measured result recorded in `docs/decisions.md`.
