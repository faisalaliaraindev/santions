/**
 * Section 4.2 — what the panel is told about its own session.
 *
 * Deliberately thin. It answers "who am I, in which tenant, with which roles", because the
 * panel needs that to render its shell without guessing. It carries **no token, no session
 * identifier and no provider claim** — the session is a server-side record behind an
 * HTTP-only cookie, and anything returned here is readable by any script on the page.
 */

import { z } from 'zod';

export const sessionInfoSchema = z
  .object({
    /** The provider's stable subject identifier. Not an email, and not a display name. */
    subject: z.string(),
    /**
     * Null for a principal with no tenant binding — a platform operator, for instance.
     * A tenant-scoped route rejects that principal rather than defaulting it (SEC-01).
     */
    tenantId: z.string().nullable(),
    roles: z.array(z.string()),
    environment: z.enum(['sandbox', 'live']),
  })
  .strict();

export type SessionInfo = z.infer<typeof sessionInfoSchema>;
