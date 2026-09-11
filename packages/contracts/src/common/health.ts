/**
 * Section 6.1 — health.
 *
 * Liveness and readiness say the minimum, because they are unauthenticated: a public endpoint
 * that names which dependency is down tells an attacker where to push. The detailed view is
 * a separate, authorised route.
 */

import { z } from 'zod';

export const healthStatusSchema = z.object({ status: z.literal('ok') }).strict();

export type HealthStatus = z.infer<typeof healthStatusSchema>;

export const dependencyHealthSchema = z
  .object({
    status: z.string(),
    /** Operator-facing detail. Never a connection string or a credential (SEC-04). */
    note: z.string(),
  })
  .strict();

export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;
