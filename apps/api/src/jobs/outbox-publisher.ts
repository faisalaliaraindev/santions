/**
 * The half of the outbox pattern that turns committed intentions into published messages.
 *
 * The reconciler for FI-04. It polls for events that are committed and unpublished, sends them
 * in batches, and marks what went. Everything about it is shaped by one fact: **it publishes
 * before it marks**. A crash between the two republishes the event (FI-05), which the consumer
 * deduplicates; the reverse order would lose it, and a lost run cannot be recovered by anyone.
 *
 * It is also the thing that makes "we recorded that" true after a crash. Without a publisher
 * the outbox is just a table of regrets.
 */

import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import { OutboxService, type OutboxEventRecord } from '../persistence/outbox.service.js';
import {
  JOB_ENVELOPE_VERSION,
  QUEUE_PORT,
  type JobEnvelope,
  type QueuePort,
} from './queue.port.js';

export interface PublishRunSummary {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

/** How many events one poll will move. Bounded so a backlog cannot monopolise the process. */
const BATCH_SIZE = 50;
const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 5 * 60 * 1000;

/**
 * Backoff for a failed publication: bounded exponential with full jitter.
 *
 * Full jitter matters here for the same reason it does everywhere else in this codebase — if
 * the queue was unreachable, every pending event failed at once, and a fixed backoff would
 * send them all again simultaneously the moment it recovers.
 */
export function republishDelayMs(attempt: number, random: number): number {
  const ceiling = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, attempt));
  return Math.floor(random * ceiling);
}

export function toEnvelope(event: OutboxEventRecord): JobEnvelope {
  return {
    envelopeVersion: JOB_ENVELOPE_VERSION,
    eventId: event.eventId,
    eventType: event.eventType,
    // Routing hint. The consumer verifies ownership against the persisted record (SEC-01).
    tenantId: event.tenantId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateRevision: event.aggregateRevision,
    occurredAt: event.occurredAt.toISOString(),
    correlationId: event.correlationId,
    payload: event.payload,
  };
}

@Injectable()
export class OutboxPublisher implements OnApplicationShutdown {
  private readonly logger = new Logger('OutboxPublisher');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly outbox: OutboxService,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
  ) {}

  /**
   * One poll. Returns what it moved, so a test can assert it rather than wait for it.
   *
   * Publication happens outside any MongoDB transaction, deliberately — a queue cannot join
   * one, and pretending otherwise is what the outbox exists to avoid.
   */
  async publishOnce(now: Date, random: () => number = Math.random): Promise<PublishRunSummary> {
    const due = await this.outbox.findDue(now, BATCH_SIZE);
    if (due.length === 0) {
      return { claimed: 0, published: 0, failed: 0 };
    }

    const byEventId = new Map(due.map((event) => [event.eventId, event]));
    const outcome = await this.queue.publish(due.map(toEnvelope));

    // Mark what went, one at a time. A single `updateMany` would be fewer round trips and
    // would also mark events the queue reported as failed, because a partial batch failure is
    // normal rather than exceptional.
    for (const eventId of outcome.published) {
      const event = byEventId.get(eventId);
      if (event !== undefined) {
        await this.outbox.markPublished({ tenantId: event.tenantId, eventId, now });
      }
    }

    for (const failure of outcome.failed) {
      const event = byEventId.get(failure.eventId);
      if (event === undefined) {
        continue;
      }
      const delay = republishDelayMs(event.attempt + 1, random());
      await this.outbox.recordPublishFailure({
        tenantId: event.tenantId,
        eventId: failure.eventId,
        error: failure.reason.slice(0, 500),
        nextAttemptAt: new Date(now.getTime() + delay),
      });
    }

    if (outcome.failed.length > 0) {
      this.logger.warn(
        `Published ${String(outcome.published.length)} of ${String(due.length)} events; ` +
          `${String(outcome.failed.length)} will be retried.`,
      );
    }

    return {
      claimed: due.length,
      published: outcome.published.length,
      failed: outcome.failed.length,
    };
  }

  /**
   * Start polling.
   *
   * Not started automatically by the module: publishing is a background responsibility, and a
   * process that only serves HTTP requests should not silently also be the publisher of record.
   * `main.ts` starts it; a test drives `publishOnce` directly.
   */
  start(intervalMs: number): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    // Do not keep the process alive purely to poll an empty queue.
    this.timer.unref();
    this.logger.log(`Publishing every ${String(intervalMs)}ms.`);
  }

  private async tick(): Promise<void> {
    // Overlap guard. A slow poll must not have a second one started on top of it: both would
    // claim the same due events and publish them twice for no reason.
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.publishOnce(new Date());
    } catch (error) {
      // Never let a poll failure kill the interval. The events are durable; the next tick
      // tries again.
      this.logger.error(`Publish poll failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
