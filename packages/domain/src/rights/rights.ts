/**
 * SEC-05 — the per-source, per-field content-rights and personal-data decision.
 *
 * This is an **enforcement function, not metadata**. SEC-05 requires a permissions engine over
 * collection, processing, storage, model disclosure, display, export, retention and permitted
 * regions, defaulting to deny for unknown operations. A registry field saying "licence: ok" is
 * not that engine; this is, and the activation path cannot reach `ACTIVE` without a passing
 * verdict from it (`lifecycle/versioned-lifecycle.ts`, `COMPLETE_ACTIVATION`).
 *
 * It lives in the domain package because the same decision is made in at least five places —
 * the fetcher before collecting, the staging service before storing, the extractor before
 * disclosing text to a model, the exporter, and the indexer — and a second copy is how the
 * export path ends up permitting what the display path forbids.
 *
 * **Three rules that are easy to get wrong, written down where they are enforced:**
 *
 * 1. **Default deny.** An operation, classification, region or intended use that the policy
 *    does not name is refused. "Publicly accessible" is not approval for every use.
 * 2. **A DENY is never upgraded by an approval.** Attaching an approval reference to a
 *    prohibited collection method does not make it permitted — see `NON_APPROVABLE_METHODS`.
 *    Approval resolves `REQUIRES_APPROVAL`; it does not overrule a prohibition.
 * 3. **A restriction is machine-actionable, not advice.** `AGGREGATE_ONLY` and
 *    `NO_RAW_RECORD_RETENTION` are returned to be enforced by the caller, and the caller is
 *    expected to fail closed if it cannot honour one it does not recognise.
 *
 * Nothing here is jurisdiction-specific. Every jurisdiction difference arrives as a
 * `RightsPolicy` — versioned configuration carried by the policy or source version — so that
 * adding a country is a data change, and a country-specific `if` in this file would be a bug.
 */

import type { CountryCode } from '../taxonomy/types.js';

/**
 * The operations SEC-05 names. `RETAIN` is separate from `STORE` on purpose: permission to
 * store a document for the duration of a screening run is not permission to keep it.
 */
export const RIGHTS_OPERATIONS = [
  'COLLECT',
  'PROCESS',
  'STORE',
  'MODEL_DISCLOSURE',
  'DISPLAY',
  'EXPORT',
  'RETAIN',
] as const;

export type RightsOperation = (typeof RIGHTS_OPERATIONS)[number];

/**
 * What kind of data is being handled.
 *
 * `BULK_PERSONAL_DATA` is its own class rather than a flavour of `PERSONAL_DATA` because the
 * question it raises is different: a national roll or register dump is lawful to derive a
 * statistic from and not lawful to keep as records. `SPECIAL_CATEGORY` exists so the FR-03
 * exclusion list is enforced as a data-protection control and not only a relevance one.
 */
export const DATA_CLASSIFICATIONS = [
  'PUBLIC_RECORD',
  'PUBLISHED_CONTENT',
  'PERSONAL_DATA',
  'BULK_PERSONAL_DATA',
  'OFFENCE_DATA',
  'SPECIAL_CATEGORY',
] as const;

export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

/**
 * How the data would be obtained.
 *
 * `CREDENTIALED_API` and `LOGIN_GATED` are deliberately different things. The first is an
 * access credential issued to this service by the publisher, which is ordinary and permitted.
 * The second is a human account wall standing between the public and the content, and going
 * through it is circumventing an access control.
 */
export const COLLECTION_METHODS = [
  'PUBLISHED_API',
  'CREDENTIALED_API',
  'BULK_DOWNLOAD',
  'PUBLISHED_FEED',
  'HTML_FETCH',
  'MANUAL_UPLOAD',
  'CAPTCHA_GATED',
  'LOGIN_GATED',
  'PAYWALLED',
] as const;

export type CollectionMethod = (typeof COLLECTION_METHODS)[number];

/**
 * Access controls this service does not go through, by any path, with any approval.
 *
 * The FR-06 table says cool down and abandon. That is a product rule, so it is enforced at the
 * rights gate rather than left to each fetcher to remember — and it is listed as non-approvable
 * so that an administrator with `source:approve` cannot license it by attaching a reference.
 */
export const NON_APPROVABLE_METHODS: readonly CollectionMethod[] = [
  'CAPTCHA_GATED',
  'LOGIN_GATED',
  'PAYWALLED',
];

export const INTENDED_USES = [
  'ADVERSE_SCREENING',
  'IDENTITY_CORROBORATION',
  'AGGREGATE_STATISTICS',
  'MODEL_EVALUATION',
] as const;

export type IntendedUse = (typeof INTENDED_USES)[number];

/** The approval evidence SEC-05 requires to be recorded, not merely asserted. */
export interface ApprovalEvidence {
  /** The reference a human can follow to the actual approval record. */
  readonly approvalRef: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  /** Null means it does not expire. A licence/terms version usually does. */
  readonly expiresAt: string | null;
  /** Exactly what was approved. An approval for one operation does not cover another. */
  readonly coversOperations: readonly RightsOperation[];
  readonly coversJurisdictions: readonly CountryCode[];
}

/**
 * The versioned, per-source, per-jurisdiction rules. Configuration, never code.
 *
 * Everything absent is denied, so an empty policy is the safest possible policy rather than an
 * accidentally permissive one.
 */
export interface RightsPolicy {
  readonly policyId: string;
  readonly jurisdiction: CountryCode;
  readonly permittedOperations: readonly RightsOperation[];
  readonly permittedClassifications: readonly DataClassification[];
  readonly permittedIntendedUses: readonly IntendedUse[];
  readonly permittedCollectionMethods: readonly CollectionMethod[];
  /** Processing regions permitted for this source's data. Empty means none. */
  readonly permittedRegions: readonly string[];
  /** Null means no retention is permitted at all; a number is the ceiling in days. */
  readonly maxRetentionDays: number | null;
  /** Whether raw personal records may be kept, as opposed to derived aggregates. */
  readonly rawPersonalDataRetentionPermitted: boolean;
  /** Operations that need a recorded approval even when otherwise permitted. */
  readonly approvalRequiredFor: readonly RightsOperation[];
}

export interface RightsRequest {
  readonly jurisdiction: CountryCode;
  readonly sourceId: string;
  readonly intendedUse: IntendedUse;
  readonly operation: RightsOperation;
  readonly classification: DataClassification;
  readonly collectionMethod: CollectionMethod;
  /** Requested retention in days; null means "no retention beyond the run". */
  readonly requestedRetentionDays: number | null;
  /** Whether the caller intends to keep raw personal records, not just derived aggregates. */
  readonly retainsRawPersonalData: boolean;
  readonly processingRegion: string;
  readonly approval: ApprovalEvidence | null;
}

export type RightsVerdict = 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL';

export const RIGHTS_REASON_CODES = [
  'PERMITTED_BY_POLICY',
  'COLLECTION_METHOD_PROHIBITED',
  'COLLECTION_METHOD_NOT_PERMITTED',
  'OPERATION_NOT_PERMITTED',
  'CLASSIFICATION_NOT_PERMITTED',
  'SPECIAL_CATEGORY_PROHIBITED',
  'INTENDED_USE_NOT_PERMITTED',
  'REGION_NOT_PERMITTED',
  'RAW_PERSONAL_DATA_RETENTION_PROHIBITED',
  'RETENTION_EXCEEDS_MAXIMUM',
  'RETENTION_NOT_PERMITTED',
  'APPROVAL_REQUIRED',
  'APPROVAL_EXPIRED',
  'APPROVAL_SCOPE_MISMATCH',
] as const;

export type RightsReasonCode = (typeof RIGHTS_REASON_CODES)[number];

export interface RightsReason {
  readonly code: RightsReasonCode;
  readonly detail: string;
}

export const RIGHTS_RESTRICTION_CODES = [
  /** Only derived aggregates may be kept. The underlying records must be discarded. */
  'AGGREGATE_ONLY',
  /** No raw personal record may be persisted, in any store, including the search index. */
  'NO_RAW_RECORD_RETENTION',
  /** Retention is capped below what was requested. `days` carries the cap. */
  'MAX_RETENTION_DAYS',
  /** A legal hold is in force and overrides expiry until lifted (D-012). */
  'LEGAL_HOLD_OVERRIDES_EXPIRY',
] as const;

export type RightsRestrictionCode = (typeof RIGHTS_RESTRICTION_CODES)[number];

export interface RightsRestriction {
  readonly code: RightsRestrictionCode;
  readonly detail: string;
  /** Present only on `MAX_RETENTION_DAYS`. */
  readonly days?: number;
}

export interface RightsDecision {
  readonly verdict: RightsVerdict;
  readonly reasons: readonly RightsReason[];
  readonly restrictions: readonly RightsRestriction[];
}

function reason(code: RightsReasonCode, detail: string): RightsReason {
  return { code, detail };
}

/**
 * Decide whether one operation on one source's data, in one jurisdiction, is permitted.
 *
 * Evaluation order is fixed and matters. Prohibitions are checked before approval, so that a
 * prohibited request is reported as prohibited rather than as "needs approval" — which would
 * send an administrator off to obtain an approval that can never make it lawful.
 *
 * Every denial reason found is returned, not just the first. An administrator fixing a source
 * configuration one refusal at a time, redeploying between each, is how a half-configured
 * source ends up activated at 5pm on a Friday.
 */
export function decideRights(
  request: RightsRequest,
  policy: RightsPolicy,
  asOf: Date,
): RightsDecision {
  const denials: RightsReason[] = [];
  const restrictions: RightsRestriction[] = [];

  // 1. Prohibited access methods. Non-approvable, and checked first so the message is honest.
  if (NON_APPROVABLE_METHODS.includes(request.collectionMethod)) {
    denials.push(
      reason(
        'COLLECTION_METHOD_PROHIBITED',
        `${request.collectionMethod} is an access control. This service does not go through ` +
          `one by any path, and no approval can license it.`,
      ),
    );
  } else if (!policy.permittedCollectionMethods.includes(request.collectionMethod)) {
    denials.push(
      reason(
        'COLLECTION_METHOD_NOT_PERMITTED',
        `Policy ${policy.policyId} does not permit collection by ${request.collectionMethod}.`,
      ),
    );
  }

  // 2. The operation itself. Unknown operations are denied by construction: membership of an
  //    explicit permit list, never absence from a deny list.
  if (!policy.permittedOperations.includes(request.operation)) {
    denials.push(
      reason(
        'OPERATION_NOT_PERMITTED',
        `Policy ${policy.policyId} does not permit ${request.operation} for this source.`,
      ),
    );
  }

  // 3. Classification. Special category is refused for anything that stores or discloses it,
  //    regardless of policy — FR-03's exclusion list as a data-protection control (SEC-05).
  if (request.classification === 'SPECIAL_CATEGORY') {
    denials.push(
      reason(
        'SPECIAL_CATEGORY_PROHIBITED',
        'Protected characteristics are never stored as finding attributes or used as query ' +
          'terms. This is not configurable per source.',
      ),
    );
  } else if (!policy.permittedClassifications.includes(request.classification)) {
    denials.push(
      reason(
        'CLASSIFICATION_NOT_PERMITTED',
        `Policy ${policy.policyId} does not cover ${request.classification} data.`,
      ),
    );
  }

  // 4. Intended use and processing region.
  if (!policy.permittedIntendedUses.includes(request.intendedUse)) {
    denials.push(
      reason(
        'INTENDED_USE_NOT_PERMITTED',
        `Policy ${policy.policyId} does not permit use for ${request.intendedUse}.`,
      ),
    );
  }
  if (!policy.permittedRegions.includes(request.processingRegion)) {
    denials.push(
      reason(
        'REGION_NOT_PERMITTED',
        `Processing in ${request.processingRegion} is not permitted for this source. ` +
          `Permitted: ${policy.permittedRegions.join(', ') || 'none'}.`,
      ),
    );
  }

  // 5. Raw personal data, and retention.
  //
  //    A bulk personal dataset that may not be retained raw is not simply refused: deriving an
  //    aggregate from it is the legitimate use, and the restriction says so in a form the
  //    caller must honour. Asking to retain it raw is refused outright.
  if (request.retainsRawPersonalData && !policy.rawPersonalDataRetentionPermitted) {
    denials.push(
      reason(
        'RAW_PERSONAL_DATA_RETENTION_PROHIBITED',
        'This source does not permit retaining raw personal records. Derive the aggregate and ' +
          'discard the records.',
      ),
    );
  }
  if (!policy.rawPersonalDataRetentionPermitted) {
    restrictions.push({
      code: 'NO_RAW_RECORD_RETENTION',
      detail:
        'No raw personal record from this source may be persisted in any store, including the ' +
        'search index and any export.',
    });
    if (request.classification === 'BULK_PERSONAL_DATA') {
      restrictions.push({
        code: 'AGGREGATE_ONLY',
        detail:
          'Only derived aggregates may be kept. The underlying records must be discarded once ' +
          'the aggregate is computed.',
      });
    }
  }

  if (request.requestedRetentionDays !== null) {
    if (policy.maxRetentionDays === null) {
      denials.push(
        reason(
          'RETENTION_NOT_PERMITTED',
          'This source permits no retention beyond the run that collected the data.',
        ),
      );
    } else if (request.requestedRetentionDays > policy.maxRetentionDays) {
      denials.push(
        reason(
          'RETENTION_EXCEEDS_MAXIMUM',
          `Requested ${String(request.requestedRetentionDays)} days; the maximum permitted is ` +
            `${String(policy.maxRetentionDays)}.`,
        ),
      );
    }
  }
  if (policy.maxRetentionDays !== null) {
    restrictions.push({
      code: 'MAX_RETENTION_DAYS',
      detail:
        `Evidence from this source expires after ${String(policy.maxRetentionDays)} days ` +
        `unless a legal hold is in force.`,
      days: policy.maxRetentionDays,
    });
  }

  if (denials.length > 0) {
    return { verdict: 'DENY', reasons: denials, restrictions };
  }

  // 6. Approval. Reached only once nothing is prohibited, so an approval is never sought for
  //    something an approval cannot fix.
  if (policy.approvalRequiredFor.includes(request.operation)) {
    const approval = request.approval;
    if (approval === null) {
      return {
        verdict: 'REQUIRES_APPROVAL',
        reasons: [
          reason(
            'APPROVAL_REQUIRED',
            `${request.operation} on this source requires a recorded approval. None was supplied.`,
          ),
        ],
        restrictions,
      };
    }

    const expired = approval.expiresAt !== null && Date.parse(approval.expiresAt) <= asOf.getTime();
    if (expired) {
      return {
        verdict: 'REQUIRES_APPROVAL',
        reasons: [
          reason(
            'APPROVAL_EXPIRED',
            `Approval ${approval.approvalRef} expired on ${approval.expiresAt}. ` +
              'An expired approval is treated exactly like none.',
          ),
        ],
        restrictions,
      };
    }

    const coversOperation = approval.coversOperations.includes(request.operation);
    const coversJurisdiction = approval.coversJurisdictions.includes(request.jurisdiction);
    if (!coversOperation || !coversJurisdiction) {
      return {
        verdict: 'REQUIRES_APPROVAL',
        reasons: [
          reason(
            'APPROVAL_SCOPE_MISMATCH',
            `Approval ${approval.approvalRef} covers ` +
              `[${approval.coversOperations.join(', ')}] in ` +
              `[${approval.coversJurisdictions.join(', ')}]; this request is ` +
              `${request.operation} in ${request.jurisdiction}.`,
          ),
        ],
        restrictions,
      };
    }
  }

  return {
    verdict: 'ALLOW',
    reasons: [
      reason(
        'PERMITTED_BY_POLICY',
        `${request.operation} permitted for ${request.sourceId} in ${request.jurisdiction} ` +
          `under policy ${policy.policyId}.`,
      ),
    ],
    restrictions,
  };
}

/**
 * The rights clearance a version must carry to reach `ACTIVE`.
 *
 * An activation is not one operation but every operation the source will perform once live, so
 * the gate evaluates them together and reports the whole picture. One `REQUIRES_APPROVAL` among
 * otherwise permitted operations blocks activation just as a `DENY` does — the difference is
 * what the administrator has to do about it, which is why the verdict is preserved rather than
 * flattened to a boolean.
 */
export interface RightsClearance {
  readonly verdict: RightsVerdict;
  readonly evaluatedAt: string;
  readonly policyId: string;
  readonly perOperation: readonly {
    readonly operation: RightsOperation;
    readonly decision: RightsDecision;
  }[];
  readonly restrictions: readonly RightsRestriction[];
}

export function clearForActivation(input: {
  readonly request: Omit<RightsRequest, 'operation'>;
  readonly operations: readonly RightsOperation[];
  readonly policy: RightsPolicy;
  readonly asOf: Date;
}): RightsClearance {
  const perOperation = input.operations.map((operation) => ({
    operation,
    decision: decideRights({ ...input.request, operation }, input.policy, input.asOf),
  }));

  const anyDenied = perOperation.some((r) => r.decision.verdict === 'DENY');
  const anyNeedsApproval = perOperation.some((r) => r.decision.verdict === 'REQUIRES_APPROVAL');

  // Deny wins over requires-approval: a set of operations containing a prohibited one is
  // prohibited, and reporting it as "needs approval" would be misleading about the remedy.
  const verdict: RightsVerdict = anyDenied
    ? 'DENY'
    : anyNeedsApproval
      ? 'REQUIRES_APPROVAL'
      : 'ALLOW';

  // Restrictions accumulate across operations and are de-duplicated by code, because a caller
  // honouring them cares that a restriction applies at all, not how many operations raised it.
  const seen = new Set<RightsRestrictionCode>();
  const restrictions: RightsRestriction[] = [];
  for (const { decision } of perOperation) {
    for (const restriction of decision.restrictions) {
      if (!seen.has(restriction.code)) {
        seen.add(restriction.code);
        restrictions.push(restriction);
      }
    }
  }

  return {
    verdict,
    evaluatedAt: input.asOf.toISOString(),
    policyId: input.policy.policyId,
    perOperation,
    restrictions,
  };
}

/** Only a clearance that allowed everything may activate a version. */
export function clearancePermitsActivation(clearance: RightsClearance): boolean {
  return clearance.verdict === 'ALLOW';
}
