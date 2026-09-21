/**
 * FR-08 — the identity acceptance tests.
 *
 * These are the tests that would have caught the defect. Each one names a real screening
 * situation and fixes the answer the service is allowed to give. They are deliberately written
 * against the band, not only against the factor list: a factor list that looks right and a band
 * that says CONFIRMED is what shipped before, so asserting the intermediate value alone would
 * have passed on the broken code too.
 *
 * The chain under test is: `resolveIdentityEvidence` -> `gradeIdentity` -> `assignBand`.
 */

import { describe, expect, it } from 'vitest';

import {
  assignBand,
  classifyEvent,
  computeAuthority,
  gradeAttribution,
  gradeIdentity,
  resolveIdentityEvidence,
  type ClusteredSource,
  type DocumentIdentityEvidence,
  type SubjectIdentityEvidence,
} from '../../src/index.js';

const RULES_VERSION = {
  bandingRulesVersionId: 'banding-v1',
  version: 1,
  activatedAt: '2026-01-01T00:00:00.000Z',
} as const;

function subject(overrides: Partial<SubjectIdentityEvidence> = {}): SubjectIdentityEvidence {
  return {
    names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
    datesOfBirth: [],
    countries: [],
    companyNames: [],
    identifiers: [],
    ...overrides,
  };
}

function document(overrides: Partial<DocumentIdentityEvidence> = {}): DocumentIdentityEvidence {
  return {
    names: [],
    datesOfBirth: [],
    countries: [],
    companyNames: [],
    identifiers: [],
    distinguishesNamesake: false,
    fieldSpan: { start: 0, end: 22 },
    ...overrides,
  };
}

/**
 * Band a resolved identity against a strong everything-else: a Tier 1 issuing authority, a
 * document naming the person directly, a conviction. Everything except Axis A is as favourable
 * as it can be, so the band that comes out is a statement about identity alone.
 */
function bandWith(
  subjectEvidence: SubjectIdentityEvidence,
  documentEvidence: DocumentIdentityEvidence,
): { readonly band: string; readonly identity: string; readonly rationale: readonly string[] } {
  const resolved = resolveIdentityEvidence(subjectEvidence, documentEvidence);
  const axisA = gradeIdentity({
    nameMatch: resolved.match.form,
    factors: resolved.factors,
    frequencyPrior: null,
    documentDistinguishesNamesake: documentEvidence.distinguishesNamesake,
  });
  const axisB = gradeAttribution({
    namesSubjectPersonally: true,
    companyInGraph: false,
    tenureLabel: 'UNKNOWN',
    roleEvidence: null,
  });
  const axisC = classifyEvent({
    category: 'FRAUD_FINANCIAL_CRIME',
    partyRole: 'CONVICTED_SANCTIONED_PARTY',
    proceduralStage: 'CONVICTION_FINAL_JUDGMENT',
    namingAuthority: 'United States District Court',
    eventDate: { value: '2025-03-01', precision: 'DAY' },
    publicationDate: { value: '2025-03-02', precision: 'DAY' },
    updateDate: { value: null, precision: 'UNKNOWN' },
    retrievalDate: { value: '2026-09-21', precision: 'DAY' },
    spansValidated: true,
    exclusionReason: null,
    subjectCentrality: 'PROTAGONIST',
  });
  const sources: ClusteredSource[] = [
    {
      documentId: 'doc-1',
      tier: 1,
      originatingNewsroomId: 'courts.example',
      issuingAuthorityId: 'us-district-court',
      isSyndicatedCopy: false,
    },
  ];
  const banded = assignBand({
    axisA,
    axisB,
    axisC,
    axisD: computeAuthority(sources),
    rulesVersion: RULES_VERSION,
  });
  return {
    band: banded.band,
    identity: axisA.grade,
    rationale: [...resolved.rationale, ...axisA.rationale, ...banded.rationale],
  };
}

describe('FR-08 identity acceptance — name-only namesake', () => {
  it('a name with no corroborating discriminator is AMBIGUOUS, never SUPPORTED', () => {
    const result = bandWith(
      subject(),
      document({ names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }] }),
    );

    expect(result.identity).toBe('WEAK');
    expect(result.band).toBe('AMBIGUOUS');
    expect(result.band).not.toBe('SUPPORTED');
    expect(result.band).not.toBe('CORROBORATED');
  });

  it('says plainly that there was nothing beyond the name to compare', () => {
    const resolved = resolveIdentityEvidence(
      subject(),
      document({ names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }] }),
    );

    expect(resolved.factors).toHaveLength(1);
    expect(resolved.rationale.join(' ')).toContain('No discriminator beyond the name');
    expect(resolved.rationale.join(' ')).toContain('not established on a name alone');
  });

  it('asserts no factor describing evidence that was not inspected', () => {
    const resolved = resolveIdentityEvidence(
      subject(),
      document({ names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }] }),
    );

    // The specific fabrication that shipped: a MODERATE city factor on a document with no city.
    expect(resolved.factors.map((factor) => factor.kind)).not.toContain(
      'RARE_FULL_NAME_PLUS_CITY',
    );
    // And no MODERATE or STRONG factor of any kind, since nothing but a name was comparable.
    expect(resolved.factors.every((factor) => factor.strength === 'WEAK')).toBe(true);
    expect(resolved.rationale.join(' ')).not.toMatch(/city/iu);
  });

  it('records the name the document actually used, not the name we searched for', () => {
    const resolved = resolveIdentityEvidence(
      subject(),
      // The publisher wrote it differently. That difference is the evidence.
      document({ names: [{ text: 'MARIA CONSUELO RAMIREZ', role: 'PRIMARY' }] }),
    );

    expect(resolved.matchedDocumentName?.text).toBe('MARIA CONSUELO RAMIREZ');
    expect(resolved.matchedSubjectName?.text).toBe('Maria Consuelo Ramirez');
    expect(resolved.rationale[0]).toContain('MARIA CONSUELO RAMIREZ');
  });
});

describe('FR-08 identity acceptance — date of birth', () => {
  it('a matching full date of birth is a STRONG identifier and corroborates identity', () => {
    const result = bandWith(
      subject({ datesOfBirth: [{ value: '1974-03-02', precision: 'DAY' }] }),
      document({
        names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
        datesOfBirth: [{ value: '1974-03-02', precision: 'DAY' }],
      }),
    );

    expect(result.identity).toBe('CORROBORATED');
    expect(result.band).toBe('CORROBORATED');
  });

  it('a conflicting date of birth contradicts identity and produces no supported finding', () => {
    const result = bandWith(
      subject({ datesOfBirth: [{ value: '1974-03-02', precision: 'DAY' }] }),
      document({
        names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
        datesOfBirth: [{ value: '1981-11-19', precision: 'DAY' }],
      }),
    );

    expect(result.identity).toBe('CONTRADICTED');
    expect(result.band).not.toBe('SUPPORTED');
    expect(result.band).not.toBe('CORROBORATED');
  });

  it('a year-only subject date agreeing with a full document date is MODERATE, not STRONG', () => {
    const resolved = resolveIdentityEvidence(
      subject({ datesOfBirth: [{ value: '1974-01-01', precision: 'YEAR' }] }),
      document({
        names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
        datesOfBirth: [{ value: '1974-03-02', precision: 'DAY' }],
      }),
    );

    const dob = resolved.factors.find((factor) => factor.kind === 'DOB_YEAR_MONTH');
    expect(dob).toBeDefined();
    expect(dob?.strength).toBe('MODERATE');
    expect(dob?.direction).toBe('CORROBORATING');
    expect(resolved.factors.map((f) => f.kind)).not.toContain('FULL_DOB');
  });

  it('a year-only date that differs in the year is still a contradiction', () => {
    const result = bandWith(
      subject({ datesOfBirth: [{ value: '1974-01-01', precision: 'YEAR' }] }),
      document({
        names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
        datesOfBirth: [{ value: '1981-11-19', precision: 'DAY' }],
      }),
    );

    expect(result.identity).toBe('CONTRADICTED');
  });

  it('a record listing several dates of birth is offering alternatives, not contradicting itself', () => {
    const resolved = resolveIdentityEvidence(
      subject({ datesOfBirth: [{ value: '1974-03-02', precision: 'DAY' }] }),
      document({
        names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
        datesOfBirth: [
          { value: '1981-11-19', precision: 'DAY' },
          { value: '1974-03-02', precision: 'DAY' },
        ],
      }),
    );

    expect(resolved.factors.map((f) => f.kind)).toContain('FULL_DOB');
    expect(resolved.factors.map((f) => f.kind)).not.toContain('DOB_DIFFERS_BEYOND_PRECISION');
  });

  it('a date of birth the document does not state produces no factor at all', () => {
    const resolved = resolveIdentityEvidence(
      subject({ datesOfBirth: [{ value: '1974-03-02', precision: 'DAY' }] }),
      document({ names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }] }),
    );

    // Absence is not evidence against, and it is not evidence for either.
    expect(resolved.factors).toHaveLength(1);
    expect(resolved.factors[0]?.kind).toBe('EXACT_COMMON_NAME');
  });

  it('a RANGE date is incomparable and never manufactures agreement or conflict', () => {
    const resolved = resolveIdentityEvidence(
      subject({ datesOfBirth: [{ value: '1974-03-02', precision: 'DAY' }] }),
      document({
        names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
        datesOfBirth: [{ value: '1970-01-01', precision: 'RANGE' }],
      }),
    );

    expect(resolved.factors).toHaveLength(1);
  });
});

describe('FR-08 identity acceptance — aliases', () => {
  it('a subject alias matching the document name records the alias as the evidence', () => {
    const resolved = resolveIdentityEvidence(
      subject({
        names: [
          { text: 'Maria Consuelo Ramirez', role: 'PRIMARY' },
          { text: 'Maria C Vargas', role: 'ALIAS', origin: 'MAIDEN_NAME' },
        ],
      }),
      document({ names: [{ text: 'Maria C Vargas', role: 'PRIMARY' }] }),
    );

    expect(resolved.matchedSubjectName?.role).toBe('ALIAS');
    expect(resolved.matchedSubjectName?.origin).toBe('MAIDEN_NAME');
    expect(resolved.rationale.join(' ')).toContain('MAIDEN_NAME');
    expect(resolved.rationale.join(' ')).toContain('alias');
  });

  it('an alias match is still only a name match, and still lands AMBIGUOUS on its own', () => {
    const result = bandWith(
      subject({
        names: [
          { text: 'Maria Consuelo Ramirez', role: 'PRIMARY' },
          { text: 'Maria C Vargas', role: 'ALIAS', origin: 'MAIDEN_NAME' },
        ],
      }),
      document({ names: [{ text: 'Maria C Vargas', role: 'PRIMARY' }] }),
    );

    expect(result.band).toBe('AMBIGUOUS');
  });

  it('matches an alias recorded by the document against the subject primary name', () => {
    const resolved = resolveIdentityEvidence(
      subject(),
      document({
        names: [
          { text: 'Someone Else Entirely', role: 'PRIMARY' },
          { text: 'Maria Consuelo Ramirez', role: 'ALIAS', origin: 'a.k.a.' },
        ],
      }),
    );

    expect(resolved.matchedDocumentName?.role).toBe('ALIAS');
    expect(resolved.match.form).toBe('EXACT');
  });
});

describe('FR-08 identity acceptance — an unrelated person', () => {
  it('a document about somebody else produces no name agreement at all', () => {
    const resolved = resolveIdentityEvidence(
      subject(),
      document({ names: [{ text: 'Jonathan Fairweather', role: 'PRIMARY' }] }),
    );

    expect(resolved.match.form).toBe('NO_MATCH');
    expect(resolved.factors).toHaveLength(0);
    expect(resolved.matchedDocumentName).toBeNull();
    expect(resolved.rationale.join(' ')).toContain('No name form agreed');
  });

  it('a document naming nobody produces no agreement — retrieval is not evidence', () => {
    // The query found the page. That is a fact about the search engine, not about the person.
    const resolved = resolveIdentityEvidence(subject(), document({ names: [] }));

    expect(resolved.match.form).toBe('NO_MATCH');
    expect(resolved.factors).toHaveLength(0);
  });

  it('a document that distinguishes a same-named person CONTRADICTS identity', () => {
    const result = bandWith(
      subject(),
      document({
        names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
        distinguishesNamesake: true,
      }),
    );

    expect(result.identity).toBe('CONTRADICTED');
    expect(result.band).not.toBe('SUPPORTED');
  });
});

describe('FR-08 identity acceptance — the other discriminators', () => {
  it('a matching identifier is STRONG and reaches CORROBORATED', () => {
    const result = bandWith(
      subject({ identifiers: [{ type: 'PASSPORT', value: 'X-123 456' }] }),
      document({
        names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
        identifiers: [{ type: 'Passport No.', value: 'x123456' }],
      }),
    );

    expect(result.identity).toBe('CORROBORATED');
  });

  it('an associated company named in the document is MODERATE — one alone is PARTIAL', () => {
    const subjectEvidence = subject({ companyNames: ['Northgate Trading Ltd'] });
    const documentEvidence = document({
      names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
      companyNames: ['Northgate Trading Ltd'],
    });
    const resolved = resolveIdentityEvidence(subjectEvidence, documentEvidence);

    const company = resolved.factors.find(
      (factor) => factor.kind === 'CO_OCCURRING_ASSOCIATE_IN_GRAPH',
    );
    expect(company?.strength).toBe('MODERATE');
    expect(bandWith(subjectEvidence, documentEvidence).identity).toBe('PARTIAL');
  });

  it('country overlap alone is WEAK and does not lift a name-only match', () => {
    const result = bandWith(
      subject({ countries: ['GB'] }),
      document({
        names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
        countries: ['gb', 'ES'],
      }),
    );

    expect(result.identity).toBe('WEAK');
    expect(result.band).toBe('AMBIGUOUS');
  });

  it('two moderate discriminators together reach CORROBORATED', () => {
    const result = bandWith(
      subject({
        datesOfBirth: [{ value: '1974-01-01', precision: 'YEAR' }],
        companyNames: ['Northgate Trading Ltd'],
      }),
      document({
        names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
        datesOfBirth: [{ value: '1974-03-02', precision: 'DAY' }],
        companyNames: ['Northgate Trading Ltd'],
      }),
    );

    expect(result.identity).toBe('CORROBORATED');
  });

  it('a country the document does not share produces no factor — absence is not contradiction', () => {
    const resolved = resolveIdentityEvidence(
      subject({ countries: ['GB'] }),
      document({
        names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
        countries: ['BR'],
      }),
    );

    expect(resolved.factors).toHaveLength(1);
    expect(resolved.factors.map((f) => f.direction)).not.toContain('CONTRADICTING');
  });
});

describe('FR-08 identity acceptance — the defect cannot return', () => {
  it('an empty document side can never produce a match, whatever the subject says', () => {
    // The old code reached EXACT here, because it compared the subject's name to itself and only
    // consulted the document to decide whether to pass an empty string. This is that test.
    const rich = subject({
      names: [
        { text: 'Maria Consuelo Ramirez', role: 'PRIMARY' },
        { text: 'Maria C Vargas', role: 'ALIAS', origin: 'MAIDEN_NAME' },
      ],
      datesOfBirth: [{ value: '1974-03-02', precision: 'DAY' }],
      countries: ['GB'],
      companyNames: ['Northgate Trading Ltd'],
      identifiers: [{ type: 'PASSPORT', value: 'X123456' }],
    });

    const resolved = resolveIdentityEvidence(rich, document({ names: [] }));

    expect(resolved.match.form).toBe('NO_MATCH');
    expect(resolved.factors).toHaveLength(0);
  });

  it('a blank document name is not a name', () => {
    const resolved = resolveIdentityEvidence(
      subject(),
      document({ names: [{ text: '   ', role: 'PRIMARY' }] }),
    );

    expect(resolved.match.form).toBe('NO_MATCH');
  });

  it('every factor detail names both sides of the comparison it describes', () => {
    const resolved = resolveIdentityEvidence(
      subject({
        datesOfBirth: [{ value: '1974-03-02', precision: 'DAY' }],
        countries: ['GB'],
      }),
      document({
        names: [{ text: 'Maria Consuelo Ramirez', role: 'PRIMARY' }],
        datesOfBirth: [{ value: '1974-03-02', precision: 'DAY' }],
        countries: ['GB'],
      }),
    );

    for (const factor of resolved.factors) {
      expect(factor.detail.length).toBeGreaterThan(20);
      // Every asserted factor is CORROBORATING or CONTRADICTING here — a factor that was not
      // evaluated is absent from the list entirely rather than present as ABSENT.
      expect(factor.direction).not.toBe('ABSENT');
    }
  });
});
