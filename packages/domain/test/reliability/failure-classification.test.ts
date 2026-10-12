/**
 * FR-06 — the failure classification table, and the three properties that matter most:
 * the non-retryable classes are genuinely non-retryable, `Retry-After` is honoured exactly,
 * and an unrecognised failure does not become a retry.
 */

import { describe, expect, it } from 'vitest';

import {
  backoffDelayMs,
  classifyFailure,
  failurePolicy,
  shouldRetry,
  FAILURE_CLASSES,
  NON_RETRYABLE_CLASSES,
} from '../../src/reliability/failure-classification.js';

describe('FR-06 classification', () => {
  it('classifies transient network signals', () => {
    expect(classifyFailure({ syscallCode: 'ECONNRESET' }).failureClass).toBe('TRANSIENT_NETWORK');
    expect(classifyFailure({ syscallCode: 'EAI_AGAIN' }).failureClass).toBe('TRANSIENT_NETWORK');
    for (const status of [502, 503, 504]) {
      expect(classifyFailure({ httpStatus: status }).failureClass).toBe('TRANSIENT_NETWORK');
    }
  });

  it('classifies 429 and any Retry-After as rate limited', () => {
    expect(classifyFailure({ httpStatus: 429 }).failureClass).toBe('RATE_LIMITED');
    // A 503 carrying Retry-After is the source telling us its own rate, not a network blip.
    expect(classifyFailure({ httpStatus: 503, retryAfterSeconds: 30 }).failureClass).toBe(
      'RATE_LIMITED',
    );
  });

  it('classifies a challenge, a bare 403 and an empty 200 as a soft block', () => {
    expect(classifyFailure({ httpStatus: 403 }).failureClass).toBe('SOFT_BLOCK');
    expect(classifyFailure({ challengeDetected: true }).failureClass).toBe('SOFT_BLOCK');
    expect(classifyFailure({ httpStatus: 200, emptyBody: true }).failureClass).toBe('SOFT_BLOCK');
  });

  it('escalates a 403 repeated across identities, and robots disallow, to a hard block', () => {
    const repeated = classifyFailure({ httpStatus: 403, repeatedAcrossIdentities: true });
    expect(repeated.failureClass).toBe('HARD_BLOCK');
    expect(repeated.domainAction).toBe('SUSPEND');
    expect(repeated.alertOperator).toBe(true);

    expect(classifyFailure({ robotsDisallow: true }).failureClass).toBe('HARD_BLOCK');
  });

  it('classifies our own gate refusal as a hard block, with the never-retry policy', () => {
    // Added in Phase E step 1. A URL the SEC-02 gate refused, an address we must never connect
    // to, or a robots position we could not establish. The FR-06 table's HARD_BLOCK row already
    // names "explicit refusal", so this adds a signal rather than a class — what it buys is a
    // record that says *we* refused rather than implying the publisher did.
    const policy = classifyFailure({ policyRefusal: true });
    expect(policy.failureClass).toBe('HARD_BLOCK');
    expect(policy.retryable).toBe(false);
    expect(policy.maxAttempts).toBe(1);
    // And the consequence a caller must respect: SUSPEND is why a policy refusal must never be
    // fed to a per-source breaker. One unreachable article would otherwise suspend the feed
    // that merely listed it.
    expect(policy.domainAction).toBe('SUSPEND');
  });

  it('classifies 404, 410, an unparsable body and a wrong content type as content errors', () => {
    expect(classifyFailure({ httpStatus: 404 }).failureClass).toBe('CONTENT_ERROR');
    expect(classifyFailure({ httpStatus: 410 }).failureClass).toBe('CONTENT_ERROR');
    expect(classifyFailure({ unparsableBody: true }).failureClass).toBe('CONTENT_ERROR');
    expect(classifyFailure({ unexpectedContentType: true }).failureClass).toBe('CONTENT_ERROR');
  });

  it('classifies 401 as a credential failure that alerts and never retries', () => {
    const policy = classifyFailure({ httpStatus: 401 });
    expect(policy.failureClass).toBe('AUTH_CREDENTIAL');
    expect(policy.retryable).toBe(false);
    expect(policy.alertOperator).toBe(true);
  });

  it('aborts on a size limit or redirect loop before anything else is considered', () => {
    // Even carrying signals that would otherwise mean "retry".
    const policy = classifyFailure({ limitExceeded: true, httpStatus: 503 });
    expect(policy.failureClass).toBe('OVERSIZE');
    expect(policy.retryable).toBe(false);
  });

  it('defaults an unrecognised failure to a non-retrying class', () => {
    // The dangerous default is "transient". An unknown failure retried five times against a
    // source that has quietly blocked us is worse than one lost lead and a coverage gap.
    expect(classifyFailure({}).retryable).toBe(false);
    expect(classifyFailure({ httpStatus: 418 }).retryable).toBe(false);
  });

  it('keeps exactly the four non-retryable classes the table names', () => {
    expect([...NON_RETRYABLE_CLASSES].sort()).toEqual([
      'AUTH_CREDENTIAL',
      'CONTENT_ERROR',
      'HARD_BLOCK',
      'OVERSIZE',
    ]);
  });

  it('never allows a retry of a non-retryable class, whatever the attempt count', () => {
    for (const failureClass of NON_RETRYABLE_CLASSES) {
      const policy = failurePolicy(failureClass);
      expect(shouldRetry(policy, 0)).toBe(false);
      expect(shouldRetry(policy, 1)).toBe(false);
    }
  });

  it('stops retrying a retryable class once its attempts are spent', () => {
    const policy = failurePolicy('TRANSIENT_NETWORK');
    expect(shouldRetry(policy, 4)).toBe(true);
    expect(shouldRetry(policy, 5)).toBe(false);
  });

  it('defines a policy for every declared class', () => {
    for (const failureClass of FAILURE_CLASSES) {
      expect(failurePolicy(failureClass).failureClass).toBe(failureClass);
    }
  });
});

describe('backoff', () => {
  const policy = failurePolicy('TRANSIENT_NETWORK');

  it('honours Retry-After exactly, with no jitter applied', () => {
    // random is deliberately extreme: if jitter were applied, this would not be 30000.
    expect(
      backoffDelayMs({ policy, attempt: 1, baseMs: 500, retryAfterSeconds: 30, random: 0.99 }),
    ).toBe(30_000);
    expect(
      backoffDelayMs({ policy, attempt: 4, baseMs: 500, retryAfterSeconds: 30, random: 0 }),
    ).toBe(30_000);
  });

  it('uses full jitter: the delay spans zero to the exponential ceiling', () => {
    expect(backoffDelayMs({ policy, attempt: 3, baseMs: 500, random: 0 })).toBe(0);
    // attempt 3 → 500 * 2^2 = 2000; full jitter takes [0, 2000).
    expect(backoffDelayMs({ policy, attempt: 3, baseMs: 500, random: 0.999 })).toBeLessThan(2000);
    expect(backoffDelayMs({ policy, attempt: 3, baseMs: 500, random: 0.999 })).toBeGreaterThan(
      1900,
    );
  });

  it('caps the ceiling at the class cap however many attempts have passed', () => {
    const delay = backoffDelayMs({ policy, attempt: 20, baseMs: 500, random: 0.999 });
    expect(delay).toBeLessThan(60_000);
  });
});
