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
  /** Scheduled machine-readable publisher artifact, parsed and searched from a local snapshot. */
  'INDEXED_BULK_XML',
  /** Scheduled machine-readable JSON artifact, parsed and searched from a local snapshot. */
  'INDEXED_BULK_JSON',
  /** Scheduled RSS/Atom ingestion into the same local snapshot store. */
  'INDEXED_RSS',
  /** Scheduled deterministic HTML ingestion where no structured official artifact exists. */
  'INDEXED_HTML',
  'NEWS_DISCOVERY_RSS',
  /**
   * GDELT DOC 2.0 — rung 3. A separate type from `NEWS_DISCOVERY_RSS` because it returns JSON
   * rather than a feed and needs its own parse, not because it is a different kind of source.
   */
  'NEWS_DISCOVERY_GDELT',
  /**
   * Our own self-hosted SearXNG instance, as the adverse-media discovery layer (rung 5).
   *
   * A separate type from `WEB_DISCOVERY_SEARX` below, and the difference is not cosmetic.
   * `WEB_DISCOVERY_SEARX` was declared in Phase D for the `WebDiscoveryPort` seam, which is
   * asked per **engine mix** and has a second method for rung-6 site search. Nothing was ever
   * built behind it. What this milestone built is asked exactly as the other news rungs are —
   * one planned query at a time, through `NewsDiscoveryPort` — so it goes on the same ladder
   * path as `NEWS_DISCOVERY_RSS` and `NEWS_DISCOVERY_GDELT` rather than growing a parallel
   * execution path beside them.
   *
   * It is also the one connector type the fetch gate treats as an **internal service**: it is
   * the value `authoriseInternalDiscoveryService` requires, and a source recorded as anything
   * else cannot reach that method. The upstream engines it queries are governed separately and
   * are not authorised by this type — see `apps/api/src/sources/searxng/engine-governance.ts`.
   */
  'NEWS_DISCOVERY_SEARXNG',
  /** Declared in Phase D for the `WebDiscoveryPort` seam. No adapter was ever built behind it. */
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
 * Groupings that are not countries, refused wherever a country code is expected.
 *
 * Exported because the search scope refuses the same list (`../searches/search.ts`). One list,
 * because a region accepted at one entry point and refused at another is worse than either.
 */
export const REGIONAL_PSEUDO_CODES = ['EU', 'EEA', 'UK', 'MENA', 'SEA', 'LATAM', 'APAC', 'GLOBAL'];

/**
 * A two-letter ISO country code.
 *
 * FR-05: "EU", "MENA" and "SEA" are not blanket source permissions. The enum of real codes is
 * not enumerated here, but a regional pseudo-code is rejected explicitly so the mistake fails
 * loudly at the API rather than silently widening a source's scope.
 */
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
 * What a publisher's own access policy says, recorded on the version an approver signed.
 *
 * **Why this is registry content and not configuration.** A publisher's fair-access terms are a
 * property of the publisher, they are what an approver actually read before approving, and they
 * are what a complaint would be checked against. A rate ceiling living in an environment
 * variable is a rate nobody approved; a poll interval living in code is one nobody can audit.
 * Both belong on the immutable version, beside the licence terms, and both are read at the
 * point of use.
 *
 * Optional, because most sources publish nothing of the sort and inventing an access policy for
 * them would put a statement in the registry that no publisher ever made. Absent means FR-06's
 * own defaults stand and no stop condition escalates them.
 *
 * Opened by **D17** — the first deliberate live request — which had to record four things about
 * one source: which source, under whose approval, at what rate, and on what stop condition.
 * Three of those are fields here; the fourth is `firstContactApproval`.
 */
export const sourceAccessPolicySchema = z
  .object({
    /**
     * The publisher's stated request ceiling, per second. **Recorded, never a target.**
     *
     * The SEC publishes ten per second per IP. Our actual usage of that source is one
     * conditional GET every fifteen minutes, which is roughly a thousandth of it. The ceiling is
     * here so that a person can see the distance between what is permitted and what is done.
     */
    requestCeilingPerSecond: z.number().positive().max(10_000).nullable(),
    /** The minimum interval between polls of this source, in seconds. The floor, not the rate. */
    pollFloorSeconds: z.number().int().positive().max(86_400).nullable(),
    /**
     * The exact URL a polling connector reads — a feed, an index, a search endpoint.
     *
     * **Registry content, not connector code.** A URL compiled into a connector is a request
     * nobody approved, and it makes the connector per-source: the same RSS parser then exists
     * three times because three publishers have three addresses. Here, one connector serves every
     * RSS source and each source's address is part of what an approver signed.
     *
     * Still not an executable instruction (see the schema header): it is a URL, validated as one,
     * and every request to it goes through `screenUrl`, the robots check and both breakers like
     * any other. Null for a source that is only ever reached by following a discovered link.
     */
    endpointUrl: z.string().url().max(500).nullable(),
    /**
     * Whether the endpoint is a fixed list or a search that takes a query.
     *
     * `FIXED_FEED` — the SEC's litigation releases, a gazette index — is polled whole and the
     * planned query is matched against what came back. `QUERY_FEED` — Google News, Bing News —
     * takes the query as a parameter, so a different query is a different request.
     *
     * The distinction is recorded rather than inferred from the URL because it changes the
     * **rate**: a fixed feed is polled on a schedule regardless of how many searches are running,
     * and a query feed is hit once per planned query, which is the difference between four
     * requests an hour and four hundred.
     */
    endpointKind: z.enum(['FIXED_FEED', 'QUERY_FEED']),
    /**
     * For a `QUERY_FEED`, the **name of the query parameter** the connector sets. Null otherwise.
     *
     * A parameter name, deliberately, and not a URL template. The connector parses `endpointUrl`,
     * sets this one search parameter to the planned query text, and serialises — so the query
     * cannot introduce a path segment, a host, a scheme or a second parameter. A template with a
     * `{query}` hole would be an executable instruction in the registry, which the schema header
     * rules out, and it would be an injection point pointed at a third party's server.
     */
    queryParam: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9_.-]+$/, 'A bare query-parameter name — no URL, no template, no braces.')
      .nullable(),
    /**
     * Whether polls must carry `If-None-Match` / `If-Modified-Since`.
     *
     * Not politeness theatre: a conditional GET that hits returns 304 with no body, so the
     * publisher serves bytes only when something actually changed. For a feed polled every
     * fifteen minutes, almost every poll is a 304.
     */
    conditionalGet: z.boolean(),
    /** Whether the publisher requires a descriptive user agent and refuses requests without one. */
    userAgentRequired: z.boolean(),
    /** Where the policy is published, so the recorded summary can be checked against it. */
    policyUrl: z.string().url().max(500).nullable(),
    /** The policy in the approver's own words. What they read, not a link they might have read. */
    policySummary: z.string().min(1).max(2000),
    /**
     * Per-source escalations of FR-06's failure table. They may only ever **stop** a source
     * sooner — never permit a request FR-06 refused. See `stop-conditions.ts` in the domain
     * package, where that invariant is stated and tested.
     */
    stopConditions: z
      .object({
        haltOnStatuses: z.array(z.number().int().min(100).max(599)).max(10),
        haltOnRateLimit: z.boolean(),
        rateLimitCooldownSeconds: z.number().int().min(0).max(86_400),
        serverErrorStreakToHalt: z.number().int().positive().max(100).nullable(),
        requiresFreshApprovalOnHalt: z.boolean(),
      })
      .strict(),
    /**
     * Who approved the **first live request** to this source, by name (D17).
     *
     * Null for every source that has never been contacted, which is all of them at the time this
     * field is added. It is not the same as the version's approver: approving a registry entry
     * says the configuration is right, and this says a named person accepted that this service
     * would start making requests to a publisher who did not ask to hear from it.
     */
    firstContactApproval: z
      .object({
        approvedBy: z.string().min(1).max(200),
        role: z.string().min(1).max(120),
        /** ISO 8601 date. */
        approvedOn: z.string().min(10).max(40),
        /** The open decision this approval closes — `D17` for the first one. */
        decision: z.string().min(1).max(40),
      })
      .strict()
      .nullable(),
    /**
     * A named, host-scoped robots exception (FR-06, **D6**).
     *
     * **Why a host list and not a boolean.** Several publishers serve their own bulk file by
     * redirecting their documented address to a signed, short-lived object-store URL — OFAC to
     * AWS GovCloud S3, the UN to Azure Blob Storage. Those delivery hosts answer `robots.txt`
     * with a 403 rather than a 404, which this service reads as `UNKNOWN` and refuses, because
     * an outage at a publisher must never become consent. That refusal is right in general and
     * wrong for this one shape: the redirect is issued *by the publisher* to *the publisher's
     * own* delivery infrastructure, for one exact file.
     *
     * So the exception is not "ignore robots for this source". It is "these named hosts are this
     * publisher's own delivery infrastructure, and a hop onto one of them may proceed without an
     * established robots position". Every other host — including one the publisher redirects to
     * later — still goes through the strict path and is refused. That is what makes this fail
     * closed: widening the exception requires a new approved version, not a redirect.
     *
     * Null for every source that needs no exception, which is almost all of them.
     */
    robotsException: z
      .object({
        approvedBy: z.string().min(1).max(200),
        role: z.string().min(1).max(120),
        /** ISO 8601 date. */
        approvedOn: z.string().min(10).max(40),
        /** The open decision recording this exception — `D6`. */
        decision: z.string().min(1).max(40),
        /** What the exception permits, in the approver's own words. Never a link. */
        scope: z.string().min(1).max(1000),
        /**
         * The exact hosts the exception covers. Bare hostnames, never patterns: a wildcard here
         * would be an exception nobody bounded, and `*.amazonaws.com` is most of the internet.
         */
        deliveryHosts: z.array(canonicalDomainSchema).min(1).max(10),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .refine((policy) => policy.endpointKind !== 'QUERY_FEED' || policy.queryParam !== null, {
    path: ['queryParam'],
    message:
      'A QUERY_FEED must name the query parameter the connector sets. Without it the ' +
      'connector would have to guess where the query goes, and a guess aimed at a third ' +
      "party's server is not a guess worth making.",
  })
  // The companion rule — "a QUERY_FEED must record the endpoint it queries" — is NOT here.
  //
  // It cannot be, because it has one exception and the exception is decided by `connectorType`,
  // which this schema cannot see. See `sourceContentSchema.superRefine` below, where both fields
  // are in scope. Leaving a weakened version here as well would be two rules disagreeing about
  // the same field.
  ;
export type SourceAccessPolicy = z.infer<typeof sourceAccessPolicySchema>;

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
    /**
     * Jurisdictions this deployment may use the source for. A genuinely worldwide authority may
     * declare GLOBAL explicitly; an empty country list alone never means global.
     */
    jurisdictionScope: z.enum(['NAMED_COUNTRIES', 'GLOBAL']).default('NAMED_COUNTRIES'),
    countries: z.array(countryCodeSchema).max(249),
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
    contentFormat: z.enum(['HTML', 'PDF', 'JSON', 'XML', 'CSV', 'XML_FEED', 'MIXED']),
    /** The publisher's own access policy, where they publish one. See above (D17). */
    accessPolicy: sourceAccessPolicySchema.nullable().optional(),
    /**
     * Refresh policy for locally indexed sources. It is approved registry content because it
     * controls publisher contact and determines when a snapshot becomes stale.
     */
    refreshPolicy: z
      .object({
        intervalSeconds: z.number().int().min(900).max(2_592_000),
        staleAfterSeconds: z.number().int().min(900).max(7_776_000),
        minimumExpectedRows: z.number().int().positive().max(10_000_000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((content, context) => {
    if (content.jurisdictionScope === 'NAMED_COUNTRIES' && content.countries.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['countries'],
        message: 'NAMED_COUNTRIES requires at least one explicit ISO country code.',
      });
    }
    if (content.jurisdictionScope === 'GLOBAL' && content.countries.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['countries'],
        message: 'GLOBAL jurisdiction scope must not also carry an incomplete named-country list.',
      });
    }
    // **A QUERY_FEED must record the endpoint it queries — unless it is a service we run.**
    //
    // The rule exists so that a connector never has to guess an address, because "a guess aimed
    // at a third party's server is not a guess worth making". Every word of that reasoning is
    // about a third party. `NEWS_DISCOVERY_SEARXNG` addresses an instance this deployment runs,
    // at an address that comes from `SEARXNG_URL` and is validated at startup — there is no
    // guess, and recording a loopback URL on an approved version would put a deployment detail
    // where the next reader would take it for a publisher's published address.
    //
    // The exemption cannot be borrowed. It is keyed on one connector type, that type is the one
    // `authoriseInternalDiscoveryService` requires, and `authoriseUrl` — the gate every
    // publisher goes through — refuses that type outright. A source claiming this type to skip
    // recording an endpoint would also be refused the publisher path entirely.
    const addressedInternally = content.connectorType === 'NEWS_DISCOVERY_SEARXNG';
    if (
      !addressedInternally &&
      content.accessPolicy?.endpointKind === 'QUERY_FEED' &&
      content.accessPolicy.endpointUrl === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accessPolicy', 'endpointUrl'],
        message: 'A QUERY_FEED must record the endpoint it queries.',
      });
    }
    if (addressedInternally && content.accessPolicy?.endpointUrl !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['accessPolicy', 'endpointUrl'],
        message:
          'An internal discovery service must NOT record an endpoint URL. Its address is ' +
          'deployment configuration (SEARXNG_URL), and a URL here would be read as the ' +
          'published address of a publisher.',
      });
    }
    if (content.connectorType.startsWith('INDEXED_') && content.refreshPolicy === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['refreshPolicy'],
        message: 'An indexed connector must declare its reviewed refresh and anomaly policy.',
      });
    }
  });

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
