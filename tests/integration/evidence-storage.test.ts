/**
 * Phase C step C5 — evidence staging, orphan reconciliation and retention deletion.
 *
 * Two rows of the C0 failure matrix are under test here, and they are the same rule from
 * opposite ends:
 *
 * - **FI-03** — stage, verify, *then* commit the reference. Never the inverse.
 * - **FI-15** — mark the reference expired, *then* delete the object. Never the inverse.
 *
 * What both prevent is a committed reference to bytes that are not there: a screening product
 * telling a reviewer that evidence exists when it does not. That failure is worse than an error
 * because it looks like success, so the tests below are written to catch it specifically —
 * several assert on what is **absent** from MongoDB after a failure, not merely that a call
 * threw. A staging bug that throws *and* commits would pass a test that only checked the throw.
 *
 * Run against the real LocalStack S3 in the local stack, because the properties that matter —
 * that the store computes its own checksum, that a delete is idempotent, that a listing
 * paginates — are properties of S3 and not of our code. Failure injection uses the in-process
 * store, because making a real bucket corrupt bytes on demand means breaking it.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 */

import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RetentionService } from '../../apps/api/src/persistence/retention.service.js';
import { SourceDocumentService } from '../../apps/api/src/persistence/source-document.service.js';
import {
  EvidenceStagingService,
  ORPHAN_WINDOW_MS,
  sha256Base64,
} from '../../apps/api/src/storage/evidence-staging.service.js';
import {
  InMemoryObjectStore,
  keyFor,
  tenantOfKey,
  tenantPrefix,
  type ObjectStorePort,
} from '../../apps/api/src/storage/object-store.port.js';
import { RetentionSweeper } from '../../apps/api/src/storage/retention-sweeper.service.js';
import { S3ObjectStoreAdapter } from '../../apps/api/src/storage/s3-object-store.adapter.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';
const AWS_ENDPOINT = process.env['AWS_ENDPOINT_URL'] ?? 'http://127.0.0.1:28566';
const REGION = process.env['AWS_REGION'] ?? 'eu-west-2';
const BUCKET = process.env['S3_EVIDENCE_BUCKET'] ?? 'adverse-search-evidence-local';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

let mongo: MongoClient;
let db: Db;
let s3: S3ObjectStoreAdapter;
let documents: SourceDocumentService;
let retention: RetentionService;

function tenant(): string {
  return `t-evid-${randomUUID()}`;
}

function stagingWith(store: ObjectStorePort): EvidenceStagingService {
  return new EvidenceStagingService(store, documents, retention, REGION);
}

function sweeperWith(store: ObjectStorePort): RetentionSweeper {
  return new RetentionSweeper(store, retention, documents);
}

/**
 * A store that delegates everything except `remove`.
 *
 * Written out rather than spread over a class instance, because spreading copies own fields and
 * silently drops the prototype methods — a stand-in that is subtly not the thing it stands in
 * for is how a failure-injection test ends up injecting the wrong failure.
 */
class RemoveOverride implements ObjectStorePort {
  readonly kind: string;
  readonly bucket: string;

  constructor(
    private readonly inner: ObjectStorePort,
    private readonly onRemove: (key: string) => Promise<void>,
  ) {
    this.kind = inner.kind;
    this.bucket = inner.bucket;
  }

  async put(input: Parameters<ObjectStorePort['put']>[0]) {
    return this.inner.put(input);
  }
  async head(key: string) {
    return this.inner.head(key);
  }
  async get(key: string) {
    return this.inner.get(key);
  }
  async remove(key: string) {
    return this.onRemove(key);
  }
  async list(prefix: string) {
    return this.inner.list(prefix);
  }
  async healthy() {
    return this.inner.healthy();
  }
}

/** A document as a fetcher would hand it over. */
function payload(tenantId: string, body = 'Synthetic evidence body.') {
  return {
    tenantId,
    body: new TextEncoder().encode(body),
    contentType: 'text/plain',
    sourceId: 'src-test',
    publisher: 'Example Gazette',
    sourceUrl: 'https://example.test/article/1',
    canonicalUrl: 'https://example.test/article/1',
    sourceTier: '2',
    retrievedAt: { value: '2026-09-11', precision: 'DAY' as const, timezone: null },
    retentionExpiresAt: null,
    now: new Date(),
  };
}

beforeAll(async () => {
  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
  } catch (error) {
    throw new Error(`${STACK_HINT}\n\n${String(error)}`);
  }
  db = mongo.db();

  documents = new SourceDocumentService(db);
  retention = new RetentionService(db);
  await documents.ensureIndexes();
  await retention.ensureIndexes();

  s3 = new S3ObjectStoreAdapter({
    bucket: BUCKET,
    region: REGION,
    endpoint: AWS_ENDPOINT,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  if (!(await s3.healthy())) {
    throw new Error(`${STACK_HINT}\n\nThe evidence bucket is not reachable at ${AWS_ENDPOINT}.`);
  }
}, 60_000);

afterAll(async () => {
  await mongo?.close();
});

describe('FI-03 — stage, verify, then commit (the real bucket)', () => {
  it('commits a reference whose object is genuinely there', async () => {
    const tenantId = tenant();
    const staging = stagingWith(s3);

    const record = await staging.stageAndCommit(payload(tenantId));

    // The assertion that matters is not that a record exists — it is that the object the
    // record names can be fetched. This is the T41 first half.
    expect(await staging.referenceResolves(record)).toBe(true);
    const stored = await s3.head(record.storage.key);
    expect(stored?.byteSize).toBe(record.storage.byteSize);
    expect(stored?.checksumValue).toBe(record.storage.checksumValue);

    await s3.remove(record.storage.key);
  });

  it('verifies against the checksum the store computed, not the one we sent', async () => {
    const tenantId = tenant();
    const body = new TextEncoder().encode('Bytes whose hash must survive a round trip.');
    const record = await stagingWith(s3).stageAndCommit({
      ...payload(tenantId),
      body,
    });

    // S3 computed this over the bytes it stored. If the adapter were echoing our own hash back,
    // this would still pass — so the corruption test below is the one that proves it.
    expect(record.storage.checksumValue).toBe(sha256Base64(body));
    expect(record.contentHash).toBe(sha256Base64(body));
    expect(record.storage.verifiedAt).toBeInstanceOf(Date);

    await s3.remove(record.storage.key);
  });

  it('generates the key server-side with no caller input anywhere in it (SEC-03)', async () => {
    const tenantId = tenant();
    const record = await stagingWith(s3).stageAndCommit({
      ...payload(tenantId),
      publisher: 'Example Gazette',
      sourceUrl: 'https://example.test/secret-subject-name/../../etc/passwd',
    });

    const key = record.storage.key;
    expect(key.startsWith(tenantPrefix(tenantId, REGION))).toBe(true);
    // A key derived from a publisher or a URL leaks the subject of a screening into object
    // metadata, and a key carrying a caller-supplied path is a traversal waiting to be found.
    expect(key).not.toContain('Example');
    expect(key).not.toContain('example.test');
    expect(key).not.toContain('..');
    expect(key).not.toContain('passwd');
    expect(tenantOfKey(key, REGION)).toBe(tenantId);

    await s3.remove(record.storage.key);
  });
});

describe('FI-03 — nothing is committed unless the object verified', () => {
  it('commits no reference when the store holds different bytes than we sent', async () => {
    const tenantId = tenant();
    const store = new InMemoryObjectStore();
    store.corruptChecksum = true;

    await expect(stagingWith(store).stageAndCommit(payload(tenantId))).rejects.toThrow(
      /Refusing to commit a reference/u,
    );

    // The load-bearing assertion. A staging bug that throws *and* commits would pass a test
    // that only checked the throw — and the record it left behind is the dangling success.
    expect(await db.collection('sourceDocumentVersions').countDocuments({ tenantId })).toBe(0);
  });

  it('removes the unverified object rather than leaving debris for the retry to race', async () => {
    const tenantId = tenant();
    const store = new InMemoryObjectStore();
    store.corruptChecksum = true;

    await expect(stagingWith(store).stageAndCommit(payload(tenantId))).rejects.toThrow();

    expect(store.size()).toBe(0);
  });

  it('commits no reference when the upload itself fails', async () => {
    const tenantId = tenant();
    const store = new InMemoryObjectStore();
    store.failNextPut = 'bucket unreachable';

    await expect(stagingWith(store).stageAndCommit(payload(tenantId))).rejects.toThrow(
      /bucket unreachable/u,
    );
    expect(await db.collection('sourceDocumentVersions').countDocuments({ tenantId })).toBe(0);
  });

  it('refuses a reference that was never verified, even if a caller assembles one by hand', async () => {
    const tenantId = tenant();
    // The persistence layer's own guard, independent of the staging service. Two locks on the
    // same door, because this is the failure that must not happen.
    await expect(
      documents.commit({
        tenantId,
        sourceId: 'src-test',
        publisher: 'Example Gazette',
        sourceUrl: 'https://example.test/1',
        canonicalUrl: 'https://example.test/1',
        sourceTier: '2',
        retrievedAt: { value: '2026-09-11', precision: 'DAY', timezone: null },
        contentHash: 'whatever',
        storage: {
          bucket: BUCKET,
          key: 'evidence/forged',
          byteSize: 10,
          contentType: 'text/plain',
          checksumAlgorithm: 'SHA256',
          checksumValue: 'forged',
          verifiedAt: null as unknown as Date,
        },
        retentionExpiresAt: null,
        now: new Date(),
      }),
    ).rejects.toThrow(/never verified/u);
  });
});

describe('FI-03 — the orphan sweep', () => {
  it('deletes an unreferenced object older than the window', async () => {
    const tenantId = tenant();
    const store = new InMemoryObjectStore();
    const now = new Date();

    // Staged and never committed: exactly what a crash between the two leaves behind.
    store.now = new Date(now.getTime() - ORPHAN_WINDOW_MS - 60_000);
    const key = keyFor({ tenantId, region: REGION, now });
    await store.put({
      key,
      body: new TextEncoder().encode('orphan'),
      contentType: 'text/plain',
      checksumValue: sha256Base64(new TextEncoder().encode('orphan')),
    });

    const summary = await stagingWith(store).sweepOrphans({ tenantId, now });

    expect(summary.deleted).toBe(1);
    expect(await store.head(key)).toBeNull();
  });

  it('leaves an unreferenced object that is still inside the window', async () => {
    const tenantId = tenant();
    const store = new InMemoryObjectStore();
    const now = new Date();

    // Young and unreferenced is the normal state of an upload in flight, not an orphan. A
    // sweep that deleted this would be deleting objects out from under commits in progress.
    store.now = new Date(now.getTime() - 60_000);
    const key = keyFor({ tenantId, region: REGION, now });
    await store.put({
      key,
      body: new TextEncoder().encode('in flight'),
      contentType: 'text/plain',
      checksumValue: sha256Base64(new TextEncoder().encode('in flight')),
    });

    const summary = await stagingWith(store).sweepOrphans({ tenantId, now });

    expect(summary.deleted).toBe(0);
    expect(summary.withinWindow).toBe(1);
    expect(await store.head(key)).not.toBeNull();
  });

  it('never deletes an object a committed reference names, however old it is', async () => {
    const tenantId = tenant();
    const store = new InMemoryObjectStore();
    const now = new Date();

    store.now = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000);
    const staging = stagingWith(store);
    const record = await staging.stageAndCommit({ ...payload(tenantId), now });

    const summary = await staging.sweepOrphans({ tenantId, now });

    // The reconciler for FI-03 deleting a referenced object would *cause* the exact failure
    // FI-03 exists to prevent. Age is not the guard here; the committed-key set is.
    expect(summary.deleted).toBe(0);
    expect(await store.head(record.storage.key)).not.toBeNull();
    expect(await staging.referenceResolves(record)).toBe(true);
  });

  it('deletes only objects this system created, not everything under the prefix', async () => {
    const tenantId = tenant();
    const store = new InMemoryObjectStore();
    const now = new Date();
    store.now = new Date(now.getTime() - ORPHAN_WINDOW_MS - 60_000);

    // Three objects under the tenant's own prefix that `keyFor` could never have produced: a
    // literal `..` name (S3 treats it as text, not traversal), a hand-uploaded file, and a key
    // from a hypothetical older layout. The sweep lists the prefix, so it sees all three — and
    // a guard that only re-checked the prefix would happily delete every one of them.
    const foreign = [
      `${tenantPrefix(tenantId, REGION)}../../other/object`,
      `${tenantPrefix(tenantId, REGION)}uploaded-by-hand.pdf`,
      `${tenantPrefix(tenantId, REGION)}2026-09-11/not-a-uuid`,
    ];
    for (const key of foreign) {
      await store.put({
        key,
        body: new TextEncoder().encode('not ours'),
        contentType: 'text/plain',
        checksumValue: sha256Base64(new TextEncoder().encode('not ours')),
      });
      expect(tenantOfKey(key, REGION)).toBeNull();
    }

    // ...and one the system really did create, so the test proves the sweep still works rather
    // than that it has been disabled.
    const ours = keyFor({ tenantId, region: REGION, now });
    await store.put({
      key: ours,
      body: new TextEncoder().encode('ours'),
      contentType: 'text/plain',
      checksumValue: sha256Base64(new TextEncoder().encode('ours')),
    });
    expect(tenantOfKey(ours, REGION)).toBe(tenantId);

    const summary = await stagingWith(store).sweepOrphans({ tenantId, now });

    expect(summary.deleted).toBe(1);
    expect(summary.unattributable).toBe(3);
    expect(await store.head(ours)).toBeNull();
    for (const key of foreign) {
      expect(await store.head(key)).not.toBeNull();
    }
  });

  it("never touches another tenant's objects (SEC-01)", async () => {
    const alpha = tenant();
    const beta = tenant();
    const store = new InMemoryObjectStore();
    const now = new Date();
    store.now = new Date(now.getTime() - ORPHAN_WINDOW_MS - 60_000);

    const betaKey = keyFor({ tenantId: beta, region: REGION, now });
    await store.put({
      key: betaKey,
      body: new TextEncoder().encode('beta orphan'),
      contentType: 'text/plain',
      checksumValue: sha256Base64(new TextEncoder().encode('beta orphan')),
    });

    const summary = await stagingWith(store).sweepOrphans({ tenantId: alpha, now });

    expect(summary.listed).toBe(0);
    expect(summary.deleted).toBe(0);
    expect(await store.head(betaKey)).not.toBeNull();
  });

  it('sweeps the real bucket, against real listing and real deletes', async () => {
    const tenantId = tenant();
    const now = new Date();
    const staging = stagingWith(s3);

    // One committed, one orphan. The orphan is written directly, which is what a crash between
    // staging and commit actually leaves.
    const committed = await staging.stageAndCommit({ ...payload(tenantId), now });
    const orphanKey = keyFor({ tenantId, region: REGION, now });
    await s3.put({
      key: orphanKey,
      body: new TextEncoder().encode('real orphan'),
      contentType: 'text/plain',
      checksumValue: sha256Base64(new TextEncoder().encode('real orphan')),
    });

    // Window of zero, because S3 sets `lastModified` itself and the test cannot age it.
    const summary = await staging.sweepOrphans({ tenantId, now: new Date(), windowMs: 0 });

    expect(summary.deleted).toBe(1);
    expect(await s3.head(orphanKey)).toBeNull();
    expect(await staging.referenceResolves(committed)).toBe(true);

    await s3.remove(committed.storage.key);
  });
});

describe('FI-15 — mark the reference, then delete the object', () => {
  async function scheduledDocument(store: ObjectStorePort, tenantId: string, dueAt: Date) {
    const record = await stagingWith(store).stageAndCommit({
      ...payload(tenantId),
      retentionExpiresAt: dueAt,
    });
    const action = await retention.findByTarget(tenantId, record.documentVersionId);
    expect(action).not.toBeNull();
    return { record, action: action! };
  }

  it('deletes the object and closes the action only once the object is gone', async () => {
    const tenantId = tenant();
    const store = new InMemoryObjectStore();
    const past = new Date(Date.now() - 1000);
    const { record, action } = await scheduledDocument(store, tenantId, past);

    const summary = await sweeperWith(store).sweepOnce({ now: new Date(), tenantId });

    expect(summary.completed).toBeGreaterThanOrEqual(1);
    expect(await store.head(record.storage.key)).toBeNull();
    const closed = await retention.findByTarget(tenantId, action.targetId);
    expect(closed?.state).toBe('COMPLETED');
    // Marked before deleted, never the inverse — the ordering is the whole row.
    expect(closed?.referenceMarkedAt).not.toBeNull();
  });

  it('does not close an action while the object is still present', async () => {
    const tenantId = tenant();
    const store = new InMemoryObjectStore();
    const past = new Date(Date.now() - 1000);
    const { action } = await scheduledDocument(store, tenantId, past);

    // A store whose delete silently does nothing. "I asked for a delete" is not "the object is
    // gone", and an action that closed here would report a retention obligation as discharged
    // while the bytes are still sitting in the bucket.
    const deaf = new RemoveOverride(store, async () => Promise.resolve());

    const summary = await sweeperWith(deaf).sweepOnce({
      now: new Date(),
      tenantId,
      random: () => 0.5,
    });

    expect(summary.completed).toBe(0);
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    const open = await retention.findByTarget(tenantId, action.targetId);
    expect(open?.state).toBe('FAILED');
    expect(open?.completedAt).toBeNull();
    expect(open?.lastError).toContain('still present');
  });

  it('stops for a legal hold raised after the action was scheduled', async () => {
    const tenantId = tenant();
    const store = new InMemoryObjectStore();
    const past = new Date(Date.now() - 1000);
    const { record, action } = await scheduledDocument(store, tenantId, past);

    // The hold arrives after scheduling — which is the only case that matters. A hold placed
    // the moment litigation starts must protect the evidence that litigation is about.
    await documents.setLegalHold({ tenantId, documentId: record.documentId, held: true });

    const summary = await sweeperWith(store).sweepOnce({ now: new Date(), tenantId });

    expect(summary.held).toBeGreaterThanOrEqual(1);
    expect(summary.completed).toBe(0);
    expect(await store.head(record.storage.key)).not.toBeNull();
    expect((await retention.findByTarget(tenantId, action.targetId))?.state).toBe('HELD');
  });

  it('retries a failed delete rather than losing the obligation', async () => {
    const tenantId = tenant();
    const store = new InMemoryObjectStore();
    const past = new Date(Date.now() - 1000);
    const { record, action } = await scheduledDocument(store, tenantId, past);

    const broken = new RemoveOverride(store, async () =>
      Promise.reject(new Error('bucket unreachable')),
    );

    const first = await sweeperWith(broken).sweepOnce({
      now: new Date(),
      tenantId,
      random: () => 0,
    });
    expect(first.failed).toBeGreaterThanOrEqual(1);
    expect((await retention.findByTarget(tenantId, action.targetId))?.state).toBe('FAILED');

    // Recovered: the action is still due, and the second pass closes it. Nothing was lost.
    const second = await sweeperWith(store).sweepOnce({ now: new Date(), tenantId });
    expect(second.completed).toBeGreaterThanOrEqual(1);
    expect(await store.head(record.storage.key)).toBeNull();
    expect((await retention.findByTarget(tenantId, action.targetId))?.state).toBe('COMPLETED');
  });

  it('deletes from the real bucket', async () => {
    const tenantId = tenant();
    const past = new Date(Date.now() - 1000);
    const { record, action } = await scheduledDocument(s3, tenantId, past);
    expect(await s3.head(record.storage.key)).not.toBeNull();

    await sweeperWith(s3).sweepOnce({ now: new Date(), tenantId });

    expect(await s3.head(record.storage.key)).toBeNull();
    expect((await retention.findByTarget(tenantId, action.targetId))?.state).toBe('COMPLETED');
  });
});
