/**
 * GENERATED FILE — do not edit.
 *
 * Produced by `pnpm api:generate` from the backend's OpenAPI document. To change it, edit
 * the contract schemas in the backend (`packages/contracts`), regenerate, and commit the
 * diff.
 */

import { apiRequest } from '../client';
import type { RequestOptions } from '../client';
import type { paths } from './schema';

/** Per-call options. Everything else — credentials, CSRF, error typing — is the transport's. */
export interface OperationOptions {
  readonly signal?: AbortSignal;
  /**
   * FR-12. Send it on a submission that must be safe to retry: an identical request returns
   * the original operation, and a changed body under the same key returns 409.
   */
  readonly idempotencyKey?: string;
}

function request(
  operation: OperationOptions | undefined,
  base: Partial<RequestOptions>,
): RequestOptions {
  return {
    ...base,
    ...(operation?.signal === undefined ? {} : { signal: operation.signal }),
    ...(operation?.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: operation.idempotencyKey }),
  };
}

function queryString(query: Record<string, unknown> | undefined): string {
  if (query === undefined) return '';

  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) parameters.append(key, String(entry));
    } else {
      parameters.append(key, String(value));
    }
  }

  const serialised = parameters.toString();
  return serialised === '' ? '' : `?${serialised}`;
}

/**
 * Revoke the session
 *
 * POST rather than GET: a GET logout can be fired by any page that embeds an image.
 */
export async function authLogout(operation?: OperationOptions): Promise<void> {
  return apiRequest<void>(`/auth/logout`, request(operation, { method: 'POST', basePath: '' }));
}

export type AuthSessionResponse =
  paths['/auth/session']['get']['responses'][200]['content']['application/json'];
/**
 * Who am I
 *
 * What the panel needs to render its shell. Carries no token and no session identifier.
 */
export async function authSession(operation?: OperationOptions): Promise<AuthSessionResponse> {
  return apiRequest<AuthSessionResponse>(
    `/auth/session`,
    request(operation, { method: 'GET', basePath: '' }),
  );
}

export type CreateSearchBody = NonNullable<
  paths['/v1/searches']['post']['requestBody']
>['content']['application/json'];
export type CreateSearchResponse =
  paths['/v1/searches']['post']['responses'][202]['content']['application/json'];
export interface CreateSearchRequest {
  readonly body: CreateSearchBody;
}
/**
 * Accept a search for execution
 *
 * Returns **202 Accepted** with a status URL, not a result. Returning 200 with a
 * result-shaped body would invite a caller to read "accepted" as "completed, nothing
 * found".
 *
 * Send `Idempotency-Key` to make submission safe to retry: an identical request
 * returns the original run with **200**, a changed body under the same key returns
 * **409**, and two concurrent identical submissions produce exactly one run.
 *
 * The scope in the request is what is being *asked for*. What was actually searched
 * comes back as the coverage statement, and it may be narrower.
 */
export async function createSearch(
  input: CreateSearchRequest,
  operation?: OperationOptions,
): Promise<CreateSearchResponse> {
  return apiRequest<CreateSearchResponse>(
    `/searches`,
    request(operation, { method: 'POST', body: input.body }),
  );
}

export type CreateSubjectBody = NonNullable<
  paths['/v1/subjects']['post']['requestBody']
>['content']['application/json'];
export type CreateSubjectResponse =
  paths['/v1/subjects']['post']['responses'][201]['content']['application/json'];
export interface CreateSubjectRequest {
  readonly body: CreateSubjectBody;
}
/**
 * Create a service-owned identity snapshot (FR-01)
 *
 * The full name is stored as written, in its original script, and is **never split**
 * into given and family parts. Splitting destroys patronymic chains, mononyms and
 * every naming system that puts the family name first — silently, at intake, before
 * any matching can compensate. Normalised comparison forms are derived alongside the
 * original, never in place of it.
 *
 * Sparse input is accepted. A missing date of birth stays missing; the subject simply
 * remains unresolved rather than being completed by inference.
 *
 * `externalSubjectRef` and `externalCaseRef` are recorded for correlation only. They
 * are neither a lookup instruction nor an authorisation credential.
 */
export async function createSubject(
  input: CreateSubjectRequest,
  operation?: OperationOptions,
): Promise<CreateSubjectResponse> {
  return apiRequest<CreateSubjectResponse>(
    `/subjects`,
    request(operation, { method: 'POST', body: input.body }),
  );
}

export type GetSearchPath = paths['/v1/searches/{searchId}']['get']['parameters']['path'];
export type GetSearchResponse =
  paths['/v1/searches/{searchId}']['get']['responses'][200]['content']['application/json'];
export interface GetSearchRequest {
  readonly path: GetSearchPath;
}
/**
 * Read a search and its three result dimensions
 *
 * `execution`, `findings` and `coverage` are independent and must be read together.
 * `SUCCEEDED` with `NO_MATCHES_FOUND` and `INCOMPLETE` coverage means the run
 * finished, found nothing, **and did not search everything it promised** — which is
 * not a clean result, and must never be presented as one.
 *
 * `progress` never carries a fabricated percentage: it reports stages completed and
 * the cascade rung reached, or nothing.
 */
export async function getSearch(
  input: GetSearchRequest,
  operation?: OperationOptions,
): Promise<GetSearchResponse> {
  return apiRequest<GetSearchResponse>(
    `/searches/${encodeURIComponent(String(input.path.searchId))}`,
    request(operation, { method: 'GET' }),
  );
}

export type GetSubjectVersionPath =
  paths['/v1/subjects/{subjectId}/versions/{version}']['get']['parameters']['path'];
export type GetSubjectVersionResponse =
  paths['/v1/subjects/{subjectId}/versions/{version}']['get']['responses'][200]['content']['application/json'];
export interface GetSubjectVersionRequest {
  readonly path: GetSubjectVersionPath;
}
/**
 * Read one pinned version of a subject
 *
 * Versions are immutable. A data update creates a new one, and a historical search keeps the version it ran against, so a past result can still be explained.
 */
export async function getSubjectVersion(
  input: GetSubjectVersionRequest,
  operation?: OperationOptions,
): Promise<GetSubjectVersionResponse> {
  return apiRequest<GetSubjectVersionResponse>(
    `/subjects/${encodeURIComponent(String(input.path.subjectId))}/versions/${encodeURIComponent(String(input.path.version))}`,
    request(operation, { method: 'GET' }),
  );
}

export type HealthDependenciesResponse =
  paths['/v1/health/dependencies']['get']['responses'][200]['content']['application/json'];
/**
 * Dependency detail, for authorised operators
 *
 * Separate from the public probes because it discloses which dependency is degraded, which tells an attacker where to push. Requires `platform:read_health`.
 */
export async function healthDependencies(
  operation?: OperationOptions,
): Promise<HealthDependenciesResponse> {
  return apiRequest<HealthDependenciesResponse>(
    `/health/dependencies`,
    request(operation, { method: 'GET' }),
  );
}

export type HealthLiveResponse =
  paths['/health/live']['get']['responses'][200]['content']['application/json'];
/**
 * Liveness probe
 *
 * Version-neutral and unauthenticated: a load balancer cannot authenticate, and a version bump must not turn every probe into a 404 — which reads as "the service is down".
 */
export async function healthLive(operation?: OperationOptions): Promise<HealthLiveResponse> {
  return apiRequest<HealthLiveResponse>(
    `/health/live`,
    request(operation, { method: 'GET', basePath: '' }),
  );
}

export type HealthReadyResponse =
  paths['/health/ready']['get']['responses'][200]['content']['application/json'];
/**
 * Readiness probe
 *
 * Whether this instance will accept traffic. It deliberately does not say why not.
 */
export async function healthReady(operation?: OperationOptions): Promise<HealthReadyResponse> {
  return apiRequest<HealthReadyResponse>(
    `/health/ready`,
    request(operation, { method: 'GET', basePath: '' }),
  );
}

export type ListSearchesQuery = NonNullable<paths['/v1/searches']['get']['parameters']['query']>;
export type ListSearchesResponse =
  paths['/v1/searches']['get']['responses'][200]['content']['application/json'];
export interface ListSearchesRequest {
  readonly query?: ListSearchesQuery;
}
/**
 * List searches for the caller's tenant
 */
export async function listSearches(
  input: ListSearchesRequest = {},
  operation?: OperationOptions,
): Promise<ListSearchesResponse> {
  return apiRequest<ListSearchesResponse>(
    `/searches${queryString(input.query)}`,
    request(operation, { method: 'GET' }),
  );
}

/** Begin the authorisation-code flow. Navigate to it; do not fetch it. */
export const AUTH_LOGIN_PATH = '/auth/login';
/** Complete sign-in and establish the session. Navigate to it; do not fetch it. */
export const AUTH_CALLBACK_PATH = '/auth/callback';
