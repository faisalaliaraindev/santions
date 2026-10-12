/** Section 6.2 result dimensions and the FR-13 no-match statement. Tests T21, T47, T88. Guards I10. */

import { describe, expect, it } from 'vitest';

import {
  REVIEW_DISCLAIMER,
  aggregateRun,
  renderNoMatchStatement,
  type SourceCoverageOutcome,
} from '../../src/coverage/result-state.js';

function outcome(overrides: Partial<SourceCoverageOutcome> & { sourceId: string }): SourceCoverageOutcome {
  return {
    sourceName: `Source ${overrides.sourceId}`,
    cascadeRung: 2,
    outcome: 'COMPLETED',
    detail: null,
    queriesAffected: 0,
    truncation: null,
    ...overrides,
  };
}

describe('aggregateRun', () => {
  it('T21 — a completed finite plan with no findings is SUCCEEDED / NO_MATCHES_FOUND / WITHIN_DECLARED_SCOPE', () => {
    const result = aggregateRun({
      cancelled: false,
      supportedFindingCount: 0,
      unresolvedLeadCount: 0,
      sourceOutcomes: [outcome({ sourceId: 'a' }), outcome({ sourceId: 'b' })],
      anyWorkDispatched: true,
    });
    expect(result).toMatchObject({
      execution: 'SUCCEEDED',
      findings: 'NO_MATCHES_FOUND',
      coverage: 'WITHIN_DECLARED_SCOPE',
    });
  });

  it('T47 — when every source fails the run is FAILED / NOT_EVALUATED, never a clean result', () => {
    const result = aggregateRun({
      cancelled: false,
      supportedFindingCount: 0,
      unresolvedLeadCount: 0,
      sourceOutcomes: [
        outcome({ sourceId: 'a', outcome: 'FAILED', detail: 'timeout' }),
        outcome({ sourceId: 'b', outcome: 'SUSPENDED', detail: 'breaker open' }),
      ],
      anyWorkDispatched: true,
    });
    expect(result.execution).toBe('FAILED');
    expect(result.findings).toBe('NOT_EVALUATED');
    expect(result.findings).not.toBe('NO_MATCHES_FOUND');
    expect(result.coverage).toBe('INCOMPLETE');
  });

  it('T47 — one succeeding source yields a usable partial result', () => {
    const result = aggregateRun({
      cancelled: false,
      supportedFindingCount: 2,
      unresolvedLeadCount: 3,
      sourceOutcomes: [outcome({ sourceId: 'a' }), outcome({ sourceId: 'b', outcome: 'FAILED' })],
      anyWorkDispatched: true,
    });
    expect(result).toMatchObject({
      execution: 'PARTIAL',
      findings: 'CONFIRMED_MATCHES_FOUND',
      coverage: 'INCOMPLETE',
    });
  });

  it('T88 — quota truncation makes coverage INCOMPLETE, never a bare no-match', () => {
    const result = aggregateRun({
      cancelled: false,
      supportedFindingCount: 0,
      unresolvedLeadCount: 0,
      sourceOutcomes: [
        outcome({ sourceId: 'a' }),
        outcome({ sourceId: 'b', truncation: 'TRUNCATED_BY_QUOTA', queriesAffected: 3, detail: 'daily budget exhausted' }),
      ],
      anyWorkDispatched: true,
    });
    expect(result.coverage).toBe('INCOMPLETE');
    expect(result.execution).toBe('PARTIAL');
    expect(result.findings).toBe('NO_MATCHES_FOUND');
  });

  it('reports UNRESOLVED when only leads were found', () => {
    const result = aggregateRun({
      cancelled: false,
      supportedFindingCount: 0,
      unresolvedLeadCount: 5,
      sourceOutcomes: [outcome({ sourceId: 'a' })],
      anyWorkDispatched: true,
    });
    expect(result.findings).toBe('UNRESOLVED');
  });

  it('cancellation never retroactively claims completion', () => {
    const result = aggregateRun({
      cancelled: true,
      supportedFindingCount: 0,
      unresolvedLeadCount: 0,
      sourceOutcomes: [outcome({ sourceId: 'a' })],
      anyWorkDispatched: true,
    });
    expect(result.execution).toBe('CANCELLED');
    expect(result.findings).toBe('NOT_EVALUATED');
    expect(result.coverage).toBe('INCOMPLETE');
  });

  it('reports UNKNOWN coverage when no work was dispatched at all', () => {
    const result = aggregateRun({
      cancelled: false,
      supportedFindingCount: 0,
      unresolvedLeadCount: 0,
      sourceOutcomes: [],
      anyWorkDispatched: false,
    });
    expect(result.coverage).toBe('UNKNOWN');
    expect(result.findings).toBe('NOT_EVALUATED');
  });

  it('treats a skipped source as incomplete coverage', () => {
    const result = aggregateRun({
      cancelled: false,
      supportedFindingCount: 1,
      unresolvedLeadCount: 0,
      sourceOutcomes: [outcome({ sourceId: 'a' }), outcome({ sourceId: 'b', outcome: 'SKIPPED' })],
      anyWorkDispatched: true,
    });
    expect(result.coverage).toBe('INCOMPLETE');
  });
});

describe('renderNoMatchStatement — I10', () => {
  const base = {
    sourceCount: 11,
    languages: ['en', 'es'],
    jurisdictions: ['GB', 'CL'],
    enabledCategories: ['FRAUD_FINANCIAL_CRIME'],
    taxonomyVersion: 14,
    policyVersion: 7,
    runAt: '2026-09-10T14:22:00.000Z',
    archiveHorizon: '2017-01-01',
    unmeasuredLanguages: [] as string[],
  };

  it('carries scope, sources, versions, date, horizon and coverage', () => {
    const statement = renderNoMatchStatement({
      ...base,
      coverage: 'WITHIN_DECLARED_SCOPE',
      failedSources: [],
    });
    const joined = statement.lines.join('\n');
    expect(statement.headline).toBe('No matches found in the sources and scope searched.');
    expect(joined).toContain('11 sources');
    expect(joined).toContain('Taxonomy v14');
    expect(joined).toContain('Policy v7');
    expect(joined).toContain('2026-09-10T14:22:00.000Z');
    expect(joined).toContain('Archive horizon: 2017-01-01');
    expect(joined).toContain('WITHIN_DECLARED_SCOPE');
  });

  it('names every failed source and the queries it affected', () => {
    const statement = renderNoMatchStatement({
      ...base,
      coverage: 'INCOMPLETE',
      failedSources: [
        outcome({ sourceId: 'gdelt', sourceName: 'GDELT DOC 2.0', outcome: 'FAILED', detail: 'quota exhausted', queriesAffected: 4 }),
        outcome({ sourceId: 'searx', sourceName: 'SearXNG', outcome: 'PARTIAL', detail: 'rate-limited', queriesAffected: 1 }),
      ],
    });
    const joined = statement.lines.join('\n');
    expect(joined).toContain('GDELT DOC 2.0: quota exhausted (4 queries affected)');
    expect(joined).toContain('SearXNG: rate-limited (1 query affected)');
  });

  it('never produces the words "clear", "clean" or "no adverse media"', () => {
    const statement = renderNoMatchStatement({
      ...base,
      coverage: 'INCOMPLETE',
      failedSources: [outcome({ sourceId: 'a', outcome: 'FAILED', detail: 'timeout' })],
    });
    const joined = `${statement.headline}\n${statement.lines.join('\n')}`;
    expect(joined).not.toMatch(/\b(clear|clean|no adverse media)\b/i);
  });

  it('T80 — declares languages that carry no measured recall figure', () => {
    const statement = renderNoMatchStatement({
      ...base,
      coverage: 'INCOMPLETE',
      failedSources: [],
      unmeasuredLanguages: ['ur', 'id'],
    });
    expect(statement.lines.join('\n')).toMatch(/Unmeasured languages: ur, id/);
  });

  it('states the coverage even when no source-level detail was recorded', () => {
    const statement = renderNoMatchStatement({ ...base, coverage: 'UNKNOWN', failedSources: [] });
    expect(statement.lines.join('\n')).toContain('Coverage: UNKNOWN');
  });
});

describe('the review disclaimer', () => {
  it('states that reporting establishes neither identity nor wrongdoing', () => {
    expect(REVIEW_DISCLAIMER).toMatch(/does not establish identity or wrongdoing/);
    expect(REVIEW_DISCLAIMER).toMatch(/not a final compliance decision/);
  });
});

/**
 * D6 / D-010 — the coverage statement must say when the terms it searched with are unreviewed.
 *
 * Distinct from "unmeasured", and both are true today. Unmeasured means we have not checked how
 * much the language finds; unreviewed means we are not sure we asked the right question.
 */
describe('the no-match statement declares an unreviewed term list', () => {
  const base = {
    sourceCount: 2,
    languages: ['es'],
    jurisdictions: ['CR'],
    enabledCategories: ['FRAUD_FINANCIAL_CRIME'],
    taxonomyVersion: 1,
    policyVersion: 1,
    runAt: '2026-09-14T10:00:00.000Z',
    archiveHorizon: 'not established',
    coverage: 'INCOMPLETE' as const,
    failedSources: [],
    unmeasuredLanguages: ['es'],
  };

  it('names the languages whose terms nobody has reviewed', () => {
    const statement = renderNoMatchStatement({ ...base, unreviewedTermLanguages: ['es'] });
    const line = statement.lines.find((l) => l.startsWith('Unreviewed term lists:'));
    expect(line).toContain('es');
    expect(line).toContain('returns nothing rather than failing');
  });

  it('says nothing when every list is reviewed', () => {
    const statement = renderNoMatchStatement({ ...base, unreviewedTermLanguages: [] });
    expect(statement.lines.some((l) => l.startsWith('Unreviewed term lists:'))).toBe(false);
  });

  it('treats an absent field as "none declared" rather than as "all reviewed"', () => {
    // Absent means the caller has not considered the question, so nothing is claimed either way.
    const statement = renderNoMatchStatement(base);
    expect(statement.lines.some((l) => l.startsWith('Unreviewed term lists:'))).toBe(false);
  });
});
