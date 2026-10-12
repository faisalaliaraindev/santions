/**
 * Environment-scoped API keys (FR-15 seam, test T68).
 *
 * Four decisions here are load-bearing:
 *
 *  1. **The secret is returned exactly once, at creation, and never stored.** Only a hash is
 *     persisted, so a database dump — or an operator with read access — cannot authenticate as
 *     a tenant. There is deliberately no method that returns a secret, because an API that can
 *     show a key again is an API that will be asked to.
 *  2. **The key carries its environment in its own identifier**, and that environment becomes
 *     the principal's. A `sandbox` key can never reach live data whatever its roles say, and
 *     the check lives in the domain's `decideAccess`, not here (FR-15, test T62).
 *  3. **Rotation and revocation are audited**, with an actor and a reason. An unexplained
 *     revocation is indistinguishable from an outage when someone investigates it later.
 *  4. **Rotation issues a new secret and keeps the key's identity**, so the tenant's
 *     configuration does not change — and the old secret stops working immediately. A rotation
 *     that leaves the previous secret valid is not a rotation.
 *  5. **Disabling and revoking are different fields, and must stay that way.** `disabledAt` is
 *     a reversible off switch for a paused integration or a rotation window; `revokedAt` is
 *     permanent, for a secret that has leaked. Collapse them into one field and either a leaked
 *     key becomes switch-back-on-able or a routine pause becomes irreversible — both wrong, in
 *     opposite directions, and no single field is right about both. `verify()` refuses either
 *     state; only one of them can be undone.
 *
 * Tenant self-service management of these keys is deferred by decision D-007; the reserved
 * route answers 501. This is the service the provider-side path uses in the meantime.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import { isRole, type Principal, type Role } from '@adverse-search/domain';

export type KeyEnvironment = 'sandbox' | 'live';

/** What happened to a key. Every one of these is written to the audit collection. */
export type ApiKeyEvent = 'CREATED' | 'ROTATED' | 'DISABLED' | 'ENABLED' | 'REVOKED';

export interface ApiKeyRecord {
  /** Public half of the credential. Safe to log, display and index on. */
  readonly keyId: string;
  readonly tenantId: string;
  readonly environment: KeyEnvironment;
  /**
   * SHA-256 of the secret.
   *
   * A password hash (bcrypt, argon2) exists to slow brute force against low-entropy input.
   * This secret is 32 bytes of CSPRNG output, so there is nothing to brute force, and a slow
   * hash would only add latency to every machine request.
   */
  readonly secretHash: string;
  readonly label: string;
  readonly roles: readonly Role[];
  readonly scopes: readonly string[];
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly rotatedAt: Date | null;
  /**
   * Switched off, reversibly. Distinct from `revokedAt` on purpose — see decision 5 above.
   *
   * Optional in the type, not because a new record may omit it — `create` always writes it —
   * but because records written before this field existed do not have it. Every read goes
   * through `disabledAtOf`, which reads a missing field as "not disabled" rather than as the
   * `undefined !== null` that would refuse every key issued before today.
   */
  readonly disabledAt?: Date | null;
  readonly disabledReason?: string | null;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

/** A missing `disabledAt` — an older record — means the key was never disabled. */
function disabledAtOf(record: Pick<ApiKeyRecord, 'disabledAt'>): Date | null {
  return record.disabledAt ?? null;
}

export interface ApiKeyAuditRecord {
  readonly keyId: string;
  readonly tenantId: string;
  readonly event: ApiKeyEvent;
  readonly actor: string;
  readonly reason: string | null;
  readonly at: Date;
}

/** The only shape that ever carries a plaintext secret, and only as a return value. */
export interface IssuedApiKey {
  readonly keyId: string;
  /** Shown once. Not recoverable — if it is lost, rotate. */
  readonly secret: string;
  readonly environment: KeyEnvironment;
  readonly expiresAt: Date | null;
}

export type ApiKeyRejection =
  'MALFORMED' | 'UNKNOWN' | 'BAD_SECRET' | 'REVOKED' | 'DISABLED' | 'EXPIRED' | 'NO_ROLES';

export class ApiKeyError extends Error {
  readonly rejection: ApiKeyRejection;

  constructor(rejection: ApiKeyRejection, message: string) {
    super(message);
    this.name = 'ApiKeyError';
    this.rejection = rejection;
  }
}

/**
 * `erly_<environment>_<keyId>_<secret>`.
 *
 * The environment is visible in the credential on purpose: an operator who pastes a live key
 * into a sandbox configuration can see the mistake, and so can a log line that recorded the
 * prefix. The key ID is there so verification is a single indexed lookup rather than hashing
 * the presented secret against every key the tenant owns.
 */
const PREFIX = 'erly';
const KEY_PATTERN = /^erly_(sandbox|live)_([A-Za-z0-9]{16})_([A-Za-z0-9_-]{43})$/u;

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

@Injectable()
export class ApiKeyService {
  private readonly keys: Collection<ApiKeyRecord>;
  private readonly audit: Collection<ApiKeyAuditRecord>;

  // Collection names follow the section 6.3 record names in camelCase plural, as every other
  // collection here does. `ApiKeyCredential` is the record; this is where it lives.
  constructor(db: Db) {
    this.keys = db.collection<ApiKeyRecord>('apiKeyCredentials');
    this.audit = db.collection<ApiKeyAuditRecord>('apiKeyAuditEvents');
  }

  async ensureIndexes(): Promise<void> {
    await this.keys.createIndex({ keyId: 1 }, { unique: true });
    await this.keys.createIndex({ tenantId: 1, environment: 1 });
    await this.audit.createIndex({ keyId: 1, at: -1 });
  }

  /** Issue a key. The returned secret is the only time it exists outside the caller. */
  async create(input: {
    readonly tenantId: string;
    readonly environment: KeyEnvironment;
    readonly label: string;
    readonly roles: readonly Role[];
    readonly scopes: readonly string[];
    readonly createdBy: string;
    readonly expiresAt?: Date | null;
    readonly now?: Date;
  }): Promise<IssuedApiKey> {
    const now = input.now ?? new Date();
    const keyId = randomBytes(8).toString('hex');
    const secret = randomBytes(32).toString('base64url');
    const expiresAt = input.expiresAt ?? null;

    await this.keys.insertOne({
      keyId,
      tenantId: input.tenantId,
      environment: input.environment,
      secretHash: hashSecret(secret),
      label: input.label,
      roles: input.roles,
      scopes: input.scopes,
      createdAt: now,
      createdBy: input.createdBy,
      expiresAt,
      lastUsedAt: null,
      rotatedAt: null,
      disabledAt: null,
      disabledReason: null,
      revokedAt: null,
      revokedReason: null,
    });

    await this.record(keyId, input.tenantId, 'CREATED', input.createdBy, input.label, now);

    return {
      keyId,
      secret: `${PREFIX}_${input.environment}_${keyId}_${secret}`,
      environment: input.environment,
      expiresAt,
    };
  }

  /**
   * Verify a presented key and derive the principal.
   *
   * Updates `lastUsedAt`, which is what makes an unused key identifiable and therefore
   * revocable. Every failure raises, and the caller maps all of them to one opaque 401 —
   * distinguishing "unknown key" from "wrong secret" tells an attacker which half to work on.
   */
  async verify(presented: string | undefined, now: Date = new Date()): Promise<Principal> {
    if (presented === undefined) {
      throw new ApiKeyError('MALFORMED', 'No API key presented.');
    }

    const match = KEY_PATTERN.exec(presented.trim());
    const environment = match?.[1];
    const keyId = match?.[2];
    const secret = match?.[3];
    if (environment === undefined || keyId === undefined || secret === undefined) {
      throw new ApiKeyError('MALFORMED', 'API key is not in the expected form.');
    }

    const record = await this.keys.findOne({ keyId });
    if (record === null) {
      throw new ApiKeyError('UNKNOWN', 'API key is not recognised.');
    }

    // Constant-time, and length-checked first: `timingSafeEqual` throws on a length mismatch.
    const expected = Buffer.from(record.secretHash);
    const actual = Buffer.from(hashSecret(secret));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ApiKeyError('BAD_SECRET', 'API key secret does not match.');
    }

    // The environment in the credential must agree with the stored one. A mismatch means the
    // string was edited — most plausibly a sandbox key rewritten to say `live`.
    if (record.environment !== environment) {
      throw new ApiKeyError('BAD_SECRET', 'API key environment does not match the stored key.');
    }

    if (record.revokedAt !== null) {
      throw new ApiKeyError('REVOKED', 'API key has been revoked.');
    }
    if (record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()) {
      throw new ApiKeyError('EXPIRED', 'API key has expired.');
    }
    // A disabled key is refused exactly as a revoked one is. The difference between them is
    // not what they do to a request — it is that this one can be undone. Checked after expiry
    // so that the internal detail names the reason the holder would have to act on first, the
    // same order the listing's `status` uses.
    if (disabledAtOf(record) !== null) {
      throw new ApiKeyError('DISABLED', 'API key is disabled.');
    }

    const roles = record.roles.filter((role): role is Role => isRole(role));
    if (roles.length === 0) {
      throw new ApiKeyError('NO_ROLES', 'API key carries no role this service recognises.');
    }

    await this.keys.updateOne({ keyId: record.keyId }, { $set: { lastUsedAt: now } });

    return {
      subject: `api-key:${record.keyId}`,
      kind: 'MACHINE',
      tenantId: record.tenantId,
      roles,
      scopes: [...record.scopes],
      environment: record.environment,
      breakGlass: null,
    };
  }

  /**
   * Replace the secret, keeping the key's identity, roles, scopes and environment.
   *
   * The previous secret stops working the moment this returns. There is no grace period: a
   * rotation with an overlap window is a second live credential, and the reason to rotate is
   * usually that the first one should not be live any more.
   */
  async rotate(input: {
    readonly keyId: string;
    readonly actor: string;
    readonly reason: string;
    readonly now?: Date;
  }): Promise<IssuedApiKey> {
    const now = input.now ?? new Date();
    const record = await this.keys.findOne({ keyId: input.keyId });
    if (record === null) {
      throw new ApiKeyError('UNKNOWN', 'API key is not recognised.');
    }
    if (record.revokedAt !== null) {
      // Rotating a revoked key would quietly bring it back.
      throw new ApiKeyError('REVOKED', 'A revoked key cannot be rotated. Issue a new one.');
    }
    // A *disabled* key may be rotated, and stays disabled afterwards. Rotating while paused is
    // the ordinary sequence — disable, replace the secret, enable — and refusing it would push
    // the tenant to revoke and re-issue instead, which changes the key id their configuration
    // holds. Rotation only replaces the secret; it never flips `disabledAt` back.

    const secret = randomBytes(32).toString('base64url');
    await this.keys.updateOne(
      { keyId: record.keyId },
      { $set: { secretHash: hashSecret(secret), rotatedAt: now } },
    );

    await this.record(record.keyId, record.tenantId, 'ROTATED', input.actor, input.reason, now);

    return {
      keyId: record.keyId,
      secret: `${PREFIX}_${record.environment}_${record.keyId}_${secret}`,
      environment: record.environment,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Switch a key off, reversibly. It stops authenticating immediately.
   *
   * For a paused integration, a rotation window, or a key someone is unsure about but has no
   * evidence has leaked. For a key that *has* leaked, use `revoke` — this one can be undone,
   * and that is the whole difference.
   *
   * Idempotent: disabling an already-disabled key changes nothing and writes no second audit
   * entry, so the trail keeps saying when it actually went off rather than when someone last
   * clicked. A **revoked** key cannot be disabled — it is already permanently off, and
   * accepting the call would suggest `enable` could bring it back.
   */
  async disable(input: {
    readonly keyId: string;
    readonly actor: string;
    readonly reason: string;
    readonly now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();
    const record = await this.keys.findOne({ keyId: input.keyId });
    if (record === null) {
      throw new ApiKeyError('UNKNOWN', 'API key is not recognised.');
    }
    if (record.revokedAt !== null) {
      throw new ApiKeyError('REVOKED', 'A revoked key is already permanently off.');
    }
    if (disabledAtOf(record) !== null) {
      return;
    }

    await this.keys.updateOne(
      { keyId: record.keyId },
      { $set: { disabledAt: now, disabledReason: input.reason } },
    );
    await this.record(record.keyId, record.tenantId, 'DISABLED', input.actor, input.reason, now);
  }

  /**
   * Switch a disabled key back on. The same secret works again the moment this returns.
   *
   * That is what makes it the wrong tool for a leak, and why `revokedAt` is a separate field
   * this method cannot touch: a revoked key is refused here rather than resurrected.
   *
   * Enabling clears `disabledReason` along with `disabledAt` — the record of *why* it was off
   * lives in the audit trail, which keeps both events; leaving a stale reason on a working key
   * would read as though it were still disabled.
   */
  async enable(input: {
    readonly keyId: string;
    readonly actor: string;
    readonly reason: string;
    readonly now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();
    const record = await this.keys.findOne({ keyId: input.keyId });
    if (record === null) {
      throw new ApiKeyError('UNKNOWN', 'API key is not recognised.');
    }
    if (record.revokedAt !== null) {
      throw new ApiKeyError('REVOKED', 'A revoked key cannot be enabled. Issue a new one.');
    }
    if (disabledAtOf(record) === null) {
      return; // Already on. Idempotent, and no audit entry for a change that did not happen.
    }

    await this.keys.updateOne(
      { keyId: record.keyId },
      { $set: { disabledAt: null, disabledReason: null } },
    );
    await this.record(record.keyId, record.tenantId, 'ENABLED', input.actor, input.reason, now);
  }

  /**
   * Revoke immediately and permanently. A revoked key is never un-revoked.
   *
   * A disabled key can still be revoked — "paused" turning out to be "compromised" is exactly
   * the path this has to support. `disabledAt` is left as it was: it is a record of what
   * happened, and revocation does not un-happen it.
   */
  async revoke(input: {
    readonly keyId: string;
    readonly actor: string;
    readonly reason: string;
    readonly now?: Date;
  }): Promise<void> {
    const now = input.now ?? new Date();
    const record = await this.keys.findOne({ keyId: input.keyId });
    if (record === null) {
      throw new ApiKeyError('UNKNOWN', 'API key is not recognised.');
    }
    if (record.revokedAt !== null) {
      return; // Already revoked. Idempotent, and no second audit entry to mislead a reader.
    }

    await this.keys.updateOne(
      { keyId: record.keyId },
      { $set: { revokedAt: now, revokedReason: input.reason } },
    );
    await this.record(record.keyId, record.tenantId, 'REVOKED', input.actor, input.reason, now);
  }

  /**
   * Keys a tenant holds, for an operator to review.
   *
   * `secretHash` is projected away. Not because the hash is usable — it is not — but because a
   * field that looks like a credential ends up in a log, a screenshot or a support ticket.
   */
  async listForTenant(tenantId: string): Promise<Omit<ApiKeyRecord, 'secretHash'>[]> {
    return this.keys
      .find({ tenantId }, { projection: { secretHash: 0, _id: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
  }

  /** The audit trail for one key, newest first (test T68). */
  async auditFor(keyId: string): Promise<ApiKeyAuditRecord[]> {
    return this.audit
      .find({ keyId }, { projection: { _id: 0 } })
      .sort({ at: -1 })
      .toArray();
  }

  private async record(
    keyId: string,
    tenantId: string,
    event: ApiKeyEvent,
    actor: string,
    reason: string | null,
    at: Date,
  ): Promise<void> {
    await this.audit.insertOne({ keyId, tenantId, event, actor, reason, at });
  }
}
