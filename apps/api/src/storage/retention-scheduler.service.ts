import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import { RetentionSweeper } from './retention-sweeper.service.js';

export const DEFAULT_RETENTION_TICK_MS = 5 * 60 * 1000;

/**
 * How many batches one tick will drain before yielding.
 *
 * `RetentionSweeper.sweepOnce` is batched at a hundred actions so that a backlog cannot
 * monopolise the process. That bound is right, and it means one call is not "retention ran" — it
 * is "a hundred of them ran". A tick therefore drains until a pass comes back short, up to this
 * ceiling, and then stops: bounded work per tick, and a backlog that actually shrinks instead of
 * losing ground at a hundred per five minutes.
 */
const MAX_PASSES_PER_TICK = 20;

/**
 * The thing that was missing: something that actually calls `RetentionSweeper.sweepOnce`.
 *
 * The sweeper has existed since Phase C step C5, wired as a provider and **called by nothing
 * outside its own tests**. Retention actions were created on schedule and executed never, so an
 * object past its retention date stayed in the bucket indefinitely while the record said it was
 * due for deletion. That is not a slow job; it is a compliance statement the system could not
 * back up, and it is the kind of gap an auditor finds rather than a monitor.
 *
 * # Why it runs on the worker and not the API
 *
 * Deletion is background work with no caller waiting on it, and it must run exactly once per due
 * action rather than once per API replica. `worker-main.ts` starts it beside
 * `IndexedSourceScheduler`; `main.ts` starts neither. That is the same split the outbox publisher
 * already uses in the other direction, and it is why this class does not start itself on module
 * init — a provider that starts a loop on construction runs in every process that builds the DI
 * graph, including a test that only wanted to read a record.
 *
 * Concurrency between two *workers* is handled where it belongs, in `RetentionService`: an action
 * is claimed before it is acted on, and a delete is idempotent. This class only ensures there is
 * exactly one loop per process.
 */
@Injectable()
export class RetentionScheduler implements OnApplicationShutdown {
  private readonly logger = new Logger('RetentionScheduler');
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight: Promise<void> | null = null;

  constructor(private readonly sweeper: RetentionSweeper) {}

  /**
   * Start the loop. Calling it twice is a no-op rather than a second loop.
   *
   * The guard is not defensive tidiness: two loops in one process double the read rate on the
   * due-action query and make every failure log appear twice, which is how a retention backlog
   * gets misread as a retry storm.
   */
  start(tickMs = DEFAULT_RETENTION_TICK_MS): void {
    if (this.timer !== null) {
      return;
    }
    this.tickInFlight = this.tick();
    this.timer = setInterval(() => {
      // Skipped rather than queued when the previous tick is still running. A sweep that takes
      // longer than the interval must not accumulate overlapping passes over the same actions.
      if (this.tickInFlight === null) {
        this.tickInFlight = this.tick();
      }
    }, tickMs);
    this.timer.unref();
  }

  /** One drain, for a test or an operator command that wants the work finished now. */
  async drain(now: Date = new Date()): Promise<{
    readonly passes: number;
    readonly considered: number;
    readonly completed: number;
    readonly held: number;
    readonly failed: number;
  }> {
    let passes = 0;
    let considered = 0;
    let completed = 0;
    let held = 0;
    let failed = 0;

    for (; passes < MAX_PASSES_PER_TICK; passes += 1) {
      const summary = await this.sweeper.sweepOnce({ now });
      considered += summary.considered;
      completed += summary.completed;
      held += summary.held;
      failed += summary.failed;
      if (summary.considered === 0) {
        passes += 1;
        break;
      }
      // A pass that completed nothing and held nothing is a pass where every action failed and
      // was pushed to a backoff. Draining harder would re-read the same rows and change nothing,
      // so stop and let the next tick meet them after their backoff.
      if (summary.completed === 0 && summary.held === 0) {
        passes += 1;
        break;
      }
    }

    return { passes, considered, completed, held, failed };
  }

  private async tick(): Promise<void> {
    try {
      const now = new Date();
      const summary = await this.drain(now);
      if (summary.considered > 0) {
        this.logger.log(
          `Retention sweep: ${String(summary.considered)} due action(s) considered, ` +
            `${String(summary.completed)} completed, ${String(summary.held)} held under legal ` +
            `hold, ${String(summary.failed)} failed and backed off.`,
        );
      }
      // Separately from the sweep, because an action that keeps failing is invisible in the
      // numbers above — it is counted as `failed` on every pass and looks like activity.
      await this.sweeper.overdue(now);
    } catch (error) {
      this.logger.error(
        'Retention sweep failed; it will run again on the next tick. Due deletions have NOT ' +
          'happened, so this is a compliance signal rather than a transient job failure.',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.tickInFlight = null;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Awaited rather than abandoned: a sweep interrupted between marking a reference expired and
    // deleting the object leaves work the next run has to redo, and shutting down cleanly costs
    // one pass.
    await this.tickInFlight;
  }
}
