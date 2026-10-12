/**
 * FR-11 / FR-16 — the I1-I10 invariant harness.
 *
 * Each invariant is a named, release-gating test. A failure blocks release. The harness runs
 * with no I/O so it can gate CI on every pull request (section 10.4), and the *same* harness
 * is re-run at G7 against axis inputs produced by the real pipeline.
 *
 * An invariant is not a metric. A metric can regress by a point and still ship; an invariant
 * failing means the system is capable of stating something it has no basis to state.
 */

import {
  assignBand,
  classifyEvent,
  computeAuthority,
  decideClustering,
  gradeAttribution,
  gradeIdentity,
  isDisplayableProbability,
  mandatoryDisplayRule,
  roleProceduralFamily,
  stageRung,
  type AxisCInput,
  type BandingResult,
  type CalibratedProbability,
  type ClusterCandidate,
} from '@adverse-search/domain';

import { SEED_RULES_VERSION } from '../dataset/scenario.js';
import type { LabelledCase, LabelledDataset } from '../dataset/types.js';

export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7' | 'I8' | 'I9' | 'I10';

export interface InvariantViolation {
  readonly caseId: string;
  readonly detail: string;
}

export interface InvariantResult {
  readonly id: InvariantId;
  readonly statement: string;
  readonly passed: boolean;
  readonly casesChecked: number;
  readonly violations: readonly InvariantViolation[];
}

export const INVARIANT_STATEMENTS: Readonly<Record<InvariantId, string>> = {
  I1: 'Event severity, publisher authority and article count never raise Axis A.',
  I2: 'A strong identifier contradiction is overridden only by an explicit, reasoned human review recorded as possible source error.',
  I3: 'A COMPANY_ONLY attribution never produces a personal adverse finding, at any band.',
  I4: 'A procedural stage is never displayed higher than the stage its span establishes.',
  I5: 'A settlement never renders as an admission; a defendant role never renders as guilt; a civil claim never renders as a criminal matter.',
  I6: 'Syndicated copies never increase the independence count.',
  I7: 'An acquittal, dismissal, correction or retraction always attaches to its event and always displays at equal prominence.',
  I8: 'No numeric probability is displayed unless calibrated on held-out labelled data, carrying its rule version and calibration scope.',
  I9: 'No composite person-level risk score is produced.',
  I10: 'A run cannot report NO_MATCHES_FOUND without also reporting its coverage state and every failed source.',
};

/** Run the full four-axis pipeline for one labelled case, with no I/O. */
export function runCase(labelled: LabelledCase): BandingResult {
  const { axisA, axisB, axisC, sources } = labelled.scenario;
  return assignBand({
    axisA: gradeIdentity(axisA),
    axisB: gradeAttribution(axisB),
    axisC: classifyEvent(axisC),
    axisD: computeAuthority(sources),
    rulesVersion: SEED_RULES_VERSION,
  });
}

function result(
  id: InvariantId,
  casesChecked: number,
  violations: readonly InvariantViolation[],
): InvariantResult {
  return {
    id,
    statement: INVARIANT_STATEMENTS[id],
    passed: violations.length === 0,
    casesChecked,
    violations,
  };
}

/**
 * I1 — severity, authority and article count never raise Axis A.
 *
 * Tested by perturbation: re-run each case with the event escalated to a conviction, every
 * source promoted to Tier 1, and the source list duplicated tenfold. Axis A must be
 * byte-identical, because none of those inputs reaches it.
 */
export function checkI1(dataset: LabelledDataset): InvariantResult {
  const violations: InvariantViolation[] = [];

  for (const c of dataset.cases) {
    const base = gradeIdentity(c.scenario.axisA);

    const escalated: AxisCInput = {
      ...c.scenario.axisC,
      proceduralStage: 'CONVICTION_FINAL_JUDGMENT',
      partyRole: 'CONVICTED_SANCTIONED_PARTY',
      category: 'TERRORISM_VIOLENT_EXTREMISM',
    };
    const amplifiedSources = [
      ...c.scenario.sources,
      ...c.scenario.sources.map((s, i) => ({
        ...s,
        documentId: `${s.documentId}-amp-${String(i)}`,
        tier: 1 as const,
        issuingAuthorityId: `authority-amp-${String(i)}`,
        isSyndicatedCopy: false,
      })),
    ];

    const perturbedBand = assignBand({
      axisA: gradeIdentity(c.scenario.axisA),
      axisB: gradeAttribution(c.scenario.axisB),
      axisC: classifyEvent(escalated),
      axisD: computeAuthority(amplifiedSources),
      rulesVersion: SEED_RULES_VERSION,
    });

    if (perturbedBand.axes.identity !== base.grade) {
      violations.push({
        caseId: c.caseId,
        detail: `Axis A changed from ${base.grade} to ${perturbedBand.axes.identity} when only severity, authority and article count were escalated.`,
      });
    }
  }

  return result('I1', dataset.cases.length, violations);
}

/** I2 — a strong identifier contradiction is never overridden automatically. */
export function checkI2(dataset: LabelledDataset): InvariantResult {
  const violations: InvariantViolation[] = [];
  let checked = 0;

  for (const c of dataset.cases) {
    const hasStrongContradiction = c.scenario.axisA.factors.some(
      (f) => f.strength === 'STRONG' && f.direction === 'CONTRADICTING',
    );
    if (!hasStrongContradiction) {
      continue;
    }
    checked++;
    const banded = runCase(c);
    if (banded.axes.identity !== 'CONTRADICTED' || banded.band !== 'CONTRADICTED') {
      violations.push({
        caseId: c.caseId,
        detail: `Strong identifier contradiction present but Axis A is ${banded.axes.identity} and band is ${banded.band}.`,
      });
    }
  }

  // Also assert the general property: adding a strong contradiction to any case forces
  // CONTRADICTED, whatever else the case says.
  for (const c of dataset.cases) {
    checked++;
    const forced = gradeIdentity({
      ...c.scenario.axisA,
      factors: [
        ...c.scenario.axisA.factors,
        {
          kind: 'DOB_DIFFERS_BEYOND_PRECISION',
          strength: 'STRONG',
          direction: 'CONTRADICTING',
          span: { start: 0, end: 5 },
          detail: 'Injected strong contradiction',
        },
      ],
    });
    if (forced.grade !== 'CONTRADICTED') {
      violations.push({
        caseId: c.caseId,
        detail: `Injected strong contradiction did not force CONTRADICTED; got ${forced.grade}.`,
      });
    }
  }

  return result('I2', checked, violations);
}

/** I3 — COMPANY_ONLY never produces a personal adverse finding at any band. */
export function checkI3(dataset: LabelledDataset): InvariantResult {
  const violations: InvariantViolation[] = [];
  let checked = 0;

  for (const c of dataset.cases) {
    // Force COMPANY_ONLY attribution on every case and assert no personal finding results.
    checked++;
    const banded = assignBand({
      axisA: gradeIdentity(c.scenario.axisA),
      axisB: gradeAttribution({
        ...c.scenario.axisB,
        namesSubjectPersonally: false,
        companyInGraph: true,
        tenureLabel: 'DURING_TENURE',
        roleEvidence: null,
      }),
      axisC: classifyEvent(c.scenario.axisC),
      axisD: computeAuthority(c.scenario.sources),
      rulesVersion: SEED_RULES_VERSION,
    });

    const personalBands = ['CORROBORATED', 'SUPPORTED', 'AMBIGUOUS'];
    if (
      personalBands.includes(banded.band) ||
      (!banded.isCompanyLevel && banded.band === 'COMPANY_CONTEXT')
    ) {
      violations.push({
        caseId: c.caseId,
        detail: `COMPANY_ONLY attribution produced band ${banded.band} with isCompanyLevel=${String(banded.isCompanyLevel)}.`,
      });
    }
  }

  return result('I3', checked, violations);
}

/** I4 — a stage is never displayed higher than the stage its span establishes. */
export function checkI4(dataset: LabelledDataset): InvariantResult {
  const violations: InvariantViolation[] = [];
  let checked = 0;

  for (const c of dataset.cases) {
    checked++;
    // Remove span validation: the stage must not survive at its asserted rung.
    const unsupported = classifyEvent({ ...c.scenario.axisC, spansValidated: false });
    if (unsupported.isValidAdverseEvent || unsupported.bandCeiling !== 'LEAD_ONLY') {
      violations.push({
        caseId: c.caseId,
        detail: 'An assertion with no validated span produced a supportable adverse event.',
      });
    }

    const banded = runCase(c);
    if (stageRung(banded.axes.stage) > stageRung(c.scenario.axisC.proceduralStage)) {
      violations.push({
        caseId: c.caseId,
        detail: `Displayed stage ${banded.axes.stage} is above the extracted stage ${c.scenario.axisC.proceduralStage}.`,
      });
    }
  }

  return result('I4', checked, violations);
}

/**
 * I5 — a settlement never renders as an admission; a defendant role never renders as guilt;
 * a civil claim never renders as a criminal matter.
 *
 * Checked structurally: the mandatory display rule must be present on every stage a finding
 * can carry, and the procedural family of a civil role must never be CRIMINAL.
 */
export function checkI5(dataset: LabelledDataset): InvariantResult {
  const violations: InvariantViolation[] = [];
  let checked = 0;

  for (const c of dataset.cases) {
    checked++;
    const banded = runCase(c);

    if (banded.axes.stage !== 'UNSPECIFIED') {
      const rule = mandatoryDisplayRule(banded.axes.stage);
      if (rule === null || rule.length === 0) {
        violations.push({
          caseId: c.caseId,
          detail: `Stage ${banded.axes.stage} carries no mandatory display rule.`,
        });
      }
    }

    if (banded.axes.stage === 'SETTLEMENT_CONSENT_ORDER') {
      const rule = mandatoryDisplayRule('SETTLEMENT_CONSENT_ORDER') ?? '';
      if (!/never rendered as an admission/i.test(rule)) {
        violations.push({
          caseId: c.caseId,
          detail: 'Settlement stage display rule does not forbid rendering as an admission.',
        });
      }
    }

    const family = roleProceduralFamily(banded.axes.partyRole);
    if (banded.axes.partyRole === 'DEFENDANT_CIVIL' && family !== 'CIVIL') {
      violations.push({
        caseId: c.caseId,
        detail: `Civil defendant role mapped to procedural family ${family}.`,
      });
    }
  }

  return result('I5', checked, violations);
}

/** I6 — syndicated copies never increase the independence count. */
export function checkI6(dataset: LabelledDataset): InvariantResult {
  const violations: InvariantViolation[] = [];
  let checked = 0;

  for (const c of dataset.cases) {
    checked++;
    const base = computeAuthority(c.scenario.sources);

    // Add ten syndicated copies of every source. The count must not move.
    const withCopies = [
      ...c.scenario.sources,
      ...Array.from({ length: 10 }, (_, i) =>
        c.scenario.sources.map((s) => ({
          ...s,
          documentId: `${s.documentId}-copy-${String(i)}`,
          isSyndicatedCopy: true,
        })),
      ).flat(),
    ];
    const amplified = computeAuthority(withCopies);

    if (amplified.independenceCount !== base.independenceCount) {
      violations.push({
        caseId: c.caseId,
        detail: `Independence count moved from ${String(base.independenceCount)} to ${String(amplified.independenceCount)} after adding syndicated copies only.`,
      });
    }

    if (c.label.independenceCount !== base.independenceCount) {
      violations.push({
        caseId: c.caseId,
        detail: `Computed independence ${String(base.independenceCount)} disagrees with the label ${String(c.label.independenceCount)}.`,
      });
    }
  }

  return result('I6', checked, violations);
}

/** I7 — outcome documents always attach to their event and are never suppressed. */
export function checkI7(dataset: LabelledDataset): InvariantResult {
  const violations: InvariantViolation[] = [];
  let checked = 0;

  for (const c of dataset.cases) {
    checked++;
    const charge: ClusterCandidate = {
      documentId: `${c.caseId}-charge`,
      subjectId: c.entityId,
      companyId: null,
      category: c.label.category,
      proceduralStage: 'CHARGE_INDICTMENT',
      eventDate: '2024-05-14',
      canonicalUrl: `https://example.test/${c.caseId}/charge`,
      contentHash: `hash-${c.caseId}-charge`,
      nearDuplicateKey: `sim-${c.caseId}`,
      originatingNewsroomId: 'newsroom-a',
    };
    // Deliberately near-identical text and the same similarity key: a text-similarity-only
    // clusterer would collapse this acquittal into the charge and lose it.
    const acquittal: ClusterCandidate = {
      ...charge,
      documentId: `${c.caseId}-acquittal`,
      proceduralStage: 'ACQUITTAL_DISMISSAL_OVERTURNED',
      canonicalUrl: `https://example.test/${c.caseId}/acquittal`,
      contentHash: `hash-${c.caseId}-acquittal`,
      eventDate: '2025-02-11',
    };

    const decision = decideClustering(charge, acquittal);
    if (decision.action !== 'LINK_AS_OUTCOME') {
      violations.push({
        caseId: c.caseId,
        detail: `An acquittal following a charge was handled as ${decision.action} instead of LINK_AS_OUTCOME.`,
      });
    }

    for (const outcome of ['CORRECTION_RETRACTION', 'APPEAL_PENDING'] as const) {
      const d = decideClustering(charge, { ...acquittal, proceduralStage: outcome });
      if (d.action !== 'LINK_AS_OUTCOME') {
        violations.push({
          caseId: c.caseId,
          detail: `A ${outcome} document was handled as ${d.action} instead of LINK_AS_OUTCOME.`,
        });
      }
    }
  }

  return result('I7', checked, violations);
}

/** I8 — no numeric probability is displayed unless calibrated on held-out labelled data. */
export function checkI8(dataset: LabelledDataset): InvariantResult {
  const violations: InvariantViolation[] = [];

  const uncalibrated: readonly (CalibratedProbability | null)[] = [
    null,
    {
      value: 0.92,
      rulesVersion: '',
      calibrationScope: 'en/GB',
      evaluationRunId: 'r1',
      heldOutSampleSize: 40,
    },
    {
      value: 0.92,
      rulesVersion: 'banding-v1',
      calibrationScope: '',
      evaluationRunId: 'r1',
      heldOutSampleSize: 40,
    },
    {
      value: 0.92,
      rulesVersion: 'banding-v1',
      calibrationScope: 'en/GB',
      evaluationRunId: '',
      heldOutSampleSize: 40,
    },
    {
      value: 0.92,
      rulesVersion: 'banding-v1',
      calibrationScope: 'en/GB',
      evaluationRunId: 'r1',
      heldOutSampleSize: 0,
    },
    {
      value: 1.4,
      rulesVersion: 'banding-v1',
      calibrationScope: 'en/GB',
      evaluationRunId: 'r1',
      heldOutSampleSize: 40,
    },
  ];

  for (const [i, candidate] of uncalibrated.entries()) {
    if (isDisplayableProbability(candidate)) {
      violations.push({
        caseId: `I8-fixture-${String(i)}`,
        detail: 'An uncalibrated or malformed probability was accepted as displayable.',
      });
    }
  }

  // A fully specified calibration is displayable — the invariant forbids uncalibrated
  // numbers, not all numbers.
  const calibrated: CalibratedProbability = {
    value: 0.83,
    rulesVersion: 'banding-v1',
    calibrationScope: 'en / GB / conviction reports, held-out split',
    evaluationRunId: 'eval-2026-09-10',
    heldOutSampleSize: 120,
  };
  if (!isDisplayableProbability(calibrated)) {
    violations.push({
      caseId: 'I8-fixture-calibrated',
      detail: 'A fully calibrated probability was rejected; the guard is over-broad.',
    });
  }

  // No banding result may carry a numeric score field.
  for (const c of dataset.cases) {
    const banded = runCase(c) as unknown as Record<string, unknown>;
    for (const key of ['score', 'riskScore', 'confidence', 'probability']) {
      if (key in banded) {
        violations.push({
          caseId: c.caseId,
          detail: `Banding result exposes a numeric field "${key}".`,
        });
      }
    }
  }

  return result('I8', uncalibrated.length + 1 + dataset.cases.length, violations);
}

/** I9 — no composite person-level risk score is produced. */
export function checkI9(dataset: LabelledDataset): InvariantResult {
  const violations: InvariantViolation[] = [];

  for (const c of dataset.cases) {
    const banded = runCase(c);
    const flat = JSON.stringify(banded);
    // The band is a label, the independence count is a count, and the axes are enums.
    // Nothing in a banding result should present itself as an aggregate person-level figure.
    if (/"(riskScore|compositeScore|overallScore|adverseScore|personScore)"/i.test(flat)) {
      violations.push({
        caseId: c.caseId,
        detail: 'Banding result contains a composite person-level score field.',
      });
    }
    if (typeof (banded as unknown as { band: unknown }).band !== 'string') {
      violations.push({ caseId: c.caseId, detail: 'Band is not a categorical label.' });
    }
  }

  return result('I9', dataset.cases.length, violations);
}

/**
 * I10 — a run cannot report NO_MATCHES_FOUND without also reporting its coverage state and
 * every failed source.
 *
 * This one is checked against the run-aggregation and no-match-statement rules rather than
 * against cases, because it is a property of a run, not of a finding.
 */
export interface NoMatchRunSample {
  readonly label: string;
  readonly findings: string;
  readonly coverage: string;
  readonly statementLines: readonly string[];
  readonly failedSourceNames: readonly string[];
  /**
   * How many findings the run is **also** returning, across every band.
   *
   * The half of I10 that had no teeth. The invariant reads "a run cannot report
   * `NO_MATCHES_FOUND` without also reporting its coverage state and every failed source", and
   * everything it checked was about the *statement*. It never asked the prior question — whether
   * the run was entitled to say "no matches" at all — so a run holding an `AMBIGUOUS` finding
   * passed the gate while contradicting its own findings list.
   *
   * Optional so an existing sample compiles. Absent means "not stated", and a sample that does
   * not state it is not checked against it — the honest reading of a caller that has not supplied
   * the figure, rather than a claim that the figure is zero.
   */
  readonly findingCount?: number | undefined;
  /** Leads rejected with a reason. Also incompatible with a bare no-match. */
  readonly unresolvedLeadCount?: number | undefined;
}

export function checkI10(samples: readonly NoMatchRunSample[]): InvariantResult {
  const violations: InvariantViolation[] = [];

  for (const sample of samples) {
    if (sample.findings !== 'NO_MATCHES_FOUND') {
      continue;
    }
    // The prior question: may this run say "no matches" at all? A findings list that is not empty
    // answers no, and the findings are the evidence — they were fetched, extracted and banded.
    // Checked before the statement's wording, because a correctly worded statement of a false
    // claim is worse than a badly worded one.
    if (sample.findingCount !== undefined && sample.findingCount > 0) {
      violations.push({
        caseId: sample.label,
        detail:
          `NO_MATCHES_FOUND reported by a run that is returning ` +
          `${String(sample.findingCount)} finding(s). A band says how well evidence supports a ` +
          `connection; it never decides whether a finding exists.`,
      });
    }
    if (sample.unresolvedLeadCount !== undefined && sample.unresolvedLeadCount > 0) {
      violations.push({
        caseId: sample.label,
        detail:
          `NO_MATCHES_FOUND reported by a run holding ${String(sample.unresolvedLeadCount)} ` +
          `unresolved lead(s). A candidate that was looked at and rejected is not nothing found.`,
      });
    }

    const joined = sample.statementLines.join('\n');

    if (!joined.includes(sample.coverage)) {
      violations.push({
        caseId: sample.label,
        detail: `NO_MATCHES_FOUND reported without its coverage state (${sample.coverage}) in the statement.`,
      });
    }
    for (const name of sample.failedSourceNames) {
      if (!joined.includes(name)) {
        violations.push({
          caseId: sample.label,
          detail: `Failed source "${name}" is absent from the no-match statement.`,
        });
      }
    }
    if (/\b(clear|clean|no adverse media)\b/i.test(joined)) {
      violations.push({
        caseId: sample.label,
        detail: 'No-match statement uses the words "clear", "clean" or "no adverse media".',
      });
    }
  }

  return result('I10', samples.length, violations);
}

export interface InvariantReport {
  readonly datasetVersion: string;
  readonly results: readonly InvariantResult[];
  readonly passed: boolean;
}

export function runAllInvariants(
  dataset: LabelledDataset,
  noMatchSamples: readonly NoMatchRunSample[],
): InvariantReport {
  const results = [
    checkI1(dataset),
    checkI2(dataset),
    checkI3(dataset),
    checkI4(dataset),
    checkI5(dataset),
    checkI6(dataset),
    checkI7(dataset),
    checkI8(dataset),
    checkI9(dataset),
    checkI10(noMatchSamples),
  ];
  return {
    datasetVersion: dataset.datasetVersion,
    results,
    passed: results.every((r) => r.passed),
  };
}
