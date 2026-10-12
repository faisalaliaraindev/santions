/** FR-16 dataset splitting and metrics. */

import { describe, expect, it } from 'vitest';

import { SEED_DATASET } from '../../src/dataset/seed.js';
import {
  assertNoLeakage,
  leakageSafeGroups,
  splitDataset,
  splitOf,
} from '../../src/dataset/split.js';
import { computeMetrics, renderMetricsTable, type CaseOutcome } from '../../src/metrics/metrics.js';
import { runCase } from '../../src/invariants/harness.js';
import type { LabelledCase, LabelledDataset } from '../../src/dataset/types.js';

describe('splitDataset', () => {
  it('produces a leakage-free split of the seed dataset', () => {
    const split = splitDataset(SEED_DATASET);
    expect(() => {
      assertNoLeakage(split);
    }).not.toThrow();
    expect(split.tuning.length + split.heldOut.length).toBe(SEED_DATASET.cases.length);
  });

  it('is deterministic across runs', () => {
    const a = splitDataset(SEED_DATASET);
    const b = splitDataset(SEED_DATASET);
    expect(a.heldOut.map((c) => c.caseId)).toEqual(b.heldOut.map((c) => c.caseId));
  });

  it('keeps a syndication family on one side of the split', () => {
    const split = splitDataset(SEED_DATASET);
    const syndicated = SEED_DATASET.cases.filter((c) => c.kinds.includes('SYNDICATION_FAMILY'));
    expect(syndicated.length).toBeGreaterThan(0);
    for (const c of syndicated) {
      expect(splitOf(split, c.caseId)).not.toBeNull();
    }
  });

  it('unions cases that share a syndication family even across different entities', () => {
    const shared: LabelledDataset = {
      datasetVersion: 'test',
      cases: SEED_DATASET.cases.slice(0, 2).map((c, i) => ({
        ...c,
        caseId: `X${String(i)}`,
        entityId: `E${String(i)}`,
        documents: c.documents.map((d) => ({ ...d, syndicationFamilyId: 'shared-wire' })),
      })),
    };
    const groups = leakageSafeGroups(shared.cases);
    // One group containing both cases, because they republish the same wire story.
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);

    const split = splitDataset(shared);
    expect(() => {
      assertNoLeakage(split);
    }).not.toThrow();
  });

  it('assertNoLeakage detects a deliberately leaked split', () => {
    const [first] = SEED_DATASET.cases;
    const leaked = { tuning: [first!], heldOut: [first!], groupCount: 1 };
    expect(() => {
      assertNoLeakage(leaked);
    }).toThrow(/leaks across tuning and held-out/);
  });

  it('returns null for a case that is in neither side', () => {
    expect(splitOf(splitDataset(SEED_DATASET), 'not-a-case')).toBeNull();
  });
});

describe('computeMetrics', () => {
  /** Build an outcome that agrees perfectly with the label — a "perfect run". */
  function perfectOutcome(c: LabelledCase): CaseOutcome {
    const banded = runCase(c);
    return {
      caseId: c.caseId,
      discovered: true,
      identity: c.label.identity,
      partyRole: c.label.partyRole,
      proceduralStage: c.label.proceduralStage,
      attribution: c.label.attribution,
      band: banded.band,
      independenceCount: c.label.independenceCount,
      spanValidationFailures: 0,
      assertionsAttempted: 1,
      contributingSourceIds: c.documents.map((d) => d.documentId),
    };
  }

  const cases = SEED_DATASET.cases;

  it('reports perfect scores for a run that agrees with every label', () => {
    const metrics = computeMetrics({
      split: 'HELD_OUT',
      cases,
      outcomes: cases.map(perfectOutcome),
      clusterErrors: { wrongMerges: 0, wrongSplits: 0, pairsCompared: 50 },
      reviewerOverturns: { overturned: 0, reviewed: 20 },
    });
    expect(metrics.endToEndRecall.value).toBe(1);
    expect(metrics.partyRoleAccuracy.value).toBe(1);
    expect(metrics.victimRoleAccuracy.value).toBe(1);
    expect(metrics.witnessRoleAccuracy.value).toBe(1);
    expect(metrics.bandAccuracy.value).toBe(1);
  });

  it('counts a discovery miss against end-to-end recall, not merely as an absence', () => {
    const outcomes = cases.map(perfectOutcome);
    // Drop the first case entirely: discovery never surfaced it.
    const metrics = computeMetrics({
      split: 'HELD_OUT',
      cases,
      outcomes: outcomes.slice(1),
      clusterErrors: { wrongMerges: 0, wrongSplits: 0, pairsCompared: 50 },
      reviewerOverturns: { overturned: 0, reviewed: 20 },
    });
    expect(metrics.endToEndRecall.value).toBeLessThan(1);
    expect(metrics.endToEndRecall.denominator).toBe(
      cases.filter((c) => c.label.discoverable).length,
    );
  });

  it('measures victim and witness role accuracy separately', () => {
    const outcomes = cases.map((c) => {
      const base = perfectOutcome(c);
      // Simulate the classic failure: a victim classified as the accused.
      return c.label.partyRole === 'VICTIM'
        ? { ...base, partyRole: 'ACCUSED_DEFENDANT_CRIMINAL' as const }
        : base;
    });
    const metrics = computeMetrics({
      split: 'HELD_OUT',
      cases,
      outcomes,
      clusterErrors: { wrongMerges: 0, wrongSplits: 0, pairsCompared: 50 },
      reviewerOverturns: { overturned: 0, reviewed: 20 },
    });
    expect(metrics.victimRoleAccuracy.value).toBe(0);
    expect(metrics.witnessRoleAccuracy.value).toBe(1);
    // Aggregate role accuracy barely moves — which is exactly why these are reported apart.
    expect(metrics.partyRoleAccuracy.value).toBeGreaterThan(0.8);
  });

  it('reports null rather than zero for a metric with no denominator', () => {
    const metrics = computeMetrics({
      split: 'HELD_OUT',
      cases: [],
      outcomes: [],
      clusterErrors: { wrongMerges: 0, wrongSplits: 0, pairsCompared: 0 },
      reviewerOverturns: { overturned: 0, reviewed: 0 },
    });
    expect(metrics.identityPrecision.value).toBeNull();
    expect(metrics.reviewerOverturnRate.value).toBeNull();
  });

  it('attributes unique findings to the only source that produced them', () => {
    const outcomes = cases.map((c) => ({ ...perfectOutcome(c), contributingSourceIds: ['solo'] }));
    const metrics = computeMetrics({
      split: 'HELD_OUT',
      cases,
      outcomes,
      clusterErrors: { wrongMerges: 0, wrongSplits: 0, pairsCompared: 1 },
      reviewerOverturns: { overturned: 0, reviewed: 1 },
    });
    const solo = metrics.perSourceContribution.find((s) => s.sourceId === 'solo');
    expect(solo?.uniqueFindings).toBe(cases.length);
  });

  it('renders a stable Markdown table for the evidence docs', () => {
    const metrics = computeMetrics({
      split: 'HELD_OUT',
      cases,
      outcomes: cases.map(perfectOutcome),
      clusterErrors: { wrongMerges: 1, wrongSplits: 2, pairsCompared: 100 },
      reviewerOverturns: { overturned: 1, reviewed: 20 },
    });
    const table = renderMetricsTable(metrics);
    expect(table).toContain('| Metric | Value | n |');
    expect(table).toContain('End-to-end recall (incl. discovery misses)');
    expect(table).toContain('Party role accuracy — victim cases');
    expect(table).toContain('Split: HELD_OUT');
  });
});
