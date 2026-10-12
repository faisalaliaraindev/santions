/**
 * `AuditEvent` (section 6.3) and its integrity checkpoint (SEC-06).
 *
 * SEC-06 rules out the obvious implementation before it is written:
 *
 * > Use separately controlled audit-write and audit-read permissions and an independently
 * > protected integrity checkpoint or equivalent tamper-detection mechanism; **a hash chain
 * > stored with the same unrestricted writer is not sufficient by itself.**
 *
 * So this file is deliberately in two parts.
 *
 * **What the chain does.** Each entry carries a per-tenant `sequence` and an `entryHash` over
 * its own content and its predecessor's hash. That makes two things detectable without any
 * external help: an entry **removed** (a gap in the sequence, or a broken link) and an entry
 * **altered** (its recomputed hash no longer matches). `verifyChain` finds both, and SEC-06
 * asks for exactly that to be tested.
 *
 * **What the chain does not do, and this is the point.** An attacker who can write to
 * `auditEvents` can rewrite an entry *and* every entry after it, and recompute the chain. The
 * chain is then internally consistent and the tampering is invisible. Detection requires a
 * checkpoint written by a principal that the entry writer cannot act as — which is a
 * deployment property, not a code property, and it cannot be created by writing more code
 * here.
 *
 * Hence `AuditCheckpointWriter` is a **port**. The local implementation writes to the same
 * MongoDB with the same credentials and **says so in its own name and in what it records**:
 * `protection: 'NONE_LOCAL_STACK'`. It is a working checkpoint for testing gap detection and
 * it is not tamper-evidence. What production must provide is written down in
 * `docs/architecture.md` under "Audit integrity", and gate G11 verifies it — not this phase,
 * and no test here may imply otherwise.
 *
 * **Append-only.** There is no update and no delete method on this service, for any caller,
 * including an administrative one. That is not enforcement — a `db.collection('auditEvents')`
 * elsewhere could still write — but it removes the path of least resistance, and
 * `tests/security/audit-integrity.test.ts` asserts the absence.
 */

import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { ClientSession, Collection, Db } from 'mongodb';

export const AUDIT_RESULTS = ['ALLOWED', 'DENIED', 'ERROR'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export interface AuditActor {
  readonly type: 'USER' | 'MACHINE' | 'SYSTEM';
  readonly subject: string;
  readonly clientId: string | null;
}

export interface AuditTarget {
  readonly type: string;
  readonly id: string;
  readonly version: number | null;
}

export interface AuditEventRecord {
  /** The tenant the action was authorised **against**, which is not always the actor's home. */
  readonly tenantId: string;
  readonly auditEventId: string;
  /** Per-tenant, gapless, monotonic. A gap is the tamper signal SEC-06 asks to detect. */
  readonly sequence: number;

  readonly actor: AuditActor;
  readonly action: string;
  readonly target: AuditTarget;
  /**
   * Why. SEC-05 applies here: record the minimal permitted fact, not a copy of the evidence.
   * An audit trail that duplicates personal data indefinitely is its own retention problem.
   */
  readonly reason: string | null;
  readonly correlationId: string | null;
  readonly result: AuditResult;
  readonly occurredAt: Date;

  readonly previousHash: string;
  readonly entryHash: string;
}

export interface AuditCheckpointRecord {
  readonly tenantId: string;
  readonly sequence: number;
  readonly entryHash: string;
  readonly createdAt: Date;
  /**
   * How well this checkpoint is protected from the writer of the entries it covers.
   * `NONE_LOCAL_STACK` is the honest value for a checkpoint written by the same credentials.
   */
  readonly protection: 'NONE_LOCAL_STACK' | 'SEPARATE_PRINCIPAL' | 'EXTERNAL_NOTARY';
}

/**
 * The seam SEC-06 requires. Production supplies an implementation whose credentials the entry
 * writer does not hold; the local stack supplies one that admits it does not.
 */
export interface AuditCheckpointWriter {
  write(checkpoint: AuditCheckpointRecord): Promise<void>;
  latest(tenantId: string): Promise<AuditCheckpointRecord | null>;
}

export type ChainVerdict =
  | { readonly ok: true; readonly entriesChecked: number; readonly lastSequence: number }
  | {
      readonly ok: false;
      readonly problem: 'SEQUENCE_GAP' | 'BROKEN_LINK' | 'ALTERED_ENTRY' | 'CHECKPOINT_MISMATCH';
      readonly atSequence: number;
      readonly detail: string;
    };

/** The hash of the notional entry before the first one. */
export const GENESIS_HASH = '0'.repeat(64);

interface SequenceCounter {
  readonly _id: string;
  readonly value: number;
}

@Injectable()
export class AuditService {
  private readonly events: Collection<AuditEventRecord>;
  private readonly counters: Collection<SequenceCounter>;

  constructor(
    db: Db,
    private readonly checkpoints: AuditCheckpointWriter,
  ) {
    this.events = db.collection<AuditEventRecord>('auditEvents');
    this.counters = db.collection<SequenceCounter>('auditSequences');
  }

  async ensureIndexes(): Promise<void> {
    await this.events.createIndex({ tenantId: 1, sequence: 1 }, { unique: true });
    await this.events.createIndex({ tenantId: 1, auditEventId: 1 }, { unique: true });
    await this.events.createIndex({ tenantId: 1, occurredAt: -1 });
    await this.events.createIndex({ tenantId: 1, 'target.type': 1, 'target.id': 1 });
    await this.events.createIndex({ correlationId: 1 });
  }

  /**
   * Append an audit entry, inside the caller's transaction.
   *
   * `session` is required. Section 6.3: *commit report state, audit reference and outbox
   * events transactionally.* An audit entry that can fail separately from the action it
   * records is an action that can happen unrecorded, and there is no boundary here to
   * reconcile afterwards — see FI-14, where the only boundary is the checkpoint.
   *
   * Sequence allocation is an `$inc` on a per-tenant counter inside the same transaction. That
   * serialises audited writes per tenant, and the cost is accepted deliberately: a gapless
   * sequence is what makes a removed entry detectable, and a sequence allocated outside the
   * transaction leaves a hole whenever a transaction aborts — which is indistinguishable from
   * a deletion, and so would make the tamper signal useless by crying wolf.
   */
  async append(
    input: {
      readonly tenantId: string;
      readonly actor: AuditActor;
      readonly action: string;
      readonly target: AuditTarget;
      readonly reason?: string | null;
      readonly correlationId?: string | null;
      readonly result: AuditResult;
      readonly now: Date;
    },
    session: ClientSession,
  ): Promise<AuditEventRecord> {
    const counter = await this.counters.findOneAndUpdate(
      { _id: input.tenantId },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: 'after', session },
    );
    /* c8 ignore next 3 -- upsert with returnDocument 'after' always yields a document. */
    if (counter === null) {
      throw new Error('Audit sequence counter did not return a value.');
    }
    const sequence = counter.value;

    const previous =
      sequence === 1
        ? null
        : await this.events.findOne(
            { tenantId: input.tenantId, sequence: sequence - 1 },
            { session },
          );

    const previousHash = previous?.entryHash ?? GENESIS_HASH;

    const base = {
      tenantId: input.tenantId,
      auditEventId: randomUUID(),
      sequence,
      actor: input.actor,
      action: input.action,
      target: input.target,
      reason: input.reason ?? null,
      correlationId: input.correlationId ?? null,
      result: input.result,
      occurredAt: input.now,
      previousHash,
    };

    const record: AuditEventRecord = { ...base, entryHash: hashEntry(base) };
    await this.events.insertOne(record, { session });
    return record;
  }

  /**
   * Verify a tenant's chain, and reconcile it against the latest checkpoint.
   *
   * Detects, in this order: a gap in the sequence, a broken link, an altered entry, and a
   * checkpoint that disagrees with the entry it covers. SEC-06 asks for *unauthorised
   * modification, missing sequence/checkpoint detection* to be tested; these are the four
   * things such a test can observe from inside the system.
   */
  async verifyChain(tenantId: string): Promise<ChainVerdict> {
    const entries = await this.events.find({ tenantId }).sort({ sequence: 1 }).toArray();

    let expectedSequence = 1;
    let expectedPrevious = GENESIS_HASH;

    for (const entry of entries) {
      if (entry.sequence !== expectedSequence) {
        return {
          ok: false,
          problem: 'SEQUENCE_GAP',
          atSequence: expectedSequence,
          detail: `Expected sequence ${String(expectedSequence)}, found ${String(entry.sequence)}.`,
        };
      }
      if (entry.previousHash !== expectedPrevious) {
        return {
          ok: false,
          problem: 'BROKEN_LINK',
          atSequence: entry.sequence,
          detail: 'This entry does not link to its predecessor.',
        };
      }
      if (hashEntry(entry) !== entry.entryHash) {
        return {
          ok: false,
          problem: 'ALTERED_ENTRY',
          atSequence: entry.sequence,
          detail: 'The recorded hash does not match the entry content.',
        };
      }
      expectedSequence += 1;
      expectedPrevious = entry.entryHash;
    }

    const checkpoint = await this.checkpoints.latest(tenantId);
    if (checkpoint !== null) {
      const covered = entries.find((e) => e.sequence === checkpoint.sequence);
      if (covered === undefined || covered.entryHash !== checkpoint.entryHash) {
        return {
          ok: false,
          problem: 'CHECKPOINT_MISMATCH',
          atSequence: checkpoint.sequence,
          detail:
            covered === undefined
              ? 'The checkpointed entry is missing entirely.'
              : 'The checkpointed entry no longer hashes to the checkpointed value.',
        };
      }
    }

    return {
      ok: true,
      entriesChecked: entries.length,
      lastSequence: expectedSequence - 1,
    };
  }

  /**
   * Write a checkpoint over the current head of a tenant's chain.
   *
   * Deliberately outside any transaction: the checkpoint is the one thing that must be written
   * by a different principal, and a transaction shared with the entry writer would defeat the
   * separation before it existed. The boundary this creates — entries committed past the last
   * checkpoint — is FI-14, and it is detectable rather than lossy.
   */
  async checkpoint(tenantId: string, now: Date): Promise<AuditCheckpointRecord | null> {
    const head = await this.events.findOne({ tenantId }, { sort: { sequence: -1 } });
    if (head === null) {
      return null;
    }
    const record: AuditCheckpointRecord = {
      tenantId,
      sequence: head.sequence,
      entryHash: head.entryHash,
      createdAt: now,
      protection: 'NONE_LOCAL_STACK',
    };
    await this.checkpoints.write(record);
    return record;
  }

  /** How many entries have been committed past the last checkpoint (FI-14). */
  async entriesSinceCheckpoint(tenantId: string): Promise<number> {
    const checkpoint = await this.checkpoints.latest(tenantId);
    const from = checkpoint?.sequence ?? 0;
    return this.events.countDocuments({ tenantId, sequence: { $gt: from } });
  }

  async list(input: {
    readonly tenantId: string;
    readonly limit: number;
  }): Promise<AuditEventRecord[]> {
    return this.events
      .find({ tenantId: input.tenantId })
      .sort({ sequence: -1 })
      .limit(input.limit)
      .toArray();
  }
}

/**
 * The local checkpoint writer, named for what it is.
 *
 * It shares MongoDB and its credentials with the audit entry writer, so it satisfies the
 * *mechanism* of SEC-06 and not its *protection*. Every record it writes carries
 * `protection: 'NONE_LOCAL_STACK'`, so no report built from these records can accidentally
 * claim tamper-evidence the deployment does not have.
 */
@Injectable()
export class LocalAuditCheckpointWriter implements AuditCheckpointWriter {
  private readonly checkpoints: Collection<AuditCheckpointRecord>;

  constructor(db: Db) {
    this.checkpoints = db.collection<AuditCheckpointRecord>('auditCheckpoints');
  }

  async ensureIndexes(): Promise<void> {
    await this.checkpoints.createIndex({ tenantId: 1, sequence: -1 }, { unique: true });
  }

  async write(checkpoint: AuditCheckpointRecord): Promise<void> {
    await this.checkpoints.updateOne(
      { tenantId: checkpoint.tenantId, sequence: checkpoint.sequence },
      { $setOnInsert: checkpoint },
      { upsert: true },
    );
  }

  async latest(tenantId: string): Promise<AuditCheckpointRecord | null> {
    return this.checkpoints.findOne({ tenantId }, { sort: { sequence: -1 } });
  }
}

/**
 * The hashed content of an entry.
 *
 * Field order is fixed explicitly rather than taken from `Object.keys`, so that a change to
 * the record's declaration order cannot silently invalidate every stored hash — which would
 * look exactly like mass tampering.
 */
function hashEntry(entry: Omit<AuditEventRecord, 'entryHash'>): string {
  const canonical = JSON.stringify([
    entry.tenantId,
    entry.auditEventId,
    entry.sequence,
    entry.actor.type,
    entry.actor.subject,
    entry.actor.clientId,
    entry.action,
    entry.target.type,
    entry.target.id,
    entry.target.version,
    entry.reason,
    entry.correlationId,
    entry.result,
    entry.occurredAt instanceof Date ? entry.occurredAt.toISOString() : String(entry.occurredAt),
    entry.previousHash,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
