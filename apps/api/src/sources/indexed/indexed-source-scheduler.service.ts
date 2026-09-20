import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

import { IndexedSourceRefreshService } from './indexed-source-refresh.service.js';

export const DEFAULT_INDEXED_SOURCE_TICK_MS = 5 * 60 * 1000;

/** Lightweight due-check loop. Source-specific cadence remains approved registry data. */
@Injectable()
export class IndexedSourceScheduler implements OnApplicationShutdown {
  private readonly logger = new Logger('IndexedSourceScheduler');
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight: Promise<void> | null = null;

  constructor(private readonly refreshes: IndexedSourceRefreshService) {}

  start(tickMs = DEFAULT_INDEXED_SOURCE_TICK_MS): void {
    if (this.timer !== null) {
      return;
    }
    this.tickInFlight = this.tick();
    this.timer = setInterval(() => {
      if (this.tickInFlight === null) {
        this.tickInFlight = this.tick();
      }
    }, tickMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      await this.refreshes.refreshDue();
    } catch (error) {
      this.logger.error(
        'Indexed-source due check failed; the scheduler will try again on the next tick.',
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
    await this.tickInFlight;
  }
}
