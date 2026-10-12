/**
 * Express request augmentation.
 *
 * Declared once in an ambient file rather than inline in each module. A module augmentation
 * inside a regular `.ts` file only applies where that file is imported, which produced
 * "correlationId does not exist" in exactly the modules that never imported the middleware.
 */

import type { Principal } from '@adverse-search/domain';

declare module 'express' {
  interface Request {
    /** Server-generated, opaque, never accepted from a client. */
    correlationId?: string;
    /** Populated by AuthGuard from a validated credential. Never from a header. */
    principal?: Principal;
  }
}
