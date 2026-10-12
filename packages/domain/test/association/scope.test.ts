/**
 * FR-02 scope — which directorships a search looks at, and what may be claimed about each.
 *
 * The first `describe` is the one the Phase D brief asks for by name: the unknown end date gets
 * its own test rather than a branch inside a bigger one, because attaching a company event to
 * someone who had already left is the single most common way this goes wrong.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyCurrency,
  describeCurrency,
  edgeInScope,
  labelTenure,
  requiresApprovedHistoricalScope,
  type PreciseDate,
  type Tenure,
} from '../../src/index.js';

const ASOF: PreciseDate = { value: '2026-09-14', precision: 'DAY' };
const NO_DATE: PreciseDate = { value: null, precision: 'UNKNOWN' };

function tenure(appointed: PreciseDate, resigned: PreciseDate = NO_DATE): Tenure {
  return { appointedOn: appointed, resignedOn: resigned };
}

describe('an unknown end date never proves current status (FR-02)', () => {
  const silent = tenure({ value: '2019-01-10', precision: 'DAY' });

  it('is never reported as confirmed, however long ago the appointment was', () => {
    expect(classifyCurrency(silent, ASOF)).toBe('CURRENT_PER_REGISTER_SILENCE');
    expect(classifyCurrency(silent, ASOF)).not.toBe('CURRENT_CONFIRMED');
  });

  it('says so in the words a reviewer reads, not only in an enum', () => {
    expect(describeCurrency('CURRENT_PER_REGISTER_SILENCE')).toMatch(/not confirmed/i);
    expect(describeCurrency('CURRENT_CONFIRMED')).not.toMatch(/not confirmed/i);
  });

  it('cannot carry an event as DURING_TENURE when the appointment is too coarse to tell', () => {
    // The proof half of the rule, enforced where it bites. A year-precision appointment with no
    // resignation, and an event inside that same year: the event may precede the appointment by
    // months, so the answer is UNKNOWN and not DURING_TENURE.
    const coarse = tenure({ value: '2019-01-01', precision: 'YEAR' });
    expect(
      labelTenure(coarse, {
        start: { value: '2019-07-01', precision: 'DAY' },
        end: { value: '2019-07-01', precision: 'DAY' },
      }),
    ).toBe('UNKNOWN');
  });

  it('does carry an event that is unambiguously after a precise appointment', () => {
    expect(
      labelTenure(silent, {
        start: { value: '2021-05-02', precision: 'DAY' },
        end: { value: '2021-05-02', precision: 'DAY' },
      }),
    ).toBe('DURING_TENURE');
  });

  it('is still searched, because excluding it would search nothing at all', () => {
    // Registers almost never publish an end date for a serving officer: absence is how they say
    // "still serving". Excluding every silent edge would make the default scope empty against
    // most registers — a clean-looking result produced by not looking. Decision D-024.
    const decision = edgeInScope(silent, 'CURRENT_ONLY', ASOF);
    expect(decision.included).toBe(true);
    expect(decision.currency).toBe('CURRENT_PER_REGISTER_SILENCE');
    expect(decision.reason).toMatch(/never reported as confirmed/i);
  });
});

describe('classifying currency', () => {
  it('confirms a directorship whose recorded end date has not arrived', () => {
    expect(
      classifyCurrency(
        tenure(
          { value: '2015-01-15', precision: 'DAY' },
          { value: '2030-06-30', precision: 'DAY' },
        ),
        ASOF,
      ),
    ).toBe('CURRENT_CONFIRMED');
  });

  it('calls a passed resignation FORMER', () => {
    expect(
      classifyCurrency(
        tenure(
          { value: '2010-01-05', precision: 'DAY' },
          { value: '2012-12-31', precision: 'DAY' },
        ),
        ASOF,
      ),
    ).toBe('FORMER');
  });

  it('calls a missing appointment date UNKNOWN, not former and not current', () => {
    expect(classifyCurrency(tenure(NO_DATE), ASOF)).toBe('UNKNOWN');
  });

  it('keeps the four states genuinely distinct', () => {
    const states = new Set([
      classifyCurrency(
        tenure(
          { value: '2015-01-15', precision: 'DAY' },
          { value: '2030-06-30', precision: 'DAY' },
        ),
        ASOF,
      ),
      classifyCurrency(tenure({ value: '2019-01-10', precision: 'DAY' }), ASOF),
      classifyCurrency(
        tenure(
          { value: '2010-01-05', precision: 'DAY' },
          { value: '2012-12-31', precision: 'DAY' },
        ),
        ASOF,
      ),
      classifyCurrency(tenure(NO_DATE), ASOF),
    ]);
    expect(states.size).toBe(4);
  });
});

describe('the default scope', () => {
  it('omits a former directorship, and says why', () => {
    const decision = edgeInScope(
      tenure({ value: '2010-01-05', precision: 'DAY' }, { value: '2012-12-31', precision: 'DAY' }),
      'CURRENT_ONLY',
      ASOF,
    );
    expect(decision.included).toBe(false);
    expect(decision.reason).toMatch(/approved historical scope/i);
  });

  it('omits an unestablished directorship rather than guessing', () => {
    const decision = edgeInScope(tenure(NO_DATE), 'CURRENT_ONLY', ASOF);
    expect(decision.included).toBe(false);
    expect(decision.reason).toMatch(/never proves current status/i);
  });

  it('never omits anything without a reason a reviewer can read', () => {
    const cases: Tenure[] = [
      tenure(NO_DATE),
      tenure({ value: '2010-01-05', precision: 'DAY' }, { value: '2012-12-31', precision: 'DAY' }),
      tenure({ value: '2019-01-10', precision: 'DAY' }),
    ];
    for (const t of cases) {
      expect(edgeInScope(t, 'CURRENT_ONLY', ASOF).reason.length).toBeGreaterThan(20);
    }
  });
});

describe('the historical scope', () => {
  it('includes former and unestablished directorships once approved', () => {
    const former = tenure(
      { value: '2010-01-05', precision: 'DAY' },
      { value: '2012-12-31', precision: 'DAY' },
    );
    expect(edgeInScope(former, 'INCLUDE_FORMER', ASOF).included).toBe(true);
    expect(edgeInScope(tenure(NO_DATE), 'INCLUDE_FORMER', ASOF).included).toBe(true);
  });

  it('still labels each edge with its own currency rather than calling them all current', () => {
    const former = tenure(
      { value: '2010-01-05', precision: 'DAY' },
      { value: '2012-12-31', precision: 'DAY' },
    );
    expect(edgeInScope(former, 'INCLUDE_FORMER', ASOF).currency).toBe('FORMER');
  });

  it('is the only scope that needs an approval', () => {
    expect(requiresApprovedHistoricalScope('INCLUDE_FORMER')).toBe(true);
    expect(requiresApprovedHistoricalScope('CURRENT_ONLY')).toBe(false);
  });
});
