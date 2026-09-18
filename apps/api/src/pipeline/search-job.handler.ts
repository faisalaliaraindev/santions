/**
 * The first job handler this service has ever had.
 *
 * Phase C built the consumer and then deliberately registered nothing against it (decision
 * D-016): a handler-less worker receives every queued search and dead-letters it as unroutable,
 * so the right behaviour was to refuse to start. This is the handler that makes
 * `pnpm dev:worker` a running worker instead of a loud refusal.
 *
 * # What it owns, and what it does not
 *
 * The consumer owns everything shared: ownership (SEC-01), deduplication, the lease, the fence,
 * failure classification, backoff and the dead letter. This handler owns the work, and has the
 * two obligations `JobHandler` describes:
 *
 * 1. **A deterministic stage key.** `search:execute:{searchId}` — derived from the work, never
 *    from the delivery or a clock. Two deliveries of one message therefore claim one stage, and
 *    the second is refused by the unique index rather than doing the work twice (FI-07).
 * 2. **Failures in the FR-06 vocabulary.** It throws `JobFailure` carrying a signal, never a
 *    class, so the one classification table decides what is retryable.
 *
 * # The write is one transaction
 *
 * Findings, rejected leads and the run's own three dimensions commit **together**. A crash
 * between them would leave a run claiming findings it cannot show, or showing findings it does
 * not admit to. The pipeline does all its I/O first and hands back plain values; the
 * transaction body is a write and nothing else, because it may run more than once under a
 * write conflict.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import { JobFailure, type JobContext, type JobHandler } from '../jobs/job-handler.js';
import type { JobEnvelope } from '../jobs/queue.port.js';
import { TransactionRunner } from '../persistence/transaction.runner.js';
import { FindingsService } from './findings.service.js';
import { SearchPipeline } from './search-pipeline.service.js';

/** The run fields this handler reads and writes. Deliberately narrow. */
interface SearchRunShape {
  readonly searchId: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly subjectVersion: number;
  readonly execution: string;
  readonly requestedScope: {
    readonly jurisdictions: readonly string[];
    readonly languages: readonly string[];
  };
  readonly pinnedVersions: {
    readonly taxonomyVersion: number;
    readonly policyVersion: number;
  };
  readonly revision: number;
}

export const SEARCH_QUEUED_EVENT = 'search.queued';

@Injectable()
export class SearchJobHandler implements JobHandler {
  readonly eventType = SEARCH_QUEUED_EVENT;

  private readonly logger = new Logger('SearchJobHandler');
  private readonly runs: Collection<SearchRunShape>;

  constructor(
    db: Db,
    private readonly pipeline: SearchPipeline,
    private readonly findings: FindingsService,
    private readonly transactions: TransactionRunner,
  ) {
    this.runs = db.collection<SearchRunShape>('searchRuns');
  }

  /** Derived from the work. See the note in `job-handler.ts` about why this must not vary. */
  stageKeyFor(envelope: JobEnvelope): string {
    return `search:execute:${envelope.aggregateId}`;
  }

  async execute(context: JobContext): Promise<void> {
    // From the persisted record, never from the envelope (SEC-01). The consumer has already
    // verified ownership; reading the run again is what gives us the pinned versions and the
    // scope, which an envelope must never be trusted to carry.
    const run = await this.runs.findOne({
      tenantId: context.tenantId,
      searchId: context.runId,
    });

    if (run === null) {
      // The consumer discards a delivery for a missing aggregate before reaching here, so this
      // is a genuine defect rather than a race. Unparsable-body is the closest honest signal:
      // it is non-retryable, which is right — retrying will not conjure the run.
      throw new JobFailure(
        { unparsableBody: true },
        `Search run ${context.runId} does not exist for tenant ${context.tenantId}.`,
      );
    }

    if (run.execution === 'CANCELLED') {
      // A cancellation that arrived while this message was in flight. Doing the work now and
      // writing it would re-open a run the user stopped (T30), so stop and acknowledge.
      this.logger.log(`Search ${run.searchId} was cancelled; discarding this delivery.`);
      return;
    }

    const now = new Date();
    const result = await this.pipeline.execute({
      tenantId: run.tenantId,
      searchId: run.searchId,
      subjectId: run.subjectId,
      subjectVersion: run.subjectVersion,
      jurisdictions: run.requestedScope.jurisdictions,
      languages: run.requestedScope.languages,
      taxonomyVersion: run.pinnedVersions.taxonomyVersion,
      policyVersion: run.pinnedVersions.policyVersion,
      now,
      heartbeat: context.heartbeat,
    });

    const aggregate = this.pipeline.aggregate({ result, cancelled: false });

    await this.transactions.run(
      async (session) => {
        await this.findings.replaceForSearch(
          {
            tenantId: run.tenantId,
            searchId: run.searchId,
            findings: result.findings,
            rejectedLeads: result.rejectedLeads,
          },
          session,
        );

        await this.runs.updateOne(
          // Conditional on the run not having been cancelled while this was running: a late
          // completion must not re-open a run the user stopped (T30).
          //
          // **It deliberately does not touch `revision`.** That field is the aggregate's
          // optimistic-concurrency token, and the consumer's own fence (`completeFenced`) is
          // holding the value it captured when it took the lease. A handler that bumps it makes
          // the consumer believe a competing writer won: the fence then refuses a stage that
          // actually succeeded, discards the result, and leaves the message unacknowledged to
          // be redelivered — work done, result thrown away, queue growing. Two writers
          // incrementing one counter is precisely the drift the fence exists to prevent, so the
          // handler stays out of it and lets the consumer own the fence.
          {
            tenantId: run.tenantId,
            searchId: run.searchId,
            execution: { $ne: 'CANCELLED' },
          },
          {
            $set: {
              execution: aggregate.execution,
              findings: aggregate.findings,
              coverage: aggregate.coverage,
              sourceOutcomes: result.sourceOutcomes,
              // What the live connectors put on the wire (D-060). Stored on the run because it
              // is a fact about this execution, not about the source registry: re-reading the
              // registry later cannot reconstruct how many requests this particular run made.
              liveDiscovery: result.liveDiscovery,
              completedAt: now,
              progress: {
                // Six: associations, plan, discovery, fetch, extraction, banding.
                stagesCompleted: 6,
                stagesTotal: 6,
                cascadeRungReached: result.cascadeRungReached,
                warnings: result.warnings,
              },
            },
          },
          { session },
        );
      },
      { name: 'search.complete' },
    );

    this.logger.log(
      `Search ${run.searchId} completed: ${aggregate.execution} / ${aggregate.findings} / ` +
        `${aggregate.coverage} — ${String(result.findings.length)} finding(s), ` +
        `${String(result.rejectedLeads.length)} rejected lead(s).`,
    );
  }
}
