/**
 * `FixedFeedPollCache` — the thing that makes a fixed feed cost one request however many
 * searches are running.
 *
 * # The defect this exists to remove
 *
 * A `FIXED_FEED` is the publisher's whole list. The connector polls it and matches the planned
 * query against what came back, so the number of external requests it costs is a property of the
 * **feed**, not of the query plan. Without something holding that line, it is a property of the
 * plan: `RssNewsDiscoveryAdapter.discover` is called once per planned query, and every F1 query —
 * one per name form, per language, per jurisdiction — opened its own socket at the same
 * unchanging URL. A subject with three aliases in two languages across two jurisdictions polled
 * the SEC twelve times for twelve identical responses, and nothing at all stopped the next search
 * a second later from doing it again.
 *
 * # It is the publisher's own poll floor, not a cache we invented
 *
 * `accessPolicy.pollFloorSeconds` is a number a source's approved version records — fifteen
 * minutes for the SEC — and until now it was parsed into `ActiveSourceVersion.pollFloorMs` and
 * read by nothing. It is the publisher's stated **minimum interval between polls**. Serving every
 * poll inside that window from the last response is not an optimisation that trades freshness for
 * politeness; it is the behaviour the record already described, finally implemented. Litigation
 * releases appear a handful of times a week, so nothing is lost by it.
 *
 * A source that records no floor is not cached beyond the in-flight collapse below. A cache
 * duration nobody approved would be a freshness decision made in code.
 *
 * # Three rules
 *
 * **Only a successful poll is stored.** A failure replayed for fifteen minutes would turn one
 * transient error into an outage, hide the breaker's own recovery, and make the retry the FR-06
 * table prescribes invisible. Failures fall straight through.
 *
 * **Concurrent polls collapse into one request.** A store of completed responses alone lets every
 * run that starts before the first one finishes through to the socket — which is exactly the
 * shape of a burst, and exactly what a publisher's rate limiter sees. The in-flight map is the
 * half that makes the guarantee hold under load.
 *
 * **It counts.** `statsFor` reports requests actually issued against polls served, so "one search
 * made one request" is a number somebody can read rather than a claim. The live smoke test reads
 * exactly this.
 *
 * # What it is not
 *
 * It is not a store of evidence and it is not per tenant. The bytes are a public list that is
 * identical for every caller, and the documents behind the leads are fetched per lead through the
 * ordinary gated path with their own provenance. Sharing a poll across tenants is the honest
 * record of what happened: we polled once and matched many times.
 *
 * It is not persistent. A restart re-polls, which is correct — an in-memory floor cannot outlive
 * the process that holds it, and claiming otherwise would be claiming a guarantee across a deploy
 * that nothing enforces.
 */

import { Injectable, Logger } from '@nestjs/common';

import type { FetchResult } from './evidence-fetch.port.js';
import { type SourceOutcome } from './source-adapter.js';

/** What one feed URL has cost and returned. Read by tests and by the live smoke test. */
export interface PollStats {
  /** Requests actually put on the wire for this URL. */
  readonly requests: number;
  /** Polls answered, whether from the wire or from the stored response. */
  readonly served: number;
  /** When the last request was issued, or null if none has been. */
  readonly lastPolledAt: string | null;
  /** How many of `served` were answered without a request. */
  readonly reused: number;
}

interface Entry {
  outcome: SourceOutcome<FetchResult>;
  polledAt: number;
}

interface Counters {
  requests: number;
  served: number;
  lastPolledAt: string | null;
}

@Injectable()
export class FixedFeedPollCache {
  private readonly logger = new Logger('FixedFeedPoll');
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<SourceOutcome<FetchResult>>>();
  private readonly counters = new Map<string, Counters>();

  /**
   * Poll a fixed feed, or answer from the last poll.
   *
   * `minIntervalMs` is the publisher's recorded floor. Null means the source records none, in
   * which case a stored response is never reused — only a poll already in flight is joined.
   */
  async poll(input: {
    readonly url: string;
    readonly sourceId: string;
    readonly minIntervalMs: number | null;
    readonly now: Date;
    readonly fetch: () => Promise<SourceOutcome<FetchResult>>;
  }): Promise<SourceOutcome<FetchResult>> {
    const counters = this.countersFor(input.url);
    counters.served += 1;

    const entry = this.entries.get(input.url);
    if (
      entry !== undefined &&
      input.minIntervalMs !== null &&
      input.now.getTime() - entry.polledAt < input.minIntervalMs
    ) {
      const ageMs = input.now.getTime() - entry.polledAt;
      this.logger.debug(
        `${input.sourceId}: served from the poll ${String(Math.round(ageMs / 1000))}s ago. ` +
          `${input.url} is a fixed feed with a ${String(
            Math.round(input.minIntervalMs / 1000),
          )}s poll floor, so this asked the publisher nothing.`,
      );
      return entry.outcome;
    }

    const existing = this.inFlight.get(input.url);
    if (existing !== undefined) {
      // A poll of this URL is already open. Joining it is what keeps a burst of searches from
      // becoming a burst of requests; without this the floor only holds between polls, never
      // during one.
      this.logger.debug(`${input.sourceId}: joined the poll already in flight for ${input.url}.`);
      return existing;
    }

    counters.requests += 1;
    counters.lastPolledAt = input.now.toISOString();
    this.logger.log(
      `${input.sourceId}: polling ${input.url} — request ${String(counters.requests)} for this ` +
        `URL in this process, serving poll ${String(counters.served)}.`,
    );

    const pending = input
      .fetch()
      .then((outcome) => {
        if (outcome.status !== 'FAILED') {
          // Only a successful poll is stored. See the file header.
          this.entries.set(input.url, { outcome, polledAt: input.now.getTime() });
        }
        return outcome;
      })
      .finally(() => {
        this.inFlight.delete(input.url);
      });

    this.inFlight.set(input.url, pending);
    return pending;
  }

  /** What this URL has cost. Zeroed rather than absent for a URL never polled. */
  statsFor(url: string): PollStats {
    const counters = this.counters.get(url);
    if (counters === undefined) {
      return { requests: 0, served: 0, lastPolledAt: null, reused: 0 };
    }
    return {
      requests: counters.requests,
      served: counters.served,
      lastPolledAt: counters.lastPolledAt,
      reused: counters.served - counters.requests,
    };
  }

  /** Every URL this process has polled, for an operator view and for the live smoke test. */
  snapshot(): Readonly<Record<string, PollStats>> {
    const out: Record<string, PollStats> = {};
    for (const url of this.counters.keys()) {
      out[url] = this.statsFor(url);
    }
    return out;
  }

  /**
   * Forget every stored poll.
   *
   * For tests and for the local smoke test, which must be able to prove it made a real request
   * rather than reading one an earlier run left behind. It does not reset the counters: the
   * number of requests this process has issued is a fact about the process, and zeroing it would
   * make the one number the smoke test exists to report resettable by the thing being measured.
   */
  clear(): void {
    this.entries.clear();
  }

  private countersFor(url: string): Counters {
    const existing = this.counters.get(url);
    if (existing !== undefined) {
      return existing;
    }
    const created: Counters = { requests: 0, served: 0, lastPolledAt: null };
    this.counters.set(url, created);
    return created;
  }
}
