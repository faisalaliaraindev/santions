/** FR-04 query planning and plan bounding. Test T78. */

import { describe, expect, it } from 'vitest';

import {
  DROP_PRIORITY,
  QUERY_FAMILY_DEFINITIONS,
  UNDROPPABLE,
  assertPlanIsEntityAnchored,
  boundPlan,
  type PlannedQuery,
  type QueryFamily,
} from '../../src/planning/query-families.js';

function q(family: QueryFamily, n: number): PlannedQuery {
  return {
    queryId: `${family}-${String(n)}`,
    family,
    query: `"Rhys Mordaunt" ${family} ${String(n)}`,
    language: 'en',
    jurisdiction: 'GB',
    companyId: family === 'F6' ? 'CO1' : null,
    followsEventId: family === 'F8' ? 'EV1' : null,
  };
}

function plan(counts: Partial<Record<QueryFamily, number>>): PlannedQuery[] {
  return Object.entries(counts).flatMap(([family, n]) =>
    Array.from({ length: n }, (_, i) => q(family as QueryFamily, i)),
  );
}

describe('the eight query families', () => {
  it('defines all eight', () => {
    expect(QUERY_FAMILY_DEFINITIONS).toHaveLength(8);
    expect(QUERY_FAMILY_DEFINITIONS.map((d) => d.family)).toEqual([
      'F1',
      'F2',
      'F3',
      'F4',
      'F5',
      'F6',
      'F7',
      'F8',
    ]);
  });

  it('marks F1, F4 and F8 as never dropped', () => {
    const never = QUERY_FAMILY_DEFINITIONS.filter((d) => d.neverDropped).map((d) => d.family);
    expect(never).toEqual(['F1', 'F4', 'F8']);
    expect([...UNDROPPABLE].sort()).toEqual(['F1', 'F4', 'F8']);
  });

  it('marks F8 as the mandatory second pass', () => {
    expect(QUERY_FAMILY_DEFINITIONS.find((d) => d.family === 'F8')?.secondPass).toBe(true);
  });

  it('never lists an undroppable family in the drop priority', () => {
    for (const family of UNDROPPABLE) {
      expect(DROP_PRIORITY).not.toContain(family);
    }
  });
});

describe('boundPlan — T78', () => {
  it('returns the plan untouched when it fits the cap', () => {
    const p = plan({ F1: 1, F4: 3, F3: 5 });
    const result = boundPlan(p, 20);
    expect(result.truncation).toBeNull();
    expect(result.kept).toHaveLength(9);
    expect(result.droppedFamilies).toHaveLength(0);
  });

  it('T78 — F1 and F4 survive truncation and the drop order is declared', () => {
    const p = plan({ F1: 2, F2: 4, F3: 20, F4: 6, F5: 4, F6: 6, F7: 12, F8: 2 });
    const result = boundPlan(p, 20);

    expect(result.truncation).toBe('TRUNCATED_BY_PLAN');
    expect(result.kept).toHaveLength(20);
    expect(result.kept.filter((x) => x.family === 'F1')).toHaveLength(2);
    expect(result.kept.filter((x) => x.family === 'F4')).toHaveLength(6);
    expect(result.kept.filter((x) => x.family === 'F8')).toHaveLength(2);
    expect(result.dropped.some((x) => (['F1', 'F4', 'F8'] as string[]).includes(x.family))).toBe(
      false,
    );
  });

  it('drops from the lowest-priority family first', () => {
    // 4 over the cap: F7 (12 available) absorbs all of it before F6 is touched.
    const p = plan({ F1: 1, F4: 1, F6: 6, F7: 12 });
    const result = boundPlan(p, 16);
    expect(result.droppedFamilies).toEqual(['F7']);
    expect(result.dropped).toHaveLength(4);
  });

  it('spills into the next family when one is exhausted', () => {
    const p = plan({ F1: 1, F4: 1, F6: 6, F7: 4 });
    const result = boundPlan(p, 6);
    expect([...result.droppedFamilies].sort()).toEqual(['F6', 'F7']);
    expect(result.dropped).toHaveLength(6);
    expect(result.kept.filter((x) => x.family === 'F7')).toHaveLength(0);
  });

  it('records every family that lost a query', () => {
    const p = plan({ F1: 1, F4: 1, F2: 3, F3: 3, F5: 3, F6: 3, F7: 3 });
    const result = boundPlan(p, 5);
    // F2 survives: the budget is exhausted by the four lower-priority families first.
    expect([...result.droppedFamilies].sort()).toEqual(['F3', 'F5', 'F6', 'F7']);
    expect(result.kept.filter((x) => x.family === 'F2')).toHaveLength(3);
    expect(result.cap).toBe(5);
  });

  it('refuses to silently discard F1 or F4 when the cap is below the undroppable floor', () => {
    const p = plan({ F1: 4, F4: 8 });
    expect(() => boundPlan(p, 5)).toThrow(/F1 and F4 are never dropped/);
  });
});

describe('assertPlanIsEntityAnchored', () => {
  it('accepts a plan containing F1', () => {
    expect(() => {
      assertPlanIsEntityAnchored(plan({ F1: 1, F3: 4 }));
    }).not.toThrow();
  });

  it('rejects a negative-keyword-only plan', () => {
    expect(() => {
      assertPlanIsEntityAnchored(plan({ F3: 10, F4: 4 }));
    }).toThrow(/Negative-keyword-only search is prohibited/);
  });
});
