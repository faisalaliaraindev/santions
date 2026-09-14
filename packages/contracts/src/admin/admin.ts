/**
 * Section 6.1 — `/v1/admin/sources`, `/v1/admin/policies`, `/v1/admin/taxonomy`.
 *
 * Draft, version, approve, activate and suspend, with fine-grained permissions and four-eyes
 * approval. The schemas are strict, and strictness is doing real work here rather than being a
 * style preference: FR-05 requires runtime source administration to select **reviewed connector
 * types and validated domain configuration**, and to permit no arbitrary executable code, SQL
 * or JavaScript snippets, unrestricted fetch URLs or unapproved model endpoints.
 *
 * That requirement is enforced by shape. A connector type is an enum, not a string. A domain is
 * a hostname pattern, not a URL. There is no free-text field anywhere in a source version that
 * something later turns into a request, and adding one would need this file changed — which is
 * a code review, which is the point.
 */

import { z } from 'zod';

export const adminRecordKindSchema = z.enum(['SOURCE', 'TAXONOMY', 'POLICY']);
export type AdminRecordKind = z.infer<typeof adminRecordKindSchema>;

export const lifecycleStateSchema = z.enum([
  'PROPOSED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'ACTIVATING',
  'ACTIVE',
  'SUSPENDED',
  'SUPERSEDED',
  'RETIRED',
]);
export type LifecycleStateWire = z.infer<typeof lifecycleStateSchema>;

/** Actions a client may ask for. Activation has its own route because it runs the SEC-05 gate. */
export const lifecycleActionSchema = z.enum([
  'SUBMIT',
  'APPROVE',
  'REQUEST_CHANGES',
  'SUSPEND',
  'RESTORE',
  'RETIRE',
]);
export type LifecycleActionWire = z.infer<typeof lifecycleActionSchema>;

export const rightsOperationSchema = z.enum([
  'COLLECT',
  'PROCESS',
  'STORE',
  'MODEL_DISCLOSURE',
  'DISPLAY',
  'EXPORT',
  'RETAIN',
]);

export const dataClassificationSchema = z.enum([
  'PUBLIC_RECORD',
  'PUBLISHED_CONTENT',
  'PERSONAL_DATA',
  'BULK_PERSONAL_DATA',
  'OFFENCE_DATA',
  'SPECIAL_CATEGORY',
]);

export const collectionMethodSchema = z.enum([
  'PUBLISHED_API',
  'CREDENTIALED_API',
  'BULK_DOWNLOAD',
  'PUBLISHED_FEED',
  'HTML_FETCH',
  'MANUAL_UPLOAD',
  'CAPTCHA_GATED',
  'LOGIN_GATED',
  'PAYWALLED',
]);

export const intendedUseSchema = z.enum([
  'ADVERSE_SCREENING',
  'IDENTITY_CORROBORATION',
  'AGGREGATE_STATISTICS',
  'MODEL_EVALUATION',
]);

/**
 * The connector types an administrator may select.
 *
 * An enum, not a class name and not a module path. This is the line FR-05 draws between
 * configuring a reviewed connector and shipping code through an admin form.
 */
export const connectorTypeSchema = z.enum([
  'NEWS_DISCOVERY_RSS',
  'WEB_DISCOVERY_SEARX',
  'PRIMARY_SOURCE_HTTP',
  'COMPANY_REGISTRY_HTTP',
  'EVIDENCE_FETCH_HTTP',
  'GAZETTE_PDF',
  'FIXTURE_MOCK',
]);

/** A registrable domain. Not a URL: no scheme, no path, no query, no credentials. */
export const canonicalDomainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(
    /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
    'Must be a bare hostname — no scheme, path, port, query or credentials.',
  );

/**
 * A two-letter ISO country code.
 *
 * FR-05: "EU", "MENA" and "SEA" are not blanket source permissions. The enum of real codes is
 * not enumerated here, but a regional pseudo-code is rejected explicitly so the mistake fails
 * loudly at the API rather than silently widening a source's scope.
 */
const REGIONAL_PSEUDO_CODES = ['EU', 'EEA', 'UK', 'MENA', 'SEA', 'LATAM', 'APAC', 'GLOBAL'];

export const countryCodeSchema = z
  .string()
  .length(2)
  .regex(/^[A-Za-z]{2}$/, 'Must be an ISO 3166-1 alpha-2 country code.')
  .transform((value) => value.toUpperCase())
  .refine((value) => !REGIONAL_PSEUDO_CODES.includes(value), {
    message: 'Regional groupings are not source permissions. Name each country explicitly (FR-05).',
  });

export const rightsPolicySchema = z
  .object({
    policyId: z.string().min(1).max(120),
    jurisdiction: countryCodeSchema,
    permittedOperations: z.array(rightsOperationSchema).max(7),
    permittedClassifications: z.array(dataClassificationSchema).max(6),
    permittedIntendedUses: z.array(intendedUseSchema).max(4),
    permittedCollectionMethods: z.array(collectionMethodSchema).max(9),
    permittedRegions: z.array(z.string().min(2).max(40)).max(20),
    /** Null means no retention is permitted at all — not "unlimited". */
    maxRetentionDays: z.number().int().min(0).max(3650).nullable(),
    rawPersonalDataRetentionPermitted: z.boolean(),
    approvalRequiredFor: z.array(rightsOperationSchema).max(7),
  })
  .strict();

export const approvalEvidenceSchema = z
  .object({
    approvalRef: z.string().min(1).max(200),
    approvedBy: z.string().min(1).max(200),
    approvedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    coversOperations: z.array(rightsOperationSchema).min(1).max(7),
    coversJurisdictions: z.array(countryCodeSchema).min(1).max(50),
  })
  .strict();

export const dataProfileSchema = z
  .object({
    jurisdiction: countryCodeSchema,
    classification: dataClassificationSchema,
    collectionMethod: collectionMethodSchema,
    intendedUse: intendedUseSchema,
    /** Everything this source will do once live. The gate clears all of it, or none of it. */
    operations: z.array(rightsOperationSchema).min(1).max(7),
    requestedRetentionDays: z.number().int().min(0).max(3650).nullable(),
    retainsRawPersonalData: z.boolean(),
    processingRegion: z.string().min(2).max(40),
    approval: approvalEvidenceSchema.nullable(),
  })
  .strict();

/**
 * A source version's content — the FR-05 registry fields.
 *
 * Note what is absent and must stay absent: any field that becomes an executable instruction.
 * No selector, no script, no template, no base URL. A connector type plus validated domain
 * configuration is the whole surface an administrator gets.
 */
export const sourceContentSchema = z
  .object({
    sourceName: z.string().min(1).max(200),
    publisher: z.string().min(1).max(200),
    connectorType: connectorTypeSchema,
    canonicalDomains: z.array(canonicalDomainSchema).min(1).max(20),
    /** 1 is the highest authority for the reported act — never confidence in identity. */
    authorityTier: z.number().int().min(1).max(5),
    cascadeRung: z.number().int().min(0).max(7),
    countries: z.array(countryCodeSchema).min(1).max(50),
    languages: z.array(z.string().min(2).max(35)).min(1).max(30),
    /** A reference to a credential held elsewhere. Never the credential (SEC-04). */
    credentialsRef: z.string().max(200).nullable(),
    freeTierHourlyBudget: z.number().int().min(0).max(1_000_000).nullable(),
    freeTierDailyBudget: z.number().int().min(0).max(10_000_000).nullable(),
    stabilityClass: z.enum(['DOCUMENTED_STABLE', 'UNDOCUMENTED_VOLATILE']),
    parserVersion: z.string().min(1).max(40),
    licenceTermsVersion: z.string().min(1).max(120),
    /**
     * When the recorded licence terms expire, if they do (Phase D step D5, T36).
     *
     * Optional because most free sources publish terms with no end date, and requiring an
     * invented one would put a date into the registry that nobody agreed. Where it *is* set,
     * `SourceHealth` refuses the source past this instant on exactly the path an engaged kill
     * switch takes — T36 names licence expiry as equivalent, and it is not a special case.
     */
    licenceExpiresAt: z.string().datetime().nullable().optional(),
    /** Robots position, recorded per source. Exceptions are open decision D6. */
    robotsPosition: z.enum(['HONOURED', 'EXCEPTION_APPROVED', 'NOT_ESTABLISHED']),
    /** How the source publishes: CR's gazette is PDF, most news is HTML. Drives extraction. */
    contentFormat: z.enum(['HTML', 'PDF', 'JSON', 'XML_FEED', 'MIXED']),
  })
  .strict();

/**
 * Note what is **not** in this schema: `mode`.
 *
 * It was here in D1 and has been removed in D2, because a caller-supplied `mode` is a way to
 * declare a fixture source LIVE inside a mock stack — the exact thing T55 forbids. The
 * operating mode is stamped on the envelope by `VersionedRecordService` from the process
 * configuration, so it describes the stack that produced the record rather than the intent of
 * whoever proposed it. `.strict()` means a request that still sends `mode` is rejected rather
 * than ignored, which is the difference between a caller learning their field did nothing and
 * a caller believing it did something.
 */

export const proposeVersionSchema = z
  .object({
    recordId: z.string().min(1).max(120),
    content: z.record(z.unknown()),
    rightsPolicy: rightsPolicySchema.optional(),
    dataProfile: dataProfileSchema.optional(),
  })
  .strict();
export type ProposeVersionInput = z.infer<typeof proposeVersionSchema>;

export const updateDraftSchema = z
  .object({
    content: z.record(z.unknown()).optional(),
    rightsPolicy: rightsPolicySchema.optional(),
    dataProfile: dataProfileSchema.optional(),
  })
  .strict();
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;

export const lifecycleTransitionSchema = z
  .object({
    action: lifecycleActionSchema,
    /** Required for approve, request-changes, suspend, restore and retire (SEC-06). */
    reason: z.string().min(1).max(2000).optional(),
  })
  .strict();
export type LifecycleTransitionInput = z.infer<typeof lifecycleTransitionSchema>;

export const rightsDecisionSchema = z
  .object({
    verdict: z.enum(['ALLOW', 'DENY', 'REQUIRES_APPROVAL']),
    reasons: z.array(z.object({ code: z.string(), detail: z.string() }).strict()),
    restrictions: z.array(
      z
        .object({ code: z.string(), detail: z.string(), days: z.number().int().optional() })
        .strict(),
    ),
  })
  .strict();

export const rightsClearanceSchema = z
  .object({
    verdict: z.enum(['ALLOW', 'DENY', 'REQUIRES_APPROVAL']),
    evaluatedAt: z.string(),
    policyId: z.string(),
    perOperation: z.array(
      z.object({ operation: rightsOperationSchema, decision: rightsDecisionSchema }).strict(),
    ),
    restrictions: rightsDecisionSchema.shape.restrictions,
  })
  .strict();
export type RightsClearanceWire = z.infer<typeof rightsClearanceSchema>;

export const versionSummarySchema = z
  .object({
    kind: adminRecordKindSchema,
    recordId: z.string(),
    versionId: z.string(),
    version: z.number().int().positive(),
    tenantId: z.string().nullable(),
    status: lifecycleStateSchema,
    content: z.record(z.unknown()),
    rightsPolicy: rightsPolicySchema.nullable(),
    dataProfile: dataProfileSchema.nullable(),
    rightsClearance: rightsClearanceSchema.nullable(),
    proposedBy: z.string(),
    approvedBy: z.string().nullable(),
    revision: z.number().int().positive(),
    history: z.array(
      z
        .object({
          action: z.string(),
          from: lifecycleStateSchema,
          to: lifecycleStateSchema,
          actor: z.string(),
          reason: z.string().nullable(),
          at: z.string(),
        })
        .strict(),
    ),
    createdAt: z.string(),
    updatedAt: z.string(),
    activatedAt: z.string().nullable(),
    supersededAt: z.string().nullable(),
  })
  .strict();
export type VersionSummary = z.infer<typeof versionSummarySchema>;

export const capabilityStatusSchema = z.enum(['SUPPORTED', 'PARTIAL', 'UNKNOWN', 'UNSUPPORTED']);

export const capabilitySchema = z.enum([
  'COMPANY_REGISTRY',
  'OFFICER_ASSOCIATIONS',
  'COURT_RECORDS',
  'GAZETTE_NOTICES',
  'REGULATOR_ENFORCEMENT',
  'PROSECUTOR_BULLETINS',
  'NEWS_DISCOVERY',
  'NAME_FREQUENCY',
  'SANCTIONS_DESIGNATIONS',
]);

/**
 * The coverage statement for a jurisdiction.
 *
 * `emptyResultMeans` is the field that matters, and it is on the wire rather than left to the
 * client to infer: `NOT_ESTABLISHED` means a nil result from that capability is not a clean
 * result and must never be rendered as one.
 */
export const coverageStatementSchema = z
  .object({
    jurisdiction: z.string(),
    outcome: z.enum(['COMPLETE', 'INCOMPLETE', 'UNKNOWN']),
    capabilities: z.array(
      z
        .object({
          capability: capabilitySchema,
          status: capabilityStatusSchema,
          emptyResultMeans: z.enum(['NO_FINDINGS', 'NOT_ESTABLISHED']),
          statement: z.string(),
          blockedByDecision: z.string().nullable(),
        })
        .strict(),
    ),
    gaps: z.array(z.string()),
  })
  .strict();
export type CoverageStatementWire = z.infer<typeof coverageStatementSchema>;

export const declareCapabilitySchema = z
  .object({
    jurisdiction: countryCodeSchema,
    capability: capabilitySchema,
    status: capabilityStatusSchema,
    rationale: z.string().min(1).max(2000),
    sourceIds: z.array(z.string().max(120)).max(50).optional(),
    evidenceRef: z.string().max(300).nullable().optional(),
    blockedByDecision: z.string().max(40).nullable().optional(),
  })
  .strict();
export type DeclareCapabilityInput = z.infer<typeof declareCapabilitySchema>;

/**
 * Phase D step D5 — the source-health wire shapes.
 *
 * Health is a **separate** document from the approved version, and the split survives onto the
 * wire: this schema carries no approved field, and `sourceContentSchema` carries no observation.
 * A caller reading one and writing the other cannot accidentally make a runtime observation look
 * like something an approver signed.
 */
export const breakerStateSchema = z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']);

export const budgetWindowSchema = z
  .object({ windowStart: z.string(), spent: z.number().int().min(0) })
  .strict();

export const sourceHealthSchema = z
  .object({
    sourceId: z.string(),
    /** The approved version these observations were made against. A reference, not a copy. */
    observedVersion: z.number().int().min(0),
    breaker: breakerStateSchema,
    openedAt: z.string().nullable(),
    halfOpenProbes: z.number().int().min(0),
    consecutiveFailures: z.number().int().min(0),
    lastFailureClass: z.string().nullable(),
    lastFailureAt: z.string().nullable(),
    lastSuccessAt: z.string().nullable(),
    hourly: budgetWindowSchema,
    daily: budgetWindowSchema,
    killSwitch: z
      .object({ engagedAt: z.string(), engagedBy: z.string(), reason: z.string() })
      .strict()
      .nullable(),
    licenceExpiresAt: z.string().nullable(),
  })
  .strict();
export type SourceHealthWire = z.infer<typeof sourceHealthSchema>;

/**
 * Engaging or releasing the kill switch.
 *
 * The reason is mandatory in both directions and is not a log line: it reaches the coverage
 * statement of every run that wanted this source, so a reviewer reading a narrow result learns
 * why it is narrow. SEC-06 requires a reason on every suspension regardless.
 */
export const killSwitchSchema = z.object({ reason: z.string().min(1).max(2000) }).strict();
export type KillSwitchInput = z.infer<typeof killSwitchSchema>;
