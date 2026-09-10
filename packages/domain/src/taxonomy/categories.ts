/**
 * FR-03 — adverse taxonomy.
 *
 * The taxonomy is versioned *configuration data*, not code. The constants here are the
 * seed content for taxonomy version 1: the identifiers are a closed enum (so a category
 * cannot be invented by an extraction model or by runtime configuration), but severity
 * weights and per-tenant/per-jurisdiction enablement live in `TaxonomyVersion` records.
 */

/** The seventeen in-scope adverse categories required by FR-03. */
export const ADVERSE_CATEGORIES = [
  'FRAUD_FINANCIAL_CRIME',
  'MONEY_LAUNDERING_TF',
  'BRIBERY_CORRUPTION',
  'MARKET_ABUSE',
  'SANCTIONS_EVASION_EXPORT_CONTROL',
  'TAX_OFFENCES',
  'ORGANISED_CRIME',
  'DRUG_OFFENCES',
  'HUMAN_TRAFFICKING_MODERN_SLAVERY',
  'TERRORISM_VIOLENT_EXTREMISM',
  'VIOLENT_CRIME',
  'CYBERCRIME',
  'REGULATORY_PROFESSIONAL_MISCONDUCT',
  'ENVIRONMENTAL_HEALTH_SAFETY',
  'CONSUMER_HARM_MISSELLING',
  'INSOLVENCY_MISCONDUCT',
  'GOVERNANCE_INTEGRITY',
] as const;

export type AdverseCategory = (typeof ADVERSE_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(ADVERSE_CATEGORIES);

export function isAdverseCategory(value: string): value is AdverseCategory {
  return CATEGORY_SET.has(value);
}

/**
 * FR-03 exclusion list. Enforced at *classification* time, not at display time.
 *
 * These are recorded as the reason a candidate was rejected so that the exclusion is
 * auditable, but they never become findings and never become query terms.
 */
export const EXCLUSION_REASONS = [
  'POLITICAL_OPINION_OR_LAWFUL_ACTIVISM',
  'PROTECTED_CHARACTERISTIC',
  'PRIVATE_LIFE_NO_MISCONDUCT',
  'ORDINARY_CIVIL_LITIGATION_NO_MISCONDUCT',
  'VICTIM_OR_WITNESS_STATUS',
  'SPENT_EXPUNGED_OR_TIME_BARRED',
  'NAMESAKE_CONCLUSIVELY_DISTINGUISHED',
  'SATIRE_FICTION_OR_OPINION',
] as const;

export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/**
 * Protected-characteristic term stems, in the languages currently authored. Used by the
 * build-gating lexicon audit (FR-03, T79): no query term may map to any of these.
 *
 * This is a deliberately blunt stem list. A false positive here costs a lexicon author one
 * rename; a false negative puts a protected characteristic into an outbound search query.
 */
export const PROTECTED_CHARACTERISTIC_STEMS: readonly string[] = [
  // religion
  'muslim',
  'islam',
  'jewish',
  'jew',
  'christian',
  'catholic',
  'protestant',
  'hindu',
  'sikh',
  'buddhist',
  'atheist',
  'religio',
  'infidel',
  // ethnicity / race / national origin as a characteristic
  'ethnic',
  'race',
  'racial',
  'roma',
  'gypsy',
  'arab',
  'african',
  'asian',
  'caucasian',
  'immigrant',
  'migrant',
  'refugee',
  'asylum seeker',
  // sexual orientation and gender identity
  'gay',
  'lesbian',
  'homosexual',
  'bisexual',
  'transgender',
  'transsexual',
  'queer',
  'lgbt',
  'sexual orientation',
  'gender identity',
  // disability and health
  'disabled',
  'disability',
  'handicap',
  'mental illness',
  'mentally ill',
  'psychiatric',
  'hiv',
  'aids',
  'addict',
  'alcoholic',
  // political opinion and lawful activism
  'communist',
  'socialist',
  'fascist',
  'leftist',
  'right-wing',
  'left-wing',
  'activist',
  'protester',
  'protestor',
  'dissident',
  'opposition party',
  'political opinion',
  'trade union',
  'union member',
];
