/**
 * `RetentionAction` (section 6.3) — the record that carries out an expiry, and the legal hold
 * that overrides it.
 *
 * D-012 sets evidence retention at 30 days, configurable. What this service adds to "delete it
 * after 30 days" is an ordering and a hold:
 *
 * **Ordering.** Mark the reference expired first, then delete the object (FI-15). The inverse
 * leaves a live reference to a deleted object, which is the same dangling success that FI-03
 * prevents from the other end. An object that outlives its reference is a sweeper's problem;
 * a reference that outlives its object is a lie told to a reviewer.
 *
 * **The hold is checked at the delete, not only at the scheduling.** A hold placed after a
 * `RetentionAction` was created must still stop the deletion — otherwise a legal hold raised
 * on Tuesday does not protect evidence that a job scheduled on Monday is about to remove.
 */

import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { ClientSession, Collection, Db } from 'mongodb';

export const RETENTION_STATES = [
  'SCHEDULED',
  'REFERENCE_MARKED',
  'COMPLETED',
  'HELD',
  'FAILED',
] as const;
export type RetentionState = (typeof RETENTION_STATES)[number];

export interface RetentionActionRecord {
  readonly tenantId: string;
  readonly retentionActionId: string;
  readonly targetType: 'SourceDocumentVersion';
  readonly targetId: string;
  /** The storage object to remove, captured at scheduling so a superseded record still cleans up. */
  readonly storageBucket: string;
  readonly storageKey: string;

  readonly state: RetentionState;
  readonly dueAt: Date;
  readonly policyBasis: string;

  readonly attempt: number;
  readonly lastError: string | null;

  readonly createdAt: Date;
  readonly referenceMarkedAt: Date | null;
  readonly completedAt: Date | null;
}

@Injectable()
export class RetentionService {
  private readonly actions: Collection<RetentionActionRecord>;

  constructor(db: Db) {
    this.actions = db.collection<RetentionActionRecord>('retentionActions');
  }

  async ensureIndexes(): Promise<void> {
    await this.actions.createIndex({ tenantId: 1, retentionActionId: 1 }, { unique: true });
    // One outstanding action per target. A second scheduling of the same expiry is the same
    // expiry, not a second deletion.
    await this.actions.createIndex({ tenantId: 1, targetType: 1, targetId: 1 }, { unique: true });
    // The sweeper's index, cross-tenant (see `docs/architecture.md`).
    await this.actions.createIndex({ state: 1, dueAt: 1 });
  }

  async schedule(input: {
    readonly tenantId: string;
    readonly targetId: string;
    readonly storageBucket: string;
    readonly storageKey: string;
    readonly dueAt: Date;
    readonly policyBasis: string;
    readonly now: Date;
    readonly session?: ClientSession | undefined;
  }): Promise<RetentionActionRecord> {
    const record: RetentionActionRecord = {
      tenantId: input.tenantId,
      retentionActionId: randomUUID(),
      targetType: 'SourceDocumentVersion',
      targetId: input.targetId,
      storageBucket: input.storageBucket,
      storageKey: input.storageKey,
      state: 'SCHEDULED',
      dueAt: input.dueAt,
      policyBasis: input.policyBasis,
      attempt: 0,
      lastError: null,
      createdAt: input.now,
      referenceMarkedAt: null,
      completedAt: null,
    };

    await this.actions.updateOne(
      { tenantId: input.tenantId, targetType: 'SourceDocumentVersion', targetId: input.targetId },
      { $setOnInsert: record },
      { upsert: true, ...withSession(input.session) },
    );

    const stored = await this.actions.findOne(
      { tenantId: input.tenantId, targetType: 'SourceDocumentVersion', targetId: input.targetId },
      withSession(input.session),
    );
    /* c8 ignore next 3 -- the upsert above guarantees a document exists. */
    if (stored === null) {
      throw new Error('Retention action vanished immediately after upsert.');
    }
    return stored;
  }

  /**
   * Due actions, oldest first. Held actions are excluded: a hold is not a delay.
   *
   * `tenantId` is optional and narrows the sweep to one tenant. The scheduled sweeper runs
   * without it, because retention is an obligation across every tenant and a per-tenant
   * schedule would be a list of tenants to forget to add to. It is passed for a targeted run —
   * an erasure request, or draining one tenant's backlog without touching anyone else's.
   */
  async findDue(now: Date, limit: number, tenantId?: string): Promise<RetentionActionRecord[]> {
    return this.actions
      .find({
        state: { $in: ['SCHEDULED', 'REFERENCE_MARKED', 'FAILED'] },
        dueAt: { $lte: now },
        ...(tenantId === undefined ? {} : { tenantId }),
      })
      .sort({ dueAt: 1 })
      .limit(limit)
      .toArray();
  }

  async markReference(input: {
    readonly tenantId: string;
    readonly retentionActionId: string;
    readonly now: Date;
  }): Promise<void> {
    await this.actions.updateOne(
      { tenantId: input.tenantId, retentionActionId: input.retentionActionId },
      { $set: { state: 'REFERENCE_MARKED', referenceMarkedAt: input.now, lastError: null } },
    );
  }

  /** Called only once the object is gone. The action is not closed before that (FI-15). */
  async complete(input: {
    readonly tenantId: string;
    readonly retentionActionId: string;
    readonly now: Date;
  }): Promise<void> {
    await this.actions.updateOne(
      { tenantId: input.tenantId, retentionActionId: input.retentionActionId },
      { $set: { state: 'COMPLETED', completedAt: input.now, lastError: null } },
    );
  }

  async recordFailure(input: {
    readonly tenantId: string;
    readonly retentionActionId: string;
    readonly error: string;
    readonly retryAt: Date;
  }): Promise<void> {
    await this.actions.updateOne(
      { tenantId: input.tenantId, retentionActionId: input.retentionActionId },
      {
        $set: { state: 'FAILED', lastError: input.error, dueAt: input.retryAt },
        $inc: { attempt: 1 },
      },
    );
  }

  /** A hold stops the action where it stands. Releasing it returns the action to the queue. */
  async hold(input: {
    readonly tenantId: string;
    readonly retentionActionId: string;
  }): Promise<void> {
    await this.actions.updateOne(
      { tenantId: input.tenantId, retentionActionId: input.retentionActionId },
      { $set: { state: 'HELD' } },
    );
  }

  async releaseHold(input: {
    readonly tenantId: string;
    readonly retentionActionId: string;
    readonly dueAt: Date;
  }): Promise<void> {
    await this.actions.updateOne(
      { tenantId: input.tenantId, retentionActionId: input.retentionActionId, state: 'HELD' },
      { $set: { state: 'SCHEDULED', dueAt: input.dueAt } },
    );
  }

  /**
   * Actions overdue past their window — an operator alert, not a silent retry.
   *
   * An undeleted object past its retention date is a compliance fact. A job that has been
   * quietly failing for a week is exactly the thing that must not be discovered by an auditor.
   */
  async findOverdue(now: Date, windowMs: number): Promise<RetentionActionRecord[]> {
    return this.actions
      .find({
        state: { $in: ['SCHEDULED', 'REFERENCE_MARKED', 'FAILED'] },
        dueAt: { $lte: new Date(now.getTime() - windowMs) },
      })
      .sort({ dueAt: 1 })
      .toArray();
  }

  async findByTarget(tenantId: string, targetId: string): Promise<RetentionActionRecord | null> {
    return this.actions.findOne({
      tenantId,
      targetType: 'SourceDocumentVersion',
      targetId,
    });
  }
}

function withSession(session: ClientSession | undefined): { session?: ClientSession } {
  return session === undefined ? {} : { session };
}
