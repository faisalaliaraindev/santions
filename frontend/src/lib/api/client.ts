/**
 * The single route from the control panel to the service.
 *
 * Decision D-001: the panel and external integrators invoke the same application services.
 * There is no second matching engine in the browser — banding, identity resolution, stage
 * logic and clustering happen in the backend and reach this code only as API responses.
 *
 * Authentication is a backend-for-frontend session (FR-14, section 4.2): provider tokens
 * stay server-side and the browser carries a secure, HTTP-only cookie. That is why every
 * request here sends credentials and none of them attaches a bearer token.
 */

/** Shape of the service's error responses (section 6.1). */
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
  readonly retryable: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string;
  readonly retryable: boolean;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.correlationId = body.correlationId;
    this.retryable = body.retryable;
  }

  /**
   * An entitlement denial is not a rate limit and not a coverage gap (REL-02). The panel
   * must say which one it is, because the operator's next action differs entirely.
   */
  get isEntitlementDenial(): boolean {
    return this.status === 403 && this.code === 'ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN';
  }

  get isSessionExpired(): boolean {
    return this.status === 401;
  }

  get isRevisionConflict(): boolean {
    return this.status === 409;
  }
}

const FALLBACK_ERROR: ApiErrorBody = {
  code: 'UNKNOWN',
  message: 'The service returned an error that could not be parsed.',
  correlationId: '',
  retryable: false,
};

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /**
   * FR-12: a tenant/client-scoped idempotency key. The same canonical request returns the
   * same operation; a changed body returns 409.
   */
  readonly idempotencyKey?: string;
  /**
   * Defaults to `/v1`. Sign-in and health are version-neutral on the service — a version bump
   * must not turn a load balancer probe or a registered redirect URI into a 404 — so the
   * generated operations for those pass an empty base rather than the `/v1` prefix.
   */
  readonly basePath?: string;
}

/** Business routes are versioned under /v1. Auth and health are deliberately not. */
const API_BASE = '/v1';

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }

  const method = options.method ?? 'GET';

  // CSRF protection for state-changing cookie-authenticated requests (section 4.2). The
  // token is issued by the BFF into a readable cookie and echoed in this header.
  if (method !== 'GET') {
    const csrf = readCsrfToken();
    if (csrf !== null) {
      headers['X-CSRF-Token'] = csrf;
    }
  }

  const init: RequestInit = {
    method,
    headers,
    // The BFF session cookie. Never a bearer token in the browser.
    credentials: 'same-origin',
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }

  const response = await fetch(`${options.basePath ?? API_BASE}${path}`, init);

  if (!response.ok) {
    let body: ApiErrorBody = FALLBACK_ERROR;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // A non-JSON error body is itself a defect worth surfacing, but not worth crashing on.
    }
    throw new ApiError(response.status, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/** The BFF issues a readable, non-HTTP-only CSRF cookie alongside the HTTP-only session. */
function readCsrfToken(): string | null {
  const match = /(?:^|;\s*)csrf_token=([^;]+)/u.exec(document.cookie);
  return match?.[1] !== undefined ? decodeURIComponent(match[1]) : null;
}
