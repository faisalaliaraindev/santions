/**
 * Tenant self-service API keys.
 *
 * # Why this exists now, when D-007 deferred it
 *
 * D-007 recorded that keys were **provider-managed in this phase**: an operator ran
 * `pnpm key:issue` and handed the secret over. That was the right call while there was no
 * commercial layer to hang self-service off, and it is recorded as **D-050** that it no longer
 * is — a tenant integrating this service cannot wait on a human to rotate a credential, and a
 * provider who is the only one able to issue keys becomes the reason a customer's key outlives
 * its usefulness.
 *
 * # What self-service does NOT mean
 *
 * Three things a tenant still cannot do, and each is a rule rather than an oversight:
 *
 * - **Escalate.** A key can carry only roles the caller already holds. Otherwise the weakest
 *   `tenant_admin` credential is a path to every role in the system, and the role model is
 *   decoration.
 * - **Cross a tenant boundary.** The tenant comes from the authenticated principal and is never
 *   read from the body. There is no field here to put one in.
 * - **Reach the live environment unprovisioned.** Creating a `live` key requires the tenant's
 *   entitlement to include `live` **and** the calling credential to be a live one. Entitlement
 *   is a commercial act by the provider; self-service issues credentials within what was sold,
 *   it does not sell.
 */

import { z } from 'zod';

// The one role list, from the pure package. A second copy here would be a second thing to keep
// in step with `permissionsForRoles`, and the copy that drifted would be the one minting keys.
import { ROLES } from '@erly/adverse-domain';

/** The environment a key may act in. A key is bound to one and cannot be promoted. */
export const keyEnvironmentSchema = z.enum(['sandbox', 'live']);

export const machineScopeSchema = z.enum([
  'search:read',
  'search:write',
  'admin:read',
  'admin:write',
]);

export const createApiKeySchema = z
  .object({
    /**
     * What the key is for, in words. Required, and required to be meaningful-length, because a
     * key nobody can identify is a key nobody dares revoke.
     */
    label: z.string().min(3).max(120),
    /**
     * Roles to grant. Every one must be a role the **caller already holds** — checked at the
     * route, not here, because a schema cannot see who is asking.
     */
    roles: z.array(z.enum(ROLES)).min(1).max(9),
    environment: keyEnvironmentSchema.default('sandbox'),
    /**
     * Narrow the key below its roles. Omit to get the scopes those roles could use.
     *
     * Passing `[]` is not "no restriction" — an empty scope list is refused on every scope-gated
     * route. The schema requires at least one entry so that the empty array cannot be sent by
     * accident and read as "everything".
     */
    scopes: z.array(machineScopeSchema).min(1).max(4).optional(),
    /** Expire after N days. Null means never, which is a choice rather than a default. */
    expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
  })
  .strict();

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

/**
 * The response to a creation, and the only time the secret exists outside the caller.
 *
 * `secret` appears here and nowhere else, ever. Only a hash is stored, so there is no endpoint
 * that can return it again and no support process that can recover it — a credential the
 * provider can read back is one the provider can leak.
 */
export const issuedApiKeySchema = z
  .object({
    keyId: z.string(),
    secret: z.string(),
    environment: keyEnvironmentSchema,
    label: z.string(),
    roles: z.array(z.enum(ROLES)),
    scopes: z.array(machineScopeSchema),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
    warning: z.string(),
  })
  .strict();

export type IssuedApiKeyResponse = z.infer<typeof issuedApiKeySchema>;

/** A key as it can be listed afterwards. Carries no secret and no hash of one. */
export const apiKeySummarySchema = z
  .object({
    keyId: z.string(),
    label: z.string(),
    environment: keyEnvironmentSchema,
    roles: z.array(z.enum(ROLES)),
    scopes: z.array(machineScopeSchema),
    createdAt: z.string(),
    createdBy: z.string(),
    /** Null until the key is first used. This is what makes an unused key identifiable. */
    lastUsedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    /** Set while the key is switched off. Reversible — see `disableApiKeySchema`. */
    disabledAt: z.string().nullable(),
    disabledReason: z.string().nullable(),
    revokedAt: z.string().nullable(),
    revokedReason: z.string().nullable(),
    /**
     * Why the key is not usable right now, or `ACTIVE`.
     *
     * One field, so it can only name one reason, and a key can be more than one of these at
     * once. The order is **what the holder must do about it**, most permanent first:
     * `REVOKED` (gone — issue a new one), `EXPIRED` (issue a new one), `DISABLED` (turn it back
     * on), `ACTIVE`. A key that was disabled and has since expired therefore reads `EXPIRED`,
     * because enabling it would not make it work — and `disabledAt` is still there, unchanged,
     * to say it was also paused.
     */
    status: z.enum(['ACTIVE', 'EXPIRED', 'DISABLED', 'REVOKED']),
  })
  .strict();

export type ApiKeySummary = z.infer<typeof apiKeySummarySchema>;

/** Revocation is immediate and irreversible. The reason is mandatory and is audited. */
export const revokeApiKeySchema = z
  .object({
    reason: z.string().min(3).max(500),
  })
  .strict();

export type RevokeApiKeyInput = z.infer<typeof revokeApiKeySchema>;

/**
 * Disabling is a **reversible** off switch, and it is deliberately not revocation.
 *
 * The two must never share a field. If they did, then either a leaked secret could be switched
 * back on — which is the one thing revocation exists to prevent — or pausing an integration for
 * an afternoon would destroy the credential. Both are wrong, in opposite directions, and a
 * single `revokedAt` cannot be right about both.
 *
 * So: `disabledAt` for "off for now", `revokedAt` for "never again". A disabled key is refused
 * by `verify()` exactly as a revoked one is; the difference is only in what can undo it.
 *
 * The reason is mandatory here for the same reason it is on revocation: a credential that
 * stopped working with no recorded explanation is indistinguishable from an outage to whoever
 * investigates it a month later.
 */
export const disableApiKeySchema = z
  .object({
    reason: z.string().min(3).max(500),
  })
  .strict();

export type DisableApiKeyInput = z.infer<typeof disableApiKeySchema>;

/** Turning a disabled key back on. Audited with an actor and a reason, like every other change. */
export const enableApiKeySchema = z
  .object({
    reason: z.string().min(3).max(500),
  })
  .strict();

export type EnableApiKeyInput = z.infer<typeof enableApiKeySchema>;
