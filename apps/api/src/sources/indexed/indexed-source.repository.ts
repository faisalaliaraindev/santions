import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import { normaliseName } from '@erly/adverse-domain';

import type {
  IndexedSnapshotPruneSummary,
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

/** Records deleted in one pruning pass before it yields. */
const DEFAULT_MAX_RECORD_DELETES = 20_000;
/** Ids read and deleted per round trip inside a pass. */
const DEFAULT_PRUNE_BATCH = 1_000;

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
  lastPrune: null,
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

        const newById = new Map(
          stored.map((record) => [record.sourceRecordId, record.rawEvidenceHash]),
        );
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

  /**
   * Delete the records of snapshots that nothing will read again — **bounded**, and never the
   * active one.
   *
   * # What is kept, and why two rather than one
   *
   * The **active** snapshot is what every search reads; deleting it would empty the shelf while
   * the source reported itself healthy. The **most recent completed snapshot behind it** is kept
   * as well, for two concrete uses: rolling back when a refresh promotes a snapshot that turns
   * out to be wrong, and answering "what changed?" — `commitSnapshot` already computes inserted,
   * updated and removed counts against the previous snapshot, and with only one snapshot retained
   * that comparison has nothing to compare against.
   *
   * Everything older is superseded. Before this existed, nothing deleted it: every
   * content-changing refresh wrote a full new snapshot and kept every previous one forever, so a
   * source refreshed four times a day grew its indexed records without bound.
   *
   * # Why the delete is bounded
   *
   * `deleteMany` over a superseded OFAC snapshot is seventeen thousand documents in one
   * unbounded operation, and doing that inline is how a refresh of one source stalls the process
   * for everything else. Ids are read in pages and deleted in pages, up to a ceiling; whatever is
   * left is picked up by the next pass. `complete` reports which of those happened, so a caller
   * that needs the work finished drains rather than assuming one call did it.
   *
   * **The active snapshot cannot be deleted by any path through this method.** It is excluded
   * from the candidate list by version, not by ordering, so a clock skew or an equal `createdAt`
   * cannot promote it into the superseded set.
   */
  async pruneSupersededSnapshots(input: {
    readonly sourceId: string;
    readonly now: Date;
    readonly maxRecordDeletes?: number;
    readonly batchSize?: number;
  }): Promise<IndexedSnapshotPruneSummary> {
    const maxRecordDeletes = input.maxRecordDeletes ?? DEFAULT_MAX_RECORD_DELETES;
    const batchSize = input.batchSize ?? DEFAULT_PRUNE_BATCH;
    const state = await this.state(input.sourceId);
    const active = state.activeSnapshotVersion;

    const snapshots = await this.snapshots
      .find({ sourceId: input.sourceId })
      .sort({ createdAt: -1, snapshotVersion: -1 })
      .toArray();

    // Excluded by version rather than by position: if `createdAt` ties or a clock moved
    // backwards, ordering alone could put the active snapshot outside the first two.
    const behindActive = snapshots.filter((snapshot) => snapshot.snapshotVersion !== active);
    const retainedPrevious = behindActive[0]?.snapshotVersion ?? null;
    const superseded = behindActive.filter(
      (snapshot) => snapshot.snapshotVersion !== retainedPrevious,
    );

    let recordsDeleted = 0;
    let snapshotsDeleted = 0;
    let complete = true;

    for (const snapshot of superseded) {
      if (snapshot.snapshotVersion === active) {
        // Unreachable by construction; asserted anyway because the cost of being wrong here is
        // an emptied index on a source that reports itself healthy.
        continue;
      }
      let drained = true;
      while (recordsDeleted < maxRecordDeletes) {
        const page = await this.records
          .find(
            { sourceId: input.sourceId, sourceSnapshotVersion: snapshot.snapshotVersion },
            {
              projection: { _id: 1 },
              limit: Math.min(batchSize, maxRecordDeletes - recordsDeleted),
            },
          )
          .toArray();
        if (page.length === 0) {
          break;
        }
        const result = await this.records.deleteMany({
          _id: { $in: page.map((document) => document._id) },
        });
        recordsDeleted += result.deletedCount;
      }
      const remaining = await this.records.countDocuments(
        { sourceId: input.sourceId, sourceSnapshotVersion: snapshot.snapshotVersion },
        { limit: 1 },
      );
      if (remaining > 0) {
        // Out of budget with records still present. The snapshot row stays, so the next pass
        // finds it again — a snapshot row deleted ahead of its records would orphan them.
        drained = false;
        complete = false;
      } else {
        await this.snapshots.deleteOne({
          sourceId: input.sourceId,
          snapshotVersion: snapshot.snapshotVersion,
        });
        snapshotsDeleted += 1;
      }
      if (!drained) {
        break;
      }
    }

    const summary: IndexedSnapshotPruneSummary = {
      sourceId: input.sourceId,
      ranAt: input.now,
      activeSnapshotVersion: active,
      retainedPreviousSnapshotVersion: retainedPrevious,
      snapshotsConsidered: superseded.length,
      snapshotsDeleted,
      recordsDeleted,
      complete,
    };
    // On the state record rather than only in a log line, so `GET /v1/admin/indexed-sources`
    // can show it and an operator can see pruning happening without shell access to the database.
    await this.states.updateOne({ sourceId: input.sourceId }, { $set: { lastPrune: summary } });
    return summary;
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
    const limit = input.limit ?? 250;

    // **Exact name-key matches first, and never crowded out.**
    //
    // These two are not the same kind of candidate. A `nameKeys` hit means a name form the
    // publisher recorded folds to a name form the subject supplied — the strongest retrieval
    // signal this index has. A `searchTokens` hit means the same words appear somewhere in the
    // record's searchable text, which is how an official publication naming a person in its
    // headline is found, and which matches far more loosely.
    //
    // They used to be one `$or` under one `limit`, so the cap was filled in natural collection
    // order. A short, common name — "Abu ABBAS" in the OFAC SDN list — matched hundreds of
    // records on tokens and its own exact entry fell outside the first 250. The subject was on
    // the list, the index held the row, and the search returned nothing for it: a false clean
    // result, which is the one failure this product must not have.
    //
    // Two bounded queries, exact first, then the remaining budget for token matches.
    const snapshotClause = { $or: snapshots };
    const exact = await this.records
      .find({ $and: [snapshotClause, { nameKeys: { $in: keys } }] })
      .limit(limit)
      .toArray();
    if (exact.length >= limit || textClauses.length === 0) {
      return exact;
    }

    const seen = new Set(exact.map((record) => `${record.sourceId}:${record.sourceRecordId}`));
    const loose = await this.records
      .find({ $and: [snapshotClause, { $or: textClauses }] })
      .limit(limit - exact.length + seen.size)
      .toArray();
    for (const record of loose) {
      if (exact.length >= limit) {
        break;
      }
      const key = `${record.sourceId}:${record.sourceRecordId}`;
      if (!seen.has(key)) {
        seen.add(key);
        exact.push(record);
      }
    }
    return exact;
  }

  private toStored(
    record: NormalizedSourceRecord,
    input: SnapshotCommitInput,
  ): StoredIndexedSourceRecord {
    return {
      ...record,
      sourceSnapshotVersion: input.snapshotVersion,
      sourceVersion: input.sourceVersion,
      parserVersion: input.parserVersion,
      retrievedAt: input.retrievedAt,
      artifactHash: input.artifactHash,
      nameKeys: [
        ...new Set(
          [record.primaryName, ...record.aliases, ...record.originalScriptNames].map(nameKey),
        ),
      ],
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
