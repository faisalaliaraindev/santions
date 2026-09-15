# Erly adverse-search service

A standalone adverse-media search service. It retrieves published material about a subject,
resolves whether that material refers to the subject, classifies what is reported and at what
procedural stage, and grades how well the evidence supports the connection.

It is **not** a criminal record check, **not** a proof of identity, and **not** a
determination of guilt. Findings support human review. A designation found in reporting is a
lead to verify against the primary list, never a sanctions finding — Zquence keeps its
existing sanctions.io integration for that.

Every source, library and model is free to use, open-source, or public data published by the
issuing authority. There are no paid data subscriptions and no commercial data licences.

## Status

**G0 and G2 complete. G1 partial. Everything after that is not started.**

`docs/implementation-status.md` is the authoritative status, including what is _not_ built
and what is unverified. Short version:

- The domain core and the I1-I10 invariant harness are built, tested and passing.
- No live source has ever been contacted. No language is enabled, because none has a measured
  recall figure.
- The API, worker, control panel, persistence, sources and fetch layer do not exist yet.

Commands that are not implemented exit non-zero rather than passing vacuously.

## Prerequisites

| Requirement | Version                  | Why                                                                                                                                                            |
| :---------- | :----------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js     | 22 LTS (`>=22.12.0 <25`) | Runtime. See decision D-003.                                                                                                                                   |
| pnpm        | 10.15.0                  | Pinned via `packageManager`; run `corepack enable`.                                                                                                            |
| Docker      | With Compose v2          | The local stack needs a MongoDB **replica set** (transactions), a search index, S3/SQS emulation, an OIDC provider, a metasearch instance and a model runtime. |

A standalone `mongod` will not do: transactions are required for the state/outbox/audit
commit, and only a replica set provides them.

## Getting started

```bash
corepack enable
pnpm install --frozen-lockfile

cp .env.example .env      # local placeholders only; never commit a real secret

pnpm local:up             # start dependencies and wait for real healthchecks
pnpm verify:local         # aggregate the mandatory non-live checks
```

`pnpm verify:local` currently **fails**, correctly: the integration, security and end-to-end
suites are not implemented, and it reports them as unverified rather than as passes.

To run only what exists and passes today:

```bash
pnpm lint
pnpm typecheck
pnpm test:unit         # 754 tests
pnpm test:invariants   #  29 tests — the I1-I10 release gate, needs no infrastructure
pnpm test:evaluation   #  12 tests
```

## Calling the API

Five steps from a clean checkout to a search result in Postman.

```bash
pnpm local:up && pnpm local:bootstrap   # start and seed the stack
pnpm dev:api                            # terminal 1 — accepts searches
pnpm dev:worker                         # terminal 2 — runs them
pnpm key:issue                          # prints a machine API key, once
```

Then import `postman/erly-adverse-search.postman_collection.json` and
`postman/local.postman_environment.json`, paste the key into the `apiKey` variable, and run the
folders in order. Full walkthrough: [`postman/README.md`](./postman/README.md).

`pnpm demo:api` does the same sequence from the command line if you would rather watch it than
click it.

**Everything above runs in mock mode.** Every source is a fixture, every record is stamped
`mode: "MOCK"`, and nothing leaves your machine. The shape of every response is real; the content
is test data.

## Commands

| Command                                               | What it does                                                             |
| :---------------------------------------------------- | :----------------------------------------------------------------------- |
| `pnpm local:up`                                       | Start dependencies; waits for each service's own healthcheck             |
| `pnpm local:down`                                     | Stop dependencies, **keeping** persisted volumes                         |
| `pnpm local:reset`                                    | Delete local volumes, behind an explicit typed confirmation              |
| `pnpm local:bootstrap`                                | Seed the selected local environment                                      |
| `pnpm dev:api` / `pnpm dev:worker`                    | Run the API and the worker. Both are needed for a search to finish       |
| `pnpm key:issue`                                      | Mint a machine API key. Prints the secret once (D-007: provider-managed) |
| `pnpm demo:api`                                       | End-to-end walkthrough over the real HTTP API, mock sources              |
| `pnpm lint` / `format` / `typecheck`                  | Quality gates                                                            |
| `pnpm test:unit`                                      | Domain unit tests                                                        |
| `pnpm test:invariants`                                | **The I1-I10 release gate.** Runs with no I/O dependency.                |
| `pnpm test:evaluation`                                | FR-16 metrics on the held-out split                                      |
| `pnpm test:integration` / `security` / `e2e` / `load` | _Not implemented_ — exit non-zero                                        |
| `pnpm verify:local`                                   | Aggregates mandatory non-live checks; fails on skipped required suites   |
| `pnpm lexicon:audit`                                  | Fails if any query term maps to a protected characteristic               |

Live-mode commands (`test:contract:live`, `measure:coverage`, `verify:aws`) do not exist yet.
They will require configured access and owner authorisation. **Live mode defaults off.**

## Repository layout

This is the backend repository. The React control panel lives in
`erly-sanction-service-frontend` — see decision D-001 for why the plan's single-monorepo
layout was split, and how the "one business API, no second matching engine in the browser"
requirement is enforced across the two.

```
apps/api/            NestJS HTTP API                     (not implemented — G3)
apps/worker/         Queue consumers                     (not implemented — G4)
packages/domain/     PURE. Taxonomy, stages, four axes, banding, clustering, planning
packages/evaluation/ PURE. Labelled dataset, FR-16 metrics, I1-I10 harness
packages/contracts/  Public schemas and OpenAPI          (not implemented — G3)
packages/providers/  Source and extraction adapters      (not implemented — G5)
packages/persistence/Repositories, transactions, outbox  (not implemented — G4)
packages/observability/                                  (not implemented — G4)
packages/client/     Typed Node client for integrators   (not implemented — G9)
infra/local/         Docker Compose stack and fixtures
infra/aws/           Infrastructure code, disabled until deployment is authorised
docs/                Architecture, decisions, traceability, coverage matrix, status
```

### The purity boundary

`packages/domain` and `packages/evaluation` perform **no I/O**: no database, no network, no
filesystem, no clock reads — callers pass `asOf` explicitly.

This is load-bearing. `pnpm test:invariants` gates every pull request and must run on a clean
checkout with nothing started. A gate that needs a database running is a gate that gets
skipped exactly when it matters.

The cost: ICU transliteration, libpostal and NER cannot be imported here. They are injected
through ports (`TransliterationPort`). `matchNameForms` therefore cannot match across scripts
on its own, and its tests assert `NO_MATCH` rather than pretending otherwise.

## The ten invariants

`pnpm test:invariants` runs these. A failure blocks release, because it means the system is
capable of stating something it has no basis to state.

| ID  | Invariant                                                                               |
| :-- | :-------------------------------------------------------------------------------------- |
| I1  | Event severity, publisher authority and article count never raise identity confidence   |
| I2  | A strong identifier contradiction is overridden only by reasoned human review           |
| I3  | A company-only attribution never produces a personal adverse finding                    |
| I4  | A procedural stage is never displayed higher than the stage its span establishes        |
| I5  | A settlement never renders as an admission; a civil claim never as a criminal matter    |
| I6  | Syndicated copies never increase the independence count                                 |
| I7  | An acquittal, dismissal, correction or retraction always attaches at equal prominence   |
| I8  | No numeric probability is displayed unless calibrated on held-out labelled data         |
| I9  | No composite person-level risk score is produced                                        |
| I10 | `NO_MATCHES_FOUND` is never reported without its coverage state and every failed source |

I10 is why this service has three independent result dimensions — execution, findings and
coverage. "The job finished", "we found nothing" and "we searched everything we said we
would" are three different facts, and collapsing them is how a screening product reports a
clean result for a run in which every source was blocked.

## Documentation

| Document                            | Contents                                                                  |
| :---------------------------------- | :------------------------------------------------------------------------ |
| `docs/implementation-status.md`     | Gate-by-gate status, defects found, known gaps                            |
| `docs/architecture.md`              | Package layout, pipeline, trust boundaries, threat summary                |
| `docs/decisions.md`                 | Architecture decisions with rationale and cost                            |
| `docs/open-decisions.md`            | D1-D12, each with an owner and a closing gate                             |
| `docs/requirements-traceability.md` | FR/SEC/REL and every test T01-T90 mapped to code                          |
| `docs/coverage-matrix.md`           | Per-source, per-language, per-jurisdiction coverage — **empty until G10** |

## Contributing

Pull requests must pass format, lint, typecheck, unit tests, **the I1-I10 invariant harness**
and coverage thresholds (85% statements, 80% branches over the domain and evaluation
packages).

Do not weaken a security control, delete a failing test or narrow search scope to make a gate
green. Document the failure and implement the correction.
