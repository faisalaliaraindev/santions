import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import { normaliseName } from '@erly/adverse-domain';

import type {
  IndexedSourceRefreshState,
  IndexedSourceTransactionPort,
  NormalizedSourceRecord,
  SnapshotCommitInput,
  StoredIndexedSourceRecord,
} from './indexed-source.types.js';

interface SnapshotRecord {
  readonly sourceId: string;
  readonly snapshotVersion: string;
  readonly sourceVersion: number;
  readonly artifactHash: string;
  readonly artifactUrl: string;
  readonly parserVersion: string;
  readonly publisherVersion: string | null;
  readonly retrievedAt: Date;
  readonly rowCount: number;
  readonly createdAt: Date;
}

interface RefreshClaim {
  readonly claimed: boolean;
  readonly refreshId: string;
  readonly previous: IndexedSourceRefreshState | null;
}

const EMPTY_STATE = (sourceId: string): IndexedSourceRefreshState => ({
  sourceId,
  activeSourceVersion: null,
  lastAttemptAt: null,
  lastSuccessfulRefreshAt: null,
  refreshStatus: 'NEVER_REFRESHED',
  httpStatus: null,
  artifactHash: null,
  etag: null,
  lastModified: null,
  parserVersion: null,
  rowCount: 0,
  insertedCount: 0,
  updatedCount: 0,
  removedCount: 0,
  activeSnapshotVersion: null,
  failureReason: null,
  freshness: 'UNAVAILABLE',
  nextRefreshDueAt: null,
  refreshLease: null,
});

@Injectable()
export class IndexedSourceRepository {
  private readonly records: Collection<StoredIndexedSourceRecord>;
  private readonly snapshots: Collection<SnapshotRecord>;
  private readonly states: Collection<IndexedSourceRefreshState>;

  constructor(
    db: Db,
    private readonly transactions: IndexedSourceTransactionPort,
  ) {
    this.records = db.collection('indexedSourceRecords');
    this.snapshots = db.collection('indexedSourceSnapshots');
    this.states = db.collection('indexedSourceRefreshStates');
  }

  async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.records.createIndex(
        { sourceId: 1, sourceSnapshotVersion: 1, sourceRecordId: 1 },
        { unique: true },
      ),
      this.records.createIndex({ sourceId: 1, sourceSnapshotVersion: 1, nameKeys: 1 }),
      this.records.createIndex({ sourceId: 1, sourceSnapshotVersion: 1, searchTokens: 1 }),
      this.records.createIndex({ sourceId: 1, sourceSnapshotVersion: 1, recordType: 1 }),
      this.snapshots.createIndex({ sourceId: 1, snapshotVersion: 1 }, { unique: true }),
      this.states.createIndex({ sourceId: 1 }, { unique: true }),
      this.states.createIndex({ nextRefreshDueAt: 1, refreshStatus: 1 }),
    ]);
  }

  async state(sourceId: string): Promise<IndexedSourceRefreshState> {
    return (await this.states.findOne({ sourceId })) ?? EMPTY_STATE(sourceId);
  }

  async listStates(sourceIds?: readonly string[]): Promise<IndexedSourceRefreshState[]> {
    const stored = await this.states
      .find(sourceIds === undefined ? {} : { sourceId: { $in: [...sourceIds] } })
      .sort({ sourceId: 1 })
      .toArray();
    if (sourceIds === undefined) {
      return stored;
    }
    const byId = new Map(stored.map((state) => [state.sourceId, state]));
    return [...new Set(sourceIds)]
      .sort((left, right) => left.localeCompare(right))
      .map((sourceId) => byId.get(sourceId) ?? EMPTY_STATE(sourceId));
  }

  async claimRefresh(input: {
    readonly sourceId: string;
    readonly sourceVersion: number;
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<RefreshClaim> {
    const refreshId = randomUUID();
    await this.states.updateOne(
      { sourceId: input.sourceId },
      { $setOnInsert: EMPTY_STATE(input.sourceId) },
      { upsert: true },
    );
    const previous = await this.state(input.sourceId);
    const result = await this.states.findOneAndUpdate(
      {
        sourceId: input.sourceId,
        $or: [
          { refreshLease: null },
          { refreshLease: { $exists: false } },
          { 'refreshLease.expiresAt': { $lte: input.now } },
        ],
      },
      {
        $set: {
          sourceId: input.sourceId,
          activeSourceVersion: previous.activeSourceVersion,
          lastAttemptAt: input.now,
          refreshStatus: 'REFRESHING',
          failureReason: null,
          refreshLease: {
            refreshId,
            expiresAt: new Date(input.now.getTime() + input.leaseMs),
          },
        },
      },
      { returnDocument: 'after', includeResultMetadata: true },
    );

    return {
      claimed: result.value?.refreshLease?.refreshId === refreshId,
      refreshId,
      previous,
    };
  }

  async recordNotModified(input: {
    readonly sourceId: string;
    readonly refreshId: string;
    readonly now: Date;
    readonly httpStatus: number;
    readonly refreshIntervalMs: number;
  }): Promise<void> {
    await this.states.updateOne(
      { sourceId: input.sourceId, 'refreshLease.refreshId': input.refreshId },
      {
        $set: {
          refreshStatus: 'NOT_MODIFIED',
          httpStatus: input.httpStatus,
          failureReason: null,
          freshness: 'CURRENT',
          nextRefreshDueAt: new Date(input.now.getTime() + input.refreshIntervalMs),
          refreshLease: null,
        },
      },
    );
  }

  async recordFailure(input: {
    readonly sourceId: string;
    readonly refreshId: string;
    readonly now: Date;
    readonly httpStatus: number | null;
    readonly reason: string;
    readonly staleAfterMs: number;
    readonly retryAt: Date;
  }): Promise<void> {
    const previous = await this.state(input.sourceId);
    const freshness =
      previous.lastSuccessfulRefreshAt === null
        ? 'UNAVAILABLE'
        : input.now.getTime() - previous.lastSuccessfulRefreshAt.getTime() > input.staleAfterMs
          ? 'STALE'
          : 'CURRENT';
    await this.states.updateOne(
      { sourceId: input.sourceId, 'refreshLease.refreshId': input.refreshId },
      {
        $set: {
          refreshStatus: 'FAILED',
          httpStatus: input.httpStatus,
          failureReason: input.reason,
          freshness,
          nextRefreshDueAt: input.retryAt,
          refreshLease: null,
        },
      },
    );
  }

  async commitSnapshot(input: SnapshotCommitInput & { readonly refreshId: string }): Promise<void> {
    await this.transactions.run(
      async (session) => {
        const current = await this.states.findOne(
          { sourceId: input.sourceId, 'refreshLease.refreshId': input.refreshId },
          { session },
        );
        if (current === null) {
          throw new Error(`Refresh lease for ${input.sourceId} was lost before snapshot commit.`);
        }

        const oldRecords =
          current.activeSnapshotVersion === null
            ? []
            : await this.records
                .find(
                  {
                    sourceId: input.sourceId,
                    sourceSnapshotVersion: current.activeSnapshotVersion,
                  },
                  { session, projection: { sourceRecordId: 1, rawEvidenceHash: 1 } },
                )
                .toArray();
        const oldById = new Map(
          oldRecords.map((record) => [record.sourceRecordId, record.rawEvidenceHash]),
        );

        const stored = input.records.map((record) => this.toStored(record, input));
        if (stored.length > 0) {
          await this.records.bulkWrite(
            stored.map((record) => ({
              updateOne: {
                filter: {
                  sourceId: record.sourceId,
                  sourceSnapshotVersion: record.sourceSnapshotVersion,
                  sourceRecordId: record.sourceRecordId,
                },
                update: { $setOnInsert: record },
                upsert: true,
              },
            })),
            { ordered: false, session },
          );
        }

        await this.snapshots.updateOne(
          { sourceId: input.sourceId, snapshotVersion: input.snapshotVersion },
          {
            $setOnInsert: {
              sourceId: input.sourceId,
              snapshotVersion: input.snapshotVersion,
              sourceVersion: input.sourceVersion,
              artifactHash: input.artifactHash,
              artifactUrl: input.artifactUrl,
              parserVersion: input.parserVersion,
              publisherVersion: input.publisherVersion,
              retrievedAt: input.retrievedAt,
              rowCount: stored.length,
              createdAt: input.retrievedAt,
            },
          },
          { upsert: true, session },
        );

        const newById = new Map(stored.map((record) => [record.sourceRecordId, record.rawEvidenceHash]));
        const insertedCount = [...newById.keys()].filter((id) => !oldById.has(id)).length;
        const updatedCount = [...newById].filter(
          ([id, hash]) => oldById.has(id) && oldById.get(id) !== hash,
        ).length;
        const removedCount = [...oldById.keys()].filter((id) => !newById.has(id)).length;

        await this.states.updateOne(
          { sourceId: input.sourceId, 'refreshLease.refreshId': input.refreshId },
          {
            $set: {
              activeSourceVersion: input.sourceVersion,
              lastSuccessfulRefreshAt: input.retrievedAt,
              refreshStatus: 'SUCCEEDED',
              httpStatus: 200,
              artifactHash: input.artifactHash,
              etag: input.etag,
              lastModified: input.lastModified,
              parserVersion: input.parserVersion,
              rowCount: stored.length,
              insertedCount,
              updatedCount,
              removedCount,
              activeSnapshotVersion: input.snapshotVersion,
              failureReason: null,
              freshness: 'CURRENT',
              nextRefreshDueAt: new Date(input.retrievedAt.getTime() + input.refreshIntervalMs),
              refreshLease: null,
            },
          },
          { session },
        );
      },
      { name: `indexed-source-snapshot:${input.sourceId}` },
    );
  }

  async search(input: {
    readonly nameForms: readonly string[];
    readonly sourceIds?: readonly string[];
    readonly limit?: number;
  }): Promise<StoredIndexedSourceRecord[]> {
    const states = await this.states
      .find({
        activeSnapshotVersion: { $ne: null },
        ...(input.sourceIds === undefined ? {} : { sourceId: { $in: [...input.sourceIds] } }),
      })
      .toArray();
    if (states.length === 0) {
      return [];
    }
    const keys = [...new Set(input.nameForms.map(nameKey).filter((value) => value !== ''))];
    if (keys.length === 0) {
      return [];
    }
    const snapshots = states.flatMap((state) =>
      state.activeSnapshotVersion === null
        ? []
        : [{ sourceId: state.sourceId, sourceSnapshotVersion: state.activeSnapshotVersion }],
    );
    const textClauses = input.nameForms
      .map((form) => textTokens(form))
      .filter((tokens) => tokens.length > 0)
      .map((tokens) => ({ searchTokens: { $all: tokens } }));
    return this.records
      .find({
        $and: [
          { $or: snapshots },
          { $or: [{ nameKeys: { $in: keys } }, ...textClauses] },
        ],
      })
      .limit(input.limit ?? 250)
      .toArray();
  }

  private toStored(record: NormalizedSourceRecord, input: SnapshotCommitInput): StoredIndexedSourceRecord {
    return {
      ...record,
      sourceSnapshotVersion: input.snapshotVersion,
      sourceVersion: input.sourceVersion,
      parserVersion: input.parserVersion,
      retrievedAt: input.retrievedAt,
      artifactHash: input.artifactHash,
      nameKeys: [...new Set([record.primaryName, ...record.aliases, ...record.originalScriptNames].map(nameKey))],
      searchTokens: textTokens(record.searchableText ?? ''),
      rawEvidenceHash: sha256(stableJson(record.rawEvidence)),
      createdAt: input.retrievedAt,
    };
  }
}

function nameKey(value: string): string {
  return normaliseName(value).folded;
}

function textTokens(value: string): string[] {
  return [
    ...new Set(
      normaliseName(value)
        .tokens.map((token) => token.folded)
        .filter((token) => token.length > 1),
    ),
  ];
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}
