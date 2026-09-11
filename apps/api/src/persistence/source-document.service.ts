/**
 * `SourceDocumentVersion` (section 6.3) — a staged evidence object and its provenance.
 *
 * Populated in Phase E, when something actually fetches. The record and its reconciliation
 * exist now because the *ordering* around it is what Phase C is for, and because two of its
 * fields encode rules that are easy to lose later:
 *
 * - **`storage.verifiedAt` is not nullable on a committed record.** A reference is only
 *   committed after the checksum has been verified against the bytes as stored (FI-03).
 *   Section 6.3: *never return a successful evidence reference to a missing object.*
 * - **`indexState` starts at `PENDING`, in the committing transaction.** MongoDB is the
 *   system of record and the search index is derived; a document that committed but never
 *   reached the index must be findable and re-indexable (FI-10). Its symptom is a clean
 *   screening result, which is why it is a state on the record rather than a log line.
 *
 * The four date fields are separate and each carries its own precision, per FR-07. A missing
 * date stays null. **It is never backfilled with the retrieval time** — that would turn "we do
 * not know when this happened" into "this happened on the day we found it", which changes how
 * a reviewer reads the event.
 */

import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { ClientSession, Collection, Db } from 'mongodb';

export const DATE_PRECISIONS = ['DAY', 'MONTH', 'YEAR', 'UNKNOWN'] as const;
export type DatePrecision = (typeof DATE_PRECISIONS)[number];

export interface PrecisedDate {
  /** ISO-8601. The precision says how much of it is meant. */
  readonly value: string;
  readonly precision: DatePrecision;
  /** IANA zone, where the source made it knowable. Null is "not stated", not "UTC". */
  readonly timezone: string | null;
}

export const INDEX_STATES = ['PENDING', 'INDEXED', 'FAILED'] as const;
export type IndexState = (typeof INDEX_STATES)[number];

export interface StorageReference {
  readonly bucket: string;
  /**
   * Generated server-side from tenant and region context plus an opaque ID (SEC-03). Never a
   * raw publisher name, a URL path or anything a caller supplied.
   */
  readonly key: string;
  readonly byteSize: number;
  readonly contentType: string;
  readonly checksumAlgorithm: 'SHA256';
  readonly checksumValue: string;
  /** When the stored bytes were verified against the checksum. See the note above. */
  readonly verifiedAt: Date;
}

export interface SourceDocumentVersionRecord {
  readonly tenantId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly version: number;

  readonly sourceId: string;
  readonly publisher: string;
  readonly sourceUrl: string;
  readonly canonicalUrl: string;
  readonly sourceTier: string;

  readonly retrievedAt: PrecisedDate;
  readonly publicationDate: PrecisedDate | null;
  readonly eventDate: PrecisedDate | null;
  readonly updateDate: PrecisedDate | null;

  readonly language: string | null;
  readonly originalScript: string | null;

  readonly contentHash: string;
  readonly storage: StorageReference;

  readonly indexState: IndexState;
  readonly indexedAt: Date | null;
  readonly indexAttempt: number;
  readonly indexError: string | null;

  /** D-012: 30 days by default, configurable. Legal hold overrides at the point of deletion. */
  readonly retentionExpiresAt: Date | null;
  readonly legalHold: boolean;

  readonly createdAt: Date;
  readonly supersededAt: Date | null;
}

export interface CommitDocumentInput {
  readonly tenantId: string;
  readonly documentId?: string | undefined;
  readonly sourceId: string;
  readonly publisher: string;
  readonly sourceUrl: string;
  readonly canonicalUrl: string;
  readonly sourceTier: string;
  readonly retrievedAt: PrecisedDate;
  readonly publicationDate?: PrecisedDate | null;
  readonly eventDate?: PrecisedDate | null;
  readonly updateDate?: PrecisedDate | null;
  readonly language?: string | null;
  readonly originalScript?: string | null;
  readonly contentHash: string;
  readonly storage: StorageReference;
  readonly retentionExpiresAt: Date | null;
  readonly now: Date;
}

@Injectable()
export class SourceDocumentService {
  private readonly documents: Collection<SourceDocumentVersionRecord>;

  constructor(db: Db) {
    this.documents = db.collection<SourceDocumentVersionRecord>('sourceDocumentVersions');
  }

  async ensureIndexes(): Promise<void> {
    await this.documents.createIndex({ tenantId: 1, documentId: 1, version: -1 }, { unique: true });
    await this.documents.createIndex({ tenantId: 1, documentVersionId: 1 }, { unique: true });
    // Near-duplicate detection within a tenant. Not unique: the same article retrieved twice
    // is two retrievals of one document, and that is a version, not a collision.
    await this.documents.createIndex({ tenantId: 1, contentHash: 1 });
    await this.documents.createIndex({ tenantId: 1, canonicalUrl: 1 });
    // The FI-10 reconciler's index, cross-tenant by design (see `docs/architecture.md`).
    await this.documents.createIndex({ indexState: 1, createdAt: 1 });
    // The retention sweeper's index. `legalHold` leads nothing: it is checked at the delete.
    await this.documents.createIndex({ retentionExpiresAt: 1, legalHold: 1 });
  }

  /**
   * Commit a document reference.
   *
   * Rejects an unverified storage reference outright rather than trusting the caller to have
   * checked. This is the single most load-bearing refusal in the persistence layer: the thing
   * it prevents is a screening product telling a reviewer that evidence exists when it does
   * not.
   */
  async commit(
    input: CommitDocumentInput,
    session?: ClientSession,
  ): Promise<SourceDocumentVersionRecord> {
    if (!(input.storage.verifiedAt instanceof Date)) {
      throw new Error(
        'Refusing to commit a document reference whose stored object was never verified. ' +
          'Stage the upload, verify the checksum, then commit (section 6.3, FI-03).',
      );
    }

    const documentId = input.documentId ?? randomUUID();
    const previous =
      input.documentId === undefined
        ? null
        : await this.documents.findOne(
            { tenantId: input.tenantId, documentId },
            { sort: { version: -1 }, ...withSession(session) },
          );

    const record: SourceDocumentVersionRecord = {
      tenantId: input.tenantId,
      documentId,
      documentVersionId: randomUUID(),
      version: (previous?.version ?? 0) + 1,
      sourceId: input.sourceId,
      publisher: input.publisher,
      sourceUrl: input.sourceUrl,
      canonicalUrl: input.canonicalUrl,
      sourceTier: input.sourceTier,
      retrievedAt: input.retrievedAt,
      // Null stays null. FR-07: a missing date is never backfilled with the retrieval time.
      publicationDate: input.publicationDate ?? null,
      eventDate: input.eventDate ?? null,
      updateDate: input.updateDate ?? null,
      language: input.language ?? null,
      originalScript: input.originalScript ?? null,
      contentHash: input.contentHash,
      storage: input.storage,
      indexState: 'PENDING',
      indexedAt: null,
      indexAttempt: 0,
      indexError: null,
      retentionExpiresAt: input.retentionExpiresAt,
      legalHold: false,
      createdAt: input.now,
      supersededAt: null,
    };

    await this.documents.insertOne(record, withSession(session));

    if (previous !== null) {
      await this.documents.updateOne(
        { tenantId: input.tenantId, documentVersionId: previous.documentVersionId },
        { $set: { supersededAt: input.now } },
        withSession(session),
      );
    }

    return record;
  }

  async markIndexed(input: {
    readonly tenantId: string;
    readonly documentVersionId: string;
    readonly now: Date;
  }): Promise<void> {
    await this.documents.updateOne(
      { tenantId: input.tenantId, documentVersionId: input.documentVersionId },
      { $set: { indexState: 'INDEXED', indexedAt: input.now, indexError: null } },
    );
  }

  async markIndexFailed(input: {
    readonly tenantId: string;
    readonly documentVersionId: string;
    readonly error: string;
  }): Promise<void> {
    await this.documents.updateOne(
      { tenantId: input.tenantId, documentVersionId: input.documentVersionId },
      { $set: { indexState: 'FAILED', indexError: input.error }, $inc: { indexAttempt: 1 } },
    );
  }

  /**
   * Committed documents the index has not got (FI-10).
   *
   * `FAILED` is included deliberately: a failed index write is not a resolved one, and leaving
   * it out would make the gate's "no unindexed committed documents" check pass by excluding
   * exactly the documents it is asking about.
   */
  async findUnindexed(input: {
    readonly olderThan: Date;
    readonly limit: number;
  }): Promise<SourceDocumentVersionRecord[]> {
    return this.documents
      .find({ indexState: { $in: ['PENDING', 'FAILED'] }, createdAt: { $lte: input.olderThan } })
      .sort({ createdAt: 1 })
      .limit(input.limit)
      .toArray();
  }

  /** The gate check. Zero, or the gate does not pass. */
  async countUnindexed(olderThan: Date): Promise<number> {
    return this.documents.countDocuments({
      indexState: { $in: ['PENDING', 'FAILED'] },
      createdAt: { $lte: olderThan },
    });
  }

  /** Every committed storage key for a tenant — the orphan sweep's other half (FI-03). */
  async committedStorageKeys(tenantId: string): Promise<Set<string>> {
    const records = await this.documents
      .find({ tenantId }, { projection: { storage: 1 } })
      .toArray();
    return new Set(records.map((r) => r.storage.key));
  }

  async findVersion(
    tenantId: string,
    documentVersionId: string,
  ): Promise<SourceDocumentVersionRecord | null> {
    return this.documents.findOne({ tenantId, documentVersionId });
  }

  async setLegalHold(input: {
    readonly tenantId: string;
    readonly documentId: string;
    readonly held: boolean;
  }): Promise<number> {
    const result = await this.documents.updateMany(
      { tenantId: input.tenantId, documentId: input.documentId },
      { $set: { legalHold: input.held } },
    );
    return result.modifiedCount;
  }
}

function withSession(session: ClientSession | undefined): { session?: ClientSession } {
  return session === undefined ? {} : { session };
}
