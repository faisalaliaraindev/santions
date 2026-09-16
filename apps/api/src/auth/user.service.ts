/**
 * The customer credential store (I2, decision D-051).
 *
 * This service has never held a password before. Human identity is OIDC end to end, the control
 * panel holds no secrets, and the recommendation on file was to create customer users in Keycloak
 * and never see one. **D-051 decided otherwise, deliberately**, so this file is where that
 * decision's cost is paid: not the hashing, which is a library call, but everything that comes
 * with owning credentials — reset, lockout, single-use tokens, and knowing which sessions to end
 * when a password changes.
 *
 * # Five properties, each with a test
 *
 * 1. **A password is stored only as an argon2id hash.** Nothing here returns one, and the record
 *    projection used for reads excludes it, so a hash cannot leak into a log line or a response
 *    by being carried along in an object somebody spread.
 * 2. **A token is stored only as a SHA-256 hash, is single-use, and expires.** The raw token
 *    exists in the email and nowhere else. A database read must not be able to confirm somebody
 *    else's address — confirming an address is what unlocks a live key (D-052).
 * 3. **Failed attempts lock the account, temporarily.** Ten wrong passwords buys a fifteen-minute
 *    pause. Temporary, because a permanent lock is a denial-of-service anybody can trigger by
 *    typing a customer's address wrong ten times.
 * 4. **Confirming the address is what sets `tenants.emailVerifiedAt`**, which is the value
 *    `decideLiveAccess` reads (D-055). Verification and the tenant flag move in one transaction:
 *    a user marked verified beside a tenant that is not is a customer who did everything asked of
 *    them and still cannot reach live.
 * 5. **A reset ends every session that user holds.** Someone resetting a password may be someone
 *    taking an account back, and leaving the other party signed in defeats the exercise.
 *
 * # What is deliberately not here
 *
 * **Sign-in.** Verifying a password is here — `authenticate` — but turning that into a session is
 * I3's, and it is the only thing standing between this store and a customer signing in.
 *
 * **Changing a password while signed in.** It needs the session identity I3 introduces. Until
 * then a customer rotates through the reset flow, which is the same proof of address by a longer
 * route.
 *
 * **MFA.** Named in D-051 as something the decision now makes ours to build. Nothing here
 * pretends it exists.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { ClientSession, Collection, Db } from 'mongodb';

import type { Role } from '@erly/adverse-domain';

import { AuditService } from '../persistence/audit.service.js';
import { TransactionRunner } from '../persistence/transaction.runner.js';
import { SessionService } from './session.service.js';
import { hashPassword, passwordNeedsRehash, verifyPassword } from './password.js';

/** Wrong passwords tolerated before the account pauses. */
export const MAX_FAILED_ATTEMPTS = 10;

/**
 * How long the pause lasts.
 *
 * Deliberately temporary. A lock that only an administrator can lift is a denial of service that
 * anybody can trigger against a named customer by typing their address and ten wrong passwords,
 * and the person it inconveniences is never the attacker.
 */
export const LOCKOUT_MS = 15 * 60 * 1000;

/** A verification link is for onboarding, and onboarding happens over days, not minutes. */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A reset link is a live credential for whoever holds it, so it is short.
 *
 * An hour is long enough for a customer to find the email and act on it, and short enough that a
 * link sitting in a forwarded thread or a shared inbox stops being useful quickly.
 */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export type UserStatus = 'ACTIVE' | 'SUSPENDED';

export interface UserRecord {
  readonly userId: string;
  readonly tenantId: string;
  /** Lower-cased at the contract boundary. The sign-in identity, and globally unique. */
  readonly email: string;
  /** argon2id, with its parameters encoded in the string. Never returned by anything. */
  readonly passwordHash: string;
  readonly roles: readonly Role[];
  readonly status: UserStatus;
  readonly displayName: string;
  readonly createdAt: Date;
  readonly emailVerifiedAt: Date | null;
  readonly passwordChangedAt: Date;
  readonly lastAuthenticatedAt: Date | null;
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
}

/** A user as anything outside this file may see one. No hash, in any form. */
export type SafeUser = Omit<UserRecord, 'passwordHash'>;

export type TokenPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

interface UserTokenRecord {
  /** SHA-256 of the token. The raw value lives in the customer's email and nowhere else. */
  readonly tokenHash: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly purpose: TokenPurpose;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export type AuthenticationFailure = 'UNKNOWN_USER' | 'BAD_PASSWORD' | 'LOCKED' | 'SUSPENDED';

export type AuthenticationResult =
  | { readonly ok: true; readonly user: SafeUser }
  | { readonly ok: false; readonly failure: AuthenticationFailure; readonly retryAfterMs?: number };

export class UserError extends Error {
  constructor(
    readonly reason: 'EMAIL_TAKEN' | 'INVALID_TOKEN',
    message: string,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

/** The token is 32 bytes of CSPRNG output, so a fast digest is right — see `password.ts`. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The one way a user record leaves this file.
 *
 * Written as an explicit pick rather than a rest-spread that drops `passwordHash`: a field added
 * to `UserRecord` later is then absent here until somebody deliberately adds it, which is the
 * safe direction. The spread would carry a new secret out on the day it was introduced.
 */
function strip(user: UserRecord): SafeUser {
  return {
    userId: user.userId,
    tenantId: user.tenantId,
    email: user.email,
    roles: user.roles,
    status: user.status,
    displayName: user.displayName,
    createdAt: user.createdAt,
    emailVerifiedAt: user.emailVerifiedAt,
    passwordChangedAt: user.passwordChangedAt,
    lastAuthenticatedAt: user.lastAuthenticatedAt,
    failedAttempts: user.failedAttempts,
    lockedUntil: user.lockedUntil,
  };
}

@Injectable()
export class UserService {
  private readonly logger = new Logger('Users');

  private readonly users: Collection<UserRecord>;
  private readonly tokens: Collection<UserTokenRecord>;
  private readonly tenants: Collection<{ tenantId: string; emailVerifiedAt?: string | null }>;

  constructor(
    db: Db,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {
    this.users = db.collection<UserRecord>('users');
    this.tokens = db.collection<UserTokenRecord>('userTokens');
    this.tenants = db.collection('tenants');
  }

  async ensureIndexes(): Promise<void> {
    // Globally unique, because the address is the sign-in identity: two users with one address
    // makes "who is signing in" a question with two answers.
    await this.users.createIndex({ email: 1 }, { unique: true });
    await this.users.createIndex({ tenantId: 1, createdAt: -1 });
    await this.users.createIndex({ userId: 1 }, { unique: true });

    await this.tokens.createIndex({ tokenHash: 1 }, { unique: true });
    await this.tokens.createIndex({ userId: 1, purpose: 1, createdAt: -1 });
    // Spent and expired tokens are litter with a credential shape. Mongo removes each one an hour
    // after it expires — the hour of slack keeps a just-expired token explainable ("that link has
    // expired") rather than indistinguishable from one that never existed.
    await this.tokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 });
  }

  /**
   * Create a user inside somebody else's transaction.
   *
   * `session` is required, and that is the point: signup creates the tenant, its three versioned
   * records and this user as one act. A tenant with no user is a tenant nobody can sign in to,
   * and it would be created by exactly the half-finished signup the transaction exists to
   * prevent.
   */
  async createInTransaction(
    input: {
      readonly tenantId: string;
      readonly email: string;
      readonly password: string;
      readonly roles: readonly Role[];
      readonly displayName: string;
      readonly now: Date;
    },
    session: ClientSession,
  ): Promise<SafeUser> {
    const existing = await this.users.findOne({ email: input.email }, { session });
    if (existing !== null) {
      throw new UserError(
        'EMAIL_TAKEN',
        `An account already exists for ${input.email}, and the address is the sign-in identity.`,
      );
    }

    const record: UserRecord = {
      userId: `user-${randomUUID()}`,
      tenantId: input.tenantId,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      roles: input.roles,
      status: 'ACTIVE',
      displayName: input.displayName,
      createdAt: input.now,
      // Unconfirmed. `issueToken` sends the proof, and confirming it is what opens live (D-052).
      emailVerifiedAt: null,
      passwordChangedAt: input.now,
      lastAuthenticatedAt: null,
      failedAttempts: 0,
      lockedUntil: null,
    };

    await this.users.insertOne(record, { session });
    return strip(record);
  }

  /** By address. Returns the safe shape, so a hash cannot leave this file by accident. */
  async findByEmail(email: string): Promise<SafeUser | null> {
    const record = await this.users.findOne({ email });
    return record === null ? null : strip(record);
  }

  async findById(userId: string): Promise<SafeUser | null> {
    const record = await this.users.findOne({ userId });
    return record === null ? null : strip(record);
  }

  /**
   * Issue a single-use token and return the raw value **once**, for the email.
   *
   * Every earlier unused token for the same purpose is spent at the same moment. Otherwise
   * asking for a second reset link leaves the first one live, and a customer who requested a
   * reset because they suspected someone else had their mail has just been given a second
   * credential without invalidating the first.
   */
  async issueToken(input: {
    readonly user: SafeUser;
    readonly purpose: TokenPurpose;
    readonly now: Date;
  }): Promise<{ readonly token: string; readonly expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const ttl =
      input.purpose === 'EMAIL_VERIFICATION' ? EMAIL_VERIFICATION_TTL_MS : PASSWORD_RESET_TTL_MS;
    const expiresAt = new Date(input.now.getTime() + ttl);

    await this.tokens.updateMany(
      { userId: input.user.userId, purpose: input.purpose, usedAt: null },
      { $set: { usedAt: input.now } },
    );

    await this.tokens.insertOne({
      tokenHash: hashToken(token),
      userId: input.user.userId,
      tenantId: input.user.tenantId,
      purpose: input.purpose,
      createdAt: input.now,
      expiresAt,
      usedAt: null,
    });

    return { token, expiresAt };
  }

  /**
   * Confirm an address, and unlock live for the tenant in the same transaction (D-052, D-055).
   *
   * Idempotent in the way that matters: a token can be spent once, so a customer who clicks the
   * link twice gets a clear "this link has already been used" rather than a second, silent
   * success — but the tenant flag it set stays set.
   */
  async verifyEmail(
    token: string,
    now: Date = new Date(),
  ): Promise<{ readonly tenantId: string; readonly userId: string; readonly verifiedAt: Date }> {
    return this.transactions.run(
      async (session) => {
        const claimed = await this.claimToken(token, 'EMAIL_VERIFICATION', now, session);

        await this.users.updateOne(
          { userId: claimed.userId },
          { $set: { emailVerifiedAt: now } },
          { session },
        );

        // The tenant flag is the one that matters: `decideLiveAccess` reads it, not the user's.
        // Written here rather than in a follow-up so a verified user beside an unverified tenant
        // — a customer who did everything asked and still cannot reach live — cannot exist.
        await this.tenants.updateOne(
          { tenantId: claimed.tenantId },
          { $set: { emailVerifiedAt: now.toISOString() } },
          { session },
        );

        await this.audit.append(
          {
            tenantId: claimed.tenantId,
            actor: { type: 'USER', subject: claimed.userId, clientId: null },
            action: 'tenant:email-verified',
            target: { type: 'TENANT', id: claimed.tenantId, version: null },
            reason: 'Contact address confirmed; live credentials unlocked (D-052)',
            result: 'ALLOWED',
            now,
          },
          session,
        );

        return { tenantId: claimed.tenantId, userId: claimed.userId, verifiedAt: now };
      },
      { name: 'account.verifyEmail' },
    );
  }

  /**
   * Set a new password from a reset token, and end every session that user holds.
   *
   * The sessions go because a reset may be an account being taken back. Leaving the other party
   * signed in would make the reset cosmetic.
   */
  async resetPassword(input: {
    readonly token: string;
    readonly newPassword: string;
    readonly now?: Date;
  }): Promise<{
    readonly userId: string;
    readonly tenantId: string;
    readonly sessionsEnded: number;
  }> {
    const now = input.now ?? new Date();
    const passwordHash = await hashPassword(input.newPassword);

    const claimed = await this.transactions.run(
      async (session) => {
        const token = await this.claimToken(input.token, 'PASSWORD_RESET', now, session);

        await this.users.updateOne(
          { userId: token.userId },
          {
            $set: {
              passwordHash,
              passwordChangedAt: now,
              // A reset is also the way out of a lockout. Whoever holds the mailbox has proved
              // more than a password would, and leaving the lock in place would punish the
              // person who just recovered their account for the attacker's failed guesses.
              failedAttempts: 0,
              lockedUntil: null,
            },
          },
          { session },
        );

        await this.audit.append(
          {
            tenantId: token.tenantId,
            actor: { type: 'USER', subject: token.userId, clientId: null },
            action: 'user:password-reset',
            target: { type: 'USER', id: token.userId, version: null },
            reason: 'Password reset using an emailed single-use token',
            result: 'ALLOWED',
            now,
          },
          session,
        );

        return token;
      },
      { name: 'account.resetPassword' },
    );

    // Outside the transaction, deliberately: session revocation is idempotent, and a commit that
    // failed because of it would leave the customer with the old password still working.
    const sessionsEnded = await this.sessions.revokeAllForSubject(claimed.userId, now);
    this.logger.log(
      `Password reset for ${claimed.userId}; ${String(sessionsEnded)} session(s) ended.`,
    );

    return { userId: claimed.userId, tenantId: claimed.tenantId, sessionsEnded };
  }

  /**
   * Check an address and password, with lockout. **Does not create a session** — that is I3.
   *
   * Every failure is reported to the caller as its own value, and it is the *caller's* job to
   * flatten them into one opaque answer at the HTTP boundary, exactly as `AuthGuard` does for API
   * keys. The distinction exists so the audit trail and the lockout counter can tell the
   * difference; it must never reach the person trying passwords.
   */
  async authenticate(input: {
    readonly email: string;
    readonly password: string;
    readonly now?: Date;
  }): Promise<AuthenticationResult> {
    const now = input.now ?? new Date();
    const record = await this.users.findOne({ email: input.email });

    if (record === null) {
      // A password is still hashed for an unknown address — see `equaliseTiming`. Skipping the
      // work here is what makes "no such account" measurably faster than "wrong password".
      await equaliseTiming(input.password);
      return { ok: false, failure: 'UNKNOWN_USER' };
    }

    if (record.status !== 'ACTIVE') {
      await equaliseTiming(input.password);
      return { ok: false, failure: 'SUSPENDED' };
    }

    if (record.lockedUntil !== null && record.lockedUntil.getTime() > now.getTime()) {
      return {
        ok: false,
        failure: 'LOCKED',
        retryAfterMs: record.lockedUntil.getTime() - now.getTime(),
      };
    }

    const matches = await verifyPassword(record.passwordHash, input.password);

    if (!matches) {
      const failedAttempts = record.failedAttempts + 1;
      const locked = failedAttempts >= MAX_FAILED_ATTEMPTS;
      await this.users.updateOne(
        { userId: record.userId },
        {
          $set: {
            failedAttempts: locked ? 0 : failedAttempts,
            lockedUntil: locked ? new Date(now.getTime() + LOCKOUT_MS) : record.lockedUntil,
          },
        },
      );
      return locked
        ? { ok: false, failure: 'LOCKED', retryAfterMs: LOCKOUT_MS }
        : { ok: false, failure: 'BAD_PASSWORD' };
    }

    // An **unconfirmed address still signs in**, and that is deliberate. D-052 gates the *live
    // key*, not the account: signup promises that sandbox works immediately, and a customer who
    // cannot sign in until an email arrives cannot use the thing they were just promised. The
    // verification state travels on the returned user, so the caller can say so; the gate stays
    // where D-055 put it, on the tenant record that key issuance reads.
    //
    // Right password, and the plaintext is briefly in hand: the one moment the store can be
    // strengthened without asking the customer to reset.
    const rehash = passwordNeedsRehash(record.passwordHash)
      ? { passwordHash: await hashPassword(input.password), passwordChangedAt: now }
      : {};

    await this.users.updateOne(
      { userId: record.userId },
      { $set: { failedAttempts: 0, lockedUntil: null, lastAuthenticatedAt: now, ...rehash } },
    );

    return { ok: true, user: strip({ ...record, ...rehash }) };
  }

  /**
   * Spend a token, or refuse.
   *
   * One refusal for every reason — unknown, expired, already used, wrong purpose. A caller who
   * can tell "already used" from "never existed" can probe which links were issued, and the
   * customer-facing answer is the same either way: ask for a new one.
   *
   * The `usedAt: null` filter on the update is what makes it single-use under concurrency: two
   * requests carrying the same token race, and exactly one modifies a document.
   */
  private async claimToken(
    token: string,
    purpose: TokenPurpose,
    now: Date,
    session: ClientSession,
  ): Promise<UserTokenRecord> {
    const record = await this.tokens.findOneAndUpdate(
      { tokenHash: hashToken(token), purpose, usedAt: null, expiresAt: { $gt: now } },
      { $set: { usedAt: now } },
      { session, returnDocument: 'before' },
    );

    if (record === null) {
      throw new UserError(
        'INVALID_TOKEN',
        `No usable ${purpose} token: it is unknown, already used, or expired.`,
      );
    }
    return record;
  }
}

/**
 * Spend roughly what a real verification spends, when there is nothing to verify.
 *
 * Without this, "no account with that address" returns in a millisecond and "wrong password"
 * returns in fifteen, and the difference is a reliable oracle for which addresses are customers —
 * which is the exact thing the reset and resend routes are careful never to say.
 */
async function equaliseTiming(password: string): Promise<void> {
  await hashPassword(password);
}
