/**
 * The deterministic mock `WebDiscoveryPort` — rungs 5 and 6.
 *
 * One behaviour here is not a convenience and should not be "fixed" later: `siteSearch`
 * **refuses a domain that is not in `approvedDomains`**, and refuses it by throwing rather than
 * by returning a `FAILED` outcome. Searching an unapproved domain directly is FR-05's
 * "an unreviewed discovered domain remains a lead" being violated, which is a permission
 * failure, not a source failure. Reporting it as a source failure would put a coverage gap in
 * the record for a domain we were never allowed to ask about, and the audit trail would then
 * show us having attempted it.
 *
 * `search` requires a non-empty engine mix for the reason given in `web-discovery.port.ts`:
 * an unnamed engine set makes the same query unreproducible after an unrelated configuration
 * change, and every recall figure measured against it becomes unrepeatable.
 */

import {
  failed,
  fixedMockClock,
  noResults,
  ok,
  type AdapterDescriptor,
  type Clock,
  type MockModeWitness,
  type SourceOutcome,
} from '../source-adapter.js';
import type { Lead } from '../lead.js';
import type { EngineMixQuery, SiteSearchQuery, WebDiscoveryPort } from '../web-discovery.port.js';
import type { FailureSignal } from '@erly/adverse-domain';

import { FIXTURE_LEADS, queryMatchesFixture } from './discovery-fixtures.js';
import { withinWindow } from './news-discovery.mock.js';

export const MOCK_WEB_DISCOVERY_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'mock-web-discovery',
  portKind: 'WEB_DISCOVERY',
  sourceId: 'src-mock-web-discovery',
  parserVersion: 'mock-1',
  stabilityClass: 'DOCUMENTED_STABLE',
  mode: 'MOCK',
  jurisdictions: ['CR'],
};

/** The engine mix the mock instance reports as enabled. */
export const MOCK_ENGINES: readonly string[] = ['duckduckgo', 'startpage', 'wikipedia'];

export class MockWebDiscoveryAdapter implements WebDiscoveryPort {
  readonly descriptor = MOCK_WEB_DISCOVERY_DESCRIPTOR;

  private fault: FailureSignal | null = null;

  constructor(
    _witness: MockModeWitness,
    /**
     * The domains an active source version has approved. Supplied by the caller rather than
     * hard-coded, because approval is registry state and a mock that carries its own list
     * would let a test pass against an approval that does not exist.
     */
    private readonly approvedDomains: readonly string[] = ['boletin-example.go.cr'],
    private readonly clock: Clock = fixedMockClock,
  ) {}

  failWith(signal: FailureSignal): void {
    this.fault = signal;
  }

  clearFault(): void {
    this.fault = null;
  }

  async availableEngines(): Promise<readonly string[]> {
    return Promise.resolve(MOCK_ENGINES);
  }

  async search(query: EngineMixQuery): Promise<SourceOutcome<readonly Lead[]>> {
    if (query.engines.length === 0) {
      throw new Error(
        'A rung-5 query must name its engine mix. Defaulting to the instance configuration ' +
          'makes the same query return different results after an unrelated change, and makes ' +
          'any recall figure measured against it unreproducible (FR-05, FR-16).',
      );
    }
    const unknown = query.engines.filter((e) => !MOCK_ENGINES.includes(e));
    if (unknown.length > 0) {
      // Not silently ignored. A query naming an engine that is not enabled covers less than it
      // claims, and the coverage statement would say otherwise.
      throw new Error(
        `Engines not enabled on this instance: ${unknown.join(', ')}. Enabled: ` +
          `${MOCK_ENGINES.join(', ')}.`,
      );
    }
    return this.collect(query.text, query.window, query.queryId, query.limit, 5, null);
  }

  async siteSearch(query: SiteSearchQuery): Promise<SourceOutcome<readonly Lead[]>> {
    if (!this.approvedDomains.includes(query.domain)) {
      throw new Error(
        `Refusing a direct site search on ${query.domain}: it is not an approved canonical ` +
          `domain on an active source version. An unreviewed discovered domain remains a lead ` +
          `(FR-05); searching it directly treats it as a source.`,
      );
    }
    return this.collect(query.text, query.window, query.queryId, query.limit, 6, query.domain);
  }

  private collect(
    text: string,
    window: { readonly from: string; readonly to: string } | null,
    queryId: string,
    limit: number,
    rung: 5 | 6,
    domain: string | null,
  ): Promise<SourceOutcome<readonly Lead[]>> {
    const now = this.clock();
    if (this.fault !== null) {
      return Promise.resolve(failed(this.descriptor, now, this.fault));
    }

    const matches = FIXTURE_LEADS.filter((f) => queryMatchesFixture(text, f.requires))
      .filter((f) => domain === null || f.lead.publisherDomain === domain)
      .filter((f) => withinWindow(f.lead.publishedAt.value, window))
      .toSorted((a, b) => a.lead.leadId.localeCompare(b.lead.leadId));

    if (matches.length === 0) {
      return Promise.resolve(noResults(this.descriptor, now));
    }

    const leads: Lead[] = matches.slice(0, limit).map((f) => ({
      ...f.lead,
      // The rung is the one this call executed, not the one the fixture was authored at: the
      // same article really can be reached from more than one rung, and the record should say
      // how it was reached this time.
      rung,
      queryId,
      provenance: {
        adapterId: this.descriptor.adapterId,
        sourceId: this.descriptor.sourceId,
        parserVersion: this.descriptor.parserVersion,
        stabilityClass: this.descriptor.stabilityClass,
        mode: this.descriptor.mode,
        retrievedAt: now.toISOString(),
      },
    }));

    return Promise.resolve(ok(this.descriptor, now, leads));
  }
}
