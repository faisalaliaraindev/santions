# Phase E — Query planning, discovery cascade and fetch

**Gate:** G6 · **Status:** outline — expand before starting · **Prerequisite:** Phase D

> **Outline, not a brief.** Expand at the start of the phase.

## Goal

Give the already-tested planning rules somewhere to send queries, and fetch what comes back
without ever turning a blocked source into a clean result.

## Scope

| Step | Deliverable                                                                                            |
| :--- | :----------------------------------------------------------------------------------------------------- |
| E1   | Generate the eight families from real subjects, taxonomy and graph; prove F1 and F4 survive truncation |
| E2   | The seven-rung cascade with per-rung logging, per-source budgets, breakers, coverage emission          |
| E3   | Egress pool: egress identities, sticky rotation, the FR-06 failure classifier                          |
| E4   | Relevance filtering and the fetch gate; rejected candidates stored as leads with reasons               |
| E5   | HTTP-first fetch, with deterministic logged Playwright escalation cached per domain                    |
| E6   | Scheduled contract tests for every undocumented source                                                 |

## Already built

`packages/domain/src/planning/query-families.ts` — the eight families, `boundPlan` with the
declared drop order, and `assertPlanIsEntityAnchored`. `boundPlan` **throws** rather than
silently dropping F1 or F4 when a cap is too low. Tested against T78.

`packages/domain/src/coverage/result-state.ts` — `aggregateRun` and `renderNoMatchStatement`,
tested against T21, T47 and T88.

## The part that is easy to get wrong

A silent parse failure on an undocumented source (Google News RSS above all) reduces recall to
zero, and the system then starts reporting clean results for everyone. E6 is not optional
polish — it is the detection mechanism for the worst failure this product has.

Never bypass a CAPTCHA, paywall, login wall or access control, by any path. Honour robots.txt;
exceptions are per-source and per-jurisdiction with a named approver recorded in the registry,
never a global setting. The user agent identifies the service honestly with a contact URL.

The egress pool is capacity management and geographic correctness. It is **not** block evasion,
and the `ProxyPort` has a mock adapter only in this phase.

## Exit evidence

Fixture searches complete end to end through real local infrastructure. T37 to T39, T46, T59
and T84 to T90 pass. A blocked or exhausted source produces a **visible coverage gap, never a
clean result**.

## Decision to close

**D6** — how robots exceptions for official sources are approved and recorded.
