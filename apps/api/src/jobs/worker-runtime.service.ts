/**
 * The loop: receive, hand to the consumer, carry out the disposition.
 *
 * Kept apart from `JobConsumer` because the two have different failure modes and different
 * tests. The consumer decides; this executes and keeps going. A loop that also decided would
 * have to be started, fed a real queue and observed from the outside to test any of the
 * decisions — which is how failure-injection suites become slow enough that people stop
 * running them.
 *
 * **Shutdown drains rather than stops.** On a signal the loop stops *receiving* and lets the
 * message in flight finish. Killing it mid-stage is safe — the lease expires and another
 * worker picks it up (FI-11) — but "safe" here costs a whole lease period of latency on every
 * deployment, and a rolling deploy of several workers turns that into a visible stall.
 */

import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import { StageExecutionService } from '../persistence/stage-execution.service.js';
import { JobConsumer, type Disposition } from './job-consumer.js';
import type { QueuePort, ReceivedMessage } from './queue.port.js';

export interface WorkerRuntimeOptions {
  readonly maxMessages: number;
  readonly waitSeconds: number;
  /** Stages swept for an expired lease per pass. Bounded so a backlog cannot monopolise. */
  readonly sweepBatch: number;
}

export const DEFAULT_RUNTIME_OPTIONS: WorkerRuntimeOptions = {
  maxMessages: 10,
  waitSeconds: 20,
  sweepBatch: 50,
};

export interface PollSummary {
  readonly received: number;
  readonly acknowledged: number;
  readonly retried: number;
  readonly deadLettered: number;
}

@Injectable()
export class WorkerRuntime implements OnApplicationShutdown {
  private readonly logger = new Logger('WorkerRuntime');
  private running = false;
  private draining = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly queue: QueuePort,
    private readonly consumer: JobConsumer,
    private readonly stages: StageExecutionService,
    private readonly options: WorkerRuntimeOptions = DEFAULT_RUNTIME_OPTIONS,
  ) {}

  /** One poll. Returns what it did, so a test can assert it rather than wait for it. */
  async pollOnce(now: Date = new Date()): Promise<PollSummary> {
    const messages = await this.queue.receive({
      maxMessages: this.options.maxMessages,
      waitSeconds: this.options.waitSeconds,
    });

    let acknowledged = 0;
    let retried = 0;
    let deadLettered = 0;

    for (const message of messages) {
      const disposition = await this.dispatch(message, now);
      switch (disposition.kind) {
        case 'ACKNOWLEDGE':
          acknowledged += 1;
          break;
        case 'RETRY_LATER':
          retried += 1;
          break;
        case 'DEAD_LETTER':
          deadLettered += 1;
          break;
      }
    }

    return { received: messages.length, acknowledged, retried, deadLettered };
  }

  /**
   * Handle one message and carry out its disposition.
   *
   * The dead-letter is sent **before** the acknowledgement, and that order is the whole point:
   * acknowledging first and then failing to send would delete a message this service had
   * already judged unprocessable, destroying the only evidence of a producer bug or an attempted
   * crossing. Sending first risks a duplicate in the DLQ if the acknowledgement then fails,
   * which costs an operator one extra row to read. One of those failures is recoverable.
   */
  private async dispatch(message: ReceivedMessage, now: Date): Promise<Disposition> {
    let disposition: Disposition;

    try {
      disposition = await this.consumer.handle(message, now);
    } catch (error) {
      // The consumer itself failed — a database outage, typically. Return the message rather
      // than acknowledging it: nothing was decided, so nothing should be consumed.
      this.logger.error(
        `Consumer failed before reaching a decision; the message was returned to the queue.`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.queue.release(message.receiptHandle, 0);
      return { kind: 'RETRY_LATER', delayMs: 0, detail: 'consumer error' };
    }

    switch (disposition.kind) {
      case 'ACKNOWLEDGE':
        await this.queue.acknowledge(message.receiptHandle);
        return disposition;

      case 'RETRY_LATER':
        await this.queue.release(message.receiptHandle, Math.ceil(disposition.delayMs / 1000));
        return disposition;

      case 'DEAD_LETTER':
        await this.consumer.deadLetter(
          this.consumer.letterFor(message, disposition.reason, disposition.detail),
        );
        await this.queue.acknowledge(message.receiptHandle);
        this.logger.error(`Dead-lettered (${disposition.reason}): ${disposition.detail}`);
        return disposition;
    }
  }

  /**
   * Return stages whose worker died (FI-11).
   *
   * Cross-tenant by design: a crashed worker's stage must not stay stuck in whichever tenant
   * nobody happened to sweep. Fenced on the lease token that expired, so a worker that renewed
   * in the meantime is not knocked off its own stage by a sweeper acting on a stale read.
   */
  async sweepExpiredLeases(
    now: Date = new Date(),
  ): Promise<{ returned: number; abandoned: number }> {
    const expired = await this.stages.findExpiredLeases(now, this.options.sweepBatch);

    let returned = 0;
    let abandoned = 0;

    for (const stage of expired) {
      /* c8 ignore next 3 -- findExpiredLeases only returns LEASED stages, which always carry a
         token; the guard is here because a null would otherwise reclaim an unleased stage. */
      if (stage.leaseToken === null) {
        continue;
      }
      const outcome = await this.stages.reclaimExpiredLease({
        tenantId: stage.tenantId,
        stageExecutionId: stage.stageExecutionId,
        expiredLeaseToken: stage.leaseToken,
        now,
      });
      if (outcome === 'RETURNED') {
        returned += 1;
      } else if (outcome === 'ABANDONED') {
        abandoned += 1;
      }
    }

    if (returned > 0 || abandoned > 0) {
      this.logger.warn(
        `Lease sweep: ${String(returned)} returned to the pool, ${String(abandoned)} abandoned.`,
      );
    }

    return { returned, abandoned };
  }

  /**
   * Start polling continuously. Returns immediately; the loop runs until shutdown.
   *
   * Refuses to start with no handlers registered. A handler-less worker is not idle — it
   * receives every queued search and dead-letters it as unroutable, so the process would look
   * healthy while draining the queue into the DLQ. Until a phase registers a handler, the
   * right behaviour is to fail loudly and consume nothing.
   */
  start(): void {
    if (this.consumer.handlerCount() === 0) {
      throw new Error(
        'Refusing to start the worker loop: no job handlers are registered. It would receive ' +
          'every queued message and dead-letter it as unroutable. Register a handler first.',
      );
    }
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.sweepExpiredLeases();
        await this.pollOnce();
      } catch (error) {
        // Never let the loop die. A worker that exits its own loop on a transient error is a
        // worker that looks alive and consumes nothing, which is the failure nobody notices.
        this.logger.error(
          'Poll failed; continuing.',
          error instanceof Error ? error.stack : String(error),
        );
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    this.draining = false;
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!this.running) {
      return;
    }
    this.logger.log(`Draining on ${signal ?? 'shutdown'}: no new messages will be received.`);
    this.running = false;
    this.draining = true;
    await this.loop;
    this.loop = null;
  }

  /** True while the loop is finishing the message it already has. */
  isDraining(): boolean {
    return this.draining;
  }
}
