/**
 * `OutboxEvent` (section 6.3) — events written **inside** the business transaction and
 * published afterwards.
 *
 * The whole design is one sentence: a message queue cannot join a MongoDB transaction, so the
 * intention to publish is written where the transaction can protect it, and a separate poller
 * turns intentions into publications. Section 6.3 requires exactly this ordering — *stage
 * uploads, verify checksums, commit references, then publish through outbox*.
 *
 * Two consequences that are features, not defects:
 *
 * - **At-least-once, never at-most-once.** A crash between publishing and marking published
 *   sends the event twice (FI-05). Marking first would lose it, and a lost run cannot be
 *   recovered, while a duplicate is discarded by the consumer's receipt and by stage identity.
 * - **`append` demands a session.** An outbox event written outside the transaction it belongs
 *   to is just a second write that can fail on its own, which is the failure mode the outbox
 *   exists to remove. The signature makes that mistake impossible rather than discouraged.
 */

import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { ClientSession, Collection, Db } from 'mongodb';

export interface OutboxEventRecord {
  readonly tenantId: string;
  readonly eventId: string;
  readonly eventType: string;
  /** What the event is about: `SearchRun`, `StageExecution`, `SourceDocumentVersion`. */
  readonly aggregateType: string;
  readonly aggregateId: string;
  /**
   * The revision of the aggregate as committed. Carried into the delivery so a receiver can
   * discard an out-of-order delivery rather than applying stale state over new (REL-03, T31).
   */
  readonly aggregateRevision: number;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string | null;
  readonly occurredAt: Date;

  readonly publishedAt: Date | null;
  readonly attempt: number;
  readonly nextAttemptAt: Date;
  readonly lastError: string | null;
}

export interface AppendEventInput {
  readonly tenantId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateRevision: number;
  readonly payload: Record<string, unknown>;
  readonly correlationId?: string | null;
  readonly now: Date;
}

@Injectable()
export class OutboxService {
  private readonly events: Collection<OutboxEventRecord>;

  constructor(db: Db) {
    this.events = db.collection<OutboxEventRecord>('outboxEvents');
  }

  async ensureIndexes(): Promise<void> {
    await this.events.createIndex({ tenantId: 1, eventId: 1 }, { unique: true });
    await this.events.createIndex({ tenantId: 1, aggregateType: 1, aggregateId: 1 });
    // The publisher's claim index. Cross-tenant for the same reason the stage sweeper is:
    // publication is a platform process and must see the oldest due event anywhere. See
    // `docs/architecture.md`, "Indexes that do not lead with tenant context".
    await this.events.createIndex({ publishedAt: 1, nextAttemptAt: 1 });
  }

  /**
   * Append an event to the outbox, in the caller's transaction.
   *
   * `session` is required, not optional. See the note at the top of this file.
   */
  async append(
    input: AppendEventInput,
    session: ClientSession,
  ): Promise<{ readonly eventId: string }> {
    const eventId = randomUUID();
    await this.events.insertOne(
      {
        tenantId: input.tenantId,
        eventId,
        eventType: input.eventType,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        aggregateRevision: input.aggregateRevision,
        payload: input.payload,
        correlationId: input.correlationId ?? null,
        occurredAt: input.now,
        publishedAt: null,
        attempt: 0,
        nextAttemptAt: input.now,
        lastError: null,
      },
      { session },
    );
    return { eventId };
  }

  /**
   * Unpublished events that are due, oldest first.
   *
   * Ordered by `occurredAt` so that events about one aggregate are published in the order they
   * happened. Ordering is not *guaranteed* end to end — REL-03 documents delivery as
   * potentially out of order, and the receiver deduplicates and compares revisions — but
   * publishing them out of order at the source would make that harder for no reason.
   */
  async findDue(now: Date, limit: number): Promise<OutboxEventRecord[]> {
    return this.events
      .find({ publishedAt: null, nextAttemptAt: { $lte: now } })
      .sort({ occurredAt: 1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Mark an event published.
   *
   * Called *after* the publish succeeded. If the process dies in between, the event is
   * published again on the next poll — see FI-05, where that is argued for rather than
   * apologised for.
   */
  async markPublished(input: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly now: Date;
  }): Promise<void> {
    await this.events.updateOne(
      { tenantId: input.tenantId, eventId: input.eventId },
      { $set: { publishedAt: input.now, lastError: null } },
    );
  }

  /** Record a failed publication attempt and when to try again. */
  async recordPublishFailure(input: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly error: string;
    readonly nextAttemptAt: Date;
  }): Promise<void> {
    await this.events.updateOne(
      { tenantId: input.tenantId, eventId: input.eventId },
      {
        $inc: { attempt: 1 },
        $set: { nextAttemptAt: input.nextAttemptAt, lastError: input.error },
      },
    );
  }

  /** Count of committed-but-unpublished events. A gate check, not a metric (FI-04). */
  async countUnpublished(olderThan?: Date): Promise<number> {
    const filter: Record<string, unknown> = { publishedAt: null };
    if (olderThan !== undefined) {
      filter['occurredAt'] = { $lte: olderThan };
    }
    return this.events.countDocuments(filter);
  }

  async findByAggregate(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
  ): Promise<OutboxEventRecord[]> {
    return this.events
      .find({ tenantId, aggregateType, aggregateId })
      .sort({ occurredAt: 1 })
      .toArray();
  }
}
