/**
 * The OpenAPI document for the public API (section 6.1).
 *
 * Two rules govern what goes in here:
 *
 *  1. **It describes what the service does, not what it will do.** The reserved FR-15 routes
 *     appear with their 501 and the reason, because an integrator who cannot see them assumes
 *     a 404 is their own mistake. Nothing else unbuilt is listed.
 *  2. **Schemas are never written by hand.** They come from the zod schemas the API validates
 *     with, so the document cannot describe a field the service would reject.
 *
 * The committed `openapi/openapi.json` is generated from this by `pnpm openapi:generate`, and
 * `apps/api/test/openapi-document.test.ts` fails if the two diverge, or if a route exists on a
 * controller without appearing here.
 */

import { buildComponentSchemas, buildErrorResponses, errorRef, ref } from './components.js';
import type { SchemaObject } from './components.js';

/** Bumped when the published contract changes in a way a client would notice. */
export const OPENAPI_VERSION = '0.1.0';

/** The URL prefix every business route carries. Health and the sign-in flow are neutral. */
export const API_VERSION_PREFIX = '/v1';

export function buildOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Erly adverse-search API',
      version: OPENAPI_VERSION,
      description: [
        'Adverse-media screening. Free and open-source sources only.',
        '',
        'Three things about this API are unusual, and all three are deliberate:',
        '',
        '- **A result has three independent dimensions, not one status.** `execution`,',
        '  `findings` and `coverage` answer different questions: whether the run finished,',
        '  what was found, and whether everything promised was actually searched. A run that',
        '  succeeded with no findings and a run whose sources were all blocked are not the',
        '  same result, and no field collapses them.',
        '- **An entitlement denial is not throttling and not a coverage gap.** It is a 403',
        '  with a specific code, and it is never retryable.',
        '- **Sparse identity input is accepted and stays unresolved.** A missing date of birth',
        '  is never inferred, and a name is never split into given and family parts.',
      ].join('\n'),
      contact: { name: 'Erly' },
    },
    servers: [
      { url: 'http://127.0.0.1:3000', description: 'Local development' },
      { url: '/', description: 'Same origin as the control panel' },
    ],
    tags: [
      { name: 'health', description: 'Liveness, readiness and operator-visible dependency state' },
      { name: 'auth', description: 'Browser sign-in and the backend-for-frontend session' },
      { name: 'subjects', description: 'FR-01 identity snapshots' },
      { name: 'searches', description: 'Search creation and the result dimensions' },
      { name: 'reserved', description: 'Documented, deliberately not implemented (FR-15, D-007)' },
    ],
    security: [{ sessionCookie: [] }, { machineToken: [] }, { apiKey: [] }],
    paths: buildPaths(),
    components: {
      schemas: buildComponentSchemas(),
      responses: buildErrorResponses(),
      parameters: PARAMETERS,
      securitySchemes: SECURITY_SCHEMES,
    },
  };
}

/**
 * Three credentials, never mixed.
 *
 * The browser gets a session cookie and no token: a bearer token readable by page script is
 * exfiltratable by page script. Machine callers get either an audience-bound bearer token or an
 * environment-scoped API key, and no cookie, so a machine credential cannot be ridden by a
 * cross-site request.
 *
 * The API key uses its own `ApiKey` scheme rather than sharing `Bearer`. A shared scheme means
 * every credential has to be tried against both verifiers, and a rejection can no longer say
 * which credential the caller meant.
 */
const SECURITY_SCHEMES: Record<string, SchemaObject> = {
  sessionCookie: {
    type: 'apiKey',
    in: 'cookie',
    name: 'adverse_session',
    description: [
      'The control panel session (section 4.2). HTTP-only and secure; the browser never holds',
      'a provider token. State-changing requests must also send `X-CSRF-Token`, echoing the',
      'readable `csrf_token` cookie issued alongside it.',
    ].join(' '),
  },
  machineToken: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: [
      'Machine-to-machine access (section 4.2). Short-lived, audience-bound and signed with an',
      'asymmetric algorithm. Scopes are checked per route, and a `sandbox` credential can never',
      'run a live search or reach live evidence.',
    ].join(' '),
  },
  apiKey: {
    type: 'apiKey',
    in: 'header',
    name: 'Authorization',
    description: [
      'An environment-scoped API key, sent as `Authorization: ApiKey erly_<environment>_…`.',
      'The secret is shown once at issue and stored only as a hash, so a lost key is rotated',
      'rather than recovered. Rotation invalidates the previous secret immediately, with no',
      'grace period, and both rotation and revocation are audited. A `sandbox` key can never',
      'run a live search or reach live evidence, whatever its roles say. Tenant self-service',
      'management of these keys is deferred by decision D-007; keys are provider-issued.',
    ].join(' '),
  },
};

const PARAMETERS: Record<string, SchemaObject> = {
  Limit: {
    name: 'limit',
    in: 'query',
    required: false,
    description: 'Page size. Defaults to 50.',
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  },
  Cursor: {
    name: 'cursor',
    in: 'query',
    required: false,
    description:
      'Opaque continuation token from the previous page. Clients must not construct or parse one: it encodes a stable ordering key, which is what lets a page neither duplicate nor drop items while the underlying set changes.',
    schema: { type: 'string', maxLength: 500 },
  },
  CsrfToken: {
    name: 'X-CSRF-Token',
    in: 'header',
    required: false,
    description:
      'Required for state-changing requests authenticated by the session cookie. Echoes the readable `csrf_token` cookie. Machine callers send no cookie and do not use it.',
    schema: { type: 'string' },
  },
};

function json(schemaRef: { $ref: string }, example?: unknown): SchemaObject {
  return {
    'application/json': {
      schema: schemaRef,
      ...(example === undefined ? {} : { example }),
    },
  };
}

function buildPaths(): Record<string, SchemaObject> {
  return {
    '/health/live': {
      get: {
        operationId: 'healthLive',
        tags: ['health'],
        summary: 'Liveness probe',
        description:
          'Version-neutral and unauthenticated: a load balancer cannot authenticate, and a version bump must not turn every probe into a 404 — which reads as "the service is down".',
        security: [],
        responses: {
          '200': { description: 'The process is alive.', content: json(ref('HealthStatus')) },
        },
      },
    },

    '/health/ready': {
      get: {
        operationId: 'healthReady',
        tags: ['health'],
        summary: 'Readiness probe',
        description:
          'Whether this instance will accept traffic. It deliberately does not say why not.',
        security: [],
        responses: {
          '200': { description: 'Ready for traffic.', content: json(ref('HealthStatus')) },
        },
      },
    },

    '/v1/health/dependencies': {
      get: {
        operationId: 'healthDependencies',
        tags: ['health'],
        summary: 'Dependency detail, for authorised operators',
        description:
          'Separate from the public probes because it discloses which dependency is degraded, which tells an attacker where to push. Requires `platform:read_health`.',
        responses: {
          '200': { description: 'Dependency state.', content: json(ref('DependencyHealth')) },
          '401': errorRef(401),
          '403': errorRef(403),
        },
      },
    },

    '/auth/login': {
      get: {
        operationId: 'authLogin',
        tags: ['auth'],
        summary: 'Begin the authorisation-code flow',
        description:
          'Redirects to the identity provider with PKCE (`S256`); the verifier never leaves the service. Version-neutral, because the redirect URI is registered at the provider and must not change with an API version.',
        security: [],
        responses: {
          '302': {
            description:
              'Redirect to the identity provider. Sets two short-lived handshake cookies.',
            headers: { Location: { schema: { type: 'string' } } },
          },
        },
      },
    },

    '/auth/callback': {
      get: {
        operationId: 'authCallback',
        tags: ['auth'],
        summary: 'Complete sign-in and establish the session',
        description:
          'Exchanges the authorisation code, then issues the HTTP-only session cookie and the readable CSRF cookie. A mismatched `state` is rejected.',
        security: [],
        parameters: [
          { name: 'code', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'state', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '302': {
            description: 'Signed in; redirect to the panel.',
            headers: { Location: { schema: { type: 'string' } } },
          },
          '401': errorRef(401),
        },
      },
    },

    '/auth/logout': {
      post: {
        operationId: 'authLogout',
        tags: ['auth'],
        summary: 'Revoke the session',
        description:
          'POST rather than GET: a GET logout can be fired by any page that embeds an image.',
        parameters: [{ $ref: '#/components/parameters/CsrfToken' }],
        responses: {
          '204': { description: 'Session revoked and cookies cleared.' },
          '401': errorRef(401),
          '403': errorRef(403),
        },
      },
    },

    '/auth/session': {
      get: {
        operationId: 'authSession',
        tags: ['auth'],
        summary: 'Who am I',
        description:
          'What the panel needs to render its shell. Carries no token and no session identifier.',
        responses: {
          '200': {
            description: 'The current principal.',
            content: json(ref('SessionInfo'), {
              subject: '9f2c1e40-7a5b-4c33-9e21-8d0a1b2c3d4e',
              tenantId: 'tenant_demo_cr',
              roles: ['analyst', 'reviewer'],
              environment: 'sandbox',
            }),
          },
          '401': errorRef(401),
          '403': errorRef(403),
        },
      },
    },

    '/v1/subjects': {
      post: {
        operationId: 'createSubject',
        tags: ['subjects'],
        summary: 'Create a service-owned identity snapshot (FR-01)',
        description: [
          'The full name is stored as written, in its original script, and is **never split**',
          'into given and family parts. Splitting destroys patronymic chains, mononyms and',
          'every naming system that puts the family name first — silently, at intake, before',
          'any matching can compensate. Normalised comparison forms are derived alongside the',
          'original, never in place of it.',
          '',
          'Sparse input is accepted. A missing date of birth stays missing; the subject simply',
          'remains unresolved rather than being completed by inference.',
          '',
          '`externalSubjectRef` and `externalCaseRef` are recorded for correlation only. They',
          'are neither a lookup instruction nor an authorisation credential.',
        ].join('\n'),
        parameters: [{ $ref: '#/components/parameters/CsrfToken' }],
        requestBody: {
          required: true,
          content: json(ref('CreateSubjectRequest'), {
            fullName: 'María José Rodríguez Alvarado',
            aliases: [{ name: 'María J. Rodríguez', origin: 'CUSTOMER_RECORD', language: 'es' }],
            dateOfBirth: { value: '1984-03-11', precision: 'DAY' },
            countryContext: ['CR'],
            knownCompanies: [],
            externalCaseRef: 'CASE-2026-00471',
            purpose: 'CUSTOMER_ONBOARDING',
          }),
        },
        responses: {
          '201': { description: 'The stored snapshot.', content: json(ref('SubjectVersion')) },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
          '413': errorRef(413),
          '422': errorRef(422),
        },
      },
    },

    '/v1/subjects/{subjectId}/versions/{version}': {
      get: {
        operationId: 'getSubjectVersion',
        tags: ['subjects'],
        summary: 'Read one pinned version of a subject',
        description:
          'Versions are immutable. A data update creates a new one, and a historical search keeps the version it ran against, so a past result can still be explained.',
        parameters: [
          { name: 'subjectId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
        ],
        responses: {
          '200': { description: 'The pinned version.', content: json(ref('SubjectVersion')) },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
          '404': errorRef(404),
        },
      },
    },

    '/v1/searches': {
      post: {
        operationId: 'createSearch',
        tags: ['searches'],
        summary: 'Accept a search for execution',
        description: [
          'Returns **202 Accepted** with a status URL, not a result. Returning 200 with a',
          'result-shaped body would invite a caller to read "accepted" as "completed, nothing',
          'found".',
          '',
          'Send `Idempotency-Key` to make submission safe to retry: an identical request',
          'returns the original run with **200**, a changed body under the same key returns',
          '**409**, and two concurrent identical submissions produce exactly one run.',
          '',
          'The scope in the request is what is being *asked for*. What was actually searched',
          'comes back as the coverage statement, and it may be narrower.',
        ].join('\n'),
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            description:
              'Tenant-scoped. Without it there is no duplicate protection, and the caller owns the consequences.',
            schema: { type: 'string', maxLength: 200 },
          },
          { $ref: '#/components/parameters/CsrfToken' },
        ],
        requestBody: {
          required: true,
          content: json(ref('CreateSearchRequest'), {
            subjectRef: { subjectId: 'sub_01JB8Z5R3M4Q2N7T9V0X1Y2Z3A', version: 1 },
            requestedScope: {
              jurisdictions: ['CR'],
              languages: ['es', 'en'],
              includeFormerDirectorships: false,
              fromDate: null,
            },
            environment: 'sandbox',
          }),
        },
        responses: {
          '202': {
            description: 'Accepted and queued.',
            content: json(ref('SearchAccepted'), {
              searchId: 'srch_01JB8Z5R3M4Q2N7T9V0X1Y2Z3A',
              statusUrl: '/v1/searches/srch_01JB8Z5R3M4Q2N7T9V0X1Y2Z3A',
              execution: 'QUEUED',
            }),
          },
          '200': {
            description:
              'Idempotent replay: this exact request was already accepted, and this is the original run.',
            content: json(ref('SearchAccepted')),
          },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
          '409': errorRef(409),
          '413': errorRef(413),
          '422': errorRef(422),
          '429': errorRef(429),
        },
      },
      get: {
        operationId: 'listSearches',
        tags: ['searches'],
        summary: "List searches for the caller's tenant",
        parameters: [
          { $ref: '#/components/parameters/Limit' },
          { $ref: '#/components/parameters/Cursor' },
        ],
        responses: {
          '200': { description: 'One page of searches.', content: json(ref('SearchPage')) },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
        },
      },
    },

    '/v1/searches/{searchId}': {
      get: {
        operationId: 'getSearch',
        tags: ['searches'],
        summary: 'Read a search and its three result dimensions',
        description: [
          '`execution`, `findings` and `coverage` are independent and must be read together.',
          '`SUCCEEDED` with `NO_MATCHES_FOUND` and `INCOMPLETE` coverage means the run',
          'finished, found nothing, **and did not search everything it promised** — which is',
          'not a clean result, and must never be presented as one.',
          '',
          '`progress` never carries a fabricated percentage: it reports stages completed and',
          'the cascade rung reached, or nothing.',
        ].join('\n'),
        parameters: [{ name: 'searchId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description:
              'The search. The `ETag` header carries the current revision; quote it in ' +
              '`If-Match` on any action that changes the run.',
            headers: {
              ETag: {
                description: 'The current revision, quoted. Send back as `If-Match`.',
                schema: { type: 'string' },
              },
            },
            content: json(ref('SearchSummary')),
          },
          '401': errorRef(401),
          '403': errorRef(403),
          '404': errorRef(404),
        },
      },
    },

    '/v1/searches/{searchId}/cancel': {
      post: {
        operationId: 'cancelSearch',
        tags: ['searches'],
        summary: 'Cancel a search that is still running',
        description: [
          'Requires `If-Match` carrying the revision the caller last read. Without it the',
          'request is rejected: a cancellation issued against a run whose state has since',
          'changed is a decision made on information that is no longer true.',
          '',
          'A stale `If-Match` returns **409** with a `conflict` object carrying the current',
          'revision and the current execution state, so the caller can see what changed and',
          're-submit deliberately rather than retrying blindly.',
          '',
          'Cancellation is **final and does not rewrite history**. Stages that had already',
          'succeeded stay succeeded, and a worker that completes after the cancellation has',
          'its result discarded rather than applied — the run is not re-opened by work that',
          'arrives late.',
          '',
          'Cancelling an already-terminal run returns **409 `ALREADY_TERMINAL`**, not a',
          'silent success. "Nothing to do" and "done" are different answers.',
        ].join('\n'),
        parameters: [
          { name: 'searchId', in: 'path', required: true, schema: { type: 'string' } },
          {
            name: 'If-Match',
            in: 'header',
            required: true,
            description: 'The revision from the last read, as returned in `ETag`.',
            schema: { type: 'string' },
          },
          { $ref: '#/components/parameters/CsrfToken' },
        ],
        requestBody: {
          required: true,
          content: json(ref('CancelSearchRequest'), {
            reason: 'Requested by the client; screening no longer required.',
          }),
        },
        responses: {
          '200': {
            description: 'Cancelled. The run is terminal and its revision has advanced.',
            content: json(ref('SearchSummary')),
          },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
          '404': errorRef(404),
          '409': {
            description:
              'Either the revision was stale (`REVISION_CONFLICT`, with a `conflict` object ' +
              'naming the current revision and state) or the run is already terminal ' +
              '(`ALREADY_TERMINAL`).',
            content: json(ref('ApiError')),
          },
          '422': errorRef(422),
        },
      },
    },

    ...reservedPath(
      '/v1/admin/plans',
      'reservedAdminPlans',
      'Plan management is deferred by decision D-007. This phase builds entitlement seams only.',
    ),
    ...reservedPath(
      '/v1/admin/tenants/{tenantId}/usage',
      'reservedAdminTenantUsage',
      'Usage metering is deferred by decision D-007. Counters are recorded but not yet exposed or billed.',
      [{ name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } }],
    ),
    ...reservedPath(
      '/v1/tenant/usage',
      'reservedTenantUsage',
      'Tenant usage reporting is deferred by decision D-007.',
    ),
    ...reservedPath(
      '/v1/tenant/api-keys',
      'reservedTenantApiKeys',
      'Tenant self-service key management is deferred by decision D-007. Keys are provider-managed in this phase.',
    ),
  };
}

/**
 * A reserved FR-15 route.
 *
 * Documented rather than hidden: an integrator who gets a 404 concludes they have the path
 * wrong and goes looking for the right one. A 501 with a reason tells them the truth — this
 * exists, it is not built yet, and here is the decision that says so.
 *
 * The controller answers every method with `@All`. GET and POST are listed because those are
 * the two anyone would try, and the route-coverage test counts the path as documented.
 */
function reservedPath(
  path: string,
  operationId: string,
  reason: string,
  parameters: SchemaObject[] = [],
): Record<string, SchemaObject> {
  const operation = (suffix: string): SchemaObject => ({
    operationId: `${operationId}${suffix}`,
    tags: ['reserved'],
    summary: 'Reserved — not implemented',
    description: reason,
    ...(parameters.length > 0 ? { parameters } : {}),
    responses: { '401': errorRef(401), '403': errorRef(403), '501': errorRef(501) },
  });

  return { [path]: { get: operation('Get'), post: operation('Post') } };
}
