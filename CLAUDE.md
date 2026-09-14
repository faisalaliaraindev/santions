# Erly adverse-search service

Standalone adverse-media search service. Node/TypeScript backend, React control panel in a
separate repository (`erly-sanction-service-frontend`). Free and open-source sources only —
zero paid data subscriptions.

## If you are starting a fresh session

**Read `docs/execution/START-HERE.md` first.** It is short and tells you which phase is
active and exactly what to read for it.

**Do not read `Adverse_Search_Strategy.md` or `CODEX_ADVERSE_SEARCH_IMPLEMENTATION_GOAL (3).md`
end to end.** They are ~167KB combined and live in the parent directory. Every phase brief
names the specific sections you need. Reading them wholesale burns most of a context window
before any work starts.

## The three rules that override convenience

1. **Never weaken an invariant to make a gate pass.** `pnpm test:invariants` runs I1–I10 with
   no I/O. A failure means the system can state something it has no basis to state. Fix the
   code, not the test.
2. **A suite that does not exist fails; it never passes vacuously.** Unimplemented commands
   exit non-zero on purpose. `pnpm verify:local` reports them as unverified.
3. **Never claim verification that did not happen.** No live source has been contacted. No
   language is enabled. If you did not run it, say so.

## Purity boundary

`packages/domain` and `packages/evaluation` perform **no I/O** — no database, network,
filesystem or clock reads (callers pass `asOf`). This exists so the I1–I10 gate runs on a
clean checkout with nothing started. Do not import I/O into these packages; use a port.

## Commands

```
pnpm test:invariants   # I1-I10 release gate, needs no infrastructure
pnpm test:unit         # domain unit tests
pnpm test:evaluation   # FR-16 metrics
pnpm lint / typecheck
pnpm openapi:generate  # regenerate openapi/openapi.json from packages/contracts
pnpm verify:local      # aggregates mandatory non-live checks; currently fails by design
pnpm local:up          # start the local stack
pnpm demo:api          # end-to-end walkthrough over the real HTTP API (mock sources)
```

## Key documents

| File                            | What it is                                             |
| :------------------------------ | :----------------------------------------------------- |
| `docs/execution/START-HERE.md`  | **Session entry point.** Active phase and reading list |
| `docs/execution/handoff-log.md` | What the last session did and left behind              |
| `docs/delivery-plan.md`         | Why the phases are in this order                       |
| `docs/implementation-status.md` | Gate-by-gate status and known gaps                     |
| `docs/open-decisions.md`        | D1–D12, each with an owner and closing gate            |
