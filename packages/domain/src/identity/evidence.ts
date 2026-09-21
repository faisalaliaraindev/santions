/**
 * FR-08 — the identity evidence resolver.
 *
 * # Why this file exists
 *
 * Axis A (`gradeIdentity`) was always correct. What was wrong was what got handed to it.
 *
 * The discovery pipeline used to build its own factor list inline, and that list contained two
 * defects that a reviewer reading a finding could not have detected:
 *
 *  1. it compared `subject.fullName` against `subject.fullName` — the subject's name to *itself* —
 *     so the name match was `EXACT` whenever the document mentioned the subject at all, whatever
 *     the document actually said;
 *  2. it asserted one hardcoded `RARE_FULL_NAME_PLUS_CITY` factor, a MODERATE identifier, which is
 *     enough on its own to lift Axis A to `PARTIAL` and therefore a finding to `SUPPORTED`. No city
 *     was ever read, from either side. The rationale served to the tenant described a check that
 *     had not run.
 *
 * Meanwhile the indexed-source path did the same job correctly, against real publisher fields. Two
 * implementations of one rule is how the wrong one survives: nobody fixing the good one knows the
 * other exists. So there is now exactly one, here, and both callers project into it.
 *
 * # The contract this file keeps
 *
 * **Both sides are supplied by the caller and are structurally distinct types.** A subject cannot
 * be passed where a document is expected. The defect above is not merely fixed, it is no longer
 * expressible: there is no path through this module in which the same string arrives on both
 * sides unless the document genuinely contains it.
 *
 * **A factor is asserted only when both sides had a value and they were compared.** Absence
 * produces no factor at all — never an `ABSENT` placeholder dressed as corroboration, and never a
 * factor whose `detail` describes an evaluation that did not happen. This is the FR-08 rule
 * "absence is not evidence against" applied one level earlier: absence is not evidence *for*
 * either.
 *
 * **A name match alone is a WEAK identifier.** `EXACT_COMMON_NAME` is WEAK in the FR-08 strength
 * table, and `gradeIdentity` maps "only weak identifiers" to `WEAK`, which `assignBand` maps to
 * `AMBIGUOUS`. That chain is what makes a namesake an open question rather than a confirmed
 * match, and nothing in this module may shortcut it.
 *
 * # What is deliberately not here
 *
 * `RARE_FULL_NAME_PLUS_CITY` has **no** implementation. The subject schema (FR-01
 * `subjectVersionSchema`) carries `countryContext` and no city, so there is no subject-side city
 * to compare a document city against. Writing the comparison anyway would produce a branch that
 * can never be true, which is how a fabricated factor comes back: the next reader sees the code,
 * assumes the check runs, and stops looking. When the subject schema gains a city, add it here,
 * with a test that fails without it.
 *
 * Pure: no I/O, no clock. Callers pass everything, including the transliteration port.
 */

import { matchNameForms, normaliseName, type NameMatch, type NameMatchForm } from './name-forms.js';
import { matchAcrossScripts, type TransliterationPort } from './transliteration.js';
import type { IdentityFactor } from './axis-a.js';

/** A half-open range in the document text that a factor points at. */
export interface EvidenceSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Where a name came from, on either side.
 *
 * Carried because an alias match is a different statement from a primary-name match, and a
 * reviewer has to be told which one happened: FR-08 requires aliases to be matched, and the
 * origin of an alias is part of its weight.
 */
export type NameRole = 'PRIMARY' | 'ALIAS' | 'ORIGINAL_SCRIPT';

export interface IdentityName {
  /** The string exactly as it appears on its side. Never a normalised form. */
  readonly text: string;
  readonly role: NameRole;
  /**
   * For an alias, where it came from (`aliasOriginSchema`, or the publisher's own label).
   * Null or absent for a primary name.
   */
  readonly origin?: string | null;
  /** Where in the document this name was read. Absent on the subject side. */
  readonly span?: EvidenceSpan | null;
}

/** A date with its declared precision. `RANGE` and `UNKNOWN` carry no comparable value. */
export interface IdentityDate {
  readonly value: string | null;
  readonly precision: 'DAY' | 'MONTH' | 'YEAR' | 'RANGE' | 'UNKNOWN';
}

export interface IdentityIdentifier {
  /** Passport, national id, tax number — as the issuer labels it. */
  readonly type: string;
  readonly value: string;
}

/** The subject side: what the tenant told us about the person being screened. */
export interface SubjectIdentityEvidence {
  readonly names: readonly IdentityName[];
  readonly datesOfBirth: readonly IdentityDate[];
  /** ISO 3166-1 alpha-2 identity context. */
  readonly countries: readonly string[];
  /** Companies the subject is associated with, from FR-01 intake or the FR-02 graph. */
  readonly companyNames: readonly string[];
  readonly identifiers: readonly IdentityIdentifier[];
}

/**
 * The document side: what *this document or record* states, read from it.
 *
 * Every field here must come from the artefact. A caller that copies a subject value into this
 * shape reintroduces the defect this module exists to remove.
 */
export interface DocumentIdentityEvidence {
  readonly names: readonly IdentityName[];
  readonly datesOfBirth: readonly IdentityDate[];
  readonly countries: readonly string[];
  readonly companyNames: readonly string[];
  readonly identifiers: readonly IdentityIdentifier[];
  /**
   * The document itself says the person it names is a different person of the same name
   * (FR-09 `NAMESAKE_DISTINGUISHED`). Passed through to `gradeIdentity` by the caller.
   */
  readonly distinguishesNamesake: boolean;
  /**
   * Span to attach to a factor established by a structured field rather than a text offset — a
   * publisher's `<dateOfBirth>` element has no position in prose. Null when there is none, and
   * the factor then carries a null span, which the `IdentityFactor` contract permits.
   */
  readonly fieldSpan?: EvidenceSpan | null;
}

export interface ResolvedIdentity {
  /** The strongest name agreement found between the two sides. */
  readonly match: NameMatch;
  /** The subject-side name that produced `match`. Null when nothing matched. */
  readonly matchedSubjectName: IdentityName | null;
  /**
   * The document-side name that produced `match`, **as written in the document**. Null when
   * nothing matched. This is the string the old discovery code could not produce at all.
   */
  readonly matchedDocumentName: IdentityName | null;
  /** Factors for `gradeIdentity`. Only comparisons that actually ran appear here. */
  readonly factors: readonly IdentityFactor[];
  /**
   * One line per comparison performed, for the reviewer-facing rationale. Describes inspected
   * evidence only — if a sentence is here, the comparison behind it ran.
   */
  readonly rationale: readonly string[];
}

const MATCH_RANK: readonly NameMatchForm[] = [
  'NO_MATCH',
  'PHONETIC',
  'SUBSET_PATRONYMIC',
  'INITIAL_EXPANSION',
  'PARTICLE_VARIANT',
  'EXACT_WORD_ORDER_VARIANT',
  'EXACT',
];

function rankOf(form: NameMatchForm): number {
  return MATCH_RANK.indexOf(form);
}

const NO_MATCH: NameMatch = { form: 'NO_MATCH', matchedForm: '', matchedScripts: [] };

/**
 * The strongest agreement across every (subject name x document name) pair.
 *
 * Both loops are required. Taking only the subject's primary name would miss an alias match;
 * taking only the document's primary name would miss a listing carrying the subject under one of
 * its "also known as" forms. FR-08 requires every retained form to be matched.
 */
function strongestNameMatch(
  subjectNames: readonly IdentityName[],
  documentNames: readonly IdentityName[],
  transliteration: TransliterationPort | null,
): {
  readonly match: NameMatch;
  readonly subject: IdentityName | null;
  readonly document: IdentityName | null;
  readonly viaRomanisation: string | null;
} {
  let best = NO_MATCH;
  let bestSubject: IdentityName | null = null;
  let bestDocument: IdentityName | null = null;
  let bestRomanisation: string | null = null;

  for (const subject of subjectNames) {
    if (subject.text.trim().length === 0) {
      continue;
    }
    const subjectNormalised = normaliseName(subject.text);
    for (const document of documentNames) {
      if (document.text.trim().length === 0) {
        continue;
      }
      const documentNormalised = normaliseName(document.text);
      const result =
        transliteration === null
          ? { ...matchNameForms(subjectNormalised, documentNormalised), viaRomanisation: null }
          : matchAcrossScripts(subjectNormalised, documentNormalised, transliteration);
      if (rankOf(result.form) > rankOf(best.form)) {
        best = {
          form: result.form,
          matchedForm: result.matchedForm,
          matchedScripts: result.matchedScripts,
        };
        bestSubject = subject;
        bestDocument = document;
        bestRomanisation = result.viaRomanisation;
      }
    }
  }

  return {
    match: best,
    subject: bestSubject,
    document: bestDocument,
    viaRomanisation: bestRomanisation,
  };
}

/** The comparable prefix of a date, or null when there is nothing to compare. */
function comparablePrefix(
  date: IdentityDate,
): { readonly key: string; readonly width: 4 | 7 | 10 } | null {
  if (date.value === null || date.precision === 'UNKNOWN' || date.precision === 'RANGE') {
    return null;
  }
  const width = date.precision === 'YEAR' ? 4 : date.precision === 'MONTH' ? 7 : 10;
  const key = date.value.slice(0, width);
  return key.length < width ? null : { key, width };
}

type DateVerdict =
  | {
      readonly kind: 'AGREE';
      readonly width: 4 | 7 | 10;
      readonly subject: string;
      readonly document: string;
    }
  | { readonly kind: 'CONFLICT'; readonly subject: string; readonly document: string }
  | { readonly kind: 'INCOMPARABLE' };

/**
 * Compare one subject date against one document date at the coarser of the two precisions.
 *
 * Two dates of different precision are compared at the precision they share: a subject born
 * "1974" and a record saying "1974-03-02" agree on everything both sides actually stated. That is
 * an agreement at year precision — worth a MODERATE identifier, not the STRONG one a full
 * date-of-birth agreement earns — and calling it a conflict because the strings differ would
 * discard a real corroboration and, worse, assert a contradiction nobody established.
 */
function compareDates(subject: IdentityDate, document: IdentityDate): DateVerdict {
  const a = comparablePrefix(subject);
  const b = comparablePrefix(document);
  if (a === null || b === null) {
    return { kind: 'INCOMPARABLE' };
  }
  const width = a.width < b.width ? a.width : b.width;
  const left = a.key.slice(0, width);
  const right = b.key.slice(0, width);
  return left === right
    ? { kind: 'AGREE', width, subject: a.key, document: b.key }
    : { kind: 'CONFLICT', subject: a.key, document: b.key };
}

function normaliseToken(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Build the Axis A input for one (subject, document) pair.
 *
 * Returns `match.form === 'NO_MATCH'` when no name form agreed. A caller should normally drop the
 * candidate at that point rather than grade it: `gradeIdentity` handles `NO_MATCH` by returning
 * `WEAK`, which is correct for a document that mentions the subject in some other way, but a
 * retrieval hit with no name agreement at all is not a finding about this person.
 */
export function resolveIdentityEvidence(
  subject: SubjectIdentityEvidence,
  document: DocumentIdentityEvidence,
  options?: { readonly transliteration?: TransliterationPort | null },
): ResolvedIdentity {
  const transliteration = options?.transliteration ?? null;
  const named = strongestNameMatch(subject.names, document.names, transliteration);
  const factors: IdentityFactor[] = [];
  const rationale: string[] = [];

  const fieldSpan = document.fieldSpan ?? null;

  if (named.match.form === 'NO_MATCH') {
    rationale.push(
      `No name form agreed: ${String(subject.names.length)} subject form(s) were compared ` +
        `against ${String(document.names.length)} name(s) read from the document.`,
    );
    return {
      match: NO_MATCH,
      matchedSubjectName: null,
      matchedDocumentName: null,
      factors,
      rationale,
    };
  }

  const subjectName = named.subject;
  const documentName = named.document;

  // The name factor. WEAK, always: the FR-08 table puts EXACT_COMMON_NAME in the weak row
  // precisely so that a name agreement cannot carry a finding on its own.
  const subjectSide =
    subjectName?.role === 'ALIAS'
      ? `subject alias "${subjectName.text}"` +
        (subjectName.origin == null ? '' : ` (origin ${subjectName.origin})`)
      : `subject name "${subjectName?.text ?? ''}"`;
  const documentSide =
    documentName?.role === 'ALIAS'
      ? `alias "${documentName.text}" recorded by the document` +
        (documentName.origin == null ? '' : ` (origin ${documentName.origin})`)
      : documentName?.role === 'ORIGINAL_SCRIPT'
        ? `original-script name "${documentName.text}" in the document`
        : `"${documentName?.text ?? ''}" as written in the document`;
  const viaNote =
    named.viaRomanisation === null ? '' : ` via romanisation "${named.viaRomanisation}"`;

  const nameDetail = `Name agreement ${named.match.form}: ${subjectSide} matched ${documentSide}${viaNote}.`;
  factors.push({
    kind: 'EXACT_COMMON_NAME',
    strength: 'WEAK',
    direction: 'CORROBORATING',
    span: documentName?.span ?? fieldSpan,
    detail: nameDetail,
  });
  rationale.push(nameDetail);

  if (subjectName?.role === 'ALIAS' || documentName?.role === 'ALIAS') {
    rationale.push(
      'The agreement is on an alias rather than a primary name; the alias and its origin are ' +
        'recorded on the finding as the evidence that produced it.',
    );
  }
  if (named.viaRomanisation !== null || documentName?.role === 'ORIGINAL_SCRIPT') {
    rationale.push(
      'The names agreed across scripts. The form stored on the finding is the one the document ' +
        'used, not the romanisation used to find it (FR-08).',
    );
  }

  // ---- Date of birth ----------------------------------------------------------------------
  // Evaluated only when both sides state one. The strongest agreement wins; a conflict is
  // asserted only when *every* date stated by the document conflicts with every date stated by
  // the subject record, because a listing carrying several dates of birth for one person is
  // offering alternatives, not contradicting itself.
  const subjectDates = subject.datesOfBirth.filter((date) => comparablePrefix(date) !== null);
  const documentDates = document.datesOfBirth.filter((date) => comparablePrefix(date) !== null);

  if (subjectDates.length > 0 && documentDates.length > 0) {
    let bestAgreement: Extract<DateVerdict, { kind: 'AGREE' }> | null = null;
    const conflicts: Extract<DateVerdict, { kind: 'CONFLICT' }>[] = [];

    for (const subjectDate of subjectDates) {
      for (const documentDate of documentDates) {
        const verdict = compareDates(subjectDate, documentDate);
        if (verdict.kind === 'AGREE') {
          if (bestAgreement === null || verdict.width > bestAgreement.width) {
            bestAgreement = verdict;
          }
        } else if (verdict.kind === 'CONFLICT') {
          conflicts.push(verdict);
        }
      }
    }

    if (bestAgreement !== null) {
      // Agreement on a day-precision date is the STRONG identifier FR-08 describes. Agreement at
      // year or year-month precision is MODERATE: a shared birth year narrows the population a
      // great deal and settles nothing on its own.
      const full = bestAgreement.width === 10;
      const detail = full
        ? `Date of birth agrees exactly: subject ${bestAgreement.subject} and document ` +
          `${bestAgreement.document}.`
        : `Date of birth agrees at the precision both sides stated ` +
          `(${bestAgreement.width === 4 ? 'year' : 'year and month'}): subject ` +
          `${bestAgreement.subject}, document ${bestAgreement.document}.`;
      factors.push({
        kind: full ? 'FULL_DOB' : 'DOB_YEAR_MONTH',
        strength: full ? 'STRONG' : 'MODERATE',
        direction: 'CORROBORATING',
        span: fieldSpan,
        detail,
      });
      rationale.push(detail);
    } else if (conflicts.length > 0) {
      const shown = conflicts[0];
      const against =
        conflicts.length === 1
          ? `document ${shown?.document ?? ''}`
          : `every one of the ${String(documentDates.length)} dates stated by the document`;
      const detail =
        `Date of birth conflicts: subject ${shown?.subject ?? ''} against ${against}. The ` +
        'difference is larger than the precision either side declared.';
      factors.push({
        kind: 'DOB_DIFFERS_BEYOND_PRECISION',
        strength: 'STRONG',
        direction: 'CONTRADICTING',
        span: fieldSpan,
        detail,
      });
      rationale.push(detail);
    }
  }

  // ---- Identifiers ------------------------------------------------------------------------
  // A government or passport number agreeing is the strongest thing either side can say.
  // Compared on the normalised value; the type is reported but is not required to agree, because
  // two issuers label the same document differently.
  const documentIdentifiers = new Map(
    document.identifiers
      .filter((identifier) => normaliseToken(identifier.value).length > 0)
      .map((identifier) => [normaliseToken(identifier.value), identifier] as const),
  );
  if (documentIdentifiers.size > 0) {
    for (const subjectIdentifier of subject.identifiers) {
      const hit = documentIdentifiers.get(normaliseToken(subjectIdentifier.value));
      if (hit !== undefined) {
        const detail =
          `Identifier agrees: subject ${subjectIdentifier.type} ${subjectIdentifier.value} ` +
          `matches ${hit.type} ${hit.value} stated by the document.`;
        factors.push({
          kind: 'GOVERNMENT_OR_PASSPORT_ID',
          strength: 'STRONG',
          direction: 'CORROBORATING',
          span: fieldSpan,
          detail,
        });
        rationale.push(detail);
        break;
      }
    }
  }

  // ---- Company / association evidence ------------------------------------------------------
  // A company the subject is associated with, named in this document. MODERATE, and never more:
  // it says the document is about the right circle, not that it is about the right person.
  const documentCompanies = new Map(
    document.companyNames
      .filter((name) => normaliseToken(name).length > 0)
      .map((name) => [normaliseToken(name), name] as const),
  );
  if (documentCompanies.size > 0) {
    for (const companyName of subject.companyNames) {
      const hit = documentCompanies.get(normaliseToken(companyName));
      if (hit !== undefined) {
        const detail =
          `Association evidence: "${hit}", a company recorded against the subject, is named in ` +
          'the document alongside the matched name.';
        factors.push({
          kind: 'CO_OCCURRING_ASSOCIATE_IN_GRAPH',
          strength: 'MODERATE',
          direction: 'CORROBORATING',
          span: fieldSpan,
          detail,
        });
        rationale.push(detail);
        break;
      }
    }
  }

  // ---- Country / nationality ---------------------------------------------------------------
  // WEAK by the FR-08 table, and correctly so: a shared nationality excludes very little.
  const subjectCountries = new Set(
    subject.countries.map((country) => country.trim().toUpperCase()).filter((c) => c.length > 0),
  );
  if (subjectCountries.size > 0) {
    const overlap = document.countries
      .map((country) => country.trim().toUpperCase())
      .filter((country) => country.length > 0 && subjectCountries.has(country));
    if (overlap.length > 0) {
      const detail =
        `Country context overlaps: ${[...new Set(overlap)].sort().join(', ')} appears both on ` +
        'the subject record and in the country, nationality or citizenship data of the document.';
      factors.push({
        kind: 'COUNTRY_ONLY',
        strength: 'WEAK',
        direction: 'CORROBORATING',
        span: fieldSpan,
        detail,
      });
      rationale.push(detail);
    }
  }

  // The honest closing sentence when nothing but the name was available to compare. It states
  // what was *not* present rather than implying a check passed — a tenant reading an AMBIGUOUS
  // finding needs the difference between "we checked and it agreed" and "there was nothing to
  // check".
  if (factors.length === 1) {
    rationale.push(
      'No discriminator beyond the name could be compared: the document states no date of ' +
        'birth, identifier, associated company or country that the subject record also states. ' +
        'Identity is not established on a name alone.',
    );
  }

  return {
    match: named.match,
    matchedSubjectName: subjectName,
    matchedDocumentName: documentName,
    factors,
    rationale,
  };
}
