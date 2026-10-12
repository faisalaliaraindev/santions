/**
 * FR-02 resolution — the rules that decide whether a register record is the customer.
 *
 * The property under test throughout is the one T14 names: a name match, however exact, never
 * attaches a company.
 */

import { describe, expect, it } from 'vitest';

import {
  compareDates,
  mayAttachCompanies,
  normaliseName,
  officerIdentityFactors,
  parseIdentifierDate,
  resolveOfficer,
  statusForGrade,
  strongestNameMatch,
  type NameFrequencyPrior,
  type ResolutionCandidate,
  type ResolutionSubject,
} from '../../src/index.js';

const SHARED_NAME = 'María Fernanda Solís Rojas';

function subject(overrides: Partial<ResolutionSubject> = {}): ResolutionSubject {
  return {
    name: normaliseName(SHARED_NAME),
    aliases: [],
    dateOfBirth: { value: '1972-03-15', precision: 'DAY' },
    countryContext: ['CR'],
    knownCompanyRefs: [],
    frequencyPrior: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<ResolutionCandidate> = {}): ResolutionCandidate {
  return {
    officerRef: 'cr-officer-0001',
    name: normaliseName(SHARED_NAME),
    jurisdiction: 'CR',
    identifiers: [],
    companyRefs: [],
    ...overrides,
  };
}

describe('a name match alone', () => {
  it('never resolves, even at an exact match on a full name', () => {
    const result = resolveOfficer(subject({ dateOfBirth: null }), candidate({ identifiers: [] }));
    expect(result.nameMatch).toBe('EXACT');
    expect(result.status).toBe('UNRESOLVED');
    expect(mayAttachCompanies(result.status)).toBe(false);
  });

  it('explains itself in terms a reviewer can act on', () => {
    const result = resolveOfficer(subject({ dateOfBirth: null }), candidate());
    expect(result.rationale.join(' ')).toMatch(/name match alone never attributes a company/i);
  });

  it('is the expected outcome of a name-only search, not an error (D-011)', () => {
    // Nothing thrown, nothing null: an answer, and the answer is "we cannot attribute this".
    const result = resolveOfficer(subject({ dateOfBirth: null, countryContext: [] }), candidate());
    expect(result.grade).toBe('WEAK');
    expect(result.factors.some((f) => f.direction === 'ABSENT')).toBe(true);
  });
});

describe('T14 — two officers, one name, different partial dates of birth', () => {
  const subjectBorn1972 = subject({ dateOfBirth: { value: '1972-03-15', precision: 'DAY' } });

  const officerA = candidate({
    officerRef: 'cr-officer-0001',
    identifiers: [{ kind: 'DATE_OF_BIRTH', value: '1972-03', partial: true }],
  });
  const officerB = candidate({
    officerRef: 'cr-officer-0002',
    identifiers: [{ kind: 'DATE_OF_BIRTH', value: '1985-11', partial: true }],
  });

  it('excludes the one whose date of birth contradicts', () => {
    const result = resolveOfficer(subjectBorn1972, officerB);
    expect(result.status).toBe('CONTRADICTED');
    expect(mayAttachCompanies(result.status)).toBe(false);
  });

  it('does not resolve the one that merely agrees to the month', () => {
    // One moderate identifier is PARTIAL, and PARTIAL does not attach. This is the assertion
    // the whole design turns on: a birth month and year shared by a common name in a small
    // country is not attribution.
    const result = resolveOfficer(subjectBorn1972, officerA);
    expect(result.grade).toBe('PARTIAL');
    expect(result.status).toBe('CANDIDATE_FOR_REVIEW');
    expect(mayAttachCompanies(result.status)).toBe(false);
  });

  it('surfaces the near match rather than hiding it', () => {
    const result = resolveOfficer(subjectBorn1972, officerA);
    expect(result.rationale.join(' ')).toMatch(/candidate for review/i);
    expect(result.factors.some((f) => f.direction === 'CORROBORATING')).toBe(true);
  });

  it('resolves only when a second, independent signal agrees', () => {
    // The client supplied the company, and the register puts this officer in it. That is a
    // registration record carrying an officer role — strong, in FR-08's table.
    const result = resolveOfficer(
      subject({
        dateOfBirth: { value: '1972-03-15', precision: 'DAY' },
        knownCompanyRefs: ['CR-3101-100001'],
      }),
      candidate({ ...officerA, companyRefs: ['CR-3101-100001'] }),
    );
    expect(result.status).toBe('RESOLVED');
    expect(mayAttachCompanies(result.status)).toBe(true);
  });

  it('still does not resolve the contradicted officer when the company agrees', () => {
    // A strong contradiction blocks automatic resolution outright, even against a strong
    // corroborating identifier. Two people can be officers of the same company.
    const result = resolveOfficer(
      subject({ knownCompanyRefs: ['CR-3101-100006'] }),
      candidate({ ...officerB, companyRefs: ['CR-3101-100006'] }),
    );
    expect(result.status).toBe('CONTRADICTED');
  });
});

describe('date comparison at shared precision', () => {
  it('does not manufacture a contradiction from a precision the register never claimed', () => {
    expect(
      compareDates(
        { value: '1971-04-22', precision: 'DAY' },
        { value: '1971-04-01', precision: 'MONTH' },
      ),
    ).toBe('AGREES_TO_COARSER');
  });

  it('contradicts when the disagreement survives the coarser precision', () => {
    expect(
      compareDates(
        { value: '1971-04-22', precision: 'DAY' },
        { value: '1985-11-01', precision: 'MONTH' },
      ),
    ).toBe('DIFFERS');
  });

  it('treats a year-only register date as agreeing on the year alone', () => {
    expect(
      compareDates(
        { value: '1971-04-22', precision: 'DAY' },
        { value: '1971-01-01', precision: 'YEAR' },
      ),
    ).toBe('AGREES_TO_COARSER');
    expect(
      compareDates(
        { value: '1971-04-22', precision: 'DAY' },
        { value: '1972-01-01', precision: 'YEAR' },
      ),
    ).toBe('DIFFERS');
  });

  it('is not comparable when either side is unknown', () => {
    expect(
      compareDates(
        { value: null, precision: 'UNKNOWN' },
        { value: '1971-04-01', precision: 'MONTH' },
      ),
    ).toBe('NOT_COMPARABLE');
  });

  it('reads precision from the register string rather than assuming a day', () => {
    expect(parseIdentifierDate('1971-04-22')).toEqual({ value: '1971-04-22', precision: 'DAY' });
    expect(parseIdentifierDate('1971-04')).toEqual({ value: '1971-04-01', precision: 'MONTH' });
    expect(parseIdentifierDate('1971')).toEqual({ value: '1971-01-01', precision: 'YEAR' });
    expect(parseIdentifierDate('April 1971')).toEqual({ value: null, precision: 'UNKNOWN' });
  });
});

describe('absence is never evidence against', () => {
  it('records a missing subject date of birth as absent, not as a contradiction', () => {
    const factors = officerIdentityFactors(
      subject({ dateOfBirth: null }),
      candidate({ identifiers: [{ kind: 'DATE_OF_BIRTH', value: '1972-03', partial: true }] }),
    );
    const dob = factors.find((f) => f.kind === 'DOB_YEAR_MONTH');
    expect(dob?.direction).toBe('ABSENT');
  });

  it('records a register that publishes no date of birth as absent', () => {
    const factors = officerIdentityFactors(subject(), candidate({ identifiers: [] }));
    expect(factors.find((f) => f.kind === 'DOB_YEAR_MONTH')?.direction).toBe('ABSENT');
  });

  it('does not contradict on a nationality outside the subject’s country context', () => {
    // A country context is not an exclusive claim. People hold more than one nationality and
    // live away from both, and FR-08 contradicts only against an exclusive claim.
    const factors = officerIdentityFactors(
      subject({ countryContext: ['CR'] }),
      candidate({ identifiers: [{ kind: 'NATIONALITY', value: 'NI', partial: false }] }),
    );
    expect(factors.some((f) => f.direction === 'CONTRADICTING')).toBe(false);
  });
});

describe('the name-frequency prior', () => {
  const commonName: NameFrequencyPrior = {
    decile: 10,
    population: 'CR',
    sourceRef: 'test',
  };

  it('holds a top-decile name back from resolving on one moderate identifier', () => {
    const result = resolveOfficer(
      subject({ frequencyPrior: commonName }),
      candidate({ identifiers: [{ kind: 'DATE_OF_BIRTH', value: '1972-03', partial: true }] }),
    );
    expect(result.frequencyPenaltyApplied).toBe(true);
    expect(result.status).not.toBe('RESOLVED');
  });

  it('is offset by a strong identifier, as FR-08 says it must be', () => {
    const result = resolveOfficer(
      subject({ frequencyPrior: commonName, knownCompanyRefs: ['CR-3101-100001'] }),
      candidate({ companyRefs: ['CR-3101-100001'] }),
    );
    expect(result.status).toBe('RESOLVED');
    expect(result.frequencyPenaltyApplied).toBe(false);
  });

  it('applies no penalty when no distribution has been measured', () => {
    // A null prior is "we do not know", never "this name is rare". The CR distribution is not
    // loaded, so this is the live behaviour today — see the handoff for what it costs.
    const result = resolveOfficer(
      subject({ frequencyPrior: null }),
      candidate({ identifiers: [{ kind: 'DATE_OF_BIRTH', value: '1972-03', partial: true }] }),
    );
    expect(result.frequencyPenaltyApplied).toBe(false);
    expect(result.status).toBe('CANDIDATE_FOR_REVIEW');
  });
});

describe('name forms', () => {
  it('takes the strongest agreement across the subject’s aliases', () => {
    const match = strongestNameMatch(
      subject({
        name: normaliseName('Someone Else Entirely'),
        aliases: [normaliseName(SHARED_NAME)],
      }),
      candidate(),
    );
    expect(match).toBe('EXACT');
  });

  it('returns NO_MATCH when nothing agrees, and that never resolves', () => {
    const result = resolveOfficer(
      subject({ name: normaliseName('Someone Else Entirely') }),
      candidate(),
    );
    expect(result.nameMatch).toBe('NO_MATCH');
    expect(result.status).toBe('UNRESOLVED');
  });
});

describe('the grade-to-status table', () => {
  it('lets only CORROBORATED attach companies', () => {
    expect(statusForGrade('CORROBORATED')).toBe('RESOLVED');
    expect(statusForGrade('PARTIAL')).toBe('CANDIDATE_FOR_REVIEW');
    expect(statusForGrade('WEAK')).toBe('UNRESOLVED');
    expect(statusForGrade('CONTRADICTED')).toBe('CONTRADICTED');

    expect(mayAttachCompanies('RESOLVED')).toBe(true);
    for (const status of ['CANDIDATE_FOR_REVIEW', 'UNRESOLVED', 'CONTRADICTED'] as const) {
      expect(mayAttachCompanies(status)).toBe(false);
    }
  });
});
