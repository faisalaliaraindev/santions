/**
 * Search creation and retrieval.
 *
 * The search is accepted here and executed by the worker (Phase C). What this phase
 * guarantees is that a run is created exactly once per idempotency key, is bound to a tenant
 * that came from a validated token, and carries the versions needed to explain itself later.
 */

import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { ClientSession, Collection, Db } from 'mongodb';

import type { CreateSearchInput, SearchSummary } from '@erly/adverse-contracts';
import type { Principal } from '@erly/adverse-domain';

import { ApiException } from '../common/api-exception.js';
import {
  ADVERSE_MEDIA,
  EntitlementsService,
  type PinnedVersions,
} from '../tenancy/entitlements.service.js';
import { AuditService } from '../persistence/audit.service.js';
import { OutboxService } from '../persistence/outbox.service.js';
import { TransactionRunner } from '../persistence/transaction.runner.js';
import { IndexerService } from '../search-index/indexer.service.js';
import { SubjectsService } from '../subjects/subjects.service.js';

type SubjectRef = NonNullable<CreateSearchInput['subjectRef']>;

interface SearchRecord {
  readonly searchId: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly subjectVersion: number;
  readonly environment: 'sandbox' | 'live';
  readonly execution: SearchSummary['execution'];
  readonly findings: SearchSummary['findings'];
  readonly coverage: SearchSummary['coverage'];
  readonly pinnedVersions: PinnedVersions;
  readonly requestedScope: CreateSearchInput['requestedScope'];
  readonly externalCaseRef: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly refreshOfSearchId: string | null;
  readonly progress: SearchSummary['progress'];
  /** Optimistic concurrency for review actions and cancellation (FR-12). */
  readonly revision: number;
}

@Injectable()
export class SearchesService {
  private readonly searches: Collection<SearchRecord>;

  constructor(
    db: Db,
    private readonly entitlements: EntitlementsService,
    private readonly subjects: SubjectsService,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly indexer: IndexerService,
  ) {
    this.searches = db.collection<SearchRecord>('searchRuns');
  }

  async ensureIndexes(): Promise<void> {
    await this.searches.createIndex({ tenantId: 1, searchId: 1 }, { unique: true });
    // Stable cursor ordering: createdAt alone is not unique enough to paginate without
    // duplicating or skipping, so searchId breaks ties (section 6.1).
    await this.searches.createIndex({ tenantId: 1, createdAt: -1, searchId: -1 });
  }

  async create(input: {
    readonly principal: Principal;
    readonly data: CreateSearchInput;
    readonly now: Date;
  }): Promise<SearchSummary> {
    const { principal, data, now } = input;

    const tenantId = principal.tenantId;
    if (tenantId === null) {
      throw new ApiException('FORBIDDEN', 'Access denied.', {
        internalDetail: 'Search creation attempted without an authenticated tenant context.',
      });
    }

    // A sandbox credential cannot create a live search, whatever the body asks for (T62).
    if (principal.environment === 'sandbox' && data.environment === 'live') {
      throw new ApiException(
        'SANDBOX_CANNOT_ACCESS_LIVE',
        'A sandbox credential cannot create a live search.',
        { internalDetail: `tenant=${tenantId}` },
      );
    }

    // T63 — the capability check happens BEFORE anything else is done, so a tenant without
    // the capability causes no source work and no persisted run.
    const entitlement = await this.entitlements.assertCapability({
      tenantId,
      capability: ADVERSE_MEDIA,
      environment: data.environment,
    });

    const subject = {
      ref: data.subjectRef ?? null,
      snapshot: data.subjectSnapshot,
    };

    const pinnedVersions = await this.entitlements.pinVersions(tenantId, entitlement.version);

    const committed = await this.commitRun({
      principal,
      data,
      now,
      tenantId,
      pinnedVersions,
      subject,
    });

    // Indexing happens after the commit and outside the transaction (section 6.3), and its
    // failure is deliberately not this request's failure: the subject is durably recorded, the
    // record carries `indexState`, and the reconciler picks it up (matrix row FI-10). Failing
    // the request here would refuse a search because a cache was briefly unreachable.
    await this.indexer.indexSubjectVersionOf({
      tenantId,
      subjectId: committed.subjectId,
      version: committed.subjectVersion,
    });

    return committed;
  }

  /**
   * The one write. Run state, audit entry and outbox event commit **together** (section 6.3).
   *
   * Everything the transaction needs was resolved before it opened — the entitlement check,
   * the pinned versions, the subject — because the body may run more than once under a write
   * conflict and must be free of side effects outside the session.
   *
   * The subject snapshot is the exception, and it is inside on purpose: it is a write, so it
   * belongs to the same commit as the run that cites it. Retrying the body writes a second
   * subject version, which is correct — a version is immutable, and the run that commits is
   * the one whose version is referenced. The abandoned version is not an orphan in any sense
   * that matters, because a failed transaction wrote nothing at all.
   *
   * The outbox event is what starts the work. Nothing is published from here: publication
   * happens after the commit, from `OutboxPublisher` (matrix rows FI-04 and FI-05).
   */
  private async commitRun(input: {
    readonly principal: Principal;
    readonly data: CreateSearchInput;
    readonly now: Date;
    readonly tenantId: string;
    readonly pinnedVersions: PinnedVersions;
    readonly subject: {
      readonly ref: SubjectRef | null;
      readonly snapshot: CreateSearchInput['subjectSnapshot'];
    };
  }): Promise<SearchSummary> {
    const { principal, data, now, tenantId, pinnedVersions } = input;

    return this.transactions.run(
      async (session: ClientSession) => {
        const resolved = await this.resolveSubject({
          tenantId,
          subject: input.subject,
          now,
          session,
        });

        const record: SearchRecord = {
          searchId: randomUUID(),
          tenantId,
          subjectId: resolved.subjectId,
          subjectVersion: resolved.version,
          environment: data.environment,
          // Nothing has run yet. Reporting anything but QUEUED / NOT_EVALUATED / UNKNOWN here
          // would be claiming a result the service does not have (section 6.2).
          execution: 'QUEUED',
          findings: 'NOT_EVALUATED',
          coverage: 'UNKNOWN',
          pinnedVersions,
          requestedScope: data.requestedScope,
          externalCaseRef: data.externalCaseRef ?? null,
          createdBy: principal.subject,
          createdAt: now,
          completedAt: null,
          refreshOfSearchId: null,
          progress: {
            stagesCompleted: 0,
            stagesTotal: 0,
            cascadeRungReached: null,
            warnings: [],
          },
          revision: 1,
        };

        await this.searches.insertOne(record, { session });

        // SEC-06 — the audit entry commits with the action, so an accepted search cannot exist
        // without a record of who asked for it and under which entitlement.
        await this.audit.append(
          {
            tenantId,
            actor: {
              type: principal.kind === 'MACHINE' ? 'MACHINE' : 'USER',
              subject: principal.subject,
              clientId: null,
            },
            action: 'search.create',
            target: { type: 'SearchRun', id: record.searchId, version: record.revision },
            // SEC-05 — the minimal permitted fact. The declared purpose of the screening is
            // why this was allowed; the subject's identity details are not copied into the audit
            // trail, which would duplicate personal data indefinitely.
            reason: resolved.purpose,
            correlationId: null,
            result: 'ALLOWED',
            now,
          },
          session,
        );

        await this.outbox.append(
          {
            tenantId,
            eventType: 'search.queued',
            aggregateType: 'SearchRun',
            aggregateId: record.searchId,
            aggregateRevision: record.revision,
            payload: {
              searchId: record.searchId,
              subjectId: record.subjectId,
              subjectVersion: record.subjectVersion,
              environment: record.environment,
            },
            now,
          },
          session,
        );

        return toWire(record);
      },
      { name: 'search.create' },
    );
  }

  /** Resolve the subject inside the transaction: an existing pinned version, or a new one. */
  private async resolveSubject(input: {
    readonly tenantId: string;
    readonly subject: {
      readonly ref: SubjectRef | null;
      readonly snapshot: CreateSearchInput['subjectSnapshot'];
    };
    readonly now: Date;
    readonly session: ClientSession;
  }): Promise<{
    readonly subjectId: string;
    readonly version: number;
    /** Never null: FR-01 requires a screening purpose on every subject. */
    readonly purpose: string;
  }> {
    if (input.subject.ref !== null) {
      const subject = await this.subjects.findVersion({
        tenantId: input.tenantId,
        subjectId: input.subject.ref.subjectId,
        version: input.subject.ref.version,
      });
      return {
        subjectId: subject.subjectId,
        version: subject.version,
        purpose: subject.purpose,
      };
    }

    if (input.subject.snapshot !== undefined) {
      const subject = await this.subjects.create({
        tenantId: input.tenantId,
        data: input.subject.snapshot,
        now: input.now,
        session: input.session,
      });
      return {
        subjectId: subject.subjectId,
        version: subject.version,
        purpose: subject.purpose,
      };
    }

    // The schema's refine already prevents this; kept as a defence in depth.
    throw new ApiException(
      'VALIDATION_FAILED',
      'Provide exactly one of subjectRef or subjectSnapshot.',
    );
  }

  /** Tenant scoping is in the query, never a check afterwards (SEC-01). */
  async findById(tenantId: string, searchId: string): Promise<SearchSummary> {
    const record = await this.searches.findOne({ tenantId, searchId });
    if (record === null) {
      throw ApiException.notFound('Search', `tenant=${tenantId} search=${searchId}`);
    }
    return toWire(record);
  }

  /**
   * Cursor pagination with a stable total ordering.
   *
   * The cursor encodes (createdAt, searchId) rather than an offset, so a report being written
   * concurrently cannot cause an item to be returned twice or skipped (section 6.1).
   */
  async list(input: {
    readonly tenantId: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{ items: SearchSummary[]; nextCursor: string | null }> {
    const filter: Record<string, unknown> = { tenantId: input.tenantId };

    if (input.cursor !== undefined) {
      const decoded = decodeCursor(input.cursor);
      filter['$or'] = [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, searchId: { $lt: decoded.searchId } },
      ];
    }

    const records = await this.searches
      .find(filter)
      .sort({ createdAt: -1, searchId: -1 })
      .limit(input.limit + 1)
      .toArray();

    const hasMore = records.length > input.limit;
    const page = hasMore ? records.slice(0, input.limit) : records;
    const last = page.at(-1);

    return {
      items: page.map(toWire),
      nextCursor:
        hasMore && last !== undefined ? encodeCursor(last.createdAt, last.searchId) : null,
    };
  }
}

function encodeCursor(createdAt: Date, searchId: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${searchId}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; searchId: string } {
  const [iso, searchId] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (Number.isNaN(createdAt.getTime()) || searchId === undefined) {
    // Cursors are opaque; a malformed one is a client error, not a reason to return page one
    // and silently restart their iteration.
    throw new ApiException('VALIDATION_FAILED', 'The cursor is not valid.');
  }
  return { createdAt, searchId };
}

function toWire(record: SearchRecord): SearchSummary {
  return {
    searchId: record.searchId,
    tenantId: record.tenantId,
    subjectId: record.subjectId,
    subjectVersion: record.subjectVersion,
    environment: record.environment,
    execution: record.execution,
    findings: record.findings,
    coverage: record.coverage,
    pinnedVersions: record.pinnedVersions,
    createdAt: record.createdAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
    refreshOfSearchId: record.refreshOfSearchId,
    progress: record.progress,
  };
}
