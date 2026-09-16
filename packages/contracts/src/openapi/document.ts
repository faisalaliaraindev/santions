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

function json(schemaRef: { $ref: string } | SchemaObject, example?: unknown): SchemaObject {
  return {
    'application/json': {
      schema: schemaRef,
      ...(example === undefined ? {} : { example }),
    },
  };
}

/** The three path parameters every version-scoped admin route carries. */
function adminVersionParameters(): Record<string, unknown>[] {
  return [
    {
      name: 'collection',
      in: 'path',
      required: true,
      schema: { type: 'string', enum: ['sources', 'taxonomy', 'policies'] },
    },
    { name: 'recordId', in: 'path', required: true, schema: { type: 'string' } },
    { name: 'version', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
  ];
}

/** `If-Match` is required on every state-changing admin call, as it is on cancellation. */
function ifMatchParameter(): Record<string, unknown> {
  return {
    name: 'If-Match',
    in: 'header',
    required: true,
    description: 'The revision from the last read, as returned in `ETag`.',
    schema: { type: 'string' },
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

    '/v1/searches/{searchId}/findings': {
      get: {
        operationId: 'getSearchFindings',
        tags: ['searches'],
        summary: 'Read what a search produced, and what it could not',
        description: [
          'Returns the findings **together with the three result dimensions**. That pairing is',
          'deliberate: a client that reads findings alone cannot tell a genuinely clean run',
          'from one in which every source was blocked, because both return an empty array.',
          '',
          'A `band` is never a score and never arrives alone — `axes` and `rationale` travel',
          'with it, because FR-08 requires the four contributing values be retained verbatim',
          'and FR-13 requires the reviewer be able to see why. There is no numeric risk score',
          'anywhere in this response, by design (invariant I9).',
          '',
          '`rejectedLeads` are candidates that were found and **not** promoted, each with its',
          'reason. They are returned rather than discarded because a pipeline that silently',
          'drops what it decided against cannot be audited (FR-06).',
          '',
          'When there are no findings, `noMatchStatement` is present and names what was',
          'searched, what was not, and what that does and does not mean. It never says',
          '"clear", "clean" or "no adverse media".',
          '',
          '`mode: "MOCK"` means every record came from fixture data and no live source was',
          'contacted. It is never servable as a live result.',
        ].join('\n'),
        parameters: [{ name: 'searchId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'The findings, the rejected leads, and the coverage they sit inside.',
            content: json(ref('FindingsPage')),
          },
          '401': errorRef(401),
          '403': errorRef(403),
          '404': errorRef(404),
        },
      },
    },

    '/v1/searches/{searchId}/associations': {
      get: {
        operationId: 'getSearchAssociations',
        tags: ['searches'],
        summary: 'Read the frozen FR-02 association graph for a search',
        description: [
          'The graph **as it was when the search ran**, not a fresh look at the register.',
          'A registry correction next month must not rewrite what a historical search',
          'explained, so a refresh produces a new snapshot linked to this one rather than',
          'mutating it.',
          '',
          'Three things here are routinely misread and are therefore separate fields.',
          '',
          'A `coverage.outcome` of `UNKNOWN` means **no approved register covers the',
          'jurisdiction, so none was asked**. It is not a worse `INCOMPLETE`, and neither',
          'value ever means no associations exist.',
          '',
          '`unresolvedCandidates` are people of the same name the graph could **not**',
          'attribute to the subject. They are returned rather than hidden, so a reviewer can',
          'see that the register held more than one such person. They are not findings.',
          '',
          '`edges[].attachesCompany` is the only field that says whether an edge may anchor',
          'a company query. An edge can be resolved and still out of scope, so it is stated',
          'rather than left to each consumer to recompute differently.',
        ].join('\n'),
        parameters: [{ name: 'searchId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'The frozen association snapshot.',
            content: json(ref('AssociationGraph')),
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

    '/v1/admin/{collection}': {
      post: {
        operationId: 'proposeVersion',
        tags: ['admin'],
        summary: 'Propose a new version of a source, taxonomy or policy',
        description: [
          '`collection` is one of `sources`, `taxonomy` or `policies`. All three share one',
          'lifecycle: **PROPOSED -> AWAITING_APPROVAL -> APPROVED -> ACTIVATING -> ACTIVE**,',
          'with `SUSPENDED`, `SUPERSEDED` and `RETIRED` alongside it.',
          '',
          'A proposal is always the *next* version. A version past `PROPOSED` is immutable, so',
          'changing an active source means proposing its successor - which is what lets a',
          'historical search still explain itself under the version it actually ran on.',
          '',
          'Taxonomy and policy versions are identified by the calling **tenant**; a source is',
          'identified by its `recordId`, and source configuration is shared across tenants.',
        ].join('\n'),
        parameters: [
          {
            name: 'collection',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['sources', 'taxonomy', 'policies'] },
          },
          { $ref: '#/components/parameters/CsrfToken' },
        ],
        requestBody: { required: true, content: json(ref('ProposeVersionRequest')) },
        responses: {
          '201': { description: 'Proposed.', content: json(ref('VersionSummary')) },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
          '404': errorRef(404),
        },
      },
      get: {
        operationId: 'listVersions',
        tags: ['admin'],
        summary: 'List versions',
        parameters: [
          {
            name: 'collection',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['sources', 'taxonomy', 'policies'] },
          },
          { name: 'recordId', in: 'query', required: false, schema: { type: 'string' } },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        ],
        responses: {
          '200': {
            description: 'Versions, newest first within each record.',
            content: json({
              type: 'object',
              properties: { items: { type: 'array', items: ref('VersionSummary') } },
              required: ['items'],
            }),
          },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
          '404': errorRef(404),
        },
      },
    },

    '/v1/admin/{collection}/{recordId}/versions/{version}': {
      get: {
        operationId: 'getVersion',
        tags: ['admin'],
        summary: 'Read one version',
        description:
          'Returns the revision as an `ETag`. Every state-changing admin call requires it in ' +
          '`If-Match`, so an administrative decision cannot be taken on state the caller has ' +
          'not seen.',
        parameters: adminVersionParameters(),
        responses: {
          '200': { description: 'The version.', content: json(ref('VersionSummary')) },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
          '404': errorRef(404),
        },
      },
      put: {
        operationId: 'updateDraft',
        tags: ['admin'],
        summary: 'Edit a draft',
        description:
          'Permitted only while `PROPOSED`. Once submitted, content is frozen - otherwise the ' +
          'approver approves one thing and a different thing activates.',
        parameters: [
          ...adminVersionParameters(),
          ifMatchParameter(),
          { $ref: '#/components/parameters/CsrfToken' },
        ],
        requestBody: { required: true, content: json(ref('UpdateDraftRequest')) },
        responses: {
          '200': { description: 'Updated.', content: json(ref('VersionSummary')) },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
          '404': errorRef(404),
          '409': errorRef(409),
        },
      },
    },

    '/v1/admin/{collection}/{recordId}/versions/{version}/transitions': {
      post: {
        operationId: 'transitionVersion',
        tags: ['admin'],
        summary: 'Submit, approve, request changes, suspend, restore or retire',
        description: [
          '**Four eyes.** `APPROVE`, `REQUEST_CHANGES` and `RESTORE` must be performed by a',
          'different authorised user from the one who proposed the version (section 4.2, test',
          'T45). The refusal is recorded in the audit trail, not only returned as a 403.',
          '',
          '**Suspension is deliberately asymmetric.** `SUSPEND` needs no second person -',
          'requiring one to *stop* using a source is how a harmful source stays live over a',
          'weekend. `RESTORE` needs both a second person and a fresh rights clearance, and',
          'lands in `ACTIVATING` rather than going straight back to `ACTIVE`.',
          '',
          'A reason is required for every action except `SUBMIT`, and is recorded (SEC-06).',
        ].join('\n'),
        parameters: [
          ...adminVersionParameters(),
          ifMatchParameter(),
          { $ref: '#/components/parameters/CsrfToken' },
        ],
        requestBody: { required: true, content: json(ref('LifecycleTransitionRequest')) },
        responses: {
          '200': { description: 'Applied.', content: json(ref('VersionSummary')) },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
          '404': errorRef(404),
          '409': errorRef(409),
        },
      },
    },

    '/v1/admin/{collection}/{recordId}/versions/{version}/activate': {
      post: {
        operationId: 'activateVersion',
        tags: ['admin'],
        summary: 'Activate an approved version, through the SEC-05 rights gate',
        description: [
          'Activation is two steps: `APPROVED -> ACTIVATING`, then the rights clearance, then',
          '`ACTIVATING -> ACTIVE`. The clearance is stored on the version either way.',
          '',
          'Returns **200 with the clearance whether or not it passed**, rather than a 403 on',
          'refusal. A refusal is a result the administrator has to read - which operation,',
          'which reason code, which policy - and an error body carrying one message would lose',
          'exactly that. Read `activated` and the version `status` for what happened: `ACTIVE`,',
          'or back to `APPROVED` with the clearance attached.',
          '',
          'A `DENY` is never upgraded by an approval reference: a prohibited collection method',
          '- a CAPTCHA, a login wall, a paywall - cannot be licensed by anyone.',
        ].join('\n'),
        parameters: [
          ...adminVersionParameters(),
          ifMatchParameter(),
          { $ref: '#/components/parameters/CsrfToken' },
        ],
        responses: {
          '200': {
            description: 'The activation attempt and its clearance.',
            content: json({
              type: 'object',
              properties: {
                version: ref('VersionSummary'),
                clearance: ref('RightsClearance'),
                activated: { type: 'boolean' },
              },
              required: ['version', 'clearance', 'activated'],
            }),
          },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
          '404': errorRef(404),
          '409': errorRef(409),
        },
      },
    },

    '/v1/admin/coverage/{jurisdiction}': {
      get: {
        operationId: 'getCoverage',
        tags: ['admin'],
        summary: 'What this service can and cannot do in a jurisdiction',
        description: [
          'Every capability carries a status - `SUPPORTED`, `PARTIAL`, `UNKNOWN` or',
          '`UNSUPPORTED` - and an `emptyResultMeans` field saying what an empty result from it',
          'may be called. **Only `SUPPORTED` yields `NO_FINDINGS`**; everything else yields',
          '`NOT_ESTABLISHED`, and must never be rendered as a clean result.',
          '',
          '`UNKNOWN` and `UNSUPPORTED` are not the same. `UNSUPPORTED` is a finished',
          'investigation - there is no way to do this here. `UNKNOWN` is an unfinished one.',
          '',
          'Readable by anyone holding `coverage:read`, including an auditor. What the service',
          'cannot do is not a secret; hiding it is how a reviewer comes to believe an empty',
          'result was a search.',
        ].join('\n'),
        parameters: [
          {
            name: 'jurisdiction',
            in: 'path',
            required: true,
            schema: { type: 'string', minLength: 2, maxLength: 2 },
          },
        ],
        responses: {
          '200': {
            description: 'The coverage statement.',
            content: json(ref('CoverageStatement')),
          },
          '401': errorRef(401),
          '403': errorRef(403),
        },
      },
    },

    '/v1/admin/coverage': {
      put: {
        operationId: 'declareCoverage',
        tags: ['admin'],
        summary: 'Declare or revise a capability coverage status',
        description:
          'A coverage status is an assertion about what this product can do in a country, and ' +
          'it reaches a reviewer unmediated - so it needs `source:approve`, not merely ' +
          '`source:propose`, and it records who declared it and what evidence it rests on.',
        parameters: [{ $ref: '#/components/parameters/CsrfToken' }],
        requestBody: { required: true, content: json(ref('DeclareCapabilityRequest')) },
        responses: {
          '200': {
            description: 'The revised coverage statement for that jurisdiction.',
            content: json(ref('CoverageStatement')),
          },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
        },
      },
    },

    '/v1/admin/source-health': {
      get: {
        operationId: 'getSourceHealth',
        tags: ['admin'],
        summary: 'Breaker state, budget spend and kill switch, per source',
        description: [
          'Source health is a **separate mutable document** from the approved source version,',
          'and the separation is visible here: this response carries no approved field, and',
          '`SourceContent` carries no observation. The approved version says what is',
          '*permitted*; health says what is *happening*.',
          '',
          'Needs `platform:read_health`, which `platform_operator` holds and which grants no',
          'access to a single customer finding. Breaker state and budget spend are properties',
          'of the publisher, not of anybody customer data - an operator must be able to see',
          'them without being handed evidence access to do it.',
        ].join('\n'),
        responses: {
          '200': {
            description: 'Every source this service has observed.',
            content: json({
              type: 'object',
              required: ['sources'],
              properties: { sources: { type: 'array', items: ref('SourceHealth') } },
            }),
          },
          '401': errorRef(401),
          '403': errorRef(403),
        },
      },
    },

    '/v1/admin/sources/{sourceId}/kill-switch': {
      post: {
        operationId: 'engageSourceKillSwitch',
        tags: ['admin'],
        summary: 'Stop using a source, immediately and across every in-flight run',
        description: [
          '**Effective mid-run.** The pipeline rechecks source access immediately before each',
          'call it makes, so a run that started an hour ago stops using this source on its very',
          'next request. Checking only at plan time would mean a source suspended for a rights',
          'violation kept being fetched for the length of every in-flight run.',
          '',
          'Blocked work is **recorded as a coverage gap naming the suspension**, never silently',
          'skipped: a run that quietly consulted one fewer source reads to a reviewer as a clean',
          'result from a search that was never made.',
          '',
          'One person, deliberately. Stopping a source is the safe direction, and requiring a',
          'second approver to stop fetching from a publisher who has just complained means the',
          'fetching continues while the second approver is found. Releasing needs four eyes.',
          '',
          'Results already produced are **not** deleted. A later read of them shows that the',
          'source has since been suspended (`sourceSuspendedSince` on the finding document, and',
          '`sinceSuspendedSources` on the findings page).',
        ].join('\n'),
        parameters: [
          { name: 'sourceId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/CsrfToken' },
        ],
        requestBody: { required: true, content: json(ref('KillSwitchRequest')) },
        responses: {
          '200': { description: 'The suspended source.', content: json(ref('SourceHealth')) },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
          '409': errorRef(409),
        },
      },
    },

    '/v1/admin/sources/{sourceId}/kill-switch/release': {
      post: {
        operationId: 'releaseSourceKillSwitch',
        tags: ['admin'],
        summary: 'Resume using a suspended source (four eyes)',
        description:
          'The releaser must not be the person who engaged the switch. A source is normally ' +
          'suspended because somebody believes we should not be fetching it, and the person ' +
          'who formed that belief is the wrong person to decide unilaterally that it no longer ' +
          'holds. Releasing also closes the breaker, whose accumulated failures describe the ' +
          'suspension rather than the source.',
        parameters: [
          { name: 'sourceId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/CsrfToken' },
        ],
        requestBody: { required: true, content: json(ref('KillSwitchRequest')) },
        responses: {
          '200': { description: 'The released source.', content: json(ref('SourceHealth')) },
          '400': errorRef(400),
          '401': errorRef(401),
          '403': errorRef(403),
          '409': errorRef(409),
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
    '/v1/tenant/api-keys': {
      post: {
        tags: ['Tenant'],
        operationId: 'createApiKey',
        summary: 'Issue an API key for your own tenant',
        description:
          'Self-service issuance (decision **D-050**, replacing the deferral in D-007).\n\n' +
          'The `secret` in the response is shown **once** and is not recoverable: only a hash ' +
          'is stored, so no endpoint can return it again and no support process can recover it.\n\n' +
          'Three limits apply, and each is a rule rather than an oversight:\n\n' +
          '- a key can carry only roles **you already hold**;\n' +
          '- the tenant comes from your credential and can never be sent in the body;\n' +
          '- an `environment: "live"` key requires your tenant to be entitled to live **and** ' +
          'your own credential to be live. Entitlement is sold by the provider; self-service ' +
          'issues within what was sold.\n\n' +
          'Requires the `apikey:manage` permission, which `tenant_admin` holds.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('CreateApiKeyRequest') } },
        },
        responses: {
          '201': {
            description: 'The key, including the only copy of its secret you will ever receive.',
            content: { 'application/json': { schema: ref('IssuedApiKey') } },
          },
          '401': errorRef(401),
          '403': errorRef(403),
          '422': errorRef(422),
        },
      },
      get: {
        tags: ['Tenant'],
        operationId: 'listApiKeys',
        summary: "List your tenant's API keys",
        description:
          'Every key this tenant holds, with no secret and no hash of one. `status` is derived ' +
          'at read time rather than stored, so a key whose expiry passed while nothing was ' +
          'running still reads as `EXPIRED`.\n\n' +
          '`status` names one reason a key is unusable, ordered by what you would have to do ' +
          'about it: `REVOKED` and `EXPIRED` mean issue a new one, `DISABLED` means enable it. ' +
          'A key that was disabled and has since expired therefore reads `EXPIRED`, with ' +
          '`disabledAt` still set to say it was also paused.',
        responses: {
          '401': errorRef(401),
          '403': errorRef(403),
          '200': {
            description: 'The keys.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['items'],
                  properties: { items: { type: 'array', items: ref('ApiKeySummary') } },
                },
              },
            },
          },
        },
      },
    },
    '/v1/tenant/api-keys/{keyId}': {
      delete: {
        tags: ['Tenant'],
        operationId: 'revokeApiKey',
        summary: 'Revoke one of your keys',
        description:
          'Immediate and irreversible. The reason is mandatory and is written to the audit ' +
          'trail.\n\nA key belonging to another tenant answers **404**, not 403 — the second ' +
          'would confirm that it exists.',
        parameters: [{ name: 'keyId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('RevokeApiKeyRequest') } },
        },
        responses: {
          '200': {
            description: 'Revoked.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['keyId', 'revoked'],
                  properties: {
                    keyId: { type: 'string' },
                    revoked: { type: 'boolean', enum: [true] },
                  },
                },
              },
            },
          },
          '401': errorRef(401),
          '403': errorRef(403),
          '404': errorRef(404),
        },
      },
    },
    '/v1/tenant/api-keys/{keyId}/disable': {
      post: {
        tags: ['Tenant'],
        operationId: 'disableApiKey',
        summary: 'Switch one of your keys off, reversibly',
        description:
          'The key stops authenticating immediately, and `POST .../enable` brings it back with ' +
          'the same secret and the same key id.\n\n' +
          '**This is not the one to use for a leaked secret.** Anything reversible is the wrong ' +
          'answer to a credential somebody else now holds — use `DELETE`, which is permanent. ' +
          'Disabling is for a paused integration, a rotation window, or a key you want out of ' +
          'service while a question is answered.\n\n' +
          'Idempotent: disabling an already-disabled key succeeds and writes no second audit ' +
          'entry. A **revoked** key answers `409 ALREADY_TERMINAL` — revocation cannot be ' +
          'undone, and accepting this call would suggest it could.\n\n' +
          'The reason is mandatory and is audited with the actor. A key belonging to another ' +
          'tenant answers **404**, not 403.',
        parameters: [{ name: 'keyId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('DisableApiKeyRequest') } },
        },
        responses: {
          '200': {
            description: 'Disabled. The key is refused until it is enabled again.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['keyId', 'disabled'],
                  properties: {
                    keyId: { type: 'string' },
                    disabled: { type: 'boolean', enum: [true] },
                  },
                },
              },
            },
          },
          '401': errorRef(401),
          '403': errorRef(403),
          '404': errorRef(404),
          '409': errorRef(409),
        },
      },
    },
    '/v1/tenant/api-keys/{keyId}/enable': {
      post: {
        tags: ['Tenant'],
        operationId: 'enableApiKey',
        summary: 'Turn a disabled key back on',
        description:
          'The same secret works again the moment this returns — nothing is re-issued and the ' +
          'key id does not change, so a tenant configuration that still holds it needs no edit.' +
          '\n\nIdempotent on a key that is already on. A **revoked** key answers ' +
          '`409 ALREADY_TERMINAL`: `revokedAt` is one-way and this route cannot touch it.\n\n' +
          'An expired key can be enabled, and will still be refused — expiry is a different ' +
          'reason, and the listing reports it as `EXPIRED` rather than `DISABLED`.',
        parameters: [{ name: 'keyId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('EnableApiKeyRequest') } },
        },
        responses: {
          '200': {
            description: 'Enabled.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['keyId', 'disabled'],
                  properties: {
                    keyId: { type: 'string' },
                    disabled: { type: 'boolean', enum: [false] },
                  },
                },
              },
            },
          },
          '401': errorRef(401),
          '403': errorRef(403),
          '404': errorRef(404),
          '409': errorRef(409),
        },
      },
    },
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
