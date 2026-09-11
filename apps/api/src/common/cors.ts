/**
 * CORS policy (test T08).
 *
 * Extracted from `main.ts` so the exact object the application uses can be asserted in a test.
 * Inline in the bootstrap it was unreachable, and "no permissive CORS" was a promise in a
 * comment rather than a check.
 *
 * The rule that matters: **the origin is always an explicit list, never a reflection of the
 * request.** `credentials: true` with a reflected origin lets any site drive an authenticated
 * session, and it is the single mistake that turns a correct BFF session into a cross-site
 * vulnerability. With no origins configured the answer is `false` — no browser origin is
 * allowed at all — because defaulting to "any" when configuration is missing is how a
 * development convenience reaches production.
 */

import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';

import type { AppConfig } from '../config/config.js';

export const ALLOWED_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];

/** Only headers the API actually reads. `Authorization` is for machine callers, not browsers. */
export const ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-CSRF-Token'];

export function corsOptions(config: AppConfig): CorsOptions {
  return {
    origin: config.corsOrigins.length > 0 ? [...config.corsOrigins] : false,
    credentials: true,
    methods: [...ALLOWED_METHODS],
    allowedHeaders: [...ALLOWED_HEADERS],
    maxAge: 600,
  };
}
