/**
 * C5 — failure-matrix row **FI-15**: mark the reference expired, then delete the object.
 *
 * This is rule 1 in its other direction. FI-03 forbids committing a reference before the object
 * exists; FI-15 forbids deleting an object before the reference says it is gone. Both prevent
 * the same thing — a live reference to bytes that are not there — approached from opposite ends.
 *
 * The order costs one failure mode and buys the other:
 *
 * - **Mark then delete** (what this does): a crash between the two leaves a reference marked
 *   expired and an object still present. The user sees the evidence reported as expired, which
 *   is true. The sweeper retries the delete until it succeeds.
 * - **Delete then mark** (forbidden): a crash between the two leaves a live reference to a
 *   deleted object. The user follows an evidence link during a review and gets nothing.
 *
 * **A legal hold is checked at the point of the delete, not only at the point of scheduling.**
 * A hold raised after a `RetentionAction` was created must still stop the deletion — otherwise a
 * hold placed the moment litigation starts does not protect the evidence that litigation is
 * about, which is the only time a hold matters.
 *
 * **An action that has not closed within 24 hours is an operator alert, not a silent retry.** An
 * undeleted object past its retention date is a compliance fact, and a job quietly failing for a
 * week is exactly the thing that must not first be discovered by an auditor.
 */

import { Injectable, Logger } from '@nestjs/common';

import { RetentionService } from '../persistence/retention.service.js';
import { SourceDocumentService } from '../persistence/source-document.service.js';

import type { ObjectStorePort } from './object-store.port.js';

/** From the C0 matrix. Past this, an outstanding action is escalated rather than retried quietly. */
export const RETENTION_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

const SWEEP_BATCH = 100;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

export interface RetentionSweepSummary {
  readonly considered: number;
  readonly completed: number;
  readonly held: number;
  readonly failed: number;
}

@Injectable()
export class RetentionSweeper {
  private readonly logger = new Logger('RetentionSweeper');

  constructor(
    private readonly store: ObjectStorePort,
    private readonly retention: RetentionService,
    private readonly documents: SourceDocumentService,
  ) {}

  /**
   * One pass over due retention actions.
   *
   * Batched, so a backlog cannot monopolise the process — which means, exactly as it does for
   * the FI-10 reconciler and the outbox publisher, that **"everything is deleted" is only true
   * after the sweep has run to completion**, and a caller checking that must drain rather than
   * call once. This is the third place that rule applies; see `docs/architecture.md`.
   */
  async sweepOnce(input: {
    readonly now: Date;
    /**
     * Narrow the sweep to one tenant. Omitted by the scheduled sweeper — retention is an
     * obligation across every tenant, and a per-tenant schedule is a list to forget to add to.
     * Passed for a targeted run: an erasure request, or draining one tenant's backlog.
     */
    readonly tenantId?: string | undefined;
    readonly random?: () => number;
  }): Promise<RetentionSweepSummary> {
    const { now, tenantId } = input;
    const random = input.random ?? Math.random;
    const due = await this.retention.findDue(now, SWEEP_BATCH, tenantId);

    let completed = 0;
    let held = 0;
    let failed = 0;

    for (const action of due) {
      // Re-read the document at the point of deletion. The hold on the *record* is the source
      // of truth, not a flag copied onto the action when it was scheduled — a hold raised an
      // hour ago would be invisible to a stale copy.
      const document = await this.documents.findVersion(action.tenantId, action.targetId);

      if (document?.legalHold === true) {
        await this.retention.hold({
          tenantId: action.tenantId,
          retentionActionId: action.retentionActionId,
        });
        held += 1;
        continue;
      }

      try {
        // 1. Mark the reference first. Never the inverse.
        if (action.referenceMarkedAt === null) {
          await this.retention.markReference({
            tenantId: action.tenantId,
            retentionActionId: action.retentionActionId,
            now,
          });
        }

        // 2. Then delete the object. Idempotent, so a retry after a successful-but-unrecorded
        //    delete still closes rather than failing forever on an absent key.
        await this.store.remove(action.storageKey);

        // 3. Only now is the action closed. Confirmed absent, not assumed absent — the whole
        //    point of FI-15 is that "I asked for a delete" is not "the object is gone".
        if ((await this.store.head(action.storageKey)) !== null) {
          throw new Error('the object is still present after the delete returned successfully');
        }

        await this.retention.complete({
          tenantId: action.tenantId,
          retentionActionId: action.retentionActionId,
          now,
        });
        completed += 1;
      } catch (error) {
        // Bounded exponential backoff with full jitter, matching the outbox publisher rather
        // than inventing a second retry policy.
        const backoff = Math.min(BASE_BACKOFF_MS * 2 ** action.attempt, MAX_BACKOFF_MS);
        await this.retention.recordFailure({
          tenantId: action.tenantId,
          retentionActionId: action.retentionActionId,
          error: String(error).slice(0, 500),
          retryAt: new Date(now.getTime() + Math.floor(random() * backoff)),
        });
        failed += 1;
      }
    }

    return { considered: due.length, completed, held, failed };
  }

  /**
   * Retention actions overdue past the alert window.
   *
   * Returned rather than logged and forgotten, so the caller decides what an alert is. Gate G10
   * owns wiring it to something that wakes a person up; recording it here means the signal
   * exists before there is anywhere to send it.
   */
  async overdue(now: Date): Promise<number> {
    const overdue = await this.retention.findOverdue(now, RETENTION_ALERT_WINDOW_MS);
    if (overdue.length > 0) {
      this.logger.error(
        `${String(overdue.length)} retention action(s) have been outstanding for more than 24h. ` +
          'An undeleted object past its retention date is a compliance fact, not a slow job.',
      );
    }
    return overdue.length;
  }
}
