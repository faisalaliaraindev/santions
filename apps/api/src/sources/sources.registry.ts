/**
 * The one place a source adapter is chosen.
 *
 * Phase D step D2. Six seams, six mocks, one real adapter — and a single function that decides
 * which of them a process gets, from the operating mode and the configured credentials.
 *
 * **Why a function and not six providers in `app.module.ts`.** The mode rule is a single rule —
 * a mock is unreachable in live mode — and six independent factories is six places to get it
 * right. Here it is expressed once: `MockModeWitness.require(mode)` is called once, at the top,
 * and a `LIVE` process throws before it constructs anything. The module then registers what
 * this returns.
 *
 * **What a live process gets today, honestly stated.** Two of the six seams have a live adapter:
 * the GB company registry (D2) and, as of Phase E step 1, evidence fetch. The other four are
 * `null` in live mode rather than a mock. Not a fallback, not a stub: null, so that a caller has
 * to handle "this capability has no source" explicitly. Falling back to a mock would make a live
 * process serve fixtures (T55), and falling back to an adapter that returns empty results would
 * make a live process report clean results from sources that were never consulted, which is the
 * failure this whole service is built to avoid.
 *
 * **The fetch adapter is null unless it can be honest.** It needs a contact URL for its user
 * agent (FR-06) and a source-health service to consult before every call (D5). Neither is
 * defaulted, because the default in each case is a lie: a contact URL nobody owns, or an
 * unthrottled fetcher pointed at a publisher.
 */

import { Logger } from '@nestjs/common';

import { CompaniesHouseAdapter } from './companies-house.adapter.js';
import {
  HttpEvidenceFetchAdapter,
  type DomainAccessPort,
  type SourceAccessPort,
} from './http-evidence-fetch.adapter.js';
import type { CompanyRegistryPort } from './company-registry.port.js';
import type { EvidenceFetchPort } from './evidence-fetch.port.js';
import type { ExtractionModelPort } from './extraction-model.port.js';
import { MockCompanyRegistryAdapter } from './mock/company-registry.mock.js';
import { MockEvidenceFetchAdapter } from './mock/evidence-fetch.mock.js';
import { MockExtractionModelAdapter } from './mock/extraction-model.mock.js';
import { MockNewsDiscoveryAdapter } from './mock/news-discovery.mock.js';
import { MockPrimarySourceAdapter } from './mock/primary-source.mock.js';
import { MockWebDiscoveryAdapter } from './mock/web-discovery.mock.js';
import type { NewsDiscoveryPort } from './news-discovery.port.js';
import type { PrimarySourcePort } from './primary-source.port.js';
import { MockModeWitness, type OperatingMode } from './source-adapter.js';
import type { WebDiscoveryPort } from './web-discovery.port.js';

/**
 * Every source seam a process holds.
 *
 * `null` means "no source is configured for this capability in this mode". It is not an error
 * state and it is not a gap to be filled with something harmless — D1's capability coverage
 * already has the vocabulary for it, and `interpretEmptyResult` already refuses to call a
 * missing capability an empty result.
 */
export interface SourceAdapterSet {
  readonly newsDiscovery: NewsDiscoveryPort | null;
  readonly webDiscovery: WebDiscoveryPort | null;
  readonly primarySource: PrimarySourcePort | null;
  /** The only seam with a real adapter in Phase D — and it covers GB, not CR. */
  readonly companyRegistry: CompanyRegistryPort | null;
  readonly evidenceFetch: EvidenceFetchPort | null;
  readonly extractionModel: ExtractionModelPort | null;
}

export interface SourceRegistryOptions {
  readonly mode: OperatingMode;
  /**
   * The Companies House API key, or null when none is configured.
   *
   * A reference resolved by configuration, never a value stored in the source registry
   * (SEC-04: the registry holds a `credentialsRef`). Without it the GB adapter is simply not
   * constructed — a registry adapter that 401s on every call is worse than an absent one,
   * because it produces a coverage gap that looks like an outage at the source.
   */
  readonly companiesHouseApiKey: string | null;
  /**
   * The contact URL the outbound user agent carries (FR-06). Null when unconfigured, and the
   * live fetch adapter is then **not constructed** — an anonymous crawler is not a degraded
   * version of an honest one, it is the thing the requirement forbids.
   */
  readonly fetchContactUrl: string | null;
  /**
   * Source health, which the fetch adapter consults immediately before every external call.
   *
   * Required in live mode and unused in mock mode. Passing it in rather than having the adapter
   * reach for it keeps `buildSourceAdapters` the one place an adapter is constructed, and keeps
   * the adapter testable against a stub.
   */
  readonly sourceAccess?: SourceAccessPort | undefined;
  /**
   * The per-domain breaker (D-040), consulted before every hop and fed every server-produced
   * failure.
   *
   * Required in live mode on the same rule as `sourceAccess`, and for a reason the source
   * breaker cannot cover: a discovery source hands us links to publishers it does not speak for,
   * and without this the adapter would keep calling a publisher who has already refused it. An
   * absent domain breaker is not a degraded one.
   */
  readonly domainAccess?: DomainAccessPort | undefined;
}

export const SOURCE_ADAPTERS = 'SOURCE_ADAPTERS';

export function buildSourceAdapters(options: SourceRegistryOptions): SourceAdapterSet {
  const logger = new Logger('Sources');

  if (options.mode === 'MOCK') {
    // One witness, obtained once. In LIVE this call throws; in MOCK every adapter below can be
    // constructed. There is no branch here in which a mock is built without it.
    const witness = MockModeWitness.require(options.mode);
    logger.warn(
      'ADVERSE_SEARCH_MODE=mock: every source adapter is a fixture. Nothing in this process ' +
        'reaches a real source, and every record it produces is stamped MOCK (T55).',
    );
    return {
      newsDiscovery: new MockNewsDiscoveryAdapter(witness),
      webDiscovery: new MockWebDiscoveryAdapter(witness),
      primarySource: new MockPrimarySourceAdapter(witness),
      companyRegistry: new MockCompanyRegistryAdapter(witness),
      evidenceFetch: new MockEvidenceFetchAdapter(witness),
      extractionModel: new MockExtractionModelAdapter(witness),
    };
  }

  // Live. Four seams still have no adapter; see the file header for why they are null rather
  // than stubbed. Fetch is the one Phase E step 1 fills.
  logger.log(
    'ADVERSE_SEARCH_MODE=live: discovery and extraction have no live adapter yet (Phase E ' +
      'steps 3 and F). Those capabilities are unavailable, not empty.',
  );

  if (options.companiesHouseApiKey === null) {
    logger.warn(
      'No Companies House API key configured: the company registry seam has no live adapter. ' +
        'FR-02 association data is unavailable rather than absent.',
    );
  } else {
    logger.log(
      'Companies House adapter enabled for GB only. It is the proving ground for the FR-02 ' +
        'graph and is NOT coverage for Costa Rica (D-010, D14): CR has no free automatable ' +
        'officer-level source. See docs/sources/cr-dossier.md.',
    );
  }

  // The fetch seam, Phase E step 1. Two things must both be present, and neither is defaulted:
  // an honest contact URL (FR-06 requires the user agent to carry one, and a made-up default is
  // worse than no adapter), and source health (the kill switch, the breaker and the budgets are
  // consulted immediately before every external call — an adapter without them is an unthrottled
  // fetcher pointed at a publisher, which is exactly what D5 was built first to prevent).
  const evidenceFetch =
    options.fetchContactUrl === null ||
    options.sourceAccess === undefined ||
    options.domainAccess === undefined
      ? null
      : new HttpEvidenceFetchAdapter({
          access: options.sourceAccess,
          domains: options.domainAccess,
          contactUrl: options.fetchContactUrl,
        });

  if (evidenceFetch === null) {
    logger.warn(
      'No live evidence-fetch adapter: ' +
        (options.fetchContactUrl === null
          ? 'FETCH_CONTACT_URL is unset, and FR-06 requires the user agent to identify this ' +
            'service honestly with a contact URL. Fetching is unavailable rather than anonymous.'
          : options.sourceAccess === undefined
            ? 'source health was not supplied, and nothing fetches without the breaker, the ' +
              'budgets and the kill switch in front of it.'
            : 'domain health was not supplied, and nothing fetches without the per-domain ' +
              'breaker in front of it — a fetcher that cannot notice a publisher refusing it ' +
              'keeps calling them (D-040).'),
    );
  } else {
    logger.log(
      'Live evidence fetch enabled. Every request screens its URL and every resolved address ' +
        '(SEC-02), honours robots.txt with UNKNOWN refusing, and checks source health ' +
        'immediately before opening a socket. No robots exception can be applied: open ' +
        'decision D6 has not closed, so no approver can be recorded.',
    );
  }

  return {
    newsDiscovery: null,
    webDiscovery: null,
    primarySource: null,
    companyRegistry:
      options.companiesHouseApiKey === null
        ? null
        : new CompaniesHouseAdapter({ apiKey: options.companiesHouseApiKey }),
    evidenceFetch,
    extractionModel: null,
  };
}
