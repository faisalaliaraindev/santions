/**
 * The backend-for-frontend session (section 4.2).
 *
 * Provider tokens stay **server-side**. The browser holds an opaque, HTTP-only session ID and
 * nothing else — no access token, no refresh token, no roles it could tamper with. That is
 * why the frontend's API client sends `credentials: 'same-origin'` and never an
 * `Authorization` header, and why `client.test.ts` asserts nothing bearer-shaped is in the
 * bundle.
 *
 * Sessions live in MongoDB rather than in memory so a restart does not sign everyone out and
 * a revocation takes effect across every API instance immediately.
 */

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import type { Principal, Role } from '@erly/adverse-domain';

/** Idle and absolute expiry are both enforced (section 4.2). */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 10 * 60 * 60 * 1000;

interface SessionRecord {
  /** SHA-256 of the session ID. The raw ID is never stored, so a database read cannot
   * impersonate a live session. */
  readonly sessionIdHash: string;
  readonly subject: string;
  readonly tenantId: string | null;
  readonly roles: readonly Role[];
  readonly environment: 'sandbox' | 'live';
  /**
   * Kept server-side only, for calls the BFF makes on the user's behalf.
   *
   * Null for a session created by `POST /v1/auth/login` (I3): a password session has no provider
   * behind it, so there is nothing to hold. Typed as nullable rather than filled with an empty
   * string, because "" is a token this service would then carry around as though it were one.
   */
  readonly providerTokens: {
    readonly accessToken: string | null;
    readonly refreshToken: string | null;
  } | null;
  /** Verified from the provider, not trusted from a client claim (section 4.2). */
  readonly authenticationAssurance: string | null;
  readonly csrfToken: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
}

function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

@Injectable()
export class SessionService {
  private readonly sessions: Collection<SessionRecord>;

  constructor(db: Db) {
    this.sessions = db.collection<SessionRecord>('sessions');
  }

  /** Indexes: lookup by hash, and TTL cleanup of absolutely-expired sessions. */
  async ensureIndexes(): Promise<void> {
    await this.sessions.createIndex({ sessionIdHash: 1 }, { unique: true });
    await this.sessions.createIndex({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  async create(input: {
    readonly subject: string;
    readonly tenantId: string | null;
    readonly roles: readonly Role[];
    readonly environment: 'sandbox' | 'live';
    readonly accessToken?: string | null;
    readonly refreshToken?: string | null;
    readonly authenticationAssurance: string | null;
    readonly now: Date;
  }): Promise<{ sessionId: string; csrfToken: string }> {
    // 32 bytes of CSPRNG output. Long enough that guessing is not a threat model.
    const sessionId = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');

    await this.sessions.insertOne({
      sessionIdHash: hashSessionId(sessionId),
      subject: input.subject,
      tenantId: input.tenantId,
      roles: input.roles,
      environment: input.environment,
      providerTokens:
        input.accessToken === undefined || input.accessToken === null
          ? null
          : { accessToken: input.accessToken, refreshToken: input.refreshToken ?? null },
      authenticationAssurance: input.authenticationAssurance,
      csrfToken,
      createdAt: input.now,
      lastSeenAt: input.now,
      absoluteExpiresAt: new Date(input.now.getTime() + SESSION_ABSOLUTE_MS),
      revokedAt: null,
    });

    return { sessionId, csrfToken };
  }

  /**
   * Resolve a session to a principal, enforcing idle and absolute expiry.
   *
   * Returns null for every failure — expired, revoked, unknown — so a caller cannot use the
   * distinction to probe which session IDs have ever existed.
   */
  async resolve(sessionId: string, now: Date = new Date()): Promise<Principal | null> {
    const record = await this.sessions.findOne({ sessionIdHash: hashSessionId(sessionId) });
    if (record === null || record.revokedAt !== null) {
      return null;
    }

    if (record.absoluteExpiresAt.getTime() <= now.getTime()) {
      return null;
    }
    if (now.getTime() - record.lastSeenAt.getTime() > SESSION_IDLE_MS) {
      return null;
    }

    // Sliding idle window. Written on read, which is the cost of enforcing idle expiry.
    await this.sessions.updateOne(
      { sessionIdHash: record.sessionIdHash },
      { $set: { lastSeenAt: now } },
    );

    return {
      subject: record.subject,
      kind: 'HUMAN',
      tenantId: record.tenantId,
      roles: record.roles,
      scopes: [],
      environment: record.environment,
      breakGlass: null,
    };
  }

  /**
   * CSRF check for state-changing cookie-authenticated requests (section 4.2, test T08).
   *
   * Compared in constant time. A `!==` here leaks token content through timing, which is a
   * small leak but an entirely avoidable one.
   */
  async verifyCsrf(sessionId: string, presented: string | undefined): Promise<boolean> {
    if (presented === undefined || presented === '') {
      return false;
    }
    const record = await this.sessions.findOne({ sessionIdHash: hashSessionId(sessionId) });
    if (record === null || record.revokedAt !== null) {
      return false;
    }

    const expected = Buffer.from(record.csrfToken);
    const actual = Buffer.from(presented);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** The absolute lifetime a session is created with, for a caller that has to state it. */
  absoluteLifetimeMs(): number {
    return SESSION_ABSOLUTE_MS;
  }

  /** Sign-out. Revocation is immediate and cluster-wide because the record is shared. */
  async revoke(sessionId: string, now: Date = new Date()): Promise<void> {
    await this.sessions.updateOne(
      { sessionIdHash: hashSessionId(sessionId) },
      { $set: { revokedAt: now } },
    );
  }

  /** Revoke every session for a subject — used when access is withdrawn (test T07). */
  async revokeAllForSubject(subject: string, now: Date = new Date()): Promise<number> {
    const result = await this.sessions.updateMany(
      { subject, revokedAt: null },
      { $set: { revokedAt: now } },
    );
    return result.modifiedCount;
  }
}
