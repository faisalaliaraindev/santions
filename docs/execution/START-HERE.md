# Start here

Entry point for a session working on this project. Designed to be read cold, with no memory
of previous sessions. It is deliberately short.

---

## 1. Active phase

> **Phase D — Sources, association graph and taxonomy administration (gate G5)**
>
> Brief: [`phase-d.md`](./phase-d.md), expanded into a full brief on 2026-09-11. **D0 and D1 are
> done; D2 is next.**
>
> **D1 built the administrative spine:** one propose → approve → activate lifecycle for sources,
> taxonomy and policy with four-eyes enforcement (T45), the SEC-05 rights engine as an actual
> gate in front of `ACTIVE` (`ALLOW` / `DENY` / `REQUIRES_APPROVAL`, default-deny, prohibited
> collection methods non-approvable), and per-jurisdiction capability coverage where only
> `SUPPORTED` lets an empty result be called "no findings". See `docs/decisions.md` D-018, D-019,
> D-020. **D16 was opened**: any tenant's `source_admin` can change shared registry entries that
> every tenant screens against, and narrowing that to a platform role needs product and security.
>
> **Read [`../sources/cr-dossier.md`](../sources/cr-dossier.md) before building anything in this
> phase.** D0 established that there is **no free automatable officer-level company source in
> Costa Rica** — the Registro Nacional is behind a CAPTCHA, and `api.hacienda.go.cr` returns no
> directors — so FR-02's association graph has no data source in the only enabled jurisdiction
> (**D14**), and that published CR judgments are probably depersonalised, which moves the
> evidence base off court records onto lower-authority channels (**D15**). Both are open, both
> owned outside engineering. It also found a real free source for the D-011 name-frequency
> prior. No source was contacted to establish any of it.
>
> **No decision is due at G5.** D1, D3 and D8 were the three this phase was meant to close, and
> all three closed on 2026-09-11 (see `docs/decisions.md` D-010, D-009, D-012) — Costa Rica with
> es+en requested, all seventeen categories, and a configurable 30-day retention default. The
> phase brief's "Decisions to close" section still named them until C6 corrected it; check
> [`../open-decisions.md`](../open-decisions.md) rather than a phase brief for what is actually
> open. The nearest live one is **D6** — how robots exceptions for official sources are approved
> and recorded — which is due at G6 but is shaped by the source registry D1 builds, so raise it
> with a source admin during this phase rather than at the start of the next.
>
> **Phase C is complete — gate G4 passed.** The whole path from an accepted search to a
> survivable unit of work exists: the section 6.3 records, the transaction runner with the
> outbox, the search index behind the (now closed) D12 seam, evidence staging with its orphan
> sweep and retention deletion, and — at C6 — the consumer that turns a queued message into
> fenced, deduplicated, retryable work.
>
> **What C6 left deliberately unbuilt:** there is no job handler. The worker
> (`pnpm dev:worker`) **refuses to start** because a handler-less consumer would dead-letter
> every queued search as unroutable. Registering the first handler is Phase E's work, and the
> fetch pipeline behind it is what it handles. See `docs/decisions.md` D-016.
>
> Phases A and B are complete. The stack starts, seeds and survives a restart; auth, tenancy,
> entitlements, subjects and idempotent search creation are built and tested against it; the
> OpenAPI document is generated and the panel generates its client from it.

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

Expected today: clean, clean, **338 passed, 29 passed, 12 passed**.

With the stack running (`pnpm local:up && pnpm local:bootstrap`), `pnpm test:integration` adds
**141 integration** tests and `pnpm test:security` **106 security** tests.

Coverage is gated at 85/80 and currently reports 94.69% / 90.47% — but only under CI's own
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
| **D** | G5     | Sources, graph, taxonomy admin       | [`phase-d.md`](./phase-d.md) |
| E     | G6     | Planning, cascade, fetch             | [`phase-e.md`](./phase-e.md) |
| F     | G7     | Extraction and the full pipeline     | [`phase-f.md`](./phase-f.md) |
| G     | G8     | Control panel                        | [`phase-g.md`](./phase-g.md) |
| H     | G9–G11 | Integration, live sources, hardening | [`phase-h.md`](./phase-h.md) |

Briefs for A, B and C are complete, and all three phases are done. D through H are outlines that must be expanded into full
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

| Directory       | What is in it                                                                                                                                                     |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin/`        | The D1 approval lifecycle, the SEC-05 gate at activation, and capability coverage                                                                                 |
| `persistence/`  | The section 6.3 records, and `TransactionRunner` — the one place a transaction opens                                                                              |
| `jobs/`         | `QueuePort` + SQS adapter, `OutboxPublisher`, `verifyJobOwnership` (SEC-01), and C6's `JobConsumer`, `WorkerRuntime`, `DeadLetterPort` and `JobHandler` interface |
| `search-index/` | `SearchIndexPort` behind the D12 seam, the Meilisearch adapter, the FI-10 reconciler                                                                              |
| `storage/`      | `ObjectStorePort` + S3 adapter, `EvidenceStagingService` (stage → verify → commit, plus the orphan sweep), `RetentionSweeper`                                     |

The control panel is a separate repository: `../erly-sanction-service-frontend`. It has its
own `CLAUDE.md`. It must never import the domain packages — decision D-001, enforced by lint
and by `src/app/boundaries.test.ts`.
