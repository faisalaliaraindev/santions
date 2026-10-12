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
 * What an **official listing** says, as distinct from what conduct a document reports.
 *
 * # Why these are not simply three more `ADVERSE_CATEGORIES`
 *
 * The seventeen above are *conduct* categories. They exist to be recognised in running text, so
 * every one of them carries lexicon terms in every enabled language, they are what a query plan
 * is built from, and `activation.ts` refuses a taxonomy version that leaves one of them without
 * terms. None of that is true of a designation. An OFAC listing is not found by searching for the
 * word "designation" — it is found by matching a name against a list we already hold, and the
 * adverse fact is the listing itself. Giving it conduct terms would mean inventing search
 * vocabulary for a category that is never searched by vocabulary.
 *
 * # Why they are not a separate product either
 *
 * They are adverse signals and they are returned as findings, on the same endpoint, with the same
 * band, axes, rationale and provenance as any other. The difference is in what produced them, not
 * in what a caller does with them. Splitting them into a second "sanctions" surface would make an
 * integrator ask two questions where the risk question is one.
 *
 * So: one closed enum on the finding, assembled from both halves, and a caller that wants only
 * designations filters on these three values rather than calling somewhere else.
 */
export const DESIGNATION_CATEGORIES = [
  /** A sanctions listing by a designating authority — OFAC, the UN, the EU, the FCDO. */
  'SANCTIONS_DESIGNATION',
  /** Debarment or exclusion from contracting, such as the World Bank's ineligible-firms list. */
  'DEBARMENT_EXCLUSION',
  /** A regulator's published warning about an unauthorised firm or individual, such as the FCA's. */
  'REGULATORY_WARNING_LIST',
] as const;

export type DesignationCategory = (typeof DESIGNATION_CATEGORIES)[number];

const DESIGNATION_SET: ReadonlySet<string> = new Set(DESIGNATION_CATEGORIES);

export function isDesignationCategory(value: string): value is DesignationCategory {
  return DESIGNATION_SET.has(value);
}

/**
 * Every value a finding's `category` may take — the closed union the API publishes.
 *
 * It is closed for the same reason `ADVERSE_CATEGORIES` is: a category that can be invented at
 * runtime is a category no integrator can switch on, and a free string is what let
 * `SANCTIONS_DESIGNATION` reach the API for weeks without ever appearing in a schema.
 */
export const FINDING_CATEGORIES = [...ADVERSE_CATEGORIES, ...DESIGNATION_CATEGORIES] as const;

export type FindingCategory = AdverseCategory | DesignationCategory;

export function isFindingCategory(value: string): value is FindingCategory {
  return CATEGORY_SET.has(value) || DESIGNATION_SET.has(value);
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
