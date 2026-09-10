/**
 * FR-12 — HTTP-layer duplicate control (tests T22, T23).
 *
 * "Tenant/client-scoped idempotency key; same canonical request returns the same operation,
 * changed body returns 409. Handle concurrent submissions atomically."
 *
 * The atomicity matters. Two identical requests arriving together must produce **one**
 * committed operation, and a check-then-insert cannot promise that — both callers can pass the
 * check before either inserts. So the claim is a unique-index insert: exactly one caller wins
 * the race, and the loser reads the winner's result.
 */

import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import { ApiException } from '../common/api-exception.js';

interface IdempotencyRecord {
  /** Tenant-scoped: the same key in two tenants is two independent operations (test T23). */
  readonly tenantId: string;
  readonly key: string;
  readonly operation: string;
  /** SHA-256 of the canonical request body. A changed body under the same key is a 409. */
  readonly requestHash: string;
  readonly resultId: string | null;
  readonly status: 'IN_FLIGHT' | 'COMPLETED';
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  /** Replay window. Documented per section 6.3. */
  readonly expiresAt: Date;
}

/**
 * How long a key is remembered. Expiring a receipt must not let a late duplicate repeat a
 * committed effect — persisted run identity remains the final guard (section 6.3), so this is
 * a convenience window, not the correctness mechanism.
 */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type IdempotencyOutcome =
  | { readonly kind: 'PROCEED' }
  | { readonly kind: 'REPLAY'; readonly resultId: string }
  | { readonly kind: 'IN_FLIGHT' };

@Injectable()
export class IdempotencyService {
  private readonly records: Collection<IdempotencyRecord>;

  constructor(db: Db) {
    this.records = db.collection<IdempotencyRecord>('idempotencyKeys');
  }

  async ensureIndexes(): Promise<void> {
    await this.records.createIndex({ tenantId: 1, key: 1, operation: 1 }, { unique: true });
    await this.records.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  /** Stable hash of the request, so key reuse with a different body is detectable. */
  static hashRequest(body: unknown): string {
    return createHash('sha256').update(canonicalise(body)).digest('hex');
  }

  /**
   * Claim a key, or discover what already holds it.
   *
   * `PROCEED` means this caller won and must go on to `complete()`. `REPLAY` returns the
   * existing result. `IN_FLIGHT` means a concurrent identical request is still working — the
   * caller is told to retry rather than being given a second operation.
   */
  async claim(input: {
    readonly tenantId: string;
    readonly key: string;
    readonly operation: string;
    readonly requestHash: string;
    readonly now: Date;
  }): Promise<IdempotencyOutcome> {
    try {
      await this.records.insertOne({
        tenantId: input.tenantId,
        key: input.key,
        operation: input.operation,
        requestHash: input.requestHash,
        resultId: null,
        status: 'IN_FLIGHT',
        createdAt: input.now,
        completedAt: null,
        expiresAt: new Date(input.now.getTime() + IDEMPOTENCY_WINDOW_MS),
      });
      return { kind: 'PROCEED' };
    } catch (error) {
      // Duplicate key: somebody else holds this key. Read theirs rather than creating a
      // second operation.
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }

    const existing = await this.records.findOne({
      tenantId: input.tenantId,
      key: input.key,
      operation: input.operation,
    });

    if (existing === null) {
      // Expired between the failed insert and this read. Treat as a fresh claim.
      return { kind: 'PROCEED' };
    }

    if (existing.requestHash !== input.requestHash) {
      // T23 — same key, different body. Never silently returns the first result, because the
      // caller clearly meant something else and would be misled by the old one.
      throw new ApiException(
        'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY',
        'This idempotency key was already used with a different request body.',
        { internalDetail: `tenant=${input.tenantId} key=${input.key}` },
      );
    }

    if (existing.status === 'COMPLETED' && existing.resultId !== null) {
      return { kind: 'REPLAY', resultId: existing.resultId };
    }

    return { kind: 'IN_FLIGHT' };
  }

  async complete(input: {
    readonly tenantId: string;
    readonly key: string;
    readonly operation: string;
    readonly resultId: string;
    readonly now: Date;
  }): Promise<void> {
    await this.records.updateOne(
      { tenantId: input.tenantId, key: input.key, operation: input.operation },
      { $set: { status: 'COMPLETED', resultId: input.resultId, completedAt: input.now } },
    );
  }

  /** Release a claim whose work failed, so a retry is not blocked by a dead reservation. */
  async release(input: {
    readonly tenantId: string;
    readonly key: string;
    readonly operation: string;
  }): Promise<void> {
    await this.records.deleteOne({
      tenantId: input.tenantId,
      key: input.key,
      operation: input.operation,
      status: 'IN_FLIGHT',
    });
  }
}

/** Deterministic serialisation: key order must not change the hash. */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);
  return `{${entries.join(',')}}`;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: number }).code === 11000;
}
