/**
 * FR-08 Axis A — identity resolution.
 *
 * "Is the person in this document the subject?"
 *
 * The governing rule of this file: **absence is not evidence against; contradiction is.**
 * A document that does not state a date of birth tells us nothing. A document that states a
 * different date of birth tells us a great deal.
 */

import type { NameMatchForm } from './name-forms.js';

export const IDENTITY_GRADES = ['CORROBORATED', 'PARTIAL', 'WEAK', 'CONTRADICTED'] as const;
export type IdentityGrade = (typeof IDENTITY_GRADES)[number];

export type IdentifierStrength = 'STRONG' | 'MODERATE' | 'WEAK';
export type IdentifierDirection = 'CORROBORATING' | 'ABSENT' | 'CONTRADICTING';

/** Identifier kinds, grouped by the strength table in FR-08. */
export const IDENTIFIER_KINDS = {
  STRONG: [
    'GOVERNMENT_OR_PASSPORT_ID',
    'FULL_DOB',
    'COMPANY_REGISTRATION_WITH_OFFICER_ROLE',
    'OFFICIAL_RECORD_WITH_IDENTIFIER',
  ],
  MODERATE: [
    'DOB_YEAR_MONTH',
    'STATED_AGE_CONSISTENT',
    'RARE_FULL_NAME_PLUS_CITY',
    'EMPLOYER_PLUS_JOB_TITLE',
    'NAMED_POSITION_HELD',
    'CO_OCCURRING_ASSOCIATE_IN_GRAPH',
    'PHOTOGRAPH_CAPTION_UPPER_TIER',
  ],
  WEAK: ['EXACT_COMMON_NAME', 'COUNTRY_ONLY', 'SECTOR_ONLY', 'APPROXIMATE_AGE', 'BROAD_CITY'],
} as const;

export type IdentifierKind =
  | (typeof IDENTIFIER_KINDS.STRONG)[number]
  | (typeof IDENTIFIER_KINDS.MODERATE)[number]
  | (typeof IDENTIFIER_KINDS.WEAK)[number];

/** Contradiction kinds from the fourth row of the FR-08 table. */
export const CONTRADICTION_KINDS = [
  'DOB_DIFFERS_BEYOND_PRECISION',
  'NATIONALITY_INCONSISTENT_WITH_EXCLUSIVE_CLAIM',
  'INCOMPATIBLE_DOCUMENTED_OCCUPATION',
  'SUBJECT_DEMONSTRABLY_ELSEWHERE',
  'DOCUMENT_DISTINGUISHES_SAME_NAMED_PERSON',
] as const;
export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number];

export interface IdentityFactor {
  readonly kind: IdentifierKind | ContradictionKind;
  readonly strength: IdentifierStrength;
  readonly direction: IdentifierDirection;
  /** Span in the normalised document supporting this factor. Null only for ABSENT. */
  readonly span: { readonly start: number; readonly end: number } | null;
  /** Human-readable statement shown to the reviewer, e.g. "DOB 1974-03-02 vs 1981-11-19". */
  readonly detail: string;
}

/**
 * FR-01 name-frequency prior. Computed at intake for the subject name in its relevant
 * population, and visible to reviewers.
 */
export interface NameFrequencyPrior {
  /** 1 = rarest decile, 10 = most common decile within the population. */
  readonly decile: number;
  readonly population: string;
  /** Where the figure came from, e.g. a national statistics name distribution. */
  readonly sourceRef: string;
}

/** A name in the top decile of frequency carries a penalty (FR-08, T71). */
export function isHighFrequencyName(prior: NameFrequencyPrior | null): boolean {
  return prior !== null && prior.decile >= 10;
}

export interface AxisAInput {
  readonly nameMatch: NameMatchForm;
  readonly factors: readonly IdentityFactor[];
  readonly frequencyPrior: NameFrequencyPrior | null;
  /**
   * True when the document's extracted party role is NAMESAKE_DISTINGUISHED — the document
   * itself says this is a different person (FR-09).
   */
  readonly documentDistinguishesNamesake: boolean;
}

export interface AxisAResult {
  readonly grade: IdentityGrade;
  /** Factors that supported the grade, for the FR-13 "matching identity factors" display. */
  readonly corroborating: readonly IdentityFactor[];
  /** Shown as "identity factors absent" — never counted against the subject. */
  readonly absent: readonly IdentityFactor[];
  readonly contradicting: readonly IdentityFactor[];
  /** True when the top-decile penalty was applied and not offset (T71). */
  readonly frequencyPenaltyApplied: boolean;
  /** Ordered, human-readable reasons. Rendered verbatim in the evidence detail view. */
  readonly rationale: readonly string[];
}

function countBy(
  factors: readonly IdentityFactor[],
  strength: IdentifierStrength,
  direction: IdentifierDirection,
): number {
  return factors.filter((f) => f.strength === strength && f.direction === direction).length;
}

/**
 * Grade Axis A.
 *
 * Reading of the FR-08 table:
 *  - one STRONG corroborating identifier reaches CORROBORATED;
 *  - two independent MODERATE identifiers reach CORROBORATED, one reaches PARTIAL;
 *  - WEAK identifiers are never sufficient alone and support WEAK at most;
 *  - a STRONG contradiction blocks automatic resolution outright, even at exact name match;
 *  - one MODERATE contradiction downgrades, two contradict outright.
 */
export function gradeIdentity(input: AxisAInput): AxisAResult {
  const rationale: string[] = [];
  const corroborating = input.factors.filter((f) => f.direction === 'CORROBORATING');
  const absent = input.factors.filter((f) => f.direction === 'ABSENT');
  const contradicting = input.factors.filter((f) => f.direction === 'CONTRADICTING');

  if (input.documentDistinguishesNamesake) {
    return {
      grade: 'CONTRADICTED',
      corroborating,
      absent,
      contradicting,
      frequencyPenaltyApplied: false,
      rationale: ['The document explicitly distinguishes a same-named person from the subject.'],
    };
  }

  const strongAgainst = countBy(input.factors, 'STRONG', 'CONTRADICTING');
  const moderateAgainst = countBy(input.factors, 'MODERATE', 'CONTRADICTING');

  if (strongAgainst > 0) {
    // "Blocks automatic resolution outright, even at exact name match." Overridable only by
    // an explicit reasoned human review recorded as possible source error (invariant I2).
    rationale.push(
      `${String(strongAgainst)} strong identifier contradiction(s) present; identity cannot be resolved automatically at any name-match strength.`,
    );
    return {
      grade: 'CONTRADICTED',
      corroborating,
      absent,
      contradicting,
      frequencyPenaltyApplied: false,
      rationale,
    };
  }

  if (moderateAgainst >= 2) {
    rationale.push('Two or more moderate identifier contradictions.');
    return {
      grade: 'CONTRADICTED',
      corroborating,
      absent,
      contradicting,
      frequencyPenaltyApplied: false,
      rationale,
    };
  }

  if (input.nameMatch === 'NO_MATCH') {
    rationale.push('No name form matched between the subject and the document.');
    return {
      grade: 'WEAK',
      corroborating,
      absent,
      contradicting,
      frequencyPenaltyApplied: false,
      rationale,
    };
  }

  const strongFor = countBy(input.factors, 'STRONG', 'CORROBORATING');
  const moderateFor = countBy(input.factors, 'MODERATE', 'CORROBORATING');
  const weakFor = countBy(input.factors, 'WEAK', 'CORROBORATING');

  let grade: IdentityGrade;
  if (strongFor >= 1) {
    grade = 'CORROBORATED';
    rationale.push(`${String(strongFor)} strong corroborating identifier(s).`);
  } else if (moderateFor >= 2) {
    grade = 'CORROBORATED';
    rationale.push(`${String(moderateFor)} independent moderate corroborating identifiers.`);
  } else if (moderateFor === 1) {
    grade = 'PARTIAL';
    rationale.push('One moderate corroborating identifier.');
  } else {
    grade = 'WEAK';
    rationale.push(
      weakFor > 0
        ? `Only weak identifiers (${String(weakFor)}); never sufficient alone.`
        : 'Name form matched but no corroborating identifier was found in the document.',
    );
  }

  // "One [moderate contradiction] downgrades."
  if (moderateAgainst === 1 && grade !== 'WEAK') {
    grade = grade === 'CORROBORATED' ? 'PARTIAL' : 'WEAK';
    rationale.push('Downgraded by one moderate identifier contradiction.');
  }

  // FR-08 frequency prior: a top-decile name must be offset by moderate or strong
  // identifiers. Weak identifiers cannot offset it.
  let frequencyPenaltyApplied = false;
  if (isHighFrequencyName(input.frequencyPrior) && strongFor === 0 && moderateFor < 2) {
    const before = grade;
    grade = grade === 'CORROBORATED' ? 'PARTIAL' : 'WEAK';
    frequencyPenaltyApplied = grade !== before || grade === 'WEAK';
    rationale.push(
      `Name-frequency penalty: decile ${String(input.frequencyPrior?.decile)} in ${String(input.frequencyPrior?.population)}; not offset by strong or two moderate identifiers.`,
    );
  }

  // A phonetic-only or patronymic-subset name agreement is not an exact-name signal.
  if (
    (input.nameMatch === 'PHONETIC' || input.nameMatch === 'SUBSET_PATRONYMIC') &&
    grade === 'CORROBORATED' &&
    strongFor === 0
  ) {
    grade = 'PARTIAL';
    rationale.push(`Name agreement is ${input.nameMatch} only, without a strong identifier.`);
  }

  return { grade, corroborating, absent, contradicting, frequencyPenaltyApplied, rationale };
}
