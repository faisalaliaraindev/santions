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

import type { CancelSearchInput, CreateSearchInput, SearchSummary } from '@erly/adverse-contracts';
import {
  aggregateRun,
  type AssociationScope,
  type Principal,
  type SourceCoverageOutcome,
} from '@erly/adverse-domain';

import { AssociationGraphService } from '../associations/association-graph.service.js';
import { ApiException } from '../common/api-exception.js';
import {
  ADVERSE_MEDIA,
  EntitlementsService,
  type PinnedVersions,
} from '../tenancy/entitlements.service.js';
import { AuditService } from '../persistence/audit.service.js';
import { OutboxService } from '../persistence/outbox.service.js';
import { StageExecutionService } from '../persistence/stage-execution.service.js';
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
  /**
   * What each source contributed to coverage (D4). Keyed by source: re-recording replaces,
   * so a redelivered message cannot make one outage look like three.
   */
  readonly sourceOutcomes?: readonly SourceCoverageOutcome[];
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
    private readonly stages: StageExecutionService,
    private readonly associations: AssociationGraphService,
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

    // FR-02: a former-director search needs an approved historical scope, and the approval
    // lives on the tenant's policy version. Checked here, before anything is written, so an
    // unapproved request is refused rather than silently narrowed to current-only and returned
    // as though it had answered the question asked.
    const associationScope = await this.associations.resolveScope({
      tenantId,
      includeFormerDirectorships: data.requestedScope.includeFormerDirectorships,
    });

    const committed = await this.commitRun({
      principal,
      data,
      now,
      tenantId,
      pinnedVersions,
      associationScope,
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
    readonly associationScope: AssociationScope;
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

        // FR-02 — the association snapshot is created here, empty, and pinned to the run from
        // its first moment (Phase D step D3). In the same transaction for the same reason the
        // audit entry is: a crash between the two would leave a run pointing at a snapshot
        // that does not exist.
        //
        // It is **not** populated here. Building it means calling a company register, and
        // FR-02 is explicit that a registry failure must not stop person searching — so
        // registry latency stays out of search acceptance and the worker fills it in.
        await this.associations.createPendingSnapshot({
          tenantId,
          searchId: record.searchId,
          subjectId: record.subjectId,
          subjectVersion: record.subjectVersion,
          jurisdictions: data.requestedScope.jurisdictions,
          scope: input.associationScope,
          // The same version the run pins. The graph's bounds are resolved from exactly this
          // one, so a bound raised later cannot change what this search is reported to cover.
          policyVersion: pinnedVersions.policyVersion,
          now,
          session,
        });

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

  /**
   * FR-12 — cancel a run in flight, against the revision the caller last read.
   *
   * Three things happen in one transaction, and the order inside it does not matter because
   * a transaction has no partial outcome — but the **fence** does, and it is the first
   * statement for a reason: every later write in the body is conditional on this one having
   * matched, so a stale caller never causes a stage cancellation, an audit entry or an event.
   *
   * What a cancellation is **not** allowed to do (matrix row FI-12, T30):
   *
   * - re-open or rewrite a stage that already succeeded. A stage that genuinely completed
   *   before the cancellation arrived genuinely completed, and rewriting it would make the
   *   historical run say something untrue about what was searched;
   * - be undone by a worker that finishes afterwards. The revision bump here is what makes
   *   that worker's fenced write fail. It is discarded and counted, never applied.
   *
   * Cancelling an already-terminal run is a **409**, not a quiet success. A caller that asked
   * to stop something which had already finished needs to know it had already finished —
   * "nothing to do" and "done" lead to different next actions.
   */
  async cancel(input: {
    readonly principal: Principal;
    readonly searchId: string;
    readonly expectedRevision: number;
    readonly data: CancelSearchInput;
    readonly now: Date;
  }): Promise<SearchSummary> {
    const { principal, searchId, expectedRevision, now } = input;

    const tenantId = principal.tenantId;
    if (tenantId === null) {
      throw new ApiException('FORBIDDEN', 'Access denied.', {
        internalDetail: 'Cancellation attempted without an authenticated tenant context.',
      });
    }

    return this.transactions.run(
      async (session: ClientSession) => {
        const cancelled = await this.searches.findOneAndUpdate(
          {
            tenantId,
            searchId,
            revision: expectedRevision,
            execution: { $in: ['QUEUED', 'RUNNING'] },
          },
          {
            $set: {
              execution: 'CANCELLED' as const,
              completedAt: now,
            },
            $inc: { revision: 1 },
          },
          { returnDocument: 'after', session },
        );

        if (cancelled === null) {
          // The fence refused. Why it refused decides what the caller is told, and the three
          // answers are genuinely different: gone, already finished, or acted on stale state.
          await this.explainCancelRefusal({ tenantId, searchId, expectedRevision, session });
        }

        // `explainCancelRefusal` always throws; this is for the type checker, and a bug that
        // made it return would be caught here rather than by a null dereference below.
        /* c8 ignore next 3 */
        if (cancelled === null) {
          throw new ApiException('INTERNAL', 'Cancellation could not be explained.');
        }

        // Stages that are still live stop. Terminal ones are untouched — see the note above.
        const stagesCancelled = await this.stages.cancelRun({
          tenantId,
          runId: searchId,
          now,
          session,
        });

        await this.audit.append(
          {
            tenantId,
            actor: {
              type: principal.kind === 'MACHINE' ? 'MACHINE' : 'USER',
              subject: principal.subject,
              clientId: null,
            },
            action: 'search.cancel',
            target: { type: 'SearchRun', id: searchId, version: cancelled.revision },
            // SEC-05 — the caller's stated reason, which is the whole point of recording this.
            reason: input.data.reason,
            correlationId: null,
            result: 'ALLOWED',
            now,
          },
          session,
        );

        await this.outbox.append(
          {
            tenantId,
            eventType: 'search.cancelled',
            aggregateType: 'SearchRun',
            aggregateId: searchId,
            aggregateRevision: cancelled.revision,
            payload: { searchId, stagesCancelled },
            now,
          },
          session,
        );

        return toWire(cancelled);
      },
      { name: 'search.cancel' },
    );
  }

  /**
   * Say precisely why a cancellation was refused. Always throws.
   *
   * Reads inside the same session as the failed update, so the explanation describes the state
   * the fence actually saw rather than one that moved again in between — an explanation that
   * names a revision which was never current is worse than none, because the caller quotes it
   * back and fails again.
   */
  private async explainCancelRefusal(input: {
    readonly tenantId: string;
    readonly searchId: string;
    readonly expectedRevision: number;
    readonly session: ClientSession;
  }): Promise<never> {
    const current = await this.searches.findOne(
      { tenantId: input.tenantId, searchId: input.searchId },
      { session: input.session },
    );

    if (current === null) {
      throw ApiException.notFound(
        'Search',
        `tenant=${input.tenantId} search=${input.searchId} (cancel)`,
      );
    }

    if (current.revision !== input.expectedRevision) {
      throw ApiException.revisionConflict({
        expectedRevision: input.expectedRevision,
        currentRevision: current.revision,
        currentState: current.execution,
        internalDetail: `search=${input.searchId} cancel on stale revision`,
      });
    }

    // The revision matched, so the only remaining reason is that the run is already terminal.
    throw new ApiException(
      'ALREADY_TERMINAL',
      `This search is already ${current.execution.toLowerCase()} and cannot be cancelled.`,
      { internalDetail: `search=${input.searchId} execution=${current.execution}` },
    );
  }

  /**
   * The SEC-01 ownership loader for the queue consumer.
   *
   * Takes the search ID **only**. Adding a tenant filter here would be the bug the ownership
   * check exists to catch: a forged tenant would simply find nothing and be reported as a
   * harmless replay, instead of as the attempted crossing it is. See `jobs/job-ownership.ts`.
   */
  async loadOwnership(searchId: string): Promise<{ tenantId: string; revision: number } | null> {
    const record = await this.searches.findOne(
      { searchId },
      { projection: { tenantId: 1, revision: 1, _id: 0 } },
    );
    return record === null ? null : { tenantId: record.tenantId, revision: record.revision };
  }

  /**
   * Record what the association graph contributed to this run's coverage (Phase D step D4).
   *
   * FR-02's degraded-execution rule lives here: a registry outage does not fail the search. It
   * records a `FAILED` source outcome, the run's **coverage** becomes `INCOMPLETE`, and the run
   * itself carries on — there is no path in this method that marks a run failed or deletes it.
   *
   * **Only the coverage dimension is written, deliberately.** `aggregateRun` also returns
   * `execution` and `findings`, and applying those here would be wrong: they are statements
   * about the whole run, and the only work that has happened at this point is the graph. With a
   * single failed source outcome `aggregateRun` correctly concludes `FAILED` — correct for a run
   * in which nothing else ran, and quite wrong for a real run whose person search is still to
   * come. Whoever finishes the run owns those two (Phase E); coverage is knowable now, because
   * it is a statement about *what was searched*, and this source's contribution is settled.
   *
   * The outcome is stored on the run as well as on the snapshot, keyed by source, so re-running
   * this replaces rather than appends. A redelivered message must not make one outage look like
   * three.
   */
  async recordAssociationCoverage(input: {
    readonly tenantId: string;
    readonly searchId: string;
  }): Promise<SearchSummary> {
    const graph = await this.associations.loadForSearch({
      tenantId: input.tenantId,
      searchId: input.searchId,
    });

    const outcome = graph.coverage.sourceOutcome;
    if (outcome === null) {
      // Still PENDING. Nothing has been attempted, so there is nothing to report — and
      // writing a coverage figure now would describe work that has not happened.
      return this.findById(input.tenantId, input.searchId);
    }

    const current = await this.searches.findOne({
      tenantId: input.tenantId,
      searchId: input.searchId,
    });
    if (current === null) {
      throw ApiException.notFound('Search', `tenant=${input.tenantId} search=${input.searchId}`);
    }

    const sourceOutcomes = [
      ...(current.sourceOutcomes ?? []).filter((o) => o.sourceId !== outcome.sourceId),
      outcome,
    ];

    const aggregate = aggregateRun({
      cancelled: current.execution === 'CANCELLED',
      // Both zero until the evidence pipeline exists. Officer candidates are deliberately **not**
      // counted as unresolved leads: a namesake in a company register is not an adverse finding,
      // and counting one would make a run report `UNRESOLVED` findings because somebody shares
      // the subject's name.
      supportedFindingCount: 0,
      unresolvedLeadCount: 0,
      sourceOutcomes,
      anyWorkDispatched: true,
    });

    const updated = await this.searches.findOneAndUpdate(
      { tenantId: input.tenantId, searchId: input.searchId },
      { $set: { sourceOutcomes, coverage: aggregate.coverage } },
      { returnDocument: 'after' },
    );
    /* c8 ignore next 3 -- the document was read immediately above in the same request. */
    if (updated === null) {
      throw ApiException.notFound('Search', `tenant=${input.tenantId} search=${input.searchId}`);
    }
    return toWire(updated);
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
    revision: record.revision,
  };
}
