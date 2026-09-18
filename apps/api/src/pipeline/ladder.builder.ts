/**
 * Building the FR-05 ladder from the registry — Phase E step 3.
 *
 * `CascadeService` walks a ladder. This decides what is on it, and the rule is one sentence:
 * **a source sits at the rung its approved version records.** Not the rung a connector was
 * written for, and not a rung chosen here.
 *
 * That is what makes the ladder configuration rather than code. Approving a new RSS source at
 * rung 2 puts it on the ladder; narrowing a source's countries takes it off for the runs it no
 * longer covers; retiring its version removes it entirely — all without a deployment, and all
 * through the four-eyes lifecycle that records who did it.
 *
 * # Read fresh, every run
 *
 * Not cached. A cached ladder keeps asking a source an administrator retired, and the window in
 * which that is true is the window somebody asked us to stop. The cost is one indexed query per
 * run, against a collection with a handful of rows.
 *
 * # What is deliberately absent
 *
 * **Rung 0 — the local index of polled feeds — has no adapter.** There is no poller yet, so
 * nothing is in a local index to read. The honest consequence is that rung 0 reports `NO_SOURCE`
 * on every run and the coverage statement says the rung was not searched. Inventing an empty
 * local index that always answers "nothing" would convert a missing capability into a clean
 * answer, which is the failure this whole service is built to avoid.
 */

import { Logger } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import type { CascadeRung } from '@erly/adverse-domain';

import type { EvidenceFetchPort } from '../sources/evidence-fetch.port.js';
import type { FetchGateService } from '../sources/fetch-gate.service.js';
import type { DiscoveryRequestLog } from '../sources/discovery-request-log.js';
import type { FixedFeedPollCache } from '../sources/feed-poll-cache.js';
import type { DiscoveryQuery, Lead } from '../sources/lead.js';
import type { NewsDiscoveryPort } from '../sources/news-discovery.port.js';
import { GdeltDiscoveryAdapter } from '../sources/gdelt-discovery.adapter.js';
import type { RequestPacer } from '../sources/request-pacer.js';
import { RssNewsDiscoveryAdapter } from '../sources/rss-news-discovery.adapter.js';
import type { Clock, OperatingMode, SourceOutcome } from '../sources/source-adapter.js';
import type { SourceVersionReader } from '../sources/source-version.service.js';
import type { SourceAdapterSet } from '../sources/sources.registry.js';
import type { WebDiscoveryPort } from '../sources/web-discovery.port.js';

import type { LadderEntry } from './cascade.service.js';

/**
 * What a rung needs to know about an approved source to put it on the ladder.
 *
 * Read straight off the active version rather than from the adapter, because the adapter's
 * descriptor describes the **parser** and this describes the **approval**.
 */
interface ApprovedDiscoverySource {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly rung: CascadeRung;
  readonly connectorType: string;
  readonly canonicalDomains: readonly string[];
}

/**
 * The engine mix a rung-5 query names.
 *
 * Required and non-empty by the port's own contract: defaulting to "whatever the instance is
 * configured with" makes the same query return different results after an unrelated
 * configuration change, and makes a recall figure from the evaluation set unreproducible.
 */
const DEFAULT_ENGINE_MIX: readonly string[] = ['duckduckgo', 'wikipedia'];

/**
 * Connector types this builder can construct a **live** adapter for, per approved source.
 *
 * Two entries, and the asymmetry between them is the point of **D-043**. Bing News RSS needed no
 * code at all — it is `NEWS_DISCOVERY_RSS` at a different approved address, so it is a registry
 * row. GDELT returns JSON rather than a feed, so it needed a parser and therefore a type.
 *
 * Adding a publisher should almost always be the first kind. A new connector type means a new
 * response format, not a new source.
 */
const LIVE_CONNECTORS: Readonly<Record<string, 'RSS' | 'GDELT'>> = {
  NEWS_DISCOVERY_RSS: 'RSS',
  NEWS_DISCOVERY_GDELT: 'GDELT',
};

/**
 * What the builder needs to construct a live discovery adapter for an approved source.
 *
 * Absent in mock mode, and the absence is load-bearing: the ladder then uses only the adapters in
 * the set, every one of which is a fixture that cannot be constructed in live mode at all
 * (`MockModeWitness`). There is no arrangement in which a live feed is read by a mock process or
 * a fixture is read by a live one.
 */
export interface LiveDiscoveryDeps {
  readonly mode: OperatingMode;
  readonly versions: SourceVersionReader;
  readonly gate: FetchGateService;
  /** Null when this process has no honest fetch adapter — no contact URL, or no source health. */
  readonly evidenceFetch: EvidenceFetchPort | null;
  /**
   * The process's fixed-feed poll cache.
   *
   * One per process, shared by every connector it builds, because the thing being bounded is the
   * number of requests **the publisher** sees — which is a property of the process, not of a run.
   * A per-run cache would still poll once per search, which is the second half of the same bug.
   */
  readonly pollCache?: FixedFeedPollCache;
  /**
   * The clock the connectors read.
   *
   * Injected rather than taken from `Date` inside each adapter so the poll floor is testable:
   * a floor whose only clock is wall time can be asserted to hold, never to expire.
   */
  readonly clock?: Clock;
  /**
   * Where the live connectors record what they put on the wire.
   *
   * One per process, like the poll cache, and for a related reason: what it measures is the
   * traffic **the publisher** sees. A diagnostic only — nothing in the pipeline reads it back to
   * make a decision, and a process without one simply reports no request counts rather than
   * reporting zero.
   */
  readonly requestLog?: DiscoveryRequestLog;
  /**
   * The process's request pacer, which enforces each source's recorded
   * `requestCeilingPerSecond`.
   *
   * One per process, for the same reason the poll cache is: a publisher's stated ceiling is a
   * promise about what this deployment does to them in total, so two searches running at once
   * must queue behind one another rather than pace themselves separately and arrive together.
   * A process without one falls back to the module-level `requestPacer`.
   */
  readonly pacer?: RequestPacer;
}

export class LadderBuilder {
  private readonly logger = new Logger('Ladder');
  private readonly versions: Collection;

  /**
   * Adapters constructed for this process, keyed by source id.
   *
   * Cached across builds because an `RssNewsDiscoveryAdapter` is a stateless wrapper over the
   * fetch port and the gate — constructing one per run would be harmless and wasteful. What is
   * **not** cached is the registry read: a source retired since the last run drops out of the
   * ladder even though its adapter is still sitting in this map, because the map is only ever
   * consulted for a source the registry just returned.
   */
  private readonly liveAdapters = new Map<string, NewsDiscoveryPort>();

  constructor(
    db: Db,
    private readonly adapters: SourceAdapterSet,
    /**
     * Absent in mock mode. See `LiveDiscoveryDeps` — the absence is what keeps a live feed out
     * of a mock process.
     */
    private readonly live: LiveDiscoveryDeps | null = null,
  ) {
    this.versions = db.collection('sourceVersions');
  }

  /**
   * The ladder for this run.
   *
   * Entries are returned in rung order, and a rung with nothing approved for it simply has no
   * entry — `CascadeService` turns that absence into a recorded `NO_SOURCE` gap rather than
   * skipping it silently.
   */
  async build(): Promise<readonly LadderEntry[]> {
    const approved = await this.approvedSources();
    const entries: LadderEntry[] = [];

    for (const source of approved) {
      const entry = this.entryFor(source);
      if (entry === null) {
        // An approved source whose connector type this build does not serve. Logged rather than
        // silently dropped: it means somebody approved a source nothing can read, and the rung
        // will report `NO_SOURCE` while the registry says a source exists for it.
        this.logger.warn(
          `${source.sourceId} is approved at rung ${String(source.rung)} with connector ` +
            `${source.connectorType}, and no adapter in this process serves it. The rung will ` +
            `report as unsearched.`,
        );
        continue;
      }
      entries.push(entry);
    }

    return entries.toSorted((a, b) => a.rung - b.rung);
  }

  /**
   * Map one approved source onto something the ladder can ask.
   *
   * The four discovery shapes are asked differently, and that difference lives here rather than
   * in the cascade: `discover` for a news feed, `search` with an engine mix for a metasearch
   * instance, `siteSearch` for a named approved domain, and nothing at all for a connector type
   * this process has no adapter for.
   */
  private entryFor(source: ApprovedDiscoverySource): LadderEntry | null {
    const base = {
      rung: source.rung,
      sourceId: source.sourceId,
      sourceName: source.sourceName,
    };

    const news = this.newsFor(source);
    if (news !== null) {
      return {
        ...base,
        ask: (query): Promise<SourceOutcome<readonly Lead[]>> => news.discover(query),
      };
    }

    const web = this.webFor(source);
    if (web !== null) {
      // Rung 6 is "direct site search on approved high-authority domains" and is a separate
      // method on the port for a reason: the domain must already be approved. Passing the
      // source's own canonical domain is what keeps that true — a discovered domain is a lead,
      // and searching it directly would be treating an unreviewed domain as a source (FR-05).
      if (source.rung === 6) {
        const domain = source.canonicalDomains[0];
        if (domain === undefined) {
          this.logger.warn(
            `${source.sourceId} is approved at rung 6 and records no canonical domain, so there ` +
              `is no approved domain to search. The rung will report as unsearched.`,
          );
          return null;
        }
        return {
          ...base,
          ask: (query): Promise<SourceOutcome<readonly Lead[]>> =>
            web.siteSearch({ ...query, domain }),
        };
      }

      return {
        ...base,
        ask: (query): Promise<SourceOutcome<readonly Lead[]>> =>
          web.search({ ...query, engines: [...DEFAULT_ENGINE_MIX] }),
      };
    }

    return null;
  }

  /**
   * The news adapter serving this source, if this process has or can build one.
   *
   * Two ways it can exist, and the order matters. An adapter already in the set wins — that is
   * how a mock process serves a fixture source, and a live process would never have one there.
   * Otherwise, in **live mode only**, one is constructed for an approved `NEWS_DISCOVERY_RSS`
   * source: the connector is registry-driven (D-043), so every RSS publisher is the same code at
   * a different approved address.
   */
  private newsFor(source: ApprovedDiscoverySource): NewsDiscoveryPort | null {
    const prebuilt = this.adapters.newsDiscovery.find(
      (port) => port.descriptor.sourceId === source.sourceId,
    );
    if (prebuilt !== undefined) {
      return prebuilt;
    }
    return this.liveConnectorFor(source);
  }

  /**
   * Construct the live connector for an approved source, or explain why not.
   *
   * Every refusal here is logged rather than silent, because the rung will then report as
   * unsearched and an operator needs to be able to tell "nothing is approved for this rung" from
   * "something is approved and this process cannot read it".
   */
  private liveConnectorFor(source: ApprovedDiscoverySource): NewsDiscoveryPort | null {
    if (this.live === null || this.live.mode !== 'LIVE') {
      return null;
    }
    const kind = LIVE_CONNECTORS[source.connectorType];
    if (kind === undefined) {
      return null;
    }

    const existing = this.liveAdapters.get(source.sourceId);
    if (existing !== undefined) {
      return existing;
    }

    if (this.live.evidenceFetch === null) {
      // No contact URL, or no source health. `buildSourceAdapters` already refuses to build the
      // fetch adapter without either, and an RSS connector with nothing to fetch through would
      // be a connector that cannot make a request — so the rung reports unsearched, honestly.
      this.logger.warn(
        `${source.sourceId} is approved at rung ${String(source.rung)} and this process has no ` +
          `evidence-fetch adapter, so it cannot be read. FETCH_CONTACT_URL and source health are ` +
          `both required (FR-06, D5). The rung will report as unsearched.`,
      );
      return null;
    }

    const shared = {
      sourceId: source.sourceId,
      versions: this.live.versions,
      gate: this.live.gate,
      fetch: this.live.evidenceFetch,
      // Absent rather than null when the process has none: `exactOptionalPropertyTypes` makes
      // the difference visible, and an adapter without a cache polls every time, honestly.
      ...(this.live.pollCache === undefined ? {} : { pollCache: this.live.pollCache }),
      ...(this.live.clock === undefined ? {} : { clock: this.live.clock }),
      ...(this.live.requestLog === undefined ? {} : { requestLog: this.live.requestLog }),
      ...(this.live.pacer === undefined ? {} : { pacer: this.live.pacer }),
    };
    const adapter =
      kind === 'GDELT' ? new GdeltDiscoveryAdapter(shared) : new RssNewsDiscoveryAdapter(shared);
    this.liveAdapters.set(source.sourceId, adapter);
    this.logger.log(
      `Live ${kind} connector for ${source.sourceName} (${source.sourceId}) at rung ` +
        `${String(source.rung)}. Every request it makes passes the same gate a document fetch ` +
        `does, including the named first-contact approval (D-042).`,
    );
    return adapter;
  }

  /** The web adapter serving this source, if this process has one. */
  private webFor(source: ApprovedDiscoverySource): WebDiscoveryPort | null {
    return (
      this.adapters.webDiscovery.find((port) => port.descriptor.sourceId === source.sourceId) ??
      null
    );
  }

  /**
   * Active source versions that sit on the discovery ladder.
   *
   * Rungs 0 to 6 only: rung 7 is the terminus and nothing is approved for it. A version whose
   * recorded rung is outside the table is skipped and logged — a rung nobody can climb is a
   * configuration error, and treating it as rung 0 would put a source somewhere its approver did
   * not put it.
   */
  private async approvedSources(): Promise<readonly ApprovedDiscoverySource[]> {
    const documents = await this.versions.find({ status: 'ACTIVE' }).toArray();
    const sources: ApprovedDiscoverySource[] = [];

    for (const document of documents) {
      // Both stored shapes are read. The bootstrap writes source fields flat on the document;
      // `VersionedRecordService` nests them under `content`. Reading only one is how an
      // administrator takes a source through four-eyes approval and finds the ladder still
      // built from the seeded one.
      const content = (document['content'] as Record<string, unknown> | undefined) ?? document;
      const rung: unknown = content['cascadeRung'];
      if (typeof rung !== 'number' || !Number.isInteger(rung) || rung < 0 || rung > 6) {
        // Logged rather than skipped in silence. An approved source that is not on the ladder and
        // says nothing about why is a source an operator will look for in the registry, find
        // ACTIVE, and have no way to connect to the rung reporting `NO_SOURCE`. Rung 7 is the
        // terminus and nothing is approved for it, so this really is a configuration error.
        this.logger.warn(
          `${String(document['sourceId'] ?? '(no sourceId)')} is ACTIVE and records ` +
            `cascadeRung ${JSON.stringify(rung)}, which is not an integer rung 0-6. It is not on ` +
            `the ladder. Note that the field is read from the record's own shape: a version ` +
            `written by the approval lifecycle nests it under \`content\`, the bootstrap writes ` +
            `it flat, and both are read here.`,
        );
        continue;
      }

      sources.push({
        sourceId: String(document['sourceId'] ?? ''),
        sourceName: stringOr(content['sourceName'], String(document['sourceId'] ?? '')),
        rung: rung as CascadeRung,
        connectorType: stringOr(content['connectorType'], 'UNKNOWN'),
        canonicalDomains: stringArray(content['canonicalDomains']),
      });
    }

    return sources;
  }
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? (value as readonly unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** The discovery query shape a ladder entry is handed, re-exported for call sites. */
export type { DiscoveryQuery };
