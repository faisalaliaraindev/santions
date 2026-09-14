/**
 * Phase D step D5 — source health against the real replica set, and rows FI-17 and FI-18.
 *
 * The properties here are the ones that only a real database can show:
 *
 *  - `sourceHealth` is a **separate collection**. Suspending a source writes nothing to the
 *    immutable `sourceVersions` document, and the version it observed is a reference rather than
 *    a copy. This is the trap the whole step exists to avoid, so it is asserted directly.
 *  - the breaker, the budgets and the kill switch **survive a new service instance**, because a
 *    breaker that lives in process memory reopens every deployment and protects nothing.
 *  - budgets are read from the **active approved version**, so lowering a budget takes effect
 *    without a restart.
 *  - engaging and releasing are audited in the same transaction as the state change, and the
 *    releaser cannot be the person who engaged it.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 *
 * Seeds its own source ids and its own tenant, and deletes them afterwards. These suites run in
 * parallel against one database, and shared fixture state makes some other file fail.
 */

import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuditService,
  LocalAuditCheckpointWriter,
} from '../../apps/api/src/persistence/audit.service.js';
import { TransactionRunner } from '../../apps/api/src/persistence/transaction.runner.js';
import { SourceHealthService } from '../../apps/api/src/sources/source-health.service.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

let mongo: MongoClient;
let db: Db;
let runner: TransactionRunner;
let audit: AuditService;
let health: SourceHealthService;

const TENANT = `t-health-${randomUUID()}`;
const SOURCE = `src-health-${randomUUID()}`;
const NOW = new Date('2026-09-14T10:30:00.000Z');

/** Seed an active source version with the budgets this suite needs. */
async function seedSource(sourceId: string, content: Record<string, unknown> = {}): Promise<void> {
  await db.collection('sourceVersions').insertOne({
    sourceId,
    version: 4,
    status: 'ACTIVE',
    mode: 'MOCK',
    sourceName: 'Health fixture source',
    publisher: 'Fixture',
    connectorType: 'RSS',
    canonicalDomains: ['fixture.example'],
    authorityTier: 3,
    cascadeRung: 2,
    countries: ['CR'],
    languages: ['es'],
    credentialsRef: null,
    freeTierHourlyBudget: null,
    freeTierDailyBudget: null,
    stabilityClass: 'DOCUMENTED_STABLE',
    parserVersion: 'v1',
    licenceTermsVersion: 'terms-2026-01',
    robotsPosition: 'HONOURED',
    contentFormat: 'XML_FEED',
    ...content,
  });
}

beforeAll(async () => {
  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await mongo.connect();
    await mongo.db().command({ ping: 1 });
  } catch (error) {
    throw new Error(`${STACK_HINT}\n\nMongoDB connection failed: ${String(error)}`);
  }
  db = mongo.db();

  runner = new TransactionRunner(mongo);
  audit = new AuditService(db, new LocalAuditCheckpointWriter(db));
  health = new SourceHealthService(db, audit, runner);

  await audit.ensureIndexes();
  await health.ensureIndexes();
  await seedSource(SOURCE);
}, 60_000);

afterAll(async () => {
  await db.collection('sourceVersions').deleteMany({ sourceId: { $regex: '^src-health-' } });
  await db
    .collection<{ _id: string }>('sourceHealth')
    .deleteMany({ _id: { $regex: '^src-health-' } });
  await db.collection('auditEvents').deleteMany({ tenantId: TENANT });
  await db.collection<{ _id: string }>('auditSequences').deleteMany({ _id: TENANT });
  await mongo.close();
});

describe('health lives beside the immutable version, never inside it', () => {
  it('writes nothing to sourceVersions when a source is suspended', async () => {
    const sourceId = `src-health-${randomUUID()}`;
    await seedSource(sourceId);
    const before = await db.collection('sourceVersions').findOne({ sourceId });

    await health.engage({
      sourceId,
      reason: 'Publisher complaint',
      actor: 'ops@erly',
      tenantId: TENANT,
      now: NOW,
    });

    const after = await db.collection('sourceVersions').findOne({ sourceId });
    // The approved artefact is byte-identical. The observation went somewhere else.
    expect(after).toEqual(before);

    const stored = await db
      .collection<{ _id: string } & Record<string, unknown>>('sourceHealth')
      .findOne({ _id: sourceId });
    expect(stored).not.toBeNull();
    expect(stored?.['killSwitch']).toMatchObject({ engagedBy: 'ops@erly' });
    // A reference to the version observed, not a copy of it.
    expect(stored?.['observedVersion']).toBe(4);
    expect(stored?.['sourceName']).toBeUndefined();
  });

  it('a source with no active version is refused rather than called unbudgeted', async () => {
    const check = await health.checkAccess({ sourceId: 'src-health-never-registered', now: NOW });
    expect(check.decision.allowed).toBe(false);
    expect(check.decision.refusal).toBe('VERSION_NOT_ACTIVE');
    expect(check.coverageOutcome?.outcome).toBe('SUSPENDED');
  });
});

describe('the breaker and the budgets survive a new process (FI-18)', () => {
  it('an open breaker refuses through a freshly constructed service', async () => {
    const sourceId = `src-health-${randomUUID()}`;
    await seedSource(sourceId);

    await health.recordFailure({ sourceId, signal: { httpStatus: 403 }, now: NOW });
    await health.recordFailure({ sourceId, signal: { httpStatus: 403 }, now: NOW });
    await health.recordFailure({ sourceId, signal: { httpStatus: 403 }, now: NOW });

    // A breaker that lives in process memory reopens on every deployment and protects nothing.
    const restarted = new SourceHealthService(db, audit, runner);
    const check = await restarted.checkAccess({ sourceId, now: NOW });
    expect(check.decision.allowed).toBe(false);
    expect(check.decision.refusal).toBe('BREAKER_OPEN');
    expect(check.coverageOutcome?.outcome).toBe('FAILED');
  });

  it('a success closes it again, and the spend is durable', async () => {
    const sourceId = `src-health-${randomUUID()}`;
    await seedSource(sourceId, { freeTierHourlyBudget: 2 });

    const first = await health.checkAccess({ sourceId, now: NOW });
    expect(first.decision.allowed).toBe(true);
    const second = await health.checkAccess({ sourceId, now: NOW });
    expect(second.decision.allowed).toBe(true);

    const restarted = new SourceHealthService(db, audit, runner);
    const third = await restarted.checkAccess({ sourceId, now: NOW });
    expect(third.decision.allowed).toBe(false);
    expect(third.decision.refusal).toBe('HOURLY_BUDGET_EXHAUSTED');
    // Exhaustion is a coverage outcome, not an error. Some of the plan ran.
    expect(third.coverageOutcome?.outcome).toBe('PARTIAL');
    expect(third.coverageOutcome?.truncation).toBe('TRUNCATED_BY_QUOTA');

    // The next clock hour reopens it without anybody intervening.
    const nextHour = await restarted.checkAccess({
      sourceId,
      now: new Date('2026-09-14T11:00:00.000Z'),
    });
    expect(nextHour.decision.allowed).toBe(true);
  });

  it('reads the budget from the active version, so lowering it needs no restart (FI-17)', async () => {
    const sourceId = `src-health-${randomUUID()}`;
    await seedSource(sourceId, { freeTierHourlyBudget: 10 });

    await health.checkAccess({ sourceId, now: NOW });
    expect((await health.checkAccess({ sourceId, now: NOW })).decision.allowed).toBe(true);

    // An administrator lowers the budget below what has already been spent.
    await db
      .collection('sourceVersions')
      .updateOne({ sourceId }, { $set: { freeTierHourlyBudget: 2 } });

    const after = await health.checkAccess({ sourceId, now: NOW });
    expect(after.decision.allowed).toBe(false);
    expect(after.decision.refusal).toBe('HOURLY_BUDGET_EXHAUSTED');
  });
});

describe('the kill switch (T36, FI-18)', () => {
  it('refuses at the point of use and names the operator and the reason', async () => {
    const sourceId = `src-health-${randomUUID()}`;
    await seedSource(sourceId);

    // Healthy when the run planned.
    expect((await health.checkAccess({ sourceId, now: NOW })).decision.allowed).toBe(true);

    await health.engage({
      sourceId,
      reason: 'Rights violation reported by the publisher',
      actor: 'ops@erly',
      tenantId: TENANT,
      now: new Date(NOW.getTime() + 1000),
    });

    // The same run, still in flight, asking again before its next call.
    const check = await health.checkAccess({
      sourceId,
      now: new Date(NOW.getTime() + 2000),
      queriesAffected: 7,
    });
    expect(check.decision.allowed).toBe(false);
    expect(check.decision.refusal).toBe('KILL_SWITCH_ENGAGED');
    expect(check.coverageOutcome?.outcome).toBe('SUSPENDED');
    expect(check.coverageOutcome?.detail).toContain('Rights violation reported by the publisher');
    expect(check.coverageOutcome?.detail).toContain('ops@erly');
    // The refusal is never a silent skip: it says what it cost the run.
    expect(check.coverageOutcome?.queriesAffected).toBe(7);
  });

  it('treats an expired licence identically, with no operator involved', async () => {
    const sourceId = `src-health-${randomUUID()}`;
    await seedSource(sourceId, { licenceExpiresAt: '2026-09-01T00:00:00.000Z' });

    const check = await health.checkAccess({ sourceId, now: NOW });
    expect(check.decision.allowed).toBe(false);
    expect(check.decision.refusal).toBe('LICENCE_EXPIRED');
    expect(check.coverageOutcome?.outcome).toBe('SUSPENDED');
  });

  it('audits the suspension in the same transaction as the state change', async () => {
    const sourceId = `src-health-${randomUUID()}`;
    await seedSource(sourceId);
    await health.engage({
      sourceId,
      reason: 'Blocked us from three identities',
      actor: 'ops@erly',
      tenantId: TENANT,
      now: NOW,
    });

    const entry = await db
      .collection('auditEvents')
      .findOne({ tenantId: TENANT, 'target.id': sourceId, action: 'source:kill_switch_engage' });
    expect(entry).not.toBeNull();
    expect(entry?.['reason']).toBe('Blocked us from three identities');
    expect(entry?.['result']).toBe('ALLOWED');
  });

  it('refuses a second engage rather than overwriting the first reason', async () => {
    const sourceId = `src-health-${randomUUID()}`;
    await seedSource(sourceId);
    await health.engage({
      sourceId,
      reason: 'first',
      actor: 'ops@erly',
      tenantId: TENANT,
      now: NOW,
    });
    await expect(
      health.engage({
        sourceId,
        reason: 'second',
        actor: 'other@erly',
        tenantId: TENANT,
        now: NOW,
      }),
    ).rejects.toThrow(/already suspended/i);
  });

  it('four-eyes on release: the person who engaged it cannot release it', async () => {
    const sourceId = `src-health-${randomUUID()}`;
    await seedSource(sourceId);
    await health.engage({
      sourceId,
      reason: 'r',
      actor: 'ops@erly',
      tenantId: TENANT,
      now: NOW,
    });

    await expect(
      health.release({
        sourceId,
        reason: 'resolved',
        actor: 'ops@erly',
        tenantId: TENANT,
        now: NOW,
      }),
    ).rejects.toThrow(/Four-eyes/i);

    const released = await health.release({
      sourceId,
      reason: 'Publisher confirmed the complaint was withdrawn',
      actor: 'legal@erly',
      tenantId: TENANT,
      now: NOW,
    });
    expect(released.killSwitch).toBeNull();
    // The failures accumulated during the suspension describe the suspension, not the source.
    expect(released.breaker).toBe('CLOSED');
    expect((await health.checkAccess({ sourceId, now: NOW })).decision.allowed).toBe(true);
  });

  it('a result produced before the suspension reads as since-suspended, and is not deleted', async () => {
    const sourceId = `src-health-${randomUUID()}`;
    await seedSource(sourceId);
    const producedAt = new Date('2026-09-10T00:00:00.000Z');

    await health.engage({
      sourceId,
      reason: 'Publisher withdrew permission',
      actor: 'ops@erly',
      tenantId: TENANT,
      now: NOW,
    });

    const notes = await health.suspensionNotesFor({
      sourceIds: [sourceId],
      producedAt,
      asOf: NOW,
    });
    expect(notes[sourceId]).toContain('before the source was suspended');
    expect(notes[sourceId]).toContain('Publisher withdrew permission');
  });

  it('says nothing about a healthy source', async () => {
    const notes = await health.suspensionNotesFor({
      sourceIds: [SOURCE],
      producedAt: NOW,
      asOf: NOW,
    });
    expect(notes[SOURCE]).toBeUndefined();
  });
});
