/** FR-08 Axis A — identity resolution. Tests T11, T12, T71, T72. */

import { describe, expect, it } from 'vitest';

import { gradeIdentity, type AxisAInput, type IdentityFactor } from '../../src/identity/axis-a.js';

function f(
  strength: IdentityFactor['strength'],
  direction: IdentityFactor['direction'],
  kind: IdentityFactor['kind'] = 'FULL_DOB',
): IdentityFactor {
  return {
    kind,
    strength,
    direction,
    span: direction === 'ABSENT' ? null : { start: 0, end: 8 },
    detail: `${strength} ${direction}`,
  };
}

function input(overrides: Partial<AxisAInput> = {}): AxisAInput {
  return {
    nameMatch: 'EXACT',
    factors: [],
    frequencyPrior: null,
    documentDistinguishesNamesake: false,
    ...overrides,
  };
}

describe('gradeIdentity', () => {
  it('one strong corroborating identifier reaches CORROBORATED', () => {
    expect(gradeIdentity(input({ factors: [f('STRONG', 'CORROBORATING')] })).grade).toBe(
      'CORROBORATED',
    );
  });

  it('two independent moderate identifiers reach CORROBORATED', () => {
    const result = gradeIdentity(
      input({
        factors: [
          f('MODERATE', 'CORROBORATING', 'NAMED_POSITION_HELD'),
          f('MODERATE', 'CORROBORATING', 'EMPLOYER_PLUS_JOB_TITLE'),
        ],
      }),
    );
    expect(result.grade).toBe('CORROBORATED');
  });

  it('one moderate identifier reaches PARTIAL', () => {
    expect(
      gradeIdentity(input({ factors: [f('MODERATE', 'CORROBORATING', 'NAMED_POSITION_HELD')] }))
        .grade,
    ).toBe('PARTIAL');
  });

  it('weak identifiers are never sufficient alone', () => {
    const result = gradeIdentity(
      input({
        factors: [
          f('WEAK', 'CORROBORATING', 'EXACT_COMMON_NAME'),
          f('WEAK', 'CORROBORATING', 'COUNTRY_ONLY'),
          f('WEAK', 'CORROBORATING', 'SECTOR_ONLY'),
        ],
      }),
    );
    expect(result.grade).toBe('WEAK');
  });

  it('absence is not evidence against — absent factors never downgrade', () => {
    const withAbsent = gradeIdentity(
      input({
        factors: [f('STRONG', 'CORROBORATING'), f('STRONG', 'ABSENT', 'GOVERNMENT_OR_PASSPORT_ID')],
      }),
    );
    const withoutAbsent = gradeIdentity(input({ factors: [f('STRONG', 'CORROBORATING')] }));
    expect(withAbsent.grade).toBe(withoutAbsent.grade);
    expect(withAbsent.absent).toHaveLength(1);
  });

  it('T11 — a strong contradiction blocks resolution even at exact name match', () => {
    const result = gradeIdentity(
      input({
        nameMatch: 'EXACT',
        factors: [
          f('STRONG', 'CORROBORATING'),
          f('STRONG', 'CONTRADICTING', 'DOB_DIFFERS_BEYOND_PRECISION'),
        ],
      }),
    );
    expect(result.grade).toBe('CONTRADICTED');
    expect(result.contradicting).toHaveLength(1);
    expect(result.rationale.join(' ')).toMatch(/cannot be resolved automatically/);
  });

  it('one moderate contradiction downgrades; two contradict outright', () => {
    const one = gradeIdentity(
      input({
        factors: [
          f('STRONG', 'CORROBORATING'),
          f('MODERATE', 'CONTRADICTING', 'INCOMPATIBLE_DOCUMENTED_OCCUPATION'),
        ],
      }),
    );
    expect(one.grade).toBe('PARTIAL');

    const two = gradeIdentity(
      input({
        factors: [
          f('STRONG', 'CORROBORATING'),
          f('MODERATE', 'CONTRADICTING', 'INCOMPATIBLE_DOCUMENTED_OCCUPATION'),
          f('MODERATE', 'CONTRADICTING', 'NATIONALITY_INCONSISTENT_WITH_EXCLUSIVE_CLAIM'),
        ],
      }),
    );
    expect(two.grade).toBe('CONTRADICTED');
  });

  it('a document that distinguishes a namesake is CONTRADICTED regardless of identifiers', () => {
    const result = gradeIdentity(
      input({ factors: [f('STRONG', 'CORROBORATING')], documentDistinguishesNamesake: true }),
    );
    expect(result.grade).toBe('CONTRADICTED');
  });

  it('T71 — a top-decile name with no secondary identifiers is penalised', () => {
    const result = gradeIdentity(
      input({
        factors: [f('WEAK', 'CORROBORATING', 'EXACT_COMMON_NAME')],
        frequencyPrior: { decile: 10, population: 'GB', sourceRef: 'ONS 2021' },
      }),
    );
    expect(result.grade).toBe('WEAK');
    expect(result.frequencyPenaltyApplied).toBe(true);
    expect(result.rationale.join(' ')).toMatch(/Name-frequency penalty/);
  });

  it('T71 — the frequency penalty is offset by two moderate identifiers', () => {
    const result = gradeIdentity(
      input({
        factors: [
          f('MODERATE', 'CORROBORATING', 'NAMED_POSITION_HELD'),
          f('MODERATE', 'CORROBORATING', 'CO_OCCURRING_ASSOCIATE_IN_GRAPH'),
        ],
        frequencyPrior: { decile: 10, population: 'GB', sourceRef: 'ONS 2021' },
      }),
    );
    expect(result.grade).toBe('CORROBORATED');
    expect(result.frequencyPenaltyApplied).toBe(false);
  });

  it('a non-top-decile name carries no penalty', () => {
    const result = gradeIdentity(
      input({
        factors: [f('MODERATE', 'CORROBORATING', 'NAMED_POSITION_HELD')],
        frequencyPrior: { decile: 4, population: 'GB', sourceRef: 'ONS 2021' },
      }),
    );
    expect(result.grade).toBe('PARTIAL');
    expect(result.frequencyPenaltyApplied).toBe(false);
  });

  it('no name match at all grades WEAK, never CORROBORATED', () => {
    const result = gradeIdentity(
      input({ nameMatch: 'NO_MATCH', factors: [f('STRONG', 'CORROBORATING')] }),
    );
    expect(result.grade).toBe('WEAK');
  });

  it('phonetic-only agreement without a strong identifier caps at PARTIAL', () => {
    const result = gradeIdentity(
      input({
        nameMatch: 'PHONETIC',
        factors: [
          f('MODERATE', 'CORROBORATING', 'NAMED_POSITION_HELD'),
          f('MODERATE', 'CORROBORATING', 'EMPLOYER_PLUS_JOB_TITLE'),
        ],
      }),
    );
    expect(result.grade).toBe('PARTIAL');
  });

  it('T12 — a name-only sparse identity is unresolved, not confirmed and not cleared', () => {
    const result = gradeIdentity(input({ nameMatch: 'EXACT', factors: [] }));
    expect(result.grade).toBe('WEAK');
    expect(result.rationale.join(' ')).toMatch(/no corroborating identifier/);
  });
});
