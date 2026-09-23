/**
 * `POST /v1/screen` — the synchronous path, built entirely out of the asynchronous one.
 *
 * The whole design of this file is one decision: **run the worker's own handler, under the
 * worker's own stage lease, rather than writing a second execution path.**
 *
 * A convenience route that re-implemented "create the run, execute it, store the result" would
 * be a second place where the pinned versions, the transaction boundary, the fence and the
 * aggregation rules all have to stay correct — and the second place is always the one that
 * drifts. It would also be the second place where an invariant could be lost, which is the
 * failure `docs/decisions.md` D-061 was written about. So there is exactly one executor
 * (`SearchJobHandler`) and this file is a caller of it.
 *
 * # Why the lease is not optional
 *
 * `SearchesService.create` writes an outbox event, so the worker **will** receive this run. If
 * this route simply called the handler, the work would happen twice: once here, once in the
 * worker a moment later. Taking the stage lease first — the same `search:execute:{searchId}`
 * key the worker derives — means the worker's delivery finds the stage already terminal and
 * discards it. That mechanism already exists for redelivery (FI-07, FI-11); this is the same
 * mechanism used for the same reason.
 *
 * It follows that a failure here is **not** silently retried by the worker: the stage is closed
 * either way. That is deliberate. A caller holding a connection open for a result is a caller
 * who should be told the result failed, not one who should be left guessing whether a background
 * retry might still be running.
 *
 * # What is not different
 *
 * Nothing about entitlements, tenancy, sandbox/live separation, pinned versions, purpose
 * limitation, source health, budgets, pacing, banding or coverage. All of it is upstream of
 * this file and untouched by it. The only thing this route changes is who waits.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { CreateSearchInput, ScreenRequest, ScreenResult } from '@erly/adverse-contracts';
import type { Principal } from '@erly/adverse-domain';

import { JOB_ENVELOPE_VERSION, type JobEnvelope } from '../jobs/queue.port.js';
import { SearchJobHandler, SEARCH_QUEUED_EVENT } from '../pipeline/search-job.handler.js';
import { StageExecutionService } from '../persistence/stage-execution.service.js';
import { ApiException } from '../common/api-exception.js';
import { SearchesService } from './searches.service.js';

/** How long this route may hold a stage before the lease is renewed. Mirrors the worker. */
const LEASE_MS = 60_000;

/**
 * The ceiling on one synchronous run.
 *
 * Generous, because a live query feed paced at its recorded ceiling genuinely takes minutes and
 * cutting it off would report a failure that is really a timeout we chose. It is not unbounded,
 * because a held connection is a resource with an owner at the other end.
 */
const MAX_EXECUTION_MS = 15 * 60_000;

@Injectable()
export class ScreenService {
  private readonly logger = new Logger('Screen');

  constructor(
    private readonly searches: SearchesService,
    private readonly handler: SearchJobHandler,
    private readonly stages: StageExecutionService,
  ) {}

  async screen(input: {
    readonly principal: Principal;
    readonly request: ScreenRequest;
    readonly now: Date;
    /** Granted local-diagnostic engines, decided by the controller. Null on every normal call. */
    readonly diagnosticEngines?: readonly string[] | null | undefined;
  }): Promise<ScreenResult> {
    const startedAt = Date.now();
    const tenantId = input.principal.tenantId;
    if (tenantId === null) {
      throw new ApiException('FORBIDDEN', 'Access denied.', {
        internalDetail: 'Screen attempted without an authenticated tenant context.',
      });
    }

    // The ordinary create. Entitlements, sandbox/live separation, pinned versions, the
    // association scope and the outbox event all happen here exactly as they do for
    // `POST /v1/searches`, because this **is** that call.
    const created = await this.searches.create({
      principal: input.principal,
      data: this.toCreateSearch(input.request),
      now: input.now,
      diagnosticEngines: input.diagnosticEngines ?? null,
    });

    const stageKey = `search:execute:${created.searchId}`;
    await this.stages.ensure({
      tenantId,
      runId: created.searchId,
      stageKey,
      maxAttempts: 1,
      now: input.now,
    });

    const lease = await this.stages.acquireLease({
      tenantId,
      runId: created.searchId,
      stageKey,
      owner: `screen:${randomUUID()}`,
      leaseMs: LEASE_MS,
      maxExecutionMs: MAX_EXECUTION_MS,
      now: input.now,
    });

    if (lease === null) {
      // The worker got there first — possible when it is fast and the queue is empty. The run
      // is real and is executing; the honest answer is to say so and hand back the id, not to
      // execute it a second time.
      throw new ApiException(
        'REVISION_CONFLICT',
        'This run was already picked up by a worker. Poll it instead.',
        {
          internalDetail: `search=${created.searchId} stage=${stageKey}`,
        },
      );
    }

    let fenceRevision = lease.revision;
    const envelope: JobEnvelope = {
      envelopeVersion: JOB_ENVELOPE_VERSION,
      eventId: randomUUID(),
      eventType: SEARCH_QUEUED_EVENT,
      tenantId,
      aggregateType: 'SearchRun',
      aggregateId: created.searchId,
      aggregateRevision: created.revision,
      occurredAt: input.now.toISOString(),
      correlationId: null,
      payload: {},
    };

    try {
      await this.handler.execute({
        tenantId,
        envelope,
        runId: created.searchId,
        stageKey,
        attempt: lease.attempt,
        heartbeat: async () => {
          const renewed = await this.stages.renewLease({
            tenantId,
            stageExecutionId: lease.stageExecutionId,
            leaseToken: lease.leaseToken,
            leaseMs: LEASE_MS,
            now: new Date(),
          });
          if (renewed === null) {
            return false;
          }
          fenceRevision = renewed.revision;
          return true;
        },
      });
    } catch (error) {
      // Close the stage as failed before answering, so the worker does not pick up a run this
      // caller has already been told about. See the file header on why there is no silent retry.
      await this.stages.completeFenced({
        tenantId,
        stageExecutionId: lease.stageExecutionId,
        leaseToken: lease.leaseToken,
        expectedRevision: fenceRevision,
        state: 'ABANDONED',
        failureDetail: error instanceof Error ? error.message : String(error),
        now: new Date(),
      });
      throw error;
    }

    await this.stages.completeFenced({
      tenantId,
      stageExecutionId: lease.stageExecutionId,
      leaseToken: lease.leaseToken,
      expectedRevision: fenceRevision,
      state: 'SUCCEEDED',
      now: new Date(),
    });

    // Read the result back through the **same** route a client would use, rather than returning
    // what the pipeline handed the handler. That read is where `findingCounts` is recomputed
    // from the stored findings and where the no-match claim is checked, so returning anything
    // else here would be a result that skipped both.
    const result = await this.searches.findingsFor({ tenantId, searchId: created.searchId });
    const summary = await this.searches.findById(tenantId, created.searchId);
    const elapsedMs = Date.now() - startedAt;

    this.logger.log(
      `Screen ${created.searchId} for tenant ${tenantId}: ${summary.execution} / ` +
        `${summary.findings} / ${summary.coverage} in ${String(elapsedMs)}ms.`,
    );

    return {
      searchId: created.searchId,
      subjectId: created.subjectId,
      subjectVersion: created.subjectVersion,
      execution: summary.execution,
      findingsState: summary.findings,
      coverage: summary.coverage,
      findingCounts: result.findingCounts,
      mode: result.mode,
      result,
      elapsedMs,
    };
  }

  /**
   * The screen request, as the ordinary create input.
   *
   * `subjectSnapshot` rather than `subjectRef`: the caller gave us a name, not an id, and the
   * snapshot path already exists for exactly that (section 4.1). The subject version it creates
   * is real, is pinned to this run and is returned, so the caller can re-screen the same
   * identity later without re-sending it.
   */
  private toCreateSearch(request: ScreenRequest): CreateSearchInput {
    return {
      subjectSnapshot: {
        fullName: request.fullName,
        aliases: request.aliases,
        ...(request.dateOfBirth === undefined ? {} : { dateOfBirth: request.dateOfBirth }),
        countryContext: request.countryContext,
        knownCompanies: [],
        purpose: request.purpose,
      },
      ...(request.externalCaseRef === undefined
        ? {}
        : { externalCaseRef: request.externalCaseRef }),
      requestedScope: {
        jurisdictions: request.jurisdictions,
        languages: request.languages,
        includeFormerDirectorships: request.includeFormerDirectorships,
        fromDate: null,
        ...(request.sources === undefined ? {} : { sources: request.sources }),
      },
      environment: request.environment,
    };
  }
}
