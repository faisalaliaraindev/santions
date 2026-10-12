/**
 * `WebDiscoveryPort` — cascade rungs 5 and 6 (FR-05).
 *
 * Self-hosted SearXNG over an approved engine mix, direct site search on approved
 * high-authority domains, and open web archives. Separate from `NewsDiscoveryPort` because of
 * how it is *asked*, not because of what it returns: news discovery is asked per language and
 * edition, web discovery is asked per **engine mix** or per **domain**, and those are the two
 * knobs that decide whether a rung-5 query is reproducible.
 *
 * Rung 6 — "direct site search on approved high-authority domains" — is the one that can
 * quietly break FR-05's permission rule, so it is a separate method rather than a parameter.
 * `siteSearch` takes a domain that the caller must have already confirmed is approved in the
 * registry; a discovered domain is a lead and searching it directly would be treating an
 * unreviewed domain as a source. Making it a distinct call means the permission check has an
 * obvious place to sit and an obvious thing to guard, instead of being one branch inside a
 * general `discover`.
 *
 * **No adapter here is written in Phase D.** Phase E, behind this seam.
 */

import type { DiscoveryQuery, Lead } from './lead.js';
import type { AdapterDescriptor, SourceOutcome } from './source-adapter.js';

export const WEB_DISCOVERY_PORT = 'WEB_DISCOVERY_PORT';

/** A rung-5 query, with the engine mix named so the run is reproducible. */
export interface EngineMixQuery extends DiscoveryQuery {
  /**
   * The SearXNG engines to use, by name. Required and non-empty: defaulting to "whatever the
   * instance is configured with" makes the same query return different results after an
   * unrelated configuration change, and makes a recall figure from the evaluation set
   * unreproducible.
   */
  readonly engines: readonly string[];
}

/** A rung-6 query against one already-approved domain. */
export interface SiteSearchQuery extends DiscoveryQuery {
  /**
   * The domain to search. The caller must have confirmed it is an approved canonical domain on
   * an active source version — this port does not check, and says so plainly, because a check
   * that lives in two places is a check that disagrees with itself.
   */
  readonly domain: string;
}

export interface WebDiscoveryPort {
  readonly descriptor: AdapterDescriptor;

  /** Rung 5. */
  search(query: EngineMixQuery): Promise<SourceOutcome<readonly Lead[]>>;

  /** Rung 6. Stops the cascade on failure per FR-05's table ("record and stop"). */
  siteSearch(query: SiteSearchQuery): Promise<SourceOutcome<readonly Lead[]>>;

  /**
   * Which engines the instance currently has enabled.
   *
   * Read, never assumed. An engine silently dropped from a self-hosted SearXNG changes what a
   * rung-5 query covers, and the coverage statement should say so rather than continue to name
   * an engine that has not run for a month.
   */
  availableEngines(): Promise<readonly string[]>;
}
