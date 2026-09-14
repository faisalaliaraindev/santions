/**
 * `NewsDiscoveryPort` — cascade rungs 2, 3 and 4 (FR-05).
 *
 * Google News RSS, GDELT DOC 2.0 and Bing News RSS. All three are free, all three are keyless
 * or free-key, and two of the three are **undocumented**: nobody has promised us that Google
 * News RSS will keep its current item shape, and when it changes, the parse does not throw —
 * it returns zero items. Zero items from a working transport is indistinguishable from "this
 * person is not in the news", so a silent shape change turns the service into one that reports
 * clean results confidently. That is the single most dangerous failure mode in this file's
 * area, and it is why `contractProbe` is part of the port rather than a script beside it.
 *
 * **No adapter here is written in Phase D.** The seam is defined now so that Phase E's adapters
 * are built to it — behind the budgets, breakers and egress identities they must cooperate
 * with — rather than the seam being reverse-engineered from the first adapter that works.
 */

import type { CountryCode } from '@erly/adverse-domain';

import type { DiscoveryQuery, Lead } from './lead.js';
import type { AdapterDescriptor, SourceOutcome } from './source-adapter.js';

export const NEWS_DISCOVERY_PORT = 'NEWS_DISCOVERY_PORT';

/**
 * The result of a scheduled contract test (FR-05, volatility control).
 *
 * A probe runs a **known query with a known-good expected shape** and reports whether the
 * response still parses into the fields the adapter depends on. `fieldsMissing` names them,
 * because "the shape changed" is not actionable at three in the morning and "item/pubDate is
 * gone" is.
 *
 * `sampleParsedCount` is here for the case that matters most: a probe that parses the envelope
 * fine and extracts zero items has found the failure, even though nothing errored.
 */
export interface ContractProbeResult {
  readonly adapterId: string;
  readonly parserVersion: string;
  readonly checkedAt: string;
  readonly shapeStable: boolean;
  readonly fieldsMissing: readonly string[];
  readonly sampleParsedCount: number;
  /** Human-readable, for the alert body. Empty when `shapeStable` is true. */
  readonly detail: string;
}

export interface NewsDiscoveryPort {
  readonly descriptor: AdapterDescriptor;

  /**
   * Editions this adapter can actually address.
   *
   * Google News RSS is addressable per country edition; GDELT is global. The planner needs to
   * know which, because issuing a per-edition query to a global source silently runs the same
   * search N times and makes the coverage statement claim N editions were checked.
   */
  readonly editions: readonly CountryCode[];

  discover(query: DiscoveryQuery): Promise<SourceOutcome<readonly Lead[]>>;

  /**
   * Verify the response shape has not changed under us.
   *
   * On the port, not in a script, for two reasons. It must run against the *same parser* the
   * live path uses — a probe with its own copy of the parse proves the copy still works — and
   * every adapter must have one, which a script cannot enforce. A `DOCUMENTED_STABLE` adapter
   * may implement it as a cheap endpoint check; an `UNDOCUMENTED_VOLATILE` one may not skip it.
   */
  contractProbe(): Promise<ContractProbeResult>;
}
