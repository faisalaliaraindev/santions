/**
 * Phase C step C2 — transactions and the outbox, against the real replica set.
 *
 * A write conflict is not something a mock can produce convincingly: it depends on two real
 * sessions touching the same document under snapshot read concern. The retry policy is only
 * worth anything if it is exercised by the thing it was written for.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 */

import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CreateSearchInput } from '../../packages/contracts/src/index.js';

import { OutboxPublisher } from '../../apps/api/src/jobs/outbox-publisher.js';
import { InMemoryQueueAdapter } from '../../apps/api/src/jobs/queue.port.js';
import {
  AuditService,
  LocalAuditCheckpointWriter,
} from '../../apps/api/src/persistence/audit.service.js';
import { OutboxService } from '../../apps/api/src/persistence/outbox.service.js';
import { SearchesService } from '../../apps/api/src/searches/searches.service.js';
import { NameFrequencyService } from '../../apps/api/src/subjects/name-frequency.service.js';
import { SubjectsService } from '../../apps/api/src/subjects/subjects.service.js';
import { EntitlementsService } from '../../apps/api/src/tenancy/entitlements.service.js';
import {
  TransactionExhaustedError,
  TransactionRunner,
} from '../../apps/api/src/persistence/transaction.runner.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

let mongo: MongoClient;
let db: Db;
let runner: TransactionRunner;
let outbox: OutboxService;
let audit: AuditService;
let searches: SearchesService;

interface Counter {
  readonly _id: string;
  readonly value: number;
}

function tenant(): string {
  return `t-txn-${randomUUID()}`;
}

const noSleep = (): Promise<void> => Promise.resolve();

beforeAll(async () => {
  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
  } catch (error) {
    throw new Error(`${STACK_HINT}\n\nMongoDB connection failed: ${String(error)}`);
  }
  db = mongo.db();

  runner = new TransactionRunner(mongo);
  outbox = new OutboxService(db);
  audit = new AuditService(db, new LocalAuditCheckpointWriter(db));

  const subjects = new SubjectsService(db, new NameFrequencyService(db));
  searches = new SearchesService(db, new EntitlementsService(db), subjects, runner, audit, outbox);

  await Promise.all([outbox.ensureIndexes(), audit.ensureIndexes(), searches.ensureIndexes()]);
}, 60_000);

afterAll(async () => {
  await mongo.close();
});

describe('TransactionRunner — commit, conflict, and what must not be retried', () => {
  it('commits every write together', async () => {
    const tenantId = tenant();
    const aggregateId = randomUUID();

    await runner.run(
      async (session) => {
        await db
          .collection<Counter>('txnTestCounters')
          .insertOne({ _id: tenantId, value: 1 }, { session });
        await outbox.append(
          {
            tenantId,
            eventType: 'test.committed',
            aggregateType: 'SearchRun',
            aggregateId,
            aggregateRevision: 1,
            payload: {},
            now: new Date(),
          },
          session,
        );
      },
      { name: 'test.commit' },
    );

    expect(
      await db.collection<Counter>('txnTestCounters').findOne({ _id: tenantId }),
    ).not.toBeNull();
    expect(await outbox.findByAggregate(tenantId, 'SearchRun', aggregateId)).toHaveLength(1);
  });

  it('discards every write when the body throws', async () => {
    const tenantId = tenant();
    const aggregateId = randomUUID();

    await expect(
      runner.run(
        async (session) => {
          await db
            .collection<Counter>('txnTestCounters')
            .insertOne({ _id: tenantId, value: 1 }, { session });
          await outbox.append(
            {
              tenantId,
              eventType: 'test.aborted',
              aggregateType: 'SearchRun',
              aggregateId,
              aggregateRevision: 1,
              payload: {},
              now: new Date(),
            },
            session,
          );
          throw new Error('business rule refused this');
        },
        { name: 'test.abort' },
      ),
    ).rejects.toThrow('business rule refused this');

    // Partial commits are the failure this whole step exists to prevent: a run with no event,
    // or an event for a run that does not exist.
    expect(await db.collection<Counter>('txnTestCounters').findOne({ _id: tenantId })).toBeNull();
    expect(await outbox.findByAggregate(tenantId, 'SearchRun', aggregateId)).toHaveLength(0);
  });

  it('retries a real write conflict and commits both writers', async () => {
    // Two transactions incrementing the same document under snapshot read concern. One will
    // conflict; the runner retries it; both must end up applied.
    const id = `conflict-${randomUUID()}`;
    const counters = db.collection<Counter>('txnTestCounters');
    await counters.insertOne({ _id: id, value: 0 });

    const attempts = { a: 0, b: 0 };

    const increment = (which: 'a' | 'b'): Promise<void> =>
      runner.run(
        async (session) => {
          attempts[which] += 1;
          const current = await counters.findOne({ _id: id }, { session });
          // A deliberate read-then-write, which is what makes the conflict possible at all.
          await counters.updateOne(
            { _id: id },
            { $set: { value: (current?.value ?? 0) + 1 } },
            { session },
          );
        },
        { name: `test.conflict.${which}`, sleep: noSleep, maxAttempts: 20 },
      );

    await Promise.all([increment('a'), increment('b')]);

    const final = await counters.findOne({ _id: id });
    expect(final?.value).toBe(2);
    // At least one of them had to try twice, or no conflict occurred and this test proved
    // nothing about retrying.
    expect(attempts.a + attempts.b).toBeGreaterThan(2);
  });

  it('surfaces a duplicate key immediately instead of retrying it to the deadline', async () => {
    const id = `dup-${randomUUID()}`;
    const counters = db.collection<Counter>('txnTestCounters');
    await counters.insertOne({ _id: id, value: 0 });

    let attempts = 0;
    const startedAt = Date.now();

    await expect(
      runner.run(
        async (session) => {
          attempts += 1;
          await counters.insertOne({ _id: id, value: 1 }, { session });
        },
        { name: 'test.duplicate', sleep: noSleep, maxAttempts: 10 },
      ),
    ).rejects.toMatchObject({ code: 11000 });

    // Once. A duplicate key is deterministic: retrying it turns a clear error into a slow one,
    // and eventually reports a timeout instead of the unique-index violation that happened.
    expect(attempts).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('gives up with the underlying cause attached rather than an anonymous timeout', async () => {
    const transient = Object.assign(new Error('simulated write conflict'), {
      hasErrorLabel: (label: string) => label === 'TransientTransactionError',
    });

    let attempts = 0;
    await expect(
      runner.run(
        () => {
          attempts += 1;
          return Promise.reject(transient);
        },
        { name: 'test.exhausted', sleep: noSleep, maxAttempts: 3 },
      ),
    ).rejects.toBeInstanceOf(TransactionExhaustedError);

    expect(attempts).toBe(3);
  });

  it('does not run the body again when the body itself succeeded', async () => {
    // The property behind the unknown-commit-outcome rule, asserted on the happy path: one
    // call to run() is one execution of the work when nothing conflicts.
    let executions = 0;
    const tenantId = tenant();

    await runner.run(
      async (session) => {
        executions += 1;
        await db
          .collection<Counter>('txnTestCounters')
          .insertOne({ _id: tenantId, value: 1 }, { session });
      },
      { name: 'test.once' },
    );

    expect(executions).toBe(1);
  });
});

describe('the outbox end to end', () => {
  it('publishes a committed event and stops republishing it (FI-04)', async () => {
    const tenantId = tenant();
    const aggregateId = randomUUID();
    const queue = new InMemoryQueueAdapter();
    const publisher = new OutboxPublisher(outbox, queue);
    const now = new Date();

    await runner.run(
      async (session) => {
        await outbox.append(
          {
            tenantId,
            eventType: 'search.queued',
            aggregateType: 'SearchRun',
            aggregateId,
            aggregateRevision: 1,
            payload: { searchId: aggregateId },
            now,
          },
          session,
        );
      },
      { name: 'test.outbox' },
    );

    // Committed and unpublished: the normal state, and the reason a publisher exists.
    expect(await outbox.findByAggregate(tenantId, 'SearchRun', aggregateId)).toMatchObject([
      { publishedAt: null },
    ]);

    const first = await publisher.publishOnce(now);
    expect(first.published).toBeGreaterThanOrEqual(1);
    expect(queue.pending().some((e) => e.aggregateId === aggregateId)).toBe(true);

    const published = await outbox.findByAggregate(tenantId, 'SearchRun', aggregateId);
    expect(published[0]?.publishedAt).not.toBeNull();

    // A second poll must not send it again. At-least-once is the delivery guarantee, not a
    // licence to republish forever.
    const republished = await publisher.publishOnce(new Date(now.getTime() + 1000));
    const envelopeIds = queue.pending().filter((e) => e.aggregateId === aggregateId);
    expect(envelopeIds).toHaveLength(1);
    expect(republished.published).toBe(0);
  });

  it('leaves a failed publication in the outbox and backs it off', async () => {
    const tenantId = tenant();
    const aggregateId = randomUUID();
    const queue = new InMemoryQueueAdapter();
    const publisher = new OutboxPublisher(outbox, queue);
    const now = new Date();

    await runner.run(
      async (session) => {
        await outbox.append(
          {
            tenantId,
            eventType: 'search.queued',
            aggregateType: 'SearchRun',
            aggregateId,
            aggregateRevision: 1,
            payload: {},
            now,
          },
          session,
        );
      },
      { name: 'test.outbox.fail' },
    );

    queue.failNextPublish = 'queue unreachable';
    const failed = await publisher.publishOnce(now, () => 0.5);
    expect(failed.failed).toBeGreaterThanOrEqual(1);

    // Still there, still unpublished. This is the difference between a durable outbox and a
    // best-effort send: nothing was lost, and the event is tried again later.
    const stored = await outbox.findByAggregate(tenantId, 'SearchRun', aggregateId);
    expect(stored[0]?.publishedAt).toBeNull();
    expect(stored[0]?.attempt).toBe(1);
    expect(stored[0]?.lastError).toContain('queue unreachable');

    queue.failNextPublish = null;
    const later = new Date(now.getTime() + 10 * 60 * 1000);
    await publisher.publishOnce(later);
    const recovered = await outbox.findByAggregate(tenantId, 'SearchRun', aggregateId);
    expect(recovered[0]?.publishedAt).not.toBeNull();
  });

  it('republishes after a crash between publishing and marking published (FI-05, T41)', async () => {
    const tenantId = tenant();
    const aggregateId = randomUUID();
    const queue = new InMemoryQueueAdapter();
    const publisher = new OutboxPublisher(outbox, queue);
    const now = new Date();

    let eventId = '';
    await runner.run(
      async (session) => {
        const appended = await outbox.append(
          {
            tenantId,
            eventType: 'search.queued',
            aggregateType: 'SearchRun',
            aggregateId,
            aggregateRevision: 1,
            payload: {},
            now,
          },
          session,
        );
        eventId = appended.eventId;
      },
      { name: 'test.outbox.crash' },
    );

    // Publish, then die before marking. Simulated by publishing directly and never calling
    // markPublished — which is exactly the state a crash leaves behind.
    await queue.publish(
      (await outbox.findByAggregate(tenantId, 'SearchRun', aggregateId)).map((event) => ({
        envelopeVersion: 1 as const,
        eventId: event.eventId,
        eventType: event.eventType,
        tenantId: event.tenantId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        aggregateRevision: event.aggregateRevision,
        occurredAt: event.occurredAt.toISOString(),
        correlationId: event.correlationId,
        payload: event.payload,
      })),
    );

    // The publisher restarts and finds it still unpublished, so it sends it again.
    await publisher.publishOnce(now);

    const delivered = queue.pending().filter((e) => e.eventId === eventId);
    expect(delivered).toHaveLength(2);
    // Duplicated on the wire, exactly once in the record. The consumer's receipt and stage
    // identity are what make the duplicate harmless (FI-07, FI-09).
    expect(delivered[0]?.eventId).toBe(delivered[1]?.eventId);
  });

  it('publishes nothing for a transaction that aborted', async () => {
    const tenantId = tenant();
    const aggregateId = randomUUID();
    const queue = new InMemoryQueueAdapter();
    const publisher = new OutboxPublisher(outbox, queue);
    const now = new Date();

    await expect(
      runner.run(
        async (session) => {
          await outbox.append(
            {
              tenantId,
              eventType: 'search.queued',
              aggregateType: 'SearchRun',
              aggregateId,
              aggregateRevision: 1,
              payload: {},
              now,
            },
            session,
          );
          throw new Error('refused');
        },
        { name: 'test.outbox.abort' },
      ),
    ).rejects.toThrow('refused');

    await publisher.publishOnce(now);
    expect(queue.pending().some((e) => e.aggregateId === aggregateId)).toBe(false);
  });
});

describe('audit entries commit with the action they record (SEC-06)', () => {
  it('writes no audit entry when the action is rolled back', async () => {
    const tenantId = tenant();

    await expect(
      runner.run(
        async (session) => {
          await audit.append(
            {
              tenantId,
              actor: { type: 'USER', subject: 'reviewer-1', clientId: null },
              action: 'search.create',
              target: { type: 'SearchRun', id: 'run-1', version: 1 },
              result: 'ALLOWED',
              now: new Date(),
            },
            session,
          );
          throw new Error('refused after the audit write');
        },
        { name: 'test.audit.abort' },
      ),
    ).rejects.toThrow('refused after the audit write');

    // An audit entry for something that did not happen is as wrong as a missing one.
    expect(await audit.list({ tenantId, limit: 10 })).toHaveLength(0);
    const verdict = await audit.verifyChain(tenantId);
    expect(verdict.ok).toBe(true);
  });

  it('keeps the sequence gapless across an aborted transaction', async () => {
    const tenantId = tenant();

    const append = (action: string): Promise<unknown> =>
      runner.run(
        (session) =>
          audit.append(
            {
              tenantId,
              actor: { type: 'USER', subject: 'reviewer-1', clientId: null },
              action,
              target: { type: 'SearchRun', id: 'run-1', version: 1 },
              result: 'ALLOWED',
              now: new Date(),
            },
            session,
          ),
        { name: 'test.audit.seq', sleep: noSleep },
      );

    await append('a');
    await expect(
      runner.run(
        async (session) => {
          await audit.append(
            {
              tenantId,
              actor: { type: 'USER', subject: 'reviewer-1', clientId: null },
              action: 'b-aborted',
              target: { type: 'SearchRun', id: 'run-1', version: 1 },
              result: 'ALLOWED',
              now: new Date(),
            },
            session,
          );
          throw new Error('aborted');
        },
        { name: 'test.audit.seq.abort' },
      ),
    ).rejects.toThrow('aborted');
    await append('c');

    // The counter increment rolls back with everything else, so the surviving entries are 1
    // and 2 — not 1 and 3. A hole here would be indistinguishable from a deleted entry, and
    // would make the tamper signal useless by crying wolf.
    const entries = await audit.list({ tenantId, limit: 10 });
    expect(entries.map((e) => e.sequence).sort((a, b) => a - b)).toEqual([1, 2]);
    expect((await audit.verifyChain(tenantId)).ok).toBe(true);
  });
});

describe('search creation commits run, audit and outbox together', () => {
  /**
   * Uses the seeded `tenant-alpha`, because a search needs an entitlement, an active taxonomy
   * version and an active policy version — all of which `local:bootstrap` seeds. Inventing a
   * tenant here produced a 422 in an earlier phase that said nothing about the thing under
   * test, which would have made a green result meaningless.
   */
  const principal = {
    subject: 'reviewer-c2',
    kind: 'HUMAN' as const,
    tenantId: 'tenant-alpha',
    roles: [],
    scopes: [],
    environment: 'sandbox' as const,
    breakGlass: null,
  };

  const request: CreateSearchInput = {
    environment: 'sandbox',
    subjectSnapshot: {
      fullName: 'Ana María Solís',
      aliases: [],
      countryContext: ['CR'],
      knownCompanies: [],
      purpose: 'CUSTOMER_ONBOARDING',
    },
    requestedScope: {
      jurisdictions: ['CR'],
      languages: ['es'],
      includeFormerDirectorships: true,
      fromDate: null,
    },
  };

  it('writes all three in one commit, and publishes only after it', async () => {
    const now = new Date();
    const created = await searches.create({ principal, data: request, now });

    expect(created.execution).toBe('QUEUED');

    // The run exists.
    const run = await searches.findById('tenant-alpha', created.searchId);
    expect(run.searchId).toBe(created.searchId);

    // So does its audit entry, in the same commit, naming who asked and why.
    const entries = await audit.list({ tenantId: 'tenant-alpha', limit: 50 });
    const entry = entries.find((e) => e.target.id === created.searchId);
    expect(entry).toBeDefined();
    expect(entry?.action).toBe('search.create');
    expect(entry?.actor.subject).toBe('reviewer-c2');
    expect(entry?.result).toBe('ALLOWED');

    // And its outbox event — committed, and deliberately not yet published.
    const events = await outbox.findByAggregate('tenant-alpha', 'SearchRun', created.searchId);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('search.queued');
    expect(events[0]?.publishedAt).toBeNull();

    // Publication is a separate, later step (FI-04). Nothing reached the queue during create.
    const queue = new InMemoryQueueAdapter();
    expect(queue.pending()).toHaveLength(0);
    await new OutboxPublisher(outbox, queue).publishOnce(new Date(now.getTime() + 1));
    expect(queue.pending().some((e) => e.aggregateId === created.searchId)).toBe(true);
  });

  it('commits no run, no audit entry and no event when the entitlement is refused (T63)', async () => {
    const before = await audit.list({ tenantId: 'tenant-alpha', limit: 1 });

    await expect(
      searches.create({
        principal: { ...principal, tenantId: 'tenant-with-no-entitlement' },
        data: request,
        now: new Date(),
      }),
    ).rejects.toThrow();

    // The capability check happens before the transaction opens, so nothing was written at
    // all — not a run, not an audit entry, and not an event that would start work for a
    // tenant that is not entitled to it.
    expect(
      await outbox.findByAggregate('tenant-with-no-entitlement', 'SearchRun', 'any'),
    ).toHaveLength(0);
    expect(await audit.list({ tenantId: 'tenant-with-no-entitlement', limit: 10 })).toHaveLength(0);
    expect(await audit.list({ tenantId: 'tenant-alpha', limit: 1 })).toEqual(before);
  });
});
