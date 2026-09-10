/**
 * FR-11 — "Finding attributes shown instead of a score".
 *
 * There is deliberately no composite figure here (invariant I9). Each attribute is shown
 * separately so a reviewer can see *why* something is in front of them, and can disagree
 * with one dimension without discarding the others.
 */

import type { OutcomeStatus } from '../stages/transitions.js';
import type { StageValue } from '../stages/ladder.js';
import type { AdverseCategory } from '../taxonomy/categories.js';
import type { PreciseDate } from '../tenure/tenure.js';
import type { EvidenceBand } from './bands.js';

export type SubjectCentrality = 'PROTAGONIST' | 'SIGNIFICANT_MENTION' | 'PASSING_MENTION';

export interface FindingAttributes {
  readonly band: EvidenceBand;
  readonly category: AdverseCategory | null;
  /** From the pinned taxonomy version. Displayed; never multiplied into anything. */
  readonly categorySeverityWeight: 1 | 2 | 3 | 4 | 5 | null;
  readonly proceduralStage: StageValue;
  /** Age of the *event*, in days. Publication date is shown separately and never substituted. */
  readonly eventAgeDays: number | null;
  readonly eventDate: PreciseDate;
  readonly publicationDate: PreciseDate;
  readonly subjectCentrality: SubjectCentrality;
  readonly independenceCount: number;
  readonly outcomeStatus: OutcomeStatus;
}

/**
 * Whole days between two dates, or null when either is unknown or imprecise beyond MONTH.
 * Returns null rather than a guess — FR-07 forbids backfilling a missing date.
 */
export function eventAgeInDays(eventDate: PreciseDate, asOf: Date): number | null {
  if (eventDate.value === null || eventDate.precision === 'UNKNOWN') {
    return null;
  }
  const t = new Date(`${eventDate.value.slice(0, 10)}T00:00:00.000Z`).getTime();
  if (Number.isNaN(t)) {
    return null;
  }
  return Math.floor((asOf.getTime() - t) / 86_400_000);
}

/**
 * Invariant I8 guard: no numeric probability is displayed unless it was calibrated on
 * held-out labelled data and carries its rule version and calibration scope.
 *
 * The default answer is no (open decision D9), so the only way a number reaches a surface is
 * through a `CalibratedProbability` that names its calibration.
 */
export interface CalibratedProbability {
  readonly value: number;
  readonly rulesVersion: string;
  /** e.g. "en / GB / conviction reports, held-out split of evaluation run 2026-09-01". */
  readonly calibrationScope: string;
  readonly evaluationRunId: string;
  readonly heldOutSampleSize: number;
}

export function isDisplayableProbability(
  candidate: CalibratedProbability | null,
): candidate is CalibratedProbability {
  return (
    candidate !== null &&
    candidate.evaluationRunId.length > 0 &&
    candidate.calibrationScope.length > 0 &&
    candidate.rulesVersion.length > 0 &&
    candidate.heldOutSampleSize > 0 &&
    candidate.value >= 0 &&
    candidate.value <= 1
  );
}
