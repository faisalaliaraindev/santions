import { describe, expect, it } from 'vitest';

import {
  assertMayReportNoFindings,
  CAPABILITY_STATUSES,
  coverageIndex,
  coverageOutcomeFor,
  describeCoverage,
  interpretEmptyResult,
  lookupCoverage,
  type CapabilityCoverage,
} from '../../src/capability/capability.js';

const ASSESSED = '2026-09-11T00:00:00.000Z';

function coverage(overrides: Partial<CapabilityCoverage> = {}): CapabilityCoverage {
  return {
    jurisdiction: 'CR',
    capability: 'OFFICER_ASSOCIATIONS',
    status: 'UNKNOWN',
    rationale: 'test',
    sourceIds: [],
    evidenceRef: null,
    assessedAt: ASSESSED,
    blockedByDecision: null,
    ...overrides,
  };
}

describe('interpreting an empty result', () => {
  it('reports nothing found as a real negative only when the capability is supported', () => {
    expect(interpretEmptyResult('SUPPORTED')).toBe('NO_FINDINGS');
  });

  it('refuses to call an empty result clean for any other status', () => {
    for (const status of CAPABILITY_STATUSES.filter((s) => s !== 'SUPPORTED')) {
      expect(interpretEmptyResult(status), status).toBe('NOT_ESTABLISHED');
    }
  });

  it('treats PARTIAL as not established — some of it was never looked at', () => {
    expect(interpretEmptyResult('PARTIAL')).toBe('NOT_ESTABLISHED');
  });
});

describe('assertMayReportNoFindings', () => {
  it('permits a clean report where coverage is supported', () => {
    expect(() => {
      assertMayReportNoFindings(coverage({ status: 'SUPPORTED', sourceIds: ['src-a'] }));
    }).not.toThrow();
  });

  it('throws rather than returning false, so the caller cannot forget the branch', () => {
    expect(() => {
      assertMayReportNoFindings(coverage({ status: 'UNKNOWN' }));
    }).toThrow(/Refusing to report "no findings"/);
  });

  it('names the capability and the status in the refusal', () => {
    expect(() => {
      assertMayReportNoFindings(coverage({ status: 'UNSUPPORTED', rationale: 'no free source' }));
    }).toThrow(/OFFICER_ASSOCIATIONS in CR: coverage is UNSUPPORTED/);
  });
});

describe('folding capability statuses into a coverage outcome', () => {
  it('is COMPLETE only when everything is supported', () => {
    expect(coverageOutcomeFor(['SUPPORTED', 'SUPPORTED'])).toBe('COMPLETE');
  });

  it('is UNKNOWN when nothing was askable at all', () => {
    expect(coverageOutcomeFor(['UNKNOWN', 'UNSUPPORTED'])).toBe('UNKNOWN');
    expect(coverageOutcomeFor(['UNKNOWN'])).toBe('UNKNOWN');
    expect(coverageOutcomeFor(['UNSUPPORTED'])).toBe('UNKNOWN');
  });

  it('is UNKNOWN, not COMPLETE, when there is nothing to fold', () => {
    expect(coverageOutcomeFor([])).toBe('UNKNOWN');
  });

  it('is INCOMPLETE when some of it worked and some did not', () => {
    expect(coverageOutcomeFor(['SUPPORTED', 'UNKNOWN'])).toBe('INCOMPLETE');
    expect(coverageOutcomeFor(['SUPPORTED', 'PARTIAL'])).toBe('INCOMPLETE');
    expect(coverageOutcomeFor(['PARTIAL'])).toBe('INCOMPLETE');
  });
});

describe('lookupCoverage', () => {
  const index = coverageIndex([
    coverage({ capability: 'NEWS_DISCOVERY', status: 'SUPPORTED', sourceIds: ['src-news'] }),
  ]);

  it('returns the recorded coverage', () => {
    const found = lookupCoverage(index, 'CR', 'NEWS_DISCOVERY', ASSESSED);
    expect(found.status).toBe('SUPPORTED');
  });

  it('defaults an unrecorded capability to UNKNOWN, never to supported', () => {
    const missing = lookupCoverage(index, 'GB', 'COURT_RECORDS', ASSESSED);
    expect(missing.status).toBe('UNKNOWN');
    expect(interpretEmptyResult(missing.status)).toBe('NOT_ESTABLISHED');
  });
});

describe('describeCoverage', () => {
  it('says plainly that nothing was searched when coverage is unknown', () => {
    const text = describeCoverage(coverage({ status: 'UNKNOWN', rationale: 'not established.' }));
    expect(text).toContain('Nothing was searched');
  });

  it('warns that a nil result means nothing when coverage is partial', () => {
    const text = describeCoverage(coverage({ status: 'PARTIAL', rationale: 'some sources only.' }));
    expect(text).toContain('does not mean there is nothing to find');
  });

  it('names the sources when coverage is real', () => {
    const text = describeCoverage(coverage({ status: 'SUPPORTED', sourceIds: ['src-a', 'src-b'] }));
    expect(text).toContain('src-a, src-b');
  });
});
