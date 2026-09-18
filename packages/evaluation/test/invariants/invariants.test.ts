/**
 * The I1-I10 release gate (FR-11, FR-16, section 10.4).
 *
 * Runs with no I/O, no database and no network. `pnpm test:invariants` must be executable on
 * a clean checkout with nothing running.
 */

import { describe, expect, it } from 'vitest';

import {
  INVARIANT_STATEMENTS,
  SEED_DATASET,
  checkI1,
  checkI2,
  checkI3,
  checkI4,
  checkI5,
  checkI6,
  checkI7,
  checkI8,
  checkI9,
  checkI10,
  runAllInvariants,
  runCase,
  type InvariantResult,
  type NoMatchRunSample,
} from '../../src/index.js';
import { aggregateRun, renderNoMatchStatement } from '@erly/adverse-domain';

/** Build the run-level samples I10 is checked against. */
function noMatchSamples(): readonly NoMatchRunSample[] {
  const failing = [
    {
      sourceId: 'gdelt',
      sourceName: 'GDELT DOC 2.0',
      cascadeRung: 3,
      outcome: 'FAILED' as const,
      detail: 'quota exhausted',
      queriesAffected: 4,
      truncation: 'TRUNCATED_BY_QUOTA' as const,
    },
    {
      sourceId: 'searxng',
      sourceName: 'SearXNG metasearch',
      cascadeRung: 5,
      outcome: 'PARTIAL' as const,
      detail: 'rate-limited',
      queriesAffected: 2,
      truncation: null,
    },
  ];

  const completing = [
    {
      sourceId: 'gnews',
      sourceName: 'Google News RSS',
      cascadeRung: 2,
      outcome: 'COMPLETED' as const,
      detail: null,
      queriesAffected: 0,
      truncation: null,
    },
  ];

  const build = (label: string, outcomes: typeof failing | typeof completing): NoMatchRunSample => {
    const aggregate = aggregateRun({
      cancelled: false,
      supportedFindingCount: 0,
      unresolvedLeadCount: 0,
      sourceOutcomes: [...completing, ...(outcomes === completing ? [] : outcomes)],
      anyWorkDispatched: true,
    });
    const statement = renderNoMatchStatement({
      sourceCount: 11,
      languages: ['en', 'es'],
      jurisdictions: ['GB', 'CL'],
      enabledCategories: ['FRAUD_FINANCIAL_CRIME', 'BRIBERY_CORRUPTION'],
      taxonomyVersion: 14,
      policyVersion: 7,
      runAt: '2026-09-10T14:22:00.000Z',
      archiveHorizon: '2017-01-01',
      coverage: aggregate.coverage,
      failedSources: aggregate.failedSources,
      unmeasuredLanguages: [],
    });
    return {
      label,
      findings: aggregate.findings,
      coverage: aggregate.coverage,
      statementLines: statement.lines,
      failedSourceNames: aggregate.failedSources.map((s) => s.sourceName),
      // Stated, so the gate checks the claim and not only its wording. These runs found nothing
      // and say so; the sample below is the one that does not.
      findingCount: aggregate.findingCounts.total,
      unresolvedLeadCount: aggregate.findingCounts.unresolvedLeads,
    };
  };

  return [build('incomplete-run', failing), build('complete-run', completing)];
}

function expectPassed(result: InvariantResult): void {
  const detail = result.violations.map((v) => `  ${v.caseId}: ${v.detail}`).join('\n');
  expect(result.passed, `${result.id} violations:\n${detail}`).toBe(true);
  expect(result.casesChecked).toBeGreaterThan(0);
}

describe('I1-I10 release-gating invariants', () => {
  it('I1 — severity, authority and article count never raise Axis A', () => {
    expectPassed(checkI1(SEED_DATASET));
  });

  it('I2 — a strong identifier contradiction is never overridden automatically', () => {
    expectPassed(checkI2(SEED_DATASET));
  });

  it('I3 — COMPANY_ONLY never produces a personal adverse finding at any band', () => {
    expectPassed(checkI3(SEED_DATASET));
  });

  it('I4 — a stage is never displayed above the stage its span establishes', () => {
    expectPassed(checkI4(SEED_DATASET));
  });

  it('I5 — settlement is never an admission, civil is never criminal', () => {
    expectPassed(checkI5(SEED_DATASET));
  });

  it('I6 — syndicated copies never increase the independence count', () => {
    expectPassed(checkI6(SEED_DATASET));
  });

  it('I7 — outcomes always attach and are never suppressed as duplicates', () => {
    expectPassed(checkI7(SEED_DATASET));
  });

  it('I8 — no uncalibrated numeric probability is displayable', () => {
    expectPassed(checkI8(SEED_DATASET));
  });

  it('I9 — no composite person-level risk score is produced', () => {
    expectPassed(checkI9(SEED_DATASET));
  });

  it('I10 — NO_MATCHES_FOUND always carries coverage state and failed sources', () => {
    expectPassed(checkI10(noMatchSamples()));
  });

  it('I10 — NO_MATCHES_FOUND is refused outright by a run that is returning a finding', () => {
    // The shape that reached production: a perfectly worded no-match statement, naming its
    // coverage and every failed source, on a run serving an AMBIGUOUS finding from `/findings`.
    // Every wording check the invariant used to make passes here. The claim is still false.
    const [honest] = noMatchSamples();
    expect(honest).toBeDefined();

    const contradicting = checkI10([
      { ...(honest as NoMatchRunSample), label: 'holds-an-ambiguous-finding', findingCount: 1 },
    ]);

    expect(contradicting.passed).toBe(false);
    expect(contradicting.violations.map((v) => v.detail).join('\n')).toContain('finding(s)');
  });

  it('I10 — NO_MATCHES_FOUND is refused by a run holding an unresolved lead', () => {
    const [honest] = noMatchSamples();
    const result = checkI10([
      { ...(honest as NoMatchRunSample), label: 'holds-a-lead', unresolvedLeadCount: 3 },
    ]);
    expect(result.passed).toBe(false);
  });

  it('the full harness passes and reports all ten invariants', () => {
    const report = runAllInvariants(SEED_DATASET, noMatchSamples());
    expect(report.results).toHaveLength(10);
    expect(report.datasetVersion).toBe(SEED_DATASET.datasetVersion);
    for (const r of report.results) {
      expect(r.statement).toBe(INVARIANT_STATEMENTS[r.id]);
    }
    expect(
      report.passed,
      JSON.stringify(
        report.results.filter((r) => !r.passed),
        null,
        2,
      ),
    ).toBe(true);
  });
});

describe('the seed dataset agrees with the banding engine', () => {
  it.each(SEED_DATASET.cases.map((c) => [c.caseId, c] as const))(
    '%s bands as its label says',
    (_caseId, labelled) => {
      const banded = runCase(labelled);
      expect(
        banded.band,
        `${labelled.caseId} (${labelled.note})\n${banded.rationale.join('\n')}`,
      ).toBe(labelled.label.band);
    },
  );

  it('every hard-negative kind required by FR-16 is represented', () => {
    const kinds = new Set(SEED_DATASET.cases.flatMap((c) => c.kinds));
    for (const required of [
      'COMMON_NAME',
      'SPARSE_IDENTITY',
      'PERSON_VS_COMPANY',
      'VICTIM',
      'WITNESS',
      'PLAINTIFF',
      'NAMESAKE_CONTRADICTING_DOB',
      'SYNDICATION_FAMILY',
      'PROCEDURAL_CHANGE_OVER_TIME',
      'CORRECTION',
      'ACQUITTAL',
    ] as const) {
      expect(kinds, `dataset is missing hard-negative kind ${required}`).toContain(required);
    }
  });

  it('no victim, witness or plaintiff case ever bands as an adverse finding', () => {
    const neverAdverse = SEED_DATASET.cases.filter((c) =>
      (['VICTIM', 'WITNESS', 'PLAINTIFF_CLAIMANT'] as const).includes(
        c.label.partyRole as 'VICTIM',
      ),
    );
    expect(neverAdverse.length).toBeGreaterThan(0);
    for (const c of neverAdverse) {
      expect(runCase(c).band, c.caseId).toBe('LEAD_ONLY');
    }
  });
});
