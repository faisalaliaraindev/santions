/**
 * FR-08 Axis C — event classification.
 *
 * "What conduct, in what role, at what stage, named by whom?"
 *
 * Axis C is the only axis that describes the *event*. It carries no opinion about whether
 * the subject is the person named (Axis A) or connected to the entity (Axis B).
 */

import type { PartyRole } from '../roles/party-roles.js';
import {
  isNeverAdverseRole,
  isAdverseRole,
  roleCapsBandAtAmbiguous,
} from '../roles/party-roles.js';
import { STAGE_UNSPECIFIED, stageAtLeast, type StageValue } from '../stages/ladder.js';
import type { AdverseCategory } from '../taxonomy/categories.js';
import type { ExclusionReason } from '../taxonomy/categories.js';
import type { PreciseDate } from '../tenure/tenure.js';

export interface AxisCInput {
  readonly category: AdverseCategory | null;
  readonly partyRole: PartyRole;
  readonly proceduralStage: StageValue;
  /** The body that named the conduct, e.g. a prosecutor or regulator. Null when unstated. */
  readonly namingAuthority: string | null;
  /** FR-07: four distinct date fields, each with declared precision. Never backfilled. */
  readonly eventDate: PreciseDate;
  readonly publicationDate: PreciseDate;
  readonly updateDate: PreciseDate;
  readonly retrievalDate: PreciseDate;
  /** True when every cited span passed FR-07 validation. */
  readonly spansValidated: boolean;
  /** Set when the FR-03 exclusion list matched. An excluded event never becomes a finding. */
  readonly exclusionReason: ExclusionReason | null;
  /** FR-11 finding attribute. Derived from mention density and position, not from severity. */
  readonly subjectCentrality: 'PROTAGONIST' | 'SIGNIFICANT_MENTION' | 'PASSING_MENTION';
}

export interface AxisCResult {
  readonly category: AdverseCategory | null;
  readonly partyRole: PartyRole;
  readonly proceduralStage: StageValue;
  readonly namingAuthority: string | null;
  /** False when the event cannot support any adverse finding, whatever the other axes say. */
  readonly isValidAdverseEvent: boolean;
  /** Ceiling this axis imposes on the band, or null when it imposes none. */
  readonly bandCeiling: 'AMBIGUOUS' | 'LEAD_ONLY' | null;
  readonly rationale: readonly string[];
}

export function classifyEvent(input: AxisCInput): AxisCResult {
  const rationale: string[] = [];
  const base = {
    category: input.category,
    partyRole: input.partyRole,
    proceduralStage: input.proceduralStage,
    namingAuthority: input.namingAuthority,
  };

  if (input.exclusionReason !== null) {
    rationale.push(`Excluded at classification time: ${input.exclusionReason}.`);
    return { ...base, isValidAdverseEvent: false, bandCeiling: 'LEAD_ONLY', rationale };
  }

  // VICTIM, WITNESS, PLAINTIFF_CLAIMANT and commentator roles are never adverse (T17).
  if (isNeverAdverseRole(input.partyRole)) {
    rationale.push(`Party role ${input.partyRole} is never adverse; excluded from findings.`);
    return { ...base, isValidAdverseEvent: false, bandCeiling: 'LEAD_ONLY', rationale };
  }

  if (!input.spansValidated) {
    rationale.push('No validated span supports this assertion; lead only (FR-07).');
    return { ...base, isValidAdverseEvent: false, bandCeiling: 'LEAD_ONLY', rationale };
  }

  if (input.category === null) {
    rationale.push('No enabled adverse category was established for this event.');
    return { ...base, isValidAdverseEvent: false, bandCeiling: 'LEAD_ONLY', rationale };
  }

  // Stage 0 is a lead by definition (ladder display rule).
  if (input.proceduralStage === 'RUMOUR_UNATTRIBUTED') {
    rationale.push('Stage 0 (rumour / unattributed) is a lead only, never a supported finding.');
    return { ...base, isValidAdverseEvent: false, bandCeiling: 'LEAD_ONLY', rationale };
  }

  if (roleCapsBandAtAmbiguous(input.partyRole)) {
    rationale.push('Party role is UNSPECIFIED; no finding advances beyond AMBIGUOUS (FR-09).');
    return { ...base, isValidAdverseEvent: true, bandCeiling: 'AMBIGUOUS', rationale };
  }

  if (input.proceduralStage === STAGE_UNSPECIFIED) {
    rationale.push('No span established a procedural stage; band capped at AMBIGUOUS (I4).');
    return { ...base, isValidAdverseEvent: true, bandCeiling: 'AMBIGUOUS', rationale };
  }

  rationale.push(
    `Category ${input.category}, role ${input.partyRole}, stage ${input.proceduralStage}` +
      (input.namingAuthority !== null
        ? `, named by ${input.namingAuthority}`
        : ', naming authority unstated'),
  );
  return { ...base, isValidAdverseEvent: true, bandCeiling: null, rationale };
}

/** FR-11: CORROBORATED requires stage >= 5 *and* an adverse role. */
export function meetsCorroboratedEvent(result: AxisCResult): boolean {
  return (
    result.isValidAdverseEvent &&
    stageAtLeast(result.proceduralStage, 5) &&
    isAdverseRole(result.partyRole)
  );
}

/** FR-11: SUPPORTED requires stage >= 3 and a validated span. */
export function meetsSupportedEvent(result: AxisCResult): boolean {
  return result.isValidAdverseEvent && stageAtLeast(result.proceduralStage, 3);
}
