# Requirements traceability

Every requirement and test from the implementation plan, mapped to implementation files,
tests and execution evidence.

**Status values:** `DONE` (implemented and verified) · `PARTIAL` (pure rules done, I/O
pending) · `TODO` (not started) · `DEFERRED` (explicitly deferred with a decision reference).

**A skipped or unimplemented suite is never recorded as a pass.**

## Functional requirements

| ID    | Requirement                                                     | Status      | Implementation                                                                                                       | Tests                                                                    |
| :---- | :-------------------------------------------------------------- | :---------- | :------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------- |
| FR-01 | Subject and search input, name-frequency prior                  | PARTIAL     | `domain/identity/axis-a.ts` (`NameFrequencyPrior`), `domain/identity/name-forms.ts`                                  | `domain/test/identity/*`                                                 |
| FR-02 | Association graph, tenure before company searches               | PARTIAL     | `domain/tenure/tenure.ts`                                                                                            | `domain/test/tenure/tenure.test.ts`                                      |
| FR-03 | Adverse taxonomy, exclusions, lexicon audit, version pinning    | PARTIAL     | `domain/taxonomy/*`                                                                                                  | `domain/test/taxonomy/lexicon-audit.test.ts`                             |
| FR-04 | Query planning, eight families, bounding, drop order            | PARTIAL     | `domain/planning/query-families.ts`                                                                                  | `domain/test/planning/planning.test.ts`                                  |
| FR-05 | Source registry, free connectors, discovery cascade             | TODO        | —                                                                                                                    | —                                                                        |
| FR-06 | Fetch, egress, free-source resilience                           | TODO        | —                                                                                                                    | —                                                                        |
| FR-07 | Evidence normalisation, extraction contract, 8 validation rules | TODO        | —                                                                                                                    | —                                                                        |
| FR-08 | Four independent axes                                           | PARTIAL     | `domain/identity/axis-a.ts`, `domain/attribution/axis-b.ts`, `domain/events/axis-c.ts`, `domain/authority/axis-d.ts` | `domain/test/identity/*`, `domain/test/banding/banding.test.ts`          |
| FR-09 | Party roles, procedural stages, tenure                          | DONE (pure) | `domain/roles/party-roles.ts`, `domain/stages/*`, `domain/tenure/tenure.ts`                                          | `domain/test/stages/stages.test.ts`, `domain/test/tenure/tenure.test.ts` |
| FR-10 | Event clustering and independence                               | DONE (pure) | `domain/clustering/rules.ts`, `domain/authority/axis-d.ts`                                                           | `domain/test/clustering/clustering.test.ts`                              |
| FR-11 | Banding and invariants I1-I10                                   | DONE (pure) | `domain/banding/*`, `evaluation/invariants/harness.ts`                                                               | `evaluation/test/invariants/invariants.test.ts`                          |
| FR-12 | Duplicate controls at every layer                               | PARTIAL     | `domain/clustering/rules.ts` (article/event, outcome layers)                                                         | `domain/test/clustering/clustering.test.ts`                              |
| FR-13 | Review, reporting, outcome lifecycle, refresh                   | PARTIAL     | `domain/coverage/result-state.ts`, `domain/stages/transitions.ts`                                                    | `domain/test/coverage/result-state.test.ts`                              |
| FR-14 | Control panel                                                   | TODO        | frontend repository                                                                                                  | —                                                                        |
| FR-15 | Tenancy and entitlement seams                                   | TODO        | —                                                                                                                    | Deferred subset: see D-007                                               |
| FR-16 | Evaluation harness                                              | DONE (pure) | `evaluation/dataset/*`, `evaluation/metrics/metrics.ts`, `evaluation/invariants/harness.ts`                          | `evaluation/test/**`                                                     |

## Security and reliability

| ID     | Requirement                        | Status  | Notes                                                                                                                                         |
| :----- | :--------------------------------- | :------ | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-01 | Tenant isolation and authorisation | TODO    | Requires G3                                                                                                                                   |
| SEC-02 | SSRF, fetch and webhook safety     | TODO    | Requires G6                                                                                                                                   |
| SEC-03 | S3 and sensitive evidence          | TODO    | Requires G4; real AWS IAM/KMS is a separate gate (G11)                                                                                        |
| SEC-04 | Application and model security     | PARTIAL | Lint bans `eval`/`new Function`; strict TypeScript; model-output handling requires G7                                                         |
| SEC-05 | Content rights and personal data   | PARTIAL | FR-03 exclusions enforced at classification time (`domain/events/axis-c.ts`); lexicon audit prevents protected characteristics as query terms |
| SEC-06 | Audit integrity                    | TODO    | Requires G4                                                                                                                                   |
| REL-01 | Jobs, retries and cancellation     | PARTIAL | Cancellation semantics in `domain/coverage/result-state.ts`; durable state requires G4                                                        |
| REL-02 | Quotas, budgets and fair use       | PARTIAL | `TRUNCATED_BY_PLAN` / `TRUNCATED_BY_QUOTA` modelled and surfaced; enforcement requires G6                                                     |
| REL-03 | Webhooks                           | TODO    | Requires G9                                                                                                                                   |
| REL-04 | Observability and recovery         | TODO    | Requires G4                                                                                                                                   |

## Invariants I1-I10

All ten execute in `pnpm test:invariants` against the seed dataset with no I/O. They must be
re-run at G7 against real pipeline output (G7 exit condition).

| ID  | Invariant                                                                | G2 pure harness | G7 full pipeline |
| :-- | :----------------------------------------------------------------------- | :-------------- | :--------------- |
| I1  | Severity, authority and article count never raise Axis A                 | PASS            | pending          |
| I2  | Strong identifier contradiction overridden only by reasoned human review | PASS            | pending          |
| I3  | COMPANY_ONLY never produces a personal adverse finding                   | PASS            | pending          |
| I4  | Stage never displayed above the stage its span establishes               | PASS            | pending          |
| I5  | Settlement never an admission; civil never criminal                      | PASS            | pending          |
| I6  | Syndicated copies never increase the independence count                  | PASS            | pending          |
| I7  | Acquittals and corrections always attach at equal prominence             | PASS            | pending          |
| I8  | No uncalibrated numeric probability is displayed                         | PASS            | pending          |
| I9  | No composite person-level risk score                                     | PASS            | pending          |
| I10 | NO_MATCHES_FOUND always carries coverage state and failed sources        | PASS            | pending          |

## Test catalogue

### 9.1 Setup, authentication and isolation

| ID      | Status | Evidence                      |
| :------ | :----- | :---------------------------- |
| T01-T09 | TODO   | Requires G1 completion and G3 |

### 9.2 Identity, associations and adverse logic

| ID  | Scenario                                      | Status  | Test                                                        |
| :-- | :-------------------------------------------- | :------ | :---------------------------------------------------------- |
| T10 | Conviction report without a sanctions hit     | PARTIAL | Seed case `C001`                                            |
| T11 | Common name, contradictory DOB                | DONE    | `axis-a.test.ts`, seed case `C003`                          |
| T12 | Name-only sparse identity                     | DONE    | `axis-a.test.ts`                                            |
| T13 | Diacritics, non-Latin names, aliases          | DONE    | `name-forms.test.ts`, `transliteration.test.ts`             |
| T14 | Two officers share a name                     | PARTIAL | `axis-b.ts` role-holder logic; graph resolution requires G5 |
| T15 | Current/former/unknown directorship dates     | DONE    | `tenure.test.ts`                                            |
| T16 | Company event without individual involvement  | DONE    | `banding.test.ts`, seed case `C007`                         |
| T17 | Plaintiff, witness or victim                  | DONE    | `banding.test.ts`, seed cases `C004`-`C006`                 |
| T18 | Allegation later dismissed or corrected       | DONE    | `clustering.test.ts`, seed cases `C011`, `C012`             |
| T19 | Event vs publication dates remain distinct    | DONE    | `axis-c.ts` four date fields; `banding.test.ts`             |
| T20 | Registry outage or graph limit                | TODO    | Requires G5                                                 |
| T21 | Finite plan completes with no findings        | DONE    | `result-state.test.ts`                                      |
| T71 | High-frequency name, no secondary identifiers | DONE    | `axis-a.test.ts`, seed case `C002`                          |
| T72 | Severe conviction, weak identity              | DONE    | `banding.test.ts`                                           |
| T73 | Role with exactly one holder                  | DONE    | `banding.test.ts`, seed case `C008`                         |
| T74 | Role held by two people                       | DONE    | `banding.test.ts`, seed case `C009`                         |
| T75 | Settlement with no-admission clause           | DONE    | `stages.test.ts`, seed case `C013`                          |
| T76 | Stage-bearing span absent                     | DONE    | `stages.test.ts`, seed case `C014`                          |
| T77 | Stage 4 event past the configured age         | DONE    | `stages.test.ts`                                            |
| T78 | Query plan cap binds                          | DONE    | `planning.test.ts`                                          |
| T79 | Protected-characteristic term proposed        | DONE    | `lexicon-audit.test.ts`                                     |
| T80 | Search in an unmeasured language              | DONE    | `result-state.test.ts`                                      |

### 9.3 Duplicate, clustering and race tests

| ID               | Status | Test                                                 |
| :--------------- | :----- | :--------------------------------------------------- |
| T22-T24, T29-T31 | TODO   | Require G4                                           |
| T25              | DONE   | `clustering.test.ts`                                 |
| T26              | DONE   | `clustering.test.ts`, invariant I6, seed case `C010` |
| T27              | DONE   | `clustering.test.ts`                                 |
| T28              | DONE   | `clustering.test.ts`, invariant I7                   |
| T81              | TODO   | Requires G7 reviewed split/merge                     |

### 9.4 Evidence, extraction, security and rights

| ID                | Status  | Notes                                                                 |
| :---------------- | :------ | :-------------------------------------------------------------------- |
| T32               | PARTIAL | `LEAD_ONLY` banding for unvalidated spans tested in `banding.test.ts` |
| T33-T45, T82, T83 | TODO    | Require G6/G7                                                         |

### 9.5 Resilience, free-source behaviour, panel and integration

| ID                                   | Status  | Notes                                                     |
| :----------------------------------- | :------ | :-------------------------------------------------------- |
| T46, T48-T58, T60, T84-T87, T89, T90 | TODO    | Require G6-G10                                            |
| T47                                  | DONE    | `result-state.test.ts`                                    |
| T59                                  | PARTIAL | Truncation modelled and surfaced; enforcement requires G6 |
| T88                                  | DONE    | `result-state.test.ts`                                    |

### 9.6 Deferred — provider plans, entitlements and usage controls

**T61, T64, T65, T66, T69, T70 are DEFERRED** with FR-15, per decision **D-007** in
`docs/decisions.md`. They are retained here as a named deferred set so the gap stays visible
rather than being forgotten.

The subset that survives into this phase and remains **TODO** (requires G3):

| ID  | Scenario                                                          |
| :-- | :---------------------------------------------------------------- |
| T62 | Sandbox entitlement without live entitlement                      |
| T63 | Tenant capability excludes adverse media                          |
| T67 | Entitlement suspended mid-run                                     |
| T68 | API key creation, one-time display, hashing, rotation, revocation |
