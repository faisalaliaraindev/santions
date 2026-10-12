/**
 * The deterministic mock `NewsDiscoveryPort`.
 *
 * Serves `discovery-fixtures.ts` for rungs 2–4. Two behaviours are worth reading before using
 * it in a test.
 *
 * **It honours the window as a gate, not as a hint.** FR-06 lists "publication date inside the
 * requested window" as a gate among the relevance signals. A lead whose publication date is
 * null cannot satisfy a gate on publication date — so when a window is set, the undated fixture
 * lead is excluded, and when no window is set it is included. Code that treats a null date as
 * "probably fine" passes the second case and fails the first, which is the point.
 *
 * **Its contract probe can be made to fail.** `simulateShapeChange` makes `contractProbe`
 * report an unstable shape with zero parsed items — the exact signature of the failure FR-05's
 * volatility paragraph is written against, where nothing errors and recall silently becomes
 * zero. Phase E's scheduled contract test needs something to prove it can detect that, and a
 * real Google News RSS feed cannot be asked to change shape on demand.
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
import type { DiscoveryQuery, Lead } from '../lead.js';
import type { ContractProbeResult, NewsDiscoveryPort } from '../news-discovery.port.js';
import type { FailureSignal } from '@adverse-search/domain';

import { FIXTURE_LEADS, queryMatchesFixture } from './discovery-fixtures.js';

export const MOCK_NEWS_DISCOVERY_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'mock-news-discovery',
  portKind: 'NEWS_DISCOVERY',
  sourceId: 'src-mock-news-discovery',
  parserVersion: 'mock-1',
  stabilityClass: 'DOCUMENTED_STABLE',
  mode: 'MOCK',
  jurisdictions: ['CR'],
};

/** Rungs this mock serves. Rung 5 and 6 belong to `MockWebDiscoveryAdapter`. */
const NEWS_RUNGS = new Set([2, 3, 4]);

export class MockNewsDiscoveryAdapter implements NewsDiscoveryPort {
  readonly descriptor = MOCK_NEWS_DISCOVERY_DESCRIPTOR;
  readonly editions: readonly string[] = ['CR'];

  private fault: FailureSignal | null = null;
  private shapeChanged = false;

  constructor(
    _witness: MockModeWitness,
    private readonly clock: Clock = fixedMockClock,
  ) {}

  failWith(signal: FailureSignal): void {
    this.fault = signal;
  }

  clearFault(): void {
    this.fault = null;
  }

  /** Make the source keep answering while the parse silently stops finding anything. */
  simulateShapeChange(changed: boolean): void {
    this.shapeChanged = changed;
  }

  async discover(query: DiscoveryQuery): Promise<SourceOutcome<readonly Lead[]>> {
    const now = this.clock();
    if (this.fault !== null) {
      return Promise.resolve(
        failed(
          this.descriptor,
          now,
          this.fault,
          `The injected fault for the news discovery fixture answered the query for ` +
            `"${query.text}" with ${JSON.stringify(this.fault)}.`,
        ),
      );
    }

    // The shape-change failure mode, exactly as it presents in production: HTTP 200, a body
    // that parses, and zero items. Nothing here throws, and that is the whole problem.
    if (this.shapeChanged) {
      return Promise.resolve(noResults(this.descriptor, now));
    }

    const matches = FIXTURE_LEADS.filter(
      (f) => NEWS_RUNGS.has(f.rung) && queryMatchesFixture(query.text, f.requires),
    )
      .filter((f) => withinWindow(f.lead.publishedAt.value, query.window))
      .filter((f) => query.language === null || f.lead.language === query.language)
      .toSorted((a, b) => a.lead.leadId.localeCompare(b.lead.leadId));

    if (matches.length === 0) {
      return Promise.resolve(noResults(this.descriptor, now));
    }

    const leads: Lead[] = matches.slice(0, query.limit).map((f) => ({
      ...f.lead,
      rung: f.rung,
      queryId: query.queryId,
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

  async contractProbe(): Promise<ContractProbeResult> {
    const now = this.clock();
    if (this.shapeChanged) {
      return Promise.resolve({
        adapterId: this.descriptor.adapterId,
        parserVersion: this.descriptor.parserVersion,
        checkedAt: now.toISOString(),
        shapeStable: false,
        fieldsMissing: ['item/title', 'item/pubDate'],
        sampleParsedCount: 0,
        detail:
          'The response parsed but yielded no items. A source that answers with zero items ' +
          'for a query known to have results is a parse failure, not an empty news cycle.',
      });
    }
    return Promise.resolve({
      adapterId: this.descriptor.adapterId,
      parserVersion: this.descriptor.parserVersion,
      checkedAt: now.toISOString(),
      shapeStable: true,
      fieldsMissing: [],
      sampleParsedCount: FIXTURE_LEADS.length,
      detail: '',
    });
  }
}

/**
 * The window gate.
 *
 * A null publication date fails a window gate. It does not "pass because we cannot tell" —
 * that reading admits undated items into a date-bounded search and then reports the search as
 * having been date-bounded.
 */
export function withinWindow(
  date: string | null,
  window: { readonly from: string; readonly to: string } | null,
): boolean {
  if (window === null) {
    return true;
  }
  if (date === null) {
    return false;
  }
  return date >= window.from && date <= window.to;
}
