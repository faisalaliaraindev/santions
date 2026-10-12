/** FR-09 stage ladder and transitions. Tests T76, T77. Guards I4. */

import { describe, expect, it } from 'vitest';

import {
  PROCEDURAL_STAGES,
  STAGE_LADDER,
  STAGE_UNSPECIFIED,
  isOutcomeStage,
  mandatoryDisplayRule,
  requiresOutcomeFollowUp,
  stageAtLeast,
  stageDefinition,
  stageRung,
} from '../../src/stages/ladder.js';
import {
  applyStageClaim,
  outcomeStatus,
  resolveSupportedStage,
  type StageClaim,
} from '../../src/stages/transitions.js';

const span = { start: 100, end: 140 };

function claim(overrides: Partial<StageClaim> & Pick<StageClaim, 'stage'>): StageClaim {
  return {
    stageSpan: span,
    documentId: 'D1',
    documentVersion: 1,
    publicationDate: '2024-05-15',
    ...overrides,
  };
}

describe('the stage ladder', () => {
  it('has exactly sixteen rungs, numbered 0-15 without gaps', () => {
    expect(STAGE_LADDER).toHaveLength(16);
    expect(PROCEDURAL_STAGES).toHaveLength(16);
    expect(STAGE_LADDER.map((d) => d.rung)).toEqual([...Array(16).keys()]);
  });

  it('gives every stage a non-empty mandatory display rule', () => {
    for (const def of STAGE_LADDER) {
      expect(def.mandatoryDisplayRule.length, def.stage).toBeGreaterThan(0);
    }
  });

  it('requires "alleged" on every surface at stage 1', () => {
    expect(mandatoryDisplayRule('ALLEGATION')).toMatch(/alleged/i);
  });

  it('forbids rendering a settlement as an admission', () => {
    expect(mandatoryDisplayRule('SETTLEMENT_CONSENT_ORDER')).toMatch(
      /never rendered as an admission/i,
    );
  });

  it('treats a designation as a lead to verify, never a finding', () => {
    expect(mandatoryDisplayRule('DESIGNATION_SANCTION')).toMatch(/lead to verify/i);
  });

  it('places UNSPECIFIED below rumour rather than equal to it', () => {
    expect(stageRung(STAGE_UNSPECIFIED)).toBe(-1);
    expect(stageRung('RUMOUR_UNATTRIBUTED')).toBe(0);
    expect(mandatoryDisplayRule(STAGE_UNSPECIFIED)).toBeNull();
  });

  it('identifies the four outcome stages', () => {
    const outcomes = STAGE_LADDER.filter((d) => d.isOutcome).map((d) => d.stage);
    expect(outcomes).toEqual([
      'APPEAL_PENDING',
      'ACQUITTAL_DISMISSAL_OVERTURNED',
      'CORRECTION_RETRACTION',
      'SPENT_EXPUNGED_TIME_BARRED',
    ]);
    expect(isOutcomeStage(STAGE_UNSPECIFIED)).toBe(false);
  });

  it('flags stages 3-5 for mandatory F8 outcome follow-up', () => {
    expect(requiresOutcomeFollowUp('INVESTIGATION_OPENED')).toBe(true);
    expect(requiresOutcomeFollowUp('RAID_ARREST_DETENTION')).toBe(true);
    expect(requiresOutcomeFollowUp('CHARGE_INDICTMENT')).toBe(true);
    expect(requiresOutcomeFollowUp('COMPLAINT_FILED')).toBe(false);
    expect(requiresOutcomeFollowUp('CONVICTION_FINAL_JUDGMENT')).toBe(false);
  });

  it('supports the >= comparisons the banding table is written in', () => {
    expect(stageAtLeast('CHARGE_INDICTMENT', 5)).toBe(true);
    expect(stageAtLeast('INVESTIGATION_OPENED', 5)).toBe(false);
    expect(stageAtLeast('INVESTIGATION_OPENED', 3)).toBe(true);
    expect(stageAtLeast(STAGE_UNSPECIFIED, 3)).toBe(false);
    expect(stageDefinition('CONVICTION_FINAL_JUDGMENT').rung).toBe(9);
  });
});

describe('resolveSupportedStage — invariant I4', () => {
  it('T76 — a claim with no stage span contributes nothing', () => {
    const resolved = resolveSupportedStage([
      claim({ stage: 'CONVICTION_FINAL_JUDGMENT', stageSpan: null }),
    ]);
    expect(resolved).toBe(STAGE_UNSPECIFIED);
  });

  it('takes the highest span-supported stage and ignores unsupported higher claims', () => {
    const resolved = resolveSupportedStage([
      claim({ stage: 'INVESTIGATION_OPENED' }),
      claim({ stage: 'CONVICTION_FINAL_JUDGMENT', stageSpan: null }),
      claim({ stage: 'CHARGE_INDICTMENT' }),
    ]);
    expect(resolved).toBe('CHARGE_INDICTMENT');
  });

  it('returns UNSPECIFIED for an empty claim list', () => {
    expect(resolveSupportedStage([])).toBe(STAGE_UNSPECIFIED);
  });
});

describe('applyStageClaim', () => {
  it('rejects a claim with no span', () => {
    const decision = applyStageClaim(
      'INVESTIGATION_OPENED',
      claim({ stage: 'CONVICTION_FINAL_JUDGMENT', stageSpan: null }),
    );
    expect(decision.accepted).toBe(false);
    expect(decision.rejection).toBe('NO_STAGE_SPAN');
    expect(decision.nextStage).toBe('INVESTIGATION_OPENED');
  });

  it('accepts an upward move on its own span', () => {
    const decision = applyStageClaim('INVESTIGATION_OPENED', claim({ stage: 'CHARGE_INDICTMENT' }));
    expect(decision.accepted).toBe(true);
    expect(decision.nextStage).toBe('CHARGE_INDICTMENT');
    expect(decision.supersedes).toBe(true);
  });

  it('refuses a sideways or downward non-outcome move', () => {
    const decision = applyStageClaim('CHARGE_INDICTMENT', claim({ stage: 'ALLEGATION' }));
    expect(decision.accepted).toBe(false);
    expect(decision.rejection).toBe('SAME_OR_LOWER_NON_OUTCOME');
    expect(decision.nextStage).toBe('CHARGE_INDICTMENT');
  });

  it('always accepts an outcome stage, including one that reverses a conviction', () => {
    const decision = applyStageClaim(
      'CONVICTION_FINAL_JUDGMENT',
      claim({ stage: 'ACQUITTAL_DISMISSAL_OVERTURNED' }),
    );
    expect(decision.accepted).toBe(true);
    expect(decision.nextStage).toBe('ACQUITTAL_DISMISSAL_OVERTURNED');
  });

  it('accepts a correction over a charge', () => {
    const decision = applyStageClaim(
      'CHARGE_INDICTMENT',
      claim({ stage: 'CORRECTION_RETRACTION' }),
    );
    expect(decision.accepted).toBe(true);
  });
});

describe('outcomeStatus — T77', () => {
  const base = {
    hasOutcomeDocument: false,
    outcomeQueriesRun: true,
    eventAgeDays: 30,
    outcomeUnknownAfterDays: 180,
  };

  it('T77 — a stage 4 event past the configured age is OUTCOME_UNKNOWN', () => {
    expect(outcomeStatus({ ...base, stage: 'RAID_ARREST_DETENTION', eventAgeDays: 400 })).toBe(
      'OUTCOME_UNKNOWN',
    );
  });

  it('is OUTCOME_UNKNOWN whenever F8 has never run, regardless of age', () => {
    expect(
      outcomeStatus({
        ...base,
        stage: 'CHARGE_INDICTMENT',
        outcomeQueriesRun: false,
        eventAgeDays: 1,
      }),
    ).toBe('OUTCOME_UNKNOWN');
  });

  it('is RESOLVED once an outcome document exists', () => {
    expect(
      outcomeStatus({
        ...base,
        stage: 'CHARGE_INDICTMENT',
        hasOutcomeDocument: true,
        eventAgeDays: 4000,
      }),
    ).toBe('RESOLVED');
  });

  it('reports UNDER_APPEAL for a pending appeal', () => {
    expect(outcomeStatus({ ...base, stage: 'APPEAL_PENDING' })).toBe('UNDER_APPEAL');
  });

  it('is not due for stages outside 3-5', () => {
    expect(outcomeStatus({ ...base, stage: 'ALLEGATION' })).toBe('OUTCOME_NOT_DUE');
    expect(outcomeStatus({ ...base, stage: 'CONVICTION_FINAL_JUDGMENT' })).toBe('OUTCOME_NOT_DUE');
  });

  it('is not due for a recent in-range event whose outcome queries have run', () => {
    expect(outcomeStatus({ ...base, stage: 'INVESTIGATION_OPENED' })).toBe('OUTCOME_NOT_DUE');
  });

  it('does not flag an event of unknown age that has been queried', () => {
    expect(outcomeStatus({ ...base, stage: 'CHARGE_INDICTMENT', eventAgeDays: null })).toBe(
      'OUTCOME_NOT_DUE',
    );
  });
});
