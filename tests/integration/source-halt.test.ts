/**
 * FI-20 — a source halts on a stop condition, and the halt is persisted.
 *
 * # Why this suite exists, and why it is written before the first live poll
 *
 * `SourceHealthService.recordFailure` is the only path that can stop this service talking to a
 * publisher **without a person deciding it**. A publisher returns a 403; the failure is classified
 * and folded into health; the recorded stop conditions (D-041) are evaluated; and when they say
 * halt, the kill switch is engaged **and** an audit entry is written to the reserved platform
 * trail (`__platform__`, see `platform-audit.ts`).
 *
 * The pure half of that — `applyObservedFailure` — is already covered by
 * `apps/api/test/fetch-tripwires.test.ts`. What no test covered until this file is the half that
 * only a real replica set can show: **that the halt and its audit entry commit together**, and
 * that nothing can leave behind a source which stopped and cannot say why.
 *
 * The failure this guards against is specific and it is silent. A halt decided in memory and
 * never persisted is a source that *should* be halted and is not: the next request goes out to a
 * publisher who has already refused us, under an approval that has effectively lapsed. Nothing
 * surfaces. The run looks normal.
 *
 * It is written **before** anything is polled live, not after, because after the first live poll
 * the first thing this code does is run against a publisher whose terms say a 403 means stop.
 *
 * # What FI-20 actually promises, and what it does not
 *
 * The matrix row claims no orphan is written and that the window is **one request**. Both are
 * asserted here:
 *
 *  - the halt and the audit entry are one transaction, so a failure writing the entry leaves
 *    **neither** (`writes neither when the audit entry cannot be written`);
 *  - the halt is **re-derived** from the next identical failure, because the signal that caused
 *    it does not go away (`the same refusal halts it again afterwards`). That re-derivation is
 *    the reconciler, and it is why the window is one request rather than forever;
 *  - halting is **idempotent**, so re-derivation cannot overwrite the reason and timestamp an
 *    operator was alerted about (`keeps the first halt record`).
 *
 * What it deliberately does not claim: that a crash *between* folding the failure into health and
 * engaging the switch leaves a partially-updated source. It cannot, because both writes are in
 * the one transaction — a crash there leaves the source untouched, and the next failure halts it.
 *
 * # A note on cleaning up
 *
 * This suite writes to `__platform__`, which is a **hash chain**. It therefore deletes nothing
 * from `auditEvents`: removing an entry from the middle of a chain is exactly the tampering the
 * chain exists to detect, and a test that broke the chain to tidy up after itself would leave
 * every later verification failing for a reason nobody could find. The entries are real platform
 * events and they stay. The suite asserts the chain still verifies on the way out.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 */

import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AuditService,
  LocalAuditCheckpointWriter,
  type AuditEventRecord,
} from '../../apps/api/src/persistence/audit.service.js';
import { TransactionRunner } from '../../apps/api/src/persistence/transaction.runner.js';
import {
  PLATFORM_AUDIT_TENANT_ID,
  SYSTEM_ACTOR,
} from '../../apps/api/src/sources/platform-audit.js';
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

const NOW = new Date('2026-09-16T09:00:00.000Z');
const LATER = new Date('2026-09-16T09:05:00.000Z');

/** The refusal D17 records for the SEC: a 403 from them is a statement about us, not a blip. */
const REFUSED = { httpStatus: 403 } as const;

/**
 * An active version whose approver recorded "a 403 halts this source".
 *
 * Written in the nested `content` shape the admin lifecycle produces, because that is the shape a
 * source approved through `/v1/admin` actually has — seeding the flat shape would test the
 * compatibility branch rather than the real one.
 */
async function seedSource(sourceId: string): Promise<void> {
  await db.collection('sourceVersions').insertOne({
    sourceId,
    version: 2,
    status: 'ACTIVE',
    content: {
      sourceName: 'Halt fixture source',
      publisher: 'Fixture',
      connectorType: 'RSS',
      canonicalDomains: ['fixture.example'],
      authorityTier: 1,
      cascadeRung: 1,
      countries: ['US'],
      languages: ['en'],
      credentialsRef: null,
      freeTierHourlyBudget: null,
      freeTierDailyBudget: null,
      stabilityClass: 'DOCUMENTED_STABLE',
      parserVersion: 'v1',
      licenceTermsVersion: 'terms-2026-01',
      robotsPosition: 'HONOURED',
      contentFormat: 'XML_FEED',
      accessPolicy: {
        stopConditions: {
          haltOnStatuses: [403],
          haltOnRateLimit: true,
          rateLimitCooldownSeconds: 600,
          serverErrorStreakToHalt: 5,
          requiresFreshApprovalOnHalt: true,
        },
      },
    },
  });
}

/** The stored health document, read raw — this suite is about what is in the database. */
async function storedHealth(sourceId: string): Promise<Record<string, unknown> | null> {
  return db
    .collection<{ _id: string } & Record<string, unknown>>('sourceHealth')
    .findOne({ _id: sourceId });
}

/** Every halt entry on the platform trail naming this source. */
async function haltEntries(sourceId: string): Promise<Record<string, unknown>[]> {
  return db
    .collection<Record<string, unknown>>('auditEvents')
    .find({
      tenantId: PLATFORM_AUDIT_TENANT_ID,
      action: 'source:stop_condition_halt',
      'target.id': sourceId,
    })
    .toArray();
}

/**
 * An audit service that cannot write — the second half of the transaction failing.
 *
 * A plain `Error` is deliberate. `classifyBodyError` sends anything that is not a transient
 * transaction fault straight out of `TransactionRunner.run` without retrying, which is the
 * behaviour under test: the write fails, the transaction aborts, and nothing is left behind.
 */
class UnwritableAuditService extends AuditService {
  override append(): Promise<AuditEventRecord> {
    return Promise.reject(new Error('audit store unavailable'));
  }
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
}, 60_000);

afterAll(async () => {
  // Source state is this suite's own and goes. `auditEvents` does not — see the header.
  await db.collection('sourceVersions').deleteMany({ sourceId: { $regex: '^src-halt-' } });
  await db
    .collection<{ _id: string }>('sourceHealth')
    .deleteMany({ _id: { $regex: '^src-halt-' } });
  await mongo.close();
});

describe('FI-20 — the halt and its audit entry commit together', () => {
  it('persists both when a recorded stop condition fires', async () => {
    const sourceId = `src-halt-${randomUUID()}`;
    await seedSource(sourceId);

    const result = await health.recordFailure({ sourceId, signal: REFUSED, now: NOW });

    // The service's own answer says halted.
    expect(result.killSwitch).not.toBeNull();

    // And so does the database, which is the only one of the two that survives this process.
    const stored = await storedHealth(sourceId);
    expect(stored?.['killSwitch']).toMatchObject({
      engagedBy: SYSTEM_ACTOR,
      engagedAt: NOW.toISOString(),
    });

    // The reason is written for a reviewer, and it has to name what fired. A halt whose reason
    // is "halted" tells the person releasing it nothing about whether it is safe to release.
    const reason = (stored?.['killSwitch'] as { reason: string }).reason;
    expect(reason).toContain('403');
    expect(reason.length).toBeGreaterThan(20);

    const entries = await haltEntries(sourceId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tenantId: PLATFORM_AUDIT_TENANT_ID,
      action: 'source:stop_condition_halt',
      // DENIED, not SUCCEEDED: the recorded outcome is that a request was refused.
      result: 'DENIED',
    });
    // No actor and no tenant, because nobody asked for it.
    expect(entries[0]?.['actor']).toMatchObject({ type: 'SYSTEM', subject: SYSTEM_ACTOR });
    // The entry points at the version whose approver recorded the condition that fired.
    expect(entries[0]?.['target']).toMatchObject({
      type: 'SourceHealth',
      id: sourceId,
      version: 2,
    });
  });

  it('writes neither when the audit entry cannot be written', async () => {
    const sourceId = `src-halt-${randomUUID()}`;
    await seedSource(sourceId);

    const unwritable = new SourceHealthService(
      db,
      new UnwritableAuditService(db, new LocalAuditCheckpointWriter(db)),
      runner,
    );

    await expect(unwritable.recordFailure({ sourceId, signal: REFUSED, now: NOW })).rejects.toThrow(
      'audit store unavailable',
    );

    // This is the property the whole row is about. A halted source with no audit entry is a
    // service that stopped calling a publisher and cannot say why; the transaction is what
    // makes that state unreachable.
    expect(await haltEntries(sourceId)).toHaveLength(0);

    const stored = await storedHealth(sourceId);
    // Either nothing was written at all, or something was — but it is *not* halted. The halt
    // never exists without the entry that explains it.
    expect(stored?.['killSwitch'] ?? null).toBeNull();
  });

  it('the same refusal halts it again afterwards, which is why the window is one request', async () => {
    const sourceId = `src-halt-${randomUUID()}`;
    await seedSource(sourceId);

    const unwritable = new SourceHealthService(
      db,
      new UnwritableAuditService(db, new LocalAuditCheckpointWriter(db)),
      runner,
    );
    await expect(
      unwritable.recordFailure({ sourceId, signal: REFUSED, now: NOW }),
    ).rejects.toThrow();
    expect((await storedHealth(sourceId))?.['killSwitch'] ?? null).toBeNull();

    // No reconciler sweeps for this, and none is needed: the signal that caused the halt is a
    // property of the publisher, so the next request produces the same 403 and the same verdict.
    const recovered = await health.recordFailure({ sourceId, signal: REFUSED, now: LATER });

    expect(recovered.killSwitch).not.toBeNull();
    expect((await storedHealth(sourceId))?.['killSwitch']).toMatchObject({
      engagedBy: SYSTEM_ACTOR,
      engagedAt: LATER.toISOString(),
    });
    expect(await haltEntries(sourceId)).toHaveLength(1);
  });

  it('keeps the first halt record when the same source refuses us again', async () => {
    const sourceId = `src-halt-${randomUUID()}`;
    await seedSource(sourceId);

    await health.recordFailure({ sourceId, signal: REFUSED, now: NOW });
    const first = (await storedHealth(sourceId))?.['killSwitch'];

    await health.recordFailure({ sourceId, signal: REFUSED, now: LATER });
    const second = (await storedHealth(sourceId))?.['killSwitch'];

    // Idempotent, and the timestamp matters: it is the one an operator was alerted about, and
    // the one a release decision is reasoned against. A re-derived halt must not move it.
    expect(second).toEqual(first);
    expect((second as { engagedAt: string }).engagedAt).toBe(NOW.toISOString());
  });

  it('refuses at the point of use through a new process, with the reason verbatim', async () => {
    const sourceId = `src-halt-${randomUUID()}`;
    await seedSource(sourceId);
    await health.recordFailure({ sourceId, signal: REFUSED, now: NOW });

    // A halt that lived in process memory would protect nothing past the next deployment.
    const fresh = new SourceHealthService(
      db,
      new AuditService(db, new LocalAuditCheckpointWriter(db)),
      runner,
    );
    const check = await fresh.checkAccess({ sourceId, now: LATER });

    expect(check.decision.allowed).toBe(false);
    // SUSPENDED, never FAILED: the publisher is working, we chose to stop asking. Reporting an
    // outage at a publisher who is up sends somebody to investigate at the wrong end.
    expect(check.coverageOutcome?.outcome).toBe('SUSPENDED');

    const reason = ((await storedHealth(sourceId))?.['killSwitch'] as { reason: string }).reason;
    // Carried verbatim into what the run reports, so the reviewer reads what the service decided
    // rather than a paraphrase of it.
    expect(JSON.stringify(check.coverageOutcome)).toContain(reason);
  });

  it('leaves the platform audit chain verifiable', async () => {
    const verdict = await audit.verifyChain(PLATFORM_AUDIT_TENANT_ID);
    expect(verdict.ok).toBe(true);
  });
});
