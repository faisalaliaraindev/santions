/**
 * Tenant self-service signup (phase I step I1).
 *
 * # What this replaces
 *
 * A tenant used to exist because somebody edited `scripts/bootstrap/seed-data.mjs` and re-ran
 * the bootstrap. That is provisioning by redeploy: the customer waits for a deployment, and the
 * record of who was onboarded and when lives in a git history rather than in the database.
 *
 * # The one field that is deliberately absent
 *
 * **There is no `tenantId` here, and there never may be.** The identity of a tenant is generated
 * by the service. A caller who can name their own tenant id can name an existing one — and the
 * best case is a duplicate-key error, while the worst is a signup that lands on the boundary of
 * somebody else's data. The schema is `.strict()`, so sending one is refused with
 * `UNKNOWN_FIELD` rather than ignored: a client that believes it chose its id should be told it
 * did not.
 *
 * The same reasoning removes the entitlement from the request. Capabilities and environments are
 * what the provider grants, not what the caller asks for. Signup writes the standard grant
 * (D-053: open signup, both key kinds) and a request cannot widen it.
 *
 * # Live access is a state, not a route
 *
 * D-052 gates a **live** key behind a verified email address. That gate is a value on the tenant
 * record which key issuance reads, rather than a condition written into the issuing route. The
 * difference matters for the payment gate that D-053 defers: turning it on later is then writing
 * a different value into tenant state, not hunting down every tenant created while there was no
 * gate.
 */

import { z } from 'zod';

/** What the caller supplies. Two fields, both about who they are — nothing about what they get. */
export const signupSchema = z
  .object({
    /**
     * The organisation being screened *for*, in words a human would recognise.
     *
     * It becomes the tenant's display name and nothing more: it is not an identifier, it is not
     * unique, and it never appears in a URL. Two firms with the same name are two tenants.
     */
    organisationName: z.string().trim().min(2).max(200),
    /**
     * Where the service reaches this customer, and the address D-052's verification is sent to.
     *
     * Not a login — I2 owns user credentials. Storing it here rather than only on a user record
     * keeps the tenant contactable when a person leaves, which is the situation where a silent
     * service is worst.
     */
    contactEmail: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();

export type SignupInput = z.infer<typeof signupSchema>;

/** Why a tenant cannot have a live key yet. `null` in `blockedBy` means it can. */
export const liveAccessBlockSchema = z.enum(['NOT_ENTITLED', 'EMAIL_NOT_VERIFIED']);

export type LiveAccessBlock = z.infer<typeof liveAccessBlockSchema>;

/**
 * What a new tenant is told, and it has to be enough to act on without reading the guide.
 *
 * The four version numbers are here because they are what a support conversation starts from.
 * A tenant whose searches are refused with `INVALID_POLICY` has no policy version; one whose
 * categories look wrong has a taxonomy version to quote. Returning them at signup means the
 * numbers exist in the customer's own records from the first minute.
 */
export const signupResultSchema = z
  .object({
    /** Generated here. The body could not name it and no later call can change it. */
    tenantId: z.string(),
    organisationName: z.string(),
    contactEmail: z.string(),
    createdAt: z.string(),

    entitlement: z
      .object({
        version: z.number().int().positive(),
        capabilities: z.array(z.string()),
        /**
         * Both environments from day one (D-053). The entitlement is not the whole answer for
         * `live` — see `liveAccess` — but it is where the provider's grant is recorded, and a
         * later payment gate belongs in exactly this record.
         */
        environments: z.array(z.enum(['sandbox', 'live'])),
      })
      .strict(),

    taxonomyVersion: z.number().int().positive(),
    policyVersion: z.number().int().positive(),

    /**
     * Whether a live key can be issued **right now**, and if not, what would change that.
     *
     * Stated at signup rather than discovered at the first refusal. A customer who reads
     * `granted: false, blockedBy: "EMAIL_NOT_VERIFIED"` knows to check their inbox; one who
     * only meets a 403 three days later files a bug against the key they were just given.
     */
    liveAccess: z
      .object({
        granted: z.boolean(),
        blockedBy: liveAccessBlockSchema.nullable(),
        detail: z.string(),
      })
      .strict(),

    /** Ordered, imperative, and in the body rather than only in the documentation. */
    nextSteps: z.array(z.string()).min(1),
  })
  .strict();

export type SignupResult = z.infer<typeof signupResultSchema>;
