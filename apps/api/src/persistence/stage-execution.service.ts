/**
 * `StageExecution` (section 6.3) — the FR-09 pipeline as durable state.
 *
 * This is the record the worker fences on, and it is the record that makes redelivery safe.
 * Two properties carry almost all of the weight:
 *
 * 1. **Stage identity is unique.** `(tenantId, runId, stageKey)` has a unique index. A stage
 *    exists once, however many times its message is delivered. This is the guard section 6.3
 *    means by "persisted run/stage identity remains the final guard" — it holds after every
 *    deduplication receipt has expired, which a receipt cannot (FI-07).
 *
 * 2. **Every advancing write is fenced.** A write carries the lease token it was granted and
 *    the revision it read. A worker that was merely paused long enough for its lease to expire
 *    is indistinguishable from a dead one until it wakes up and writes — so the write, not the
 *    liveness check, is what has to refuse it (REL-01, FI-11, FI-12).
 *
 * Nothing here retries, backs off or classifies: that is C6, over
 * `packages/domain/src/reliability/failure-classification.ts`. This service records outcomes.
 */

import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { ClientSession, Collection, Db } from 'mongodb';

import type { FailureClass } from '@erly/adverse-domain';

import { isDuplicateKeyError } from './inbox-receipt.service.js';

export const STAGE_STATES = [
  'PENDING',
  'LEASED',
  'SUCCEEDED',
  'FAILED',
  'ABANDONED',
  'CANCELLED',
] as const;
export type StageState = (typeof STAGE_STATES)[number];

/** States from which no further work is attempted. A redelivery to one of these is discarded. */
const TERMINAL_STATES: readonly StageState[] = ['SUCCEEDED', 'ABANDONED', 'CANCELLED'];

export function isTerminal(state: StageState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface StageExecutionRecord {
  readonly tenantId: string;
  readonly runId: string;
  /**
   * Stage identity within a run — the FR-09 step, plus whatever makes it unique within the
   * step (a source ID for a fetch, a document ID for an extraction). Caller-supplied and
   * deterministic: if it is not derivable from the work itself, redelivery creates a second
   * stage and the uniqueness guarantee above is worth nothing.
   */
  readonly stageKey: string;
  readonly stageExecutionId: string;
  readonly state: StageState;

  readonly attempt: number;
  readonly maxAttempts: number;

  readonly leaseToken: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  /** REL-01 — long jobs renew their lease, and their total execution is still bounded. */
  readonly executionDeadline: Date | null;

  readonly failureClass: FailureClass | null;
  readonly failureDetail: string | null;
  readonly nextAttemptAt: Date | null;

  /** Optimistic concurrency. Every advancing write checks it and bumps it (T29, T30). */
  readonly revision: number;

  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;

  /**
   * Writes that were refused by the fence. Kept, not discarded silently: "a worker finished
   * work we threw away" is a fact an operator needs, and a reviewer must never see it
   * presented as a finding (FI-12).
   */
  readonly discardedAttempts: number;
}

export interface Lease {
  readonly stageExecutionId: string;
  readonly leaseToken: string;
  readonly revision: number;
  readonly attempt: number;
  readonly leaseExpiresAt: Date;
  readonly executionDeadline: Date;
}

@Injectable()
export class StageExecutionService {
  private readonly stages: Collection<StageExecutionRecord>;

  constructor(db: Db) {
    this.stages = db.collection<StageExecutionRecord>('stageExecutions');
  }

  async ensureIndexes(): Promise<void> {
    // Stage identity. The unique index IS the duplicate-work guard; it is not an optimisation.
    await this.stages.createIndex({ tenantId: 1, runId: 1, stageKey: 1 }, { unique: true });
    await this.stages.createIndex({ tenantId: 1, stageExecutionId: 1 }, { unique: true });
    await this.stages.createIndex({ tenantId: 1, runId: 1, state: 1 });
    // Claim and sweep indexes. These deliberately do NOT lead with tenantId — see
    // `docs/architecture.md`, "Indexes that do not lead with tenant context". A claim that
    // scanned per tenant could not pick the oldest due work across the platform, and fairness
    // between tenants is REL-02's problem, solved in the claim query rather than by an index
    // that makes cross-tenant work invisible.
    await this.stages.createIndex({ state: 1, nextAttemptAt: 1 });
    await this.stages.createIndex({ state: 1, leaseExpiresAt: 1 });
  }

  /**
   * Create a stage if it does not exist; return the existing one if it does.
   *
   * Idempotent by construction rather than by a check: the insert races the unique index and
   * loses gracefully. A `findOne`-then-`insertOne` would let two deliveries both find nothing.
   */
  async ensure(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly stageKey: string;
    readonly maxAttempts: number;
    readonly now: Date;
    readonly session?: ClientSession | undefined;
  }): Promise<StageExecutionRecord> {
    const identity = {
      tenantId: input.tenantId,
      runId: input.runId,
      stageKey: input.stageKey,
    };

    const record: StageExecutionRecord = {
      ...identity,
      stageExecutionId: randomUUID(),
      state: 'PENDING',
      attempt: 0,
      maxAttempts: input.maxAttempts,
      leaseToken: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      executionDeadline: null,
      failureClass: null,
      failureDetail: null,
      nextAttemptAt: input.now,
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
      startedAt: null,
      completedAt: null,
      discardedAttempts: 0,
    };

    try {
      await this.stages.insertOne(record, session(input.session));
      return record;
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }

    const existing = await this.stages.findOne(identity, session(input.session));
    /* c8 ignore next 3 -- a duplicate-key error means the document exists; a null here would
       mean it was deleted between the two statements, which nothing in this service does. */
    if (existing === null) {
      throw new Error(`Stage ${input.stageKey} vanished between insert and read.`);
    }
    return existing;
  }

  /**
   * Take a lease on a stage, if it is available.
   *
   * One atomic `findOneAndUpdate`, so two workers racing for the same stage cannot both win.
   * A lease is available when the stage is `PENDING` and due, or when it is `LEASED` and the
   * previous lease has expired — the second case is the crash-recovery path (FI-11), and it
   * increments the attempt count, because an expired lease means an attempt was made.
   */
  async acquireLease(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly stageKey: string;
    readonly owner: string;
    readonly leaseMs: number;
    readonly maxExecutionMs: number;
    readonly now: Date;
  }): Promise<Lease | null> {
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
    const executionDeadline = new Date(input.now.getTime() + input.maxExecutionMs);

    const claimed = await this.stages.findOneAndUpdate(
      {
        tenantId: input.tenantId,
        runId: input.runId,
        stageKey: input.stageKey,
        $or: [
          { state: 'PENDING', nextAttemptAt: { $lte: input.now } },
          { state: 'LEASED', leaseExpiresAt: { $lte: input.now } },
        ],
      },
      {
        $set: {
          state: 'LEASED',
          leaseToken,
          leaseOwner: input.owner,
          leaseExpiresAt,
          executionDeadline,
          startedAt: input.now,
          updatedAt: input.now,
        },
        $inc: { attempt: 1, revision: 1 },
      },
      { returnDocument: 'after' },
    );

    if (claimed === null) {
      return null;
    }

    return {
      stageExecutionId: claimed.stageExecutionId,
      leaseToken,
      revision: claimed.revision,
      attempt: claimed.attempt,
      leaseExpiresAt,
      executionDeadline,
    };
  }

  /**
   * Extend a lease that is still held.
   *
   * Refuses past the execution deadline: REL-01 requires long jobs to renew safely *and* to
   * have their total execution bounded. A renewal loop with no deadline is an unbounded job
   * wearing a lease.
   */
  async renewLease(input: {
    readonly tenantId: string;
    readonly stageExecutionId: string;
    readonly leaseToken: string;
    readonly leaseMs: number;
    readonly now: Date;
  }): Promise<Date | null> {
    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);

    const renewed = await this.stages.findOneAndUpdate(
      {
        tenantId: input.tenantId,
        stageExecutionId: input.stageExecutionId,
        leaseToken: input.leaseToken,
        state: 'LEASED',
        executionDeadline: { $gt: input.now },
      },
      { $set: { leaseExpiresAt, updatedAt: input.now }, $inc: { revision: 1 } },
      { returnDocument: 'after' },
    );

    return renewed === null ? null : leaseExpiresAt;
  }

  /**
   * Advance a stage to a terminal or retryable state, fenced.
   *
   * Returns `false` when the fence refused the write — the lease is no longer this worker's,
   * or the revision moved underneath it (a cancellation, typically). The refusal is recorded
   * on the record as a discarded attempt so that it is visible rather than silent.
   *
   * The caller must treat `false` as "my result was not applied" and must not retry it. The
   * whole point of a fence is that a stale worker cannot win by trying again.
   */
  async completeFenced(input: {
    readonly tenantId: string;
    readonly stageExecutionId: string;
    readonly leaseToken: string;
    readonly expectedRevision: number;
    readonly state: Extract<StageState, 'SUCCEEDED' | 'FAILED' | 'ABANDONED'>;
    readonly failureClass?: FailureClass | null;
    readonly failureDetail?: string | null;
    readonly nextAttemptAt?: Date | null;
    readonly now: Date;
    readonly session?: ClientSession | undefined;
  }): Promise<boolean> {
    const terminal = input.state !== 'FAILED';

    const updated = await this.stages.findOneAndUpdate(
      {
        tenantId: input.tenantId,
        stageExecutionId: input.stageExecutionId,
        leaseToken: input.leaseToken,
        revision: input.expectedRevision,
        state: 'LEASED',
      },
      {
        $set: {
          state: input.state,
          failureClass: input.failureClass ?? null,
          failureDetail: input.failureDetail ?? null,
          // A FAILED stage is due again; a terminal one never is.
          nextAttemptAt: terminal ? null : (input.nextAttemptAt ?? null),
          leaseToken: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: terminal ? input.now : null,
          updatedAt: input.now,
        },
        $inc: { revision: 1 },
      },
      { returnDocument: 'after', ...session(input.session) },
    );

    if (updated !== null) {
      return true;
    }

    await this.recordDiscardedAttempt(input);
    return false;
  }

  /**
   * Cancel every non-terminal stage of a run.
   *
   * Bumps `revision` and clears the lease, which is what makes a late completion fail its
   * fence (FI-12). Already-terminal stages are left exactly as they are: a cancellation does
   * not rewrite history, and a stage that genuinely succeeded before the cancellation arrived
   * did genuinely succeed.
   */
  async cancelRun(input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly now: Date;
    readonly session?: ClientSession | undefined;
  }): Promise<number> {
    const result = await this.stages.updateMany(
      {
        tenantId: input.tenantId,
        runId: input.runId,
        state: { $in: ['PENDING', 'LEASED', 'FAILED'] },
      },
      {
        $set: {
          state: 'CANCELLED',
          leaseToken: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          completedAt: input.now,
          updatedAt: input.now,
        },
        $inc: { revision: 1 },
      },
      session(input.session),
    );
    return result.modifiedCount;
  }

  async findByKey(
    tenantId: string,
    runId: string,
    stageKey: string,
  ): Promise<StageExecutionRecord | null> {
    return this.stages.findOne({ tenantId, runId, stageKey });
  }

  async listForRun(tenantId: string, runId: string): Promise<StageExecutionRecord[]> {
    return this.stages.find({ tenantId, runId }).sort({ stageKey: 1 }).toArray();
  }

  /**
   * Stages whose lease has expired: the reconciler for FI-11.
   *
   * Cross-tenant by design — it is a platform process, not a tenant-scoped read, and a
   * per-tenant sweep would leave a crashed worker's stage stuck in whichever tenant nobody
   * swept.
   */
  async findExpiredLeases(now: Date, limit: number): Promise<StageExecutionRecord[]> {
    return this.stages
      .find({ state: 'LEASED', leaseExpiresAt: { $lte: now } })
      .sort({ leaseExpiresAt: 1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Return an expired lease to the pool, or abandon it if its attempts are spent.
   *
   * Fenced on the lease token that expired, so a worker that renewed in the meantime is not
   * knocked off its own stage by a sweeper reading a stale list.
   */
  async reclaimExpiredLease(input: {
    readonly tenantId: string;
    readonly stageExecutionId: string;
    readonly expiredLeaseToken: string;
    readonly now: Date;
  }): Promise<'RETURNED' | 'ABANDONED' | 'NOT_APPLICABLE'> {
    const current = await this.stages.findOne({
      tenantId: input.tenantId,
      stageExecutionId: input.stageExecutionId,
      leaseToken: input.expiredLeaseToken,
      state: 'LEASED',
    });

    if (current === null) {
      return 'NOT_APPLICABLE';
    }

    const exhausted =
      current.attempt >= current.maxAttempts ||
      (current.executionDeadline !== null && current.executionDeadline <= input.now);

    const updated = await this.stages.findOneAndUpdate(
      {
        tenantId: input.tenantId,
        stageExecutionId: input.stageExecutionId,
        leaseToken: input.expiredLeaseToken,
        state: 'LEASED',
      },
      {
        $set: exhausted
          ? {
              state: 'ABANDONED' as const,
              failureClass: current.failureClass,
              failureDetail:
                current.failureDetail ?? 'Lease expired and no attempts or time remained.',
              leaseToken: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              nextAttemptAt: null,
              completedAt: input.now,
              updatedAt: input.now,
            }
          : {
              state: 'PENDING' as const,
              leaseToken: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              nextAttemptAt: input.now,
              updatedAt: input.now,
            },
        $inc: { revision: 1 },
      },
      { returnDocument: 'after' },
    );

    if (updated === null) {
      return 'NOT_APPLICABLE';
    }
    return exhausted ? 'ABANDONED' : 'RETURNED';
  }

  /**
   * Record that a fenced write was refused.
   *
   * Unfenced on purpose, and the only unfenced write in this service: it changes no state a
   * result depends on, and it must succeed precisely in the case where the fenced write could
   * not. Losing the count of discarded work because the fence was busy would hide the thing
   * the count exists to show.
   */
  private async recordDiscardedAttempt(input: {
    readonly tenantId: string;
    readonly stageExecutionId: string;
    readonly now: Date;
  }): Promise<void> {
    await this.stages.updateOne(
      { tenantId: input.tenantId, stageExecutionId: input.stageExecutionId },
      { $inc: { discardedAttempts: 1 }, $set: { updatedAt: input.now } },
    );
  }
}

function session(value: ClientSession | undefined): { session?: ClientSession } {
  return value === undefined ? {} : { session: value };
}
