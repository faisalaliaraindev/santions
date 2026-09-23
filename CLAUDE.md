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
3. **Never claim verification that did not happen.** No language is enabled. If you did not
   run it, say so.

   **First live contact has happened** — 2026-09-16, the SEC, under D17. See
   `docs/sources/first-live-contact.md` for exactly what was contacted and when. Since then:
   GDELT under D18, and one bounded Google-News-via-SearXNG diagnostic under D20-A (which
   activated nothing — Google is still REFUSED and now also defaults OFF). Each was contacted
   under a decision that names it, and none of them makes any other claim about coverage true.

   **`en.wikinews.org` was contacted on 2026-09-23 under D22**, approved by Faisal Ali, Source
   admin. `wikinews-en` is ACTIVE through a four-eyes lifecycle and one article has been fetched
   and turned into one finding — the rung-5 chain is proven end to end.

   **It is the ONLY publisher approved for rung-5 fetching.** Every other domain SearXNG
   discovers is refused `PUBLISHER_NOT_APPROVED`, per candidate, and that is correct rather than
   a coverage gap. Approving another one needs its own decision recorded in
   `scripts/lib/first-contact-approvals.mjs`, which throws for a source no decision names.

   **A local-only Google diagnostic exists** (twenty-ninth session): one LIVE search, by the
   tenant named in `GOOGLE_DIAGNOSTIC_TENANT_ID`, with `ALLOW_LOCAL_GOOGLE_DIAGNOSTIC=true`, to a
   loopback API, carrying `X-Local-Discovery-Diagnostic: GOOGLE_NEWS`, may add `GOOGLE_NEWS` for
   that request only. It writes no setting and moves nothing in D20; production refuses to start
   with the flag. Postman Folder 19 and `docs/testing/google-live-local.md`. The user runs it.

   **The user drives first contact.** Build and verify up to the request, then stop and hand over
   the armed command. Never fill `robotsPosition` or `firstContactApproval` on a registry record
   by editing the file — that is bypassing the lifecycle, not completing it.

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

| File                            | What it is                                                                     |
| :------------------------------ | :----------------------------------------------------------------------------- |
| `RUNBOOK.md`                    | **What to start and in what order**, from nothing running to a working request |
| `docs/execution/START-HERE.md`  | **Session entry point.** Active phase and reading list                         |
| `docs/execution/handoff-log.md` | What the last session did and left behind                                      |
| `docs/delivery-plan.md`         | Why the phases are in this order                                               |
| `docs/implementation-status.md` | Gate-by-gate status and known gaps                                             |
| `docs/open-decisions.md`        | D1–D12, each with an owner and closing gate                                    |
