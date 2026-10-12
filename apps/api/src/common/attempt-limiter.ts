/**
 * A bound on how often one origin may try something unauthenticated (I1, I3).
 *
 * Two routes in this service accept work from callers with no credential, and both need a floor
 * under them:
 *
 * - **signup** writes records, so an unbounded one is a collection somebody fills;
 * - **login** computes an argon2id hash on every attempt, which costs 19 MiB and a few
 *   milliseconds *by design*, so an unbounded one is a way to spend the server's memory using
 *   nothing but a socket.
 *
 * Written once here rather than twice, because the second copy is the one that drifts — and a
 * limiter that drifts is one that silently stops limiting.
 *
 * # What this is not
 *
 * It is not the account lockout. That lives on the user record and counts failures against **one
 * account**, which is what stops somebody grinding a single customer's password. This counts
 * attempts against **one origin**, which is what stops a spray across many accounts and a
 * deliberate attempt to exhaust CPU. Neither substitutes for the other, and they are measured on
 * different axes on purpose.
 *
 * It is also not a per-tenant live budget (still open, per D-052) and does nothing about the
 * publishers' shared rate limits.
 *
 * # Behind a proxy
 *
 * The caller passes what Express resolved as the remote address. `X-Forwarded-For` is
 * deliberately never read: without a trusted proxy configured it is whatever the caller typed,
 * and a limiter keyed on a caller-chosen value is a limiter the caller opts out of. A deployment
 * behind a load balancer must set `trust proxy` before these routes are exposed, or every
 * customer shares one bucket — see D-056.
 */

import { createHmac } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../tokens.js';

/** What is being counted. One collection, one index, several independent buckets. */
export type AttemptBucket = 'SIGNUP' | 'LOGIN';

export interface AttemptPolicy {
  readonly bucket: AttemptBucket;
  readonly max: number;
  readonly windowMs: number;
}

/**
 * Signups permitted from one address per hour.
 *
 * Generous by design. A real firm signs up once; five leaves room for a genuine second tenant, a
 * colleague on the same office address, and two mistakes, while still turning an unattended
 * script into a few rows rather than a few million.
 */
export const SIGNUP_POLICY: AttemptPolicy = {
  bucket: 'SIGNUP',
  max: 5,
  windowMs: 60 * 60 * 1000,
};

/**
 * Sign-in attempts permitted from one address per ten minutes.
 *
 * Higher than the signup bound, because an office behind one address has many people signing in
 * and mistyping, and locking a whole building out is worse than the attack this bounds. Low
 * enough that a password spray — one guess each against many accounts, which the per-account
 * lockout cannot see — runs out of room quickly.
 */
export const LOGIN_POLICY: AttemptPolicy = {
  bucket: 'LOGIN',
  max: 30,
  windowMs: 10 * 60 * 1000,
};

/** The longest window any policy uses, which is what the TTL has to outlive. */
const MAX_WINDOW_MS = Math.max(SIGNUP_POLICY.windowMs, LOGIN_POLICY.windowMs);

interface AttemptRecord {
  readonly bucket: AttemptBucket;
  /** Keyed, never the address itself — see `originKeyFor`. */
  readonly originKey: string;
  readonly at: Date;
}

/**
 * A keyed digest of the address, never the address.
 *
 * A bare SHA-256 of an IPv4 address is not anonymisation: the whole space is four billion values
 * and a laptop walks it in seconds. Keying the digest with the deployment's own secret makes the
 * stored value useless to anyone who does not also hold that secret, while still being stable
 * enough to count against for an hour.
 *
 * Exported so that anything needing to find one origin's rows — an operator asking why an address
 * is being refused, a test clearing its own bucket without touching another's — uses this rather
 * than reimplementing the keying beside it.
 */
export function originKeyFor(secret: string, ip: string | undefined): string {
  return createHmac('sha256', secret)
    .update(ip ?? 'unknown')
    .digest('hex');
}

/** Thrown when an origin is past its bound. Carries the count, for the log rather than the caller. */
export class AttemptLimitExceeded extends Error {
  constructor(
    readonly bucket: AttemptBucket,
    readonly attempts: number,
  ) {
    super(`${String(attempts)} ${bucket} attempts from this origin inside the window.`);
    this.name = 'AttemptLimitExceeded';
  }
}

@Injectable()
export class AttemptLimiter {
  private readonly attempts: Collection<AttemptRecord>;

  constructor(
    db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.attempts = db.collection<AttemptRecord>('attemptLog');
  }

  async ensureIndexes(): Promise<void> {
    await this.attempts.createIndex({ bucket: 1, originKey: 1, at: -1 });
    // The log exists to bound a burst, not to build a record of who visited. Mongo deletes each
    // row once it is older than the longest window, so this never becomes a store of addresses
    // somebody has to reason about under a retention policy.
    await this.attempts.createIndex(
      { at: 1 },
      { expireAfterSeconds: Math.floor(MAX_WINDOW_MS / 1000) },
    );
  }

  /** The key this origin's rows are stored under. */
  originKey(ip: string | undefined): string {
    return originKeyFor(this.config.session.secret, ip);
  }

  /**
   * Record an attempt and refuse if this origin is past the bound.
   *
   * The attempt is written **before** the count, so a caller whose attempts keep failing is
   * counted too. Counting only successes would leave a loop of failures entirely unbounded, which
   * is the cheaper attack of the two and the one that costs the server most.
   *
   * Never inside a caller's transaction: a row that vanished when the surrounding work failed
   * would make the limiter forget exactly the attempts it exists to remember.
   */
  async record(
    policy: AttemptPolicy,
    ip: string | undefined,
    now: Date = new Date(),
  ): Promise<void> {
    const originKey = this.originKey(ip);
    await this.attempts.insertOne({ bucket: policy.bucket, originKey, at: now });

    const since = new Date(now.getTime() - policy.windowMs);
    const recent = await this.attempts.countDocuments({
      bucket: policy.bucket,
      originKey,
      at: { $gte: since },
    });

    if (recent > policy.max) {
      throw new AttemptLimitExceeded(policy.bucket, recent);
    }
  }
}
