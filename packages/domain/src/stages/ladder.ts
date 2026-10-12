/**
 * FR-09 — the procedural stage ladder (0-15).
 *
 * The ladder is the difference between "reported to have been accused" and "found to have
 * done". Every rung carries a mandatory display rule that survives into exports and API
 * responses. Stages are only ever set from a span that establishes them; they never upgrade
 * by inference (invariant I4).
 */

export const PROCEDURAL_STAGES = [
  'RUMOUR_UNATTRIBUTED',
  'ALLEGATION',
  'COMPLAINT_FILED',
  'INVESTIGATION_OPENED',
  'RAID_ARREST_DETENTION',
  'CHARGE_INDICTMENT',
  'CIVIL_CLAIM_FILED',
  'REGULATORY_ACTION_FINE',
  'SETTLEMENT_CONSENT_ORDER',
  'CONVICTION_FINAL_JUDGMENT',
  'DEBARMENT_DISQUALIFICATION',
  'DESIGNATION_SANCTION',
  'APPEAL_PENDING',
  'ACQUITTAL_DISMISSAL_OVERTURNED',
  'CORRECTION_RETRACTION',
  'SPENT_EXPUNGED_TIME_BARRED',
] as const;

export type ProceduralStage = (typeof PROCEDURAL_STAGES)[number];

/** Sentinel used when no span establishes a stage. Never treated as a rung. */
export const STAGE_UNSPECIFIED = 'UNSPECIFIED' as const;
export type StageValue = ProceduralStage | typeof STAGE_UNSPECIFIED;

export interface StageDefinition {
  readonly stage: ProceduralStage;
  /** Ladder position 0-15. Not a severity and not a probability. */
  readonly rung: number;
  readonly label: string;
  /** Rendered on every surface that shows the stage, including exports and API responses. */
  readonly mandatoryDisplayRule: string;
  /** True where a document at this stage resolves or reverses an earlier one (FR-10 chains). */
  readonly isOutcome: boolean;
}

export const STAGE_LADDER: readonly StageDefinition[] = [
  {
    stage: 'RUMOUR_UNATTRIBUTED',
    rung: 0,
    label: 'Rumour / unattributed',
    mandatoryDisplayRule: 'Lead only. Never a supported finding.',
    isOutcome: false,
  },
  {
    stage: 'ALLEGATION',
    rung: 1,
    label: 'Allegation',
    mandatoryDisplayRule:
      '"Alleged" must appear on every surface, including exports and API responses.',
    isOutcome: false,
  },
  {
    stage: 'COMPLAINT_FILED',
    rung: 2,
    label: 'Complaint filed',
    mandatoryDisplayRule: 'A complaint is not a finding by the authority.',
    isOutcome: false,
  },
  {
    stage: 'INVESTIGATION_OPENED',
    rung: 3,
    label: 'Investigation opened',
    mandatoryDisplayRule: 'Name the authority and the date. Not an accusation of guilt.',
    isOutcome: false,
  },
  {
    stage: 'RAID_ARREST_DETENTION',
    rung: 4,
    label: 'Raid / arrest / detention',
    mandatoryDisplayRule: 'Arrest is not charge. Triggers mandatory F8 outcome queries.',
    isOutcome: false,
  },
  {
    stage: 'CHARGE_INDICTMENT',
    rung: 5,
    label: 'Charge / indictment',
    mandatoryDisplayRule: 'Prefer the charging document over reporting about it.',
    isOutcome: false,
  },
  {
    stage: 'CIVIL_CLAIM_FILED',
    rung: 6,
    label: 'Civil claim filed',
    mandatoryDisplayRule: 'Party role must be shown adjacent to the stage.',
    isOutcome: false,
  },
  {
    stage: 'REGULATORY_ACTION_FINE',
    rung: 7,
    label: 'Regulatory action / fine',
    mandatoryDisplayRule:
      'Cite the notice reference. Distinguish firm-level from individual-level action.',
    isOutcome: false,
  },
  {
    stage: 'SETTLEMENT_CONSENT_ORDER',
    rung: 8,
    label: 'Settlement / consent order',
    mandatoryDisplayRule: 'Never rendered as an admission. Quote any no-admission clause.',
    isOutcome: false,
  },
  {
    stage: 'CONVICTION_FINAL_JUDGMENT',
    rung: 9,
    label: 'Conviction / final judgment',
    mandatoryDisplayRule: 'Cite court, case number and date.',
    isOutcome: false,
  },
  {
    stage: 'DEBARMENT_DISQUALIFICATION',
    rung: 10,
    label: 'Debarment / disqualification',
    mandatoryDisplayRule: 'Cross-check the primary register rather than relying on reporting.',
    isOutcome: false,
  },
  {
    stage: 'DESIGNATION_SANCTION',
    rung: 11,
    label: 'Designation / sanction',
    mandatoryDisplayRule:
      'A lead to verify against the primary list. Never a sanctions finding here.',
    isOutcome: false,
  },
  {
    stage: 'APPEAL_PENDING',
    rung: 12,
    label: 'Appeal pending',
    mandatoryDisplayRule: 'Attaches to the underlying event, which is marked under appeal.',
    isOutcome: true,
  },
  {
    stage: 'ACQUITTAL_DISMISSAL_OVERTURNED',
    rung: 13,
    label: 'Acquittal / dismissal / overturned',
    mandatoryDisplayRule:
      'Linked to the original event, displayed at equal prominence, never discarded as a duplicate.',
    isOutcome: true,
  },
  {
    stage: 'CORRECTION_RETRACTION',
    rung: 14,
    label: 'Correction / retraction',
    mandatoryDisplayRule:
      'Suppresses the original finding and notifies any reviewer who acted on it.',
    isOutcome: true,
  },
  {
    stage: 'SPENT_EXPUNGED_TIME_BARRED',
    rung: 15,
    label: 'Spent / expunged / time-barred',
    mandatoryDisplayRule: 'The rights engine decides display and export per jurisdiction.',
    isOutcome: true,
  },
];

const BY_STAGE = new Map<ProceduralStage, StageDefinition>(STAGE_LADDER.map((d) => [d.stage, d]));

export function stageDefinition(stage: ProceduralStage): StageDefinition {
  const def = BY_STAGE.get(stage);
  /* c8 ignore next 3 -- unreachable while ProceduralStage is a closed union */
  if (!def) {
    throw new Error(`Unknown procedural stage: ${stage}`);
  }
  return def;
}

/** Ladder position. `UNSPECIFIED` is deliberately -1: it is below rumour, not equal to it. */
export function stageRung(stage: StageValue): number {
  return stage === STAGE_UNSPECIFIED ? -1 : stageDefinition(stage).rung;
}

/** The banding rules in FR-11 are expressed as "stage >= 3" / "stage >= 5" over the rung. */
export function stageAtLeast(stage: StageValue, minimumRung: number): boolean {
  return stageRung(stage) >= minimumRung;
}

export function isOutcomeStage(stage: StageValue): boolean {
  return stage !== STAGE_UNSPECIFIED && stageDefinition(stage).isOutcome;
}

/** Rungs 3, 4 and 5 age into `OUTCOME_UNKNOWN` without an outcome document (FR-09, T77). */
export function requiresOutcomeFollowUp(stage: StageValue): boolean {
  const rung = stageRung(stage);
  return rung >= 3 && rung <= 5;
}

export function mandatoryDisplayRule(stage: StageValue): string | null {
  return stage === STAGE_UNSPECIFIED ? null : stageDefinition(stage).mandatoryDisplayRule;
}
