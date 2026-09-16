/**
 * The OpenAPI component schemas, derived from the zod schemas rather than written by hand.
 *
 * Hand-written OpenAPI drifts from the code that validates the request. Here the zod schema
 * is the single definition: the API validates with it, the document is generated from it, and
 * the panel's client is generated from the document. A field cannot be added to the contract
 * without appearing in all three.
 *
 * Target is OpenAPI 3.0 rather than 3.1 because that is what the generator emits faithfully —
 * notably `nullable: true` rather than a union with `null`. A nullable field that generates
 * as non-nullable is exactly the kind of silent contract lie this file exists to prevent.
 */

import { z } from 'zod';

import {
  apiKeySummarySchema,
  createApiKeySchema,
  issuedApiKeySchema,
  revokeApiKeySchema,
} from '../tenancy/api-keys.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { apiErrorSchema, ERROR_CODES, ERROR_STATUS, type ErrorCode } from '../errors/errors.js';
import { sessionInfoSchema } from '../auth/session.js';
import { dependencyHealthSchema, healthStatusSchema } from '../common/health.js';
import { pageSchema } from '../common/pagination.js';
import {
  aliasOriginSchema,
  aliasSchema,
  companyIdentifierSchema,
  createSubjectSchema,
  datePrecisionSchema,
  nameFrequencyPriorSchema,
  preciseDateSchema,
  screeningPurposeSchema,
  subjectVersionSchema,
} from '../subjects/subject.js';
import {
  coverageStatementSchema,
  declareCapabilitySchema,
  killSwitchSchema,
  lifecycleTransitionSchema,
  proposeVersionSchema,
  rightsClearanceSchema,
  sourceContentSchema,
  sourceHealthSchema,
  updateDraftSchema,
  versionSummarySchema,
} from '../admin/admin.js';
import {
  cancelSearchSchema,
  coverageStateSchema,
  createSearchSchema,
  executionStateSchema,
  findingsStateSchema,
  searchAcceptedSchema,
  searchSummarySchema,
} from '../searches/search.js';
import {
  associationCoverageSchema,
  associationEdgeSchema,
  associationGraphSchema,
  currencyStateSchema,
  identityFactorSchema,
  resolutionStatusSchema,
  tenureLabelSchema,
  unresolvedCandidateSchema,
} from '../searches/associations.js';
import {
  evidenceBandSchema,
  findingSchema,
  findingsPageSchema,
  rejectedLeadSchema,
} from '../searches/findings.js';

/** A JSON Schema fragment. Structural on purpose — this is document data, not domain data. */
export type SchemaObject = Record<string, unknown>;

/**
 * Every schema that becomes a named component.
 *
 * Enums are registered as well as objects. An inlined enum generates as a bare string union
 * at every use site, which reads fine until the panel needs to name the type in a function
 * signature and has nothing to import.
 */
export const COMPONENT_SCHEMAS = {
  ApiError: apiErrorSchema,

  DatePrecision: datePrecisionSchema,
  PreciseDate: preciseDateSchema,
  AliasOrigin: aliasOriginSchema,
  Alias: aliasSchema,
  CompanyIdentifier: companyIdentifierSchema,
  ScreeningPurpose: screeningPurposeSchema,
  NameFrequencyPrior: nameFrequencyPriorSchema,
  CreateApiKeyRequest: createApiKeySchema,
  IssuedApiKey: issuedApiKeySchema,
  ApiKeySummary: apiKeySummarySchema,
  RevokeApiKeyRequest: revokeApiKeySchema,
  CreateSubjectRequest: createSubjectSchema,
  SubjectVersion: subjectVersionSchema,

  ExecutionState: executionStateSchema,
  FindingsState: findingsStateSchema,
  CoverageState: coverageStateSchema,
  CreateSearchRequest: createSearchSchema,
  CancelSearchRequest: cancelSearchSchema,
  SearchAccepted: searchAcceptedSchema,
  SearchSummary: searchSummarySchema,
  SearchPage: pageSchema(searchSummarySchema),

  ResolutionStatus: resolutionStatusSchema,
  CurrencyState: currencyStateSchema,
  TenureLabel: tenureLabelSchema,
  AssociationCoverage: associationCoverageSchema,
  IdentityFactor: identityFactorSchema,
  AssociationEdge: associationEdgeSchema,
  UnresolvedOfficerCandidate: unresolvedCandidateSchema,
  AssociationGraph: associationGraphSchema,

  EvidenceBand: evidenceBandSchema,
  Finding: findingSchema,
  RejectedLead: rejectedLeadSchema,
  FindingsPage: findingsPageSchema,

  ProposeVersionRequest: proposeVersionSchema,
  UpdateDraftRequest: updateDraftSchema,
  LifecycleTransitionRequest: lifecycleTransitionSchema,
  SourceContent: sourceContentSchema,
  RightsClearance: rightsClearanceSchema,
  VersionSummary: versionSummarySchema,
  CoverageStatement: coverageStatementSchema,
  DeclareCapabilityRequest: declareCapabilitySchema,
  SourceHealth: sourceHealthSchema,
  KillSwitchRequest: killSwitchSchema,

  SessionInfo: sessionInfoSchema,
  HealthStatus: healthStatusSchema,
  DependencyHealth: dependencyHealthSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

export type ComponentSchemaName = keyof typeof COMPONENT_SCHEMAS;

const DEFINITION_PATH = 'components/schemas';

/** `#/components/schemas/X`, in one place so a rename cannot half-apply. */
export function ref(name: ComponentSchemaName): { $ref: string } {
  return { $ref: `#/${DEFINITION_PATH}/${name}` };
}

/**
 * Convert the registry in a single pass.
 *
 * One pass matters: converting each schema separately would inline shared sub-schemas into
 * every parent instead of referencing the shared component, and `Alias` would exist three
 * times with three names.
 */
export function buildComponentSchemas(): Record<string, SchemaObject> {
  // The root is a throwaway — only the definitions it carries are wanted.
  const converted = zodToJsonSchema(z.unknown(), {
    definitions: COMPONENT_SCHEMAS,
    definitionPath: DEFINITION_PATH,
    target: 'openApi3',
    $refStrategy: 'root',
  }) as unknown as Record<string, Record<string, SchemaObject> | undefined>;

  const schemas = converted[DEFINITION_PATH];
  if (schemas === undefined) {
    throw new Error('Schema conversion produced no definitions. The generator contract changed.');
  }
  return schemas;
}

/**
 * The error responses, one per status, built from the single `ERROR_STATUS` mapping.
 *
 * Generating them from that mapping rather than listing them by hand is what keeps the
 * document honest: a new error code cannot document itself under the wrong status, because
 * nobody chooses the status here.
 */
export function buildErrorResponses(): Record<string, SchemaObject> {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of ERROR_CODES) {
    const status = ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }

  const responses: Record<string, SchemaObject> = {};
  for (const [status, codes] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
    const first = codes[0];
    if (first === undefined) continue;
    responses[errorResponseName(status)] = {
      description: `${ERROR_STATUS_DESCRIPTION[status] ?? 'Error'} Possible codes: ${codes.join(', ')}.`,
      content: {
        'application/json': {
          schema: ref('ApiError'),
          example: {
            code: first,
            message: EXAMPLE_MESSAGE[first] ?? 'The request could not be completed.',
            correlationId: '01JB8Z5R3M4Q2N7T9V0X1Y2Z3A',
            retryable: status === 429 || status === 500,
          },
        },
      },
    };
  }
  return responses;
}

/** `#/components/responses/X` for a status, so routes reference rather than repeat. */
export function errorRef(status: number): { $ref: string } {
  return { $ref: `#/components/responses/${errorResponseName(status)}` };
}

function errorResponseName(status: number): string {
  return `Error${String(status)}`;
}

const ERROR_STATUS_DESCRIPTION: Readonly<Record<number, string>> = {
  400: 'The request body or query is malformed, or carries an unknown field.',
  401: 'No valid credential. The session may have expired.',
  403: 'Authenticated, but not permitted. An entitlement denial is reported here and is never retryable (REL-02).',
  404: 'Not found. Deliberately indistinguishable from an unauthorised read, so IDs cannot be enumerated.',
  409: 'Conflict: a stale revision, or an idempotency key reused with a different body.',
  413: 'The request exceeds a documented input bound.',
  422: 'The request is well-formed but the scope or policy it asks for is not valid.',
  429: 'Throttled. This is not an entitlement denial and not a coverage gap.',
  500: 'Unexpected failure. The body never carries internal detail (SEC-04).',
  501: 'A reserved endpoint that is documented but deliberately not implemented.',
};

const EXAMPLE_MESSAGE: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'The request body failed validation.',
  UNAUTHENTICATED: 'Authentication is required.',
  FORBIDDEN: 'Access denied.',
  NOT_FOUND: 'Search not found.',
  REVISION_CONFLICT: 'The record changed since it was read. Re-read it and retry.',
  PAYLOAD_TOO_LARGE: 'The request exceeds the 256 kB body limit.',
  INVALID_SCOPE: 'The requested scope includes a jurisdiction that is not enabled.',
  RATE_LIMITED: 'Too many requests. Retry after the interval in the Retry-After header.',
  INTERNAL: 'The request could not be completed.',
  NOT_IMPLEMENTED: 'This endpoint is reserved and not implemented in this release.',
};
