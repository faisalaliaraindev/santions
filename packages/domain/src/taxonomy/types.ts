/** FR-03 — versioned taxonomy records. */

import type { AdverseCategory } from './categories.js';

/** How a lexicon term is used, per FR-03. Only `CONDUCT` terms narrow F3. */
export type TermKind = 'CONDUCT' | 'PROCEDURAL' | 'AUTHORITY_NAME';

/** BCP-47 language tag, e.g. `en`, `ar`, `ur`, `id`. */
export type LanguageTag = string;

/** ISO 3166-1 alpha-2 country code. "EU"/"MENA"/"SEA" are never valid here (FR-05). */
export type CountryCode = string;

export interface LexiconTerm {
  readonly term: string;
  readonly language: LanguageTag;
  readonly kind: TermKind;
  /** Only meaningful for `CONDUCT` terms; null for procedural terms and authority names. */
  readonly category: AdverseCategory | null;
  /**
   * Planner ordering within (category, language). Lower ranks are kept first when F3 is
   * bounded to top-N terms (FR-04).
   */
  readonly rank: number;
}

export interface CategoryConfig {
  readonly category: AdverseCategory;
  /** Relative severity, 1 (lowest) to 5 (highest). Displayed; never folded into a score (I9). */
  readonly severityWeight: 1 | 2 | 3 | 4 | 5;
  /** Countries in which this category is enabled. Empty means enabled nowhere. */
  readonly enabledCountries: readonly CountryCode[];
}

/**
 * A language is "enabled" only if it carries a measured recall figure from the evaluation
 * set (FR-03, FR-16, T80). An unmeasured language is disabled and the coverage statement
 * must say so.
 */
export interface LanguageProfile {
  readonly language: LanguageTag;
  /** End-to-end recall measured on the held-out split, or null if never measured. */
  readonly measuredRecall: number | null;
  /** The evaluation run that produced `measuredRecall`. Null when unmeasured. */
  readonly measuredByEvaluationRunId: string | null;
}

export interface TaxonomyVersion {
  readonly taxonomyVersionId: string;
  /** Monotonic within a tenant. Pinned onto every search (FR-03). */
  readonly version: number;
  readonly tenantId: string;
  readonly categories: readonly CategoryConfig[];
  readonly lexicon: readonly LexiconTerm[];
  readonly languages: readonly LanguageProfile[];
  readonly status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'SUSPENDED';
  readonly proposedBy: string;
  /** Four-eyes: must differ from `proposedBy` before status can become ACTIVE (T45). */
  readonly approvedBy: string | null;
  readonly activatedAt: string | null;
}

/** A language is enabled only when it has a measured recall figure. */
export function isLanguageEnabled(profile: LanguageProfile): boolean {
  return profile.measuredRecall !== null;
}

/** Categories enabled for a country. A disabled category is never queried (G5 exit). */
export function enabledCategories(
  taxonomy: TaxonomyVersion,
  country: CountryCode,
): readonly AdverseCategory[] {
  return taxonomy.categories
    .filter((c) => c.enabledCountries.includes(country))
    .map((c) => c.category);
}

export function enabledLanguages(taxonomy: TaxonomyVersion): readonly LanguageTag[] {
  return taxonomy.languages.filter(isLanguageEnabled).map((l) => l.language);
}

/** Languages that were requested but carry no measured recall figure (T80 coverage note). */
export function unmeasuredLanguages(
  taxonomy: TaxonomyVersion,
  requested: readonly LanguageTag[],
): readonly LanguageTag[] {
  const measured = new Set(enabledLanguages(taxonomy));
  return requested.filter((l) => !measured.has(l));
}

export function severityWeightOf(
  taxonomy: TaxonomyVersion,
  category: AdverseCategory,
): 1 | 2 | 3 | 4 | 5 | null {
  return taxonomy.categories.find((c) => c.category === category)?.severityWeight ?? null;
}
