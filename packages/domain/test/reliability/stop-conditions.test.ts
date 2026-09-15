/**
 * The D17 stop conditions.
 *
 * The invariant that makes it safe for a source to carry a second rule about a failure is the
 * first thing asserted here: **a stop condition can only ever stop.** It never permits a request
 * FR-06 refused, never lowers a class, never shortens a backoff. Without that property a
 * per-source override is a hole in the one failure taxonomy this service has.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyFailure,
  type FailureSignal,
} from '../../src/reliability/failure-classification.js';
import { newSourceHealth } from '../../src/reliability/source-health.js';
import {
  applyObservedFailure,
  evaluateStopConditions,
  isServerError,
  NO_STOP_CONDITIONS,
  type StopConditionPolicy,
} from '../../src/reliability/stop-conditions.js';

const T0 = new Date('2026-09-15T12:00:00.000Z');

/** The conditions D17 recorded for the SEC, in the domain's own vocabulary. */
const SEC: StopConditionPolicy = {
  haltOnStatuses: [403],
  haltOnRateLimit: true,
  rateLimitCooldownMs: 10 * 60_000,
  serverErrorStreakToHalt: 3,
  requiresFreshApprovalOnHalt: true,
};

function verdict(
  signal: FailureSignal,
  streak = 0,
  conditions = SEC,
): ReturnType<typeof evaluateStopConditions> {
  return evaluateStopConditions({ signal, conditions, consecutiveServerErrors: streak });
}

describe('a stop condition can only ever stop', () => {
  it('never changes the FR-06 classification, on any signal', () => {
    const signals: FailureSignal[] = [
      { httpStatus: 403 },
      { httpStatus: 429, retryAfterSeconds: 30 },
      { httpStatus: 503 },
      { httpStatus: 404 },
      { httpStatus: 200, emptyBody: true },
      { syscallCode: 'ECONNRESET' },
      { limitExceeded: true },
      { robotsDisallow: true },
      { policyRefusal: true },
      { unparsableBody: true },
      { challengeDetected: true },
      { httpStatus: 401 },
    ];

    for (const signal of signals) {
      expect(verdict(signal).policy).toEqual(classifyFailure(signal));
      // And with no conditions recorded, FR-06 stands exactly as written.
      expect(verdict(signal, 0, NO_STOP_CONDITIONS).halt).toBe(false);
    }
  });

  it('never halts on a refusal of our own making', () => {
    // A robots disallow and an SSRF refusal are our decision not to ask, not the publisher
    // doing anything. Halting a source over one would be recording our decision as their
    // refusal — the same rule as D-035, one layer along.
    expect(verdict({ robotsDisallow: true }).halt).toBe(false);
    expect(verdict({ policyRefusal: true }).halt).toBe(false);
  });
});

describe('403 halts and requires fresh approval', () => {
  it('halts, where FR-06 alone would have retried once from another identity', () => {
    // The escalation D17 recorded: the SEC's policy says a 403 means the user agent is wrong,
    // so retrying is repeating the thing they asked us not to do.
    expect(classifyFailure({ httpStatus: 403 }).retryable).toBe(true);

    const result = verdict({ httpStatus: 403 });
    expect(result.halt).toBe(true);
    expect(result.reason).toBe('HALT_ON_STATUS');
    expect(result.requiresFreshApproval).toBe(true);
    expect(result.detail).toContain('403');
  });

  it('does not halt a source whose approver recorded no such condition', () => {
    expect(verdict({ httpStatus: 403 }, 0, NO_STOP_CONDITIONS).halt).toBe(false);
  });
});

describe('429 halts after its cooldown, honoured in full', () => {
  it('uses the publisher-stated Retry-After rather than our own number', () => {
    const result = verdict({ httpStatus: 429, retryAfterSeconds: 45 });
    expect(result.halt).toBe(true);
    expect(result.reason).toBe('HALT_ON_RATE_LIMIT');
    expect(result.cooldownMs).toBe(45_000);
  });

  it('falls back to the recorded cooldown when the publisher named none', () => {
    expect(verdict({ httpStatus: 429 }).cooldownMs).toBe(10 * 60_000);
  });

  it('treats a bare Retry-After as a rate limit, as FR-06 does', () => {
    expect(verdict({ retryAfterSeconds: 5 }).reason).toBe('HALT_ON_RATE_LIMIT');
  });
});

describe('a server-error streak halts', () => {
  it('does not halt below the recorded limit', () => {
    expect(verdict({ httpStatus: 503 }, 2).halt).toBe(false);
  });

  it('halts at the recorded limit', () => {
    const result = verdict({ httpStatus: 503 }, 3);
    expect(result.halt).toBe(true);
    expect(result.reason).toBe('HALT_ON_SERVER_ERROR_STREAK');
  });

  it('counts the statuses `isServerError` names, and nothing else', () => {
    expect(isServerError({ httpStatus: 503 })).toBe(true);
    expect(isServerError({ httpStatus: 500 })).toBe(true);
    expect(isServerError({ httpStatus: 404 })).toBe(false);
    expect(isServerError({ syscallCode: 'ECONNRESET' })).toBe(false);
  });
});

describe('applyObservedFailure — the composition the service and the harness share', () => {
  const health = newSourceHealth({
    sourceId: 'sec-litigation-releases',
    observedVersion: 1,
    now: T0,
  });

  it('folds the failure into health before it halts, so the record is not left claiming health', () => {
    const applied = applyObservedFailure({
      health,
      signal: { httpStatus: 403 },
      conditions: SEC,
      consecutiveServerErrors: 0,
      now: T0,
      haltedBy: 'system',
    });

    expect(applied.halted).toBe(true);
    expect(applied.failureClass).toBe('SOFT_BLOCK');
    // The failure is on the record as well as the halt. Releasing the halt must not release a
    // source whose stored state says nothing ever went wrong.
    expect(applied.health.lastFailureClass).toBe('SOFT_BLOCK');
    expect(applied.health.killSwitch?.engagedBy).toBe('system');
    expect(applied.health.killSwitch?.reason).toContain('a different authorised person');
  });

  it('keeps the streak across failures and resets it on anything else', () => {
    const first = applyObservedFailure({
      health,
      signal: { httpStatus: 503 },
      conditions: SEC,
      consecutiveServerErrors: 0,
      now: T0,
      haltedBy: 'system',
    });
    expect(first.consecutiveServerErrors).toBe(1);
    expect(first.halted).toBe(false);

    const reset = applyObservedFailure({
      health: first.health,
      signal: { httpStatus: 404 },
      conditions: SEC,
      consecutiveServerErrors: first.consecutiveServerErrors,
      now: T0,
      haltedBy: 'system',
    });
    expect(reset.consecutiveServerErrors).toBe(0);
  });

  it('does not re-engage a kill switch that is already engaged', () => {
    const halted = applyObservedFailure({
      health,
      signal: { httpStatus: 403 },
      conditions: SEC,
      consecutiveServerErrors: 0,
      now: T0,
      haltedBy: 'system',
    });
    const again = applyObservedFailure({
      health: halted.health,
      signal: { httpStatus: 403 },
      conditions: SEC,
      consecutiveServerErrors: 0,
      now: new Date(T0.getTime() + 60_000),
      haltedBy: 'somebody-else',
    });
    expect(again.halted).toBe(false);
    expect(again.health.killSwitch?.engagedAt).toBe(halted.health.killSwitch?.engagedAt);
  });

  it('leaves a source with no recorded conditions exactly as FR-06 leaves it', () => {
    const applied = applyObservedFailure({
      health,
      signal: { httpStatus: 403 },
      conditions: NO_STOP_CONDITIONS,
      consecutiveServerErrors: 0,
      now: T0,
      haltedBy: 'system',
    });
    expect(applied.halted).toBe(false);
    expect(applied.health.killSwitch).toBeNull();
  });
});
