/**
 * Phase D step D6 — what a taxonomy version must satisfy before it can become `ACTIVE`, and the
 * effective scope a search resolves under one.
 *
 * # Why activation and not CI
 *
 * `assertLexiconClean` already fails the build (T79). That catches a term an engineer commits; it
 * catches nothing a `taxonomy_admin` types into the admin API at three in the afternoon. The
 * taxonomy is **versioned configuration data**, editable at runtime by design, so the enforcement
 * point has to be the transition that makes it queryable.
 *
 * **Block at activation, warn at draft save.** An admin should see the problem while they are
 * still editing — refusing to save a half-finished draft is how people end up keeping their real
 * taxonomy in a spreadsheet — but a draft cannot reach a source, and `ACTIVE` can.
 *
 * # The three refusals, and why each one is a refusal rather than a warning
 *
 * 1. **A protected-characteristic term.** SEC-05. It must never leave the service as an outbound
 *    query term, and there is no version of "warn and continue" that is compatible with that.
 * 2. **A language enabled without a measured recall figure.** FR-03 and D-010. The seed carries
 *    `es` and `en` as *requested, unmeasured*, and the entire coverage statement rests on that
 *    distinction. An admin toggle that flipped it to enabled would erase it silently — the run
 *    would stop reporting the language as unmeasured, and a reviewer would read a narrow result
 *    as a complete one.
 * 3. **A category enabled for a country with no approved source coverage.** Enablement without
 *    sources produces a category that is searched for and never found, which reads to a reviewer
 *    as a clean result *for that category*. That is the specific false statement this whole
 *    service exists to avoid making.
 *
 * # Purity
 *
 * The caller supplies the facts that need I/O — which countries have an approved active source,
 * and what the currently active taxonomy version says. Nothing here reads a database.
 */

import { auditLexicon } from './lexicon-audit.js';
import type { AdverseCategory } from './categories.js';
import type {
  CountryCode,
  LanguageProfile,
  LanguageTag,
  LexiconTerm,
  TaxonomyVersion,
} from './types.js';

export const TAXONOMY_REFUSAL_CODES = [
  'PROTECTED_CHARACTERISTIC_TERM',
  'MACHINE_TRANSLATED_TERM',
  'LANGUAGE_ENABLED_WITHOUT_MEASUREMENT',
  'RECALL_NOT_SET_BY_EVALUATION',
  'CATEGORY_WITHOUT_SOURCE_COVERAGE',
] as const;
export type TaxonomyRefusalCode = (typeof TAXONOMY_REFUSAL_CODES)[number];

export interface TaxonomyRefusal {
  readonly code: TaxonomyRefusalCode;
  /** Written for the administrator who has to fix it. Named field, named value, named rule. */
  readonly detail: string;
}

export interface TaxonomyActivationInput {
  readonly candidate: TaxonomyVersion;
  /**
   * The version currently `ACTIVE` for this tenant, or null for the first one.
   *
   * Needed only for the measurement rule: an admin edit is detected by comparing the candidate's
   * language profiles against what is live, because recall is not a field an administrator gets
   * to author at all.
   */
  readonly active: TaxonomyVersion | null;
  /**
   * Countries in which at least one source version is `ACTIVE` and approved.
   *
   * Supplied by the caller because it is a database read. An empty set means no source is
   * approved anywhere, and every enabled category is then refused — which is correct, and is
   * why the seed enables categories only for countries its seeded sources cover.
   */
  readonly countriesWithApprovedSource: readonly CountryCode[];
}

/**
 * Has an administrator changed a measurement?
 *
 * `measuredRecall` is settable only by an evaluation run (FR-16), never by an admin edit, and
 * this is how that is enforced: the candidate's language profiles must match the active
 * version's exactly. Any difference — a recall appearing, a recall changing, a run id being
 * attached — is an admin edit, because the admin API is the only thing that produced this
 * version.
 *
 * An evaluation run does not go through this path. It writes the measurement directly, and the
 * next proposed version inherits it; that is the seam FR-16 fills at G10, and until it exists no
 * language can become enabled — which is the honest state and exactly what the coverage
 * statement says today.
 */
function measurementChanged(
  candidate: LanguageProfile,
  active: LanguageProfile | undefined,
): boolean {
  if (active === undefined) {
    // A language appearing for the first time may be declared, but only as unmeasured.
    return candidate.measuredRecall !== null || candidate.measuredByEvaluationRunId !== null;
  }
  return (
    candidate.measuredRecall !== active.measuredRecall ||
    candidate.measuredByEvaluationRunId !== active.measuredByEvaluationRunId
  );
}

/**
 * Every reason this version may not become `ACTIVE`.
 *
 * Returns all of them, not the first. An administrator fixing a seventeen-category taxonomy one
 * round trip per mistake stops using the API and starts writing to the collection directly,
 * which is how the approval trail gets bypassed.
 */
export function auditTaxonomyForActivation(
  input: TaxonomyActivationInput,
): readonly TaxonomyRefusal[] {
  const refusals: TaxonomyRefusal[] = [];
  const { candidate } = input;

  // 1. SEC-05 / T79.
  const lexicon = auditLexicon(candidate.lexicon);
  for (const violation of lexicon.violations) {
    refusals.push({
      code: 'PROTECTED_CHARACTERISTIC_TERM',
      detail:
        `"${violation.term}" (${violation.language}, ${violation.kind}) maps to the protected ` +
        `characteristic stem "${violation.matchedStem}". A protected characteristic must never ` +
        `leave the service as an outbound query term (FR-03, SEC-05).`,
    });
  }

  // 1b. D-010: a machine-translated term is never activatable, in any language. The usable
  // Costa Rican Spanish terms for "charged" or "indicted" are not dictionary translations of the
  // English words, and a machine-translated list looks fully configured while missing every real
  // court report. The field records provenance; this is what makes recording it mean something.
  for (const term of candidate.lexicon) {
    if (term.reviewState === 'MACHINE_TRANSLATED') {
      refusals.push({
        code: 'MACHINE_TRANSLATED_TERM',
        detail:
          `"${term.term}" (${term.language}) is marked MACHINE_TRANSLATED. Decision D-010 ` +
          `forbids activating a machine-translated term: it must be authored or reviewed by ` +
          `someone who reads the language.`,
      });
    }
  }

  // 2. FR-03 / FR-16 / D-010.
  const activeLanguages = new Map(
    (input.active?.languages ?? []).map((profile) => [profile.language, profile]),
  );
  for (const profile of candidate.languages) {
    if (profile.measuredRecall !== null && profile.measuredByEvaluationRunId === null) {
      refusals.push({
        code: 'LANGUAGE_ENABLED_WITHOUT_MEASUREMENT',
        detail:
          `Language "${profile.language}" declares measuredRecall ` +
          `${String(profile.measuredRecall)} with no evaluation run id. A recall figure with no ` +
          `run behind it is an assertion, not a measurement (FR-16).`,
      });
      continue;
    }
    if (measurementChanged(profile, activeLanguages.get(profile.language))) {
      refusals.push({
        code: 'RECALL_NOT_SET_BY_EVALUATION',
        detail:
          `Language "${profile.language}": measuredRecall and measuredByEvaluationRunId are ` +
          `settable only by an evaluation run (FR-16), never by an administrative edit. ` +
          `Propose this version without changing them.`,
      });
    }
  }

  // 3. A category enabled where nothing can look for it.
  const covered = new Set(input.countriesWithApprovedSource);
  for (const category of candidate.categories) {
    for (const country of category.enabledCountries) {
      if (!covered.has(country)) {
        refusals.push({
          code: 'CATEGORY_WITHOUT_SOURCE_COVERAGE',
          detail:
            `Category ${category.category} is enabled for ${country}, which has no approved ` +
            `active source. A category that is searched for and never found reads to a ` +
            `reviewer as a clean result for that category.`,
        });
      }
    }
  }

  return refusals;
}

/**
 * The warning form, for a draft save.
 *
 * Same audit, no throwing. An admin editing a draft sees the problem immediately and can fix it
 * before asking anybody to approve it.
 */
export function warnOnTaxonomyDraft(input: TaxonomyActivationInput): readonly TaxonomyRefusal[] {
  return auditTaxonomyForActivation(input);
}

/** One line per refusal, for an audit reason and an error message. */
export function summariseTaxonomyRefusals(refusals: readonly TaxonomyRefusal[]): string {
  return refusals.map((refusal) => `${refusal.code}: ${refusal.detail}`).join(' ');
}

/**
 * The effective scope of a search, under a taxonomy version, in one country.
 *
 * Exposed here — pure, testable with no infrastructure — so that **"a disabled category is never
 * queried" is provable now** rather than being an assertion about Phase E code that does not
 * exist yet. `buildQueryPlan` already consumes `enabledCategories`; this is the same resolution
 * made explicit, with the things a coverage statement needs alongside it.
 */
export interface EffectiveScope {
  readonly country: CountryCode;
  /** Categories enabled for this country. A category absent here is never queried. */
  readonly categories: readonly AdverseCategory[];
  /** Categories the taxonomy declares but does not enable here. Reported, never searched. */
  readonly excludedCategories: readonly AdverseCategory[];
  /**
   * Languages the search will actually run in: those requested that the taxonomy declares.
   *
   * Deliberately **not** filtered to measured languages. Refusing to run in an unmeasured
   * language would mean the service does nothing at all until G10 measures one, and the honest
   * alternative is to run and say so — which is what `unmeasuredLanguages` below is for.
   */
  readonly languages: readonly LanguageTag[];
  /** Requested languages the taxonomy does not declare at all. Not searched. */
  readonly undeclaredLanguages: readonly LanguageTag[];
  /** Searched languages carrying no measured recall figure (FR-03, T80). */
  readonly unmeasuredLanguages: readonly LanguageTag[];
  /** Terms usable in this scope, already narrowed to enabled categories and searched languages. */
  readonly terms: readonly LexiconTerm[];
  /**
   * Enabled categories that have **no term** in any searched language.
   *
   * Today this is every category, because the lexicon is empty for most of them. It is reported
   * rather than hidden: a category with no terms is searched only by the bare-name families, so
   * calling its empty result "nothing found for this category" would overstate what happened.
   */
  readonly categoriesWithoutTerms: readonly AdverseCategory[];
  /** Searched languages whose terms have not been reviewed by a speaker (D-010). */
  readonly unreviewedTermLanguages: readonly LanguageTag[];
}

export function resolveEffectiveScope(input: {
  readonly taxonomy: TaxonomyVersion;
  readonly country: CountryCode;
  readonly requestedLanguages: readonly LanguageTag[];
}): EffectiveScope {
  const enabled: AdverseCategory[] = [];
  const excluded: AdverseCategory[] = [];
  for (const config of input.taxonomy.categories) {
    (config.enabledCountries.includes(input.country) ? enabled : excluded).push(config.category);
  }

  const declared = new Set(input.taxonomy.languages.map((profile) => profile.language));
  const languages = input.requestedLanguages.filter((language) => declared.has(language));
  const undeclared = input.requestedLanguages.filter((language) => !declared.has(language));

  const measured = new Set(
    input.taxonomy.languages
      .filter((profile) => profile.measuredRecall !== null)
      .map((profile) => profile.language),
  );
  const unmeasured = languages.filter((language) => !measured.has(language));

  const enabledSet = new Set<string>(enabled);
  const languageSet = new Set(languages);
  // The load-bearing filter. A term whose category is not enabled here never reaches a query,
  // and that is true of this function by construction rather than by a caller remembering.
  const terms = input.taxonomy.lexicon.filter(
    (term) =>
      languageSet.has(term.language) &&
      (term.category === null || enabledSet.has(term.category)) &&
      // An authority name is not a search term for a person: `"Ana Solís" Fiscalía` finds every
      // article that mentions the prosecutor, which is most of them.
      term.kind !== 'AUTHORITY_NAME',
  );

  const categoriesWithTerms = new Set(
    terms
      .map((term) => term.category)
      .filter((category): category is AdverseCategory => category !== null),
  );

  const unreviewed = [
    ...new Set(
      terms
        .filter((term) => term.reviewState !== 'REVIEWED_BY_SPEAKER')
        .map((term) => term.language),
    ),
  ];

  return {
    country: input.country,
    categories: enabled,
    excludedCategories: excluded,
    languages,
    undeclaredLanguages: undeclared,
    unmeasuredLanguages: unmeasured,
    terms,
    categoriesWithoutTerms: enabled.filter((category) => !categoriesWithTerms.has(category)),
    unreviewedTermLanguages: unreviewed,
  };
}
