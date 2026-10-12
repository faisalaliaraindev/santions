/**
 * G2 seed labelled dataset.
 *
 * Deliberately hard-negative-heavy. A dataset of clear-cut convictions proves nothing: every
 * naive implementation passes it. The cases that decide whether this product is safe are the
 * common name with no secondary identifiers, the victim, the witness, the plaintiff, the
 * namesake with a contradicting date of birth, the company event with no personal
 * involvement, and the acquittal that arrives after the charge.
 *
 * This is a synthetic corpus. Names are invented and are not intended to refer to any real
 * person or company.
 */

import type {
  AxisAInput,
  AxisBInput,
  AxisCInput,
  ClusteredSource,
  IdentityFactor,
  PreciseDate,
} from '@adverse-search/domain';

import type { LabelledCase, LabelledDataset, LabelledDocument } from './types.js';

const UNKNOWN_DATE: PreciseDate = { value: null, precision: 'UNKNOWN' };

function day(value: string): PreciseDate {
  return { value, precision: 'DAY' };
}

function factor(
  kind: IdentityFactor['kind'],
  strength: IdentityFactor['strength'],
  direction: IdentityFactor['direction'],
  detail: string,
  span: { start: number; end: number } | null = { start: 0, end: 10 },
): IdentityFactor {
  return { kind, strength, direction, span: direction === 'ABSENT' ? null : span, detail };
}

function doc(overrides: Partial<LabelledDocument> & { documentId: string }): LabelledDocument {
  return {
    language: 'en',
    jurisdiction: 'GB',
    tier: 2,
    originatingNewsroomId: `newsroom-${overrides.documentId}`,
    issuingAuthorityId: null,
    isSyndicatedCopy: false,
    syndicationFamilyId: `family-${overrides.documentId}`,
    canonicalUrl: `https://example.test/${overrides.documentId}`,
    contentHash: `hash-${overrides.documentId}`,
    nearDuplicateKey: null,
    text: 'Synthetic fixture text.',
    ...overrides,
  };
}

function source(overrides: Partial<ClusteredSource> & { documentId: string }): ClusteredSource {
  return {
    tier: 2,
    originatingNewsroomId: `newsroom-${overrides.documentId}`,
    issuingAuthorityId: null,
    isSyndicatedCopy: false,
    ...overrides,
  };
}

function axisC(overrides: Partial<AxisCInput>): AxisCInput {
  return {
    category: 'FRAUD_FINANCIAL_CRIME',
    partyRole: 'ACCUSED_DEFENDANT_CRIMINAL',
    proceduralStage: 'CHARGE_INDICTMENT',
    namingAuthority: 'Crown Prosecution Service',
    eventDate: day('2024-05-14'),
    publicationDate: day('2024-05-15'),
    updateDate: UNKNOWN_DATE,
    retrievalDate: day('2026-09-10'),
    spansValidated: true,
    exclusionReason: null,
    subjectCentrality: 'PROTAGONIST',
    ...overrides,
  };
}

function axisA(overrides: Partial<AxisAInput>): AxisAInput {
  return {
    nameMatch: 'EXACT',
    factors: [],
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

export const SEED_CASES: readonly LabelledCase[] = [
  {
    caseId: 'C001',
    entityId: 'E-mordaunt-rhys',
    kinds: ['TRUE_POSITIVE'],
    subjectName: 'Rhys Mordaunt',
    language: 'en',
    jurisdiction: 'GB',
    note: 'Clean positive: court judgment plus an established newspaper, strong identifier present.',
    documents: [
      doc({ documentId: 'D001a', tier: 1, issuingAuthorityId: 'court-ew-crown' }),
      doc({ documentId: 'D001b', tier: 2 }),
    ],
    label: {
      identity: 'CORROBORATED',
      attribution: 'DIRECT_PERSONAL',
      category: 'FRAUD_FINANCIAL_CRIME',
      partyRole: 'CONVICTED_SANCTIONED_PARTY',
      proceduralStage: 'CONVICTION_FINAL_JUDGMENT',
      tenureLabel: 'UNKNOWN',
      band: 'CORROBORATED',
      independenceCount: 2,
      exclusionReason: null,
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [
          factor('FULL_DOB', 'STRONG', 'CORROBORATING', 'DOB 1974-03-02 stated in judgment'),
        ],
      }),
      axisB: axisB(),
      axisC: axisC({
        partyRole: 'CONVICTED_SANCTIONED_PARTY',
        proceduralStage: 'CONVICTION_FINAL_JUDGMENT',
      }),
      sources: [
        source({ documentId: 'D001a', tier: 1, issuingAuthorityId: 'court-ew-crown' }),
        source({ documentId: 'D001b', tier: 2 }),
      ],
    },
  },
  {
    caseId: 'C002',
    entityId: 'E-common-name-smith',
    kinds: ['COMMON_NAME', 'HIGH_FREQUENCY_NAME', 'SPARSE_IDENTITY'],
    subjectName: 'John Smith',
    language: 'en',
    jurisdiction: 'GB',
    note: 'T71: top-decile name, no secondary identifiers. Must not exceed AMBIGUOUS whatever the reporting says.',
    documents: [doc({ documentId: 'D002' })],
    label: {
      identity: 'WEAK',
      attribution: 'DIRECT_PERSONAL',
      category: 'FRAUD_FINANCIAL_CRIME',
      partyRole: 'ACCUSED_DEFENDANT_CRIMINAL',
      proceduralStage: 'CHARGE_INDICTMENT',
      tenureLabel: 'UNKNOWN',
      band: 'AMBIGUOUS',
      independenceCount: 1,
      exclusionReason: null,
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [
          factor('EXACT_COMMON_NAME', 'WEAK', 'CORROBORATING', 'Exact name match, common name'),
          factor('FULL_DOB', 'STRONG', 'ABSENT', 'No date of birth stated in the document'),
        ],
        frequencyPrior: { decile: 10, population: 'GB', sourceRef: 'ONS name distribution 2021' },
      }),
      axisB: axisB(),
      axisC: axisC({}),
      sources: [source({ documentId: 'D002' })],
    },
  },
  {
    caseId: 'C003',
    entityId: 'E-namesake-okonkwo',
    kinds: ['NAMESAKE_CONTRADICTING_DOB'],
    subjectName: 'Adaeze Okonkwo',
    language: 'en',
    jurisdiction: 'NG',
    note: 'T11: severe conviction reporting about a same-named person with a contradicting DOB. Guards I1 and I2.',
    documents: [doc({ documentId: 'D003', tier: 1, issuingAuthorityId: 'court-ng-federal' })],
    label: {
      identity: 'CONTRADICTED',
      attribution: 'DIRECT_PERSONAL',
      category: 'BRIBERY_CORRUPTION',
      partyRole: 'CONVICTED_SANCTIONED_PARTY',
      proceduralStage: 'CONVICTION_FINAL_JUDGMENT',
      tenureLabel: 'UNKNOWN',
      band: 'CONTRADICTED',
      independenceCount: 1,
      exclusionReason: null,
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [
          factor('EXACT_COMMON_NAME', 'WEAK', 'CORROBORATING', 'Exact name match'),
          factor(
            'DOB_DIFFERS_BEYOND_PRECISION',
            'STRONG',
            'CONTRADICTING',
            'Judgment states DOB 1981-11-19; subject snapshot states 1974-03-02',
          ),
        ],
      }),
      axisB: axisB(),
      axisC: axisC({
        category: 'BRIBERY_CORRUPTION',
        partyRole: 'CONVICTED_SANCTIONED_PARTY',
        proceduralStage: 'CONVICTION_FINAL_JUDGMENT',
        namingAuthority: 'Federal High Court',
      }),
      sources: [source({ documentId: 'D003', tier: 1, issuingAuthorityId: 'court-ng-federal' })],
    },
  },
  {
    caseId: 'C004',
    entityId: 'E-victim-lindqvist',
    kinds: ['VICTIM'],
    subjectName: 'Elin Lindqvist',
    language: 'en',
    jurisdiction: 'SE',
    note: 'T17: subject is the victim of the fraud. Never adverse, at any band.',
    documents: [doc({ documentId: 'D004' })],
    label: {
      identity: 'CORROBORATED',
      attribution: 'DIRECT_PERSONAL',
      category: 'FRAUD_FINANCIAL_CRIME',
      partyRole: 'VICTIM',
      proceduralStage: 'CHARGE_INDICTMENT',
      tenureLabel: 'UNKNOWN',
      band: 'LEAD_ONLY',
      independenceCount: 1,
      exclusionReason: 'VICTIM_OR_WITNESS_STATUS',
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [factor('FULL_DOB', 'STRONG', 'CORROBORATING', 'DOB stated and matches')],
      }),
      axisB: axisB(),
      axisC: axisC({ partyRole: 'VICTIM' }),
      sources: [source({ documentId: 'D004' })],
    },
  },
  {
    caseId: 'C005',
    entityId: 'E-witness-haruna',
    kinds: ['WITNESS'],
    subjectName: 'Suleiman Haruna',
    language: 'en',
    jurisdiction: 'GB',
    note: 'T17: subject gave evidence as a witness. Never adverse.',
    documents: [doc({ documentId: 'D005' })],
    label: {
      identity: 'CORROBORATED',
      attribution: 'DIRECT_PERSONAL',
      category: 'MONEY_LAUNDERING_TF',
      partyRole: 'WITNESS',
      proceduralStage: 'CONVICTION_FINAL_JUDGMENT',
      tenureLabel: 'UNKNOWN',
      band: 'LEAD_ONLY',
      independenceCount: 1,
      exclusionReason: 'VICTIM_OR_WITNESS_STATUS',
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [
          factor('NAMED_POSITION_HELD', 'MODERATE', 'CORROBORATING', 'Named as finance director'),
          factor('EMPLOYER_PLUS_JOB_TITLE', 'MODERATE', 'CORROBORATING', 'Employer matches graph'),
        ],
      }),
      axisB: axisB(),
      axisC: axisC({ category: 'MONEY_LAUNDERING_TF', partyRole: 'WITNESS' }),
      sources: [source({ documentId: 'D005' })],
    },
  },
  {
    caseId: 'C006',
    entityId: 'E-plaintiff-braga',
    kinds: ['PLAINTIFF'],
    subjectName: 'Mariana Braga',
    language: 'en',
    jurisdiction: 'PT',
    note: 'T17: subject brought the civil claim. Being a claimant is not an adverse event.',
    documents: [doc({ documentId: 'D006' })],
    label: {
      identity: 'CORROBORATED',
      attribution: 'DIRECT_PERSONAL',
      category: 'FRAUD_FINANCIAL_CRIME',
      partyRole: 'PLAINTIFF_CLAIMANT',
      proceduralStage: 'CIVIL_CLAIM_FILED',
      tenureLabel: 'UNKNOWN',
      band: 'LEAD_ONLY',
      independenceCount: 1,
      exclusionReason: null,
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [factor('GOVERNMENT_OR_PASSPORT_ID', 'STRONG', 'CORROBORATING', 'NIF matches')],
      }),
      axisB: axisB(),
      axisC: axisC({ partyRole: 'PLAINTIFF_CLAIMANT', proceduralStage: 'CIVIL_CLAIM_FILED' }),
      sources: [source({ documentId: 'D006' })],
    },
  },
  {
    caseId: 'C007',
    entityId: 'E-company-only-arclight',
    kinds: ['COMPANY_ONLY_EVENT', 'PERSON_VS_COMPANY'],
    subjectName: 'Priya Raghunathan',
    language: 'en',
    jurisdiction: 'GB',
    note: 'T16: regulator fines the company; no individual is named. Guards I3 — never a personal finding.',
    documents: [doc({ documentId: 'D007', tier: 1, issuingAuthorityId: 'regulator-gb-fca' })],
    label: {
      identity: 'WEAK',
      attribution: 'COMPANY_ONLY',
      category: 'REGULATORY_PROFESSIONAL_MISCONDUCT',
      partyRole: 'ACCUSED_DEFENDANT_CRIMINAL',
      proceduralStage: 'REGULATORY_ACTION_FINE',
      tenureLabel: 'DURING_TENURE',
      band: 'COMPANY_CONTEXT',
      independenceCount: 1,
      exclusionReason: null,
      discoverable: true,
    },
    scenario: {
      axisA: axisA({ nameMatch: 'NO_MATCH' }),
      axisB: axisB({
        namesSubjectPersonally: false,
        companyInGraph: true,
        tenureLabel: 'DURING_TENURE',
      }),
      axisC: axisC({
        category: 'REGULATORY_PROFESSIONAL_MISCONDUCT',
        proceduralStage: 'REGULATORY_ACTION_FINE',
        namingAuthority: 'Financial Conduct Authority',
      }),
      sources: [source({ documentId: 'D007', tier: 1, issuingAuthorityId: 'regulator-gb-fca' })],
    },
  },
  {
    caseId: 'C008',
    entityId: 'E-via-role-sole',
    kinds: ['PERSON_VS_COMPANY'],
    subjectName: 'Tomas Berec',
    language: 'en',
    jurisdiction: 'CZ',
    note: 'T73: document names the CFO role; the graph shows exactly one holder at the event date. VIA_ROLE, capped at SUPPORTED.',
    documents: [doc({ documentId: 'D008', tier: 2 })],
    label: {
      identity: 'CORROBORATED',
      attribution: 'VIA_ROLE',
      category: 'MARKET_ABUSE',
      partyRole: 'INVESTIGATED_NOT_CHARGED',
      proceduralStage: 'INVESTIGATION_OPENED',
      tenureLabel: 'DURING_TENURE',
      band: 'SUPPORTED',
      independenceCount: 1,
      exclusionReason: null,
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [
          factor(
            'COMPANY_REGISTRATION_WITH_OFFICER_ROLE',
            'STRONG',
            'CORROBORATING',
            'Register lists subject as CFO',
          ),
        ],
      }),
      axisB: axisB({
        namesSubjectPersonally: false,
        companyInGraph: true,
        tenureLabel: 'DURING_TENURE',
        roleEvidence: {
          roleNamed: 'chief financial officer',
          holdersAtEventDate: 1,
          soleHolderIsSubject: true,
        },
      }),
      axisC: axisC({
        category: 'MARKET_ABUSE',
        partyRole: 'INVESTIGATED_NOT_CHARGED',
        proceduralStage: 'INVESTIGATION_OPENED',
        namingAuthority: 'Czech National Bank',
      }),
      sources: [source({ documentId: 'D008', tier: 2 })],
    },
  },
  {
    caseId: 'C009',
    entityId: 'E-via-role-two',
    kinds: ['PERSON_VS_COMPANY'],
    subjectName: 'Ingrid Halvorsen',
    language: 'en',
    jurisdiction: 'NO',
    note: 'T74: the same role was held by two people at the event date. No personal finding may be produced.',
    documents: [doc({ documentId: 'D009', tier: 2 })],
    label: {
      identity: 'CORROBORATED',
      attribution: 'COMPANY_ONLY',
      category: 'MARKET_ABUSE',
      partyRole: 'INVESTIGATED_NOT_CHARGED',
      proceduralStage: 'INVESTIGATION_OPENED',
      tenureLabel: 'DURING_TENURE',
      band: 'COMPANY_CONTEXT',
      independenceCount: 1,
      exclusionReason: null,
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [
          factor('NAMED_POSITION_HELD', 'MODERATE', 'CORROBORATING', 'Named as a co-director'),
        ],
      }),
      axisB: axisB({
        namesSubjectPersonally: false,
        companyInGraph: true,
        tenureLabel: 'DURING_TENURE',
        roleEvidence: {
          roleNamed: 'managing director',
          holdersAtEventDate: 2,
          soleHolderIsSubject: false,
        },
      }),
      axisC: axisC({
        category: 'MARKET_ABUSE',
        partyRole: 'INVESTIGATED_NOT_CHARGED',
        proceduralStage: 'INVESTIGATION_OPENED',
      }),
      sources: [source({ documentId: 'D009', tier: 2 })],
    },
  },
  {
    caseId: 'C010',
    entityId: 'E-syndication-vasquez',
    kinds: ['SYNDICATION_FAMILY'],
    subjectName: 'Camila Vasquez',
    language: 'es',
    jurisdiction: 'CL',
    note: 'T26: one wire story republished by six outlets. Independence count must remain 1. Guards I6.',
    documents: [
      doc({
        documentId: 'D010a',
        language: 'es',
        originatingNewsroomId: 'wire-agencia',
        syndicationFamilyId: 'family-wire-1',
        nearDuplicateKey: 'sim-1',
      }),
      doc({
        documentId: 'D010b',
        language: 'es',
        originatingNewsroomId: 'wire-agencia',
        syndicationFamilyId: 'family-wire-1',
        nearDuplicateKey: 'sim-1',
        isSyndicatedCopy: true,
        tier: 4,
      }),
      doc({
        documentId: 'D010c',
        language: 'es',
        originatingNewsroomId: 'wire-agencia',
        syndicationFamilyId: 'family-wire-1',
        nearDuplicateKey: 'sim-1',
        isSyndicatedCopy: true,
        tier: 4,
      }),
    ],
    label: {
      identity: 'PARTIAL',
      attribution: 'DIRECT_PERSONAL',
      category: 'TAX_OFFENCES',
      partyRole: 'INVESTIGATED_NOT_CHARGED',
      proceduralStage: 'INVESTIGATION_OPENED',
      tenureLabel: 'UNKNOWN',
      band: 'SUPPORTED',
      independenceCount: 1,
      exclusionReason: null,
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [
          factor(
            'RARE_FULL_NAME_PLUS_CITY',
            'MODERATE',
            'CORROBORATING',
            'Rare name plus Valparaiso',
          ),
        ],
      }),
      axisB: axisB(),
      axisC: axisC({
        category: 'TAX_OFFENCES',
        partyRole: 'INVESTIGATED_NOT_CHARGED',
        proceduralStage: 'INVESTIGATION_OPENED',
        namingAuthority: 'Servicio de Impuestos Internos',
      }),
      sources: [
        source({ documentId: 'D010a', originatingNewsroomId: 'wire-agencia' }),
        source({
          documentId: 'D010b',
          originatingNewsroomId: 'wire-agencia',
          isSyndicatedCopy: true,
          tier: 4,
        }),
        source({
          documentId: 'D010c',
          originatingNewsroomId: 'wire-agencia',
          isSyndicatedCopy: true,
          tier: 4,
        }),
      ],
    },
  },
  {
    caseId: 'C011',
    entityId: 'E-acquittal-nowak',
    kinds: ['ACQUITTAL', 'PROCEDURAL_CHANGE_OVER_TIME'],
    subjectName: 'Katarzyna Nowak',
    language: 'pl',
    jurisdiction: 'PL',
    note:
      'T18: charged in 2023, acquitted in 2025. The acquittal must attach at equal prominence. Guards I7. ' +
      'Banded CORROBORATED deliberately: the band states how well the evidence supports the connection, ' +
      'not how adverse the matter is. The evidence here is a Tier 1 court record naming the subject with a ' +
      'matching DOB, so the connection is corroborated — and what it corroborates is an acquittal. ' +
      'The fairness is carried by the stage (ACQUITTAL_DISMISSAL_OVERTURNED) and the RESOLVED outcome ' +
      'status, both shown alongside the band. See open decision D11.',
    documents: [
      doc({ documentId: 'D011a', language: 'pl', syndicationFamilyId: 'family-nowak' }),
      doc({
        documentId: 'D011b',
        language: 'pl',
        tier: 1,
        issuingAuthorityId: 'court-pl-district',
        syndicationFamilyId: 'family-nowak',
      }),
    ],
    label: {
      identity: 'CORROBORATED',
      attribution: 'DIRECT_PERSONAL',
      category: 'FRAUD_FINANCIAL_CRIME',
      partyRole: 'ACCUSED_DEFENDANT_CRIMINAL',
      proceduralStage: 'ACQUITTAL_DISMISSAL_OVERTURNED',
      tenureLabel: 'UNKNOWN',
      band: 'CORROBORATED',
      independenceCount: 2,
      exclusionReason: null,
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [factor('FULL_DOB', 'STRONG', 'CORROBORATING', 'DOB matches the court record')],
      }),
      axisB: axisB(),
      axisC: axisC({
        partyRole: 'ACCUSED_DEFENDANT_CRIMINAL',
        proceduralStage: 'ACQUITTAL_DISMISSAL_OVERTURNED',
        namingAuthority: 'Sąd Rejonowy',
        eventDate: day('2025-02-11'),
        publicationDate: day('2025-02-12'),
      }),
      sources: [
        source({ documentId: 'D011a' }),
        source({ documentId: 'D011b', tier: 1, issuingAuthorityId: 'court-pl-district' }),
      ],
    },
  },
  {
    caseId: 'C012',
    entityId: 'E-correction-oyelaran',
    kinds: ['CORRECTION'],
    subjectName: 'Femi Oyelaran',
    language: 'en',
    jurisdiction: 'NG',
    note: 'T18: the publisher retracted the original report. The retraction suppresses the finding and notifies the reviewer.',
    documents: [doc({ documentId: 'D012', syndicationFamilyId: 'family-oyelaran' })],
    label: {
      identity: 'CORROBORATED',
      attribution: 'DIRECT_PERSONAL',
      category: 'BRIBERY_CORRUPTION',
      partyRole: 'ACCUSED_DEFENDANT_CRIMINAL',
      proceduralStage: 'CORRECTION_RETRACTION',
      tenureLabel: 'UNKNOWN',
      band: 'SUPPORTED',
      independenceCount: 1,
      exclusionReason: null,
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [
          factor(
            'OFFICIAL_RECORD_WITH_IDENTIFIER',
            'STRONG',
            'CORROBORATING',
            'Register entry cited',
          ),
        ],
      }),
      axisB: axisB(),
      axisC: axisC({
        category: 'BRIBERY_CORRUPTION',
        proceduralStage: 'CORRECTION_RETRACTION',
        namingAuthority: null,
      }),
      sources: [source({ documentId: 'D012' })],
    },
  },
  {
    caseId: 'C013',
    entityId: 'E-settlement-kaur',
    kinds: ['SETTLEMENT_NO_ADMISSION'],
    subjectName: 'Harpreet Kaur',
    language: 'en',
    jurisdiction: 'US',
    note: 'T75: consent order with an explicit no-admission clause. Guards I5 — never rendered as an admission.',
    documents: [doc({ documentId: 'D013', tier: 1, issuingAuthorityId: 'regulator-us-sec' })],
    label: {
      identity: 'CORROBORATED',
      attribution: 'DIRECT_PERSONAL',
      category: 'MARKET_ABUSE',
      partyRole: 'DEFENDANT_CIVIL',
      proceduralStage: 'SETTLEMENT_CONSENT_ORDER',
      tenureLabel: 'UNKNOWN',
      band: 'CORROBORATED',
      independenceCount: 1,
      exclusionReason: null,
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [
          factor(
            'OFFICIAL_RECORD_WITH_IDENTIFIER',
            'STRONG',
            'CORROBORATING',
            'SEC release names subject with CRD number',
          ),
        ],
      }),
      axisB: axisB(),
      axisC: axisC({
        category: 'MARKET_ABUSE',
        partyRole: 'DEFENDANT_CIVIL',
        proceduralStage: 'SETTLEMENT_CONSENT_ORDER',
        namingAuthority: 'Securities and Exchange Commission',
      }),
      sources: [source({ documentId: 'D013', tier: 1, issuingAuthorityId: 'regulator-us-sec' })],
    },
  },
  {
    caseId: 'C014',
    entityId: 'E-unspecified-role-diallo',
    kinds: ['UNSPECIFIED_ROLE'],
    subjectName: 'Aminata Diallo',
    language: 'fr',
    jurisdiction: 'SN',
    note: 'T76: the headline uses the word "fraude" but no span establishes a role or a stage. Guards I4.',
    documents: [doc({ documentId: 'D014', language: 'fr', tier: 3 })],
    label: {
      identity: 'CORROBORATED',
      attribution: 'DIRECT_PERSONAL',
      category: 'FRAUD_FINANCIAL_CRIME',
      partyRole: 'UNSPECIFIED',
      proceduralStage: 'UNSPECIFIED',
      tenureLabel: 'UNKNOWN',
      band: 'AMBIGUOUS',
      independenceCount: 1,
      exclusionReason: null,
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [factor('FULL_DOB', 'STRONG', 'CORROBORATING', 'DOB stated and matches')],
      }),
      axisB: axisB(),
      axisC: axisC({
        partyRole: 'UNSPECIFIED',
        proceduralStage: 'UNSPECIFIED',
        namingAuthority: null,
      }),
      sources: [source({ documentId: 'D014', tier: 3 })],
    },
  },
  {
    caseId: 'C015',
    entityId: 'E-tier5-blog-ferreira',
    kinds: ['SPARSE_IDENTITY'],
    subjectName: 'Rui Ferreira',
    language: 'pt',
    jurisdiction: 'BR',
    note: 'Tier 5 anonymous blog alleging fraud. Lead only, never a supported finding.',
    documents: [doc({ documentId: 'D015', language: 'pt', tier: 5 })],
    label: {
      identity: 'WEAK',
      attribution: 'DIRECT_PERSONAL',
      category: 'FRAUD_FINANCIAL_CRIME',
      partyRole: 'ACCUSED_DEFENDANT_CRIMINAL',
      proceduralStage: 'ALLEGATION',
      tenureLabel: 'UNKNOWN',
      band: 'LEAD_ONLY',
      independenceCount: 0,
      exclusionReason: null,
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [factor('COUNTRY_ONLY', 'WEAK', 'CORROBORATING', 'Country only')],
      }),
      axisB: axisB(),
      axisC: axisC({ proceduralStage: 'ALLEGATION', namingAuthority: null }),
      sources: [source({ documentId: 'D015', tier: 5 })],
    },
  },
  {
    caseId: 'C016',
    entityId: 'E-political-activism-mensah',
    kinds: ['UNSPECIFIED_ROLE'],
    subjectName: 'Kwabena Mensah',
    language: 'en',
    jurisdiction: 'GH',
    note: 'FR-03 exclusion: reporting concerns lawful protest and party membership. Excluded at classification time.',
    documents: [doc({ documentId: 'D016', tier: 2 })],
    label: {
      identity: 'CORROBORATED',
      attribution: 'DIRECT_PERSONAL',
      category: null,
      partyRole: 'ASSOCIATE_MENTIONED',
      proceduralStage: 'UNSPECIFIED',
      tenureLabel: 'UNKNOWN',
      band: 'LEAD_ONLY',
      independenceCount: 1,
      exclusionReason: 'POLITICAL_OPINION_OR_LAWFUL_ACTIVISM',
      discoverable: true,
    },
    scenario: {
      axisA: axisA({
        factors: [factor('FULL_DOB', 'STRONG', 'CORROBORATING', 'DOB matches')],
      }),
      axisB: axisB(),
      axisC: axisC({
        category: null,
        partyRole: 'ASSOCIATE_MENTIONED',
        proceduralStage: 'UNSPECIFIED',
        exclusionReason: 'POLITICAL_OPINION_OR_LAWFUL_ACTIVISM',
        namingAuthority: null,
      }),
      sources: [source({ documentId: 'D016' })],
    },
  },
];

export const SEED_DATASET: LabelledDataset = {
  datasetVersion: 'seed-2026-09-10',
  cases: SEED_CASES,
};
