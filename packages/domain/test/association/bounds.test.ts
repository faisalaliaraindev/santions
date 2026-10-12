/**
 * FR-02 traversal bounds, and the coverage they produce.
 *
 * The property running through all of it: a bound that binds must be visible. A silently
 * truncated graph is a narrower search reported as a complete one.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GRAPH_BOUNDS,
  GRAPH_BOUND_CEILINGS,
  describeBound,
  resolveGraphBounds,
  summariseAssociationCoverage,
  type BoundApplication,
} from '../../src/index.js';

describe('resolving bounds from a policy version', () => {
  it('uses the declared values when they are sane', () => {
    const { bounds, problems } = resolveGraphBounds({
      maxOfficerCandidates: 10,
      maxCompaniesPerOfficer: 20,
      maxEdgesPerSnapshot: 100,
    });
    expect(bounds).toEqual({
      maxOfficerCandidates: 10,
      maxCompaniesPerOfficer: 20,
      maxEdgesPerSnapshot: 100,
    });
    expect(problems).toEqual([]);
  });

  it('falls back to the documented default for an undeclared field', () => {
    const { bounds, problems } = resolveGraphBounds({ maxOfficerCandidates: 10 });
    expect(bounds.maxCompaniesPerOfficer).toBe(DEFAULT_GRAPH_BOUNDS.maxCompaniesPerOfficer);
    // An omission is not a mistake: a policy that declares one bound and leaves the others is
    // perfectly reasonable, so it produces no problem line.
    expect(problems).toEqual([]);
  });

  it('uses defaults, not an error, when the policy declares nothing at all', () => {
    expect(resolveGraphBounds(undefined).bounds).toEqual(DEFAULT_GRAPH_BOUNDS);
    expect(resolveGraphBounds(null).bounds).toEqual(DEFAULT_GRAPH_BOUNDS);
    expect(resolveGraphBounds('nonsense').bounds).toEqual(DEFAULT_GRAPH_BOUNDS);
  });

  it('reports a nonsensical bound instead of failing the search', () => {
    // Throwing would take a screening run down over a configuration typo, which is a worse
    // failure than running with a default that is stated in the coverage.
    const { bounds, problems } = resolveGraphBounds({ maxOfficerCandidates: -4 });
    expect(bounds.maxOfficerCandidates).toBe(DEFAULT_GRAPH_BOUNDS.maxOfficerCandidates);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/not a positive whole number/i);
  });

  it('reports a fractional bound the same way', () => {
    const { problems } = resolveGraphBounds({ maxEdgesPerSnapshot: 12.5 });
    expect(problems[0]).toMatch(/maxEdgesPerSnapshot/);
  });

  it('caps a bound above the ceiling, because a limitless bound is not a bound', () => {
    const { bounds, problems } = resolveGraphBounds({ maxEdgesPerSnapshot: 10_000_000 });
    expect(bounds.maxEdgesPerSnapshot).toBe(GRAPH_BOUND_CEILINGS.maxEdgesPerSnapshot);
    expect(problems[0]).toMatch(/ceiling/i);
  });

  it('never returns a bound below 1 or above its ceiling, whatever it is given', () => {
    for (const raw of [0, -1, 1, 10_000_000, 'x', null, {}]) {
      const { bounds } = resolveGraphBounds({
        maxOfficerCandidates: raw,
        maxCompaniesPerOfficer: raw,
        maxEdgesPerSnapshot: raw,
      });
      expect(bounds.maxOfficerCandidates).toBeGreaterThanOrEqual(1);
      expect(bounds.maxOfficerCandidates).toBeLessThanOrEqual(
        GRAPH_BOUND_CEILINGS.maxOfficerCandidates,
      );
      expect(bounds.maxEdgesPerSnapshot).toBeLessThanOrEqual(
        GRAPH_BOUND_CEILINGS.maxEdgesPerSnapshot,
      );
    }
  });
});

describe('describing a bound to a reviewer', () => {
  const officerCap: BoundApplication = {
    bound: 'MAX_OFFICER_CANDIDATES',
    limit: 3,
    available: 12,
    appliedTo: 'Juan Carlos Rodríguez',
  };

  it('says how big the gap is when the register said', () => {
    expect(describeBound(officerCap)).toMatch(/capped at 3/);
    expect(describeBound(officerCap)).toMatch(/12 exist/);
  });

  it('says the size is unknown rather than implying there is none', () => {
    // "More than 3, we do not know how many" and "3 of 12" lead a reviewer somewhere different.
    expect(describeBound({ ...officerCap, available: null })).toMatch(
      /did not say how many exist/i,
    );
  });

  it('describes all three bounds distinctly', () => {
    const sentences = (
      ['MAX_OFFICER_CANDIDATES', 'MAX_COMPANIES_PER_OFFICER', 'MAX_EDGES_PER_SNAPSHOT'] as const
    ).map((bound) => describeBound({ ...officerCap, bound }));
    expect(new Set(sentences).size).toBe(3);
    for (const sentence of sentences) {
      expect(sentence.length).toBeGreaterThan(30);
    }
  });
});

describe('association coverage', () => {
  const base = {
    sourceId: 'src-registry',
    sourceName: 'Company register',
    jurisdiction: 'CR',
    answered: true,
    failure: null,
    boundsApplied: [] as readonly BoundApplication[],
    policyProblems: [] as readonly string[],
    notAskedReason: null,
  };

  it('is COMPLETE only when a register answered and nothing bound', () => {
    const result = summariseAssociationCoverage(base);
    expect(result.outcome).toBe('COMPLETE');
    expect(result.detail).toBeNull();
    expect(result.sourceOutcome.outcome).toBe('COMPLETED');
    expect(result.sourceOutcome.truncation).toBeNull();
  });

  it('is UNKNOWN when no register was asked, and says so without implying an attempt', () => {
    const result = summariseAssociationCoverage({ ...base, sourceId: null, answered: false });
    expect(result.outcome).toBe('UNKNOWN');
    expect(result.detail).toMatch(/none was asked/i);
    expect(result.detail).toMatch(/not evidence that the subject has no associations/i);
    // SKIPPED, not FAILED: nothing failed, because nothing was attempted.
    expect(result.sourceOutcome.outcome).toBe('SKIPPED');
  });

  it('is INCOMPLETE and FAILED when a register was asked and did not answer', () => {
    const result = summariseAssociationCoverage({
      ...base,
      answered: false,
      failure: 'TRANSIENT_NETWORK',
    });
    expect(result.outcome).toBe('INCOMPLETE');
    expect(result.sourceOutcome.outcome).toBe('FAILED');
    expect(result.detail).toMatch(/does not prove no associations exist/i);
  });

  it('keeps "never asked" and "asked and failed" distinguishable in the run outcome', () => {
    const skipped = summariseAssociationCoverage({ ...base, sourceId: null, answered: false });
    const failed = summariseAssociationCoverage({
      ...base,
      answered: false,
      failure: 'HARD_BLOCK',
    });
    // Both make a run incomplete. They must not become the same fact on the way there.
    expect(skipped.sourceOutcome.outcome).not.toBe(failed.sourceOutcome.outcome);
    expect(skipped.detail).not.toBe(failed.detail);
  });

  it('is INCOMPLETE and PARTIAL when a bound bound, because real associations were found', () => {
    const result = summariseAssociationCoverage({
      ...base,
      boundsApplied: [
        { bound: 'MAX_OFFICER_CANDIDATES', limit: 3, available: 12, appliedTo: 'someone' },
      ],
    });
    expect(result.outcome).toBe('INCOMPLETE');
    expect(result.sourceOutcome.outcome).toBe('PARTIAL');
    expect(result.sourceOutcome.truncation).toBe('TRUNCATED_BY_PLAN');
    expect(result.limitations).toHaveLength(1);
  });

  it('surfaces a policy bound problem as a limitation of the run', () => {
    // A run that silently fell back to defaults because of a typo is a run whose truncation
    // nobody can explain afterwards.
    const result = summariseAssociationCoverage({
      ...base,
      policyProblems: ['Policy bound maxOfficerCandidates is "ten", which is not a number.'],
    });
    expect(result.outcome).toBe('INCOMPLETE');
    expect(result.limitations).toHaveLength(1);
  });

  it('never claims absence: any mention of "no associations" is a denial of the claim', () => {
    const outcomes = [
      summariseAssociationCoverage(base),
      summariseAssociationCoverage({ ...base, sourceId: null, answered: false }),
      summariseAssociationCoverage({ ...base, answered: false, failure: 'HARD_BLOCK' }),
      summariseAssociationCoverage({
        ...base,
        boundsApplied: [
          { bound: 'MAX_EDGES_PER_SNAPSHOT', limit: 5, available: null, appliedTo: 'x' },
        ],
      }),
    ];
    for (const result of outcomes) {
      const detail = result.detail ?? '';
      if (/no associations/i.test(detail)) {
        // FR-02 closes by forbidding the inference, so the only permitted way to use the
        // phrase is to deny it.
        expect(detail).toMatch(/does not prove no associations|not evidence that the subject/i);
      }
    }
  });

  it('always attributes the outcome to rung 1 of the cascade', () => {
    // The graph is what makes a company eligible for a rung-1 primary-source query, so that is
    // where it belongs in the coverage statement.
    expect(summariseAssociationCoverage(base).sourceOutcome.cascadeRung).toBe(1);
  });
});
