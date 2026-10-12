/**
 * GENERATED FILE — do not edit.
 *
 * Produced by `pnpm api:generate` from the backend's OpenAPI document. To change it, edit
 * the contract schemas in the backend (`packages/contracts`), regenerate, and commit the
 * diff.
 */

export interface paths {
  '/health/live': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Liveness probe
     * @description Version-neutral and unauthenticated: a load balancer cannot authenticate, and a version bump must not turn every probe into a 404 — which reads as "the service is down".
     */
    get: operations['healthLive'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/health/ready': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Readiness probe
     * @description Whether this instance will accept traffic. It deliberately does not say why not.
     */
    get: operations['healthReady'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/health/dependencies': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Dependency detail, for authorised operators
     * @description Separate from the public probes because it discloses which dependency is degraded, which tells an attacker where to push. Requires `platform:read_health`.
     */
    get: operations['healthDependencies'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/auth/login': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Begin the authorisation-code flow
     * @description Redirects to the identity provider with PKCE (`S256`); the verifier never leaves the service. Version-neutral, because the redirect URI is registered at the provider and must not change with an API version.
     */
    get: operations['authLogin'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/auth/callback': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Complete sign-in and establish the session
     * @description Exchanges the authorisation code, then issues the HTTP-only session cookie and the readable CSRF cookie. A mismatched `state` is rejected.
     */
    get: operations['authCallback'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/auth/logout': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Revoke the session
     * @description POST rather than GET: a GET logout can be fired by any page that embeds an image.
     */
    post: operations['authLogout'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/auth/session': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Who am I
     * @description What the panel needs to render its shell. Carries no token and no session identifier.
     */
    get: operations['authSession'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/subjects': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Create a service-owned identity snapshot (FR-01)
     * @description The full name is stored as written, in its original script, and is **never split**
     *     into given and family parts. Splitting destroys patronymic chains, mononyms and
     *     every naming system that puts the family name first — silently, at intake, before
     *     any matching can compensate. Normalised comparison forms are derived alongside the
     *     original, never in place of it.
     *
     *     Sparse input is accepted. A missing date of birth stays missing; the subject simply
     *     remains unresolved rather than being completed by inference.
     *
     *     `externalSubjectRef` and `externalCaseRef` are recorded for correlation only. They
     *     are neither a lookup instruction nor an authorisation credential.
     */
    post: operations['createSubject'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/subjects/{subjectId}/versions/{version}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Read one pinned version of a subject
     * @description Versions are immutable. A data update creates a new one, and a historical search keeps the version it ran against, so a past result can still be explained.
     */
    get: operations['getSubjectVersion'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/searches': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** List searches for the caller's tenant */
    get: operations['listSearches'];
    put?: never;
    /**
     * Accept a search for execution
     * @description Returns **202 Accepted** with a status URL, not a result. Returning 200 with a
     *     result-shaped body would invite a caller to read "accepted" as "completed, nothing
     *     found".
     *
     *     Send `Idempotency-Key` to make submission safe to retry: an identical request
     *     returns the original run with **200**, a changed body under the same key returns
     *     **409**, and two concurrent identical submissions produce exactly one run.
     *
     *     The scope in the request is what is being *asked for*. What was actually searched
     *     comes back as the coverage statement, and it may be narrower.
     */
    post: operations['createSearch'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/searches/{searchId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Read a search and its three result dimensions
     * @description `execution`, `findings` and `coverage` are independent and must be read together.
     *     `SUCCEEDED` with `NO_MATCHES_FOUND` and `INCOMPLETE` coverage means the run
     *     finished, found nothing, **and did not search everything it promised** — which is
     *     not a clean result, and must never be presented as one.
     *
     *     `progress` never carries a fabricated percentage: it reports stages completed and
     *     the cascade rung reached, or nothing.
     */
    get: operations['getSearch'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/admin/plans': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Reserved — not implemented
     * @description Plan management is deferred by decision D-007. This phase builds entitlement seams only.
     */
    get: operations['reservedAdminPlansGet'];
    put?: never;
    /**
     * Reserved — not implemented
     * @description Plan management is deferred by decision D-007. This phase builds entitlement seams only.
     */
    post: operations['reservedAdminPlansPost'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/admin/tenants/{tenantId}/usage': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Reserved — not implemented
     * @description Usage metering is deferred by decision D-007. Counters are recorded but not yet exposed or billed.
     */
    get: operations['reservedAdminTenantUsageGet'];
    put?: never;
    /**
     * Reserved — not implemented
     * @description Usage metering is deferred by decision D-007. Counters are recorded but not yet exposed or billed.
     */
    post: operations['reservedAdminTenantUsagePost'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/tenant/usage': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Reserved — not implemented
     * @description Tenant usage reporting is deferred by decision D-007.
     */
    get: operations['reservedTenantUsageGet'];
    put?: never;
    /**
     * Reserved — not implemented
     * @description Tenant usage reporting is deferred by decision D-007.
     */
    post: operations['reservedTenantUsagePost'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/v1/tenant/api-keys': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Reserved — not implemented
     * @description Tenant self-service key management is deferred by decision D-007. Keys are provider-managed in this phase.
     */
    get: operations['reservedTenantApiKeysGet'];
    put?: never;
    /**
     * Reserved — not implemented
     * @description Tenant self-service key management is deferred by decision D-007. Keys are provider-managed in this phase.
     */
    post: operations['reservedTenantApiKeysPost'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    ApiError: {
      /** @enum {string} */
      code:
        | 'VALIDATION_FAILED'
        | 'UNKNOWN_FIELD'
        | 'INVALID_SCOPE'
        | 'INVALID_POLICY'
        | 'UNAUTHENTICATED'
        | 'SESSION_EXPIRED'
        | 'TOKEN_INVALID'
        | 'FORBIDDEN'
        | 'CROSS_TENANT_DENIED'
        | 'ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN'
        | 'SANDBOX_CANNOT_ACCESS_LIVE'
        | 'BREAK_GLASS_REQUIRED'
        | 'NOT_FOUND'
        | 'REVISION_CONFLICT'
        | 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY'
        | 'ALREADY_TERMINAL'
        | 'PAYLOAD_TOO_LARGE'
        | 'INPUT_BOUND_EXCEEDED'
        | 'RATE_LIMITED'
        | 'NOT_IMPLEMENTED'
        | 'INTERNAL';
      message: string;
      correlationId: string;
      retryable: boolean;
      details?: {
        path: string;
        message: string;
      }[];
    };
    /** @enum {string} */
    DatePrecision: 'DAY' | 'MONTH' | 'YEAR' | 'UNKNOWN';
    PreciseDate: {
      /** Format: date */
      value: string | null;
      precision: components['schemas']['DatePrecision'];
    };
    /** @enum {string} */
    AliasOrigin:
      | 'SELF_DECLARED'
      | 'CUSTOMER_RECORD'
      | 'OFFICIAL_DOCUMENT'
      | 'PUBLIC_REGISTER'
      | 'MAIDEN_NAME'
      | 'MARRIED_NAME'
      | 'TRANSLITERATION'
      | 'UNKNOWN';
    Alias: {
      name: string;
      origin: components['schemas']['AliasOrigin'];
      language?: string;
    };
    CompanyIdentifier: {
      registrationNumber: string;
      jurisdiction: string;
      name?: string;
    };
    /** @enum {string} */
    ScreeningPurpose:
      | 'CUSTOMER_ONBOARDING'
      | 'PERIODIC_REVIEW'
      | 'ENHANCED_DUE_DILIGENCE'
      | 'TRANSACTION_MONITORING_ESCALATION'
      | 'SUPPLIER_DUE_DILIGENCE'
      | 'EMPLOYEE_SCREENING';
    NameFrequencyPrior: {
      decile: number;
      population: string;
      sourceRef: string;
    };
    CreateSubjectRequest: {
      fullName: string;
      /** @default [] */
      aliases: components['schemas']['Alias'][];
      dateOfBirth?: components['schemas']['PreciseDate'];
      /** @default [] */
      countryContext: string[];
      /** @default [] */
      knownCompanies: components['schemas']['CompanyIdentifier'][];
      externalSubjectRef?: string;
      externalCaseRef?: string;
      purpose: components['schemas']['ScreeningPurpose'];
    };
    SubjectVersion: {
      subjectId: string;
      subjectVersionId: string;
      version: number;
      tenantId: string;
      fullName: string;
      normalised: {
        folded: string;
        sortedCoreKey: string;
        phoneticKeys: string[];
        scripts: string[];
      };
      aliases: components['schemas']['Alias'][];
      dateOfBirth: components['schemas']['PreciseDate'] | null;
      countryContext: string[];
      knownCompanies: {
        registrationNumber: components['schemas']['CompanyIdentifier']['registrationNumber'];
        jurisdiction: components['schemas']['CompanyIdentifier']['jurisdiction'];
        name?: components['schemas']['CompanyIdentifier']['name'];
        /** @enum {string} */
        verificationStatus: 'SUPPLIED_UNVERIFIED' | 'SUPPLIED_REVIEWED' | 'REGISTRY_VERIFIED';
      }[];
      externalSubjectRef: string | null;
      externalCaseRef: string | null;
      purpose: components['schemas']['ScreeningPurpose'];
      nameFrequencyPrior: components['schemas']['NameFrequencyPrior'] | null;
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      supersededAt: string | null;
    };
    /** @enum {string} */
    ExecutionState: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
    /** @enum {string} */
    FindingsState: 'POTENTIAL_MATCHES' | 'NO_MATCHES_FOUND' | 'UNRESOLVED' | 'NOT_EVALUATED';
    /** @enum {string} */
    CoverageState: 'WITHIN_DECLARED_SCOPE' | 'INCOMPLETE' | 'UNKNOWN';
    CreateSearchRequest: {
      subjectRef?: {
        subjectId: string;
        version: number;
      };
      subjectSnapshot?: components['schemas']['CreateSubjectRequest'];
      externalCaseRef?: string;
      requestedScope: {
        jurisdictions: string[];
        languages: string[];
        categories?: string[];
        /** @default false */
        includeFormerDirectorships: boolean;
        /**
         * Format: date
         * @default null
         */
        fromDate: string | null;
      };
      /**
       * @default sandbox
       * @enum {string}
       */
      environment: 'sandbox' | 'live';
    };
    SearchAccepted: {
      searchId: string;
      statusUrl: string;
      execution: components['schemas']['ExecutionState'];
    };
    SearchSummary: {
      searchId: string;
      tenantId: string;
      subjectId: string;
      subjectVersion: number;
      /** @enum {string} */
      environment: 'sandbox' | 'live';
      execution: components['schemas']['ExecutionState'];
      findings: components['schemas']['FindingsState'];
      coverage: components['schemas']['CoverageState'];
      pinnedVersions: {
        taxonomyVersion: number;
        policyVersion: number;
        entitlementVersion: number;
        bandingRulesVersion: string;
      };
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      completedAt: string | null;
      refreshOfSearchId: string | null;
      progress: {
        stagesCompleted: number;
        stagesTotal: number;
        cascadeRungReached: number | null;
        warnings: string[];
      };
    };
    SearchPage: {
      items: components['schemas']['SearchSummary'][];
      nextCursor: string | null;
    };
    SessionInfo: {
      subject: string;
      tenantId: string | null;
      roles: string[];
      /** @enum {string} */
      environment: 'sandbox' | 'live';
    };
    HealthStatus: {
      /** @enum {string} */
      status: 'ok';
    };
    DependencyHealth: {
      status: string;
      note: string;
    };
  };
  responses: {
    /** @description The request body or query is malformed, or carries an unknown field. Possible codes: VALIDATION_FAILED, UNKNOWN_FIELD. */
    Error400: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        /**
         * @example {
         *       "code": "VALIDATION_FAILED",
         *       "message": "The request body failed validation.",
         *       "correlationId": "01JB8Z5R3M4Q2N7T9V0X1Y2Z3A",
         *       "retryable": false
         *     }
         */
        'application/json': components['schemas']['ApiError'];
      };
    };
    /** @description No valid credential. The session may have expired. Possible codes: UNAUTHENTICATED, SESSION_EXPIRED, TOKEN_INVALID. */
    Error401: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        /**
         * @example {
         *       "code": "UNAUTHENTICATED",
         *       "message": "Authentication is required.",
         *       "correlationId": "01JB8Z5R3M4Q2N7T9V0X1Y2Z3A",
         *       "retryable": false
         *     }
         */
        'application/json': components['schemas']['ApiError'];
      };
    };
    /** @description Authenticated, but not permitted. An entitlement denial is reported here and is never retryable (REL-02). Possible codes: FORBIDDEN, CROSS_TENANT_DENIED, ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN, SANDBOX_CANNOT_ACCESS_LIVE, BREAK_GLASS_REQUIRED. */
    Error403: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        /**
         * @example {
         *       "code": "FORBIDDEN",
         *       "message": "Access denied.",
         *       "correlationId": "01JB8Z5R3M4Q2N7T9V0X1Y2Z3A",
         *       "retryable": false
         *     }
         */
        'application/json': components['schemas']['ApiError'];
      };
    };
    /** @description Not found. Deliberately indistinguishable from an unauthorised read, so IDs cannot be enumerated. Possible codes: NOT_FOUND. */
    Error404: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        /**
         * @example {
         *       "code": "NOT_FOUND",
         *       "message": "Search not found.",
         *       "correlationId": "01JB8Z5R3M4Q2N7T9V0X1Y2Z3A",
         *       "retryable": false
         *     }
         */
        'application/json': components['schemas']['ApiError'];
      };
    };
    /** @description Conflict: a stale revision, or an idempotency key reused with a different body. Possible codes: REVISION_CONFLICT, IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY, ALREADY_TERMINAL. */
    Error409: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        /**
         * @example {
         *       "code": "REVISION_CONFLICT",
         *       "message": "The record changed since it was read. Re-read it and retry.",
         *       "correlationId": "01JB8Z5R3M4Q2N7T9V0X1Y2Z3A",
         *       "retryable": false
         *     }
         */
        'application/json': components['schemas']['ApiError'];
      };
    };
    /** @description The request exceeds a documented input bound. Possible codes: PAYLOAD_TOO_LARGE, INPUT_BOUND_EXCEEDED. */
    Error413: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        /**
         * @example {
         *       "code": "PAYLOAD_TOO_LARGE",
         *       "message": "The request exceeds the 256 kB body limit.",
         *       "correlationId": "01JB8Z5R3M4Q2N7T9V0X1Y2Z3A",
         *       "retryable": false
         *     }
         */
        'application/json': components['schemas']['ApiError'];
      };
    };
    /** @description The request is well-formed but the scope or policy it asks for is not valid. Possible codes: INVALID_SCOPE, INVALID_POLICY. */
    Error422: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        /**
         * @example {
         *       "code": "INVALID_SCOPE",
         *       "message": "The requested scope includes a jurisdiction that is not enabled.",
         *       "correlationId": "01JB8Z5R3M4Q2N7T9V0X1Y2Z3A",
         *       "retryable": false
         *     }
         */
        'application/json': components['schemas']['ApiError'];
      };
    };
    /** @description Throttled. This is not an entitlement denial and not a coverage gap. Possible codes: RATE_LIMITED. */
    Error429: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        /**
         * @example {
         *       "code": "RATE_LIMITED",
         *       "message": "Too many requests. Retry after the interval in the Retry-After header.",
         *       "correlationId": "01JB8Z5R3M4Q2N7T9V0X1Y2Z3A",
         *       "retryable": true
         *     }
         */
        'application/json': components['schemas']['ApiError'];
      };
    };
    /** @description Unexpected failure. The body never carries internal detail (SEC-04). Possible codes: INTERNAL. */
    Error500: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        /**
         * @example {
         *       "code": "INTERNAL",
         *       "message": "The request could not be completed.",
         *       "correlationId": "01JB8Z5R3M4Q2N7T9V0X1Y2Z3A",
         *       "retryable": true
         *     }
         */
        'application/json': components['schemas']['ApiError'];
      };
    };
    /** @description A reserved endpoint that is documented but deliberately not implemented. Possible codes: NOT_IMPLEMENTED. */
    Error501: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        /**
         * @example {
         *       "code": "NOT_IMPLEMENTED",
         *       "message": "This endpoint is reserved and not implemented in this release.",
         *       "correlationId": "01JB8Z5R3M4Q2N7T9V0X1Y2Z3A",
         *       "retryable": false
         *     }
         */
        'application/json': components['schemas']['ApiError'];
      };
    };
  };
  parameters: {
    /** @description Page size. Defaults to 50. */
    Limit: number;
    /** @description Opaque continuation token from the previous page. Clients must not construct or parse one: it encodes a stable ordering key, which is what lets a page neither duplicate nor drop items while the underlying set changes. */
    Cursor: string;
    /** @description Required for state-changing requests authenticated by the session cookie. Echoes the readable `csrf_token` cookie. Machine callers send no cookie and do not use it. */
    CsrfToken: string;
  };
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  healthLive: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The process is alive. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['HealthStatus'];
        };
      };
    };
  };
  healthReady: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Ready for traffic. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['HealthStatus'];
        };
      };
    };
  };
  healthDependencies: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Dependency state. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['DependencyHealth'];
        };
      };
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
    };
  };
  authLogin: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Redirect to the identity provider. Sets two short-lived handshake cookies. */
      302: {
        headers: {
          Location?: string;
          [name: string]: unknown;
        };
        content?: never;
      };
    };
  };
  authCallback: {
    parameters: {
      query: {
        code: string;
        state: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Signed in; redirect to the panel. */
      302: {
        headers: {
          Location?: string;
          [name: string]: unknown;
        };
        content?: never;
      };
      401: components['responses']['Error401'];
    };
  };
  authLogout: {
    parameters: {
      query?: never;
      header?: {
        /** @description Required for state-changing requests authenticated by the session cookie. Echoes the readable `csrf_token` cookie. Machine callers send no cookie and do not use it. */
        'X-CSRF-Token'?: components['parameters']['CsrfToken'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Session revoked and cookies cleared. */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
    };
  };
  authSession: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The current principal. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          /**
           * @example {
           *       "subject": "9f2c1e40-7a5b-4c33-9e21-8d0a1b2c3d4e",
           *       "tenantId": "tenant_demo_cr",
           *       "roles": [
           *         "analyst",
           *         "reviewer"
           *       ],
           *       "environment": "sandbox"
           *     }
           */
          'application/json': components['schemas']['SessionInfo'];
        };
      };
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
    };
  };
  createSubject: {
    parameters: {
      query?: never;
      header?: {
        /** @description Required for state-changing requests authenticated by the session cookie. Echoes the readable `csrf_token` cookie. Machine callers send no cookie and do not use it. */
        'X-CSRF-Token'?: components['parameters']['CsrfToken'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        /**
         * @example {
         *       "fullName": "María José Rodríguez Alvarado",
         *       "aliases": [
         *         {
         *           "name": "María J. Rodríguez",
         *           "origin": "CUSTOMER_RECORD",
         *           "language": "es"
         *         }
         *       ],
         *       "dateOfBirth": {
         *         "value": "1984-03-11",
         *         "precision": "DAY"
         *       },
         *       "countryContext": [
         *         "CR"
         *       ],
         *       "knownCompanies": [],
         *       "externalCaseRef": "CASE-2026-00471",
         *       "purpose": "CUSTOMER_ONBOARDING"
         *     }
         */
        'application/json': components['schemas']['CreateSubjectRequest'];
      };
    };
    responses: {
      /** @description The stored snapshot. */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SubjectVersion'];
        };
      };
      400: components['responses']['Error400'];
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
      413: components['responses']['Error413'];
      422: components['responses']['Error422'];
    };
  };
  getSubjectVersion: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        subjectId: string;
        version: number;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The pinned version. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SubjectVersion'];
        };
      };
      400: components['responses']['Error400'];
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
      404: components['responses']['Error404'];
    };
  };
  listSearches: {
    parameters: {
      query?: {
        /** @description Page size. Defaults to 50. */
        limit?: components['parameters']['Limit'];
        /** @description Opaque continuation token from the previous page. Clients must not construct or parse one: it encodes a stable ordering key, which is what lets a page neither duplicate nor drop items while the underlying set changes. */
        cursor?: components['parameters']['Cursor'];
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description One page of searches. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SearchPage'];
        };
      };
      400: components['responses']['Error400'];
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
    };
  };
  createSearch: {
    parameters: {
      query?: never;
      header?: {
        /** @description Tenant-scoped. Without it there is no duplicate protection, and the caller owns the consequences. */
        'Idempotency-Key'?: string;
        /** @description Required for state-changing requests authenticated by the session cookie. Echoes the readable `csrf_token` cookie. Machine callers send no cookie and do not use it. */
        'X-CSRF-Token'?: components['parameters']['CsrfToken'];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        /**
         * @example {
         *       "subjectRef": {
         *         "subjectId": "sub_01JB8Z5R3M4Q2N7T9V0X1Y2Z3A",
         *         "version": 1
         *       },
         *       "requestedScope": {
         *         "jurisdictions": [
         *           "CR"
         *         ],
         *         "languages": [
         *           "es",
         *           "en"
         *         ],
         *         "includeFormerDirectorships": false,
         *         "fromDate": null
         *       },
         *       "environment": "sandbox"
         *     }
         */
        'application/json': components['schemas']['CreateSearchRequest'];
      };
    };
    responses: {
      /** @description Idempotent replay: this exact request was already accepted, and this is the original run. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SearchAccepted'];
        };
      };
      /** @description Accepted and queued. */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          /**
           * @example {
           *       "searchId": "srch_01JB8Z5R3M4Q2N7T9V0X1Y2Z3A",
           *       "statusUrl": "/v1/searches/srch_01JB8Z5R3M4Q2N7T9V0X1Y2Z3A",
           *       "execution": "QUEUED"
           *     }
           */
          'application/json': components['schemas']['SearchAccepted'];
        };
      };
      400: components['responses']['Error400'];
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
      409: components['responses']['Error409'];
      413: components['responses']['Error413'];
      422: components['responses']['Error422'];
      429: components['responses']['Error429'];
    };
  };
  getSearch: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        searchId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The search. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SearchSummary'];
        };
      };
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
      404: components['responses']['Error404'];
    };
  };
  reservedAdminPlansGet: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
      501: components['responses']['Error501'];
    };
  };
  reservedAdminPlansPost: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
      501: components['responses']['Error501'];
    };
  };
  reservedAdminTenantUsageGet: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
      501: components['responses']['Error501'];
    };
  };
  reservedAdminTenantUsagePost: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        tenantId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
      501: components['responses']['Error501'];
    };
  };
  reservedTenantUsageGet: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
      501: components['responses']['Error501'];
    };
  };
  reservedTenantUsagePost: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
      501: components['responses']['Error501'];
    };
  };
  reservedTenantApiKeysGet: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
      501: components['responses']['Error501'];
    };
  };
  reservedTenantApiKeysPost: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      401: components['responses']['Error401'];
      403: components['responses']['Error403'];
      501: components['responses']['Error501'];
    };
  };
}
