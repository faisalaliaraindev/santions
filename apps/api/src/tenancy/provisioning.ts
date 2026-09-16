/**
 * What a tenant is made of, in one place (phase I step I1).
 *
 * A tenant is not one record. It is four, and a tenant missing any of them is broken in a way
 * that surfaces far from the cause:
 *
 * | Record                      | Missing it looks like                                     |
 * | :-------------------------- | :-------------------------------------------------------- |
 * | `tenants`                   | A credential that authenticates for a tenant nobody has   |
 * | `tenantEntitlementVersions` | `ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN` on the first search  |
 * | `taxonomyVersions`          | `INVALID_POLICY` — "no active taxonomy version"           |
 * | `policyVersions`            | `INVALID_POLICY` — "no active policy version"             |
 *
 * None of those reads as "your signup did not finish". They read as a bug in search, which is
 * why `SignupService` writes all four in a single transaction and why the content of all four
 * is built here, by one pure function, rather than assembled at each call site.
 *
 * **This module performs no I/O and reads no clock.** The caller passes `now`. That is what lets
 * the shape of a provisioned tenant be asserted in a unit test with nothing running, and it is
 * why `scripts/bootstrap/seed-data.mjs` can import the same builder from `dist` rather than
 * keeping a second copy of these defaults. A second copy is a second thing to keep in step, and
 * the copy that drifts is the one the customer gets.
 */

import { ADVERSE_CATEGORIES, SEED_LEXICON } from '@erly/adverse-domain';

import {
  ADVERSE_MEDIA,
  type EntitlementVersionRecord,
  type TenantRecord,
} from './entitlements.service.js';

/** The first version of every versioned record a tenant owns. */
export const INITIAL_VERSION = 1;

/**
 * Severity weight every category starts at.
 *
 * Uniform on purpose: a weight that differs per category at provisioning time would be a
 * judgement nobody made. Tuning is a taxonomy admin's act, through the D1 approval lifecycle,
 * against findings they have actually seen.
 */
export const DEFAULT_SEVERITY_WEIGHT = 3;

/**
 * Countries the default taxonomy enables categories for.
 *
 * Not "everywhere". A taxonomy enables categories *per country*, and a source whose countries
 * the pinned taxonomy enables nothing for is refused with `JURISDICTION_NOT_ENABLED`. Enabling
 * every country would therefore not widen coverage — it would promise reach that no configured
 * source has, and turn "we have no source there" into a result that reads like a clean search.
 *
 * `CR` is where the fixture sources operate; `US` is where the only source ever approved for
 * live use (the SEC litigation releases, D17) publishes. Widening this list is a taxonomy
 * admin's act through the approval lifecycle, not a deployment — D-044.
 */
export const DEFAULT_ENABLED_COUNTRIES: readonly string[] = ['CR', 'US'];

/**
 * Languages the taxonomy *requests*. Not the same as languages that are enabled.
 *
 * FR-03: a language is enabled only once it carries a measured recall figure from the evaluation
 * set. Neither has one, so both are provisioned with `measuredRecall: null` and every coverage
 * statement must declare them unmeasured. Provisioning a tenant cannot be the moment a language
 * quietly becomes supported.
 */
export const DEFAULT_REQUESTED_LANGUAGES: readonly string[] = ['es', 'en'];

/** Evidence retention, in days (D-012). Revisable per policy version, not compiled in. */
export const DEFAULT_EVIDENCE_RETENTION_DAYS = 30;

/** FR-04 bound on how many queries one run may plan. */
export const DEFAULT_QUERY_PLAN_CAP = 200;

/** FR-02 one-hop traversal bounds (D4). Configuration, so a shell-company screen can raise them. */
export const DEFAULT_ASSOCIATION_BOUNDS = {
  maxOfficerCandidates: 25,
  maxCompaniesPerOfficer: 50,
  maxEdgesPerSnapshot: 500,
} as const;

/** After this long with no recorded outcome, a case is reported as outcome-unknown. */
export const DEFAULT_OUTCOME_UNKNOWN_AFTER_DAYS = 180;

export interface ProvisioningInput {
  readonly tenantId: string;
  readonly name: string;
  /**
   * What the provider grants. Signup passes both (D-053); the bootstrap passes what each
   * seeded tenant is for.
   */
  readonly environments: readonly ('sandbox' | 'live')[];
  /** Who or what provisioned this tenant. Recorded on the taxonomy and policy versions. */
  readonly provisionedBy: string;
  /** FR-02: a former-director search needs an approved historical scope. Off unless asked for. */
  readonly historicalScopeApproved?: boolean;
  /** Why these versions exist, for whoever reads the record later. */
  readonly decisionRef: string;
  readonly now: Date;
}

export interface TaxonomyVersionContent {
  readonly tenantId: string;
  readonly version: number;
  readonly status: 'ACTIVE';
  readonly categories: readonly {
    readonly category: string;
    readonly severityWeight: number;
    readonly enabledCountries: readonly string[];
  }[];
  readonly languages: readonly {
    readonly language: string;
    readonly measuredRecall: null;
    readonly measuredByEvaluationRunId: null;
  }[];
  readonly lexicon: unknown;
  readonly proposedBy: string;
  readonly approvedBy: string;
  readonly decisionRef: string;
  readonly activatedAt: string;
}

export interface PolicyVersionContent {
  readonly tenantId: string;
  readonly version: number;
  readonly status: 'ACTIVE';
  readonly historicalScopeApproved: boolean;
  readonly queryPlanCap: number;
  readonly associationBounds: typeof DEFAULT_ASSOCIATION_BOUNDS;
  readonly outcomeUnknownAfterDays: number;
  readonly evidenceRetentionDays: number;
  readonly archiveHorizon: null;
  readonly assumption: string;
  readonly activatedAt: string;
}

/** The four records, as content. Nothing here is written; the caller decides where and how. */
export interface ProvisionedTenant {
  readonly tenant: TenantRecord;
  readonly entitlement: EntitlementVersionRecord;
  readonly taxonomy: TaxonomyVersionContent;
  readonly policy: PolicyVersionContent;
}

/**
 * Build the four records a usable tenant needs.
 *
 * Pure. Same input, same output, no clock and no database — so the thing a signup promises can
 * be asserted without one running.
 */
export function buildTenantProvisioning(input: ProvisioningInput): ProvisionedTenant {
  const at = input.now.toISOString();

  return {
    tenant: {
      tenantId: input.tenantId,
      name: input.name,
      // The tenant's ordinary working environment. It is not the authority on what they may
      // reach — the entitlement is — and nothing decides access from this field.
      environment: 'sandbox',
    },
    entitlement: {
      tenantId: input.tenantId,
      version: INITIAL_VERSION,
      capabilities: [ADVERSE_MEDIA],
      environments: [...input.environments],
      status: 'ACTIVE',
      activatedAt: at,
    },
    taxonomy: {
      tenantId: input.tenantId,
      version: INITIAL_VERSION,
      status: 'ACTIVE',
      // All seventeen on (D-009). Far easier to notice an irrelevant finding and switch a
      // category off than to discover months later that a whole class of conduct was never
      // searched for. The FR-03 exclusion list still applies at classification time, so
      // "all categories" never means "anything goes".
      categories: ADVERSE_CATEGORIES.map((category) => ({
        category,
        severityWeight: DEFAULT_SEVERITY_WEIGHT,
        enabledCountries: [...DEFAULT_ENABLED_COUNTRIES],
      })),
      languages: DEFAULT_REQUESTED_LANGUAGES.map((language) => ({
        language,
        measuredRecall: null,
        measuredByEvaluationRunId: null,
      })),
      // The D6 term list, from the pure package. Every term is `UNREVIEWED_AUTHORED` and
      // nothing is machine translated (D-033); the coverage statement says so on every run.
      lexicon: SEED_LEXICON,
      proposedBy: input.provisionedBy,
      approvedBy: input.provisionedBy,
      decisionRef: input.decisionRef,
      activatedAt: at,
    },
    policy: {
      tenantId: input.tenantId,
      version: INITIAL_VERSION,
      status: 'ACTIVE',
      historicalScopeApproved: input.historicalScopeApproved ?? false,
      queryPlanCap: DEFAULT_QUERY_PLAN_CAP,
      associationBounds: DEFAULT_ASSOCIATION_BOUNDS,
      outcomeUnknownAfterDays: DEFAULT_OUTCOME_UNKNOWN_AFTER_DAYS,
      evidenceRetentionDays: DEFAULT_EVIDENCE_RETENTION_DAYS,
      archiveHorizon: null,
      assumption:
        'Archive horizon is null because no source has been measured. Open decision D2 closes at G10.',
      activatedAt: at,
    },
  };
}
