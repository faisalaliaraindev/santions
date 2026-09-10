/**
 * Section 6.1 — the error contract.
 *
 * Every error the service returns has the same shape, carries a correlation ID, and says
 * whether retrying could help. Three distinctions are load-bearing, because the operator's
 * next action is completely different for each:
 *
 *  - an **entitlement denial** is not throttling and not a coverage gap (REL-02);
 *  - a **revision conflict** means someone acted on stale data and needs a recovery path,
 *    not a silent retry;
 *  - a **session expiry** is recoverable without losing work.
 *
 * The control panel already depends on exactly these distinctions — see `ApiError` in the
 * frontend's `src/lib/api/client.ts`.
 */

import { z } from 'zod';

export const ERROR_CODES = [
  // 400 / 422
  'VALIDATION_FAILED',
  'UNKNOWN_FIELD',
  'INVALID_SCOPE',
  'INVALID_POLICY',
  // 401
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'TOKEN_INVALID',
  // 403
  'FORBIDDEN',
  'CROSS_TENANT_DENIED',
  'ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN',
  'SANDBOX_CANNOT_ACCESS_LIVE',
  'BREAK_GLASS_REQUIRED',
  // 404 — deliberately non-enumerating: an unauthorised read and a missing record look alike.
  'NOT_FOUND',
  // 409
  'REVISION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY',
  'ALREADY_TERMINAL',
  // 413
  'PAYLOAD_TOO_LARGE',
  'INPUT_BOUND_EXCEEDED',
  // 429
  'RATE_LIMITED',
  // 501
  'NOT_IMPLEMENTED',
  // 500
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const apiErrorSchema = z
  .object({
    code: z.enum(ERROR_CODES),
    /** Safe for display. Never contains a stack trace, a source secret or evidence text. */
    message: z.string(),
    correlationId: z.string(),
    /** True only when the same request could succeed later without being changed. */
    retryable: z.boolean(),
    /** Field-level detail for validation failures. Never echoes a rejected secret. */
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .strict();

export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

/** The HTTP status each code is returned with. One mapping, so routes cannot drift. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNKNOWN_FIELD: 400,
  INVALID_SCOPE: 422,
  INVALID_POLICY: 422,

  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  TOKEN_INVALID: 401,

  FORBIDDEN: 403,
  CROSS_TENANT_DENIED: 403,
  ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN: 403,
  SANDBOX_CANNOT_ACCESS_LIVE: 403,
  BREAK_GLASS_REQUIRED: 403,

  NOT_FOUND: 404,

  REVISION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY: 409,
  ALREADY_TERMINAL: 409,

  PAYLOAD_TOO_LARGE: 413,
  INPUT_BOUND_EXCEEDED: 413,

  RATE_LIMITED: 429,

  NOT_IMPLEMENTED: 501,

  INTERNAL: 500,
};

/**
 * Whether retrying the identical request could succeed.
 *
 * Note that `RATE_LIMITED` is retryable and every 403 is not. That difference is the whole
 * point of REL-02: a capability the tenant does not have will still not be there in a minute,
 * and a client that retries it is generating load for no possible benefit.
 */
export const ERROR_RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  VALIDATION_FAILED: false,
  UNKNOWN_FIELD: false,
  INVALID_SCOPE: false,
  INVALID_POLICY: false,

  UNAUTHENTICATED: false,
  SESSION_EXPIRED: false,
  TOKEN_INVALID: false,

  FORBIDDEN: false,
  CROSS_TENANT_DENIED: false,
  ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN: false,
  SANDBOX_CANNOT_ACCESS_LIVE: false,
  BREAK_GLASS_REQUIRED: false,

  NOT_FOUND: false,

  REVISION_CONFLICT: false,
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY: false,
  ALREADY_TERMINAL: false,

  PAYLOAD_TOO_LARGE: false,
  INPUT_BOUND_EXCEEDED: false,

  RATE_LIMITED: true,

  NOT_IMPLEMENTED: false,

  INTERNAL: true,
};

export function statusForErrorCode(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

export function isRetryable(code: ErrorCode): boolean {
  return ERROR_RETRYABLE[code];
}

/** True for the codes the panel surfaces with a dedicated recovery path. */
export function isEntitlementDenial(code: ErrorCode): boolean {
  return code === 'ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN' || code === 'SANDBOX_CANNOT_ACCESS_LIVE';
}
