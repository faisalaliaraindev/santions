/**
 * The per-domain breaker — decision **D-040**.
 *
 * Two properties carry the weight here, and both are about not confusing a publisher with an
 * agreement:
 *
 * 1. A `SUSPEND` is **sticky**. It does not expire on a clock, because nothing about time
 *    passing answers the question a hard block raises. Only an operator releases it.
 * 2. A `DEGRADE` expires, on the **publisher's** clock where they gave one, and a success does
 *    not cancel it.
 *
 * And the rule that keeps the two breakers from arguing: neither invents a taxonomy. Every
 * decision below is read off FR-06's policy table.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DOMAIN_BREAKER_CONFIG,
  decideDomainAccess,
  domainBreakerAt,
  newDomainHealth,
  observeDomainFailure,
  observeDomainSuccess,
  releaseDomainSuspension,
  spendDomainProbe,
  suspendDomain,
  type DomainHealth,
} from '../../src/reliability/domain-health.js';

const T0 = new Date('2026-09-15T12:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

function fresh(): DomainHealth {
  return newDomainHealth({ domain: 'example.com' });
}

function fail(
  health: DomainHealth,
  failureClass: Parameters<typeof observeDomainFailure>[0]['failureClass'],
  now: Date,
  retryAfterSeconds?: number,
): DomainHealth {
  return observeDomainFailure({
    health,
    failureClass,
    detail: `observed ${failureClass}`,
    now,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}

describe('a hard block suspends the publisher', () => {
  it('suspends on the first occurrence and names what happened', () => {
    const health = fail(fresh(), 'HARD_BLOCK', T0);
    expect(health.suspension?.failureClass).toBe('HARD_BLOCK');
    expect(health.suspension?.suspendedBy).toBe('SYSTEM');
    expect(health.breaker).toBe('OPEN');
  });

  it('does not expire on a cooldown, however long', () => {
    // The difference between SUSPEND and DEGRADE. A suspended domain that cooled into a probe
    // would make FR-06's "do not retry, alert an operator" into "retry in five minutes".
    const health = fail(fresh(), 'HARD_BLOCK', T0);
    const later = domainBreakerAt(health, at(365 * 24 * 60 * 60_000));
    expect(later.breaker).toBe('OPEN');
    expect(decideDomainAccess({ health: later, now: at(365 * 24 * 60 * 60_000) }).refusal).toBe(
      'DOMAIN_SUSPENDED',
    );
  });

  it('keeps the first suspension when it happens again', () => {
    // The first one is the one an operator was alerted about. Overwriting its timestamp makes
    // the alert and the record disagree about when the publisher refused us.
    const first = fail(fresh(), 'HARD_BLOCK', T0);
    const again = fail(first, 'HARD_BLOCK', at(60_000));
    expect(again.suspension?.at).toBe(first.suspension?.at);
  });

  it('is released by an operator, which resets the breaker with it', () => {
    const released = releaseDomainSuspension(fail(fresh(), 'HARD_BLOCK', T0));
    expect(released.suspension).toBeNull();
    expect(released.breaker).toBe('CLOSED');
    expect(released.consecutiveFailures).toBe(0);
    expect(decideDomainAccess({ health: released, now: at(1) }).allowed).toBe(true);
  });
});

describe('a soft block or a rate limit degrades the publisher', () => {
  it('honours Retry-After exactly rather than substituting our own number', () => {
    const health = fail(fresh(), 'RATE_LIMITED', T0, 30);
    expect(health.degradedUntil).toBe(at(30_000).toISOString());
  });

  it('applies the configured cooldown when the publisher named none', () => {
    const health = fail(fresh(), 'RATE_LIMITED', T0);
    expect(health.degradedUntil).toBe(
      at(DEFAULT_DOMAIN_BREAKER_CONFIG.degradeCooldownMs).toISOString(),
    );
  });

  it('never shortens a cooldown already in force', () => {
    // A long Retry-After followed by a short one must not let the short one win: the publisher
    // asked for the longer wait and nothing since has withdrawn it.
    const long = fail(fresh(), 'RATE_LIMITED', T0, 600);
    const short = fail(long, 'RATE_LIMITED', at(1_000), 5);
    expect(short.degradedUntil).toBe(at(600_000).toISOString());
  });

  it('refuses while cooling and permits once the cooldown has passed', () => {
    const health = fail(fresh(), 'RATE_LIMITED', T0, 30);
    expect(decideDomainAccess({ health, now: at(29_000) }).refusal).toBe('DOMAIN_COOLING');
    expect(decideDomainAccess({ health, now: at(31_000) }).allowed).toBe(true);
  });

  it('is not cancelled by a success that slipped through', () => {
    // The breaker asks "is this host answering?", which one success settles. `degradedUntil` is
    // a wait the publisher asked for, and one request getting through does not withdraw it.
    const health = observeDomainSuccess({
      health: fail(fresh(), 'RATE_LIMITED', T0, 300),
      now: at(1),
    });
    expect(health.breaker).toBe('CLOSED');
    expect(decideDomainAccess({ health, now: at(2) }).refusal).toBe('DOMAIN_COOLING');
  });
});

describe('the breaker counts only what FR-06 says is about the source', () => {
  it('opens after three qualifying failures', () => {
    let health = fresh();
    for (let i = 0; i < 3; i += 1) {
      health = fail(health, 'TRANSIENT_NETWORK', at(i * 1_000));
    }
    expect(health.breaker).toBe('OPEN');
    expect(decideDomainAccess({ health, now: at(3_000) }).refusal).toBe('DOMAIN_BREAKER_OPEN');
  });

  it('does not count a fact about one document', () => {
    // A 404 or an oversized PDF says nothing about the publisher, and a breaker that counted
    // them would open on a source that is working perfectly.
    let health = fresh();
    for (let i = 0; i < 5; i += 1) {
      health = fail(health, 'CONTENT_ERROR', at(i * 1_000));
    }
    expect(health.breaker).toBe('CLOSED');
    expect(health.consecutiveFailures).toBe(0);
  });

  it('cools into a half-open probe, and one failed probe reopens it', () => {
    let health = fresh();
    for (let i = 0; i < 3; i += 1) {
      health = fail(health, 'TRANSIENT_NETWORK', at(i * 1_000));
    }
    // The breaker opened on the *third* failure, so the cooldown runs from that instant.
    const cooled = domainBreakerAt(
      health,
      at(2_000 + DEFAULT_DOMAIN_BREAKER_CONFIG.openDurationMs + 1),
    );
    expect(cooled.breaker).toBe('HALF_OPEN');

    const spent = spendDomainProbe(cooled);
    expect(decideDomainAccess({ health: spent, now: at(400_000) }).refusal).toBe(
      'DOMAIN_BREAKER_OPEN',
    );

    const probeFailed = fail(cooled, 'TRANSIENT_NETWORK', at(400_000));
    expect(probeFailed.breaker).toBe('OPEN');
  });

  it('closes on a success', () => {
    let health = fresh();
    for (let i = 0; i < 3; i += 1) {
      health = fail(health, 'TRANSIENT_NETWORK', at(i * 1_000));
    }
    const recovered = observeDomainSuccess({ health, now: at(10_000) });
    expect(recovered.breaker).toBe('CLOSED');
    expect(decideDomainAccess({ health: recovered, now: at(10_001) }).allowed).toBe(true);
  });

  it('treats an unparsable openedAt as just-opened rather than long-expired', () => {
    const corrupt: DomainHealth = { ...fresh(), breaker: 'OPEN', openedAt: 'not a date' };
    expect(domainBreakerAt(corrupt, at(10 ** 9)).breaker).toBe('OPEN');
  });
});

describe('the order of refusals', () => {
  it('reports a suspension even when the domain is also cooling and also broken', () => {
    // Three different things to tell an operator, and only the first is one somebody will be
    // asked about.
    let health = fail(fresh(), 'RATE_LIMITED', T0, 600);
    health = fail(health, 'TRANSIENT_NETWORK', at(1));
    health = fail(health, 'TRANSIENT_NETWORK', at(2));
    health = fail(health, 'TRANSIENT_NETWORK', at(3));
    health = fail(health, 'HARD_BLOCK', at(4));

    const decision = decideDomainAccess({ health, now: at(5) });
    expect(decision.refusal).toBe('DOMAIN_SUSPENDED');
    expect(decision.detail).toContain('example.com');
  });
});

describe('an operator suspending by hand', () => {
  it('takes effect immediately and records who did it', () => {
    const health = suspendDomain({
      health: fresh(),
      reason: 'The publisher emailed and asked us to stop.',
      suspendedBy: 'faisal@erlystage.com',
      now: T0,
    });
    expect(health.suspension?.suspendedBy).toBe('faisal@erlystage.com');
    expect(decideDomainAccess({ health, now: at(1) }).refusal).toBe('DOMAIN_SUSPENDED');
  });

  it('is idempotent, keeping the first record', () => {
    const first = suspendDomain({
      health: fresh(),
      reason: 'first',
      suspendedBy: 'a',
      now: T0,
    });
    const second = suspendDomain({
      health: first,
      reason: 'second',
      suspendedBy: 'b',
      now: at(1_000),
    });
    expect(second.suspension?.detail).toBe('first');
  });
});
