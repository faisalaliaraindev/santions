/**
 * `SearxngDiscoveryAdapter` — rung 5, the multi-engine adverse-media discovery layer.
 *
 * # What it is, in one sentence
 *
 * It asks a metasearch instance we run for news about a planned query, **once per engine**, over
 * the engines the tenant has switched on, and turns what comes back into **leads** — which is all
 * discovery is ever allowed to produce.
 *
 * # Why one request per engine rather than one request naming them all
 *
 * SearXNG will merge engines for you: one request naming six engines returns one merged result
 * list and an `unresponsive_engines` array. That is less code and it is the wrong shape here, for
 * three reasons that all come down to *observability of the individual engine*:
 *
 * - **Per-engine timing is unobtainable from a merged response.** `durationMs` per engine is a
 *   requirement, and a merged request can only report how long the slowest engine took.
 * - **A merged request fails as a unit.** If the instance times out waiting for its slowest
 *   engine, the whole request times out and the engines that had already answered are lost. Six
 *   requests lose only the engine that failed.
 * - **`unresponsive_engines` is not a complete account.** An engine that returns nothing is
 *   absent from both the results and the unresponsive list, so `ZERO_RESULTS` and "never ran"
 *   are indistinguishable — and those are exactly the two a coverage statement must not confuse.
 *
 * **It costs the upstream engines nothing.** This is the part worth being clear about: a merged
 * request forwards the query to all six engines anyway. Six separate requests send each engine
 * the same one query it would have received. What multiplies is traffic to **our own loopback
 * instance**, which is free. The publishers see identical volume either way.
 *
 * The requests run concurrently and are bounded by `maxConcurrentEngines`, so one slow engine
 * delays the query by its own timeout rather than by the sum of six.
 *
 * # Every configured engine produces a row. There are no silent absences.
 *
 * An engine the tenant has switched off is `DISABLED_BY_POLICY` carrying the decision id, and it
 * is in the per-engine table exactly like the others. A reviewer asking "what happened to
 * Google?" gets an answer rather than silence, and the next engineer does not conclude Google was
 * never built.
 *
 * # The three things a reader must not confuse
 *
 * A result here is a **discovery service**, a **discovery channel** and a **publisher**:
 *
 * - the service is `searxng-adverse-media`, ours, and it is never the evidence publisher;
 * - the engines are channels. Four engines returning one Reuters article is **one** article, not
 *   four confirmations — which is why they are a list on one lead rather than four leads;
 * - the publisher is whoever wrote the article, and it is the only one of the three that can ever
 *   support a finding, after the document has been fetched through `FetchGateService` and read.
 *
 * This adapter produces none of the third. `Lead` carries no category, stage or party role, so it
 * cannot classify even by accident.
 *
 * # It cannot become a way past source governance
 *
 * Every query runs `FetchGateService.authoriseInternalDiscoveryService` first — an ACTIVE
 * approved version through four-eyes, licence terms and the licence clock, the run's pinned
 * jurisdiction and language scope, the pinned taxonomy's effective scope, an attributable egress
 * identity. What that method drops (the SEC-02 address policy, robots, first-contact approval) it
 * drops because all three are controls about a **publisher** and this hop is to a service we run;
 * its own header argues that at length.
 *
 * And the engine set comes from `EngineEnablementPort`, per tenant. There is no path that reads
 * the instance's own enabled list and treats it as permission.
 *
 * # Why the request names engines and never names a category
 *
 * The audit found SearXNG treats `engines` and `categories` as a **union**: a request naming one
 * engine and the news category runs every engine in the news category. Sending `categories=news`
 * would make the engine list decorative — the parameter meant to bound the request would widen it
 * past the matrix. So the connector names one engine and no category.
 * `docs/sources/evidence/searxng-adverse-media.json` has the two requests that establish it.
 *
 * # It does not fight the upstream
 *
 * SearXNG's own handling of engine suspension, 403s, CAPTCHAs, 429 cooldowns and timeouts is left
 * exactly as it is. There is no retry loop here, no proxy, no challenge solving. A blocked engine
 * is recorded as blocked and the run continues without it.
 */

import { Logger } from '@nestjs/common';

import { canonicalise, screenUrl, type CountryCode } from '@erly/adverse-domain';

import { endpointDigest, hostOf, type DiscoveryRequestLog } from '../discovery-request-log.js';
import { leadsFrom, type RawCandidate } from '../discovery/lead-mapping.js';
import type { FetchGateService } from '../fetch-gate.service.js';
import type { CascadeRung, DiscoveryQuery, Lead } from '../lead.js';
import type { ContractProbeResult, NewsDiscoveryPort } from '../news-discovery.port.js';
import {
  bounded,
  failed,
  noResults,
  ok,
  stampProvenance,
  type AdapterDescriptor,
  type Clock,
  type SourceOutcome,
} from '../source-adapter.js';
import type { ActiveSourceVersion, SourceVersionReader } from '../source-version.service.js';

import type { EngineEnablementPort, ResolvedEngine } from './engine-enablement.service.js';
import {
  classifyEngineFailure,
  deriveSourceOutcome,
  engineFailed,
  type EngineOutcome,
  type RecordedEngineResult,
  type SearxngEngineLog,
} from './engine-health.js';
import type { DiscoveryEngine } from './engine-governance.js';
import {
  applyLocalDiagnostic,
  processPermitsLocalDiagnostic,
  type LocalDiagnosticPolicy,
} from './local-diagnostic.js';
import { parseSearxngResponse, type SearxngClient, type SearxngResult } from './searxng-client.js';

/** Bumped whenever the parse changes (FR-05 volatility control). */
export const SEARXNG_PARSER_VERSION = 'searxng-json-2';

/**
 * The bounds on what one search may cost.
 *
 * Conservative on purpose, and the reasoning is `gdelt-doc-v2`'s: a bound nobody reaches is a
 * bound nobody has tested, and a fan-out that stops visibly inside one run is better than one
 * that stops at an unpredictable point in the next.
 *
 * `maxQueriesPerSearch` is the load-bearing one. A live plan for one subject in one language is
 * around 53 planned queries, and the cascade offers every one to every source on the ladder.
 * Twelve means a search issues at most twelve metasearch queries — and therefore at most twelve
 * queries to each upstream engine — and records the rest as a bounded truncation, visible in the
 * coverage statement rather than a silent fan-out on every search this service ever runs.
 */
export interface SearxngLimits {
  /** Planned queries this connector serves in one run, across the whole plan. */
  readonly maxQueriesPerSearch: number;
  /** Result pages fetched per engine per planned query. */
  readonly maxPagesPerQuery: number;
  /** Candidates kept from one planned query, after merging engines. */
  readonly maxCandidatesPerQuery: number;
  /** Candidates kept across the whole run. */
  readonly maxTotalCandidates: number;
  /** The bound on one engine's request. */
  readonly timeoutMs: number;
  /**
   * How many engines are queried at once.
   *
   * The whole matrix, so one planned query costs one round of parallel requests rather than six
   * sequential ones. Bounded rather than unbounded so that adding engines later does not silently
   * become an unbounded fan-out against our own instance.
   */
  readonly maxConcurrentEngines: number;
}

export const DEFAULT_SEARXNG_LIMITS: SearxngLimits = {
  maxQueriesPerSearch: 12,
  // One page. A second page of a news metasearch is where relevance has already fallen away, and
  // it doubles the traffic every upstream engine sees for the least valuable results in the run.
  maxPagesPerQuery: 1,
  maxCandidatesPerQuery: 40,
  maxTotalCandidates: 250,
  // Well above the instance's own 3-second per-engine timeout, because the instance waits for the
  // engine and then formats. A bound below that would time out on our own aggregation rather than
  // on anything being wrong upstream.
  timeoutMs: 15_000,
  maxConcurrentEngines: 6,
};

export interface SearxngDiscoveryOptions {
  readonly sourceId: string;
  readonly versions: SourceVersionReader;
  readonly gate: FetchGateService;
  /**
   * The client, or null when this process holds no validated base URL.
   *
   * Null rather than a client pointed at a guess. Every engine then reports `NOT_CONFIGURED`,
   * which is a different fact from an engine that was asked and failed.
   */
  readonly client: SearxngClient | null;
  /** Per-tenant engine switches. The connector never reads the matrix defaults directly. */
  readonly enablement: EngineEnablementPort;
  readonly engineLog: SearxngEngineLog;
  readonly requestLog?: DiscoveryRequestLog | undefined;
  readonly clock?: Clock | undefined;
  readonly limits?: SearxngLimits | undefined;
  /**
   * **LOCAL DIAGNOSTIC ONLY.** This process's half of the local Google diagnostic conditions.
   * Absent means no run is ever granted an engine beyond its tenant's resolved set.
   */
  readonly localDiagnostic?: LocalDiagnosticPolicy | undefined;
}

/** A resolved engine as this run uses it: possibly widened by the local diagnostic, never stored. */
type RunEngine = ResolvedEngine & { readonly diagnosticOverride?: boolean };

/** What one run has spent so far. Bounded and evicted on the same rule as the logs. */
interface RunBudget {
  queriesIssued: number;
  candidates: number;
}

const MAX_TRACKED_RUNS = 64;

export class SearxngDiscoveryAdapter implements NewsDiscoveryPort {
  private readonly logger = new Logger('SearxngDiscovery');
  private readonly clock: Clock;
  private readonly limits: SearxngLimits;
  /**
   * Per-run spend, so `maxQueriesPerSearch` and `maxTotalCandidates` mean something.
   *
   * The cascade calls `discover` once per planned query, so a bound on "one search" cannot live
   * in a single call. Insertion-ordered and evicted oldest-first: a run that dies mid-plan leaves
   * an entry, and the eviction is what stops that being a leak rather than something to rely on.
   */
  private readonly budgets = new Map<string, RunBudget>();

  readonly descriptor: AdapterDescriptor;

  constructor(private readonly options: SearxngDiscoveryOptions) {
    this.clock = options.clock ?? ((): Date => new Date());
    this.limits = options.limits ?? DEFAULT_SEARXNG_LIMITS;
    this.descriptor = {
      adapterId: 'searxng-discovery',
      portKind: 'NEWS_DISCOVERY',
      sourceId: options.sourceId,
      parserVersion: SEARXNG_PARSER_VERSION,
      // SearXNG documents its JSON interface and versions its releases, and this is still
      // `UNDOCUMENTED_VOLATILE` — because the shape that breaks is not the envelope but what a
      // scraping engine puts inside it, which nobody versions. Claiming DOCUMENTED_STABLE would
      // exempt this from the scheduled contract test that is the only thing standing between a
      // silent shape change and confident clean results (T84).
      stabilityClass: 'UNDOCUMENTED_VOLATILE',
      mode: 'LIVE',
      jurisdictions: [],
    };
  }

  /** A metasearch instance is global rather than per-edition, so it addresses no edition list. */
  get editions(): readonly CountryCode[] {
    return [];
  }

  async discover(query: DiscoveryQuery): Promise<SourceOutcome<readonly Lead[]>> {
    const now = this.clock();
    const version = await this.options.versions.loadActive(this.options.sourceId);
    if (version === null) {
      return failed(
        this.descriptor,
        now,
        { policyRefusal: true },
        `Source ${this.options.sourceId} has no active approved version, so there is nothing ` +
          `authorising a query to it.`,
      );
    }

    const descriptor = this.descriptorFor(version);
    const language = query.language ?? version.languages[0] ?? null;
    const jurisdiction = query.country ?? version.countries[0] ?? null;
    if (language === null || jurisdiction === null) {
      return failed(
        descriptor,
        now,
        { policyRefusal: true },
        `${version.sourceName} declares no ${language === null ? 'language' : 'country'}, so a ` +
          `query to it could not be attributed. Neither is ever inferred (FR-03, FR-05).`,
      );
    }

    // Per tenant. The matrix defaults apply only where this tenant has expressed no preference,
    // and that resolution happens in one place rather than here.
    const engines = this.withLocalDiagnostic(
      await this.options.enablement.resolveFor(query.tenantId),
      query,
    );
    const permitted = engines.filter((engine) => engine.effectiveEnabled);

    const decision = await this.options.gate.authoriseInternalDiscoveryService({
      sourceId: this.options.sourceId,
      jurisdiction,
      language,
      runJurisdictions: query.run.jurisdictions,
      runLanguages: query.run.languages,
      taxonomy: query.run.taxonomy,
      serviceConfigured: this.options.client !== null,
      permittedEngineCount: permitted.length,
      now,
    });
    if (!decision.authorised) {
      // Still recorded, engine by engine, so a coverage reader asking "why did SearXNG return
      // nothing?" gets the table rather than silence.
      this.options.engineLog.recordQuery({
        jobId: query.run.jobId,
        results: engines.map((engine) =>
          this.notAttempted(
            engine,
            this.options.client === null ? 'NOT_CONFIGURED' : 'DISABLED_BY_POLICY',
          ),
        ),
      });
      return failed(
        descriptor,
        now,
        { policyRefusal: true },
        `${decision.refusal}: ${decision.detail}`,
      );
    }

    const client = this.options.client;
    if (client === null) {
      // Unreachable: the gate refuses `serviceConfigured: false` above. Kept because the
      // narrowing has to happen somewhere, and a non-null assertion would be the version of this
      // that stops being true when somebody edits the gate.
      return failed(
        descriptor,
        now,
        { policyRefusal: true },
        'No SearXNG client is configured in this process.',
      );
    }

    const budget = this.budgetFor(query.run.jobId);
    if (budget.queriesIssued >= this.limits.maxQueriesPerSearch) {
      // A bound, not a failure. The connector has served its share of this run's plan, and the
      // remaining planned queries are recorded as truncated rather than silently unserved.
      return bounded(descriptor, now, [], {
        reason: 'BOUND_EXCEEDED',
        limit: this.limits.maxQueriesPerSearch,
        availableCount: null,
      });
    }
    if (budget.candidates >= this.limits.maxTotalCandidates) {
      return bounded(descriptor, now, [], {
        reason: 'BOUND_EXCEEDED',
        limit: this.limits.maxTotalCandidates,
        availableCount: null,
      });
    }
    budget.queriesIssued += 1;

    // ---- Query every permitted engine, independently ----------------------------------------
    //
    // `Promise.all` over per-engine tasks that never reject: each catches its own failure and
    // returns an outcome row. A rejection here would take the whole query down with one engine,
    // which is the exact thing this file is built to prevent.
    const withheld = engines.filter((engine) => !engine.effectiveEnabled);
    const attempted = await this.runBounded(
      permitted.map(
        (engine) => (): Promise<EngineRun> =>
          this.queryEngine({ engine, client, query, language, version }),
      ),
      this.limits.maxConcurrentEngines,
    );

    const results: RecordedEngineResult[] = [
      ...withheld.map((engine) => this.notAttempted(engine, 'DISABLED_BY_POLICY')),
      ...attempted.map((run) => run.record),
    ];
    this.options.engineLog.recordQuery({ jobId: query.run.jobId, results });

    // ---- Merge what came back ----------------------------------------------------------------
    const merged = new Map<string, MergedCandidate>();
    let rawCandidates = 0;
    for (const run of attempted) {
      rawCandidates += run.record.resultsReturned;
      for (const entry of run.entries) {
        this.mergeResult(merged, entry, run.engine.engine);
      }
    }

    const candidates = [...merged.values()].slice(0, this.limits.maxCandidatesPerQuery);
    budget.candidates += candidates.length;

    const sourceOutcome = deriveSourceOutcome(
      results.map((result) => ({ attempted: result.attempted, outcome: result.outcome })),
    );

    // Every attempted engine failed and nothing was salvaged. A genuine coverage gap for this
    // source — and note what it is not: if ANY engine returned something, the failures below are
    // recorded as diagnostics and the results are kept.
    if (sourceOutcome === 'FAILED' && merged.size === 0) {
      const reasons = results
        .filter((result) => engineFailed(result.outcome))
        .map((result) => `${result.engine}=${result.outcome}`)
        .join(', ');
      return failed(
        descriptor,
        now,
        this.signalFor(results),
        `Every permitted engine failed on this query: ${reasons}. No candidate was retained.`,
      );
    }

    const leads = leadsFrom({
      candidates: candidates.map((candidate) => candidate.raw),
      fallbackLanguage: language,
      // Overridden per lead below. A metasearch instance is not the publisher of anything it
      // returns; this parameter exists for feeds where the source IS the publisher.
      publisherName: version.sourceName,
      rung: rungOf(version.cascadeRung),
      queryId: query.queryId,
      provenance: stampProvenance(descriptor, now),
      // No local match filter. Each engine was asked the question, so re-filtering its answer on
      // our own string match would discard what it judged relevant — and `matchesQuery` requires
      // every quoted phrase, which is right for a publisher's whole list and wrong for a ranked
      // search result.
    }).map((lead) => this.attributePublisher(lead));

    if (leads.length === 0) {
      // The engines answered and between them had nothing. A real, honest empty answer — and
      // `deriveSourceOutcome` has already recorded whether any of them failed getting there.
      return noResults(descriptor, now);
    }
    if (leads.length > query.limit) {
      return bounded(descriptor, now, leads.slice(0, query.limit), {
        reason: 'SOURCE_PAGE_LIMIT',
        limit: query.limit,
        availableCount: leads.length,
      });
    }
    if (rawCandidates > this.limits.maxCandidatesPerQuery) {
      return bounded(descriptor, now, leads, {
        reason: 'BOUND_EXCEEDED',
        limit: this.limits.maxCandidatesPerQuery,
        availableCount: rawCandidates,
      });
    }
    return ok(descriptor, now, leads);
  }

  /**
   * The tenant's resolved engines, widened for this run only by a granted local diagnostic.
   *
   * The run carries what the API granted; this process re-checks its own environment
   * (non-production, the flag, the named tenant) before honouring it, so a run record replayed
   * into a process without the flag runs as a normal search. Nothing here is written anywhere.
   */
  private withLocalDiagnostic(
    resolved: readonly ResolvedEngine[],
    query: DiscoveryQuery,
  ): readonly RunEngine[] {
    const requested = query.run.diagnosticEngines ?? [];
    if (requested.length === 0) {
      return resolved;
    }
    const policy = this.options.localDiagnostic;
    if (policy === undefined || !processPermitsLocalDiagnostic(policy, query.tenantId)) {
      this.logger.warn(
        `Run ${query.run.jobId} carries a local discovery diagnostic this process does not ` +
          `permit; it runs with the tenant's resolved engines only.`,
      );
      return resolved;
    }
    return applyLocalDiagnostic(resolved, requested);
  }

  /**
   * One engine, one planned query, bounded — and it never throws.
   *
   * Everything that can go wrong becomes an outcome row. That is the contract the concurrency
   * above depends on: a task that rejected would abort `Promise.all` and lose the engines that
   * had already answered, which is the failure this whole design exists to prevent.
   */
  private async queryEngine(input: {
    readonly engine: RunEngine;
    readonly client: SearxngClient;
    readonly query: DiscoveryQuery;
    readonly language: string;
    readonly version: ActiveSourceVersion;
  }): Promise<EngineRun> {
    const started = Date.now();
    const entries: SearxngResult[] = [];
    let outcome: EngineOutcome = 'ZERO_RESULTS';
    let failureReason: string | null = null;

    try {
      for (let page = 1; page <= this.limits.maxPagesPerQuery; page += 1) {
        const params = {
          q: input.query.text,
          // One engine. Never a category — see the file header.
          engines: [input.engine.searxngEngineName],
          language: input.language,
          pageno: page,
          timeRange: null,
        } as const;
        const url = input.client.searchUrl(params);
        const result = await input.client.search(params, this.limits.timeoutMs);

        // Recorded after the request returns, like the GDELT connector does, and for the same
        // reason: only now is it known whether anything reached the instance.
        this.options.requestLog?.record({
          jobId: input.query.run.jobId,
          sourceId: this.options.sourceId,
          sourceName: input.version.sourceName,
          endpointKind: input.version.endpointKind,
          family: input.query.family,
          queryId: input.query.queryId,
          host: hostOf(url),
          endpointDigest: endpointDigest(url),
          issued: !(result.kind === 'FAILURE' && result.code === 'EPOLICY'),
        });

        if (result.kind === 'FAILURE') {
          outcome =
            result.code === 'ETIMEDOUT'
              ? 'TIMEOUT'
              : result.code === 'EPOLICY' || result.code === 'ELIMIT'
                ? 'INTERNAL_ERROR'
                : 'CONNECTION_ERROR';
          failureReason = result.detail;
          break;
        }
        if (result.status === 429) {
          outcome = 'RATE_LIMITED';
          failureReason = `The instance answered 429 for ${input.engine.searxngEngineName}.`;
          break;
        }
        if (result.status === 403) {
          outcome = 'ACCESS_DENIED';
          failureReason = `The instance answered 403 for ${input.engine.searxngEngineName}.`;
          break;
        }
        if (result.status !== 200) {
          outcome = 'INTERNAL_ERROR';
          failureReason = `The instance answered ${String(result.status)}.`;
          break;
        }

        const parsed = parseSearxngResponse(result.body);
        if (parsed.kind !== 'OK') {
          // Never a zero result. A shape change that reads as "no news" is invisible and would
          // read that way for every subject searched afterwards (T84).
          this.logger.warn(
            `${input.version.sourceName} / ${input.engine.engine}: ${parsed.kind} — ` +
              parsed.detail,
          );
          outcome = 'INTERNAL_ERROR';
          failureReason = parsed.detail;
          break;
        }

        // The instance's own account of what this engine did. With one engine named, any entry
        // here is about that engine.
        const unresponsive = parsed.response.unresponsiveEngines[0];
        if (unresponsive !== undefined) {
          outcome = classifyEngineFailure(unresponsive.reason);
          failureReason = unresponsive.reason;
          break;
        }

        // **Attribution is checked, not assumed.** A result credited to an engine we did not name
        // means the instance widened the request, and it must not be silently accepted as this
        // engine's work.
        for (const entry of parsed.response.results) {
          const credited = [...entry.engines, ...(entry.engine === null ? [] : [entry.engine])];
          const foreign = credited.filter(
            (name) => name.toLowerCase() !== input.engine.searxngEngineName.toLowerCase(),
          );
          if (foreign.length > 0) {
            this.logger.warn(
              `A request naming only ${input.engine.searxngEngineName} returned a result ` +
                `credited to [${foreign.join(', ')}]. The instance is widening requests; the ` +
                `result is discarded rather than attributed to an engine that did not produce it.`,
            );
            continue;
          }
          entries.push(entry);
        }

        if (parsed.response.results.length === 0) {
          // Nothing on this page, so there is no next page. Asking for one would be another
          // request to the upstream for a page the instance has said is empty.
          break;
        }
      }

      if (failureReason === null) {
        outcome = entries.length > 0 ? 'RETURNED_RESULTS' : 'ZERO_RESULTS';
      }
    } catch (error) {
      // A defect on our side, not the engine's. Recorded as ours.
      outcome = 'INTERNAL_ERROR';
      failureReason = error instanceof Error ? error.message : String(error);
      this.logger.error(`${input.engine.engine} threw: ${failureReason}`);
    }

    const canonicalUrls = [
      ...new Set(
        entries
          .map((entry) => canonicalUrlOf(entry.url))
          .filter((url): url is string => url !== null),
      ),
    ];

    return {
      engine: input.engine,
      entries,
      record: {
        engine: input.engine.engine,
        searxngEngineName: input.engine.searxngEngineName,
        attempted: true,
        outcome,
        durationMs: Date.now() - started,
        resultsReturned: entries.length,
        canonicalUrls,
        failureReason,
        governanceStatus: input.engine.governanceStatus,
        decisionId: input.engine.decisionId,
        ...(input.engine.diagnosticOverride === true ? { diagnosticOverride: true } : {}),
      },
    };
  }

  /** A row for an engine nothing was asked of. Never an absence from the table. */
  private notAttempted(
    engine: ResolvedEngine,
    outcome: 'DISABLED_BY_POLICY' | 'NOT_CONFIGURED',
  ): RecordedEngineResult {
    return {
      engine: engine.engine,
      searxngEngineName: engine.searxngEngineName,
      attempted: false,
      outcome,
      durationMs: 0,
      resultsReturned: 0,
      canonicalUrls: [],
      failureReason:
        outcome === 'DISABLED_BY_POLICY'
          ? engine.governanceStatus === 'REFUSED'
            ? `Disabled by platform governance: ${engine.governanceStatus} under ` +
              `${engine.decisionId}; tenantEnabled=${String(engine.tenantEnabled)} cannot override it.`
            : `Not enabled for discovery by this tenant (governance ${engine.governanceStatus}, ` +
              `${engine.decisionId}).`
          : 'This process holds no SearXNG instance to query.',
      governanceStatus: engine.governanceStatus,
      decisionId: engine.decisionId,
    };
  }

  /**
   * The FR-06 signal for a query in which every engine failed.
   *
   * Takes the most specific thing the engines agreed on, because the signal decides the retry
   * policy and the breaker: a rate limit must back off, a connection error may be retried, and a
   * CAPTCHA must not be retried at all. Where they disagree it reports a plain network failure,
   * which is the conservative reading — it never escalates a mixed bag into a hard block.
   */
  private signalFor(results: readonly RecordedEngineResult[]): Parameters<typeof failed>[2] {
    const outcomes = new Set(results.filter((r) => engineFailed(r.outcome)).map((r) => r.outcome));
    if (outcomes.size === 1) {
      const only = [...outcomes][0];
      if (only === 'RATE_LIMITED') {
        return { httpStatus: 429 };
      }
      if (only === 'ACCESS_DENIED' || only === 'CAPTCHA') {
        return { httpStatus: 403 };
      }
      if (only === 'TIMEOUT') {
        return { syscallCode: 'ETIMEDOUT' };
      }
      if (only === 'INTERNAL_ERROR') {
        return { unparsableBody: true };
      }
    }
    return { syscallCode: 'ECONNRESET' };
  }

  /**
   * Run tasks with a bound on how many are in flight.
   *
   * A plain `Promise.all` over six would be fine today and would become an unbounded fan-out the
   * moment somebody adds engines. Every task is expected not to reject — see `queryEngine`.
   */
  private async runBounded<T>(
    tasks: readonly (() => Promise<T>)[],
    limit: number,
  ): Promise<readonly T[]> {
    const results: T[] = new Array<T>(tasks.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        const task = tasks[index];
        if (task === undefined) {
          return;
        }
        results[index] = await task();
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * Merge one result into the candidate set, unioning its engine attribution.
   *
   * # The rule this implements
   *
   * One URL is one candidate, however many engines returned it. This does it across engines
   * within a query; the pipeline does it again across planned queries. Both layers, because the
   * thing being prevented — one story counted as several independent confirmations — is the
   * mistake FR-10's clustering rules exist to stop, and stopping it only at the far end would
   * mean fetching the same article several times on the way there.
   *
   * # What wins when two engines disagree
   *
   * The first sighting's title and snippet, and the **union** of the engines. Not the
   * highest-scoring sighting's: the score is a ranking opinion, it is read by nothing, and
   * letting it choose the snippet would let a ranking decide what the relevance filter later
   * scores. A published date is taken from the first sighting that has one, because a date one
   * engine reports and another omits is still a date the publisher stated — and `parsePublished`
   * refuses anything it cannot parse, so a bad one stays null.
   */
  private mergeResult(
    into: Map<string, MergedCandidate>,
    entry: SearxngResult,
    engine: DiscoveryEngine,
  ): void {
    if (entry.url === null || entry.title === null) {
      return;
    }
    const canonicalUrl = canonicalUrlOf(entry.url);
    if (canonicalUrl === null) {
      return;
    }

    const existing = into.get(canonicalUrl);
    if (existing !== undefined) {
      existing.engines.add(engine);
      if (existing.raw.publishedAtRaw === null && entry.publishedDate !== null) {
        existing.raw = { ...existing.raw, publishedAtRaw: entry.publishedDate };
      }
      existing.raw = {
        ...existing.raw,
        attribution: {
          discoverySource: this.options.sourceId,
          discoveryEngines: [...existing.engines].toSorted(),
          discoveryScore: existing.score,
          discoveryCategory: existing.category,
        },
      };
      return;
    }

    const engineSet = new Set<DiscoveryEngine>([engine]);
    into.set(canonicalUrl, {
      canonicalUrl,
      engines: engineSet,
      score: entry.score,
      category: entry.category,
      raw: {
        title: entry.title,
        link: entry.url,
        // SearXNG calls it `content`. Taken exactly as given, or null. Never synthesised from the
        // title: FR-06's relevance filter scores the snippet, and an invented one would be scored
        // as though the publisher had written it.
        snippet: entry.content,
        publishedAtRaw: entry.publishedDate,
        // A metasearch result declares no language of its own. Null, so `leadsFrom` falls back to
        // the language the query was asked in — what was asked for, not a guess from the text.
        language: null,
        attribution: {
          discoverySource: this.options.sourceId,
          discoveryEngines: [...engineSet],
          discoveryScore: entry.score,
          discoveryCategory: entry.category,
        },
      },
    });
  }

  /**
   * Replace the placeholder publisher with the one the article's own URL names.
   *
   * `leadsFrom` stamps every lead with the source's name, which is right for a feed — the SEC
   * publishes the SEC's litigation releases — and exactly wrong here. Leaving it would record the
   * metasearch instance as the publisher of every article it found, which is the single confusion
   * this whole design is written against.
   *
   * The publisher is the **registrable host**, not a resolved organisation name. The document has
   * not been fetched yet and nothing here knows whether `www.reuters.com` is Reuters or a
   * syndication of them; the host is a fact and a name would be an inference presented as one.
   * Extraction resolves the real publisher from the document once it has been read.
   */
  private attributePublisher(lead: Lead): Lead {
    return { ...lead, publisher: lead.publisherDomain };
  }

  /**
   * The scheduled contract test (T84).
   *
   * Runs the same parse the live path uses, through the same gate. A probe with its own copy of
   * the parse proves the copy still works.
   *
   * Zero results for a term this common is the signal rather than a coincidence — but note what
   * it means here and does not mean elsewhere: with no engine switched on, zero results is also
   * what a correctly configured but fully disabled layer looks like. The detail says so, because
   * an operator woken by this needs to know whether to look at the parser or at the switches.
   */
  async contractProbe(): Promise<ContractProbeResult> {
    const now = this.clock();
    const version = await this.options.versions.loadActive(this.options.sourceId);
    const base = {
      adapterId: this.descriptor.adapterId,
      parserVersion: this.descriptor.parserVersion,
      checkedAt: now.toISOString(),
    };

    if (version === null) {
      return {
        ...base,
        shapeStable: false,
        fieldsMissing: [],
        sampleParsedCount: 0,
        detail: `Source ${this.options.sourceId} has no active approved version to probe.`,
      };
    }

    const probeTenant = 'contract-probe';
    const outcome = await this.discover({
      tenantId: probeTenant,
      run: {
        jobId: `contract-probe-${now.toISOString()}`,
        subjectId: probeTenant,
        jurisdictions: [...version.countries],
        languages: [...version.languages],
        taxonomy: probeTaxonomy(version, now),
      },
      queryId: probeTenant,
      family: 'F3',
      text: 'fraud',
      language: version.languages[0] ?? null,
      country: version.countries[0] ?? null,
      window: null,
      limit: 50,
    });

    if (outcome.status === 'FAILED') {
      return {
        ...base,
        shapeStable: false,
        fieldsMissing: [],
        sampleParsedCount: 0,
        detail: outcome.detail,
      };
    }

    const count = 'data' in outcome ? outcome.data.length : 0;
    const engines = await this.options.enablement.resolveFor(probeTenant);
    const on = engines.filter((engine) => engine.effectiveEnabled).map((e) => e.engine);
    return {
      ...base,
      shapeStable: count > 0,
      fieldsMissing: count === 0 ? ['results'] : [],
      sampleParsedCount: count,
      detail:
        count === 0
          ? `${version.sourceName} answered and the parse extracted zero results for "fraud". ` +
            `That is how a silent shape change presents: nothing throws, and recall goes to zero ` +
            `while the service keeps reporting clean results (T84). Before changing the parser, ` +
            `check the switches — engines enabled for the probe tenant were ` +
            `[${on.join(', ') || 'none'}], and a probe over no engine returns zero for a reason ` +
            `that has nothing to do with the parse.`
          : '',
    };
  }

  private budgetFor(jobId: string): RunBudget {
    const existing = this.budgets.get(jobId);
    if (existing !== undefined) {
      return existing;
    }
    while (this.budgets.size >= MAX_TRACKED_RUNS) {
      const oldest = this.budgets.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.budgets.delete(oldest.value);
    }
    const budget: RunBudget = { queriesIssued: 0, candidates: 0 };
    this.budgets.set(jobId, budget);
    return budget;
  }

  /** Drop a run's budget. Called by the pipeline once the run's discovery is finished. */
  forget(jobId: string): void {
    this.budgets.delete(jobId);
  }

  private descriptorFor(version: ActiveSourceVersion): AdapterDescriptor {
    return {
      ...this.descriptor,
      jurisdictions: [...version.countries],
      parserVersion: `${SEARXNG_PARSER_VERSION}+${version.sourceId}`,
    };
  }
}

/** What one engine's task produced: the outcome row, and the entries to merge. */
interface EngineRun {
  readonly engine: RunEngine;
  readonly entries: readonly SearxngResult[];
  readonly record: RecordedEngineResult;
}

/** One canonical URL, every engine that returned it, and the candidate it will become. */
interface MergedCandidate {
  readonly canonicalUrl: string;
  readonly engines: Set<DiscoveryEngine>;
  readonly score: number | null;
  readonly category: string | null;
  raw: RawCandidate;
}

/**
 * The canonical form of a result URL, or null when SEC-02 refuses it.
 *
 * Screened here as well as inside `leadsFrom`, because this is the **merge key**: a key derived
 * from an unscreened URL would merge candidates on something we may never fetch, and would count
 * a refused URL as a unique contribution in the diagnostics.
 */
function canonicalUrlOf(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const screening = screenUrl(raw);
  if (!screening.allowed || screening.canonical === null) {
    return null;
  }
  return canonicalise(new URL(screening.canonical));
}

function rungOf(cascadeRung: number): CascadeRung {
  const rung = Math.trunc(cascadeRung);
  return (rung < 0 ? 0 : rung > 7 ? 7 : rung) as CascadeRung;
}

function probeTaxonomy(version: ActiveSourceVersion, now: Date): DiscoveryQuery['run']['taxonomy'] {
  return {
    taxonomyVersionId: `contract-probe:${version.sourceId}`,
    version: version.version,
    tenantId: 'contract-probe',
    categories: [
      {
        category: 'FRAUD_FINANCIAL_CRIME',
        severityWeight: 1,
        enabledCountries: [...version.countries],
      },
    ],
    lexicon: [],
    languages: version.languages.map((language) => ({
      language,
      measuredRecall: null,
      measuredByEvaluationRunId: null,
    })),
    status: 'ACTIVE',
    proposedBy: 'contract-probe',
    approvedBy: 'contract-probe',
    activatedAt: now.toISOString(),
  };
}
