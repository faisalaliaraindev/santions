/**
 * Phase C step C6 — redelivery, fencing, cancellation and the dead letter, against the real
 * replica set.
 *
 * None of this is convincingly testable against a mock. "Two deliveries commit one stage"
 * depends on a unique index; "a late completion is refused" depends on a conditional update
 * seeing another session's committed write; "the receipt and the effect commit together"
 * depends on a transaction. A fake that got any of those subtly wrong would agree with the
 * code and disagree with production.
 *
 * Every fencing test here races **two workers**. A single-worker test proves nothing about
 * staleness: the code path that matters is the one where the losing write arrives after the
 * winning one committed.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 */

import { SourceHealthService } from '../../apps/api/src/sources/source-health.service.js';
import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { statusForErrorCode, type ApiErrorBody } from '../../packages/contracts/src/index.js';
import type { Principal } from '../../packages/domain/src/index.js';

import { ApiException } from '../../apps/api/src/common/api-exception.js';
import { InMemoryDeadLetterSink } from '../../apps/api/src/jobs/dead-letter.port.js';
import { JobConsumer, type Disposition } from '../../apps/api/src/jobs/job-consumer.js';
import { JobFailure, type JobHandler } from '../../apps/api/src/jobs/job-handler.js';
import {
  InMemoryQueueAdapter,
  JOB_ENVELOPE_VERSION,
  type JobEnvelope,
  type ReceivedMessage,
} from '../../apps/api/src/jobs/queue.port.js';
import { WorkerRuntime } from '../../apps/api/src/jobs/worker-runtime.service.js';
import {
  AuditService,
  LocalAuditCheckpointWriter,
} from '../../apps/api/src/persistence/audit.service.js';
import {
  InboxReceiptService,
  queueChannel,
} from '../../apps/api/src/persistence/inbox-receipt.service.js';
import { OutboxService } from '../../apps/api/src/persistence/outbox.service.js';
import { RetentionService } from '../../apps/api/src/persistence/retention.service.js';
import { SourceDocumentService } from '../../apps/api/src/persistence/source-document.service.js';
import { StageExecutionService } from '../../apps/api/src/persistence/stage-execution.service.js';
import { TransactionRunner } from '../../apps/api/src/persistence/transaction.runner.js';
import { IndexerService } from '../../apps/api/src/search-index/indexer.service.js';
import { InMemorySearchIndex } from '../../apps/api/src/search-index/search-index.port.js';
import { EvidenceStagingService } from '../../apps/api/src/storage/evidence-staging.service.js';
import { InMemoryObjectStore } from '../../apps/api/src/storage/object-store.port.js';
import { OutboxPublisher } from '../../apps/api/src/jobs/outbox-publisher.js';
import { AssociationGraphService } from '../../apps/api/src/associations/association-graph.service.js';
import { CapabilityCoverageService } from '../../apps/api/src/admin/capability-coverage.service.js';
import { buildSourceAdapters } from '../../apps/api/src/sources/sources.registry.js';
import { PolicyService } from '../../apps/api/src/tenancy/policy.service.js';
import { FindingsService } from '../../apps/api/src/pipeline/findings.service.js';
import { TaxonomyService } from '../../apps/api/src/admin/taxonomy.service.js';
import { SearchesService } from '../../apps/api/src/searches/searches.service.js';
import { NameFrequencyService } from '../../apps/api/src/subjects/name-frequency.service.js';
import { SubjectsService } from '../../apps/api/src/subjects/subjects.service.js';
import { EntitlementsService } from '../../apps/api/src/tenancy/entitlements.service.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

let mongo: MongoClient;
let db: Db;
let runner: TransactionRunner;
let stages: StageExecutionService;
let receipts: InboxReceiptService;
let searches: SearchesService;
let entitlements: EntitlementsService;

const CONSUMER = 'test-worker';
const LEASE_MS = 30_000;

/**
 * This suite's own tenant, seeded in `beforeAll`.
 *
 * A search needs an entitlement, an active taxonomy version and an active policy version, so
 * the obvious move is to borrow the bootstrap's `tenant-alpha`. That was the first version of
 * this file, and it broke `transactions.test.ts`: its T63 asserts that a refused entitlement
 * leaves `tenant-alpha`'s audit trail unchanged, and these tests — running in parallel, in the
 * same database — were writing to it. The failure was in the other file, which is the worst
 * place for it to appear.
 *
 * So this suite seeds a tenant of its own. Borrowing shared fixture state is exactly how a
 * suite starts failing for reasons that have nothing to do with what it tests.
 */
const TENANT = `t-jobs-${randomUUID()}`;

function tenant(): string {
  return TENANT;
}

/**
 * The minimum a tenant needs before a search can be accepted, matching what
 * `scripts/bootstrap/seed-data.mjs` writes for the seeded tenants.
 */
async function seedTenant(tenantId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .collection('tenants')
    .insertOne({ tenantId, name: 'C6 test tenant', status: 'ACTIVE', createdAt: now });
  await db.collection('tenantEntitlementVersions').insertOne({
    tenantId,
    version: 1,
    capabilities: ['adverse_media'],
    environments: ['sandbox'],
    status: 'ACTIVE',
    activatedAt: now,
  });
  await db.collection('taxonomyVersions').insertOne({
    tenantId,
    version: 1,
    status: 'ACTIVE',
    categories: [],
    languages: [],
    lexicon: [],
    proposedBy: 'jobs.test',
    approvedBy: 'jobs.test',
    decisionRef: 'Fixture for the C6 suite.',
    activatedAt: now,
  });
  await db.collection('policyVersions').insertOne({
    tenantId,
    version: 1,
    status: 'ACTIVE',
    historicalScopeApproved: true,
    queryPlanCap: 200,
    outcomeUnknownAfterDays: 180,
    evidenceRetentionDays: 365,
    archiveHorizon: null,
    activatedAt: now,
  });
}

function envelopeFor(input: {
  tenantId: string;
  runId: string;
  revision?: number;
  eventId?: string;
  eventType?: string;
}): JobEnvelope {
  return {
    envelopeVersion: JOB_ENVELOPE_VERSION,
    eventId: input.eventId ?? randomUUID(),
    eventType: input.eventType ?? 'search.queued',
    tenantId: input.tenantId,
    aggregateType: 'SearchRun',
    aggregateId: input.runId,
    aggregateRevision: input.revision ?? 1,
    occurredAt: new Date().toISOString(),
    correlationId: null,
    payload: {},
  };
}

function messageFor(envelope: JobEnvelope, receiveCount = 1): ReceivedMessage {
  return {
    envelope,
    body: JSON.stringify(envelope),
    receiptHandle: randomUUID(),
    approximateReceiveCount: receiveCount,
  };
}

/** Counts its own executions, so "how many times did the work actually run?" is answerable. */
function countingHandler(
  onExecute: () => Promise<void> = async () => Promise.resolve(),
): JobHandler & { executions: number } {
  const handler = {
    eventType: 'search.queued',
    executions: 0,
    stageKeyFor: (envelope: JobEnvelope) => `fetch:${envelope.aggregateId}`,
    execute: async (): Promise<void> => {
      handler.executions += 1;
      await onExecute();
    },
  };
  return handler;
}

function consumerWith(handler: JobHandler, sink = new InMemoryDeadLetterSink()): JobConsumer {
  const consumer = new JobConsumer(
    stages,
    receipts,
    runner,
    sink,
    async (aggregateId: string) => searches.loadOwnership(aggregateId),
    {
      consumerName: CONSUMER,
      leaseMs: LEASE_MS,
      maxExecutionMs: 600_000,
      receiptTtlMs: 3_600_000,
      maxDeliveries: 5,
    },
    () => 0.5,
  );
  consumer.register(handler);
  return consumer;
}

/** A principal for a tenant, as the API would have built it from a validated token. */
function principalFor(tenantId: string): Principal {
  return {
    subject: 'reviewer-c6',
    kind: 'HUMAN',
    tenantId,
    roles: [],
    scopes: [],
    environment: 'sandbox',
    breakGlass: null,
  } as unknown as Principal;
}

/** Create a real queued run, the way the API does. */
async function createRun(tenantId: string): Promise<{ searchId: string; revision: number }> {
  const created = await searches.create({
    principal: principalFor(tenantId),
    data: {
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
        // Current-only. As of D3 a former-director search needs the `historical_directorships`
        // entitlement, which the seeded tenant here does not hold, and an unentitled request is
        // refused rather than silently narrowed (FR-02). The refusal is tested in
        // `associations.test.ts`; this suite is about job delivery.
        includeFormerDirectorships: false,
        fromDate: null,
      },
    },
    now: new Date(),
  });
  return { searchId: created.searchId, revision: created.revision };
}

beforeAll(async () => {
  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
  } catch (error) {
    throw new Error(`${STACK_HINT}\n\nMongoDB connection failed: ${String(error)}`);
  }
  db = mongo.db();

  runner = new TransactionRunner(mongo);
  stages = new StageExecutionService(db);
  receipts = new InboxReceiptService(db);
  entitlements = new EntitlementsService(db);

  const audit = new AuditService(db, new LocalAuditCheckpointWriter(db));
  const outbox = new OutboxService(db);
  const subjects = new SubjectsService(db, new NameFrequencyService(db));
  searches = new SearchesService(
    db,
    entitlements,
    subjects,
    runner,
    audit,
    outbox,
    new IndexerService(db, new InMemorySearchIndex(), new SourceDocumentService(db)),
    stages,
    associationGraphFor(db, subjects, runner, audit),
    new FindingsService(db),
    new TaxonomyService(db),
    new SourceHealthService(db, audit, runner),
    'mock',
  );

  await Promise.all([
    stages.ensureIndexes(),
    receipts.ensureIndexes(),
    audit.ensureIndexes(),
    outbox.ensureIndexes(),
    searches.ensureIndexes(),
  ]);

  await seedTenant(TENANT);
}, 60_000);

afterAll(async () => {
  // Leave no fixture behind. A tenant per run would otherwise accumulate in a database people
  // keep for weeks, and the next person reading `tenants` would have to work out which of the
  // hundreds are real.
  for (const collection of [
    'tenants',
    'tenantEntitlementVersions',
    'taxonomyVersions',
    'policyVersions',
    'searchRuns',
    'stageExecutions',
    'inboxReceipts',
    'outboxEvents',
    'auditEntries',
    'subjects',
    'subjectVersions',
    'sourceDocumentVersions',
  ]) {
    await db.collection(collection).deleteMany({ tenantId: TENANT });
  }
  await mongo.close();
});

describe('a handler that heartbeats still completes', () => {
  /**
   * The regression test for a bug that survived three phases undetected.
   *
   * `renewLease` increments the stage's `revision`, and `completeFenced` fences on the revision
   * captured when the lease was taken. So a handler that called `heartbeat()` invalidated its
   * own completion: the work succeeded, the fence refused it, the result was discarded, and the
   * message went back to the queue to be done again. Nothing caught it because until Phase E
   * there were no handlers, and therefore nothing ever called `heartbeat()`.
   *
   * The fence now advances with the lease owner's own renewals and with nothing else.
   */
  it('is not refused by its own heartbeat', async () => {
    const tenantId = tenant();
    const { searchId } = await createRun(tenantId);

    let heartbeats = 0;
    const handler: JobHandler = {
      eventType: 'search.queued',
      stageKeyFor: (envelope) => `fetch:${envelope.aggregateId}`,
      execute: async (context) => {
        // Three renewals, as a long-running pipeline does between its stages.
        for (let i = 0; i < 3; i += 1) {
          const alive = await context.heartbeat();
          expect(alive).toBe(true);
          heartbeats += 1;
        }
      },
    };

    const consumer = consumerWith(handler);
    const envelope = envelopeFor({ tenantId, runId: searchId });
    const disposition = await consumer.handle(messageFor(envelope), new Date());

    expect(heartbeats).toBe(3);
    // ACKNOWLEDGE, not RETRY_LATER. A discarded success is worse than a failure: the work was
    // done, the result was thrown away, and the queue grew.
    expect(disposition.kind).toBe('ACKNOWLEDGE');

    const stage = await stages.findByKey(tenantId, searchId, `fetch:${searchId}`);
    expect(stage?.state).toBe('SUCCEEDED');
  });
});

describe('T24 — redelivery commits no duplicate stage', () => {
  it('runs the work once across two deliveries of the same message', async () => {
    const tenantId = tenant();
    const { searchId } = await createRun(tenantId);
    const handler = countingHandler();
    const consumer = consumerWith(handler);
    const envelope = envelopeFor({ tenantId, runId: searchId });

    const first = await consumer.handle(messageFor(envelope), new Date());
    const second = await consumer.handle(messageFor(envelope, 2), new Date());

    expect(first).toMatchObject({ kind: 'ACKNOWLEDGE', outcome: 'SUCCEEDED' });
    // The receipt catches this one: the same eventId was already handled.
    expect(second).toMatchObject({ kind: 'ACKNOWLEDGE', outcome: 'DUPLICATE' });
    expect(handler.executions).toBe(1);

    const all = await stages.listForRun(tenantId, searchId);
    expect(all).toHaveLength(1);
    expect(all[0]?.state).toBe('SUCCEEDED');
  });

  it('still refuses the second attempt after the receipt is deleted outright (FI-09)', async () => {
    // The receipt is not the guard. If this test passes only because a receipt existed, it was
    // testing the cheap layer and not the durable one.
    const tenantId = tenant();
    const { searchId } = await createRun(tenantId);
    const handler = countingHandler();
    const consumer = consumerWith(handler);
    const envelope = envelopeFor({ tenantId, runId: searchId });

    await consumer.handle(messageFor(envelope), new Date());

    const deleted = await db.collection('inboxReceipts').deleteMany({
      tenantId,
      channel: queueChannel(CONSUMER),
    });
    expect(deleted.deletedCount).toBeGreaterThan(0);

    const second = await consumer.handle(messageFor(envelope, 2), new Date());

    // Stage identity, the layer that outlives every receipt.
    expect(second).toMatchObject({ kind: 'ACKNOWLEDGE', outcome: 'ALREADY_TERMINAL' });
    expect(handler.executions).toBe(1);
    expect(await stages.listForRun(tenantId, searchId)).toHaveLength(1);
  });

  it('commits no stage at all when the handler fails — no dangling success', async () => {
    const tenantId = tenant();
    const { searchId } = await createRun(tenantId);
    const handler = countingHandler(async () => {
      await Promise.resolve();
      throw new JobFailure({ httpStatus: 503 }, 'source unavailable');
    });
    const consumer = consumerWith(handler);

    const disposition = await consumer.handle(
      messageFor(envelopeFor({ tenantId, runId: searchId })),
      new Date(),
    );

    expect(disposition.kind).toBe('RETRY_LATER');
    const [stage] = await stages.listForRun(tenantId, searchId);
    expect(stage?.state).toBe('FAILED');
    expect(stage?.failureClass).toBe('TRANSIENT_NETWORK');
    expect(stage?.nextAttemptAt).not.toBeNull();
    // And the claim was released, so the retry is not blocked by this delivery's reservation.
    const held = await db
      .collection('inboxReceipts')
      .countDocuments({ tenantId, channel: queueChannel(CONSUMER) });
    expect(held).toBe(0);
  });

  it('abandons a class the FR-06 table says must never be retried', async () => {
    const tenantId = tenant();
    const { searchId } = await createRun(tenantId);
    const handler = countingHandler(async () => {
      await Promise.resolve();
      throw new JobFailure({ robotsDisallow: true }, 'robots.txt disallows this URL');
    });

    const disposition = await consumerWith(handler).handle(
      messageFor(envelopeFor({ tenantId, runId: searchId })),
      new Date(),
    );

    expect(disposition).toMatchObject({ kind: 'ACKNOWLEDGE', outcome: 'ABANDONED' });
    const [stage] = await stages.listForRun(tenantId, searchId);
    expect(stage?.state).toBe('ABANDONED');
    expect(stage?.failureClass).toBe('HARD_BLOCK');
    expect(stage?.attempt).toBe(1);
  });
});

describe('T30 — cancellation racing a late completion', () => {
  it('holds the cancellation and discards the late result', async () => {
    const tenantId = tenant();
    const { searchId, revision } = await createRun(tenantId);

    let cancelDuring: (() => Promise<void>) | null = null;
    const handler = countingHandler(async () => {
      // The cancellation lands while this worker is mid-stage — the only ordering that matters.
      await cancelDuring?.();
    });
    const consumer = consumerWith(handler);

    cancelDuring = async () => {
      await searches.cancel({
        principal: principalFor(tenantId),
        searchId,
        expectedRevision: revision,
        data: { reason: 'No longer required.' },
        now: new Date(),
      });
    };

    const disposition = await consumer.handle(
      messageFor(envelopeFor({ tenantId, runId: searchId, revision })),
      new Date(),
    );

    // The worker finished its work. Its write was refused, not applied, and not retried.
    expect(handler.executions).toBe(1);
    expect(disposition).toMatchObject({ kind: 'ACKNOWLEDGE', outcome: 'FENCE_REFUSED' });

    const [stage] = await stages.listForRun(tenantId, searchId);
    expect(stage?.state).toBe('CANCELLED');
    expect(stage?.discardedAttempts).toBe(1);

    const run = await searches.findById(tenantId, searchId);
    expect(run.execution).toBe('CANCELLED');
    // Not re-opened, not PARTIAL, and no findings from the discarded work.
    expect(run.findings).toBe('NOT_EVALUATED');
  });

  it('leaves a stage that had already succeeded exactly as it was', async () => {
    const tenantId = tenant();
    const { searchId, revision } = await createRun(tenantId);
    const consumer = consumerWith(countingHandler());

    await consumer.handle(
      messageFor(envelopeFor({ tenantId, runId: searchId, revision })),
      new Date(),
    );
    const before = (await stages.listForRun(tenantId, searchId))[0];
    expect(before?.state).toBe('SUCCEEDED');

    await searches.cancel({
      principal: principalFor(tenantId),
      searchId,
      expectedRevision: revision,
      data: { reason: 'Cancelled after one stage finished.' },
      now: new Date(),
    });

    const after = (await stages.listForRun(tenantId, searchId))[0];
    // A cancellation does not rewrite history: what genuinely completed, completed.
    expect(after?.state).toBe('SUCCEEDED');
    expect(after?.completedAt).toEqual(before?.completedAt);
  });

  it('does not resume work on a cancelled run when the message is redelivered', async () => {
    const tenantId = tenant();
    const { searchId, revision } = await createRun(tenantId);
    const handler = countingHandler();
    const consumer = consumerWith(handler);

    // Create the stage, then cancel the run, then redeliver.
    const envelope = envelopeFor({ tenantId, runId: searchId, revision });
    await stages.ensure({
      tenantId,
      runId: searchId,
      stageKey: handler.stageKeyFor(envelope),
      maxAttempts: 5,
      now: new Date(),
    });
    await searches.cancel({
      principal: principalFor(tenantId),
      searchId,
      expectedRevision: revision,
      data: { reason: 'Stop.' },
      now: new Date(),
    });

    const disposition = await consumer.handle(
      messageFor({ ...envelope, aggregateRevision: revision + 1 }),
      new Date(),
    );

    expect(disposition).toMatchObject({ kind: 'ACKNOWLEDGE', outcome: 'ALREADY_TERMINAL' });
    expect(handler.executions).toBe(0);
  });
});

describe('T29 — two actions on one revision', () => {
  it('accepts one, refuses the other with 409 and a recovery path', async () => {
    const tenantId = tenant();
    const { searchId, revision } = await createRun(tenantId);
    const principal = principalFor(tenantId);
    const cancel = async (): Promise<unknown> =>
      searches.cancel({
        principal,
        searchId,
        expectedRevision: revision,
        data: { reason: 'Concurrent cancellation.' },
        now: new Date(),
      });

    const outcomes = await Promise.allSettled([cancel(), cancel()]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const error = (rejected[0] as PromiseRejectedResult).reason as ApiException;
    expect(error).toBeInstanceOf(ApiException);

    const body = error.getResponse() as ApiErrorBody;
    // A 409 is not enough on its own. Without the current revision and state, the losing
    // caller's only move is to re-read and overwrite, which is how the first decision is lost.
    expect(statusForErrorCode(body.code)).toBe(409);
    expect(body.code === 'REVISION_CONFLICT' || body.code === 'ALREADY_TERMINAL').toBe(true);
    if (body.code === 'REVISION_CONFLICT') {
      expect(body.conflict).toMatchObject({
        expectedRevision: revision,
        currentRevision: revision + 1,
        currentState: 'CANCELLED',
      });
    }
  });

  it('refuses a stale revision and names the revision to re-submit against', async () => {
    const tenantId = tenant();
    const { searchId, revision } = await createRun(tenantId);

    await expect(
      searches.cancel({
        principal: principalFor(tenantId),
        searchId,
        expectedRevision: revision + 41,
        data: { reason: 'Acting on something I never read.' },
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });

    // And the run is untouched by the refused action.
    expect((await searches.findById(tenantId, searchId)).execution).toBe('QUEUED');
  });
});

describe('T31 — repeated and out-of-order deliveries', () => {
  it('discards a delivery older than the applied revision', async () => {
    const tenantId = tenant();
    const { searchId, revision } = await createRun(tenantId);
    await searches.cancel({
      principal: principalFor(tenantId),
      searchId,
      expectedRevision: revision,
      data: { reason: 'Bump the revision.' },
      now: new Date(),
    });

    const handler = countingHandler();
    const disposition = await consumerWith(handler).handle(
      messageFor(envelopeFor({ tenantId, runId: searchId, revision })),
      new Date(),
    );

    expect(disposition).toMatchObject({ kind: 'ACKNOWLEDGE', outcome: 'STALE_REVISION' });
    expect(handler.executions).toBe(0);
  });

  it('does the work once when the same message arrives three times', async () => {
    const tenantId = tenant();
    const { searchId } = await createRun(tenantId);
    const handler = countingHandler();
    const consumer = consumerWith(handler);
    const envelope = envelopeFor({ tenantId, runId: searchId });

    const dispositions: Disposition[] = [];
    for (let i = 1; i <= 3; i += 1) {
      dispositions.push(await consumer.handle(messageFor(envelope, i), new Date()));
    }

    expect(handler.executions).toBe(1);
    expect(dispositions.filter((d) => d.kind === 'ACKNOWLEDGE')).toHaveLength(3);
    expect(await stages.listForRun(tenantId, searchId)).toHaveLength(1);
  });
});

describe('FI-11 — a worker that dies, and one that only looked dead', () => {
  it('lets a second worker take an expired lease, and refuses the first worker afterwards', async () => {
    const tenantId = tenant();
    const { searchId } = await createRun(tenantId);
    const stageKey = 'fetch:dead-worker';

    await stages.ensure({ tenantId, runId: searchId, stageKey, maxAttempts: 5, now: new Date() });

    // Worker one takes a lease that lasts a millisecond, then stops responding. The clock is
    // not moved backwards to arrange this: a stage is only claimable once it is due, so a past
    // `now` would fail the claim for a reason that has nothing to do with what is under test.
    const first = await stages.acquireLease({
      tenantId,
      runId: searchId,
      stageKey,
      owner: 'worker-1',
      leaseMs: 1,
      maxExecutionMs: 600_000,
      now: new Date(),
    });
    expect(first).not.toBeNull();

    // The sweep's own query sees it. Asserted as membership rather than as a count: the sweep
    // is cross-tenant and bounded, so a count would really be measuring how much unrelated
    // work the shared local database happens to be holding.
    const sweepAt = new Date(Date.now() + 5_000);
    const due = await stages.findExpiredLeases(sweepAt, 500);
    expect(due.map((s) => s.stageExecutionId)).toContain(first!.stageExecutionId);

    const reclaimed = await stages.reclaimExpiredLease({
      tenantId,
      stageExecutionId: first!.stageExecutionId,
      expiredLeaseToken: first!.leaseToken,
      now: sweepAt,
    });
    expect(reclaimed).toBe('RETURNED');

    // Worker two takes it.
    const second = await stages.acquireLease({
      tenantId,
      runId: searchId,
      stageKey,
      owner: 'worker-2',
      leaseMs: LEASE_MS,
      maxExecutionMs: 600_000,
      now: new Date(Date.now() + 5_000),
    });
    expect(second).not.toBeNull();

    // Worker one was never dead — only paused — and now tries to write its result.
    const applied = await stages.completeFenced({
      tenantId,
      stageExecutionId: first!.stageExecutionId,
      leaseToken: first!.leaseToken,
      expectedRevision: first!.revision,
      state: 'SUCCEEDED',
      now: new Date(),
    });

    expect(applied).toBe(false);
    const stage = await stages.findByKey(tenantId, searchId, stageKey);
    // Still worker two's, and the refusal is visible rather than silent.
    expect(stage?.state).toBe('LEASED');
    expect(stage?.leaseToken).toBe(second!.leaseToken);
    expect(stage?.discardedAttempts).toBe(1);
  });

  it('abandons an expired lease whose attempts are spent rather than looping forever', async () => {
    const tenantId = tenant();
    const { searchId } = await createRun(tenantId);
    const stageKey = 'fetch:exhausted';

    await stages.ensure({ tenantId, runId: searchId, stageKey, maxAttempts: 1, now: new Date() });
    const lease = await stages.acquireLease({
      tenantId,
      runId: searchId,
      stageKey,
      owner: 'worker-1',
      leaseMs: 1,
      maxExecutionMs: 600_000,
      now: new Date(),
    });
    expect(lease).not.toBeNull();

    const outcome = await stages.reclaimExpiredLease({
      tenantId,
      stageExecutionId: lease!.stageExecutionId,
      expiredLeaseToken: lease!.leaseToken,
      now: new Date(Date.now() + 5_000),
    });

    expect(outcome).toBe('ABANDONED');
    expect((await stages.findByKey(tenantId, searchId, stageKey))?.state).toBe('ABANDONED');
  });

  it('refuses to renew a lease past the execution deadline', async () => {
    const tenantId = tenant();
    const { searchId } = await createRun(tenantId);
    const stageKey = 'fetch:unbounded';

    await stages.ensure({ tenantId, runId: searchId, stageKey, maxAttempts: 5, now: new Date() });
    const lease = await stages.acquireLease({
      tenantId,
      runId: searchId,
      stageKey,
      owner: 'worker-1',
      leaseMs: LEASE_MS,
      maxExecutionMs: 60_000,
      now: new Date(),
    });

    const renewed = await stages.renewLease({
      tenantId,
      stageExecutionId: lease!.stageExecutionId,
      leaseToken: lease!.leaseToken,
      leaseMs: LEASE_MS,
      // Past the deadline. A renewal loop with no bound is an unbounded job wearing a lease.
      now: new Date(Date.now() + 120_000),
    });

    expect(renewed).toBeNull();
  });
});

/**
 * T41 runs the two boundaries in sequence, because the danger is in the *order*, not in either
 * step: the object is committed before the record, and the record is committed before the
 * event. Each step is chosen so the thing left wrong is the cheap one — a few kilobytes nobody
 * can see, or a message delivered twice — and never a reference to bytes that are not there or
 * a run nobody was told to start.
 *
 * The object store is the in-process one here, and only here. Making a real bucket fail on
 * demand means breaking it; C5's suite runs the same paths against the real LocalStack S3 to
 * show that the store behaves as assumed.
 */
describe('T41 — upload commits, the database fails; the database commits, the publisher crashes', () => {
  it('leaves an orphan object and no reference, then reconciles the orphan', async () => {
    const tenantId = tenant();
    const store = new InMemoryObjectStore();
    const documents = new SourceDocumentService(db);
    await documents.ensureIndexes();
    const retention = new RetentionService(db);
    await retention.ensureIndexes();

    // The database refuses the commit after the bytes are in the store and verified.
    const failing = new SourceDocumentService(db);
    failing.commit = async () => {
      await Promise.resolve();
      throw new Error('injected: the database was unreachable at commit');
    };
    const staging = new EvidenceStagingService(store, failing, retention, 'eu-west-2');

    await expect(
      staging.stageAndCommit({
        tenantId,
        body: new TextEncoder().encode('Synthetic evidence body.'),
        contentType: 'text/plain',
        sourceId: 'src-t41',
        publisher: 'Example Gazette',
        sourceUrl: 'https://example.test/article/41',
        canonicalUrl: 'https://example.test/article/41',
        sourceTier: '2',
        retrievedAt: { value: '2026-09-11', precision: 'DAY', timezone: null },
        retentionExpiresAt: null,
        now: new Date(),
      }),
    ).rejects.toThrow(/injected/);

    // No dangling success: nothing claims evidence exists.
    expect(await documents.committedStorageKeys(tenantId)).toHaveProperty('size', 0);

    // The object is the thing left wrong, which is the acceptable half of the trade — a few
    // kilobytes no user can see, rather than a reference to bytes that are not there. The
    // sweep removes it once it is old enough that no commit can still be in flight.
    const sweep = await new EvidenceStagingService(
      store,
      documents,
      retention,
      'eu-west-2',
    ).sweepOrphans({ tenantId, now: new Date(Date.now() + 60 * 60_000), windowMs: 0 });

    expect(sweep.deleted).toBe(1);
    expect(await documents.committedStorageKeys(tenantId)).toHaveProperty('size', 0);
  });

  it('republishes an outbox event whose publisher crashed, and starts no second run', async () => {
    const tenantId = tenant();
    const { searchId } = await createRun(tenantId);
    const outbox = new OutboxService(db);
    const queue = new InMemoryQueueAdapter();
    const publisher = new OutboxPublisher(outbox, queue);

    // The publisher dies mid-send. The event is committed and unpublished — which is exactly
    // the state the outbox exists to make recoverable.
    queue.failNextPublish = 'injected: the queue was unreachable';
    const firstPass = await publisher.publishOnce(new Date(), () => 0.5);
    expect(firstPass.failed).toBeGreaterThanOrEqual(1);

    queue.failNextPublish = null;
    const secondPass = await publisher.publishOnce(new Date(Date.now() + 600_000), () => 0.5);
    expect(secondPass.published).toBeGreaterThanOrEqual(1);

    // Publishing twice would have been acceptable — the consumer deduplicates. Committing a
    // second run would not, and there is exactly one.
    const events = await outbox.findByAggregate(tenantId, 'SearchRun', searchId);
    expect(events).toHaveLength(1);
    expect(await searches.findById(tenantId, searchId)).toMatchObject({ execution: 'QUEUED' });
  });
});

describe('The runtime carries out dispositions, and refuses to run blind', () => {
  it('acknowledges, delays and dead-letters through the transport', async () => {
    const tenantId = tenant();
    const { searchId } = await createRun(tenantId);
    const queue = new InMemoryQueueAdapter();
    const sink = new InMemoryDeadLetterSink();

    const handler = countingHandler();
    const runtime = new WorkerRuntime(queue, consumerWith(handler, sink), stages, {
      maxMessages: 10,
      waitSeconds: 0,
      sweepBatch: 10,
    });

    await queue.publish([envelopeFor({ tenantId, runId: searchId })]);
    queue.injectRaw('{ not an envelope');

    const summary = await runtime.pollOnce(new Date());

    expect(summary.received).toBe(2);
    expect(summary.acknowledged).toBe(1);
    expect(summary.deadLettered).toBe(1);
    // The dead letter carries the original body and a reason an operator can act on.
    expect(sink.all()).toHaveLength(1);
    expect(sink.all()[0]).toMatchObject({
      reason: 'MALFORMED_ENVELOPE',
      body: '{ not an envelope',
    });
    // Nothing is left in flight: both messages were consumed, neither silently dropped.
    expect(queue.pending()).toHaveLength(0);
  });

  it('serves an FR-06 backoff as a transport delay rather than by sleeping', async () => {
    const tenantId = tenant();
    const { searchId } = await createRun(tenantId);
    const queue = new InMemoryQueueAdapter();

    const handler = countingHandler(async () => {
      await Promise.resolve();
      throw new JobFailure({ httpStatus: 429, retryAfterSeconds: 30 }, 'slow down');
    });
    const runtime = new WorkerRuntime(queue, consumerWith(handler), stages, {
      maxMessages: 10,
      waitSeconds: 0,
      sweepBatch: 10,
    });

    await queue.publish([envelopeFor({ tenantId, runId: searchId })]);
    const summary = await runtime.pollOnce(new Date());

    expect(summary.retried).toBe(1);
    // Exactly the Retry-After the source gave, not a jittered approximation of it.
    expect(queue.delays()[0]?.delaySeconds).toBe(30);
  });

  it('refuses to start with no handlers registered', () => {
    const consumer = new JobConsumer(
      stages,
      receipts,
      runner,
      new InMemoryDeadLetterSink(),
      async (id: string) => searches.loadOwnership(id),
      {
        consumerName: CONSUMER,
        leaseMs: LEASE_MS,
        maxExecutionMs: 600_000,
        receiptTtlMs: 3_600_000,
        maxDeliveries: 5,
      },
    );

    const runtime = new WorkerRuntime(new InMemoryQueueAdapter(), consumer, stages);

    // A handler-less worker is not idle: it would empty the queue into the DLQ.
    expect(() => {
      runtime.start();
    }).toThrow(/no job handlers are registered/);
  });
});

/**
 * The association graph service, as the composition root builds it.
 *
 * D3 added it as a dependency of `SearchesService`, because the FR-02 snapshot is created in
 * the same transaction as the run that pins it. Built with mock source adapters: this suite is
 * about transactions and jobs, not about registers, and a real adapter would put a network call
 * inside a test that has nothing to say about one.
 */
function associationGraphFor(
  db: Db,
  subjects: SubjectsService,
  transactions: TransactionRunner,
  audit: AuditService,
): AssociationGraphService {
  return new AssociationGraphService(
    db,
    subjects,
    buildSourceAdapters({ mode: 'MOCK', companiesHouseApiKey: null, fetchContactUrl: null }),
    new CapabilityCoverageService(db),
    transactions,
    audit,
    new PolicyService(db),
    'mock',
  );
}
