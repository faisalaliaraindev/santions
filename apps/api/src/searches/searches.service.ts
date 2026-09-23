/**
 * Search creation and retrieval.
 *
 * The search is accepted here and executed by the worker (Phase C). What this phase
 * guarantees is that a run is created exactly once per idempotency key, is bound to a tenant
 * that came from a validated token, and carries the versions needed to explain itself later.
 */

import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { ClientSession, Collection, Db } from 'mongodb';

import type {
  CancelSearchInput,
  CreateSearchInput,
  Finding,
  FindingsPage,
  LiveDiscoverySummary,
  SearxngDiscoverySummaryDto,
  SearchSummary,
} from '@erly/adverse-contracts';
import {
  aggregateRun,
  enabledCategories,
  renderNoMatchStatement,
  REVIEW_DISCLAIMER,
  unmeasuredLanguages,
  unreviewedLexiconNote,
  type AssociationScope,
  type Principal,
  assertNoMatchIsHonest,
  describeFindings,
  type EvidenceBand,
  type FindingCounts,
  type SourceCoverageOutcome,
} from '@erly/adverse-domain';

import { AssociationGraphService } from '../associations/association-graph.service.js';
import { SourceHealthService } from '../sources/source-health.service.js';
import { TaxonomyService } from '../admin/taxonomy.service.js';
import { FindingsService, type FindingRecord } from '../pipeline/findings.service.js';
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
  /**
   * The band counts behind `findings` (the state).
   *
   * Optional because a run completed before this existed has none stored. Nothing invents them
   * on write; `findingCountsFor` below recomputes them from the stored findings on read, which
   * is the one place that is safe to do — the findings are right there, and a count derived from
   * the evidence cannot contradict it.
   */
  readonly findingCounts?: FindingCounts;
  /**
   * What the live discovery connectors put on the wire (D-060).
   *
   * Optional and nullable, and the two mean different things. Absent is a run completed before
   * this was recorded at all; `null` is a run whose process held no request log. Neither is
   * rewritten into zero — a count nobody took is not a count of nothing.
   */
  readonly liveDiscovery?: LiveDiscoverySummary | null;
  /**
   * Per-engine diagnostics for the rung-5 metasearch layer (§15).
   *
   * Optional and nullable on the same rule as `liveDiscovery`, and the two states mean different
   * things: absent is a run completed before this was recorded at all, `null` is a run whose
   * process held no engine log. Neither is rewritten into an empty engine list — "nobody
   * measured" and "governance permitted no engine" are different facts.
   */
  readonly searxngDiscovery?: SearxngDiscoverySummaryDto | null;
  readonly progress: SearchSummary['progress'];
  /** Optimistic concurrency for review actions and cancellation (FR-12). */
  readonly revision: number;
  /**
   * **LOCAL DIAGNOSTIC ONLY.** Engines this one run may execute beyond the tenant's resolved
   * set, granted by `decideLocalDiagnostic` when the run was accepted. Absent on every normal run.
   *
   * A fact about this run, not a setting: nothing reads it except this run's worker, which
   * re-checks its own environment before honouring it (`local-diagnostic.ts`).
   */
  readonly localDiscoveryDiagnostic?: { readonly engines: readonly string[] } | undefined;
}

@Injectable()
export class SearchesService {
  private readonly logger = new Logger('Searches');
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
    private readonly findings: FindingsService,
    private readonly taxonomies: TaxonomyService,
    private readonly sourceHealth: SourceHealthService,
    private readonly mode: 'mock' | 'live',
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
    /** Granted local-diagnostic engines, or null/absent for every normal search. */
    readonly diagnosticEngines?: readonly string[] | null | undefined;
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
      diagnosticEngines: input.diagnosticEngines ?? null,
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
    readonly diagnosticEngines: readonly string[] | null;
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
          ...(input.diagnosticEngines === null || input.diagnosticEngines.length === 0
            ? {}
            : { localDiscoveryDiagnostic: { engines: [...input.diagnosticEngines] } }),
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

  /**
   * The findings page: what the run produced, and what it could not.
   *
   * The three dimensions are repeated on this response on purpose. A client that fetches
   * findings alone has no way to tell a genuinely clean run from one where every source was
   * blocked, and section 6.2 exists precisely because those two look identical if you only
   * count results.
   *
   * The FR-13 no-match statement is rendered whenever there are no findings — including when
   * the run is still queued, where it honestly says nothing has been searched yet rather than
   * implying an empty result.
   */
  async findingsFor(input: {
    readonly tenantId: string;
    readonly searchId: string;
  }): Promise<FindingsPage> {
    const run = await this.searches.findOne({
      tenantId: input.tenantId,
      searchId: input.searchId,
    });
    if (run === null) {
      throw ApiException.notFound('Search', `tenant=${input.tenantId} search=${input.searchId}`);
    }

    const [{ findings, rejectedLeads }, taxonomy] = await Promise.all([
      this.findings.listForSearch({ tenantId: input.tenantId, searchId: input.searchId }),
      this.taxonomies.loadPinned(input.tenantId, run.pinnedVersions.taxonomyVersion),
    ]);

    const sourceOutcomes = run.sourceOutcomes ?? [];
    const unmeasured = unmeasuredLanguages(taxonomy, run.requestedScope.languages);

    // T36's "or after result" half. A result produced under a source that has since been
    // suspended is not deleted and is not altered — but this read must say so, in both the
    // per-document note and the run-level list. See decision D-031.
    const suspensionNotes = await this.sourceHealth.suspensionNotesFor({
      sourceIds: [
        ...findings.map((finding) => finding.document.sourceId),
        ...sourceOutcomes.map((outcome) => outcome.sourceId),
      ],
      producedAt: run.createdAt,
      asOf: new Date(),
    });

    // Counted from the findings this response is about to return, not read from the run.
    //
    // The two can only disagree if something wrote a state the evidence does not support, and
    // when they disagree the findings are the evidence. This is the last place before the wire
    // where that can be caught, so it is caught here: `findingsStateFor` refuses to serve
    // `NO_MATCHES_FOUND` over a findings list that is not empty.
    const findingCounts = findingCountsFor(findings, rejectedLeads.length);
    const findingsState = this.findingsStateFor(run, findingCounts);

    const noMatchStatement =
      findingCounts.total > 0
        ? null
        : renderNoMatchStatement({
            sourceCount: sourceOutcomes.length,
            languages: run.requestedScope.languages,
            jurisdictions: run.requestedScope.jurisdictions,
            enabledCategories: run.requestedScope.jurisdictions.flatMap((jurisdiction) =>
              enabledCategories(taxonomy, jurisdiction),
            ),
            taxonomyVersion: run.pinnedVersions.taxonomyVersion,
            policyVersion: run.pinnedVersions.policyVersion,
            runAt: run.createdAt.toISOString(),
            // D2 is open: no source archive horizon has been measured, so the statement says
            // so rather than naming a date nobody has verified.
            archiveHorizon:
              'not established — no source archive horizon has been measured (D2, gate G10)',
            coverage: run.coverage,
            failedSources: sourceOutcomes.filter(
              (outcome) => outcome.outcome === 'FAILED' || outcome.outcome === 'SKIPPED',
            ),
            unmeasuredLanguages: unmeasured,
            // D-010 / D6: distinct from unmeasured, and both are true today. An unreviewed term
            // list does not fail — it returns nothing — so an empty result in that language is
            // weaker evidence than an empty result in a reviewed one.
            unreviewedTermLanguages: run.requestedScope.languages.filter(
              (language) => unreviewedLexiconNote(taxonomy.lexicon, language) !== null,
            ),
          });

    return {
      searchId: run.searchId,
      execution: run.execution,
      findingsState,
      findingCounts,
      coverage: run.coverage,
      noMatchStatement:
        noMatchStatement === null
          ? null
          : {
              headline: noMatchStatement.headline,
              limitations: [...noMatchStatement.lines],
              disclaimer: REVIEW_DISCLAIMER,
            },
      findings: findings.map((finding) => toFindingWire(finding, suspensionNotes)),
      rejectedLeads: rejectedLeads.map((lead) => {
        // Read defensively at the storage boundary. `publisherDomain`, `fetchAttempted` and
        // `discoveredByEngines` were added after rows had already been written, and the stored
        // shape of an older run does not change because today's type says it should. Asserting
        // the type here instead would turn "read a search from last week" into a validation
        // failure, which is a worse answer than an empty domain.
        const stored = lead as Partial<typeof lead>;
        return {
          leadId: lead.leadId,
          url: lead.url,
          title: lead.title,
          publisher: lead.publisher,
          publisherDomain: stored.publisherDomain ?? '',
          cascadeRung: lead.cascadeRung,
          queryId: lead.queryId,
          reason: lead.reason,
          stage: lead.stage,
          fetchAttempted: stored.fetchAttempted ?? false,
          discoveredByEngines: [...(stored.discoveredByEngines ?? [])],
        };
      }),
      sourceOutcomes: sourceOutcomes.map((outcome) => ({
        sourceId: outcome.sourceId,
        sourceName: outcome.sourceName,
        cascadeRung: outcome.cascadeRung,
        outcome: outcome.outcome,
        detail: outcome.detail,
        truncation: outcome.truncation,
        failureClass: outcome.failureClass ?? null,
        // Present only for an indexed source. `?? null` rather than omitted, so a client can tell
        // "this source has no snapshot" from "this source is not the kind that has one" by
        // whether the key is there at all.
        ...(outcome.snapshotVersion === undefined && outcome.freshness === undefined
          ? {}
          : {
              snapshotVersion: outcome.snapshotVersion ?? null,
              freshness: outcome.freshness ?? null,
              snapshotRowCount: outcome.snapshotRowCount ?? null,
            }),
      })),
      unmeasuredLanguages: [...unmeasured],
      sinceSuspendedSources: Object.entries(suspensionNotes).map(([sourceId, note]) => ({
        sourceId,
        note,
      })),
      mode: this.mode === 'live' ? 'LIVE' : 'MOCK',
      liveDiscovery: run.liveDiscovery ?? null,
      searxngDiscovery: run.searxngDiscovery ?? null,
    };
  }

  /**
   * The findings state this response may honestly carry.
   *
   * Normally the run's own stored state, because that is what the run concluded with everything
   * in front of it. The exception is the one that does damage: a stored state of
   * `NO_MATCHES_FOUND` over a findings list that is **not** empty. That pair cannot both be
   * true, and of the two the findings are the evidence — they were fetched, extracted, banded
   * and stored — while the state is a summary of them.
   *
   * So a contradiction is corrected in favour of the evidence and logged as the defect it is,
   * rather than served. A reviewer who is told "no matches" does not go and look, which is
   * precisely why this is the one inconsistency worth overriding on a read path instead of
   * reporting faithfully and waiting for someone to notice.
   *
   * It also covers a run stored by an older build, whose state was computed by a version of
   * `aggregateRun` that only ever counted `CORROBORATED` and `SUPPORTED`.
   */
  private findingsStateFor(
    run: { readonly searchId: string; readonly findings: SearchSummary['findings'] },
    counts: FindingCounts,
  ): SearchSummary['findings'] {
    const violation = assertNoMatchIsHonest({ findings: run.findings, counts });
    if (violation === null) {
      return run.findings;
    }
    const corrected = describeFindings(counts);
    this.logger.error(
      `Search ${run.searchId} is stored as ${run.findings} and is being served as ` +
        `${corrected}. ${violation}`,
    );
    return corrected;
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

/**
 * Count the stored findings by band, and the leads that never became one.
 *
 * Derived from the findings rather than trusted from the run, because this is the response that
 * carries both: a count that disagreed with the list beside it would be worse than no count.
 *
 * Every value of `EvidenceBand` falls into exactly one group. A band added to the domain and not
 * added here would be counted in `total` and in nothing else, which is visible — `confirmed +
 * ambiguous + other !== total` — rather than silently dropped.
 */
function findingCountsFor(
  findings: readonly FindingRecord[],
  unresolvedLeads: number,
): FindingCounts {
  const inBands = (bands: readonly EvidenceBand[]): number =>
    findings.filter((finding) => bands.includes(finding.band)).length;

  return {
    confirmed: inBands(['CORROBORATED', 'SUPPORTED']),
    ambiguous: inBands(['AMBIGUOUS', 'COMPANY_CONTEXT']),
    other: inBands(['CONTRADICTED', 'LEAD_ONLY']),
    total: findings.length,
    unresolvedLeads,
  };
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
    ...(record.findingCounts === undefined ? {} : { findingCounts: record.findingCounts }),
    pinnedVersions: record.pinnedVersions,
    createdAt: record.createdAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null,
    refreshOfSearchId: record.refreshOfSearchId,
    progress: record.progress,
    revision: record.revision,
  };
}

/**
 * A stored finding, as the contract serves it.
 *
 * An explicit mapping rather than returning the record. The stored shape carries a tenant id
 * and internal keys that are operational detail, and a response built by spreading a database
 * record grows a field the day somebody adds one to the collection.
 */
/**
 * @param suspensionNotes note per `sourceId` whose source has been suspended since the run.
 *        T36: the finding is unchanged, and a later read must say the source has since stopped
 *        being used. See decision D-031.
 */
function toFindingWire(record: FindingRecord, suspensionNotes: Record<string, string>): Finding {
  return {
    findingId: record.findingId,
    searchId: record.searchId,
    band: record.band,
    axes: {
      identity: record.axes.identity as Finding['axes']['identity'],
      attribution: record.axes.attribution as Finding['axes']['attribution'],
      stage: record.axes.stage,
      partyRole: record.axes.partyRole,
      authorityTier: record.axes.authorityTier,
      independenceCount: record.axes.independenceCount,
    },
    rationale: [...record.rationale],
    category: record.category,
    proceduralStage: record.proceduralStage,
    partyRole: record.partyRole,
    namingAuthority: record.namingAuthority,
    attribution: {
      grade: record.attribution.grade as Finding['attribution']['grade'],
      isInference: record.attribution.isInference,
      statement: record.attribution.statement,
      companyRef: record.attribution.companyRef,
      companyName: record.attribution.companyName,
      tenureLabel: record.attribution.tenureLabel,
    },
    document: {
      documentId: record.document.documentId,
      documentVersion: record.document.documentVersion,
      url: record.document.url,
      title: record.document.title,
      publisher: record.document.publisher,
      sourceId: record.document.sourceId,
      authorityTier: record.document.authorityTier,
      language: record.document.language,
      eventDate: record.document.eventDate,
      publicationDate: record.document.publicationDate,
      updateDate: record.document.updateDate,
      retrievalDate: record.document.retrievalDate,
      cascadeRung: record.document.cascadeRung,
      mode: record.document.mode,
      sourceSuspendedSince: suspensionNotes[record.document.sourceId] ?? null,
      // Indexed-source provenance. Stored on the finding since the indexed path was built, in
      // the contract since then, and **dropped here** — this mapper builds `document` field by
      // field, and these four were never added to it. So every finding from a local snapshot
      // arrived with `sourceRecordId: undefined`, and a reviewer had no way back to the
      // publisher's own row. Optional because a discovery finding has no snapshot behind it.
      ...(record.document.sourceRecordId === undefined
        ? {}
        : { sourceRecordId: record.document.sourceRecordId }),
      ...(record.document.sourceSnapshotVersion === undefined
        ? {}
        : { sourceSnapshotVersion: record.document.sourceSnapshotVersion }),
      ...(record.document.parserVersion === undefined
        ? {}
        : { parserVersion: record.document.parserVersion }),
      ...(record.document.rawEvidenceHash === undefined
        ? {}
        : { rawEvidenceHash: record.document.rawEvidenceHash }),
      // How a metasearch layer found this document, where one did. Absent for everything else —
      // an SEC litigation release is not "discovered by" anything, and a field present on every
      // finding would read as though it were.
      ...(record.document.discoverySource === undefined
        ? {}
        : { discoverySource: record.document.discoverySource }),
      ...(record.document.discoveryEngines === undefined
        ? {}
        : { discoveryEngines: [...record.document.discoveryEngines] }),
    },
    subjectMentionSpans: record.subjectMentionSpans.map((span) => ({
      start: span.start,
      end: span.end,
    })),
    conductSpan:
      record.conductSpan === null
        ? null
        : { start: record.conductSpan.start, end: record.conductSpan.end },
    stageSpan:
      record.stageSpan === null
        ? null
        : { start: record.stageSpan.start, end: record.stageSpan.end },
    identityFactors: record.identityFactors.map((factor) => ({
      kind: factor.kind,
      strength: factor.strength as Finding['identityFactors'][number]['strength'],
      direction: factor.direction as Finding['identityFactors'][number]['direction'],
      detail: factor.detail,
    })),
    queryId: record.queryId,
    queryFamily: record.queryFamily,
    extractorVersion: record.extractorVersion,
    modelId: record.modelId,
    promptVersion: record.promptVersion,
    createdAt: record.createdAt.toISOString(),
  };
}
