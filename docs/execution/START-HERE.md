# Start here

Entry point for a session working on this project. Designed to be read cold, with no memory
of previous sessions. It is deliberately short.

---

## 1. Active phase

> **Phase F — Extraction, classification and the full pipeline (gate G7)**
>
> 🔧 **Starting now: the live extractor — the one thing blocking a live search from Postman.**
>
> **Read [`phase-f.md`](./phase-f.md) §3.3 before anything else.** `sources.registry.ts:209`
> returns `extractionModel: null` in live mode, and the pipeline rejects a document when the
> extractor is null. So a live run discovers real leads, filters them, passes the fetch gate,
> opens a real socket, commits real evidence — and then rejects **every document** at
> `EXTRACTION`, reporting `NO_MATCHES_FOUND`. To a reader that is indistinguishable from "the
> source had nothing on this person". **D-048** decides what to do about it. Discovery is fine;
> `ladder.builder.ts:271` builds live connectors per activated source.
>
> **Priority order for a live Postman e2e** (detail in `phase-f.md` §3bis):
>
> | P      | What                                                                                                        | Whose                       |
> | :----- | :---------------------------------------------------------------------------------------------------------- | :-------------------------- |
> | **P0** | The live rule-based extractor (D-048)                                                                       | Engineering                 |
> | **P0** | F1 normalisation and charset — SEC serves real HTML and the pipeline hands markup to the extractor today    | Engineering                 |
> | **P1** | `pnpm first-contact` → update `robotsPosition` on what it said → propose/approve/activate                   | **Source admin, four eyes** |
> | **P1** | Search a subject actually present in the SEC feed — it is a `FIXED_FEED`, so the name never reaches the SEC | Whoever runs the demo       |
>
> **The wider phase: the extraction model.** Phase E's discovery and fetch path is built and
> green; the pipeline runs end to end in mock mode and over real HTTP. What it does _not_ have is
> extraction it could be surprised by — `MockExtractionModel` is rule-based and keyword-driven, so
> it only ever finds what its own table already knows. That is the largest thing between here and
> a result worth believing.
>
> **Brief: [`phase-f.md`](./phase-f.md) — expanded into a full brief on 2026-09-15.** It carries
> an execution order that deliberately differs from the `F1`–`F7` numbering (**build the FR-07
> validator before the model**), and **two blockers found while writing it**: the labelled set has
> no document bodies, so D7 cannot be benchmarked as written; and the pipeline hands **raw HTML**
> to the extractor while calling it normalised text, with no charset handling. Read §3 before
> writing code.
>
> **The largest gap in the pipeline is unchanged: FR-10 clustering is not wired**, so a syndicated
> copy still counts as a second independent source on axis D. It sits in F5, and it is the
> highest-value thing to pull forward if the phase splits across sessions, because it changes
> bands being produced today.
>
> ---
>
> **Phase E — Query planning, discovery cascade and fetch (gate G6) — the path is built**
>
> 🔧 **Current work: the live-source path. Steps 1 and 2 of eight are done, and step 3 has its
> foundations.** `HttpEvidenceFetchAdapter` — the real `EvidenceFetchPort` — is built, wired and
> tested, and `FetchGateService` **derives** every `FetchAuthorisation` field (**D-036**).
>
> **D17 closed on 2026-09-15**, so this project now has a decided first live source: the **SEC
> litigation-releases RSS feed**, approved by name (Faisal Ali, source admin), one conditional GET
> every fifteen minutes against a recorded 10 req/s ceiling, on four stop conditions that are each
> **proved to fire** by `apps/api/test/fetch-tripwires.test.ts`.
>
> **No live source has been contacted by this project. That is still true.** The source version is
> written and schema-checked (`apps/api/src/sources/registry/sec-litigation-releases.ts`) and has
> **not** been proposed, approved or activated — and it carries `robotsPosition: NOT_ESTABLISHED`,
> which the fetch gate refuses, so the feed cannot be polled until a first `GET /robots.txt` has
> actually happened and the position has been updated on what it said. That ordering is deliberate.
>
> **What step 3 built so far, and what it did not.** The XML parser is decided, built and tested —
> `fast-xml-parser@4.5.7` pinned exactly, behind a DOCTYPE gate this project owns rather than a
> parser option (**D-039**, and **D18** is newly open about v5). The **per-domain breaker** exists
> beside the per-source one, because a discovery source is one agreement and a hundred publishers
> (**D-040**). **Stop conditions** escalate FR-06 per source and can only ever stop (**D-041**).
> **The rungs and the connectors themselves are not built** — that is exactly where step 3 resumes,
> and it is the next concrete action.
>
> Brief: [`phase-e.md`](./phase-e.md) — **expanded into a full brief on 2026-09-14**. It carries
> an execution order that deliberately differs from the `E1`–`E6` step numbering, and says why.
>
> **What step 1 settled, and what a later step must not undo.** The adapter talks HTTPS through
> `node:https` with the SEC-02 screening inside the connection's own `lookup` (**D-034**) — that
> is what defeats DNS rebinding, and screening before a `fetch` call would not. Wire bytes and
> decompressed bytes are separate budgets, because they defend against different attacks. Robots
> `UNKNOWN` **refuses**: an outage at the publisher is not consent. And **a gate refusal is never
> recorded against source health** (**D-035**). Rights are checked **before** the domain gate and
> without spending, so an operator's kill switch is what a refusal reports rather than a
> publisher's cooldown — found by the trip-wire harness, not by reasoning.
>
> **`pnpm demo:api` and the whole test suite still run without any live call.** The real
> transport is constructed only by the live composition root, and every test in the fetch suite
> uses an injected one.
>
> **What D5 built, and what the fetch adapter now does** (kept here because every later
> connector must do the same). Source health is a **separate
> mutable document** (`sourceHealth`, keyed by `sourceId`) beside the immutable `SourceVersion`:
> the approved version says what is _permitted_, health says what is _happening_. Call
> `SourceHealthService.checkAccess` **immediately before every external call**, not at plan time
> — that point-of-use recheck is what makes the kill switch effective mid-run (T36) — then feed
> the outcome back with `recordFailure` / `recordSuccess`. The breaker reads the existing FR-06
> table and invents nothing. A refusal is **never** a silent skip: it becomes a
> `SourceCoverageOutcome` naming what stopped it. See `docs/decisions.md` D-031 and D-032, and
> failure-injection rows FI-17 and FI-18.
>
> **What D6 built, and the gap it leaves open.** The taxonomy lexicon is **no longer empty** —
> 155 hand-authored terms across `en` and `es`, so F3 category queries are now built — and the
> lexicon audit now fails **activation** as well as CI (T79), along with three other refusals a
> `taxonomy_admin` could otherwise slip through. **⚠️ No Spanish reader has reviewed the Spanish
> terms.** Every term is marked `UNREVIEWED_AUTHORED`, the coverage statement says so on every
> run, and `docs/decisions.md` D-033 records the open action. An unreviewed term does not fail —
> it returns nothing — so the Spanish half may report no findings because the query was wrong
> rather than because nothing exists. **Finding a Spanish-reading reviewer is still open and is
> owned outside engineering.**
>
> **No Costa Rican name-frequency distribution is loaded**, and nothing invents one. It is
> blocked on the SEC-05 aggregate-only approval for the TSE padrón (D-011). The cost is real and
> is printed on every bootstrap: the FR-08 top-decile penalty never fires for CR names, so a
> common name reaches a higher identity grade than it should.
>
> **The largest gap in the pipeline is unchanged: FR-10 clustering is not wired**, so a
> syndicated copy still counts as a second independent source on axis D.
>
> **Phase D is complete — gate G5 passed.** D0 the CR source dossier (opening **D14** and
> **D15**, both owned outside engineering); D1 the propose → approve → activate lifecycle with
> four eyes and the SEC-05 rights gate (opening **D16**); D2 the six FR-05 ports, six
> deterministic mocks and one real adapter (UK Companies House, **GB only — not Costa Rican
> coverage**); D3 the FR-02 association graph, where a `PARTIAL` identity grade attaches nothing;
> D4 the traversal bounds as policy-version configuration pinned to the run; D5 source health;
> D6 the lexicon and its activation audit. Decisions D-018 through D-033.
>
> **D15 remains open and untouched**, and it is now the nearer blocker: the cascade's rung tiers —
> step 3's remaining work — encode its answer. D17 closing does **not** cover it, because a Costa
> Rican judicial portal is a different publisher and needs its own named approval.
>
> **Two decisions are due at G6 and both are open.** Check
> [`../open-decisions.md`](../open-decisions.md) rather than a phase brief for what is actually
> open. **D6 — how robots exceptions for official sources are approved and recorded — was raised
> with specifics on 2026-09-14** and is written up there with three options and a recommendation.
> **It needs a source admin, not an engineer.** Until it closes, no robots exception can be
> applied at all: the schema has no field for the named approver the fetch gate demands, so an
> `EXCEPTION_APPROVED` source is refused rather than fetched. That is the safe direction and it
> is recorded as provisional. **D15 — the Costa Rican primary-source evidence base — is also due
> at G6** and is untouched.
>
> **Phases A, B, C and D are complete.** The stack starts, seeds and survives a restart; auth,
> tenancy, entitlements, subjects and idempotent search creation are built and tested against it;
> persistence, jobs, the search index and evidence storage exist with their reconcilers; and a
> search runs end to end in mock mode (`pnpm demo:api`). The worker refuses to start without a
> handler (D-016); the handler exists as of the Phase E slice built early for a demo.

Update this pointer when a phase completes. It is the one line every session depends on.

---

## 2. What to read, and what not to

Read, in this order:

1. This file.
2. [`handoff-log.md`](./handoff-log.md) — the last few entries only. What the previous session
   did and what it left behind.
3. Your phase brief. It names every file and spec section you need.

**Do not read these unless a phase brief points you at a specific section:**

| File                                                       | Size   | Why not                                                |
| :--------------------------------------------------------- | :----- | :----------------------------------------------------- |
| `../../../Adverse_Search_Strategy.md`                      | ~66KB  | Domain reasoning. Already encoded in `packages/domain` |
| `../../../CODEX_ADVERSE_SEARCH_IMPLEMENTATION_GOAL (3).md` | ~102KB | The requirements. Phase briefs quote what you need     |
| `../requirements-traceability.md`                          | Large  | Read only the rows for your phase                      |

Reading the two source documents end to end costs roughly 45,000 tokens and leaves you less
room to do the work than to plan it. The phase briefs exist so you do not have to.

---

## 3. Session protocol

**At the start**

1. Read this file, the recent handoff entries, and your phase brief.
2. Run the health check below. If it does not pass, something regressed — investigate before
   building on it.
3. Work the steps in the brief in order. They are dependency-ordered within the phase.

**Health check** — takes about ten seconds, no infrastructure needed:

```bash
pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:invariants && pnpm test:evaluation
```

Expected today (2026-09-15): clean, clean, **829 passed, 29 passed, 12 passed**.

With the stack running (`pnpm local:up && pnpm local:bootstrap`), `pnpm test:integration` adds
**207 integration** tests, `pnpm test:security` **106 security** tests, and `pnpm test:e2e:api`
**10 API end-to-end** tests over real HTTP, real SQS and a real worker.

Coverage is gated at 85/80 and currently reports 94.07% / 90.46% — but only under CI's own
invocation, which is
`pnpm exec vitest run --project unit --project invariants --project evaluation --coverage`.
Running `--project unit` alone reports ~84% and fails, because domain code is also exercised by
the other two projects. Do not "fix" a coverage failure that is really a wrong invocation.

**At the end — before the session is cleared**

1. Append an entry to [`handoff-log.md`](./handoff-log.md) using the template at its top.
   This is the only thing carrying state to the next session. Write it as though the reader
   knows nothing, because they will not.
2. Update the phase brief's checklist — tick what is genuinely done, and note what is
   half-done and where it stopped.
3. If the phase completed, update the **Active phase** pointer in section 1 and move the gate
   in `../implementation-status.md`.
4. Commit. A phase left uncommitted is a phase the next session cannot see.

---

## 4. Rules that survive every phase

These are not style preferences. Each one exists because breaking it produces a screening
product that states something untrue about a real person.

1. **Never weaken an invariant to make something pass.** I1–I10 are in
   `packages/evaluation/src/invariants/harness.ts`. If one fails, the code is wrong.
2. **Never mark a suite passing that did not run.** Unimplemented commands exit non-zero
   deliberately.
3. **Never claim a source was verified live.** No live call has ever been made from this
   project. Fixtures are labelled and isolated from live mode.
4. **Never enable a language without a measured recall figure** (FR-03). None is measured, so
   none is enabled, and the coverage statement must say so.
5. **Keep `packages/domain` and `packages/evaluation` free of I/O.** Use a port.
6. **Do not let an open decision acquire a silent default.** See `../open-decisions.md`.

---

## 5. Phase map

| Phase | Gate   | Focus                                | Brief                        |
| :---- | :----- | :----------------------------------- | :--------------------------- |
| A     | G1     | Make the local stack real            | [`phase-a.md`](./phase-a.md) |
| B     | G3     | Identity, tenancy, API contract      | [`phase-b.md`](./phase-b.md) |
| C     | G4     | Persistence, jobs, index, storage    | [`phase-c.md`](./phase-c.md) |
| D     | G5     | Sources, graph, taxonomy admin       | [`phase-d.md`](./phase-d.md) |
| E     | G6     | Planning, cascade, fetch             | [`phase-e.md`](./phase-e.md) |
| **F** | G7     | Extraction and the full pipeline     | [`phase-f.md`](./phase-f.md) |
| G     | G8     | Control panel                        | [`phase-g.md`](./phase-g.md) |
| H     | G9–G11 | Integration, live sources, hardening | [`phase-h.md`](./phase-h.md) |

Briefs for A, B, C, D, E and **F** are complete. G and H are outlines that must be expanded into full
briefs **at the start of their phase** — deliberately, because their detail depends on what
earlier phases reveal. Writing them out now would harden guesses into instructions. Each
outline says what expanding it involves.

Why the phases are ordered this way: [`../delivery-plan.md`](../delivery-plan.md).

---

## 6. Where things are

```
packages/domain/       PURE. Taxonomy, stages, four axes, banding, clustering, planning,
                       and the FR-06 failure classification table
packages/evaluation/   PURE. Labelled dataset, FR-16 metrics, I1-I10 harness
packages/contracts/    Versioned schemas; the OpenAPI document is generated from here
apps/api/              NestJS. auth/ tenancy/ subjects/ searches/ persistence/ jobs/
                       search-index/ — see below
                       worker-main.ts is the worker entrypoint — same image, same DI graph,
                       no HTTP server (D-016). There is no separate apps/worker package
infra/local/           Docker Compose stack, host ports in the 280xx range
scripts/               local-up, local-bootstrap, local-reset, verify-local
docs/                  architecture, decisions, open-decisions, traceability, status,
                       failure-injection-matrix
```

Inside `apps/api/src`, the four directories Phase C added:

| Directory       | What is in it                                                                                                                                                                                                                                                                       |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin/`        | The D1 approval lifecycle, the SEC-05 gate at activation, and capability coverage                                                                                                                                                                                                   |
| `persistence/`  | The section 6.3 records, and `TransactionRunner` — the one place a transaction opens                                                                                                                                                                                                |
| `jobs/`         | `QueuePort` + SQS adapter, `OutboxPublisher`, `verifyJobOwnership` (SEC-01), and C6's `JobConsumer`, `WorkerRuntime`, `DeadLetterPort` and `JobHandler` interface                                                                                                                   |
| `search-index/` | `SearchIndexPort` behind the D12 seam, the Meilisearch adapter, the FI-10 reconciler                                                                                                                                                                                                |
| `storage/`      | `ObjectStorePort` + S3 adapter, `EvidenceStagingService` (stage → verify → commit, plus the orphan sweep), `RetentionSweeper`                                                                                                                                                       |
| `sources/`      | The six FR-05 ports (D2), their deterministic mocks in `mock/`, the GB-only Companies House adapter, the live `HttpEvidenceFetchAdapter` (E1), and `FetchGateService` — the only issuer of a `FetchAuthorisation` — with its source-version reader and the one egress identity (E2) |
| `associations/` | The FR-02 graph (D3): officer resolution, the `DIRECTOR_OF` edges, and the snapshot frozen to the run                                                                                                                                                                               |
| `pipeline/`     | The search pipeline, the job handler that runs it, and the findings store (Phase E slice)                                                                                                                                                                                           |

The control panel is a separate repository: `../erly-sanction-service-frontend`. It has its
own `CLAUDE.md`. It must never import the domain packages — decision D-001, enforced by lint
and by `src/app/boundaries.test.ts`.
