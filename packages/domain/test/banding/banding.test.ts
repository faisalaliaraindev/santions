/**
 * FR-11 banding table, and the axis modules it combines.
 * Tests T16, T72, T73, T74, T75, T76.
 */

import { describe, expect, it } from 'vitest';

import {
  gradeAttribution,
  permitsPersonalFinding,
  type AxisBInput,
} from '../../src/attribution/axis-b.js';
import {
  computeAuthority,
  meetsCorroboratedAuthority,
  meetsSupportedAuthority,
  type ClusteredSource,
} from '../../src/authority/axis-d.js';
import { assignBand, type BandingRuleVersion } from '../../src/banding/bands.js';
import { eventAgeInDays, isDisplayableProbability } from '../../src/banding/finding-attributes.js';
import { classifyEvent, type AxisCInput } from '../../src/events/axis-c.js';
import { gradeIdentity, type AxisAInput, type IdentityFactor } from '../../src/identity/axis-a.js';

const RULES: BandingRuleVersion = {
  bandingRulesVersionId: 'banding-v1',
  version: 1,
  activatedAt: '2026-09-10T00:00:00.000Z',
};

const strongFor: IdentityFactor = {
  kind: 'FULL_DOB',
  strength: 'STRONG',
  direction: 'CORROBORATING',
  span: { start: 0, end: 10 },
  detail: 'DOB matches',
};

function axisA(overrides: Partial<AxisAInput> = {}): AxisAInput {
  return {
    nameMatch: 'EXACT',
    factors: [strongFor],
    frequencyPrior: null,
    documentDistinguishesNamesake: false,
    ...overrides,
  };
}

function axisB(overrides: Partial<AxisBInput> = {}): AxisBInput {
  return {
    namesSubjectPersonally: true,
    companyInGraph: false,
    tenureLabel: 'UNKNOWN',
    roleEvidence: null,
    ...overrides,
  };
}

function axisC(overrides: Partial<AxisCInput> = {}): AxisCInput {
  return {
    category: 'FRAUD_FINANCIAL_CRIME',
    partyRole: 'ACCUSED_DEFENDANT_CRIMINAL',
    proceduralStage: 'CHARGE_INDICTMENT',
    namingAuthority: 'Crown Prosecution Service',
    eventDate: { value: '2024-05-14', precision: 'DAY' },
    publicationDate: { value: '2024-05-15', precision: 'DAY' },
    updateDate: { value: null, precision: 'UNKNOWN' },
    retrievalDate: { value: '2026-09-10', precision: 'DAY' },
    spansValidated: true,
    exclusionReason: null,
    subjectCentrality: 'PROTAGONIST',
    ...overrides,
  };
}

const tier1: ClusteredSource = {
  documentId: 'D1',
  tier: 1,
  originatingNewsroomId: 'court',
  issuingAuthorityId: 'court-ew-crown',
  isSyndicatedCopy: false,
};

const tier2 = (id: string): ClusteredSource => ({
  documentId: id,
  tier: 2,
  originatingNewsroomId: `newsroom-${id}`,
  issuingAuthorityId: null,
  isSyndicatedCopy: false,
});

function band(a: AxisAInput, b: AxisBInput, c: AxisCInput, sources: readonly ClusteredSource[]) {
  return assignBand({
    axisA: gradeIdentity(a),
    axisB: gradeAttribution(b),
    axisC: classifyEvent(c),
    axisD: computeAuthority(sources),
    rulesVersion: RULES,
  });
}

describe('assignBand — the FR-11 table', () => {
  it('reaches CORROBORATED with a Tier 1 source at conviction stage', () => {
    const result = band(
      axisA(),
      axisB(),
      axisC({
        proceduralStage: 'CONVICTION_FINAL_JUDGMENT',
        partyRole: 'CONVICTED_SANCTIONED_PARTY',
      }),
      [tier1],
    );
    expect(result.band).toBe('CORROBORATED');
    expect(result.axes.independenceCount).toBe(1);
  });

  it('reaches CORROBORATED with two independent Tier 2 sources', () => {
    const result = band(axisA(), axisB(), axisC(), [tier2('a'), tier2('b')]);
    expect(result.band).toBe('CORROBORATED');
  });

  it('falls to SUPPORTED with only one Tier 2 source', () => {
    expect(band(axisA(), axisB(), axisC(), [tier2('a')]).band).toBe('SUPPORTED');
  });

  it('falls to SUPPORTED below stage 5', () => {
    const result = band(
      axisA(),
      axisB(),
      axisC({ proceduralStage: 'INVESTIGATION_OPENED', partyRole: 'INVESTIGATED_NOT_CHARGED' }),
      [tier1],
    );
    expect(result.band).toBe('SUPPORTED');
  });

  it('T72 — severity and publisher tier never lift a weak identity above AMBIGUOUS', () => {
    const weak = axisA({
      factors: [
        {
          kind: 'EXACT_COMMON_NAME',
          strength: 'WEAK',
          direction: 'CORROBORATING',
          span: { start: 0, end: 4 },
          detail: 'common name',
        },
      ],
    });
    const severe = axisC({
      category: 'TERRORISM_VIOLENT_EXTREMISM',
      proceduralStage: 'CONVICTION_FINAL_JUDGMENT',
      partyRole: 'CONVICTED_SANCTIONED_PARTY',
    });
    const result = band(weak, axisB(), severe, [tier1, tier2('a'), tier2('b'), tier2('c')]);
    expect(result.band).toBe('AMBIGUOUS');
    expect(result.axes.identity).toBe('WEAK');
  });

  it('returns CONTRADICTED when Axis A contradicts, whatever the evidence', () => {
    const contradicted = axisA({
      factors: [
        strongFor,
        {
          kind: 'DOB_DIFFERS_BEYOND_PRECISION',
          strength: 'STRONG',
          direction: 'CONTRADICTING',
          span: { start: 0, end: 4 },
          detail: 'DOB differs',
        },
      ],
    });
    expect(band(contradicted, axisB(), axisC(), [tier1]).band).toBe('CONTRADICTED');
  });

  it('T16 — a company-only event is COMPANY_CONTEXT and flagged company-level', () => {
    const result = band(
      axisA({ nameMatch: 'NO_MATCH', factors: [] }),
      axisB({ namesSubjectPersonally: false, companyInGraph: true, tenureLabel: 'DURING_TENURE' }),
      axisC(),
      [tier1],
    );
    expect(result.band).toBe('COMPANY_CONTEXT');
    expect(result.isCompanyLevel).toBe(true);
  });

  it('T73 — VIA_ROLE with a sole holder is capped at SUPPORTED and shown as an inference', () => {
    const b = gradeAttribution(
      axisB({
        namesSubjectPersonally: false,
        companyInGraph: true,
        tenureLabel: 'DURING_TENURE',
        roleEvidence: {
          roleNamed: 'chief financial officer',
          holdersAtEventDate: 1,
          soleHolderIsSubject: true,
        },
      }),
    );
    expect(b.grade).toBe('VIA_ROLE');
    expect(b.isInference).toBe(true);
    expect(b.inferenceStatement).toMatch(/inference from the graph/i);

    const result = assignBand({
      axisA: gradeIdentity(axisA()),
      axisB: b,
      axisC: classifyEvent(
        axisC({
          proceduralStage: 'CONVICTION_FINAL_JUDGMENT',
          partyRole: 'CONVICTED_SANCTIONED_PARTY',
        }),
      ),
      axisD: computeAuthority([tier1]),
      rulesVersion: RULES,
    });
    expect(result.band).toBe('SUPPORTED');
    expect(result.rationale.join(' ')).toMatch(/Capped at SUPPORTED/);
  });

  it('T74 — a role held by two people yields COMPANY_ONLY and no personal finding', () => {
    const b = gradeAttribution(
      axisB({
        namesSubjectPersonally: false,
        companyInGraph: true,
        tenureLabel: 'DURING_TENURE',
        roleEvidence: {
          roleNamed: 'managing director',
          holdersAtEventDate: 2,
          soleHolderIsSubject: false,
        },
      }),
    );
    expect(b.grade).toBe('COMPANY_ONLY');
    expect(permitsPersonalFinding(b.grade)).toBe(false);
  });

  it('VIA_ROLE outside the tenure window becomes COMPANY_ONLY', () => {
    const b = gradeAttribution(
      axisB({
        namesSubjectPersonally: false,
        companyInGraph: true,
        tenureLabel: 'AFTER_TENURE',
        roleEvidence: {
          roleNamed: 'chief executive',
          holdersAtEventDate: 1,
          soleHolderIsSubject: true,
        },
      }),
    );
    expect(b.grade).toBe('COMPANY_ONLY');
  });

  it('T76 — an unestablished stage caps the band at AMBIGUOUS', () => {
    const result = band(axisA(), axisB(), axisC({ proceduralStage: 'UNSPECIFIED' }), [tier1]);
    expect(result.band).toBe('AMBIGUOUS');
  });

  it('an UNSPECIFIED party role caps the band at AMBIGUOUS', () => {
    const result = band(axisA(), axisB(), axisC({ partyRole: 'UNSPECIFIED' }), [tier1]);
    expect(result.band).toBe('AMBIGUOUS');
  });

  it('a Tier 5 source is LEAD_ONLY whatever the other axes say', () => {
    const tier5: ClusteredSource = {
      documentId: 'D5',
      tier: 5,
      originatingNewsroomId: 'blog',
      issuingAuthorityId: null,
      isSyndicatedCopy: false,
    };
    expect(band(axisA(), axisB(), axisC(), [tier5]).band).toBe('LEAD_ONLY');
  });

  it('an unvalidated span is LEAD_ONLY', () => {
    expect(band(axisA(), axisB(), axisC({ spansValidated: false }), [tier1]).band).toBe(
      'LEAD_ONLY',
    );
  });

  it('an excluded category is LEAD_ONLY and never a finding', () => {
    const result = band(
      axisA(),
      axisB(),
      axisC({ exclusionReason: 'POLITICAL_OPINION_OR_LAWFUL_ACTIVISM' }),
      [tier1],
    );
    expect(result.band).toBe('LEAD_ONLY');
  });

  it('an unestablished attribution is LEAD_ONLY', () => {
    const result = band(
      axisA(),
      axisB({ namesSubjectPersonally: false, companyInGraph: false }),
      axisC(),
      [tier1],
    );
    expect(result.band).toBe('LEAD_ONLY');
  });

  it('pins the rules version onto every result', () => {
    expect(band(axisA(), axisB(), axisC(), [tier1]).rulesVersion).toEqual(RULES);
  });

  it('retains all four contributing axis values after combination', () => {
    const result = band(axisA(), axisB(), axisC(), [tier1]);
    expect(result.axes).toEqual({
      identity: 'CORROBORATED',
      attribution: 'DIRECT_PERSONAL',
      stage: 'CHARGE_INDICTMENT',
      partyRole: 'ACCUSED_DEFENDANT_CRIMINAL',
      authorityTier: 1,
      independenceCount: 1,
    });
  });
});

describe('Axis D — authority and independence', () => {
  it('counts distinct newsrooms, not distinct domains or URLs', () => {
    const same = [
      { ...tier2('a'), originatingNewsroomId: 'shared' },
      { ...tier2('b'), originatingNewsroomId: 'shared' },
    ];
    expect(computeAuthority(same).independenceCount).toBe(1);
  });

  it('counts a Tier 1 authority separately from newsrooms', () => {
    const result = computeAuthority([tier1, tier2('a')]);
    expect(result.independenceCount).toBe(2);
    expect(result.distinctTier1Authorities).toEqual(['court-ew-crown']);
  });

  it('excludes Tier 4 aggregators from the count with a stated reason', () => {
    const tier4: ClusteredSource = {
      documentId: 'D4',
      tier: 4,
      originatingNewsroomId: 'wire',
      issuingAuthorityId: null,
      isSyndicatedCopy: false,
    };
    const result = computeAuthority([tier2('a'), tier4]);
    expect(result.independenceCount).toBe(1);
    expect(result.excludedFromCount[0]?.reason).toMatch(
      /does not contribute independent corroboration/,
    );
  });

  it('meets the CORROBORATED authority bar with one Tier 1 or two independent Tier 2-3', () => {
    expect(meetsCorroboratedAuthority(computeAuthority([tier1]))).toBe(true);
    expect(meetsCorroboratedAuthority(computeAuthority([tier2('a'), tier2('b')]))).toBe(true);
    expect(meetsCorroboratedAuthority(computeAuthority([tier2('a')]))).toBe(false);
  });

  it('meets the SUPPORTED bar at Tier 1-3 only', () => {
    expect(meetsSupportedAuthority(computeAuthority([tier2('a')]))).toBe(true);
    const tier5: ClusteredSource = {
      documentId: 'D5',
      tier: 5,
      originatingNewsroomId: 'blog',
      issuingAuthorityId: null,
      isSyndicatedCopy: false,
    };
    expect(meetsSupportedAuthority(computeAuthority([tier5]))).toBe(false);
  });

  it('reports zero independence for an empty cluster', () => {
    expect(computeAuthority([]).independenceCount).toBe(0);
  });
});

describe('finding attributes', () => {
  it('computes event age from the event date, not the publication date', () => {
    const asOf = new Date('2026-09-10T00:00:00.000Z');
    expect(eventAgeInDays({ value: '2026-09-01', precision: 'DAY' }, asOf)).toBe(9);
  });

  it('returns null rather than guessing when the event date is unknown', () => {
    const asOf = new Date('2026-09-10T00:00:00.000Z');
    expect(eventAgeInDays({ value: null, precision: 'UNKNOWN' }, asOf)).toBeNull();
    expect(eventAgeInDays({ value: 'not-a-date', precision: 'DAY' }, asOf)).toBeNull();
  });

  it('I8 — rejects an uncalibrated probability and accepts a fully specified one', () => {
    expect(isDisplayableProbability(null)).toBe(false);
    expect(
      isDisplayableProbability({
        value: 0.8,
        rulesVersion: 'banding-v1',
        calibrationScope: 'en/GB',
        evaluationRunId: 'eval-1',
        heldOutSampleSize: 100,
      }),
    ).toBe(true);
  });
});
