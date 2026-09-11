/**
 * `InboxReceipt` (section 6.3) — one record for every "have I already done this?" question,
 * whatever asked it.
 *
 * Phase B had this only for HTTP idempotency keys, in a collection called `idempotencyKeys`.
 * A queue consumer needs exactly the same thing for a message identity, and writing a second,
 * subtly different version of it is how two deduplication rules end up disagreeing about what
 * "already done" means. So there is one collection, one claim protocol, and a `channel` that
 * says which conversation the key belongs to.
 *
 * **The receipt is not the guard.** Section 6.3: *expiring a deduplication receipt must not
 * permit a late message to repeat a committed business effect; persisted run/stage identity
 * remains the final guard.* This service makes duplicates cheap to detect. It does not make
 * them impossible — the unique index on `(tenantId, runId, stageKey)` in
 * `StageExecutionService` does that, and it holds after every receipt here has expired.
 * See `docs/failure-injection-matrix.md`, rows FI-07 and FI-09.
 */

import { Injectable } from '@nestjs/common';
import type { ClientSession, Collection, Db } from 'mongodb';

/** HTTP idempotency keys, per FR-12. */
export const HTTP_IDEMPOTENCY_CHANNEL = 'http-idempotency';

/** Queue message identity, per consumer. Two consumers of one message deduplicate separately. */
export function queueChannel(consumer: string): string {
  return `queue:${consumer}`;
}

export interface InboxReceiptRecord {
  /** Tenant-scoped: the same key in two tenants is two independent operations (T23). */
  readonly tenantId: string;
  readonly channel: string;
  readonly key: string;
  readonly operation: string;
  /** SHA-256 of the canonical request, where the channel has one. Null for queue messages. */
  readonly requestHash: string | null;
  readonly resultId: string | null;
  readonly status: 'IN_FLIGHT' | 'COMPLETED';
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  /** Replay window. Documented in `docs/architecture.md`. */
  readonly expiresAt: Date;
}

export type ReceiptOutcome =
  | { readonly kind: 'PROCEED' }
  | { readonly kind: 'REPLAY'; readonly resultId: string }
  | { readonly kind: 'IN_FLIGHT' }
  /** Same key, different request. The caller decides what that means on its channel. */
  | { readonly kind: 'CONFLICT' };

@Injectable()
export class InboxReceiptService {
  private readonly receipts: Collection<InboxReceiptRecord>;

  constructor(db: Db) {
    this.receipts = db.collection<InboxReceiptRecord>('inboxReceipts');
  }

  async ensureIndexes(): Promise<void> {
    await this.receipts.createIndex(
      { tenantId: 1, channel: 1, key: 1, operation: 1 },
      { unique: true },
    );
    await this.receipts.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  /**
   * Claim a key, or discover what already holds it.
   *
   * The claim is a unique-index insert rather than a read followed by a write: two identical
   * requests arriving together can both pass a check, and only one can win an insert (T22).
   *
   * `session` is accepted so that a queue consumer can commit the receipt in the *same*
   * transaction as the effect it deduplicates (FI-09). If they commit separately, a crash
   * between them leaves an effect with no receipt, and the redelivery repeats it.
   */
  async claim(input: {
    readonly tenantId: string;
    readonly channel: string;
    readonly key: string;
    readonly operation: string;
    readonly requestHash: string | null;
    readonly now: Date;
    readonly ttlMs: number;
    readonly session?: ClientSession | undefined;
  }): Promise<ReceiptOutcome> {
    const filter = {
      tenantId: input.tenantId,
      channel: input.channel,
      key: input.key,
      operation: input.operation,
    };

    try {
      await this.receipts.insertOne(
        {
          ...filter,
          requestHash: input.requestHash,
          resultId: null,
          status: 'IN_FLIGHT',
          createdAt: input.now,
          completedAt: null,
          expiresAt: new Date(input.now.getTime() + input.ttlMs),
        },
        withSession(input.session),
      );
      return { kind: 'PROCEED' };
    } catch (error) {
      // Duplicate key: somebody else holds this. Read theirs rather than creating a second
      // operation.
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }

    const existing = await this.receipts.findOne(filter, withSession(input.session));

    if (existing === null) {
      // Expired between the failed insert and this read. A fresh claim is the honest answer;
      // the business-identity guard still prevents a repeated effect.
      return { kind: 'PROCEED' };
    }

    if (input.requestHash !== null && existing.requestHash !== input.requestHash) {
      return { kind: 'CONFLICT' };
    }

    if (existing.status === 'COMPLETED' && existing.resultId !== null) {
      return { kind: 'REPLAY', resultId: existing.resultId };
    }

    return { kind: 'IN_FLIGHT' };
  }

  async complete(input: {
    readonly tenantId: string;
    readonly channel: string;
    readonly key: string;
    readonly operation: string;
    readonly resultId: string;
    readonly now: Date;
    readonly session?: ClientSession | undefined;
  }): Promise<void> {
    await this.receipts.updateOne(
      {
        tenantId: input.tenantId,
        channel: input.channel,
        key: input.key,
        operation: input.operation,
      },
      { $set: { status: 'COMPLETED', resultId: input.resultId, completedAt: input.now } },
      withSession(input.session),
    );
  }

  /** Release a claim whose work failed, so a retry is not blocked by a dead reservation. */
  async release(input: {
    readonly tenantId: string;
    readonly channel: string;
    readonly key: string;
    readonly operation: string;
    readonly session?: ClientSession | undefined;
  }): Promise<void> {
    await this.receipts.deleteOne(
      {
        tenantId: input.tenantId,
        channel: input.channel,
        key: input.key,
        operation: input.operation,
        status: 'IN_FLIGHT',
      },
      withSession(input.session),
    );
  }
}

function withSession(session: ClientSession | undefined): { session?: ClientSession } {
  return session === undefined ? {} : { session };
}

export function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: number }).code === 11000;
}
