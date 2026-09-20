import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { SourceVersionReader } from '../source-version.service.js';
import { IndexedSourceRepository } from './indexed-source.repository.js';
import type {
  IndexedArtifactParser,
  IndexedSourceRefreshState,
  ScheduledArtifactTransport,
} from './indexed-source.types.js';

export interface IndexedSourceSchedule {
  readonly sourceId: string;
  readonly artifactUrl: string;
  readonly parser: IndexedArtifactParser;
  readonly refreshIntervalMs: number;
  readonly staleAfterMs: number;
  readonly minimumExpectedRows: number;
  readonly acceptedContentTypes: readonly string[];
}

export const INDEXED_SOURCE_SCHEDULES = 'INDEXED_SOURCE_SCHEDULES';

export type RefreshResult =
  | { readonly kind: 'SUCCEEDED'; readonly state: IndexedSourceRefreshState }
  | { readonly kind: 'NOT_MODIFIED'; readonly state: IndexedSourceRefreshState }
  | { readonly kind: 'SKIPPED_NOT_DUE'; readonly state: IndexedSourceRefreshState }
  | { readonly kind: 'SKIPPED_IN_FLIGHT'; readonly state: IndexedSourceRefreshState }
  | { readonly kind: 'FAILED'; readonly state: IndexedSourceRefreshState };

export interface IndexedSourceOperatorStatus extends IndexedSourceRefreshState {
  readonly sourceName: string;
  readonly publisher: string | null;
  readonly sourceActive: boolean;
  readonly registryActiveSourceVersion: number | null;
  readonly snapshotSourceVersion: number | null;
  readonly endpointUrl: string;
  readonly expectedParserVersion: string;
  readonly snapshotUsable: boolean;
  readonly refreshIntervalMs: number;
  readonly staleAfterMs: number;
}

const REFRESH_LEASE_MS = 10 * 60 * 1000;
const FAILURE_RETRY_MS = 15 * 60 * 1000;

/**
 * One reusable refresh lifecycle for bulk files and scheduled feeds.
 *
 * Fetch and parse happen before the transaction. Only a validated non-empty artifact reaches
 * `commitSnapshot`, so malformed content can update refresh health but cannot replace usable data.
 */
@Injectable()
export class IndexedSourceRefreshService {
  private readonly logger = new Logger('IndexedSourceRefresh');
  private readonly inFlight = new Map<string, Promise<RefreshResult>>();

  constructor(
    private readonly repository: IndexedSourceRepository,
    private readonly versions: SourceVersionReader,
    private readonly transport: ScheduledArtifactTransport,
    private readonly schedules: ReadonlyMap<string, IndexedSourceSchedule>,
    private readonly clock: () => Date = (): Date => new Date(),
  ) {}

  async refresh(sourceId: string, force = false): Promise<RefreshResult> {
    const running = this.inFlight.get(sourceId);
    if (running !== undefined) {
      return running;
    }
    const promise = this.runRefresh(sourceId, force).finally(() => {
      this.inFlight.delete(sourceId);
    });
    this.inFlight.set(sourceId, promise);
    return promise;
  }

  async refreshDue(): Promise<readonly RefreshResult[]> {
    const now = this.clock();
    const results: RefreshResult[] = [];
    // Deliberately sequential. Domain pacing belongs to transport, and this prevents a scheduler
    // tick from producing an avoidable burst across sources hosted by one publisher.
    for (const schedule of this.schedules.values()) {
      const state = await this.repository.state(schedule.sourceId);
      if (state.nextRefreshDueAt === null || state.nextRefreshDueAt <= now) {
        results.push(await this.refresh(schedule.sourceId));
      }
    }
    return results;
  }

  async listStatuses(): Promise<readonly IndexedSourceOperatorStatus[]> {
    const schedules = [...this.schedules.values()].sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId),
    );
    const states = await this.repository.listStates(schedules.map((schedule) => schedule.sourceId));
    const stateById = new Map(states.map((state) => [state.sourceId, state]));
    return Promise.all(
      schedules.map(async (schedule): Promise<IndexedSourceOperatorStatus> => {
        const state = stateById.get(schedule.sourceId);
        if (state === undefined) {
          throw new Error(`Indexed source ${schedule.sourceId} has no refresh state.`);
        }
        const active = await this.versions.loadActive(schedule.sourceId);
        return {
          ...state,
          sourceName: active?.sourceName ?? schedule.sourceId,
          publisher: active?.publisher ?? null,
          sourceActive: active !== null,
          registryActiveSourceVersion: active?.version ?? null,
          snapshotSourceVersion: state.activeSourceVersion,
          endpointUrl: schedule.artifactUrl,
          expectedParserVersion: schedule.parser.parserVersion,
          snapshotUsable: state.activeSnapshotVersion !== null,
          refreshIntervalMs: schedule.refreshIntervalMs,
          staleAfterMs: schedule.staleAfterMs,
        };
      }),
    );
  }

  private async runRefresh(sourceId: string, force: boolean): Promise<RefreshResult> {
    const schedule = this.schedules.get(sourceId);
    if (schedule === undefined) {
      throw new Error(`No indexed-source schedule is registered for ${sourceId}.`);
    }
    const now = this.clock();
    const before = await this.repository.state(sourceId);
    if (!force && before.nextRefreshDueAt !== null && before.nextRefreshDueAt > now) {
      return { kind: 'SKIPPED_NOT_DUE', state: before };
    }

    const version = await this.versions.loadActive(sourceId);
    if (version === null) {
      return this.failWithoutClaim(
        schedule,
        before,
        `Source ${sourceId} has no ACTIVE approved version. The scheduler did not contact it.`,
      );
    }
    if (version.endpointUrl !== schedule.artifactUrl) {
      return this.failWithoutClaim(
        schedule,
        before,
        `The active version endpoint does not match the reviewed schedule for ${sourceId}.`,
      );
    }

    const claim = await this.repository.claimRefresh({
      sourceId,
      sourceVersion: version.version,
      now,
      leaseMs: REFRESH_LEASE_MS,
    });
    if (!claim.claimed) {
      return { kind: 'SKIPPED_IN_FLIGHT', state: await this.repository.state(sourceId) };
    }

    try {
      const response = await this.transport.fetch({
        sourceId,
        url: schedule.artifactUrl,
        etag: before.etag,
        lastModified: before.lastModified,
      });
      if (response.status === 304) {
        if (before.activeSnapshotVersion === null) {
          throw new RefreshValidationError(
            304,
            'Publisher returned 304 but this service has no last-known-good snapshot.',
          );
        }
        await this.repository.recordNotModified({
          sourceId,
          refreshId: claim.refreshId,
          now,
          httpStatus: 304,
          refreshIntervalMs: schedule.refreshIntervalMs,
        });
        return { kind: 'NOT_MODIFIED', state: await this.repository.state(sourceId) };
      }
      if (response.status < 200 || response.status >= 300 || response.body === null) {
        throw new RefreshValidationError(
          response.status,
          `Artifact request returned HTTP ${String(response.status)} without a usable body.`,
        );
      }
      this.assertContentType(schedule, response.contentType, response.status);

      const artifactHash = sha256(response.body);
      if (artifactHash === before.artifactHash && before.activeSnapshotVersion !== null) {
        await this.repository.recordNotModified({
          sourceId,
          refreshId: claim.refreshId,
          now,
          httpStatus: response.status,
          refreshIntervalMs: schedule.refreshIntervalMs,
        });
        return { kind: 'NOT_MODIFIED', state: await this.repository.state(sourceId) };
      }

      const parsed = schedule.parser.parse({
        sourceId,
        artifactUrl: schedule.artifactUrl,
        contentType: response.contentType,
        body: response.body,
      });
      if (parsed.records.length < schedule.minimumExpectedRows) {
        throw new RefreshValidationError(
          response.status,
          `Parser ${schedule.parser.parserVersion} produced ${String(parsed.records.length)} ` +
            `record(s), below the reviewed minimum of ${String(schedule.minimumExpectedRows)}. ` +
            'The previous snapshot was preserved.',
        );
      }
      assertUniqueRecordIds(parsed.records.map((record) => record.sourceRecordId));

      const snapshotVersion = `${sourceId}:${artifactHash.slice(0, 24)}`;
      await this.repository.commitSnapshot({
        sourceId,
        sourceVersion: version.version,
        snapshotVersion,
        artifactHash,
        parserVersion: schedule.parser.parserVersion,
        publisherVersion: parsed.publisherVersion,
        artifactUrl: schedule.artifactUrl,
        retrievedAt: now,
        etag: response.etag,
        lastModified: response.lastModified,
        refreshIntervalMs: schedule.refreshIntervalMs,
        records: parsed.records,
        refreshId: claim.refreshId,
      });
      return { kind: 'SUCCEEDED', state: await this.repository.state(sourceId) };
    } catch (error) {
      const status = error instanceof RefreshValidationError ? error.httpStatus : null;
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${sourceId} refresh failed; last-good snapshot retained: ${reason}`);
      await this.repository.recordFailure({
        sourceId,
        refreshId: claim.refreshId,
        now,
        httpStatus: status,
        reason,
        staleAfterMs: schedule.staleAfterMs,
        retryAt: new Date(now.getTime() + FAILURE_RETRY_MS),
      });
      return { kind: 'FAILED', state: await this.repository.state(sourceId) };
    }
  }

  private assertContentType(
    schedule: IndexedSourceSchedule,
    contentType: string | null,
    status: number,
  ): void {
    if (contentType === null) {
      return;
    }
    const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!schedule.acceptedContentTypes.includes(mediaType)) {
      throw new RefreshValidationError(
        status,
        `Unexpected content type ${contentType}; expected ${schedule.acceptedContentTypes.join(', ')}.`,
      );
    }
  }

  private failWithoutClaim(
    schedule: IndexedSourceSchedule,
    state: IndexedSourceRefreshState,
    reason: string,
  ): RefreshResult {
    this.logger.warn(reason);
    return {
      kind: 'FAILED',
      state: {
        ...state,
        refreshStatus: 'FAILED',
        failureReason: reason,
        freshness:
          state.lastSuccessfulRefreshAt === null
            ? 'UNAVAILABLE'
            : this.clock().getTime() - state.lastSuccessfulRefreshAt.getTime() >
                schedule.staleAfterMs
              ? 'STALE'
              : 'CURRENT',
      },
    };
  }
}

class RefreshValidationError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'RefreshValidationError';
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertUniqueRecordIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (id.trim() === '') {
      throw new Error('A parsed indexed-source record has an empty sourceRecordId.');
    }
    if (seen.has(id)) {
      throw new Error(`Parser produced duplicate sourceRecordId ${id}.`);
    }
    seen.add(id);
  }
}
