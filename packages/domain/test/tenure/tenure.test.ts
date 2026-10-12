/** FR-02 / FR-09 tenure labelling. Test T15 — all five labels. */

import { describe, expect, it } from 'vitest';

import {
  TENURE_LABELS,
  isConfirmedCurrent,
  labelTenure,
  type PreciseDate,
  type Tenure,
} from '../../src/tenure/tenure.js';

const day = (value: string): PreciseDate => ({ value, precision: 'DAY' });
const year = (value: string): PreciseDate => ({ value, precision: 'YEAR' });
const unknown: PreciseDate = { value: null, precision: 'UNKNOWN' };

const point = (d: PreciseDate) => ({ start: d, end: d });

describe('labelTenure — T15', () => {
  const tenure: Tenure = { appointedOn: day('2018-01-01'), resignedOn: day('2022-06-30') };

  it('labels an event inside the tenure DURING_TENURE', () => {
    expect(labelTenure(tenure, point(day('2020-04-15')))).toBe('DURING_TENURE');
  });

  it('labels an event before the appointment BEFORE_TENURE', () => {
    expect(labelTenure(tenure, point(day('2016-09-01')))).toBe('BEFORE_TENURE');
  });

  it('labels an event after the resignation AFTER_TENURE', () => {
    expect(labelTenure(tenure, point(day('2024-01-10')))).toBe('AFTER_TENURE');
  });

  it('labels an event crossing a tenure boundary SPANNING', () => {
    expect(labelTenure(tenure, { start: day('2017-06-01'), end: day('2019-06-01') })).toBe(
      'SPANNING',
    );
    expect(labelTenure(tenure, { start: day('2021-06-01'), end: day('2023-06-01') })).toBe(
      'SPANNING',
    );
  });

  it('returns UNKNOWN when the appointment date is unknown', () => {
    expect(
      labelTenure(
        { appointedOn: unknown, resignedOn: day('2022-06-30') },
        point(day('2020-01-01')),
      ),
    ).toBe('UNKNOWN');
  });

  it('returns UNKNOWN when the event date is unknown', () => {
    expect(labelTenure(tenure, point(unknown))).toBe('UNKNOWN');
  });

  it('an unknown end date never proves current status', () => {
    const openEnded: Tenure = { appointedOn: day('2018-01-01'), resignedOn: unknown };
    // The event is after the appointment, so DURING is supportable...
    expect(labelTenure(openEnded, point(day('2020-04-15')))).toBe('DURING_TENURE');
    // ...but an event before it is still BEFORE, not DURING.
    expect(labelTenure(openEnded, point(day('2016-01-01')))).toBe('BEFORE_TENURE');
  });

  it('respects coarse date precision rather than assuming 1 January', () => {
    const coarse: Tenure = { appointedOn: year('2018-01-01'), resignedOn: year('2022-01-01') };
    // An event in mid-2018 cannot be proven to fall inside a YEAR-precision appointment.
    expect(labelTenure(coarse, point(day('2018-03-01')))).toBe('SPANNING');
    // An event well inside the window is unambiguous.
    expect(labelTenure(coarse, point(day('2020-03-01')))).toBe('DURING_TENURE');
  });

  it('only ever returns one of the five declared labels', () => {
    const cases: Tenure[] = [
      tenure,
      { appointedOn: unknown, resignedOn: unknown },
      { appointedOn: year('2018-01-01'), resignedOn: unknown },
    ];
    for (const t of cases) {
      for (const d of [day('2015-01-01'), day('2020-01-01'), day('2030-01-01'), unknown]) {
        expect(TENURE_LABELS).toContain(labelTenure(t, point(d)));
      }
    }
  });

  it('returns UNKNOWN for an unparsable date rather than throwing', () => {
    expect(
      labelTenure(
        { appointedOn: day('not-a-date'), resignedOn: unknown },
        point(day('2020-01-01')),
      ),
    ).toBe('UNKNOWN');
  });
});

describe('isConfirmedCurrent', () => {
  const asOf = day('2026-09-10');

  it('confirms an appointment with no recorded resignation', () => {
    expect(isConfirmedCurrent({ appointedOn: day('2018-01-01'), resignedOn: unknown }, asOf)).toBe(
      true,
    );
  });

  it('rejects a directorship that ended in the past', () => {
    expect(
      isConfirmedCurrent({ appointedOn: day('2018-01-01'), resignedOn: day('2022-06-30') }, asOf),
    ).toBe(false);
  });

  it('rejects an appointment that has not started', () => {
    expect(isConfirmedCurrent({ appointedOn: day('2027-01-01'), resignedOn: unknown }, asOf)).toBe(
      false,
    );
  });

  it('rejects when the appointment date is unknown', () => {
    expect(isConfirmedCurrent({ appointedOn: unknown, resignedOn: unknown }, asOf)).toBe(false);
  });
});
