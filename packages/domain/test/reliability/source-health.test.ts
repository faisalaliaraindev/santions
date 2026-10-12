/**
 * Phase D step D5 — the breaker, the budgets and the kill switch.
 *
 * The properties asserted here are the ones that, if they broke, would either hammer a source
 * that has refused us or hide from a reviewer that a source was never consulted:
 *
 *  - a `CONTENT_ERROR` never opens a breaker, and a `HARD_BLOCK` opens it on the first failure;
 *  - the kill switch refuses **before** anything else, so an operator's reason is what gets
 *    reported rather than a breaker state that happens to be true as well;
 *  - budget exhaustion is `PARTIAL` / `TRUNCATED_BY_QUOTA`, not a failure;
 *  - every refusal produces a coverage outcome, so none of them can be a silent skip.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BREAKER_CONFIG,
  accessCoverageOutcome,
  breakerAt,
  countsAgainstSourceHealth,
  decideSourceAccess,
  engageKillSwitch,
  newSourceHealth,
  observeFailure,
  observeFailureSignal,
  observeSuccess,
  opensBreakerImmediately,
  releaseKillSwitch,
  rollBudgets,
  sinceSuspendedNote,
  spendAccess,
  type SourceBudgets,
  type SourceHealth,
} from '../../src/reliability/source-health.js';
import { FAILURE_CLASSES } from '../../src/reliability/failure-classification.js';

const T0 = new Date('2026-09-14T10:30:00.000Z');
const UNLIMITED: SourceBudgets = { hourlyBudget: null, dailyBudget: null };

function health(overrides: Partial<SourceHealth> = {}): SourceHealth {
  return {
    ...newSourceHealth({ sourceId: 'src-news-cr', observedVersion: 3, now: T0 }),
    ...overrides,
  };
}

describe('the breaker reads the FR-06 table rather than restating it', () => {
  it('counts source-level failures and ignores document-level ones', () => {
    // Degraded or retryable: the source is the thing that is unwell.
    expect(countsAgainstSourceHealth('TRANSIENT_NETWORK')).toBe(true);
    expect(countsAgainstSourceHealth('RATE_LIMITED')).toBe(true);
    expect(countsAgainstSourceHealth('SOFT_BLOCK')).toBe(true);
    expect(countsAgainstSourceHealth('HARD_BLOCK')).toBe(true);

    // Facts about one document. A 404 on one article says nothing about the publisher.
    expect(countsAgainstSourceHealth('CONTENT_ERROR')).toBe(false);
    expect(countsAgainstSourceHealth('OVERSIZE')).toBe(false);
  });

  it('opens immediately only where the table says stop or alert', () => {
    expect(opensBreakerImmediately('HARD_BLOCK')).toBe(true);
    expect(opensBreakerImmediately('AUTH_CREDENTIAL')).toBe(true);
    expect(opensBreakerImmediately('TRANSIENT_NETWORK')).toBe(false);
    expect(opensBreakerImmediately('RATE_LIMITED')).toBe(false);
  });

  it('classifies every declared class without inventing a category', () => {
    for (const failureClass of FAILURE_CLASSES) {
      const after = observeFailure({ health: health(), failureClass, now: T0 });
      expect(after.lastFailureClass).toBe(failureClass);
    }
  });

  it('does not open on a run of content errors', () => {
    let current = health();
    for (let i = 0; i < 10; i += 1) {
      current = observeFailure({ health: current, failureClass: 'CONTENT_ERROR', now: T0 });
    }
    expect(current.breaker).toBe('CLOSED');
    expect(current.consecutiveFailures).toBe(0);
    // Still recorded, so an operator can see a source producing nothing but dead links.
    expect(current.lastFailureClass).toBe('CONTENT_ERROR');
  });

  it('opens on the threshold of qualifying failures, and not before', () => {
    let current = health();
    for (let i = 0; i < DEFAULT_BREAKER_CONFIG.failureThreshold - 1; i += 1) {
      current = observeFailure({ health: current, failureClass: 'TRANSIENT_NETWORK', now: T0 });
      expect(current.breaker).toBe('CLOSED');
    }
    current = observeFailure({ health: current, failureClass: 'TRANSIENT_NETWORK', now: T0 });
    expect(current.breaker).toBe('OPEN');
    expect(current.openedAt).toBe(T0.toISOString());
  });

  it('opens on the first hard block', () => {
    const after = observeFailure({ health: health(), failureClass: 'HARD_BLOCK', now: T0 });
    expect(after.breaker).toBe('OPEN');
  });

  it('opens on the first revoked credential — free-source keys are revoked silently', () => {
    const after = observeFailureSignal({ health: health(), signal: { httpStatus: 401 }, now: T0 });
    expect(after.lastFailureClass).toBe('AUTH_CREDENTIAL');
    expect(after.breaker).toBe('OPEN');
  });

  it('a success closes the breaker outright', () => {
    const open = observeFailure({ health: health(), failureClass: 'HARD_BLOCK', now: T0 });
    const closed = observeSuccess({ health: open, now: T0 });
    expect(closed.breaker).toBe('CLOSED');
    expect(closed.openedAt).toBeNull();
    expect(closed.consecutiveFailures).toBe(0);
    expect(closed.lastSuccessAt).toBe(T0.toISOString());
  });
});

describe('the cooldown is driven by the clock, not by an event', () => {
  const opened = observeFailure({ health: health(), failureClass: 'HARD_BLOCK', now: T0 });

  it('stays open inside the cooldown', () => {
    const inside = new Date(T0.getTime() + DEFAULT_BREAKER_CONFIG.openDurationMs - 1);
    expect(breakerAt(opened, inside).breaker).toBe('OPEN');
  });

  it('goes half-open at the cooldown boundary', () => {
    const at = new Date(T0.getTime() + DEFAULT_BREAKER_CONFIG.openDurationMs);
    expect(breakerAt(opened, at).breaker).toBe('HALF_OPEN');
  });

  it('admits exactly the probe allowance, then refuses again', () => {
    const at = new Date(T0.getTime() + DEFAULT_BREAKER_CONFIG.openDurationMs);
    const first = decideSourceAccess({ health: opened, budgets: UNLIMITED, now: at });
    expect(first.allowed).toBe(true);
    expect(first.health.breaker).toBe('HALF_OPEN');

    const spent = spendAccess({ health: first.health, now: at });
    expect(spent.halfOpenProbes).toBe(1);

    const second = decideSourceAccess({ health: spent, budgets: UNLIMITED, now: at });
    expect(second.allowed).toBe(false);
    expect(second.refusal).toBe('BREAKER_OPEN');
  });

  it('a failed probe re-opens the breaker at once', () => {
    const at = new Date(T0.getTime() + DEFAULT_BREAKER_CONFIG.openDurationMs);
    const halfOpen = breakerAt(opened, at);
    const failed = observeFailure({
      health: halfOpen,
      failureClass: 'TRANSIENT_NETWORK',
      now: at,
    });
    expect(failed.breaker).toBe('OPEN');
    expect(failed.openedAt).toBe(at.toISOString());
  });

  it('treats an unparsable openedAt as just opened, never as long expired', () => {
    const corrupt = { ...opened, openedAt: 'not a date' };
    const far = new Date(T0.getTime() + 99 * 60 * 60_000);
    expect(breakerAt(corrupt, far).breaker).toBe('OPEN');
  });
});

describe('budgets', () => {
  const budgets: SourceBudgets = { hourlyBudget: 2, dailyBudget: 3 };

  it('refuses once the hourly window is spent, and reopens in the next hour', () => {
    let current = health();
    current = spendAccess({ health: current, now: T0 });
    current = spendAccess({ health: current, now: T0 });

    const refused = decideSourceAccess({ health: current, budgets, now: T0 });
    expect(refused.allowed).toBe(false);
    expect(refused.refusal).toBe('HOURLY_BUDGET_EXHAUSTED');

    const nextHour = new Date('2026-09-14T11:00:00.000Z');
    const allowed = decideSourceAccess({ health: current, budgets, now: nextHour });
    expect(allowed.allowed).toBe(true);
    expect(allowed.health.hourly.spent).toBe(0);
    // The daily window has not rolled: two calls are still counted against the day.
    expect(allowed.health.daily.spent).toBe(2);
  });

  it('the daily window survives an hourly roll and refuses on its own', () => {
    let current = health();
    current = spendAccess({ health: current, now: T0 });
    current = spendAccess({ health: current, now: T0 });
    current = spendAccess({ health: current, now: new Date('2026-09-14T11:00:00.000Z') });

    const sameDay = new Date('2026-09-14T12:00:00.000Z');
    const refused = decideSourceAccess({ health: current, budgets, now: sameDay });
    expect(refused.allowed).toBe(false);
    expect(refused.refusal).toBe('DAILY_BUDGET_EXHAUSTED');

    const nextDay = new Date('2026-09-15T00:00:00.000Z');
    expect(decideSourceAccess({ health: current, budgets, now: nextDay }).allowed).toBe(true);
  });

  it('a null budget declares no limit rather than a limit of zero', () => {
    let current = health();
    for (let i = 0; i < 1000; i += 1) {
      current = spendAccess({ health: current, now: T0 });
    }
    expect(decideSourceAccess({ health: current, budgets: UNLIMITED, now: T0 }).allowed).toBe(true);
  });

  it('rolls windows on a read without spending anything', () => {
    const spent = spendAccess({ health: health(), now: T0 });
    const rolled = rollBudgets(spent, new Date('2026-09-15T00:00:00.000Z'));
    expect(rolled.hourly.spent).toBe(0);
    expect(rolled.daily.spent).toBe(0);
  });

  it('spends before the call, so a failing source still consumes its allowance', () => {
    // The publisher counts the request, not the outcome. A budget decremented on success would
    // let the source you most want to stop calling be called without limit.
    const spent = spendAccess({ health: health(), now: T0 });
    const failed = observeFailure({ health: spent, failureClass: 'RATE_LIMITED', now: T0 });
    expect(failed.hourly.spent).toBe(1);
  });
});

describe('the kill switch takes effect at the point of use (T36)', () => {
  it('refuses a source suspended after the run started', () => {
    // The run pinned this source at plan time and it was healthy then.
    const planTime = decideSourceAccess({ health: health(), budgets: UNLIMITED, now: T0 });
    expect(planTime.allowed).toBe(true);

    // An operator suspends it while the run is in flight.
    const suspended = engageKillSwitch({
      health: health(),
      reason: 'Rights violation reported by the publisher',
      engagedBy: 'ops@example.com',
      now: new Date(T0.getTime() + 1000),
    });

    const useTime = decideSourceAccess({
      health: suspended,
      budgets: UNLIMITED,
      now: new Date(T0.getTime() + 2000),
    });
    expect(useTime.allowed).toBe(false);
    expect(useTime.refusal).toBe('KILL_SWITCH_ENGAGED');
    expect(useTime.detail).toContain('Rights violation reported by the publisher');
    expect(useTime.detail).toContain('ops@example.com');
  });

  it('reports the suspension even when the breaker is open and the budget is spent', () => {
    // Three true statements; only one is the reason somebody will be asked about.
    let current = observeFailure({ health: health(), failureClass: 'HARD_BLOCK', now: T0 });
    current = spendAccess({ health: current, now: T0 });
    current = engageKillSwitch({
      health: current,
      reason: 'Licence under review',
      engagedBy: 'legal@example.com',
      now: T0,
    });

    const decision = decideSourceAccess({
      health: current,
      budgets: { hourlyBudget: 1, dailyBudget: 1 },
      now: T0,
    });
    expect(decision.refusal).toBe('KILL_SWITCH_ENGAGED');
  });

  it('treats an expired licence exactly like a kill switch', () => {
    const expired = health({ licenceExpiresAt: '2026-09-01T00:00:00.000Z' });
    const decision = decideSourceAccess({ health: expired, budgets: UNLIMITED, now: T0 });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe('LICENCE_EXPIRED');
  });

  it('refuses an unreadable licence expiry rather than assuming it is in the future', () => {
    const corrupt = health({ licenceExpiresAt: 'whenever' });
    expect(decideSourceAccess({ health: corrupt, budgets: UNLIMITED, now: T0 }).refusal).toBe(
      'LICENCE_EXPIRED',
    );
  });

  it('refuses a source whose approved version is no longer ACTIVE', () => {
    const decision = decideSourceAccess({
      health: health(),
      budgets: UNLIMITED,
      versionStatus: 'SUSPENDED',
      now: T0,
    });
    expect(decision.refusal).toBe('VERSION_NOT_ACTIVE');
  });

  it('engaging twice keeps the first record, so the original reason is not overwritten', () => {
    const first = engageKillSwitch({
      health: health(),
      reason: 'first',
      engagedBy: 'a',
      now: T0,
    });
    const second = engageKillSwitch({
      health: first,
      reason: 'second',
      engagedBy: 'b',
      now: new Date(T0.getTime() + 60_000),
    });
    expect(second.killSwitch?.reason).toBe('first');
  });

  it('releasing clears the breaker the suspension accumulated', () => {
    let current = engageKillSwitch({
      health: health(),
      reason: 'r',
      engagedBy: 'a',
      now: T0,
    });
    current = observeFailure({ health: current, failureClass: 'HARD_BLOCK', now: T0 });
    const released = releaseKillSwitch(current);
    expect(released.killSwitch).toBeNull();
    expect(released.breaker).toBe('CLOSED');
    expect(decideSourceAccess({ health: released, budgets: UNLIMITED, now: T0 }).allowed).toBe(
      true,
    );
  });
});

describe('a refusal is never a silent skip', () => {
  const shape = { sourceId: 'src-news-cr', sourceName: 'CR news', cascadeRung: 2 };

  it('produces a coverage outcome for every refusal reason', () => {
    const cases: { health: SourceHealth; budgets: SourceBudgets }[] = [
      {
        health: engageKillSwitch({ health: health(), reason: 'r', engagedBy: 'a', now: T0 }),
        budgets: UNLIMITED,
      },
      { health: health({ licenceExpiresAt: '2026-01-01T00:00:00.000Z' }), budgets: UNLIMITED },
      {
        health: observeFailure({ health: health(), failureClass: 'HARD_BLOCK', now: T0 }),
        budgets: UNLIMITED,
      },
      { health: health(), budgets: { hourlyBudget: 0, dailyBudget: null } },
      { health: health(), budgets: { hourlyBudget: null, dailyBudget: 0 } },
    ];

    for (const c of cases) {
      const decision = decideSourceAccess({ health: c.health, budgets: c.budgets, now: T0 });
      expect(decision.allowed).toBe(false);
      const outcome = accessCoverageOutcome({ decision, ...shape, queriesAffected: 4 });
      expect(outcome).not.toBeNull();
      expect(outcome?.detail).toBe(decision.detail);
      expect(outcome?.queriesAffected).toBe(4);
    }
  });

  it('distinguishes "we chose not to ask" from "we asked and it failed" from "quota"', () => {
    const suspended = decideSourceAccess({
      health: engageKillSwitch({ health: health(), reason: 'r', engagedBy: 'a', now: T0 }),
      budgets: UNLIMITED,
      now: T0,
    });
    expect(
      accessCoverageOutcome({ decision: suspended, ...shape, queriesAffected: 1 })?.outcome,
    ).toBe('SUSPENDED');

    const broken = decideSourceAccess({
      health: observeFailure({ health: health(), failureClass: 'HARD_BLOCK', now: T0 }),
      budgets: UNLIMITED,
      now: T0,
    });
    expect(accessCoverageOutcome({ decision: broken, ...shape, queriesAffected: 1 })?.outcome).toBe(
      'FAILED',
    );

    const quota = decideSourceAccess({
      health: health(),
      budgets: { hourlyBudget: 0, dailyBudget: null },
      now: T0,
    });
    const quotaOutcome = accessCoverageOutcome({ decision: quota, ...shape, queriesAffected: 1 });
    expect(quotaOutcome?.outcome).toBe('PARTIAL');
    expect(quotaOutcome?.truncation).toBe('TRUNCATED_BY_QUOTA');
  });

  it('produces nothing when access was permitted', () => {
    const allowed = decideSourceAccess({ health: health(), budgets: UNLIMITED, now: T0 });
    expect(accessCoverageOutcome({ decision: allowed, ...shape, queriesAffected: 1 })).toBeNull();
  });
});

describe('a result produced before a suspension reads as since-suspended (T36)', () => {
  const produced = '2026-09-10T00:00:00.000Z';

  it('labels a result gathered before the suspension', () => {
    const suspended = engageKillSwitch({
      health: health(),
      reason: 'Publisher withdrew permission',
      engagedBy: 'ops@example.com',
      now: T0,
    });
    const note = sinceSuspendedNote({ health: suspended, producedAt: produced, asOf: T0 });
    expect(note).toContain('before the source was suspended');
    expect(note).toContain('Publisher withdrew permission');
  });

  it('says nothing when the source is not suspended', () => {
    expect(sinceSuspendedNote({ health: health(), producedAt: produced, asOf: T0 })).toBeNull();
  });

  it('says nothing about a result that postdates the suspension', () => {
    // Such a result should not exist. Calling it "since suspended" would state something false
    // about when the data was gathered, so it says nothing at all.
    const suspended = engageKillSwitch({
      health: health(),
      reason: 'r',
      engagedBy: 'a',
      now: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect(sinceSuspendedNote({ health: suspended, producedAt: produced, asOf: T0 })).toBeNull();
  });

  it('labels an expired licence the same way', () => {
    const expired = health({ licenceExpiresAt: '2026-09-12T00:00:00.000Z' });
    const note = sinceSuspendedNote({ health: expired, producedAt: produced, asOf: T0 });
    expect(note).toContain('licence terms');
  });
});
