/**
 * `DiscoveryRequestLog` — what a run actually put on the wire, per source, counted.
 *
 * # Why this exists
 *
 * Until now the number of external requests a search made was readable in exactly one place —
 * `FixedFeedPollCache.statsFor`, in the worker's memory, for fixed feeds only. Postman folder 14
 * says so in as many words: *"Request count is NOT visible over HTTP."*
 *
 * That is fine while every live source is a `FIXED_FEED`, because a fixed feed's cost is a
 * constant. It stops being fine the moment a `QUERY_FEED` is on the ladder, because the whole
 * distinction between the two shapes is a statement about **request counts**:
 *
 * - a `FIXED_FEED` costs one request per poll floor, *whatever the plan's size*;
 * - a `QUERY_FEED` costs one request per planned query, *bounded by the budget*.
 *
 * Neither claim can be checked from a result that reports only `SUCCEEDED` and a list of source
 * ids. So this records the counts, the run carries them, and the findings response states them.
 *
 * # What it deliberately does not record
 *
 * **No query text and no URLs.** A planned query is the subject's name plus a conduct term; a
 * GDELT URL contains it verbatim. Putting either into a diagnostic field would move personal
 * data into a response whose whole purpose is to be quotable in an audit.
 *
 * What is recorded instead is `endpointDigest` — the first twelve hex characters of a SHA-256 of
 * the URL. It answers the one question the counts cannot: *were these distinct network
 * operations, or one operation counted many times?* Two requests with the same digest went to
 * the same address; two with different digests did not. It is one-way, it is per URL rather than
 * per subject, and it reveals nothing about the person searched.
 *
 * The **family** (`F1`, `F3`, …) is recorded, because it is a property of the query *plan*, not
 * of the person, and it is the thing that ties "the planner generated F3" to "an F3 query reached
 * the wire".
 *
 * # It is a diagnostic, not evidence
 *
 * Nothing in the pipeline reads it to make a decision. It is written by the two live discovery
 * connectors, read once by `SearchPipeline` at the end of discovery, and forgotten. A run that
 * produced no entries is a run in which no live connector made an attempt — which is exactly
 * what a mock-mode run is, and the absence is therefore itself a fixture-versus-live signal.
 *
 * # Bounded, because it is process-global
 *
 * One instance per process, shared by every run. Two bounds keep that from becoming a leak: at
 * most `MAX_ATTEMPTS_PER_JOB` attempts are kept for any one job (a plan is capped at 200 queries
 * and at most a handful of sources, so the ceiling is not reachable by an honest run), and at
 * most `MAX_JOBS` jobs are tracked, oldest evicted first. `forget` is called by the pipeline as
 * soon as it has read the summary; the eviction bound is the backstop for a run that dies
 * between the attempt and the read.
 */

import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

/** Attempts kept per job. A bounded plan is 200 queries; this is far above any honest run. */
const MAX_ATTEMPTS_PER_JOB = 2_000;

/** Jobs tracked at once. Oldest evicted first, so a run that never calls `forget` cannot leak. */
const MAX_JOBS = 64;

/** How many hex characters of the endpoint digest are kept. Enough to distinguish, not to undo. */
const DIGEST_LENGTH = 12;

/** One attempt by one live discovery connector to serve one planned query. */
export interface DiscoveryAttempt {
  /** The search id. Every attempt belongs to exactly one run. */
  readonly jobId: string;
  readonly sourceId: string;
  readonly sourceName: string;
  /** What the approved version records. The whole point of the distinction being recorded. */
  readonly endpointKind: 'FIXED_FEED' | 'QUERY_FEED';
  /** The FR-04 family of the planned query being served. */
  readonly family: string;
  readonly queryId: string;
  /** The endpoint's host, so a coverage reader can see which publishers were addressed. */
  readonly host: string;
  /** A one-way digest of the endpoint URL. See the file header for why not the URL. */
  readonly endpointDigest: string;
  /**
   * Whether this attempt opened a socket.
   *
   * False when a fixed feed was served from `FixedFeedPollCache` inside the publisher's own poll
   * floor. The difference between `attempts` and `requests` is precisely the amplification that
   * the cache removes, so both are counted rather than only the second.
   */
  readonly issued: boolean;
}

/** What one source cost a run. */
export interface DiscoverySourceStat {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly endpointKind: 'FIXED_FEED' | 'QUERY_FEED';
  /** The hosts addressed. Normally one; a list because the record permits more than one. */
  readonly hosts: readonly string[];
  /** Planned queries this connector was asked to serve. */
  readonly queriesOffered: number;
  /** Of those, how many opened a socket. This is the number the publisher's log would show. */
  readonly requestsIssued: number;
  /** Offered minus issued — served from the poll cache, or refused before the socket. */
  readonly servedWithoutRequest: number;
  /**
   * Distinct endpoints actually requested.
   *
   * The regression guard for a query feed: `requestsIssued` can be inflated by retries, but
   * `distinctEndpoints` cannot, and a cache that collapsed distinct queries would show many
   * offered queries against **one** distinct endpoint.
   */
  readonly distinctEndpoints: number;
  /** Families offered to this connector, sorted. */
  readonly families: readonly string[];
  /** Families that produced a real outbound request, sorted. The F2-F4 proof, in the response. */
  readonly familiesRequested: readonly string[];
}

/** What a whole run cost, across every live connector. */
export interface DiscoveryRequestSummary {
  readonly sources: readonly DiscoverySourceStat[];
  /** Real outbound requests across every source. */
  readonly totalRequestsIssued: number;
}

@Injectable()
export class DiscoveryRequestLog {
  private readonly logger = new Logger('DiscoveryRequests');
  /** Insertion-ordered, which is what makes the oldest-first eviction below correct. */
  private readonly byJob = new Map<string, DiscoveryAttempt[]>();
  /** Jobs whose diagnostic has overflowed, so the warning is logged once rather than per call. */
  private readonly truncated = new Set<string>();

  /**
   * Record one attempt.
   *
   * Never throws and never blocks the request it describes: a diagnostic that can fail a search
   * is worse than no diagnostic. The only thing it does on overflow is stop appending and say so
   * once.
   */
  record(attempt: DiscoveryAttempt): void {
    const existing = this.byJob.get(attempt.jobId);
    if (existing === undefined) {
      this.evictIfFull();
      this.byJob.set(attempt.jobId, [attempt]);
      return;
    }
    if (existing.length >= MAX_ATTEMPTS_PER_JOB) {
      if (!this.truncated.has(attempt.jobId)) {
        this.truncated.add(attempt.jobId);
        this.logger.warn(
          `${attempt.jobId} recorded more than ${String(MAX_ATTEMPTS_PER_JOB)} discovery ` +
            `attempts. The diagnostic is now truncated for this run; the run itself is ` +
            `unaffected. A bounded plan cannot reach this, so it means something is looping.`,
        );
      }
      return;
    }
    existing.push(attempt);
  }

  /**
   * What this run cost, per source.
   *
   * An empty `sources` list is a real answer and means no **live** discovery connector made an
   * attempt — a mock-mode run, or a run whose whole ladder was refused before a connector was
   * reached. It is never synthesised into a zero-cost success.
   */
  summaryFor(jobId: string): DiscoveryRequestSummary {
    const attempts = this.byJob.get(jobId) ?? [];
    const bySource = new Map<string, DiscoveryAttempt[]>();
    for (const attempt of attempts) {
      const bucket = bySource.get(attempt.sourceId);
      if (bucket === undefined) {
        bySource.set(attempt.sourceId, [attempt]);
      } else {
        bucket.push(attempt);
      }
    }

    const sources = [...bySource.entries()]
      .map(([sourceId, entries]): DiscoverySourceStat => {
        const issued = entries.filter((entry) => entry.issued);
        return {
          sourceId,
          sourceName: entries[0]?.sourceName ?? sourceId,
          endpointKind: entries[0]?.endpointKind ?? 'FIXED_FEED',
          hosts: sorted(entries.map((entry) => entry.host)),
          queriesOffered: entries.length,
          requestsIssued: issued.length,
          servedWithoutRequest: entries.length - issued.length,
          distinctEndpoints: new Set(issued.map((entry) => entry.endpointDigest)).size,
          families: sorted(entries.map((entry) => entry.family)),
          familiesRequested: sorted(issued.map((entry) => entry.family)),
        };
      })
      .toSorted((a, b) => a.sourceId.localeCompare(b.sourceId));

    return {
      sources,
      totalRequestsIssued: sources.reduce((total, source) => total + source.requestsIssued, 0),
    };
  }

  /** Drop a run's attempts once its summary has been read. */
  forget(jobId: string): void {
    this.byJob.delete(jobId);
    this.truncated.delete(jobId);
  }

  private evictIfFull(): void {
    while (this.byJob.size >= MAX_JOBS) {
      const oldest = this.byJob.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.byJob.delete(oldest.value);
      this.truncated.delete(oldest.value);
    }
  }
}

/**
 * The digest recorded in place of a URL.
 *
 * SHA-256, truncated. Truncation is not a weakening here: the question it answers is "same
 * address or different?", and twelve hex characters collide at a rate far below the number of
 * distinct endpoints one bounded plan can produce.
 */
export function endpointDigest(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, DIGEST_LENGTH);
}

/** The host of a URL, or `unknown` when it will not parse. Never throws into a discovery path. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

function sorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].toSorted((a, b) => a.localeCompare(b));
}
