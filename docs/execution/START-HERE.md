# Start here

Entry point for a session working on this project. Designed to be read cold, with no memory
of previous sessions. It is deliberately short.

---

## 1. Active phase

> **Phase C — Persistence, jobs, index and object storage (gate G4)**
>
> Brief: [`phase-c.md`](./phase-c.md) — expanded into a full brief on 2026-09-11. Start at C0,
> the failure-injection matrix; it is the specification for the tests in C2, C5 and C6.
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

Expected today: clean, clean, 206 passed, 29 passed, 12 passed.

With the stack running (`pnpm local:up && pnpm local:bootstrap`), `pnpm test:integration`
adds 14 integration and 86 security tests.

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
| **C** | G4     | Persistence, jobs, index, storage    | [`phase-c.md`](./phase-c.md) |
| D     | G5     | Sources, graph, taxonomy admin       | [`phase-d.md`](./phase-d.md) |
| E     | G6     | Planning, cascade, fetch             | [`phase-e.md`](./phase-e.md) |
| F     | G7     | Extraction and the full pipeline     | [`phase-f.md`](./phase-f.md) |
| G     | G8     | Control panel                        | [`phase-g.md`](./phase-g.md) |
| H     | G9–G11 | Integration, live sources, hardening | [`phase-h.md`](./phase-h.md) |

Briefs for A, B and C are complete; A and B are done. D through H are outlines that must be expanded into full
briefs **at the start of their phase** — deliberately, because their detail depends on what
earlier phases reveal. Writing them out now would harden guesses into instructions. Each
outline says what expanding it involves.

Why the phases are ordered this way: [`../delivery-plan.md`](../delivery-plan.md).

---

## 6. Where things are

```
packages/domain/       PURE. Taxonomy, stages, four axes, banding, clustering, planning
packages/evaluation/   PURE. Labelled dataset, FR-16 metrics, I1-I10 harness
apps/api/              empty — Phase B
apps/worker/           empty — Phase C
infra/local/           Docker Compose stack, host ports in the 280xx range
scripts/               local-up, local-reset, verify-local
docs/                  architecture, decisions, open-decisions, traceability, status
```

The control panel is a separate repository: `../erly-sanction-service-frontend`. It has its
own `CLAUDE.md`. It must never import the domain packages — decision D-001, enforced by lint
and by `src/app/boundaries.test.ts`.
