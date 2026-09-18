/**
 * The minimum interval between outbound requests to one source, enforced.
 *
 * # Why this exists
 *
 * `accessPolicy.requestCeilingPerSecond` has been recorded on source versions since FR-05 and
 * read by **nothing**. It appeared in registry records, in the contract schema and in the admin
 * API, and no code anywhere turned it into a delay. A recorded ceiling that nothing enforces is
 * worse than no ceiling at all: it reads, to anyone auditing the record, as a commitment the
 * service is keeping.
 *
 * It did not matter while every live source was a `FIXED_FEED`, because a fixed feed makes one
 * request per poll floor and `FixedFeedPollCache` already bounds that. A `QUERY_FEED` makes
 * **one request per planned query**, dispatched from a serial loop with no delay in it
 * (`search-pipeline.service.ts`), so a plan of twenty queries is twenty requests as fast as the
 * event loop will carry them.
 *
 * GDELT publishes its ceiling in the body of its own 429 — *"Please limit requests to one every
 * 5 seconds"* — which this project read on 2026-09-18 during first contact. Against that,
 * an unpaced fan-out is refused from the second request onward, and because GDELT's stop
 * conditions carry `haltOnRateLimit: true` with `requiresFreshApprovalOnHalt: true`, the first
 * live run would halt the source and leave it needing a fresh human approval. The fix is to make
 * the number the approver signed the number the socket obeys.
 *
 * # What it is not
 *
 * Not a budget, and not a breaker. `SourceHealthService` still counts what was spent and
 * `FetchGateService` still refuses when an hourly or daily budget is exhausted; this only ever
 * decides *when* an already-authorised request goes out. It never drops a query, never merges
 * two queries into one request, and never changes what a 429 means — a paced request that is
 * refused is refused exactly as an unpaced one was.
 *
 * # Fairness
 *
 * Waiters on one key are served in arrival order through a promise chain, so a long plan cannot
 * be starved by a later caller slipping in front of it. The chain is per key: pacing GDELT never
 * delays the SEC.
 */

/** Milliseconds. Injected so a test can assert the wait without spending it. */
export type PacerClock = () => number;

/** Injected for the same reason. The default is a real timer. */
export type PacerSleep = (ms: number) => Promise<void>;

export interface RequestPacerOptions {
  readonly now?: PacerClock;
  readonly sleep?: PacerSleep;
}

/**
 * Turn a recorded requests-per-second ceiling into a minimum interval in milliseconds.
 *
 * `null` in, `null` out: a source that records no ceiling is not paced, because inventing an
 * interval for a publisher who published none is the same class of mistake as inventing their
 * robots position. A non-positive or non-finite figure is treated as absent rather than as
 * "unlimited", so a corrupt record fails towards asking less often, not more.
 */
export function minIntervalMsFor(requestCeilingPerSecond: number | null): number | null {
  if (
    requestCeilingPerSecond === null ||
    !Number.isFinite(requestCeilingPerSecond) ||
    requestCeilingPerSecond <= 0
  ) {
    return null;
  }
  return Math.ceil(1000 / requestCeilingPerSecond);
}

/** What one `pace` call did, returned so a caller can log or assert it. */
export interface PaceResult {
  /** Milliseconds actually spent waiting. `0` when the slot was already free. */
  readonly waitedMs: number;
  /** The interval applied, or `null` when the source records no ceiling and none was applied. */
  readonly minIntervalMs: number | null;
}

export class RequestPacer {
  /** Per key, the earliest clock reading at which the next request may leave. */
  private readonly nextFreeAt = new Map<string, number>();
  /** Per key, the tail of the queue of waiters, so arrival order is preserved. */
  private readonly tail = new Map<string, Promise<void>>();
  private readonly now: PacerClock;
  private readonly sleep: PacerSleep;

  constructor(options: RequestPacerOptions = {}) {
    this.now = options.now ?? ((): number => Date.now());
    this.sleep =
      options.sleep ??
      ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Wait until a request on `key` may be sent, then reserve the next slot.
   *
   * The slot is reserved on the way out rather than on the way in, so the interval is measured
   * between one request leaving and the next leaving — which is what a publisher who says "one
   * every five seconds" is describing.
   */
  async pace(key: string, minIntervalMs: number | null): Promise<PaceResult> {
    if (minIntervalMs === null || minIntervalMs <= 0) {
      return { waitedMs: 0, minIntervalMs: null };
    }

    const previous = this.tail.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Chained off the previous waiter's completion, and `catch`-guarded so one failed waiter
    // cannot poison the queue for every request behind it.
    this.tail.set(
      key,
      previous.then(
        () => mine,
        () => mine,
      ),
    );

    try {
      await previous;
    } catch {
      // A predecessor that failed still released its slot; this one proceeds on its own merits.
    }

    try {
      const earliest = this.nextFreeAt.get(key) ?? Number.NEGATIVE_INFINITY;
      const waitedMs = Math.max(0, earliest - this.now());
      if (waitedMs > 0) {
        await this.sleep(waitedMs);
      }
      this.nextFreeAt.set(key, this.now() + minIntervalMs);
      return { waitedMs, minIntervalMs };
    } finally {
      // Always, including on a thrown sleep: a waiter that never released would stall every
      // later request on this key for the life of the process.
      release();
    }
  }

  /** The earliest send time currently reserved for a key. Diagnostics and tests only. */
  nextFreeFor(key: string): number | null {
    return this.nextFreeAt.get(key) ?? null;
  }
}

/**
 * The process-wide pacer, beside `FixedFeedPollCache` and for the same reason.
 *
 * A ceiling is a promise about what one deployment does to one publisher, so it has to be shared
 * by every search running in the process. A per-request instance would pace each search against
 * itself and none of them against each other, which is the defect rather than the fix.
 */
export const requestPacer = new RequestPacer();
