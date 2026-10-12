/**
 * FR-09 stage transition rules.
 *
 * Rules, verbatim from the specification:
 *  - a stage is only set from a span that establishes it;
 *  - stages never upgrade by inference;
 *  - stages may be superseded within a cluster while retaining full history;
 *  - an event at stage 3, 4 or 5 beyond a configured age without an outcome document is
 *    flagged OUTCOME_UNKNOWN and re-queried on every refresh.
 */

import {
  STAGE_UNSPECIFIED,
  isOutcomeStage,
  requiresOutcomeFollowUp,
  stageRung,
  type ProceduralStage,
  type StageValue,
} from './ladder.js';

/** A stage claim carries the span that establishes it, or it is not a stage claim. */
export interface StageClaim {
  readonly stage: ProceduralStage;
  /** Offsets into the normalised document text. Required — see FR-07 "Stage support". */
  readonly stageSpan: { readonly start: number; readonly end: number } | null;
  readonly documentId: string;
  readonly documentVersion: number;
  /** Publication date of the document making the claim (ISO 8601). */
  readonly publicationDate: string | null;
}

/**
 * Invariant I4: a procedural stage is never displayed higher than the stage its span
 * establishes. A claim with no stage span is downgraded to UNSPECIFIED, never kept at its
 * asserted rung.
 */
export function resolveSupportedStage(claims: readonly StageClaim[]): StageValue {
  const supported = claims.filter((c) => c.stageSpan !== null);
  const [first] = supported;
  if (first === undefined) {
    return STAGE_UNSPECIFIED;
  }
  // Highest *span-supported* rung. Unsupported claims contribute nothing at all.
  return supported.reduce<ProceduralStage>(
    (best, c) => (stageRung(c.stage) > stageRung(best) ? c.stage : best),
    first.stage,
  );
}

export type TransitionRejection =
  'NO_STAGE_SPAN' | 'INFERRED_UPGRADE_NOT_PERMITTED' | 'SAME_OR_LOWER_NON_OUTCOME';

export interface TransitionDecision {
  readonly accepted: boolean;
  readonly nextStage: StageValue;
  /** True when the new claim supersedes the current stage within the cluster. */
  readonly supersedes: boolean;
  readonly rejection: TransitionRejection | null;
}

/**
 * Decide whether a new stage claim may change an event's current stage.
 *
 * Outcome stages (appeal, acquittal, correction, spent) always attach even though their
 * rung ordering is not a severity ordering — an acquittal at rung 13 supersedes a
 * conviction at rung 9 because it resolves it, not because 13 > 9.
 */
export function applyStageClaim(current: StageValue, claim: StageClaim): TransitionDecision {
  if (claim.stageSpan === null) {
    // No span, no stage. This is the single most common route to overstating a matter.
    return { accepted: false, nextStage: current, supersedes: false, rejection: 'NO_STAGE_SPAN' };
  }

  if (isOutcomeStage(claim.stage)) {
    return { accepted: true, nextStage: claim.stage, supersedes: true, rejection: null };
  }

  // A non-outcome claim may only move the event up the ladder, and only on its own span.
  if (stageRung(claim.stage) > stageRung(current)) {
    return { accepted: true, nextStage: claim.stage, supersedes: true, rejection: null };
  }

  return {
    accepted: false,
    nextStage: current,
    supersedes: false,
    rejection: 'SAME_OR_LOWER_NON_OUTCOME',
  };
}

export interface OutcomeStatusInput {
  readonly stage: StageValue;
  /** Whether any linked document in the chain carries an outcome stage. */
  readonly hasOutcomeDocument: boolean;
  /** Whether F8 outcome queries have ever run for this event (FR-04). */
  readonly outcomeQueriesRun: boolean;
  /** Age of the event in days, from the event date. Null when the event date is unknown. */
  readonly eventAgeDays: number | null;
  /** Configured age after which an unresolved stage 3-5 event is flagged. */
  readonly outcomeUnknownAfterDays: number;
}

export type OutcomeStatus = 'RESOLVED' | 'UNDER_APPEAL' | 'OUTCOME_UNKNOWN' | 'OUTCOME_NOT_DUE';

/**
 * FR-11 finding attribute "outcome status", and the FR-13 dedicated queue.
 *
 * A finding whose outcome has never been checked is OUTCOME_UNKNOWN regardless of age —
 * that is the point of FR-04 F8 being mandatory.
 */
export function outcomeStatus(input: OutcomeStatusInput): OutcomeStatus {
  if (input.stage === 'APPEAL_PENDING') {
    return 'UNDER_APPEAL';
  }
  if (input.hasOutcomeDocument) {
    return 'RESOLVED';
  }
  if (!requiresOutcomeFollowUp(input.stage)) {
    return 'OUTCOME_NOT_DUE';
  }
  if (!input.outcomeQueriesRun) {
    return 'OUTCOME_UNKNOWN';
  }
  if (input.eventAgeDays !== null && input.eventAgeDays > input.outcomeUnknownAfterDays) {
    return 'OUTCOME_UNKNOWN';
  }
  return 'OUTCOME_NOT_DUE';
}
