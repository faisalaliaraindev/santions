/**
 * Phase C step C1 — the section 6.3 records, against the real replica set.
 *
 * Not unit tests over a mocked collection. Every property under test here is a property of
 * MongoDB's behaviour — a unique index refusing a second insert, a `findOneAndUpdate` being
 * atomic, a transaction discarding both of its writes — and a mock would prove only that the
 * mock was told what to return.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 *
 * Rows referenced below are in `docs/failure-injection-matrix.md`.
 */

import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuditService,
  LocalAuditCheckpointWriter,
} from '../../apps/api/src/persistence/audit.service.js';
import {
  HTTP_IDEMPOTENCY_CHANNEL,
  InboxReceiptService,
  queueChannel,
} from '../../apps/api/src/persistence/inbox-receipt.service.js';
import { OutboxService } from '../../apps/api/src/persistence/outbox.service.js';
import { RetentionService } from '../../apps/api/src/persistence/retention.service.js';
import {
  SourceDocumentService,
  type StorageReference,
} from '../../apps/api/src/persistence/source-document.service.js';
import { StageExecutionService } from '../../apps/api/src/persistence/stage-execution.service.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

let mongo: MongoClient;
let db: Db;

let receipts: InboxReceiptService;
let stages: StageExecutionService;
let outbox: OutboxService;
let documents: SourceDocumentService;
let retention: RetentionService;
let audit: AuditService;
let checkpoints: LocalAuditCheckpointWriter;

/** A fresh tenant per test, so no test can pass because another one left the right state. */
function tenant(): string {
  return `t-persist-${randomUUID()}`;
}

const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
  } catch (error) {
    throw new Error(`${STACK_HINT}\n\nMongoDB connection failed: ${String(error)}`);
  }
  db = mongo.db();

  receipts = new InboxReceiptService(db);
  stages = new StageExecutionService(db);
  outbox = new OutboxService(db);
  documents = new SourceDocumentService(db);
  retention = new RetentionService(db);
  checkpoints = new LocalAuditCheckpointWriter(db);
  audit = new AuditService(db, checkpoints);

  await Promise.all([
    receipts.ensureIndexes(),
    stages.ensureIndexes(),
    outbox.ensureIndexes(),
    documents.ensureIndexes(),
    retention.ensureIndexes(),
    audit.ensureIndexes(),
    checkpoints.ensureIndexes(),
  ]);
}, 60_000);

afterAll(async () => {
  await mongo.close();
});

// --------------------------------------------------------------------------------------------
// InboxReceipt
// --------------------------------------------------------------------------------------------

describe('InboxReceipt — one claim protocol for both channels', () => {
  const claim = (input: {
    tenantId: string;
    channel: string;
    key: string;
    hash: string | null;
  }): Promise<unknown> =>
    receipts.claim({
      tenantId: input.tenantId,
      channel: input.channel,
      key: input.key,
      operation: 'test.operation',
      requestHash: input.hash,
      now: new Date(),
      ttlMs: HOUR,
    });

  it('grants the claim once and reports the duplicate as in flight', async () => {
    const tenantId = tenant();
    const key = randomUUID();

    expect(await claim({ tenantId, channel: HTTP_IDEMPOTENCY_CHANNEL, key, hash: 'h1' })).toEqual({
      kind: 'PROCEED',
    });
    expect(await claim({ tenantId, channel: HTTP_IDEMPOTENCY_CHANNEL, key, hash: 'h1' })).toEqual({
      kind: 'IN_FLIGHT',
    });
  });

  it('gives exactly one winner when identical claims race (T22)', async () => {
    const tenantId = tenant();
    const key = randomUUID();

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        claim({ tenantId, channel: HTTP_IDEMPOTENCY_CHANNEL, key, hash: 'h1' }),
      ),
    );

    const winners = outcomes.filter((o) => (o as { kind: string }).kind === 'PROCEED');
    expect(winners).toHaveLength(1);
  });

  it('replays the recorded result once the claim is completed', async () => {
    const tenantId = tenant();
    const key = randomUUID();
    await claim({ tenantId, channel: HTTP_IDEMPOTENCY_CHANNEL, key, hash: 'h1' });
    await receipts.complete({
      tenantId,
      channel: HTTP_IDEMPOTENCY_CHANNEL,
      key,
      operation: 'test.operation',
      resultId: 'run-1',
      now: new Date(),
    });

    expect(await claim({ tenantId, channel: HTTP_IDEMPOTENCY_CHANNEL, key, hash: 'h1' })).toEqual({
      kind: 'REPLAY',
      resultId: 'run-1',
    });
  });

  it('reports a conflict when the same key carries a different request (T23)', async () => {
    const tenantId = tenant();
    const key = randomUUID();
    await claim({ tenantId, channel: HTTP_IDEMPOTENCY_CHANNEL, key, hash: 'h1' });

    expect(await claim({ tenantId, channel: HTTP_IDEMPOTENCY_CHANNEL, key, hash: 'h2' })).toEqual({
      kind: 'CONFLICT',
    });
  });

  it('keeps the same key independent across tenants and across channels (T23)', async () => {
    const key = randomUUID();
    const alpha = tenant();
    const beta = tenant();

    await claim({ tenantId: alpha, channel: HTTP_IDEMPOTENCY_CHANNEL, key, hash: 'h1' });

    // Another tenant's identical key is a different operation entirely.
    expect(
      await claim({ tenantId: beta, channel: HTTP_IDEMPOTENCY_CHANNEL, key, hash: 'h1' }),
    ).toEqual({ kind: 'PROCEED' });
    // As is the same key seen by a queue consumer rather than by the HTTP layer.
    expect(
      await claim({ tenantId: alpha, channel: queueChannel('worker'), key, hash: null }),
    ).toEqual({ kind: 'PROCEED' });
  });

  it('releases a failed claim so a retry is not blocked by a dead reservation', async () => {
    const tenantId = tenant();
    const key = randomUUID();
    await claim({ tenantId, channel: HTTP_IDEMPOTENCY_CHANNEL, key, hash: 'h1' });
    await receipts.release({
      tenantId,
      channel: HTTP_IDEMPOTENCY_CHANNEL,
      key,
      operation: 'test.operation',
    });

    expect(await claim({ tenantId, channel: HTTP_IDEMPOTENCY_CHANNEL, key, hash: 'h1' })).toEqual({
      kind: 'PROCEED',
    });
  });
});

// --------------------------------------------------------------------------------------------
// StageExecution
// --------------------------------------------------------------------------------------------

describe('StageExecution — identity, leases and fencing', () => {
  const LEASE_MS = 30_000;
  const MAX_EXECUTION_MS = 5 * 60 * 1000;

  it('creates a stage once however many times it is delivered (FI-07)', async () => {
    const tenantId = tenant();
    const runId = randomUUID();

    const created = await Promise.all(
      Array.from({ length: 6 }, () =>
        stages.ensure({
          tenantId,
          runId,
          stageKey: 'FETCH:source-a',
          maxAttempts: 3,
          now: new Date(),
        }),
      ),
    );

    const distinct = new Set(created.map((s) => s.stageExecutionId));
    expect(distinct.size).toBe(1);
    expect(await stages.listForRun(tenantId, runId)).toHaveLength(1);
  });

  it('grants a lease to exactly one of two racing workers', async () => {
    const tenantId = tenant();
    const runId = randomUUID();
    const now = new Date();
    await stages.ensure({ tenantId, runId, stageKey: 'PLAN', maxAttempts: 3, now });

    const [a, b] = await Promise.all([
      stages.acquireLease({
        tenantId,
        runId,
        stageKey: 'PLAN',
        owner: 'worker-a',
        leaseMs: LEASE_MS,
        maxExecutionMs: MAX_EXECUTION_MS,
        now,
      }),
      stages.acquireLease({
        tenantId,
        runId,
        stageKey: 'PLAN',
        owner: 'worker-b',
        leaseMs: LEASE_MS,
        maxExecutionMs: MAX_EXECUTION_MS,
        now,
      }),
    ]);

    const held = [a, b].filter((lease) => lease !== null);
    expect(held).toHaveLength(1);
  });

  it('refuses a stale worker whose lease expired and was taken by another (FI-11)', async () => {
    const tenantId = tenant();
    const runId = randomUUID();
    const start = new Date();
    await stages.ensure({ tenantId, runId, stageKey: 'FETCH:a', maxAttempts: 3, now: start });

    const first = await stages.acquireLease({
      tenantId,
      runId,
      stageKey: 'FETCH:a',
      owner: 'worker-a',
      leaseMs: 1000,
      maxExecutionMs: MAX_EXECUTION_MS,
      now: start,
    });
    expect(first).not.toBeNull();

    // The clock is a parameter, so "the lease expired" is an argument rather than a wait.
    const later = new Date(start.getTime() + 5000);
    const second = await stages.acquireLease({
      tenantId,
      runId,
      stageKey: 'FETCH:a',
      owner: 'worker-b',
      leaseMs: LEASE_MS,
      maxExecutionMs: MAX_EXECUTION_MS,
      now: later,
    });
    expect(second).not.toBeNull();

    // Worker A wakes up and tries to commit its result. It must lose.
    const applied = await stages.completeFenced({
      tenantId,
      stageExecutionId: first!.stageExecutionId,
      leaseToken: first!.leaseToken,
      expectedRevision: first!.revision,
      state: 'SUCCEEDED',
      now: later,
    });

    expect(applied).toBe(false);

    const record = await stages.findByKey(tenantId, runId, 'FETCH:a');
    expect(record?.state).toBe('LEASED');
    expect(record?.leaseOwner).toBe('worker-b');
    // The refusal is visible, not silent.
    expect(record?.discardedAttempts).toBe(1);
  });

  it('lets the current lease holder commit', async () => {
    const tenantId = tenant();
    const runId = randomUUID();
    const now = new Date();
    await stages.ensure({ tenantId, runId, stageKey: 'PLAN', maxAttempts: 3, now });

    const lease = await stages.acquireLease({
      tenantId,
      runId,
      stageKey: 'PLAN',
      owner: 'worker-a',
      leaseMs: LEASE_MS,
      maxExecutionMs: MAX_EXECUTION_MS,
      now,
    });

    // A control: without it, every "refused" assertion above would also pass if commits were
    // simply broken.
    const applied = await stages.completeFenced({
      tenantId,
      stageExecutionId: lease!.stageExecutionId,
      leaseToken: lease!.leaseToken,
      expectedRevision: lease!.revision,
      state: 'SUCCEEDED',
      now,
    });

    expect(applied).toBe(true);
    const record = await stages.findByKey(tenantId, runId, 'PLAN');
    expect(record?.state).toBe('SUCCEEDED');
    expect(record?.completedAt).not.toBeNull();
  });

  it('keeps a cancellation when a late completion arrives (T30, FI-12)', async () => {
    const tenantId = tenant();
    const runId = randomUUID();
    const now = new Date();
    await stages.ensure({ tenantId, runId, stageKey: 'FETCH:a', maxAttempts: 3, now });

    const lease = await stages.acquireLease({
      tenantId,
      runId,
      stageKey: 'FETCH:a',
      owner: 'worker-a',
      leaseMs: LEASE_MS,
      maxExecutionMs: MAX_EXECUTION_MS,
      now,
    });

    const cancelled = await stages.cancelRun({ tenantId, runId, now });
    expect(cancelled).toBe(1);

    const applied = await stages.completeFenced({
      tenantId,
      stageExecutionId: lease!.stageExecutionId,
      leaseToken: lease!.leaseToken,
      expectedRevision: lease!.revision,
      state: 'SUCCEEDED',
      now,
    });

    expect(applied).toBe(false);
    const record = await stages.findByKey(tenantId, runId, 'FETCH:a');
    expect(record?.state).toBe('CANCELLED');
  });

  it('leaves an already-terminal stage untouched by a cancellation', async () => {
    const tenantId = tenant();
    const runId = randomUUID();
    const now = new Date();
    await stages.ensure({ tenantId, runId, stageKey: 'PLAN', maxAttempts: 3, now });
    const lease = await stages.acquireLease({
      tenantId,
      runId,
      stageKey: 'PLAN',
      owner: 'worker-a',
      leaseMs: LEASE_MS,
      maxExecutionMs: MAX_EXECUTION_MS,
      now,
    });
    await stages.completeFenced({
      tenantId,
      stageExecutionId: lease!.stageExecutionId,
      leaseToken: lease!.leaseToken,
      expectedRevision: lease!.revision,
      state: 'SUCCEEDED',
      now,
    });

    await stages.cancelRun({ tenantId, runId, now: new Date(now.getTime() + 1000) });

    // Cancellation does not rewrite history: work that succeeded, succeeded.
    expect((await stages.findByKey(tenantId, runId, 'PLAN'))?.state).toBe('SUCCEEDED');
  });

  it('returns an expired lease to the pool, and abandons it once attempts are spent', async () => {
    const tenantId = tenant();
    const runId = randomUUID();
    const start = new Date();
    await stages.ensure({ tenantId, runId, stageKey: 'FETCH:a', maxAttempts: 2, now: start });

    const first = await stages.acquireLease({
      tenantId,
      runId,
      stageKey: 'FETCH:a',
      owner: 'w1',
      leaseMs: 1000,
      maxExecutionMs: MAX_EXECUTION_MS,
      now: start,
    });

    const after = new Date(start.getTime() + 5000);
    expect(await stages.findExpiredLeases(after, 10)).not.toHaveLength(0);

    expect(
      await stages.reclaimExpiredLease({
        tenantId,
        stageExecutionId: first!.stageExecutionId,
        expiredLeaseToken: first!.leaseToken,
        now: after,
      }),
    ).toBe('RETURNED');
    expect((await stages.findByKey(tenantId, runId, 'FETCH:a'))?.state).toBe('PENDING');

    // Second and final attempt.
    const second = await stages.acquireLease({
      tenantId,
      runId,
      stageKey: 'FETCH:a',
      owner: 'w2',
      leaseMs: 1000,
      maxExecutionMs: MAX_EXECUTION_MS,
      now: after,
    });
    const later = new Date(after.getTime() + 5000);

    expect(
      await stages.reclaimExpiredLease({
        tenantId,
        stageExecutionId: second!.stageExecutionId,
        expiredLeaseToken: second!.leaseToken,
        now: later,
      }),
    ).toBe('ABANDONED');
    expect((await stages.findByKey(tenantId, runId, 'FETCH:a'))?.state).toBe('ABANDONED');
  });

  it('refuses to renew a lease past the execution deadline (REL-01)', async () => {
    const tenantId = tenant();
    const runId = randomUUID();
    const start = new Date();
    await stages.ensure({ tenantId, runId, stageKey: 'PLAN', maxAttempts: 3, now: start });
    const lease = await stages.acquireLease({
      tenantId,
      runId,
      stageKey: 'PLAN',
      owner: 'w1',
      leaseMs: 1000,
      maxExecutionMs: 10_000,
      now: start,
    });

    // Within the deadline: renewal works.
    expect(
      await stages.renewLease({
        tenantId,
        stageExecutionId: lease!.stageExecutionId,
        leaseToken: lease!.leaseToken,
        leaseMs: 1000,
        now: new Date(start.getTime() + 2000),
      }),
    ).not.toBeNull();

    // Past it: a renewal loop must not become an unbounded job.
    expect(
      await stages.renewLease({
        tenantId,
        stageExecutionId: lease!.stageExecutionId,
        leaseToken: lease!.leaseToken,
        leaseMs: 1000,
        now: new Date(start.getTime() + 20_000),
      }),
    ).toBeNull();
  });

  it('scopes every read to the tenant (SEC-01)', async () => {
    const alpha = tenant();
    const beta = tenant();
    const runId = randomUUID();
    const now = new Date();
    await stages.ensure({ tenantId: alpha, runId, stageKey: 'PLAN', maxAttempts: 3, now });

    // Same run ID, different tenant. It must be invisible, not merely filtered afterwards.
    expect(await stages.findByKey(beta, runId, 'PLAN')).toBeNull();
    expect(await stages.listForRun(beta, runId)).toHaveLength(0);
  });
});

// --------------------------------------------------------------------------------------------
// Outbox
// --------------------------------------------------------------------------------------------

describe('OutboxEvent — written inside the transaction, published outside it', () => {
  it('commits the event with the business write, and discards it when the transaction aborts', async () => {
    const tenantId = tenant();
    const aggregateId = randomUUID();
    const session = mongo.startSession();

    // Abort deliberately: the event must not survive a rolled-back business change. This is
    // the property that makes the outbox worth having at all (FI-04).
    try {
      await session.withTransaction(async () => {
        await outbox.append(
          {
            tenantId,
            eventType: 'search.stage.completed',
            aggregateType: 'SearchRun',
            aggregateId,
            aggregateRevision: 2,
            payload: { stageKey: 'PLAN' },
            now: new Date(),
          },
          session,
        );
        throw new Error('deliberate abort');
      });
    } catch {
      // expected
    } finally {
      await session.endSession();
    }

    expect(await outbox.findByAggregate(tenantId, 'SearchRun', aggregateId)).toHaveLength(0);

    // Now the committing case, as the control.
    const committing = mongo.startSession();
    try {
      await committing.withTransaction(async () => {
        await outbox.append(
          {
            tenantId,
            eventType: 'search.stage.completed',
            aggregateType: 'SearchRun',
            aggregateId,
            aggregateRevision: 2,
            payload: { stageKey: 'PLAN' },
            now: new Date(),
          },
          committing,
        );
      });
    } finally {
      await committing.endSession();
    }

    const events = await outbox.findByAggregate(tenantId, 'SearchRun', aggregateId);
    expect(events).toHaveLength(1);
    expect(events[0]?.publishedAt).toBeNull();
    expect(events[0]?.aggregateRevision).toBe(2);
  });

  it('finds due unpublished events and stops finding them once published (FI-04)', async () => {
    const tenantId = tenant();
    const aggregateId = randomUUID();
    const now = new Date();

    const session = mongo.startSession();
    let eventId = '';
    try {
      await session.withTransaction(async () => {
        const appended = await outbox.append(
          {
            tenantId,
            eventType: 'search.completed',
            aggregateType: 'SearchRun',
            aggregateId,
            aggregateRevision: 3,
            payload: {},
            now,
          },
          session,
        );
        eventId = appended.eventId;
      });
    } finally {
      await session.endSession();
    }

    const due = await outbox.findDue(now, 100);
    expect(due.some((e) => e.eventId === eventId)).toBe(true);

    await outbox.markPublished({ tenantId, eventId, now });

    const afterPublish = await outbox.findDue(new Date(now.getTime() + 1000), 500);
    expect(afterPublish.some((e) => e.eventId === eventId)).toBe(false);
  });

  it('counts committed-but-unpublished events, which is the gate check (FI-04)', async () => {
    const tenantId = tenant();
    const now = new Date();
    const before = await outbox.countUnpublished(now);

    const session = mongo.startSession();
    let eventId = '';
    try {
      await session.withTransaction(async () => {
        const appended = await outbox.append(
          {
            tenantId,
            eventType: 'search.completed',
            aggregateType: 'SearchRun',
            aggregateId: randomUUID(),
            aggregateRevision: 1,
            payload: {},
            now,
          },
          session,
        );
        eventId = appended.eventId;
      });
    } finally {
      await session.endSession();
    }

    expect(await outbox.countUnpublished(now)).toBe(before + 1);
    await outbox.markPublished({ tenantId, eventId, now });
    expect(await outbox.countUnpublished(now)).toBe(before);
  });

  it('backs a failed publication off rather than spinning on it', async () => {
    const tenantId = tenant();
    const now = new Date();
    const session = mongo.startSession();
    let eventId = '';
    try {
      await session.withTransaction(async () => {
        const appended = await outbox.append(
          {
            tenantId,
            eventType: 'search.completed',
            aggregateType: 'SearchRun',
            aggregateId: randomUUID(),
            aggregateRevision: 1,
            payload: {},
            now,
          },
          session,
        );
        eventId = appended.eventId;
      });
    } finally {
      await session.endSession();
    }

    await outbox.recordPublishFailure({
      tenantId,
      eventId,
      error: 'queue unreachable',
      nextAttemptAt: new Date(now.getTime() + 60_000),
    });

    expect((await outbox.findDue(now, 500)).some((e) => e.eventId === eventId)).toBe(false);
    expect(
      (await outbox.findDue(new Date(now.getTime() + 61_000), 500)).some(
        (e) => e.eventId === eventId,
      ),
    ).toBe(true);
  });
});

// --------------------------------------------------------------------------------------------
// SourceDocumentVersion
// --------------------------------------------------------------------------------------------

describe('SourceDocumentVersion — verified references only', () => {
  const storage = (now: Date): StorageReference => ({
    bucket: 'evidence-local',
    key: `tenant/region/${randomUUID()}`,
    byteSize: 1024,
    contentType: 'text/html',
    checksumAlgorithm: 'SHA256',
    checksumValue: 'a'.repeat(64),
    verifiedAt: now,
  });

  const commitInput = (tenantId: string, now: Date) => ({
    tenantId,
    sourceId: 'fixture-news',
    publisher: 'Fixture Times',
    sourceUrl: 'https://fixtures.local/article/1',
    canonicalUrl: 'https://fixtures.local/article/1',
    sourceTier: 'TIER_3',
    retrievedAt: { value: now.toISOString(), precision: 'DAY' as const, timezone: 'UTC' },
    contentHash: 'b'.repeat(64),
    storage: storage(now),
    retentionExpiresAt: new Date(now.getTime() + 30 * 24 * HOUR),
    now,
  });

  it('refuses to commit a reference whose object was never verified (FI-03)', async () => {
    const tenantId = tenant();
    const now = new Date();
    const input = commitInput(tenantId, now);

    await expect(
      documents.commit({
        ...input,
        storage: { ...input.storage, verifiedAt: undefined as unknown as Date },
      }),
    ).rejects.toThrow(/never verified/i);
  });

  it('commits as PENDING so an unindexed document is findable (FI-10)', async () => {
    const tenantId = tenant();
    const now = new Date();
    const record = await documents.commit(commitInput(tenantId, now));

    expect(record.indexState).toBe('PENDING');
    expect(record.version).toBe(1);

    const later = new Date(now.getTime() + 10 * 60_000);
    const unindexed = await documents.findUnindexed({ olderThan: later, limit: 500 });
    expect(unindexed.some((d) => d.documentVersionId === record.documentVersionId)).toBe(true);

    await documents.markIndexed({ tenantId, documentVersionId: record.documentVersionId, now });

    const after = await documents.findUnindexed({ olderThan: later, limit: 500 });
    expect(after.some((d) => d.documentVersionId === record.documentVersionId)).toBe(false);
  });

  it('counts a FAILED index write as unindexed, not as resolved', async () => {
    const tenantId = tenant();
    const now = new Date();
    const record = await documents.commit(commitInput(tenantId, now));
    await documents.markIndexFailed({
      tenantId,
      documentVersionId: record.documentVersionId,
      error: 'index rejected the document',
    });

    const later = new Date(now.getTime() + 10 * 60_000);
    const unindexed = await documents.findUnindexed({ olderThan: later, limit: 500 });
    expect(unindexed.some((d) => d.documentVersionId === record.documentVersionId)).toBe(true);
  });

  it('never backfills a missing date with the retrieval time (FR-07)', async () => {
    const tenantId = tenant();
    const now = new Date();
    const record = await documents.commit(commitInput(tenantId, now));

    expect(record.publicationDate).toBeNull();
    expect(record.eventDate).toBeNull();
    expect(record.updateDate).toBeNull();
    expect(record.retrievedAt.value).toBe(now.toISOString());
  });

  it('supersedes the previous version rather than overwriting it', async () => {
    const tenantId = tenant();
    const now = new Date();
    const first = await documents.commit(commitInput(tenantId, now));

    const later = new Date(now.getTime() + HOUR);
    const second = await documents.commit({
      ...commitInput(tenantId, later),
      documentId: first.documentId,
    });

    expect(second.version).toBe(2);
    const reloadedFirst = await documents.findVersion(tenantId, first.documentVersionId);
    expect(reloadedFirst?.supersededAt).not.toBeNull();
  });

  it('lists committed storage keys for the orphan sweep, scoped to the tenant (FI-03)', async () => {
    const alpha = tenant();
    const beta = tenant();
    const now = new Date();
    const record = await documents.commit(commitInput(alpha, now));

    expect(await documents.committedStorageKeys(alpha)).toContain(record.storage.key);
    // A sweep run for another tenant must not see this key as committed — and must therefore
    // never be run across a shared prefix.
    expect(await documents.committedStorageKeys(beta)).not.toContain(record.storage.key);
  });
});

// --------------------------------------------------------------------------------------------
// RetentionAction
// --------------------------------------------------------------------------------------------

describe('RetentionAction — reference first, object second, hold at the delete', () => {
  const schedule = (tenantId: string, now: Date, dueAt: Date) =>
    retention.schedule({
      tenantId,
      targetId: `doc-${randomUUID()}`,
      storageBucket: 'evidence-local',
      storageKey: `tenant/region/${randomUUID()}`,
      dueAt,
      policyBasis: 'D-012 default: 30 days',
      now,
    });

  it('schedules one action per target, however many times it is scheduled', async () => {
    const tenantId = tenant();
    const now = new Date();
    const targetId = `doc-${randomUUID()}`;

    const base = {
      tenantId,
      targetId,
      storageBucket: 'evidence-local',
      storageKey: 'tenant/region/object',
      dueAt: new Date(now.getTime() + 30 * 24 * HOUR),
      policyBasis: 'D-012 default: 30 days',
      now,
    };

    const first = await retention.schedule(base);
    const second = await retention.schedule(base);

    expect(second.retentionActionId).toBe(first.retentionActionId);
  });

  it('does not close the action until the object is actually gone (FI-15)', async () => {
    const tenantId = tenant();
    const now = new Date();
    const action = await schedule(tenantId, now, new Date(now.getTime() - HOUR));

    await retention.markReference({
      tenantId,
      retentionActionId: action.retentionActionId,
      now,
    });

    const marked = await retention.findByTarget(tenantId, action.targetId);
    expect(marked?.state).toBe('REFERENCE_MARKED');
    // Still due: the reference says expired but the object is still there, which is precisely
    // the state that must not be mistaken for done.
    expect((await retention.findDue(now, 500)).some((a) => a.targetId === action.targetId)).toBe(
      true,
    );

    await retention.complete({ tenantId, retentionActionId: action.retentionActionId, now });
    expect((await retention.findByTarget(tenantId, action.targetId))?.state).toBe('COMPLETED');
    expect((await retention.findDue(now, 500)).some((a) => a.targetId === action.targetId)).toBe(
      false,
    );
  });

  it('stops a held action from being swept, and resumes it when the hold is released', async () => {
    const tenantId = tenant();
    const now = new Date();
    const action = await schedule(tenantId, now, new Date(now.getTime() - HOUR));

    await retention.hold({ tenantId, retentionActionId: action.retentionActionId });
    expect((await retention.findDue(now, 500)).some((a) => a.targetId === action.targetId)).toBe(
      false,
    );

    await retention.releaseHold({
      tenantId,
      retentionActionId: action.retentionActionId,
      dueAt: new Date(now.getTime() - HOUR),
    });
    expect((await retention.findDue(now, 500)).some((a) => a.targetId === action.targetId)).toBe(
      true,
    );
  });

  it('surfaces an action overdue past its window as an operator concern, not a silent retry', async () => {
    const tenantId = tenant();
    const now = new Date();
    const action = await schedule(tenantId, now, new Date(now.getTime() - 48 * HOUR));

    const overdue = await retention.findOverdue(now, 24 * HOUR);
    expect(overdue.some((a) => a.targetId === action.targetId)).toBe(true);
  });

  it('reschedules a failed delete rather than losing it', async () => {
    const tenantId = tenant();
    const now = new Date();
    const action = await schedule(tenantId, now, new Date(now.getTime() - HOUR));

    await retention.recordFailure({
      tenantId,
      retentionActionId: action.retentionActionId,
      error: 's3 unreachable',
      retryAt: new Date(now.getTime() + HOUR),
    });

    const reloaded = await retention.findByTarget(tenantId, action.targetId);
    expect(reloaded?.state).toBe('FAILED');
    expect(reloaded?.attempt).toBe(1);
    expect((await retention.findDue(now, 500)).some((a) => a.targetId === action.targetId)).toBe(
      false,
    );
    expect(
      (await retention.findDue(new Date(now.getTime() + 2 * HOUR), 500)).some(
        (a) => a.targetId === action.targetId,
      ),
    ).toBe(true);
  });
});

// --------------------------------------------------------------------------------------------
// AuditEvent — SEC-06
// --------------------------------------------------------------------------------------------

describe('AuditEvent — what the chain detects, and what it does not', () => {
  const entry = (tenantId: string, action: string, now: Date) => ({
    tenantId,
    actor: { type: 'USER' as const, subject: 'reviewer-1', clientId: null },
    action,
    target: { type: 'SearchRun', id: 'run-1', version: 1 },
    reason: 'Reviewed for adverse media.',
    correlationId: randomUUID(),
    result: 'ALLOWED' as const,
    now,
  });

  async function appendEntries(tenantId: string, count: number): Promise<void> {
    const session = mongo.startSession();
    try {
      for (let i = 0; i < count; i += 1) {
        // Separate transactions: each audit entry belongs to its own business change.
        await session.withTransaction(async () => {
          await audit.append(entry(tenantId, `action.${String(i)}`, new Date()), session);
        });
      }
    } finally {
      await session.endSession();
    }
  }

  it('numbers entries gaplessly per tenant and links each to its predecessor', async () => {
    const tenantId = tenant();
    await appendEntries(tenantId, 4);

    const listed = await audit.list({ tenantId, limit: 10 });
    expect(listed.map((e) => e.sequence)).toEqual([4, 3, 2, 1]);

    const verdict = await audit.verifyChain(tenantId);
    expect(verdict.ok).toBe(true);
  });

  it('keeps sequences independent across tenants', async () => {
    const alpha = tenant();
    const beta = tenant();
    await appendEntries(alpha, 3);
    await appendEntries(beta, 1);

    const betaEntries = await audit.list({ tenantId: beta, limit: 10 });
    expect(betaEntries[0]?.sequence).toBe(1);
  });

  it('detects an altered entry (SEC-06)', async () => {
    const tenantId = tenant();
    await appendEntries(tenantId, 3);

    // Tamper directly in the collection, as an attacker with write access would.
    await db
      .collection('auditEvents')
      .updateOne({ tenantId, sequence: 2 }, { $set: { result: 'DENIED' } });

    const verdict = await audit.verifyChain(tenantId);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.problem).toBe('ALTERED_ENTRY');
      expect(verdict.atSequence).toBe(2);
    }
  });

  it('detects a removed entry as a sequence gap (SEC-06)', async () => {
    const tenantId = tenant();
    await appendEntries(tenantId, 3);

    await db.collection('auditEvents').deleteOne({ tenantId, sequence: 2 });

    const verdict = await audit.verifyChain(tenantId);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.problem).toBe('SEQUENCE_GAP');
    }
  });

  it('detects a chain that was rewritten wholesale — only because of the checkpoint', async () => {
    const tenantId = tenant();
    await appendEntries(tenantId, 3);
    await audit.checkpoint(tenantId, new Date());

    // An attacker with the entry writer's access rewrites an entry AND recomputes every hash
    // after it, so the chain is internally consistent again. Without the checkpoint this is
    // undetectable — which is exactly why SEC-06 says a hash chain alone is not sufficient.
    const rewritten = await db
      .collection('auditEvents')
      .find({ tenantId })
      .sort({ sequence: 1 })
      .toArray();
    await db.collection('auditEvents').deleteMany({ tenantId });

    await db
      .collection<{ _id: string; value: number }>('auditSequences')
      .updateOne({ _id: tenantId }, { $set: { value: 0 } });

    // Re-append a shorter, "clean" history with valid internal links.
    await appendEntries(tenantId, rewritten.length - 1);

    const verdict = await audit.verifyChain(tenantId);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.problem).toBe('CHECKPOINT_MISMATCH');
    }
  });

  it('reports how many entries are committed past the last checkpoint (FI-14)', async () => {
    const tenantId = tenant();
    await appendEntries(tenantId, 2);
    await audit.checkpoint(tenantId, new Date());
    expect(await audit.entriesSinceCheckpoint(tenantId)).toBe(0);

    await appendEntries(tenantId, 3);
    expect(await audit.entriesSinceCheckpoint(tenantId)).toBe(3);
  });

  it('records the local checkpoint as unprotected, because it is', async () => {
    const tenantId = tenant();
    await appendEntries(tenantId, 1);
    const written = await audit.checkpoint(tenantId, new Date());

    // The local writer shares MongoDB and its credentials with the entry writer. Recording
    // that honestly is the difference between a seam and a claim. Production supplies a
    // writer whose credentials this process does not hold; G11 verifies it.
    expect(written?.protection).toBe('NONE_LOCAL_STACK');
  });

  it('exposes no way to update or delete an entry', () => {
    // Not enforcement — a raw collection handle elsewhere could still write. It removes the
    // path of least resistance, and makes adding one a visible change rather than a habit.
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(audit));
    expect(methods).not.toContain('update');
    expect(methods).not.toContain('delete');
    expect(methods.filter((m) => /delete|update|remove/i.test(m))).toHaveLength(0);
  });
});
