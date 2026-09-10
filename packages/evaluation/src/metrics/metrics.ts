/**
 * FR-16 metrics.
 *
 * Reported on the held-out split only. Note in particular `endToEndRecall`, which counts
 * *discovery misses* — a case that was never retrieved is a miss, not an absence. Measuring
 * recall over "articles we already fetched" is the standard way to publish a flattering
 * number that says nothing about whether the product finds things.
 */

import type { EvidenceBand, IdentityGrade, PartyRole } from '@erly/adverse-domain';

import type { LabelledCase } from '../dataset/types.js';

/** What the pipeline actually produced for one case. */
export interface CaseOutcome {
  readonly caseId: string;
  /** False when discovery never surfaced the case at all — an end-to-end recall miss. */
  readonly discovered: boolean;
  readonly identity: IdentityGrade;
  readonly partyRole: PartyRole;
  readonly proceduralStage: string;
  readonly attribution: string;
  readonly band: EvidenceBand;
  readonly independenceCount: number;
  /** Number of FR-07 span validations that rejected an assertion for this case. */
  readonly spanValidationFailures: number;
  readonly assertionsAttempted: number;
  /** Source that contributed the finding, for per-source contribution. */
  readonly contributingSourceIds: readonly string[];
}

export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
}

function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

/** Bands that assert a connection between the subject and adverse conduct. */
const POSITIVE_BANDS: ReadonlySet<EvidenceBand> = new Set<EvidenceBand>([
  'CORROBORATED',
  'SUPPORTED',
]);

export interface EvaluationMetrics {
  readonly split: 'TUNING' | 'HELD_OUT';
  readonly caseCount: number;
  /** Of the cases we asserted as the subject, how many were actually the subject. */
  readonly identityPrecision: Ratio;
  /** Of the cases that were actually the subject, how many did we assert. */
  readonly identityRecall: Ratio;
  /** Includes discovery misses. The headline recall figure. */
  readonly endToEndRecall: Ratio;
  readonly eventRelevancePrecision: Ratio;
  readonly proceduralStageAccuracy: Ratio;
  readonly partyRoleAccuracy: Ratio;
  /** Measured separately because misclassifying these is the most harmful error (FR-16). */
  readonly victimRoleAccuracy: Ratio;
  readonly witnessRoleAccuracy: Ratio;
  readonly attributionAccuracy: Ratio;
  readonly bandAccuracy: Ratio;
  readonly clusterMergeErrorRate: Ratio;
  readonly clusterSplitErrorRate: Ratio;
  readonly spanValidationFailureRate: Ratio;
  readonly unresolvedRate: Ratio;
  readonly reviewerOverturnRate: Ratio;
  readonly perSourceContribution: readonly PerSourceContribution[];
}

export interface PerSourceContribution {
  readonly sourceId: string;
  /** Findings this source contributed to. */
  readonly findings: number;
  /** Findings only this source contributed to — what would be lost if it went away. */
  readonly uniqueFindings: number;
}

export interface ClusterErrorCounts {
  /** Pairs merged that should have stayed separate. */
  readonly wrongMerges: number;
  /** Pairs kept separate that should have merged. */
  readonly wrongSplits: number;
  readonly pairsCompared: number;
}

export interface ReviewerOverturnCounts {
  readonly overturned: number;
  readonly reviewed: number;
}

export interface MetricsInput {
  readonly split: 'TUNING' | 'HELD_OUT';
  readonly cases: readonly LabelledCase[];
  readonly outcomes: readonly CaseOutcome[];
  readonly clusterErrors: ClusterErrorCounts;
  readonly reviewerOverturns: ReviewerOverturnCounts;
}

export function computeMetrics(input: MetricsInput): EvaluationMetrics {
  const byCaseId = new Map(input.outcomes.map((o) => [o.caseId, o]));

  let identityTruePositives = 0;
  let identityAsserted = 0;
  let identityActual = 0;
  let discoverableCases = 0;
  let discovered = 0;
  let relevantAsserted = 0;
  let relevantCorrect = 0;
  let stageCorrect = 0;
  let stageComparable = 0;
  let roleCorrect = 0;
  let roleComparable = 0;
  let victimCorrect = 0;
  let victimTotal = 0;
  let witnessCorrect = 0;
  let witnessTotal = 0;
  let attributionCorrect = 0;
  let bandCorrect = 0;
  let unresolved = 0;
  let spanFailures = 0;
  let assertionsAttempted = 0;

  const sourceFindings = new Map<string, number>();
  const sourceUnique = new Map<string, number>();

  for (const c of input.cases) {
    const outcome = byCaseId.get(c.caseId);

    if (c.label.discoverable) {
      discoverableCases++;
      if (outcome?.discovered === true) {
        discovered++;
      }
    }

    if (outcome === undefined) {
      continue;
    }

    const labelSaysSubject = c.label.identity === 'CORROBORATED' || c.label.identity === 'PARTIAL';
    const weSaySubject = outcome.identity === 'CORROBORATED' || outcome.identity === 'PARTIAL';
    if (weSaySubject) {
      identityAsserted++;
    }
    if (labelSaysSubject) {
      identityActual++;
    }
    if (weSaySubject && labelSaysSubject) {
      identityTruePositives++;
    }

    if (POSITIVE_BANDS.has(outcome.band)) {
      relevantAsserted++;
      if (POSITIVE_BANDS.has(c.label.band)) {
        relevantCorrect++;
      }
    }

    stageComparable++;
    if (outcome.proceduralStage === c.label.proceduralStage) {
      stageCorrect++;
    }

    roleComparable++;
    if (outcome.partyRole === c.label.partyRole) {
      roleCorrect++;
    }

    if (c.label.partyRole === 'VICTIM') {
      victimTotal++;
      if (outcome.partyRole === 'VICTIM') {
        victimCorrect++;
      }
    }
    if (c.label.partyRole === 'WITNESS') {
      witnessTotal++;
      if (outcome.partyRole === 'WITNESS') {
        witnessCorrect++;
      }
    }

    if (outcome.attribution === c.label.attribution) {
      attributionCorrect++;
    }
    if (outcome.band === c.label.band) {
      bandCorrect++;
    }
    if (outcome.band === 'AMBIGUOUS' || outcome.identity === 'WEAK') {
      unresolved++;
    }

    spanFailures += outcome.spanValidationFailures;
    assertionsAttempted += outcome.assertionsAttempted;

    for (const sourceId of outcome.contributingSourceIds) {
      sourceFindings.set(sourceId, (sourceFindings.get(sourceId) ?? 0) + 1);
    }
    const [only] = outcome.contributingSourceIds;
    if (outcome.contributingSourceIds.length === 1 && only !== undefined) {
      sourceUnique.set(only, (sourceUnique.get(only) ?? 0) + 1);
    }
  }

  const perSourceContribution: PerSourceContribution[] = [...sourceFindings.keys()]
    .sort()
    .map((sourceId) => ({
      sourceId,
      findings: sourceFindings.get(sourceId) ?? 0,
      uniqueFindings: sourceUnique.get(sourceId) ?? 0,
    }));

  return {
    split: input.split,
    caseCount: input.cases.length,
    identityPrecision: ratio(identityTruePositives, identityAsserted),
    identityRecall: ratio(identityTruePositives, identityActual),
    endToEndRecall: ratio(discovered, discoverableCases),
    eventRelevancePrecision: ratio(relevantCorrect, relevantAsserted),
    proceduralStageAccuracy: ratio(stageCorrect, stageComparable),
    partyRoleAccuracy: ratio(roleCorrect, roleComparable),
    victimRoleAccuracy: ratio(victimCorrect, victimTotal),
    witnessRoleAccuracy: ratio(witnessCorrect, witnessTotal),
    attributionAccuracy: ratio(attributionCorrect, input.outcomes.length),
    bandAccuracy: ratio(bandCorrect, input.outcomes.length),
    clusterMergeErrorRate: ratio(
      input.clusterErrors.wrongMerges,
      input.clusterErrors.pairsCompared,
    ),
    clusterSplitErrorRate: ratio(
      input.clusterErrors.wrongSplits,
      input.clusterErrors.pairsCompared,
    ),
    spanValidationFailureRate: ratio(spanFailures, assertionsAttempted),
    unresolvedRate: ratio(unresolved, input.outcomes.length),
    reviewerOverturnRate: ratio(
      input.reviewerOverturns.overturned,
      input.reviewerOverturns.reviewed,
    ),
    perSourceContribution,
  };
}

/** Render metrics as a stable Markdown table for `docs/` evidence. */
export function renderMetricsTable(metrics: EvaluationMetrics): string {
  const rows: readonly (readonly [string, Ratio])[] = [
    ['Identity precision', metrics.identityPrecision],
    ['Identity recall', metrics.identityRecall],
    ['End-to-end recall (incl. discovery misses)', metrics.endToEndRecall],
    ['Event relevance precision', metrics.eventRelevancePrecision],
    ['Procedural stage accuracy', metrics.proceduralStageAccuracy],
    ['Party role accuracy', metrics.partyRoleAccuracy],
    ['Party role accuracy — victim cases', metrics.victimRoleAccuracy],
    ['Party role accuracy — witness cases', metrics.witnessRoleAccuracy],
    ['Attribution accuracy', metrics.attributionAccuracy],
    ['Band accuracy', metrics.bandAccuracy],
    ['Cluster merge error rate', metrics.clusterMergeErrorRate],
    ['Cluster split error rate', metrics.clusterSplitErrorRate],
    ['Span validation failure rate', metrics.spanValidationFailureRate],
    ['Unresolved rate', metrics.unresolvedRate],
    ['Reviewer overturn rate', metrics.reviewerOverturnRate],
  ];

  const body = rows
    .map(([name, r]) => {
      const value = r.value === null ? 'n/a' : `${(r.value * 100).toFixed(1)}%`;
      return `| ${name} | ${value} | ${String(r.numerator)}/${String(r.denominator)} |`;
    })
    .join('\n');

  return [
    `Split: ${metrics.split} — ${String(metrics.caseCount)} cases`,
    '',
    '| Metric | Value | n |',
    '| :---- | :---- | :---- |',
    body,
  ].join('\n');
}
