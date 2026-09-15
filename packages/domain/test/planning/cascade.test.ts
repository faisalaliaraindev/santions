/**
 * The FR-05 discovery cascade.
 *
 * Two things carry the weight, and both are about not overstating what was searched:
 *
 * 1. **A source that answered "nothing" is not a gap. A rung with nothing behind it is.**
 *    Collapsing those is how "we did not look" becomes "there is nothing there".
 * 2. **The ladder is walked in full**, because axis D grants `CORROBORATED` on two independent
 *    Tier 2–3 sources and a first-hit-wins cascade would make that unreachable.
 */

import { describe, expect, it } from 'vitest';

import {
  CASCADE_RUNGS,
  TERMINAL_RUNG,
  cascadeCoverageOutcomes,
  describeAttempt,
  isGap,
  nextRung,
  rungSpec,
  summariseCascade,
  type CascadeRung,
  type RungAttempt,
  type RungOutcome,
} from '../../src/planning/cascade.js';

function attempt(
  rung: CascadeRung,
  outcome: RungOutcome,
  overrides: Partial<RungAttempt> = {},
): RungAttempt {
  return {
    rung,
    sourceId: outcome === 'NO_SOURCE' ? null : `src-rung-${String(rung)}`,
    sourceName: outcome === 'NO_SOURCE' ? `rung ${String(rung)}` : `Source at rung ${String(rung)}`,
    outcome,
    candidates: outcome === 'FOUND' ? 3 : 0,
    detail: outcome === 'FAILED' ? 'the source timed out' : null,
    queriesAffected: 4,
    ...overrides,
  };
}

describe('the table is FR-05, as written', () => {
  it('has eight rungs, with the last one the terminus', () => {
    expect(CASCADE_RUNGS).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(TERMINAL_RUNG).toBe(7);
    expect(rungSpec(7).onFailure).toBe('TERMINUS');
  });

  it('marks rung 0 always available — a local index cannot be unreachable', () => {
    expect(rungSpec(0).onFailure).toBe('ALWAYS_AVAILABLE');
  });

  it('retries rung 2 once, and only rung 2', () => {
    // "Cool down the egress identity, retry once, descend." No other rung says retry.
    expect(rungSpec(2).retryOnce).toBe(true);
    for (const rung of CASCADE_RUNGS.filter((r) => r !== 2)) {
      expect(rungSpec(rung).retryOnce, `rung ${String(rung)} must not retry`).toBe(false);
    }
  });

  it('stops the ladder at rung 6, and nowhere else below the terminus', () => {
    // "Record and stop" — the one rung whose failure ends the walk rather than descending.
    expect(rungSpec(6).stopsCascade).toBe(true);
    for (const rung of CASCADE_RUNGS.filter((r) => r !== 6 && r !== 7)) {
      expect(rungSpec(rung).stopsCascade, `rung ${String(rung)} must descend`).toBe(false);
    }
  });
});

describe('descending', () => {
  it('descends past a failure at every rung the table says descend', () => {
    for (const rung of [0, 1, 2, 3, 4, 5] as CascadeRung[]) {
      expect(nextRung({ current: rung, failed: true })).toBe(rung + 1);
    }
  });

  it('stops after a failure at rung 6', () => {
    expect(nextRung({ current: 6, failed: true })).toBeNull();
  });

  it('still reaches the terminus when rung 6 succeeds', () => {
    expect(nextRung({ current: 6, failed: false })).toBe(7);
  });

  it('ends at the terminus', () => {
    expect(nextRung({ current: 7, failed: false })).toBeNull();
  });

  it('keeps climbing after a rung that found something', () => {
    // The load-bearing one. If this returned null, axis D could never see two independent
    // sources, and CORROBORATED would be a band the engine can define and never award.
    expect(nextRung({ current: 2, failed: false })).toBe(3);
  });
});

describe('what counts as a gap', () => {
  it('does not count a source that answered with nothing', () => {
    expect(isGap('EMPTY')).toBe(false);
    expect(isGap('FOUND')).toBe(false);
  });

  it('counts a failure, a refusal, and a rung with no source at all', () => {
    expect(isGap('FAILED')).toBe(true);
    expect(isGap('REFUSED')).toBe(true);
    // The one most easily missed: nothing was asked, so nothing was searched.
    expect(isGap('NO_SOURCE')).toBe(true);
  });
});

describe('summarising a walk', () => {
  it('reports complete when every rung answered, empty or not', () => {
    const summary = summariseCascade([
      attempt(0, 'EMPTY'),
      attempt(1, 'FOUND'),
      attempt(2, 'EMPTY'),
    ]);
    expect(summary.complete).toBe(true);
    expect(summary.gaps).toHaveLength(0);
    expect(summary.candidates).toBe(3);
    expect(summary.rungReached).toBe(2);
  });

  it('reports incomplete when a rung has no source behind it', () => {
    // A one-source deployment must not be able to claim it climbed the whole ladder.
    const summary = summariseCascade([attempt(0, 'FOUND'), attempt(3, 'NO_SOURCE')]);
    expect(summary.complete).toBe(false);
    expect(summary.gaps).toHaveLength(1);
    expect(summary.gaps[0]?.rung).toBe(3);
  });

  it('reports incomplete when a rung was refused before being asked', () => {
    const summary = summariseCascade([attempt(0, 'FOUND'), attempt(2, 'REFUSED')]);
    expect(summary.complete).toBe(false);
  });

  it('records that the walk stopped early when rung 6 failed', () => {
    const summary = summariseCascade([attempt(5, 'EMPTY'), attempt(6, 'FAILED')]);
    expect(summary.stoppedEarly).toBe(true);
  });

  it('does not call an unattempted ladder complete', () => {
    // Nothing attempted is not the same as rung 0 answering with nothing, and a run that
    // dispatched no discovery at all must not read as one that searched and found nothing.
    const summary = summariseCascade([]);
    expect(summary.rungReached).toBeNull();
    expect(summary.complete).toBe(false);
  });
});

describe('coverage outcomes', () => {
  it('names every gap and stays silent about every non-gap', () => {
    const outcomes = cascadeCoverageOutcomes([
      attempt(0, 'FOUND'),
      attempt(1, 'EMPTY'),
      attempt(2, 'FAILED'),
      attempt(3, 'NO_SOURCE'),
    ]);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.cascadeRung)).toEqual([2, 3]);
  });

  it('distinguishes asked-and-unanswered from never-asked', () => {
    const outcomes = cascadeCoverageOutcomes([attempt(2, 'FAILED'), attempt(3, 'NO_SOURCE')]);

    // FAILED: we asked and were not answered.
    expect(outcomes[0]?.outcome).toBe('FAILED');
    // SKIPPED: we had nobody to ask. Reporting this as FAILED would send somebody to
    // investigate an outage at a publisher that is working perfectly.
    expect(outcomes[1]?.outcome).toBe('SKIPPED');
  });

  it('always carries a detail a reviewer can read, even when the caller gave none', () => {
    const outcomes = cascadeCoverageOutcomes([attempt(3, 'NO_SOURCE', { detail: null })]);
    expect(outcomes[0]?.detail).toContain('No approved source answers at rung 3');
    expect(outcomes[0]?.detail).toContain('not searched');
  });

  it('carries how many queries the gap cost', () => {
    const outcomes = cascadeCoverageOutcomes([attempt(4, 'FAILED', { queriesAffected: 11 })]);
    expect(outcomes[0]?.queriesAffected).toBe(11);
  });
});

describe('the per-rung log FR-05 requires', () => {
  it('says plainly that an empty answer is not a gap', () => {
    expect(describeAttempt(attempt(1, 'EMPTY'))).toContain('Not a gap');
  });

  it('says plainly that an unsourced rung was not searched', () => {
    expect(describeAttempt(attempt(3, 'NO_SOURCE'))).toContain('Not searched');
  });

  it('names the rung and its source on every line', () => {
    for (const outcome of ['FOUND', 'EMPTY', 'FAILED', 'REFUSED', 'NO_SOURCE'] as RungOutcome[]) {
      const line = describeAttempt(attempt(2, outcome));
      expect(line, outcome).toContain('rung 2');
      expect(line, outcome).toContain('Google News RSS');
    }
  });
});
