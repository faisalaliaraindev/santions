/**
 * Projects committed records into the search index, and reconciles what did not get there.
 *
 * This is the FI-10 reconciler, and FI-10 is the most dangerous row in the failure matrix
 * because its symptom is a **clean screening result**. An unindexed document does not look like
 * an error; it looks like nothing to report. So the state lives on the record, the sweep is a
 * query, and the gate check counts rather than assumes.
 *
 * Three rules hold everything together:
 *
 * 1. **Indexing happens after the commit, never inside the transaction** (§6.3). A search index
 *    cannot join a MongoDB transaction, and pretending otherwise would make a commit depend on
 *    a cache being reachable.
 * 2. **A write is only `INDEXED` once the index confirms it is searchable.** The adapter waits
 *    for the index's own task to succeed. Marking on enqueue would record a document as indexed
 *    while the matcher still cannot see it.
 * 3. **MongoDB wins.** Reconciliation reads the record and re-projects it. It never reads the
 *    index to repair MongoDB.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import {
  SourceDocumentService,
  type SourceDocumentVersionRecord,
} from '../persistence/source-document.service.js';
import type {
  DocumentIndexDocument,
  SearchIndexPort,
  SubjectIndexDocument,
} from './search-index.port.js';

/**
 * The persisted subject shape this service reads.
 *
 * Declared locally rather than imported from the contract, because what is indexed is the
 * *stored* record — including `indexState`, which is not part of any wire contract and must
 * never become one.
 */
interface SubjectVersionRow {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly subjectVersionId: string;
  readonly version: number;
  readonly fullName: string;
  readonly normalised: {
    readonly folded: string;
    readonly sortedCoreKey: string;
    readonly phoneticKeys: readonly string[];
    readonly scripts: readonly string[];
  };
  readonly aliases: readonly { readonly value: string }[];
  readonly countryContext: readonly string[];
  readonly indexState?: 'PENDING' | 'INDEXED' | 'FAILED';
  readonly createdAt: Date;
}

export interface ReconcileSummary {
  readonly subjectsReindexed: number;
  readonly documentsReindexed: number;
  readonly stillFailing: number;
}

/** How long after commit a record may be unindexed before the reconciler takes an interest. */
export const REINDEX_GRACE_MS = 5 * 60 * 1000;
const BATCH = 100;

@Injectable()
export class IndexerService {
  private readonly logger = new Logger('Indexer');
  private readonly subjects: Collection<SubjectVersionRow>;

  constructor(
    db: Db,
    private readonly index: SearchIndexPort,
    private readonly documents: SourceDocumentService,
  ) {
    this.subjects = db.collection<SubjectVersionRow>('subjectVersions');
  }

  async ensureIndexes(): Promise<void> {
    // The reconciler's index. `indexState` is an additive field: subject versions written
    // before C3 do not carry it at all, which is why every sweep below matches
    // `{ $ne: 'INDEXED' }` rather than listing PENDING and FAILED. A query that listed the two
    // states would silently skip every legacy record — the exact failure the additive-only
    // migration decision has to be careful about (see `docs/architecture.md`, "Migrations").
    await this.subjects.createIndex({ indexState: 1, createdAt: 1 });
  }

  // ---- projection -------------------------------------------------------------------------

  /**
   * What the matcher searches.
   *
   * The derived forms, not the raw name (FR-08). The original is carried for display and is
   * never the field matched on, because matching on it would make "José" and "Jose" different
   * people.
   */
  static projectSubject(row: SubjectVersionRow): SubjectIndexDocument {
    return {
      subjectVersionId: row.subjectVersionId,
      subjectId: row.subjectId,
      version: row.version,
      tenantId: row.tenantId,
      nameOriginal: row.fullName,
      nameFolded: row.normalised.folded,
      sortedCoreKey: row.normalised.sortedCoreKey,
      phoneticKeys: row.normalised.phoneticKeys,
      aliasesFolded: row.aliases.map((a) => a.value.toLowerCase()),
      countryContext: row.countryContext,
      scripts: row.normalised.scripts,
    };
  }

  static projectDocument(
    row: SourceDocumentVersionRecord,
    text: string,
    title: string,
  ): DocumentIndexDocument {
    return {
      documentVersionId: row.documentVersionId,
      documentId: row.documentId,
      tenantId: row.tenantId,
      title,
      text,
      publisher: row.publisher,
      sourceId: row.sourceId,
      language: row.language,
      tier: row.sourceTier,
      // A missing publication date stays missing. FR-07: never backfilled with the retrieval
      // time, and a date filter must exclude it rather than pretend it is recent.
      publicationDate:
        row.publicationDate === null ? null : Date.parse(row.publicationDate.value) || null,
    };
  }

  // ---- writing ----------------------------------------------------------------------------

  /**
   * Index a subject version that has just been committed.
   *
   * Never throws. A failure here must not fail the request that created the subject — the
   * record is durable and the reconciler will pick it up — but it must be *recorded*, because
   * an unindexed subject that nobody is tracking is an invisible one.
   */
  async indexSubject(subjectVersionId: string, tenantId: string): Promise<boolean> {
    const row = await this.subjects.findOne({ tenantId, subjectVersionId });
    if (row === null) {
      return false;
    }

    const outcome = await this.index.upsertSubjects([IndexerService.projectSubject(row)]);
    const ok = outcome.indexed.includes(subjectVersionId);

    await this.subjects.updateOne(
      { tenantId, subjectVersionId },
      { $set: { indexState: ok ? 'INDEXED' : 'FAILED' } },
    );

    if (!ok) {
      this.logger.warn(
        `Subject version ${subjectVersionId} is committed but not indexed: ` +
          `${outcome.failed[0]?.reason ?? 'unknown'}. The reconciler will retry it.`,
      );
    }
    return ok;
  }

  /**
   * Index the subject version a search just pinned.
   *
   * Addressed by `(subjectId, version)` because that is what a run stores — a caller holding a
   * `SearchSummary` has no `subjectVersionId`, and making it look one up would put a second
   * query in every caller rather than one here.
   */
  async indexSubjectVersionOf(input: {
    readonly tenantId: string;
    readonly subjectId: string;
    readonly version: number;
  }): Promise<boolean> {
    const row = await this.subjects.findOne({
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      version: input.version,
    });
    if (row === null) {
      return false;
    }
    return this.indexSubject(row.subjectVersionId, input.tenantId);
  }

  /** As above, for a source document. The text is supplied by the caller that extracted it. */
  async indexDocument(input: {
    readonly tenantId: string;
    readonly documentVersionId: string;
    readonly title: string;
    readonly text: string;
  }): Promise<boolean> {
    const row = await this.documents.findVersion(input.tenantId, input.documentVersionId);
    if (row === null) {
      return false;
    }

    const outcome = await this.index.upsertDocuments([
      IndexerService.projectDocument(row, input.text, input.title),
    ]);

    if (outcome.indexed.includes(input.documentVersionId)) {
      await this.documents.markIndexed({
        tenantId: input.tenantId,
        documentVersionId: input.documentVersionId,
        now: new Date(),
      });
      return true;
    }

    await this.documents.markIndexFailed({
      tenantId: input.tenantId,
      documentVersionId: input.documentVersionId,
      error: outcome.failed[0]?.reason ?? 'unknown',
    });
    return false;
  }

  // ---- reconciliation ---------------------------------------------------------------------

  /**
   * Find committed records the index does not have, and put them there.
   *
   * Cross-tenant by design: this is a platform obligation, and a per-tenant sweep is how one
   * tenant's unindexed evidence goes unnoticed.
   *
   * `text` and `title` are not recoverable for a document whose extracted text lives elsewhere,
   * so document reconciliation re-projects with whatever the record itself carries. In this
   * phase that is empty — nothing extracts yet — and Phase F, which produces the text, owns
   * supplying it. Recorded here rather than silently indexing an empty document as if it were
   * complete: `documentsReindexed` counts what was re-sent, and a document with no text is
   * still findable by publisher and source, which is what the record can honestly support.
   */
  async reconcile(now: Date): Promise<ReconcileSummary> {
    const olderThan = new Date(now.getTime() - REINDEX_GRACE_MS);

    let subjectsReindexed = 0;
    let stillFailing = 0;

    const staleSubjects = await this.subjects
      .find({ indexState: { $ne: 'INDEXED' }, createdAt: { $lte: olderThan } })
      .sort({ createdAt: 1 })
      .limit(BATCH)
      .toArray();

    if (staleSubjects.length > 0) {
      const outcome = await this.index.upsertSubjects(
        staleSubjects.map((row) => IndexerService.projectSubject(row)),
      );
      for (const row of staleSubjects) {
        const ok = outcome.indexed.includes(row.subjectVersionId);
        await this.subjects.updateOne(
          { tenantId: row.tenantId, subjectVersionId: row.subjectVersionId },
          { $set: { indexState: ok ? 'INDEXED' : 'FAILED' } },
        );
        if (ok) {
          subjectsReindexed += 1;
        } else {
          stillFailing += 1;
        }
      }
    }

    const staleDocuments = await this.documents.findUnindexed({ olderThan, limit: BATCH });
    let documentsReindexed = 0;

    if (staleDocuments.length > 0) {
      const outcome = await this.index.upsertDocuments(
        staleDocuments.map((row) => IndexerService.projectDocument(row, '', row.publisher)),
      );
      for (const row of staleDocuments) {
        if (outcome.indexed.includes(row.documentVersionId)) {
          await this.documents.markIndexed({
            tenantId: row.tenantId,
            documentVersionId: row.documentVersionId,
            now,
          });
          documentsReindexed += 1;
        } else {
          await this.documents.markIndexFailed({
            tenantId: row.tenantId,
            documentVersionId: row.documentVersionId,
            error: outcome.failed[0]?.reason ?? 'unknown',
          });
          stillFailing += 1;
        }
      }
    }

    if (subjectsReindexed + documentsReindexed > 0) {
      this.logger.log(
        `Reconciled ${String(subjectsReindexed)} subject(s) and ` +
          `${String(documentsReindexed)} document(s) into the index.`,
      );
    }

    return { subjectsReindexed, documentsReindexed, stillFailing };
  }

  /**
   * The gate's exit condition, as a query rather than an assumption.
   *
   * G4 requires "no unindexed committed documents". This returns the number; zero is the only
   * passing answer, and the count is taken over records committed longer ago than the grace
   * window so that a document indexed a moment from now is not counted as a failure.
   */
  async countUnindexed(now: Date): Promise<{ subjects: number; documents: number }> {
    const olderThan = new Date(now.getTime() - REINDEX_GRACE_MS);
    return {
      subjects: await this.subjects.countDocuments({
        indexState: { $ne: 'INDEXED' },
        createdAt: { $lte: olderThan },
      }),
      documents: await this.documents.countUnindexed(olderThan),
    };
  }

  /**
   * Rebuild a tenant's indexes from MongoDB.
   *
   * The operational expression of "MongoDB is the system of record": if the index is wrong, in
   * any way, throwing it away and re-deriving it is always a correct repair. Purge first, so a
   * rebuild also removes entries whose record no longer exists.
   */
  async rebuildTenant(tenantId: string): Promise<number> {
    await this.index.purgeTenant(tenantId);

    let rebuilt = 0;
    const cursor = this.subjects.find({ tenantId }).sort({ createdAt: 1 });
    let batch: SubjectVersionRow[] = [];

    for await (const row of cursor) {
      batch.push(row);
      if (batch.length >= BATCH) {
        rebuilt += await this.flushSubjects(batch);
        batch = [];
      }
    }
    if (batch.length > 0) {
      rebuilt += await this.flushSubjects(batch);
    }

    this.logger.log(`Rebuilt ${String(rebuilt)} subject(s) for one tenant from MongoDB.`);
    return rebuilt;
  }

  private async flushSubjects(rows: readonly SubjectVersionRow[]): Promise<number> {
    const outcome = await this.index.upsertSubjects(
      rows.map((row) => IndexerService.projectSubject(row)),
    );
    for (const row of rows) {
      const ok = outcome.indexed.includes(row.subjectVersionId);
      await this.subjects.updateOne(
        { tenantId: row.tenantId, subjectVersionId: row.subjectVersionId },
        { $set: { indexState: ok ? 'INDEXED' : 'FAILED' } },
      );
    }
    return outcome.indexed.length;
  }
}
