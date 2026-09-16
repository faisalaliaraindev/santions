/**
 * Signing in with a password, for a caller that is not a browser (I3).
 *
 * # Why this exists beside the OIDC flow rather than replacing it
 *
 * `GET /auth/login` is a redirect journey: a human ends up at the identity provider, comes back
 * with a code, and leaves holding an HTTP-only cookie they cannot read. That is right for the
 * control panel and wrong for an integrator's backend, which has no browser to redirect and no
 * cookie jar worth the name.
 *
 * So there are two ways in, and **one session store behind both**. That is the constraint this
 * step was written under: one verifier, one store, one set of expiry rules. A second
 * authentication system is how a service ends up with a revocation that only works on one of
 * them.
 *
 * # One answer for every failure
 *
 * Wrong password, no such address, locked, suspended — all `401`, all the same sentence. The
 * service knows the difference and writes it down; the caller never learns it. Telling an
 * anonymous caller that an address exists but the password is wrong halves the work of guessing,
 * and telling them an account is *locked* confirms the address is real — which is the enumeration
 * the account routes are otherwise careful to avoid (D-057).
 *
 * The cost is a customer who mistyped ten times and cannot tell why they are still refused. That
 * is what the reset flow is for, and the lockout expires on its own.
 */

import { z } from 'zod';

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    /**
     * Not `passwordSchema`. A login must accept whatever the customer actually has, including a
     * password that predates a policy change — validating it here against today's rules would
     * refuse the correct password and report it as a validation error, which is both wrong and
     * an oracle for what the rules are.
     */
    password: z.string().min(1).max(500),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * What a machine caller gets: the session, and enough context not to have to ask again.
 *
 * `sessionToken` is presented as `Authorization: Session <token>` — its own scheme, like `ApiKey`,
 * so it is never fed to the JWT verifier and a token is never fed to the session store. Sharing
 * one scheme means every failed verification has to be attempted twice and the logs stop saying
 * which credential the caller actually meant.
 */
export const loginResultSchema = z
  .object({
    sessionToken: z.string(),
    /** Absolute expiry. The session ends here whatever happens in between. */
    expiresAt: z.string(),
    /** Idle expiry, in seconds. A session unused for this long is over before `expiresAt`. */
    idleTimeoutSeconds: z.number().int().positive(),

    userId: z.string(),
    tenantId: z.string(),
    roles: z.array(z.string()),
    /**
     * The environment this session acts in.
     *
     * Derived from what the tenant may actually use, by the same function that decides whether a
     * live key may be issued: a tenant entitled to live, with a confirmed address, gets a `live`
     * session; everybody else gets `sandbox`. It is not a choice the caller makes, because the
     * caller is not who decides what was sold to them.
     */
    environment: z.enum(['sandbox', 'live']),
    /** Null until the contact address is confirmed. Sandbox works either way (D-052). */
    emailVerifiedAt: z.string().nullable(),

    /** Said in the body, not only in the documentation. */
    warning: z.string(),
  })
  .strict();

export type LoginResult = z.infer<typeof loginResultSchema>;

/** Signing out. Immediate, cluster-wide, and idempotent. */
export const logoutResultSchema = z
  .object({
    signedOut: z.literal(true),
  })
  .strict();

export type LogoutResult = z.infer<typeof logoutResultSchema>;
