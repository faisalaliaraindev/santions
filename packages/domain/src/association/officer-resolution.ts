/**
 * FR-02 — resolving a subject to an officer record.
 *
 * **Resolution is an identity grade, not a string comparison.** That sentence is the whole
 * point of this file. A company register will happily return four people called "Juan Carlos
 * Rodríguez", and the difference between a screening product and a liability is whether their
 * companies attach to your customer because the strings matched.
 *
 * So nothing here compares names and decides. It assembles the same `IdentityFactor` list that
 * FR-08 Axis A consumes for a document, hands it to `gradeIdentity`, and translates the grade
 * into what the graph is allowed to do with the officer. One grading function, one table, one
 * set of rules — a second, register-specific notion of "matched enough" would drift from the
 * document one, and the two would disagree about the same person in the same run.
 *
 * **The four statuses and what each permits:**
 *
 * | Grade          | Status                 | The graph may…                                   |
 * | :------------- | :--------------------- | :----------------------------------------------- |
 * | `CORROBORATED` | `RESOLVED`             | attach the companies and anchor queries on them  |
 * | `PARTIAL`      | `CANDIDATE_FOR_REVIEW` | show the companies, anchor nothing               |
 * | `WEAK`         | `UNRESOLVED`           | show the officer, attach nothing                 |
 * | `CONTRADICTED` | `CONTRADICTED`         | nothing — the register says this is someone else |
 *
 * **`PARTIAL` does not attach**, and this is the decision most worth arguing with. One moderate
 * identifier — a year-and-month of birth that agrees — feels like enough when you are looking at
 * one candidate. It is not, and T14 is the reason: a register publishing a birth month and year
 * for a common name in a country of five million will hand you several people who agree on it.
 * FR-02 says unresolved officers must not attach companies automatically, and "automatically" is
 * doing the work — a reviewer may still look at the candidate and decide. The candidate is
 * therefore surfaced, not hidden, and nothing anchors a query to it.
 *
 * **A name match alone yields `UNRESOLVED`, and that is the expected outcome of a name-only
 * search** (D-011), not a gap to be closed later by loosening this.
 */

import { gradeIdentity, type IdentityFactor, type NameFrequencyPrior } from '../identity/axis-a.js';
import { matchNameForms, type NameMatchForm, type NormalisedName } from '../identity/name-forms.js';
import type { PreciseDate } from '../tenure/tenure.js';

export const RESOLUTION_STATUSES = [
  'RESOLVED',
  'CANDIDATE_FOR_REVIEW',
  'UNRESOLVED',
  'CONTRADICTED',
] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

/** What the subject record offers the comparison. */
export interface ResolutionSubject {
  readonly name: NormalisedName;
  /** Alias forms, already normalised. Each is tried; the strongest agreement wins. */
  readonly aliases: readonly NormalisedName[];
  readonly dateOfBirth: PreciseDate | null;
  /** ISO 3166-1 alpha-2 identity context. Context, never a search scope. */
  readonly countryContext: readonly string[];
  /**
   * Registration numbers the client supplied as known companies (FR-01).
   *
   * Load-bearing, and the reason a resolution can reach `CORROBORATED` at all in practice: if
   * the client tells us their customer directs company X, and the register says a person of
   * that name is an officer of company X, that is a registration record carrying an officer
   * role — the strong identifier in FR-08's table. Without something like it, a register that
   * publishes only a partial date of birth can never produce more than one moderate factor.
   */
  readonly knownCompanyRefs: readonly string[];
  readonly frequencyPrior: NameFrequencyPrior | null;
}

/** What the register offers, as the register publishes it. */
export interface ResolutionCandidate {
  readonly officerRef: string;
  readonly name: NormalisedName;
  readonly jurisdiction: string;
  readonly identifiers: readonly {
    readonly kind: string;
    readonly value: string;
    readonly partial: boolean;
  }[];
  /** Company references already attributed to this officer, where the search returned them. */
  readonly companyRefs: readonly string[];
}

export interface OfficerResolution {
  readonly officerRef: string;
  readonly status: ResolutionStatus;
  readonly grade: ReturnType<typeof gradeIdentity>['grade'];
  readonly nameMatch: NameMatchForm;
  readonly factors: readonly IdentityFactor[];
  /** Ordered and human-readable. Rendered verbatim to a reviewer; never summarised away. */
  readonly rationale: readonly string[];
  readonly frequencyPenaltyApplied: boolean;
}

/**
 * Parse a register's date-of-birth string into a date with declared precision.
 *
 * Registers publish `1971-04`, `1971`, or occasionally a full date. The precision is read from
 * the shape rather than assumed, because the comparison below is only sound if both sides know
 * how much they actually know. A `1971-04` read as `1971-04-01` at DAY precision manufactures a
 * contradiction against a subject born `1971-04-22`.
 */
export function parseIdentifierDate(raw: string): PreciseDate {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { value: raw, precision: 'DAY' };
  }
  if (/^\d{4}-\d{2}$/.test(raw)) {
    return { value: `${raw}-01`, precision: 'MONTH' };
  }
  if (/^\d{4}$/.test(raw)) {
    return { value: `${raw}-01-01`, precision: 'YEAR' };
  }
  return { value: null, precision: 'UNKNOWN' };
}

/** How much of a date is actually known, coarsest first. */
const PRECISION_RANK: Readonly<Record<PreciseDate['precision'], number>> = {
  UNKNOWN: 0,
  YEAR: 1,
  MONTH: 2,
  DAY: 3,
};

type DateAgreement = 'AGREES_TO_DAY' | 'AGREES_TO_COARSER' | 'DIFFERS' | 'NOT_COMPARABLE';

/**
 * Compare two dates **at the precision both of them share**.
 *
 * The rule that matters: a disagreement only counts when it survives the coarser of the two
 * precisions. `1971-04-22` and `1971-04` agree, because the second one never claimed a day.
 * `1971-04-22` and `1985-11` differ, because they disagree on the year, which both claimed.
 */
export function compareDates(a: PreciseDate, b: PreciseDate): DateAgreement {
  if (a.value === null || b.value === null) {
    return 'NOT_COMPARABLE';
  }
  const shared = Math.min(PRECISION_RANK[a.precision], PRECISION_RANK[b.precision]);
  if (shared === 0) {
    return 'NOT_COMPARABLE';
  }
  // 4 characters for a year, 7 for a year and month, 10 for a full date.
  const length = shared === 1 ? 4 : shared === 2 ? 7 : 10;
  if (a.value.slice(0, length) !== b.value.slice(0, length)) {
    return 'DIFFERS';
  }
  return shared === 3 ? 'AGREES_TO_DAY' : 'AGREES_TO_COARSER';
}

/** The strongest name agreement across the subject's primary name and every alias. */
export function strongestNameMatch(
  subject: ResolutionSubject,
  candidate: ResolutionCandidate,
): NameMatchForm {
  const forms: NameMatchForm[] = [subject.name, ...subject.aliases].map(
    (form) => matchNameForms(form, candidate.name).form,
  );
  const ORDER: readonly NameMatchForm[] = [
    'EXACT',
    'EXACT_WORD_ORDER_VARIANT',
    'PARTICLE_VARIANT',
    'INITIAL_EXPANSION',
    'SUBSET_PATRONYMIC',
    'PHONETIC',
    'NO_MATCH',
  ];
  for (const form of ORDER) {
    if (forms.includes(form)) {
      return form;
    }
  }
  return 'NO_MATCH';
}

/**
 * Turn what the register published into Axis A factors.
 *
 * Exported because the factor list is shown to a reviewer as the explanation of the resolution,
 * and a caller that wants to display it should be reading the same list the grade was computed
 * from — not rebuilding a parallel one for the screen.
 */
export function officerIdentityFactors(
  subject: ResolutionSubject,
  candidate: ResolutionCandidate,
): readonly IdentityFactor[] {
  const factors: IdentityFactor[] = [];

  const publishedDob = candidate.identifiers.find((i) => i.kind === 'DATE_OF_BIRTH');

  if (subject.dateOfBirth === null || subject.dateOfBirth.value === null) {
    // Absence is never evidence against. The subject simply supplied no date of birth, and
    // FR-01 is explicit that a sparse identity may be searched — it stays unresolved rather
    // than being invented.
    factors.push({
      kind: 'DOB_YEAR_MONTH',
      strength: 'MODERATE',
      direction: 'ABSENT',
      span: null,
      detail: 'The subject record carries no date of birth, so none could be compared.',
    });
  } else if (publishedDob === undefined) {
    factors.push({
      kind: 'DOB_YEAR_MONTH',
      strength: 'MODERATE',
      direction: 'ABSENT',
      span: null,
      detail: 'The register publishes no date of birth for this officer.',
    });
  } else {
    const registerDate = parseIdentifierDate(publishedDob.value);
    const agreement = compareDates(subject.dateOfBirth, registerDate);
    switch (agreement) {
      case 'AGREES_TO_DAY':
        factors.push({
          kind: 'FULL_DOB',
          strength: 'STRONG',
          direction: 'CORROBORATING',
          span: null,
          detail: `Date of birth agrees exactly: ${publishedDob.value}.`,
        });
        break;
      case 'AGREES_TO_COARSER':
        factors.push({
          kind: 'DOB_YEAR_MONTH',
          strength: 'MODERATE',
          direction: 'CORROBORATING',
          span: null,
          detail:
            `Date of birth agrees as far as the register publishes it ` +
            `(${publishedDob.value}), which is not a full date.`,
        });
        break;
      case 'DIFFERS':
        factors.push({
          kind: 'DOB_DIFFERS_BEYOND_PRECISION',
          strength: 'STRONG',
          direction: 'CONTRADICTING',
          span: null,
          detail:
            `Date of birth differs beyond the precision either side claims: subject ` +
            `${subject.dateOfBirth.value} versus register ${publishedDob.value}.`,
        });
        break;
      case 'NOT_COMPARABLE':
        factors.push({
          kind: 'DOB_YEAR_MONTH',
          strength: 'MODERATE',
          direction: 'ABSENT',
          span: null,
          detail: `The register's date of birth could not be read: "${publishedDob.value}".`,
        });
        break;
    }
  }

  // The strong signal, when the client supplied companies and the register agrees.
  const shared = candidate.companyRefs.filter((ref) => subject.knownCompanyRefs.includes(ref));
  if (shared.length > 0) {
    factors.push({
      kind: 'COMPANY_REGISTRATION_WITH_OFFICER_ROLE',
      strength: 'STRONG',
      direction: 'CORROBORATING',
      span: null,
      detail:
        `The register records this officer at ${shared.join(', ')}, which the client supplied ` +
        `as a known company of the subject.`,
    });
  }

  const nationality = candidate.identifiers.find((i) => i.kind === 'NATIONALITY');
  if (nationality !== undefined && subject.countryContext.includes(nationality.value)) {
    // Weak, and weak on purpose: a shared nationality in a single-jurisdiction register is
    // true of nearly everyone in it. Note what is *not* here — a nationality outside the
    // subject's country context is not recorded as a contradiction. FR-08 contradicts only on
    // a nationality inconsistent with an **exclusive** claim, and a country context is not an
    // exclusive claim: people hold more than one nationality and live away from both.
    factors.push({
      kind: 'COUNTRY_ONLY',
      strength: 'WEAK',
      direction: 'CORROBORATING',
      span: null,
      detail: `Nationality ${nationality.value} is within the subject's country context.`,
    });
  }

  const locality = candidate.identifiers.find((i) => i.kind === 'ADDRESS_LOCALITY');
  if (locality !== undefined) {
    factors.push({
      kind: 'BROAD_CITY',
      strength: 'WEAK',
      direction: 'CORROBORATING',
      span: null,
      detail: `The register publishes a locality for this officer: ${locality.value}.`,
    });
  }

  return factors;
}

/** Grade → what the graph may do with this officer. See the table in the file header. */
export function statusForGrade(grade: OfficerResolution['grade']): ResolutionStatus {
  switch (grade) {
    case 'CORROBORATED':
      return 'RESOLVED';
    case 'PARTIAL':
      return 'CANDIDATE_FOR_REVIEW';
    case 'WEAK':
      return 'UNRESOLVED';
    case 'CONTRADICTED':
      return 'CONTRADICTED';
  }
}

/** True when the graph may attach this officer's companies and anchor queries on them. */
export function mayAttachCompanies(status: ResolutionStatus): boolean {
  return status === 'RESOLVED';
}

/**
 * Resolve one candidate officer against the subject.
 *
 * Pure. No register call, no clock, no database. The caller fetched the candidate; this decides
 * what it is worth.
 */
export function resolveOfficer(
  subject: ResolutionSubject,
  candidate: ResolutionCandidate,
): OfficerResolution {
  const nameMatch = strongestNameMatch(subject, candidate);
  const factors = officerIdentityFactors(subject, candidate);

  const graded = gradeIdentity({
    nameMatch,
    factors,
    frequencyPrior: subject.frequencyPrior,
    // A register record cannot say "this is a different person of the same name" — that is a
    // statement a document makes in prose, and a register has no prose. Always false here, and
    // deliberately not wired to anything that could set it.
    documentDistinguishesNamesake: false,
  });

  const status = statusForGrade(graded.grade);

  const rationale = [
    nameMatch === 'NO_MATCH'
      ? 'No name form matched between the subject and the officer record.'
      : `Name agreement: ${nameMatch}.`,
    ...graded.rationale,
    status === 'RESOLVED'
      ? 'Resolved: the register record is attributed to the subject, and its companies attach.'
      : status === 'CANDIDATE_FOR_REVIEW'
        ? 'Not resolved. Shown as a candidate for review; no company attaches and no query is ' +
          'anchored on one (FR-02).'
        : status === 'CONTRADICTED'
          ? 'Excluded: the register record contradicts the subject on a strong identifier.'
          : 'Not resolved. A name match alone never attributes a company to a person.',
  ];

  return {
    officerRef: candidate.officerRef,
    status,
    grade: graded.grade,
    nameMatch,
    factors,
    rationale,
    frequencyPenaltyApplied: graded.frequencyPenaltyApplied,
  };
}
