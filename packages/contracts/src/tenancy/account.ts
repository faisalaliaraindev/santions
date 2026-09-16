/**
 * The customer's own account: a password, a confirmed address, and a way back in (I2).
 *
 * # Why this service holds a password at all
 *
 * It did not, until now. Human identity here is OIDC end to end and the recommendation on file
 * was to create customer users in Keycloak and never see the password. **D-051 decided
 * otherwise**, deliberately and against that recommendation, so this service now owns a
 * credential store — and owning one means owning what comes with it: reset, lockout, rotation
 * and breach response. Those are not extras bolted on later; they are the cost of the decision,
 * and they are in this step.
 *
 * # Hashed, not encrypted
 *
 * The instruction that opened D-051 said "encrypted". Encryption is reversible: anything that can
 * decrypt a password can produce it, and a store the provider can read back is a store the
 * provider can leak. Passwords are **argon2id** hashes here, which is the one-way version of the
 * same intent. The slow, memory-hard hash is right for low-entropy human input in a way it is
 * deliberately not for a 32-byte random API key secret — see `api-key.service.ts`, which uses
 * SHA-256 and says why.
 *
 * # What every route here has in common
 *
 * **None of them tells an anonymous caller whether an address is a customer.** Requesting a reset
 * for an unknown address answers exactly as it does for a known one. A signup form that says "no
 * account with that address" is an account-enumeration oracle, and this service already refuses
 * to be one for API keys (`404`, not `403`) and for authentication (one opaque `401`).
 */

import { z } from 'zod';

/**
 * The minimum password length.
 *
 * Length first, because length is what actually resists guessing. NIST SP 800-63B's position —
 * and the one taken here — is that composition rules (one capital, one symbol) push people
 * towards `Password1!` and buy very little, while a longer minimum plus a check against known-bad
 * values buys a lot.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * And a maximum, because argon2id is memory-hard on purpose.
 *
 * Without a bound, a megabyte of "password" is a free way to spend the server's memory and CPU on
 * every attempt. 200 is far beyond any real passphrase.
 */
export const PASSWORD_MAX_LENGTH = 200;

export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

/** Why a password was refused. The caller is told which, because they must be able to fix it. */
export const passwordRejectionSchema = z.enum([
  'TOO_SHORT',
  'TOO_LONG',
  'TOO_COMMON',
  'CONTAINS_EMAIL',
  'CONTAINS_ORGANISATION',
]);

export type PasswordRejection = z.infer<typeof passwordRejectionSchema>;

/**
 * Confirming the address the tenant signed up with.
 *
 * The token arrives by email and is the whole proof. It is single-use, expires, and is stored
 * only as a hash — the same reasoning as a session id: a database read must not be able to
 * confirm somebody else's address, because confirming an address is what unlocks a live key
 * (D-052).
 */
export const verifyEmailSchema = z.object({ token: z.string().min(16).max(200) }).strict();

export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const verifyEmailResultSchema = z
  .object({
    tenantId: z.string(),
    emailVerifiedAt: z.string(),
    /**
     * What confirming the address just changed.
     *
     * Stated in the response because it is the point of the exercise: this is the moment a
     * self-signed-up tenant becomes able to hold a live credential (D-052, D-055). A caller who
     * has to infer that from a later 403 disappearing has been told nothing.
     */
    liveAccessUnlocked: z.boolean(),
  })
  .strict();

export type VerifyEmailResult = z.infer<typeof verifyEmailResultSchema>;

/**
 * Asking for something to be sent again, or for the first time — a verification link or a reset.
 *
 * The answer never depends on whether the address is known. See the note at the top of this file:
 * a different answer for a known address turns this route into a list of customers.
 */
export const emailRequestSchema = z
  .object({ email: z.string().trim().toLowerCase().email().max(254) })
  .strict();

export type EmailRequestInput = z.infer<typeof emailRequestSchema>;

/** Deliberately says nothing about whether anything was sent. */
export const acceptedSchema = z
  .object({
    accepted: z.literal(true),
    detail: z.string(),
  })
  .strict();

export type AcceptedResponse = z.infer<typeof acceptedSchema>;

/** Setting a new password with a token from a reset email. */
export const resetPasswordSchema = z
  .object({
    token: z.string().min(16).max(200),
    newPassword: passwordSchema,
  })
  .strict();

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const resetPasswordResultSchema = z
  .object({
    reset: z.literal(true),
    /**
     * A reset ends every session that user holds.
     *
     * Someone resetting a password may be someone taking an account back, and leaving the other
     * party signed in would defeat the exercise entirely.
     */
    sessionsEnded: z.number().int().nonnegative(),
  })
  .strict();

export type ResetPasswordResult = z.infer<typeof resetPasswordResultSchema>;
