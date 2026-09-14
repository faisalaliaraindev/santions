import { describe, expect, it } from 'vitest';

import { assignDeciles, describeMissingNameFrequency, type NameCount } from '../../src/index.js';

/**
 * A distribution shaped like a real one: a few very common names and a long tail of rare ones.
 * The tail is what breaks a rank-based decile scheme, so the fixture has one.
 */
const REALISTIC: readonly NameCount[] = [
  { nameKey: 'rodriguez', count: 500 },
  { nameKey: 'gonzalez', count: 300 },
  { nameKey: 'jimenez', count: 100 },
  ...Array.from({ length: 200 }, (_, i) => ({ nameKey: `rare${String(i)}`, count: 1 })),
];

describe('deciles are drawn on population mass, not on the surname ranking', () => {
  it('puts the most common name in decile 10', () => {
    const deciles = assignDeciles(REALISTIC);
    expect(deciles.find((d) => d.nameKey === 'rodriguez')?.decile).toBe(10);
  });

  it('does not place a long tail of unique names in the same band as a common one', () => {
    const deciles = assignDeciles(REALISTIC);
    const rare = deciles.filter((d) => d.nameKey.startsWith('rare'));
    expect(rare.every((d) => d.decile < 10)).toBe(true);
    // The point of the whole scheme: a rank-based split would have put the first ~20 of these
    // 200 unique names into the top decile alongside "rodriguez".
    expect(rare.some((d) => d.decile <= 2)).toBe(true);
  });

  it('is deterministic, including across ties', () => {
    const shuffled = [...REALISTIC].toReversed();
    expect(assignDeciles(shuffled)).toEqual(assignDeciles(REALISTIC));
  });

  it('keeps every decile within 1..10', () => {
    for (const entry of assignDeciles(REALISTIC)) {
      expect(entry.decile).toBeGreaterThanOrEqual(1);
      expect(entry.decile).toBeLessThanOrEqual(10);
    }
  });

  it('never gives a rarer name a higher decile than a more common one', () => {
    // Monotonicity. Without it a distribution dominated by one enormous surname produces a
    // decile ordering that disagrees with the counts it was derived from.
    const deciles = assignDeciles(REALISTIC);
    for (let i = 1; i < deciles.length; i += 1) {
      const previous = deciles[i - 1];
      const current = deciles[i];
      if (previous === undefined || current === undefined) {
        throw new Error('unexpected gap');
      }
      expect(current.decile).toBeLessThanOrEqual(previous.decile);
    }
  });

  it('flags a surname carried by a large share of the population as top-decile', () => {
    // The case the midpoint rule got wrong: one name carrying 45% of the population is the most
    // common name there is, and must be decile 10.
    const deciles = assignDeciles([
      { nameKey: 'dominant', count: 4500 },
      ...Array.from({ length: 500 }, (_, i) => ({ nameKey: `other${String(i)}`, count: 11 })),
    ]);
    expect(deciles.find((d) => d.nameKey === 'dominant')?.decile).toBe(10);
  });

  it('returns one row per input name and loses none', () => {
    const deciles = assignDeciles(REALISTIC);
    expect(deciles).toHaveLength(REALISTIC.length);
    expect(new Set(deciles.map((d) => d.nameKey)).size).toBe(REALISTIC.length);
  });
});

describe('it refuses input that is not a measurement', () => {
  it('refuses an empty distribution rather than silently loading nothing', () => {
    // An empty result would be indistinguishable from a loaded one, and the coverage statement
    // would stop reporting the prior as missing.
    expect(() => assignDeciles([])).toThrow(/empty distribution/i);
  });

  it('refuses a zero or fractional count', () => {
    expect(() => assignDeciles([{ nameKey: 'x', count: 0 }])).toThrow(/not a measurement/i);
    expect(() => assignDeciles([{ nameKey: 'x', count: 1.5 }])).toThrow(/not a measurement/i);
  });
});

describe('the disclosure for a population with no distribution', () => {
  it('says what the absence costs, not merely that it is absent', () => {
    const statement = describeMissingNameFrequency('CR');
    expect(statement).toContain('CR');
    expect(statement).toMatch(/more permissive/i);
    expect(statement).toMatch(/T71/);
  });
});
