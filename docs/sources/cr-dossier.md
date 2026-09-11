# Costa Rica source dossier

**Phase D step D0** · First written 2026-09-11 · **Status: v1, desk research only**

This is the input to every later decision about what an adverse search can actually find in
Costa Rica. D-010 made CR the only enabled jurisdiction, and every free source this plan was
written around — Companies House, SEC EDGAR, CourtListener — is UK or US. Nothing here is a
substitute for the G10 live verification; it exists so that Phase D does not design the
association graph and the source registry around a registry contract nobody has confirmed
exists.

## How this was researched, and what that limits

**No candidate source was contacted.** No API was called, no page of any candidate's site was
fetched, no `robots.txt` was read, no rate limit was probed. The project rule that no source has
ever been contacted live still holds, and G10 still owns live verification.

What was done instead: search-engine queries, and reading what the results reported about each
institution's own published material. That is enough to answer "does this kind of data exist and
in what shape", and it is **not** enough to answer "what exactly does this endpoint return".
Every claim below carries one of three labels:

| Label        | Means                                                                                    |
| :----------- | :--------------------------------------------------------------------------------------- |
| `DOCUMENTED` | The institution's own published material states it, as reported in a cited search result |
| `INFERRED`   | Deduced from secondary evidence; plausible, unconfirmed                                  |
| `UNKNOWN`    | Not established. Named here so it cannot be quietly assumed                              |

**Nothing in this file is marked verified, and nothing here may be cited as verification.**

---

## The three findings that change Phase D

### 1. Officer-level company data exists, and is not automatable on free terms

The Registro Nacional publishes free legal-person consultation — including who represents the
entity — through its `rnpdigital.com` platform, but behind **free registration and a CAPTCHA**
(`DOCUMENTED`). A CAPTCHA is a hard stop for this project, not an obstacle to engineer around:
the FR-06 table says cool down and abandon, and never solving or bypassing a CAPTCHA, paywall or
login wall is a product rule with no technical exception.

The free machine-readable alternative, `api.hacienda.go.cr`, returns a taxpayer's name, type,
tax status and economic activity for a cédula física or jurídica (`DOCUMENTED`) — enough to
confirm **that a company exists and is active**, and **nothing about who its directors are**
(`DOCUMENTED`, by absence from every description of the API's response).

**Consequence:** there is no known free, automatable, officer-level source in Costa Rica. The
FR-02 association graph therefore has **no data source in the only enabled jurisdiction**. This
is what D4 means by `UNKNOWN` association coverage — never asked, because nothing approved could
be asked — and it must never render as `INCOMPLETE`, which would claim an attempt that did not
happen. Raised as **D14**.

### 2. Published Costa Rican judgments are depersonalised

The Poder Judicial operates a data-protection regulation for personal data in its publicly
accessible databases, a protocol for de-identification requests, a de-personalising tool, and a
**Repositorio Único de Sentencias Judiciales Despersonalizadas** (`DOCUMENTED`).

**Consequence:** the obvious tier-1 primary source for a person-anchored adverse search — court
judgments naming the person — is likely to be **systematically stripped of the name that makes
it a finding**. A depersonalised judgment is not a weak match; it is not a match at all, because
there is no name in it to match. Whether any category of CR judgment is published with parties
named is `UNKNOWN` and is the single most valuable thing for the next session to establish.
Raised as **D15**.

This does not make CR adverse search impossible. It relocates the evidence base to named-person
channels: the Boletín Judicial, La Gaceta, prosecutor and police newsrooms, and the press. It
does mean the authority-tier profile of a CR search is **lower on average than the UK/US design
assumed**, and the FR-08 Axis D reasoning should expect it.

### 3. There is a genuine free source for the Costa Rican name-frequency prior

The TSE publishes the **Padrón Nacional Electoral** for download as ZIP archives containing
`PADRON.TXT`, with `DISTELEC.TXT` and a `LEAME.TXT` describing the layout (`DOCUMENTED`). That
is a national roll carrying every registered voter's given names and both surnames — precisely
the population distribution D-011 says is missing, and without which Rodríguez, Jiménez, Vargas,
Mora and Solís each score as though they were rare names and the FR-08 frequency penalty never
fires.

**It is also bulk personal data on several million living people, and must be treated as such.**
The deliverable is the **aggregate frequency profile only**: count surnames, store counts,
**discard the roll**. Do not import the padrón into any collection, do not retain it on disk
after the counts are computed, and do not let it reach the search index or an evidence object.
`nameFrequencyProfiles` is already shared rather than tenant-owned, which is the right home for
a population statistic. PRODHAB is the supervising authority for personal-data processing in
Costa Rica (`DOCUMENTED`), and SEC-05 requires documented privacy approval before country
enablement regardless — this use needs to be named in that approval, not assumed covered by it.

---

## Candidate sources

Ordered by what they would serve. **Approval state for every one of them is: not reviewed, not
approved, not activated.**

### Registro Nacional — company and officer register

| Field                | Finding                                                                                     |
| :------------------- | :------------------------------------------------------------------------------------------ |
| Publishes            | Legal persons, cédula jurídica, legal status, representatives (`DOCUMENTED`)                |
| Free access          | Yes, via `rnpdigital.com`, **after free registration**, **behind a CAPTCHA** (`DOCUMENTED`) |
| Machine access       | None known (`UNKNOWN` — no documented API found)                                            |
| Officer-level data   | Exists in the register (`DOCUMENTED`); not reachable on free automatable terms              |
| Stability class      | n/a — not adoptable in this form                                                            |
| Rate limits / robots | `UNKNOWN`                                                                                   |
| Verdict              | **Not adoptable.** CAPTCHA and login are a hard stop, not an engineering problem            |

Identifier scheme reference: the register's identifiers are catalogued as `CR-RPJ` in
org-id.guide, which is a useful neutral description of the cédula jurídica format.

### Ministerio de Hacienda — `api.hacienda.go.cr` taxpayer consultation

| Field           | Finding                                                                                                                                                 |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Publishes       | Name, identification type, tax regime, status (active/registered/suspended/cancelled), CIIU activity codes, arrears indicator (`DOCUMENTED`)            |
| Free access     | Yes, public, no key described (`DOCUMENTED`)                                                                                                            |
| Officer data    | **None** (`DOCUMENTED` by absence)                                                                                                                      |
| Stability class | `INFERRED` documented-and-stable — it is an official government API with third-party clients, but no published contract or versioning policy was found  |
| Rate limits     | `UNKNOWN` — third-party mirrors exist specifically because the service has downtime, which is itself a signal                                           |
| Useful for      | Company **identity corroboration** (FR-08 Axis A) and confirming a user-supplied company is real; **not** for building graph edges                      |
| Verdict         | **Adopt as a corroboration source, not as a registry.** Good first real `CompanyRegistryPort`-adjacent adapter candidate, but it does not resolve FR-02 |

Note the identifier detail for any adapter: for a cédula jurídica, only the first ten digits are
used, without the final two check digits (`DOCUMENTED`).

### Poder Judicial — Nexus PJ (jurisprudence)

| Field           | Finding                                                                                                                                                                      |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publishes       | Full-text judgments, searchable, with an advanced-search UI, downloadable in several formats (`DOCUMENTED`)                                                                  |
| Free access     | Yes, public, no login described (`DOCUMENTED`)                                                                                                                               |
| Machine access  | No documented API (`UNKNOWN`); HTML search UI only                                                                                                                           |
| Stability class | **Undocumented and volatile** (`INFERRED`) — therefore requires the FR-05 scheduled contract test from day one if adopted                                                    |
| Names           | **Likely depersonalised** — see finding 2 (`DOCUMENTED` that the depersonalisation apparatus exists; `UNKNOWN` which document classes it applies to)                         |
| Verdict         | **Cannot be scoped until D15 is answered.** Adopting it before knowing whether names survive would build a primary-source adapter that structurally cannot produce a finding |

### Boletín Judicial

| Field       | Finding                                                                                                                                       |
| :---------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| Publishes   | The Judicial Branch's official notices, **every business day** (`DOCUMENTED`)                                                                 |
| Free access | Yes, public, and also distributed through the Imprenta Nacional's channels (`DOCUMENTED`)                                                     |
| Names       | `UNKNOWN` — but official judicial notices (edicts, summonses, insolvency and disqualification notices) are named by their nature (`INFERRED`) |
| Format      | PDF (`INFERRED`, from its co-distribution with La Gaceta)                                                                                     |
| Verdict     | **The most promising named-person official channel in this list.** Establish next, alongside D15                                              |

### Imprenta Nacional — La Gaceta (official gazette)

| Field           | Finding                                                                                                                              |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------- |
| Publishes       | Decrees, laws, regulations, government agreements, notifications and other public acts (`DOCUMENTED`)                                |
| Free access     | Yes, public, with a publication search tool over the archive, plus a mobile app (`DOCUMENTED`)                                       |
| Format          | PDF, at dated paths of the shape `/pub/YYYY/MM/DD/...` (`INFERRED` from observed URLs)                                               |
| Stability class | **Documented and stable** as a publication, `UNKNOWN` as an interface                                                                |
| Notable         | Regulator sanction notices appear to reach the public through Gaceta _alcances_ rather than through a standing register (`INFERRED`) |
| Verdict         | **Strong candidate.** Predictable dated artefacts are the easiest honest ingestion shape here, and it is the official record         |

Consequence for extraction, worth planning for now: this source is **PDF-first**, so Phase F's
extraction path for CR is PDF text, not HTML article text. That is a different pipeline from the
one the UK/US design assumed.

### SUGEF · SUGEVAL · SUGESE · SUPEN · CONASSIF — financial regulators

| Field                                          | Finding                                                                                                                                                       |
| :--------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sanctioning powers                             | Yes — each superintendency has them, with administrative sanction and fine procedures (`DOCUMENTED`)                                                          |
| Standing public register of sanctioned parties | **`UNKNOWN`.** None was found; publication appears to route through La Gaceta (`INFERRED`)                                                                    |
| Published lists                                | SUGEF publishes lists of supervised entities as dated PDFs (`DOCUMENTED`)                                                                                     |
| Verdict                                        | **Treat as a La Gaceta consumer until proven otherwise.** Do not register a "regulator enforcement register" source that turns out to be a PDF in the gazette |

### Ministerio Público and OIJ — prosecutor and police newsrooms

| Field           | Finding                                                                                                                                                               |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publishes       | `Boletín OIJ: Actualidad Policial`, `Avisos y Noticias Policiales`, and the Ministerio Público site (`DOCUMENTED`)                                                    |
| Free access     | Yes, public web (`DOCUMENTED`)                                                                                                                                        |
| RSS / feed      | `UNKNOWN` — no feed was confirmed                                                                                                                                     |
| Names           | `UNKNOWN` — Latin American police bulletins commonly publish initials plus a surname rather than a full name (`INFERRED`, and it matters enormously for FR-08 Axis A) |
| Stability class | Undocumented and volatile (`INFERRED`)                                                                                                                                |
| Verdict         | **Register as discovery, tier 2, leads only** — with the naming convention established before any recall claim is made                                                |

### Spanish-language press

Not yet enumerated. FR-05 tiering requires per-masthead authority assessment, and D-010 requires
the lexicon that would query them to be authored by a Spanish reader. Deferred within D0 rather
than half-done: a partial masthead list invites someone to treat it as the list.

---

## What this means for the rest of Phase D

1. **D2's real `CompanyRegistryPort` adapter cannot be Costa Rican.** Build the port and the
   graph, prove them against a UK Companies House adapter labelled out-of-jurisdiction and not
   enabled for CR searches, exactly as the brief anticipated. Consider `api.hacienda.go.cr` as a
   second, genuinely Costa Rican adapter for **company identity corroboration** — valuable, and
   not the same thing as a registry.
2. **D3's resolution work stands unchanged**, and D4's `UNKNOWN` coverage outcome is now known to
   be the live CR case rather than a defensive branch. Test it as the primary path.
3. **Phase F's CR extraction path is PDF-first.** Note it in the Phase F brief when it is
   expanded; it is cheaper to know now than to discover after an HTML-shaped extractor exists.
4. **The name-frequency deliverable is real and available** — with the discard-the-roll
   constraint above, and a line in the SEC-05 approval naming the use.
5. **The CR coverage statement must say all of this out loud.** A Costa Rican search that finds
   nothing is, today, a search with no officer register, probably no named judgments, and an
   unreviewed Spanish lexicon. `NO_MATCHES_FOUND` with `INCOMPLETE` coverage is the honest
   output, and the statement has to name these gaps specifically enough that a reviewer does not
   read it as "clean".

## Open questions this dossier raises

| ID      | Question                                                                                          | Owner                  |
| :------ | :------------------------------------------------------------------------------------------------ | :--------------------- |
| **D14** | What feeds the FR-02 association graph in Costa Rica, given no free automatable officer register? | Product + compliance   |
| **D15** | What is the CR primary-source evidence base, given depersonalised judgments?                      | Product + source admin |

Both are recorded in [`../open-decisions.md`](../open-decisions.md). Neither is an engineering
decision, and neither may acquire a silent default.

## What the next revision must establish

In rough order of value:

1. Whether **any** class of CR judgment is published with parties named (D15).
2. What the **Boletín Judicial** actually carries, and in what format.
3. Whether OIJ and Ministerio Público bulletins name people in full or by initials.
4. Whether La Gaceta's archive has a stable, documented retrieval path, and what its terms say.
5. `api.hacienda.go.cr`'s published rate limits and terms of use.
6. The press masthead list, with FR-05 authority tiers.

Items 1–4 are desk research and can be done the same way this revision was. Item 5 and anything
that requires touching an endpoint belong to **G10**, not here.

## Sources consulted

Search-engine results referencing the following. Listed so the next session can go to the
primary material rather than re-deriving the search:

- [Registro Nacional](https://www.registronacional.go.cr/) · [personas jurídicas — consultas](https://www.registronacional.go.cr/tramites_servicios/consultas_tramites/personas%20juridicas/personas_juridicas_Consultas.htm) · [org-id.guide CR-RPJ](https://org-id.guide/list/CR-RPJ)
- [public-apis-cr (community list of Costa Rican open APIs)](https://github.com/ruiznorlan/public-apis-cr)
- [Poder Judicial](https://pj.poder-judicial.go.cr/) · [Nexus PJ advanced search](https://nexuspj.poder-judicial.go.cr/advancedSearch) · [Nexus PJ description](https://pj.poder-judicial.go.cr/index.php/nexus-info)
- [Reglamento para el tratamiento de los datos personales — Poder Judicial (PDF)](https://cij.poder-judicial.go.cr/images/ProteccionDatos/REGLAMENTO_PROTECCIN_DE_DATOS-PODER_JUDICIAL.pdf)
- [Boletín Judicial](https://boletinjudicial.poder-judicial.go.cr/)
- [Imprenta Nacional](https://www.imprentanacional.go.cr/) · [Diario Oficial La Gaceta](https://www.imprentanacional.go.cr/gaceta/) · [diarios oficiales](https://www.imprentanacional.go.cr/diarios_oficiales/)
- [SUGEF — lista de entidades supervisadas (PDF)](https://www.sugef.fi.cr/entidades_supervisadas/lista_entidades_supervisadas/entidades_fiscalizadas/anterior/2025_02.pdf) · [Reglamento SUGEF 8-08 (PDF)](https://www.sugeval.fi.cr/normativa/Normas/Sugef%208-08.pdf)
- [OIJ — Boletín: Actualidad Policial](https://sitiooij.poder-judicial.go.cr/index.php/comunicacion/noticias/boletin-oij-actualidad-policial) · [OIJ noticias](https://sitiooij.poder-judicial.go.cr/index.php/comunicacion/noticias) · [Ministerio Público](https://ministeriopublico.poder-judicial.go.cr/)
- [TSE — descarga del padrón nacional electoral](https://www.tse.go.cr/descarga_padron.html) · [Padrón Nacional Electoral Definitivo](https://www.tse.go.cr/2026/padron.html)
- [Realidad sobre la privacidad de los datos personales en Costa Rica (SciELO)](https://www.scielo.sa.cr/scielo.php?script=sci_arttext&pid=S1659-41422019000200068)
