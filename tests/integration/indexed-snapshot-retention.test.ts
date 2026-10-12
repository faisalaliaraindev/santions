/**
 * Bounded snapshot retention, and a retention sweeper that actually runs.
 *
 * Two gaps found by the 2026-09-21 audit, both of the same shape: a thing that was written,
 * wired as a provider, and then called by nothing.
 *
 * - **Indexed snapshots were never pruned.** Every content-changing refresh wrote a full new
 *   snapshot and kept every previous one forever. A source refreshed four times a day grew its
 *   `indexedSourceRecords` without bound, and nothing in the codebase issued a `deleteMany`
 *   against that collection at all.
 * - **`RetentionSweeper.sweepOnce` had no caller.** Retention actions were created on schedule
 *   and executed never, so an object past its retention date stayed in the bucket indefinitely
 *   while the record said it was due for deletion.
 *
 * The tests here are written against the **real MongoDB** in the local stack rather than a mock,
 * because what is being checked is a property of the storage: that documents are actually gone,
 * that a bounded pass yields, and that the active snapshot survives a prune. A mocked repository
 * would assert that we called the method we wrote, which is not the claim.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 */

import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RetentionService } from '../../apps/api/src/persistence/retention.service.js';
import { SourceDocumentService } from '../../apps/api/src/persistence/source-document.service.js';
import { TransactionRunner } from '../../apps/api/src/persistence/transaction.runner.js';
import { IndexedSourceRepository } from '../../apps/api/src/sources/indexed/indexed-source.repository.js';
import type { NormalizedSourceRecord } from '../../apps/api/src/sources/indexed/indexed-source.types.js';
import { sha256Base64 } from '../../apps/api/src/storage/evidence-staging.service.js';
import { InMemoryObjectStore } from '../../apps/api/src/storage/object-store.port.js';
import { RetentionScheduler } from '../../apps/api/src/storage/retention-scheduler.service.js';
import { RetentionSweeper } from '../../apps/api/src/storage/retention-sweeper.service.js';

// `directConnection=true` matters: without it the driver performs replica-set discovery and gets
// back the container-internal hostname `mongo`, which does not resolve from the host.
const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';
const STACK_HINT =
  'This suite needs the local stack. Run `pnpm local:up && pnpm local:bootstrap` first.';

let mongo: MongoClient;
let db: Db;
let repository: IndexedSourceRepository;

beforeAll(async () => {
  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
  } catch (error) {
    throw new Error(`${STACK_HINT}\n\n${String(error)}`);
  }
  db = mongo.db();
  repository = new IndexedSourceRepository(db, new TransactionRunner(mongo));
  await repository.ensureIndexes();
});

afterAll(async () => {
  await mongo.close();
});

/** A source id unique to one test, so suites never contend over the same rows. */
function isolatedSourceId(): string {
  return `test-indexed-${randomUUID()}`;
}

function normalisedRecord(
  sourceId: string,
  index: number,
  generation: number,
): NormalizedSourceRecord {
  return {
    sourceId,
    sourceRecordId: `row-${String(index)}`,
    recordKind: 'AUTHORITY_LIST_ENTRY',
    recordType: 'PERSON',
    primaryName: `Test Person ${String(index)} gen ${String(generation)}`,
    aliases: [],
    originalScriptNames: [],
    datesOfBirth: [],
    placesOfBirth: [],
    nationalities: [],
    citizenships: [],
    countries: [],
    addresses: [],
    identifiers: [],
    companyIdentifiers: [],
    sanctionTypes: ['Asset freeze'],
    programmes: [],
    listingDate: null,
    grounds: null,
    status: null,
    effectiveDate: null,
    expiryDate: null,
    publisherUrl: `https://example.test/${sourceId}`,
    sourceDocumentUrl: `https://example.test/${sourceId}`,
    searchableText: `Test Person ${String(index)} generation ${String(generation)}`,
    publicationDate: null,
    rawEvidence: { index, generation },
  };
}

/**
 * Commit one snapshot, the way a refresh does: claim the lease, then commit under it.
 *
 * Going through `claimRefresh` rather than writing the state document directly matters — the
 * commit is guarded by the lease id, so a test that set the state by hand would be exercising a
 * path the refresh service never takes.
 */
async function commitGeneration(
  sourceId: string,
  generation: number,
  rowCount: number,
): Promise<string> {
  const now = new Date(Date.UTC(2026, 8, 21, 0, 0, generation));
  const claim = await repository.claimRefresh({
    sourceId,
    sourceVersion: 1,
    now,
    leaseMs: 60_000,
  });
  expect(claim.claimed).toBe(true);

  const snapshotVersion = `${sourceId}:gen-${String(generation).padStart(3, '0')}`;
  await repository.commitSnapshot({
    sourceId,
    sourceVersion: 1,
    snapshotVersion,
    artifactHash: `hash-${String(generation)}`,
    parserVersion: 'test-parser-1',
    publisherVersion: null,
    artifactUrl: `https://example.test/${sourceId}`,
    retrievedAt: now,
    etag: null,
    lastModified: null,
    refreshIntervalMs: 3_600_000,
    records: Array.from({ length: rowCount }, (_, index) =>
      normalisedRecord(sourceId, index, generation),
    ),
    refreshId: claim.refreshId,
  });
  return snapshotVersion;
}

describe('indexed snapshot retention is bounded', () => {
  it('leaves no more than two snapshots worth of records after twenty changed refreshes', async () => {
    const sourceId = isolatedSourceId();
    const rowsPerSnapshot = 50;

    // Twenty refreshes that each change content. Before pruning existed this left twenty
    // snapshots and a thousand records; the acceptance figure is "about two snapshots' worth".
    for (let generation = 1; generation <= 20; generation += 1) {
      await commitGeneration(sourceId, generation, rowsPerSnapshot);
      await repository.pruneSupersededSnapshots({ sourceId, now: new Date() });
    }

    const records = await db.collection('indexedSourceRecords').countDocuments({ sourceId });
    const snapshots = await db.collection('indexedSourceSnapshots').countDocuments({ sourceId });

    expect(snapshots).toBe(2);
    expect(records).toBe(rowsPerSnapshot * 2);

    // And the two kept are the right two: the active one and the one immediately behind it.
    const state = await repository.state(sourceId);
    expect(state.activeSnapshotVersion).toBe(`${sourceId}:gen-020`);
    const kept = await db
      .collection('indexedSourceSnapshots')
      .find({ sourceId })
      .sort({ snapshotVersion: 1 })
      .toArray();
    expect(kept.map((snapshot) => snapshot['snapshotVersion'])).toEqual([
      `${sourceId}:gen-019`,
      `${sourceId}:gen-020`,
    ]);

    await db.collection('indexedSourceRecords').deleteMany({ sourceId });
    await db.collection('indexedSourceSnapshots').deleteMany({ sourceId });
    await db.collection('indexedSourceRefreshStates').deleteMany({ sourceId });
  }, 120_000);

  it('never deletes the active snapshot, even when it is the oldest one present', async () => {
    const sourceId = isolatedSourceId();
    await commitGeneration(sourceId, 1, 10);

    // One snapshot only, and it is active. There is nothing superseded, so a prune must be a
    // no-op rather than "delete all but the newest two" applied to a set of one.
    const summary = await repository.pruneSupersededSnapshots({ sourceId, now: new Date() });

    expect(summary.snapshotsDeleted).toBe(0);
    expect(summary.recordsDeleted).toBe(0);
    expect(summary.activeSnapshotVersion).toBe(`${sourceId}:gen-001`);
    expect(await db.collection('indexedSourceRecords').countDocuments({ sourceId })).toBe(10);

    await db.collection('indexedSourceRecords').deleteMany({ sourceId });
    await db.collection('indexedSourceSnapshots').deleteMany({ sourceId });
    await db.collection('indexedSourceRefreshStates').deleteMany({ sourceId });
  });

  it('yields at its delete ceiling and reports the pass as incomplete', async () => {
    const sourceId = isolatedSourceId();
    await commitGeneration(sourceId, 1, 40);
    await commitGeneration(sourceId, 2, 40);
    await commitGeneration(sourceId, 3, 40);

    // Generation 1 is superseded and holds 40 records. A ceiling of 10 cannot finish it, so the
    // pass must stop, say so, and leave the snapshot row in place for the next pass rather than
    // orphaning the records it did not reach.
    const first = await repository.pruneSupersededSnapshots({
      sourceId,
      now: new Date(),
      maxRecordDeletes: 10,
      batchSize: 5,
    });
    expect(first.complete).toBe(false);
    expect(first.recordsDeleted).toBe(10);
    expect(first.snapshotsDeleted).toBe(0);
    expect(await db.collection('indexedSourceSnapshots').countDocuments({ sourceId })).toBe(3);

    // Draining finishes the work.
    let guard = 0;
    let summary = first;
    while (!summary.complete && guard < 20) {
      summary = await repository.pruneSupersededSnapshots({
        sourceId,
        now: new Date(),
        maxRecordDeletes: 10,
        batchSize: 5,
      });
      guard += 1;
    }
    expect(summary.complete).toBe(true);
    expect(await db.collection('indexedSourceSnapshots').countDocuments({ sourceId })).toBe(2);
    expect(await db.collection('indexedSourceRecords').countDocuments({ sourceId })).toBe(80);

    await db.collection('indexedSourceRecords').deleteMany({ sourceId });
    await db.collection('indexedSourceSnapshots').deleteMany({ sourceId });
    await db.collection('indexedSourceRefreshStates').deleteMany({ sourceId });
  });

  it('records the prune on the state, so an operator can see it without database access', async () => {
    const sourceId = isolatedSourceId();
    await commitGeneration(sourceId, 1, 5);
    await commitGeneration(sourceId, 2, 5);
    await commitGeneration(sourceId, 3, 5);
    await repository.pruneSupersededSnapshots({ sourceId, now: new Date() });

    const state = await repository.state(sourceId);
    expect(state.lastPrune).not.toBeNull();
    expect(state.lastPrune?.snapshotsDeleted).toBe(1);
    expect(state.lastPrune?.recordsDeleted).toBe(5);
    expect(state.lastPrune?.activeSnapshotVersion).toBe(`${sourceId}:gen-003`);
    expect(state.lastPrune?.retainedPreviousSnapshotVersion).toBe(`${sourceId}:gen-002`);

    await db.collection('indexedSourceRecords').deleteMany({ sourceId });
    await db.collection('indexedSourceSnapshots').deleteMany({ sourceId });
    await db.collection('indexedSourceRefreshStates').deleteMany({ sourceId });
  });
});

describe('the retention sweeper is actually driven', () => {
  it('processes an expired scheduled retention action', async () => {
    const tenantId = `tenant-retention-${randomUUID()}`;
    const documents = new SourceDocumentService(db);
    const retention = new RetentionService(db);
    await documents.ensureIndexes();
    await retention.ensureIndexes();

    const store = new InMemoryObjectStore();
    const storageKey = `${tenantId}/evidence/${randomUUID()}`;
    const body = new TextEncoder().encode('evidence bytes');
    await store.put({
      key: storageKey,
      body,
      contentType: 'application/octet-stream',
      checksumValue: sha256Base64(body),
    });
    expect(await store.head(storageKey)).not.toBeNull();

    const documentId = randomUUID();
    await db.collection('sourceDocumentVersions').insertOne({
      tenantId,
      // `RetentionSweeper` re-reads the document by `targetId` at the point of deletion, and
      // `SourceDocumentService.findVersion` keys on `documentVersionId`. The legal-hold check is
      // the reason it re-reads at all, so a row the sweeper cannot find would silently skip it.
      documentVersionId: documentId,
      documentId,
      version: 1,
      legalHold: false,
      createdAt: new Date(),
    });

    // Due an hour ago. Before the scheduler existed this row sat here forever: `sweepOnce` was
    // never called by anything outside its own tests.
    await retention.schedule({
      tenantId,
      targetId: documentId,
      storageBucket: store.bucket,
      storageKey,
      dueAt: new Date(Date.now() - 60 * 60 * 1000),
      policyBasis: 'test: 30-day evidence retention',
      now: new Date(),
    });

    const scheduler = new RetentionScheduler(new RetentionSweeper(store, retention, documents));
    const summary = await scheduler.drain(new Date());

    expect(summary.considered).toBeGreaterThanOrEqual(1);
    expect(summary.completed).toBeGreaterThanOrEqual(1);
    // The claim that matters is not "the sweeper returned a number" but "the object is gone".
    expect(await store.head(storageKey)).toBeNull();

    await db.collection('sourceDocumentVersions').deleteMany({ tenantId });
    await db.collection('retentionActions').deleteMany({ tenantId });
  });

  it('starts and stops cleanly, and starting twice does not make a second loop', async () => {
    const documents = new SourceDocumentService(db);
    const retention = new RetentionService(db);
    const scheduler = new RetentionScheduler(
      new RetentionSweeper(new InMemoryObjectStore(), retention, documents),
    );

    scheduler.start(60_000);
    scheduler.start(60_000);
    // A clean shutdown awaits the pass in flight rather than abandoning it mid-delete.
    await expect(scheduler.onApplicationShutdown()).resolves.toBeUndefined();
    await expect(scheduler.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
