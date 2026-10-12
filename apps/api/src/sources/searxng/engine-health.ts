/**
 * Per-engine outcomes — what each engine was asked, what it did, and what that means for the run.
 *
 * # Why the existing request log is not enough
 *
 * `DiscoveryRequestLog` counts requests **per source**, and SearXNG is one source. It would
 * report `searxng-adverse-media: 8 queries offered, 8 requests issued` and be entirely correct
 * and entirely useless, because the failures that matter inside this source are per *engine*.
 * "Google suspended on CAPTCHA while Bing and DuckDuckGo answered" is the exact shape the
 * failure-isolation claim rests on, and one number per source cannot express it.
 *
 * So this sits beside the request log rather than replacing it. The request log says what the
 * **instance** cost; this says what the **engines** did.
 *
 * # Every configured engine produces an outcome. There are no silent absences.
 *
 * An engine that was not permitted is `DISABLED_BY_POLICY` with the decision id that disabled
 * it. An engine with no instance configured is `NOT_CONFIGURED`. An engine that answered with
 * nothing is `ZERO_RESULTS`, which is **not a failure** — it is a working engine reporting that
 * it has nothing, and treating it as a gap would turn "this person is not in the news" into "we
 * could not look".
 *
 * That distinction is the same one `SourceOutcome` draws between `NO_RESULTS` and `FAILED`, one
 * level down, and it is drawn again here for the same reason: collapsing them lets a clean result
 * and an outage read identically.
 *
 * # The source-level outcome is derived, never asserted
 *
 * `deriveSourceOutcome` computes it from the engine rows. Nothing else may decide it, because a
 * source outcome computed in one place and asserted in another is how "five engines worked" ends
 * up reported as a failed source.
 *
 * # It is a diagnostic and nothing in the pipeline reads it back
 *
 * Written by the connector, read once by `SearchPipeline` at the end of discovery, and forgotten
 * — the same lifecycle and the same two bounds as `DiscoveryRequestLog`, because it is
 * process-global for the same reason.
 *
 * # What it deliberately does not record
 *
 * **No query text, no URLs and no secrets.** A planned query is the subject's name plus a conduct
 * term. What is recorded is counts, engine names, durations and the instance's own failure
 * sentences — none of which names the person searched or carries a credential.
 */

import { Injectable, Logger } from '@nestjs/common';

import type { DiscoveryEngine } from './engine-governance.js';

/** Attempts kept per job. Far above what a bounded plan can produce. */
const MAX_ENTRIES_PER_JOB = 4_000;

/** Jobs tracked at once. Oldest evicted first, so a run that never calls `forget` cannot leak. */
const MAX_JOBS = 64;

/**
 * What one engine did for one planned query.
 *
 * A closed union, because every one of these leads a reader somewhere different and a free
 * string would let a new case arrive without anybody deciding which of the existing meanings it
 * has. The three groups matter:
 *
 * - **Answered**: `RETURNED_RESULTS`, `ZERO_RESULTS`. Neither is a gap.
 * - **Not attempted**: `DISABLED_BY_POLICY`, `NOT_CONFIGURED`. Nothing was asked, so nothing
 *   failed — and neither is evidence about the engine.
 * - **Failed**: everything else. A real attempt that did not produce an answer.
 */
export type EngineOutcome =
  /** The engine answered and returned at least one candidate. */
  | 'RETURNED_RESULTS'
  /** The engine answered and had nothing. A working engine, not a gap. */
  | 'ZERO_RESULTS'
  /** The attempt exceeded its bound. */
  | 'TIMEOUT'
  /** 429, or the instance's own cooldown. */
  | 'RATE_LIMITED'
  /** The upstream served a challenge. Never solved, never worked around. */
  | 'CAPTCHA'
  /** 403, or the upstream otherwise refusing us. */
  | 'ACCESS_DENIED'
  /** The instance could not reach the upstream at all. */
  | 'CONNECTION_ERROR'
  /** Not attempted: this tenant does not have the engine switched on. Carries the decision id. */
  | 'DISABLED_BY_POLICY'
  /** Not attempted: this process holds no SearXNG instance to ask. */
  | 'NOT_CONFIGURED'
  /** Our fault — an unparsable body, an unexpected shape, a defect. Never the engine's. */
  | 'INTERNAL_ERROR';

/** Did this outcome mean the engine answered? `ZERO_RESULTS` counts: it answered, with nothing. */
export function engineAnswered(outcome: EngineOutcome): boolean {
  return outcome === 'RETURNED_RESULTS' || outcome === 'ZERO_RESULTS';
}

/** Was the engine asked at all? The two not-attempted states are not failures. */
export function engineAttempted(outcome: EngineOutcome): boolean {
  return outcome !== 'DISABLED_BY_POLICY' && outcome !== 'NOT_CONFIGURED';
}

/** Did a real attempt fail? Neither a zero result nor a policy skip is a failure. */
export function engineFailed(outcome: EngineOutcome): boolean {
  return engineAttempted(outcome) && !engineAnswered(outcome);
}

/** One engine's outcome on one planned query. */
export interface EngineAttempt {
  readonly jobId: string;
  readonly engine: DiscoveryEngine;
  /** False for `DISABLED_BY_POLICY` and `NOT_CONFIGURED`. Nothing was put on the wire. */
  readonly attempted: boolean;
  readonly outcome: EngineOutcome;
  /** Wall time for this engine's own request. Zero when nothing was attempted. */
  readonly durationMs: number;
  /** Candidates this engine returned, before any deduplication. */
  readonly resultsReturned: number;
  /**
   * Canonical URLs this engine contributed, for the run's unique-contribution count.
   *
   * The URLs rather than a count, because "unique" is only decidable across the whole run: an
   * engine that returned the same article another engine also returned contributed it, and
   * whether that was the *only* engine to do so cannot be known until every engine has reported.
   */
  readonly canonicalUrls: readonly string[];
  /**
   * Why, when something went wrong, or which decision disabled it.
   *
   * The instance's own sentence for a failure (`Suspended: CAPTCHA`), or the decision id for a
   * policy skip (`D20`). Null when the engine simply answered. Never a credential, never a URL.
   */
  readonly failureReason: string | null;
}

/** What one engine did across a whole run. */
export interface EngineStat {
  readonly engine: DiscoveryEngine;
  /** The engine's own name on the instance, so a report can be matched against `/config`. */
  readonly searxngEngineName: string;
  readonly attempted: boolean;
  /**
   * The run-level outcome for this engine.
   *
   * The **worst** outcome it had across the run's queries, not the last: an engine that answered
   * nine queries and was rate-limited on the tenth is `RATE_LIMITED` for the run, because that is
   * the fact a reader needs. Its successful results are kept regardless — see `resultsReturned`.
   */
  readonly outcome: EngineOutcome;
  readonly queriesAttempted: number;
  /** Queries on which it returned at least one result. */
  readonly queriesReturnedResults: number;
  readonly queriesFailed: number;
  /** Total wall time across this engine's requests. */
  readonly durationMs: number;
  /** Results it returned, counted per engine — one article found by three engines counts thrice. */
  readonly resultsReturned: number;
  /**
   * Canonical URLs **only this engine** contributed to the run.
   *
   * The number that answers "was this engine worth querying?", which `resultsReturned` does not:
   * an engine that returned forty articles every other engine also returned added nothing.
   */
  readonly uniqueResultsContributed: number;
  /**
   * Distinct explanatory sentences, deduplicated and sorted.
   *
   * For a failure, the instance's own words. For a `DISABLED_BY_POLICY` row, the decision id that
   * disabled the engine — which is why this is not filtered to failures only: "zero results" with
   * no reason beside it is exactly the silence a per-engine table exists to remove.
   */
  readonly failureReasons: readonly string[];
  /** The governance reading at the time of the run, carried for the report. */
  readonly governanceStatus: string;
  readonly decisionId: string;
  /**
   * **LOCAL DIAGNOSTIC ONLY.** Present, and true, only when this engine ran because of the local
   * Google diagnostic. `governanceStatus` above still carries the unchanged reading.
   */
  readonly diagnosticOverride?: boolean;
  readonly diagnosticOnly?: boolean;
  readonly effectiveEnabled?: boolean;
}

/**
 * The source-level outcome, derived from the engine rows.
 *
 * `COMPLETED` covers both "every engine answered with results" and "every engine answered with
 * nothing": a zero result is a working source reporting a fact, and calling it a failure would
 * be the false-outage this whole vocabulary exists to prevent.
 */
export type SearxngSourceOutcome = 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'REFUSED';

/**
 * Derive the source outcome from what the engines did.
 *
 * The rules, in order, and each one is a claim about what the run may honestly say:
 *
 * 1. **Nothing was attempted** → `REFUSED`. Every engine was disabled or unconfigured, so the
 *    source was never asked anything. Not `FAILED`: nothing failed.
 * 2. **Every attempt failed** → `FAILED`. A real coverage gap.
 * 3. **Some attempts failed** → `PARTIAL`. Results from the engines that worked are kept, and
 *    the gap is stated. This is the case §14 is about, and the one a naive implementation gets
 *    wrong by discarding the successes.
 * 4. **Everything that was attempted answered** → `COMPLETED`, whether or not it found anything.
 */
export function deriveSourceOutcome(
  stats: readonly Pick<EngineStat, 'attempted' | 'outcome'>[],
): SearxngSourceOutcome {
  const attempted = stats.filter((stat) => stat.attempted);
  if (attempted.length === 0) {
    return 'REFUSED';
  }
  const failed = attempted.filter((stat) => engineFailed(stat.outcome));
  if (failed.length === 0) {
    return 'COMPLETED';
  }
  return failed.length === attempted.length ? 'FAILED' : 'PARTIAL';
}

/**
 * Everything a run can say about its metasearch discovery.
 *
 * The counts §15 asks for, plus the per-engine rows. Two pairs are worth reading together:
 * `totalRawResults` against `uniqueCandidateUrls` says how much of the multi-engine yield was the
 * same story, and `duplicatesCollapsed` states the same fact the other way round so nobody has to
 * subtract.
 */
export interface SearxngDiscoverySummary {
  readonly sourceOutcome: SearxngSourceOutcome;
  /** Engines the connector integrates. Never filtered — a missing engine is a missing answer. */
  readonly enginesConfigured: number;
  /** Of those, the ones this tenant has switched on. */
  readonly enginesPermitted: number;
  /** Of those, the ones a request was actually made for. */
  readonly enginesAttempted: number;
  readonly enginesReturnedResults: number;
  readonly enginesFailed: number;
  readonly perEngine: readonly EngineStat[];
  readonly queriesIssued: number;
  /** Candidates across every query and engine, before deduplication. */
  readonly totalRawResults: number;
  /** Distinct canonical URLs. This is the candidate count. */
  readonly uniqueCandidateUrls: number;
  /** `totalRawResults - uniqueCandidateUrls`. The multi-engine overlap, stated. */
  readonly duplicatesCollapsed: number;
  /**
   * Articles the pipeline actually fetched from their original publishers, and findings made.
   *
   * Filled in by `SearchPipeline` rather than by the connector, which cannot know either: the
   * connector produces leads and stops. Null when the run did not reach that stage.
   */
  readonly articlesFetched: number | null;
  readonly findingsGenerated: number | null;
}

/** One engine's contribution to one query, as the connector reports it. */
export interface RecordedEngineResult {
  readonly engine: DiscoveryEngine;
  readonly searxngEngineName: string;
  readonly attempted: boolean;
  readonly outcome: EngineOutcome;
  readonly durationMs: number;
  readonly resultsReturned: number;
  readonly canonicalUrls: readonly string[];
  readonly failureReason: string | null;
  readonly governanceStatus: string;
  readonly decisionId: string;
  /** True only when this engine ran because of the local diagnostic. */
  readonly diagnosticOverride?: boolean;
}

/** One engine's identity as the run saw it, kept so the summary can report it without re-reading. */
interface EngineMeta {
  readonly searxngEngineName: string;
  readonly governanceStatus: string;
  readonly decisionId: string;
  readonly diagnosticOverride: boolean;
}

/** What a run knows that its individual attempts do not: the query count and the engine set. */
interface RunFacts {
  readonly meta: Map<DiscoveryEngine, EngineMeta>;
  queriesIssued: number;
  permitted: Set<DiscoveryEngine>;
  configured: Set<DiscoveryEngine>;
  articlesFetched: number | null;
  findingsGenerated: number | null;
}

@Injectable()
export class SearxngEngineLog {
  private readonly logger = new Logger('SearxngEngines');
  private readonly byJob = new Map<string, EngineAttempt[]>();
  /** Per job: the engine metadata and the query count, which the attempts alone cannot give. */
  private readonly runFacts = new Map<string, RunFacts>();
  private readonly truncated = new Set<string>();

  /**
   * Record what one planned query produced, across every configured engine.
   *
   * Never throws and never blocks the query it describes: a diagnostic that can fail a search is
   * worse than no diagnostic.
   */
  recordQuery(input: {
    readonly jobId: string;
    readonly results: readonly RecordedEngineResult[];
  }): void {
    const facts = this.factsFor(input.jobId);
    facts.queriesIssued += 1;

    const attempts: EngineAttempt[] = [];
    for (const result of input.results) {
      facts.meta.set(result.engine, {
        searxngEngineName: result.searxngEngineName,
        governanceStatus: result.governanceStatus,
        decisionId: result.decisionId,
        // Sticky across the run's queries: once the diagnostic ran an engine, the row says so.
        diagnosticOverride:
          result.diagnosticOverride === true ||
          (facts.meta.get(result.engine)?.diagnosticOverride ?? false),
      });
      facts.configured.add(result.engine);
      if (result.outcome !== 'DISABLED_BY_POLICY') {
        facts.permitted.add(result.engine);
      }
      attempts.push({
        jobId: input.jobId,
        engine: result.engine,
        attempted: result.attempted,
        outcome: result.outcome,
        durationMs: result.durationMs,
        resultsReturned: result.resultsReturned,
        canonicalUrls: result.canonicalUrls,
        failureReason: result.failureReason,
      });
    }

    const bucket = this.byJob.get(input.jobId);
    if (bucket === undefined) {
      this.byJob.set(input.jobId, attempts);
      return;
    }
    if (bucket.length >= MAX_ENTRIES_PER_JOB) {
      if (!this.truncated.has(input.jobId)) {
        this.truncated.add(input.jobId);
        this.logger.warn(
          `${input.jobId} recorded more than ${String(MAX_ENTRIES_PER_JOB)} engine attempts. ` +
            `The diagnostic is truncated for this run; the run itself is unaffected. A bounded ` +
            `plan cannot reach this, so it means something is looping.`,
        );
      }
      return;
    }
    bucket.push(...attempts);
  }

  /**
   * Record what the pipeline did with the candidates, once it knows.
   *
   * Separate from `recordQuery` because the connector cannot know either number: it produces
   * leads and stops, and whether a lead became a fetched article or a finding is decided several
   * stages later.
   */
  recordPipelineTotals(input: {
    readonly jobId: string;
    readonly articlesFetched: number;
    readonly findingsGenerated: number;
  }): void {
    const facts = this.runFacts.get(input.jobId);
    if (facts === undefined) {
      // No metasearch discovery ran for this job, so there is nothing to attach the totals to.
      // Creating an entry here would produce a summary for a run that never queried an engine.
      return;
    }
    facts.articlesFetched = input.articlesFetched;
    facts.findingsGenerated = input.findingsGenerated;
  }

  /**
   * This run's engine diagnostics, or null when the run recorded nothing.
   *
   * Null rather than a zero-filled summary. A run in which the connector never got as far as a
   * query — the ladder not built, the source not approved — has nothing to say about engines, and
   * reporting zeros would read as "every engine was asked and none answered".
   */
  summaryFor(jobId: string): SearxngDiscoverySummary | null {
    const facts = this.runFacts.get(jobId);
    if (facts === undefined) {
      return null;
    }
    const attempts = this.byJob.get(jobId) ?? [];

    // Which engines contributed which URLs, so "unique contribution" can be decided across the
    // whole run rather than per query.
    const enginesByUrl = new Map<string, Set<DiscoveryEngine>>();
    for (const attempt of attempts) {
      for (const url of attempt.canonicalUrls) {
        const set = enginesByUrl.get(url) ?? new Set<DiscoveryEngine>();
        set.add(attempt.engine);
        enginesByUrl.set(url, set);
      }
    }

    const byEngine = new Map<DiscoveryEngine, EngineAttempt[]>();
    for (const attempt of attempts) {
      const bucket = byEngine.get(attempt.engine);
      if (bucket === undefined) {
        byEngine.set(attempt.engine, [attempt]);
      } else {
        bucket.push(attempt);
      }
    }

    const perEngine: EngineStat[] = [];
    for (const [engine, meta] of [...facts.meta.entries()].toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const entries = byEngine.get(engine) ?? [];
      const failures = entries.filter((entry) => engineFailed(entry.outcome));
      const urls = new Set(entries.flatMap((entry) => entry.canonicalUrls));
      const uniqueContributed = [...urls].filter(
        (url) => (enginesByUrl.get(url)?.size ?? 0) === 1,
      ).length;

      perEngine.push({
        engine,
        searxngEngineName: meta.searxngEngineName,
        attempted: entries.some((entry) => entry.attempted),
        outcome: worstOutcome(entries.map((entry) => entry.outcome)),
        queriesAttempted: entries.filter((entry) => entry.attempted).length,
        queriesReturnedResults: entries.filter((entry) => entry.outcome === 'RETURNED_RESULTS')
          .length,
        queriesFailed: failures.length,
        durationMs: entries.reduce((total, entry) => total + entry.durationMs, 0),
        resultsReturned: entries.reduce((total, entry) => total + entry.resultsReturned, 0),
        uniqueResultsContributed: uniqueContributed,
        // Collected from **every** entry carrying a reason, not only the failures. A
        // `DISABLED_BY_POLICY` row's reason names the decision that disabled it, and that is the
        // single most useful sentence in the whole table — dropping it because "disabled is not
        // a failure" would leave the row saying zero with no explanation, which is the silence
        // this design exists to remove.
        failureReasons: [
          ...new Set(
            entries
              .map((entry) => entry.failureReason)
              .filter((reason): reason is string => reason !== null),
          ),
        ].toSorted(),
        governanceStatus: meta.governanceStatus,
        decisionId: meta.decisionId,
        // Only on a diagnostic row, so every normal run's table is byte-for-byte what it was.
        ...(meta.diagnosticOverride
          ? { diagnosticOverride: true, diagnosticOnly: true, effectiveEnabled: true }
          : {}),
      });
    }

    const totalRawResults = attempts.reduce((total, entry) => total + entry.resultsReturned, 0);
    const uniqueCandidateUrls = enginesByUrl.size;

    return {
      sourceOutcome: deriveSourceOutcome(perEngine),
      enginesConfigured: facts.configured.size,
      enginesPermitted: facts.permitted.size,
      enginesAttempted: perEngine.filter((stat) => stat.attempted).length,
      enginesReturnedResults: perEngine.filter((stat) => stat.resultsReturned > 0).length,
      enginesFailed: perEngine.filter((stat) => engineFailed(stat.outcome)).length,
      perEngine,
      queriesIssued: facts.queriesIssued,
      totalRawResults,
      uniqueCandidateUrls,
      // Never negative: `totalRawResults` counts every engine's contribution and the unique set
      // is a subset of those. Clamped anyway, because a negative count in a diagnostic is the
      // kind of thing a reader stops trusting the rest of the page over.
      duplicatesCollapsed: Math.max(0, totalRawResults - uniqueCandidateUrls),
      articlesFetched: facts.articlesFetched,
      findingsGenerated: facts.findingsGenerated,
    };
  }

  /** Drop a run's entries once its summary has been read. */
  forget(jobId: string): void {
    this.byJob.delete(jobId);
    this.runFacts.delete(jobId);
    this.truncated.delete(jobId);
  }

  private factsFor(jobId: string): RunFacts {
    const existing = this.runFacts.get(jobId);
    if (existing !== undefined) {
      return existing;
    }
    while (this.runFacts.size >= MAX_JOBS) {
      const oldest = this.runFacts.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.forget(oldest.value);
    }
    const facts: RunFacts = {
      meta: new Map(),
      queriesIssued: 0,
      permitted: new Set(),
      configured: new Set(),
      articlesFetched: null,
      findingsGenerated: null,
    };
    this.runFacts.set(jobId, facts);
    return facts;
  }
}

/**
 * The run-level outcome for an engine that had several per-query outcomes.
 *
 * The **worst**, by the order below, and not the last. An engine that answered nine queries and
 * was rate-limited on the tenth is `RATE_LIMITED` for the run: that is the fact that changes what
 * a reader should do, and reporting the last outcome would hide it behind whichever query
 * happened to run last. Its nine queries' results are unaffected — the outcome describes the
 * engine's reliability, not what was kept.
 */
const OUTCOME_SEVERITY: readonly EngineOutcome[] = [
  // Least severe first.
  //
  // `ZERO_RESULTS` ranks BELOW `RETURNED_RESULTS`, so an engine that answered some queries with
  // hits and others with nothing reports `RETURNED_RESULTS`. Both are "answered" and neither is
  // a failure, so between the two the question is not which is worse but which is true of the
  // engine: it demonstrably returned results. Ranking them the other way round made Reuters
  // report `ZERO_RESULTS` for a run in which it returned 49 results across 5 of 12 queries,
  // which reads as "this engine found nothing" and is the opposite of what happened.
  //
  // Every genuine failure still outranks both, so the property this ordering exists for is
  // unchanged: an engine that answered nine queries and was rate-limited on the tenth is still
  // `RATE_LIMITED` for the run.
  'ZERO_RESULTS',
  'RETURNED_RESULTS',
  'DISABLED_BY_POLICY',
  'NOT_CONFIGURED',
  'TIMEOUT',
  'CONNECTION_ERROR',
  'RATE_LIMITED',
  'ACCESS_DENIED',
  'CAPTCHA',
  'INTERNAL_ERROR',
];

export function worstOutcome(outcomes: readonly EngineOutcome[]): EngineOutcome {
  let worst: EngineOutcome = 'ZERO_RESULTS';
  let rank = -1;
  for (const outcome of outcomes) {
    const index = OUTCOME_SEVERITY.indexOf(outcome);
    if (index > rank) {
      rank = index;
      worst = outcome;
    }
  }
  return worst;
}

/**
 * SearXNG's failure sentence, reduced to one of our outcomes.
 *
 * Matched on substrings of the instance's own wording. The sentence is carried alongside, so a
 * reason this does not recognise becomes `INTERNAL_ERROR` **and stays readable** rather than
 * being lost. That ordering is deliberate: this classification can be wrong without costing
 * anything, which is why nothing in the pipeline is allowed to read it.
 *
 * `CAPTCHA` is checked before `SUSPENDED` on purpose. SearXNG reports a suspended Google as
 * `Suspended: CAPTCHA`, and of the two facts the challenge is the one that tells an operator what
 * happened and that we must not try to get around it.
 */
export function classifyEngineFailure(reason: string): EngineOutcome {
  const folded = reason.toLowerCase();
  if (folded.includes('captcha')) {
    return 'CAPTCHA';
  }
  if (folded.includes('too many requests') || folded.includes('429')) {
    return 'RATE_LIMITED';
  }
  if (folded.includes('403') || folded.includes('forbidden') || folded.includes('access denied')) {
    return 'ACCESS_DENIED';
  }
  if (folded.includes('timeout') || folded.includes('timed out')) {
    return 'TIMEOUT';
  }
  if (folded.includes('suspended')) {
    // A suspension with no stated cause. SearXNG's own breaker has stopped calling the engine,
    // which from our side behaves as a rate limit: try later, do not hammer it.
    return 'RATE_LIMITED';
  }
  if (
    folded.includes('connection') ||
    folded.includes('ssl') ||
    folded.includes('proxy') ||
    folded.includes('unreachable') ||
    // SearXNG's bare "HTTP error" for an upstream that answered with something unusable. It
    // carries no status, so the specific classes above cannot apply — but it is emphatically the
    // upstream's failure and not ours, and `INTERNAL_ERROR` would put our name on it. Seen live
    // from the `reuters` engine on 2026-09-22.
    folded === 'http error' ||
    folded.startsWith('http error')
  ) {
    return 'CONNECTION_ERROR';
  }
  return 'INTERNAL_ERROR';
}
