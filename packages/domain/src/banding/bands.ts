/**
 * FR-11 — banding.
 *
 * A declarative, versioned rules engine, not a learned model. Rules are pinned to every
 * finding so a historical result can still explain itself under the version it ran on.
 *
 * The four axes are computed independently and combined *only* here. Their contributing
 * values remain visible after combination — the band is a summary of the axes, never a
 * replacement for them, and never a score (invariant I9).
 */

import {
  permitsPersonalFinding,
  type AttributionGrade,
  type AxisBResult,
} from '../attribution/axis-b.js';
import {
  meetsCorroboratedAuthority,
  meetsSupportedAuthority,
  type AxisDResult,
} from '../authority/axis-d.js';
import { meetsCorroboratedEvent, meetsSupportedEvent, type AxisCResult } from '../events/axis-c.js';
import type { AxisAResult, IdentityGrade } from '../identity/axis-a.js';

export const EVIDENCE_BANDS = [
  'CORROBORATED',
  'SUPPORTED',
  'AMBIGUOUS',
  'COMPANY_CONTEXT',
  'CONTRADICTED',
  'LEAD_ONLY',
] as const;

export type EvidenceBand = (typeof EVIDENCE_BANDS)[number];

/** Ordering used only to apply ceilings. It is not a risk ordering and is never displayed. */
const BAND_RANK: Readonly<Record<EvidenceBand, number>> = {
  LEAD_ONLY: 0,
  CONTRADICTED: 0,
  COMPANY_CONTEXT: 1,
  AMBIGUOUS: 2,
  SUPPORTED: 3,
  CORROBORATED: 4,
};

export interface BandingRuleVersion {
  readonly bandingRulesVersionId: string;
  readonly version: number;
  readonly activatedAt: string;
}

export interface BandingInput {
  readonly axisA: AxisAResult;
  readonly axisB: AxisBResult;
  readonly axisC: AxisCResult;
  readonly axisD: AxisDResult;
  readonly rulesVersion: BandingRuleVersion;
}

export interface BandingResult {
  readonly band: EvidenceBand;
  /** The four contributing values, retained verbatim next to the band (FR-08). */
  readonly axes: {
    readonly identity: IdentityGrade;
    readonly attribution: AttributionGrade;
    readonly stage: AxisCResult['proceduralStage'];
    readonly partyRole: AxisCResult['partyRole'];
    readonly authorityTier: AxisDResult['bestTier'];
    readonly independenceCount: number;
  };
  readonly rulesVersion: BandingRuleVersion;
  /** Every rule that fired, in order, for the evidence-detail explanation. */
  readonly rationale: readonly string[];
  /** True when the finding concerns a company rather than the person. */
  readonly isCompanyLevel: boolean;
}

function cap(band: EvidenceBand, ceiling: EvidenceBand): EvidenceBand {
  return BAND_RANK[band] > BAND_RANK[ceiling] ? ceiling : band;
}

/**
 * Apply the FR-11 band table.
 *
 * Evaluated as an ordered rule list. The first three rules are exits — CONTRADICTED,
 * LEAD_ONLY and COMPANY_ONLY attribution are decided before anything else can raise a band,
 * which is what makes invariants I1, I3 and I4 hold structurally rather than by convention.
 */
export function assignBand(input: BandingInput): BandingResult {
  const { axisA, axisB, axisC, axisD } = input;
  const rationale: string[] = [];

  const axes = {
    identity: axisA.grade,
    attribution: axisB.grade,
    stage: axisC.proceduralStage,
    partyRole: axisC.partyRole,
    authorityTier: axisD.bestTier,
    independenceCount: axisD.independenceCount,
  } as const;

  const result = (band: EvidenceBand, isCompanyLevel = false): BandingResult => ({
    band,
    axes,
    rulesVersion: input.rulesVersion,
    rationale,
    isCompanyLevel,
  });

  // Rule 1 — Axis A CONTRADICTED. Excluded from findings, retained in audit with the
  // contradiction stated. Overridable only by explicit human review (invariant I2).
  if (axisA.grade === 'CONTRADICTED') {
    rationale.push('Axis A is CONTRADICTED; excluded from findings and retained in audit (I2).');
    return result('CONTRADICTED');
  }

  // Rule 2 — no validated span, or rights/fetch denied. Never a supported assertion (T32).
  if (axisC.bandCeiling === 'LEAD_ONLY') {
    rationale.push(...axisC.rationale);
    rationale.push('No supportable adverse event; LEAD_ONLY.');
    return result('LEAD_ONLY');
  }

  // Rule 3 — invariant I3. A COMPANY_ONLY attribution never produces a personal adverse
  // finding at any band. It becomes a company-level finding instead.
  if (!permitsPersonalFinding(axisB.grade)) {
    if (axisB.grade === 'COMPANY_ONLY') {
      if (!meetsSupportedAuthority(axisD)) {
        rationale.push('Company-level event, but no Tier 1-3 source; LEAD_ONLY.');
        return result('LEAD_ONLY', true);
      }
      rationale.push(...axisB.rationale);
      rationale.push('Attribution is COMPANY_ONLY; banded COMPANY_CONTEXT, never personal (I3).');
      return result('COMPANY_CONTEXT', true);
    }
    rationale.push('Attribution NOT_ESTABLISHED; no finding can be attached to the subject.');
    return result('LEAD_ONLY');
  }

  // Rule 4 — Tier 5 sources are leads only, whatever the other axes say.
  if (axisD.bestTier === 5) {
    rationale.push('Best available source is Tier 5 (blog / forum / unattributed); LEAD_ONLY.');
    return result('LEAD_ONLY');
  }

  // Rule 5 — CORROBORATED.
  const corroboratedIdentity = axisA.grade === 'CORROBORATED';
  const directAttribution = axisB.grade === 'DIRECT_PERSONAL';
  if (
    corroboratedIdentity &&
    directAttribution &&
    meetsCorroboratedEvent(axisC) &&
    meetsCorroboratedAuthority(axisD)
  ) {
    rationale.push(
      'Axis A CORROBORATED, Axis B DIRECT_PERSONAL, stage >= 5 with an adverse role, and one Tier 1 or two independent Tier 2-3 sources.',
    );
    return result(applyCeilings('CORROBORATED', axisB, axisC, rationale));
  }

  // Rule 6 — SUPPORTED.
  const supportedIdentity = axisA.grade === 'CORROBORATED' || axisA.grade === 'PARTIAL';
  if (supportedIdentity && meetsSupportedEvent(axisC) && meetsSupportedAuthority(axisD)) {
    rationale.push(
      'Axis A CORROBORATED or PARTIAL, Axis B DIRECT_PERSONAL or VIA_ROLE, stage >= 3 span-validated, Tier 1-3 source.',
    );
    return result(applyCeilings('SUPPORTED', axisB, axisC, rationale));
  }

  // Rule 7 — AMBIGUOUS. Axis A PARTIAL or WEAK, any attribution, any valid event.
  rationale.push(
    `Axis A is ${axisA.grade} and the CORROBORATED/SUPPORTED conditions are not met; AMBIGUOUS.`,
  );
  if (axisA.frequencyPenaltyApplied) {
    rationale.push('A name-frequency penalty contributed to this identity grade (FR-01, FR-08).');
  }
  return result(applyCeilings('AMBIGUOUS', axisB, axisC, rationale));
}

/**
 * Ceilings that apply after a band is proposed:
 *  - VIA_ROLE produces a personal finding at SUPPORTED at most (FR-08, T73);
 *  - an UNSPECIFIED role or unestablished stage caps at AMBIGUOUS (FR-09, I4).
 */
function applyCeilings(
  proposed: EvidenceBand,
  axisB: AxisBResult,
  axisC: AxisCResult,
  rationale: string[],
): EvidenceBand {
  let band = proposed;

  if (axisB.grade === 'VIA_ROLE') {
    band = cap(band, 'SUPPORTED');
    // Stated whether or not the cap changed the band. A reviewer looking at a VIA_ROLE
    // finding needs to know it can never reach CORROBORATED, not merely that it did not.
    rationale.push(
      'Capped at SUPPORTED: attribution is VIA_ROLE. The document names a role, not the subject; ' +
        'the connection is inferred from the association graph and is shown as an inference (T73).',
    );
    if (axisB.inferenceStatement !== null) {
      rationale.push(axisB.inferenceStatement);
    }
  }

  if (axisC.bandCeiling === 'AMBIGUOUS') {
    const capped = cap(band, 'AMBIGUOUS');
    if (capped !== band) {
      rationale.push(...axisC.rationale);
    }
    band = capped;
  }

  return band;
}
