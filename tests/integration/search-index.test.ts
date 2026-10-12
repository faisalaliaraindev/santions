/**
 * Phase C step C3 — the search index, against the real Meilisearch in the local stack.
 *
 * Two things here can only be tested against the real index, and both matter:
 *
 * - **Writes are asynchronous.** A document is not searchable when the write returns. The
 *   adapter waits for the index's own task, and an in-process fake would hide the entire
 *   problem by being synchronous.
 * - **The filter language is a query language.** Tenant scoping is a filter expression, and
 *   whether it actually isolates tenants is a property of Meilisearch, not of our string.
 *
 * The reconciler is tested against both: the real index for the happy path, and the in-process
 * one for failure injection, because making a real index fail on demand means breaking it.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 */

import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { normaliseName, phoneticKeys } from '../../packages/domain/src/index.js';

import { SourceDocumentService } from '../../apps/api/src/persistence/source-document.service.js';
import {
  IndexerService,
  REINDEX_GRACE_MS,
} from '../../apps/api/src/search-index/indexer.service.js';
import { MeilisearchAdapter } from '../../apps/api/src/search-index/meilisearch.adapter.js';
import {
  InMemorySearchIndex,
  type SearchIndexPort,
} from '../../apps/api/src/search-index/search-index.port.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';
const MEILI_HOST = process.env['MEILI_HOST'] ?? 'http://127.0.0.1:28700';
const MEILI_KEY = process.env['MEILI_MASTER_KEY'] ?? 'local-development-master-key-change-me';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

let mongo: MongoClient;
let db: Db;
let meili: MeilisearchAdapter;
let documents: SourceDocumentService;

function tenant(): string {
  return `t-index-${randomUUID()}`;
}

/** A subject version as the collection stores it, so the projection is exercised for real. */
function subjectRow(input: { tenantId: string; fullName: string; aliases?: string[] }): {
  tenantId: string;
  subjectId: string;
  subjectVersionId: string;
  version: number;
  fullName: string;
  normalised: {
    folded: string;
    sortedCoreKey: string;
    phoneticKeys: string[];
    scripts: string[];
  };
  aliases: { value: string }[];
  countryContext: string[];
  createdAt: Date;
} {
  const normalised = normaliseName(input.fullName);
  return {
    tenantId: input.tenantId,
    subjectId: randomUUID(),
    subjectVersionId: randomUUID(),
    version: 1,
    fullName: input.fullName,
    normalised: {
      folded: normalised.folded,
      sortedCoreKey: normalised.sortedCoreKey,
      phoneticKeys: [...phoneticKeys(normalised)],
      scripts: [...normalised.scripts],
    },
    aliases: (input.aliases ?? []).map((value) => ({ value })),
    countryContext: ['CR'],
    // Old enough that the reconciler's grace window does not exclude it.
    createdAt: new Date(Date.now() - 2 * REINDEX_GRACE_MS),
  };
}

beforeAll(async () => {
  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
  } catch (error) {
    throw new Error(`${STACK_HINT}\n\nMongoDB connection failed: ${String(error)}`);
  }
  db = mongo.db();
  documents = new SourceDocumentService(db);
  meili = new MeilisearchAdapter({ host: MEILI_HOST, apiKey: MEILI_KEY });

  if (!(await meili.healthy())) {
    throw new Error(`${STACK_HINT}\n\nMeilisearch is not reachable at ${MEILI_HOST}.`);
  }
  await documents.ensureIndexes();
}, 60_000);

afterAll(async () => {
  await mongo.close();
});

describe('MeilisearchAdapter — the real index', () => {
  it('does not report a write as indexed until it is actually searchable', async () => {
    const tenantId = tenant();
    const row = subjectRow({ tenantId, fullName: 'Ana María Solís' });

    const outcome = await meili.upsertSubjects([IndexerService.projectSubject(row)]);
    expect(outcome.indexed).toContain(row.subjectVersionId);

    // No wait, no retry loop, no polling in the test. If `upsertSubjects` returned before the
    // document was searchable, this assertion is what fails — which is the whole point of the
    // adapter waiting on the index's task rather than on the HTTP response.
    const hits = await meili.searchSubjects({ tenantId, text: 'solis', limit: 10 });
    expect(hits.map((h) => h.document.subjectVersionId)).toContain(row.subjectVersionId);
  });

  it('matches on the derived name forms, not the original spelling (FR-08)', async () => {
    const tenantId = tenant();
    const row = subjectRow({ tenantId, fullName: 'José María Solís-Rojas' });
    await meili.upsertSubjects([IndexerService.projectSubject(row)]);

    // Written without accents and without the hyphen — the same person, spelled as a careless
    // integrator would send it. Matching the raw name would miss this.
    const hits = await meili.searchSubjects({
      tenantId,
      text: 'jose maria solis rojas',
      limit: 10,
    });
    expect(hits.map((h) => h.document.subjectVersionId)).toContain(row.subjectVersionId);
  });

  it("never returns another tenant's subject (SEC-01)", async () => {
    const alpha = tenant();
    const beta = tenant();
    const name = `Zulema Quirós ${randomUUID().slice(0, 8)}`;

    const alphaRow = subjectRow({ tenantId: alpha, fullName: name });
    const betaRow = subjectRow({ tenantId: beta, fullName: name });
    await meili.upsertSubjects([
      IndexerService.projectSubject(alphaRow),
      IndexerService.projectSubject(betaRow),
    ]);

    // Deliberately identical names in two tenants: the index must isolate on the filter, not
    // on the text happening to differ.
    const asAlpha = await meili.searchSubjects({ tenantId: alpha, text: 'zulema', limit: 50 });
    const ids = asAlpha.map((h) => h.document.subjectVersionId);

    expect(ids).toContain(alphaRow.subjectVersionId);
    expect(ids).not.toContain(betaRow.subjectVersionId);
    expect(asAlpha.every((h) => h.document.tenantId === alpha)).toBe(true);
  });

  it('removes an entry when the record is restricted (SEC-05)', async () => {
    const tenantId = tenant();
    const row = subjectRow({ tenantId, fullName: 'Marta Vargas' });
    await meili.upsertSubjects([IndexerService.projectSubject(row)]);
    expect(await meili.searchSubjects({ tenantId, text: 'vargas', limit: 10 })).not.toHaveLength(0);

    await meili.removeSubjects([row.subjectVersionId]);

    // A restricted record that remains searchable is still disclosed, whatever the record says.
    expect(await meili.searchSubjects({ tenantId, text: 'vargas', limit: 10 })).toHaveLength(0);
  });

  it('purges a whole tenant, for a rebuild or an erasure request', async () => {
    const tenantId = tenant();
    await meili.upsertSubjects([
      IndexerService.projectSubject(subjectRow({ tenantId, fullName: 'Uno Pérez' })),
      IndexerService.projectSubject(subjectRow({ tenantId, fullName: 'Dos Pérez' })),
    ]);
    expect(await meili.searchSubjects({ tenantId, text: 'perez', limit: 10 })).toHaveLength(2);

    await meili.purgeTenant(tenantId);
    expect(await meili.searchSubjects({ tenantId, text: 'perez', limit: 10 })).toHaveLength(0);
  });

  it('answers a batch of queries positionally, so each name form keeps its own hits', async () => {
    const tenantId = tenant();
    const marker = randomUUID().slice(0, 8);
    const ana = subjectRow({ tenantId, fullName: `Ana Belén Quintero ${marker}` });
    const ivan = subjectRow({ tenantId, fullName: `Iván Kuznetsov ${marker}` });
    await meili.upsertSubjects([
      IndexerService.projectSubject(ana),
      IndexerService.projectSubject(ivan),
    ]);

    const results = await meili.searchSubjectsBatch([
      { tenantId, text: `quintero ${marker}`, limit: 10 },
      { tenantId, text: `kuznetsov ${marker}`, limit: 10 },
    ]);

    // Positional, not merged. Which form produced a hit is evidence the matcher uses to decide
    // what the agreement is worth (FR-08); a merged list throws that away.
    expect(results).toHaveLength(2);
    expect(results[0]!.map((h) => h.document.subjectVersionId)).toContain(ana.subjectVersionId);
    expect(results[0]!.map((h) => h.document.subjectVersionId)).not.toContain(
      ivan.subjectVersionId,
    );
    expect(results[1]!.map((h) => h.document.subjectVersionId)).toContain(ivan.subjectVersionId);
  });

  it('applies the tenant filter to every query in a batch (SEC-01)', async () => {
    const alpha = tenant();
    const beta = tenant();
    const name = `Rosalía Étienne ${randomUUID().slice(0, 8)}`;
    const alphaRow = subjectRow({ tenantId: alpha, fullName: name });
    const betaRow = subjectRow({ tenantId: beta, fullName: name });
    await meili.upsertSubjects([
      IndexerService.projectSubject(alphaRow),
      IndexerService.projectSubject(betaRow),
    ]);

    // Three queries, so a filter applied only to the first would still look correct in the
    // result set of the first — which is how a batch path loses tenant scoping unnoticed.
    const results = await meili.searchSubjectsBatch([
      { tenantId: alpha, text: 'rosalia', limit: 50 },
      { tenantId: alpha, text: 'etienne', limit: 50 },
      { tenantId: alpha, text: name.toLowerCase(), limit: 50 },
    ]);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.every((h) => h.document.tenantId === alpha)).toBe(true);
      expect(result.map((h) => h.document.subjectVersionId)).not.toContain(
        betaRow.subjectVersionId,
      );
    }
  });

  it('returns the same hits in a batch as the queries would return one at a time', async () => {
    // The batch exists to save round trips, not to change answers. If the two ever disagree,
    // the matcher's recall depends on which method it happened to call.
    const tenantId = tenant();
    const marker = randomUUID().slice(0, 8);
    await meili.upsertSubjects(
      ['Piotr Nowicki', 'Petra Nowicka', 'Pyotr Novitski'].map((fullName) =>
        IndexerService.projectSubject(subjectRow({ tenantId, fullName: `${fullName} ${marker}` })),
      ),
    );

    const queries = [
      { tenantId, text: `nowicki ${marker}`, limit: 20 },
      { tenantId, text: `novitski ${marker}`, limit: 20 },
      { tenantId, text: `nowicka ${marker}`, limit: 20 },
    ];
    const batched = await meili.searchSubjectsBatch(queries);
    const individually = [];
    for (const query of queries) {
      individually.push(await meili.searchSubjects(query));
    }

    expect(batched.map((r) => r.map((h) => h.document.subjectVersionId))).toEqual(
      individually.map((r) => r.map((h) => h.document.subjectVersionId)),
    );
  });

  it('treats an empty batch as no work, not as a request with no tenant', async () => {
    expect(await meili.searchSubjectsBatch([])).toEqual([]);
  });

  it('raises on a failed batch rather than returning empty result sets', async () => {
    const broken = new MeilisearchAdapter({ host: MEILI_HOST, apiKey: 'not-the-master-key' });
    await expect(
      broken.searchSubjectsBatch([{ tenantId: tenant(), text: 'anything', limit: 10 }]),
    ).rejects.toThrow(/Batch search on subjects failed/u);
  });

  it('raises rather than answering "no matches" when the index cannot answer', async () => {
    // An index outage reported as an empty result is a clean screening result for a person who
    // was never actually searched for. It must be an error the caller has to handle.
    const broken = new MeilisearchAdapter({ host: MEILI_HOST, apiKey: 'not-the-master-key' });
    await expect(
      broken.searchSubjects({ tenantId: tenant(), text: 'anything', limit: 10 }),
    ).rejects.toThrow(/Search on subjects failed/u);
  });
});

describe('the reconciler (FI-10)', () => {
  async function indexerWith(
    port: SearchIndexPort,
  ): Promise<{ indexer: IndexerService; port: SearchIndexPort }> {
    const indexer = new IndexerService(db, port, documents);
    await indexer.ensureIndexes();
    return { indexer, port };
  }

  /**
   * Run the reconciler until it stops making progress.
   *
   * One call is deliberately bounded to a batch, so that a large backlog cannot monopolise the
   * process — which means a single pass is not expected to clear everything and a test must not
   * assume it does. The shared local database accumulates unindexed rows from every previous
   * run, so draining is also what makes these assertions about *this* record rather than about
   * how much unrelated backlog happened to be ahead of it.
   */
  async function drain(indexer: IndexerService): Promise<void> {
    for (let pass = 0; pass < 50; pass += 1) {
      const summary = await indexer.reconcile(new Date());
      if (summary.subjectsReindexed + summary.documentsReindexed === 0) {
        return;
      }
    }
  }

  it('indexes a committed subject and records that it is indexed', async () => {
    const tenantId = tenant();
    const row = subjectRow({ tenantId, fullName: 'Carlos Jiménez' });
    await db.collection('subjectVersions').insertOne(row);

    const { indexer } = await indexerWith(meili);
    expect(await indexer.indexSubject(row.subjectVersionId, tenantId)).toBe(true);

    const stored = await db
      .collection('subjectVersions')
      .findOne({ subjectVersionId: row.subjectVersionId });
    expect(stored?.['indexState']).toBe('INDEXED');
  });

  it('records a failed index write instead of losing it, then recovers it', async () => {
    const tenantId = tenant();
    const row = subjectRow({ tenantId, fullName: 'Lucía Mora' });
    await db.collection('subjectVersions').insertOne(row);

    const port = new InMemorySearchIndex();
    port.failWrites = 'index unreachable';
    const { indexer } = await indexerWith(port);

    // The request that created the subject must not fail because a cache was unreachable — but
    // the failure must be recorded, or the subject is invisible and nobody knows.
    expect(await indexer.indexSubject(row.subjectVersionId, tenantId)).toBe(false);
    expect(
      (
        await db.collection('subjectVersions').findOne({ subjectVersionId: row.subjectVersionId })
      )?.['indexState'],
    ).toBe('FAILED');

    // The gate check counts it. Zero is the only passing answer.
    expect((await indexer.countUnindexed(new Date())).subjects).toBeGreaterThan(0);

    port.failWrites = null;
    await drain(indexer);

    expect(
      (
        await db.collection('subjectVersions').findOne({ subjectVersionId: row.subjectVersionId })
      )?.['indexState'],
    ).toBe('INDEXED');
    expect(port.size().subjects).toBeGreaterThan(0);
  });

  it('reconciles a record that was never indexed at all, including a legacy one', async () => {
    // A subject version written before C3 carries no `indexState` field whatsoever. A sweep
    // that listed PENDING and FAILED would skip it silently — which is why the query is
    // `$ne: 'INDEXED'`. This is the additive-only migration decision being paid for.
    const tenantId = tenant();
    const legacy = subjectRow({ tenantId, fullName: 'Rafael Céspedes' });
    await db.collection('subjectVersions').insertOne(legacy);

    const port = new InMemorySearchIndex();
    const { indexer } = await indexerWith(port);

    const before = await indexer.countUnindexed(new Date());
    expect(before.subjects).toBeGreaterThan(0);

    await drain(indexer);

    expect(
      (
        await db
          .collection('subjectVersions')
          .findOne({ subjectVersionId: legacy.subjectVersionId })
      )?.['indexState'],
    ).toBe('INDEXED');
  });

  it('leaves a freshly committed record alone until its grace window passes', async () => {
    const tenantId = tenant();
    const fresh = { ...subjectRow({ tenantId, fullName: 'Nueva Persona' }), createdAt: new Date() };
    await db.collection('subjectVersions').insertOne(fresh);

    const port = new InMemorySearchIndex();
    const { indexer } = await indexerWith(port);

    // A sweep with no grace window races the write it is trying to repair, and under load it
    // would "reconcile" documents that are about to be indexed a moment later.
    await indexer.reconcile(new Date());
    const stored = await db
      .collection('subjectVersions')
      .findOne({ subjectVersionId: fresh.subjectVersionId });
    expect(stored?.['indexState']).toBeUndefined();
  });

  it('rebuilds a tenant from MongoDB, discarding whatever the index held', async () => {
    const tenantId = tenant();
    const rows = [
      subjectRow({ tenantId, fullName: 'Uno Rebuild' }),
      subjectRow({ tenantId, fullName: 'Dos Rebuild' }),
    ];
    await db.collection('subjectVersions').insertMany(rows);

    const port = new InMemorySearchIndex();
    const { indexer } = await indexerWith(port);

    // Something the index believes but MongoDB does not: a stale entry for a record that no
    // longer exists. A rebuild must remove it, because MongoDB is the system of record.
    await port.upsertSubjects([
      IndexerService.projectSubject(subjectRow({ tenantId, fullName: 'Ghost Entry' })),
    ]);

    const rebuilt = await indexer.rebuildTenant(tenantId);
    expect(rebuilt).toBe(2);

    const hits = await port.searchSubjects({ tenantId, text: 'ghost', limit: 10 });
    expect(hits).toHaveLength(0);
    expect((await port.searchSubjects({ tenantId, text: 'rebuild', limit: 10 })).length).toBe(2);
  });

  it('counts a FAILED document as unindexed, so the gate check cannot pass by omission', async () => {
    const tenantId = tenant();
    const now = new Date();
    const committed = await documents.commit({
      tenantId,
      sourceId: 'fixture-news',
      publisher: 'Fixture Times',
      sourceUrl: 'https://fixtures.local/a',
      canonicalUrl: 'https://fixtures.local/a',
      sourceTier: 'TIER_3',
      retrievedAt: { value: now.toISOString(), precision: 'DAY', timezone: 'UTC' },
      contentHash: 'c'.repeat(64),
      storage: {
        bucket: 'evidence-local',
        key: `tenant/region/${randomUUID()}`,
        byteSize: 10,
        contentType: 'text/html',
        checksumAlgorithm: 'SHA256',
        checksumValue: 'd'.repeat(64),
        verifiedAt: now,
      },
      retentionExpiresAt: null,
      now: new Date(now.getTime() - 2 * REINDEX_GRACE_MS),
    });

    await documents.markIndexFailed({
      tenantId,
      documentVersionId: committed.documentVersionId,
      error: 'index rejected it',
    });

    const { indexer } = await indexerWith(new InMemorySearchIndex());
    expect((await indexer.countUnindexed(new Date())).documents).toBeGreaterThan(0);

    await drain(indexer);
    const after = await documents.findVersion(tenantId, committed.documentVersionId);
    expect(after?.indexState).toBe('INDEXED');
  });
});
