/**
 * The deterministic mock `CompanyRegistryPort`.
 *
 * It serves `registry-fixtures.ts` and nothing else, and it exists to make three things
 * assertable that a real register cannot be made to do on demand: fail, return nothing, and
 * return more than the bound allows. T20 asks for exactly those three and asks that they not
 * collapse into one another.
 *
 * **Determinism is a property of this class, not a hope.** Results are sorted by `officerRef`
 * and `companyRef` before being returned, the clock is injected and fixed, and nothing here
 * reads a random number. A mock with incidental ordering produces a graph test that fails once
 * a fortnight and looks like a resolution bug every time.
 *
 * **It cannot exist in a live process.** The constructor requires a `MockModeWitness`, which
 * cannot be obtained when the mode is `LIVE` (T55).
 */

import {
  assertJurisdictionCovered,
  bounded,
  failed,
  fixedMockClock,
  noResults,
  ok,
  type AdapterDescriptor,
  type Clock,
  type MockModeWitness,
  type SourceOutcome,
} from '../source-adapter.js';
import type {
  AppointmentsQuery,
  CompanyRegistryPort,
  Directorship,
  OfficerCandidate,
  OfficerSearchQuery,
  RegistryCompany,
} from '../company-registry.port.js';
import type { FailureSignal } from '@erly/adverse-domain';

import {
  FIXTURE_COMPANIES,
  FIXTURE_DIRECTORSHIPS,
  FIXTURE_JURISDICTION,
  FIXTURE_OFFICERS,
} from './registry-fixtures.js';

export const MOCK_COMPANY_REGISTRY_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'mock-company-registry',
  portKind: 'COMPANY_REGISTRY',
  sourceId: 'src-mock-cr-registry',
  parserVersion: 'mock-1',
  // The fixture corpus is as documented and stable as anything gets: it is a file in this
  // repository. Saying otherwise would make the stability class meaningless.
  stabilityClass: 'DOCUMENTED_STABLE',
  mode: 'MOCK',
  jurisdictions: [FIXTURE_JURISDICTION],
};

/**
 * What the mock should do next.
 *
 * A single nullable field rather than a set of booleans. The three T20 conditions are mutually
 * exclusive in a single call, and representing them as independent flags invites a test that
 * sets two and asserts whichever happens to win.
 */
export type MockRegistryFault = { readonly kind: 'FAIL'; readonly signal: FailureSignal } | null;

export class MockCompanyRegistryAdapter implements CompanyRegistryPort {
  readonly descriptor = MOCK_COMPANY_REGISTRY_DESCRIPTOR;

  private fault: MockRegistryFault = null;

  constructor(
    /**
     * Unused at runtime and required at compile time. Holding it is the point: a live-mode
     * process cannot produce one, so it cannot produce this adapter either.
     */
    _witness: MockModeWitness,
    private readonly clock: Clock = fixedMockClock,
  ) {}

  /** T20's first condition. Applies to every call until cleared. */
  failWith(signal: FailureSignal): void {
    this.fault = { kind: 'FAIL', signal };
  }

  clearFault(): void {
    this.fault = null;
  }

  async findOfficers(
    query: OfficerSearchQuery,
  ): Promise<SourceOutcome<readonly OfficerCandidate[]>> {
    assertJurisdictionCovered(this.descriptor, query.jurisdiction);
    const now = this.clock();
    if (this.fault !== null) {
      return Promise.resolve(failed(this.descriptor, now, this.fault.signal));
    }

    const matches = FIXTURE_OFFICERS.filter(
      (o) => o.jurisdiction === query.jurisdiction && o.name === query.name,
    ).toSorted((a, b) => a.officerRef.localeCompare(b.officerRef));

    // T20's second condition, and the one the whole outcome type exists for. The register
    // answered; its answer was "nobody". That is not a failure and it is not proof of absence.
    if (matches.length === 0) {
      return Promise.resolve(noResults(this.descriptor, now));
    }

    if (matches.length > query.limit) {
      // T20's third. The candidates that fit are still returned — discarding real associations
      // because there were too many of them is strictly worse than reporting them with the
      // bound stated.
      return Promise.resolve(
        bounded(this.descriptor, now, matches.slice(0, query.limit), {
          reason: 'BOUND_EXCEEDED',
          limit: query.limit,
          availableCount: matches.length,
        }),
      );
    }

    return Promise.resolve(ok(this.descriptor, now, matches));
  }

  async listAppointments(
    query: AppointmentsQuery,
  ): Promise<SourceOutcome<readonly Directorship[]>> {
    assertJurisdictionCovered(this.descriptor, query.jurisdiction);
    const now = this.clock();
    if (this.fault !== null) {
      return Promise.resolve(failed(this.descriptor, now, this.fault.signal));
    }

    const matches = FIXTURE_DIRECTORSHIPS.filter(
      (d) => d.officerRef === query.officerRef && d.jurisdiction === query.jurisdiction,
    ).toSorted((a, b) => a.companyRef.localeCompare(b.companyRef));

    if (matches.length === 0) {
      return Promise.resolve(noResults(this.descriptor, now));
    }
    if (matches.length > query.limit) {
      return Promise.resolve(
        bounded(this.descriptor, now, matches.slice(0, query.limit), {
          reason: 'BOUND_EXCEEDED',
          limit: query.limit,
          availableCount: matches.length,
        }),
      );
    }
    return Promise.resolve(ok(this.descriptor, now, matches));
  }

  async getCompany(
    companyRef: string,
    jurisdiction: string,
  ): Promise<SourceOutcome<RegistryCompany>> {
    assertJurisdictionCovered(this.descriptor, jurisdiction);
    const now = this.clock();
    if (this.fault !== null) {
      return Promise.resolve(failed(this.descriptor, now, this.fault.signal));
    }
    const found = FIXTURE_COMPANIES.find(
      (c) => c.companyRef === companyRef && c.jurisdiction === jurisdiction,
    );
    // A company identifier the register does not hold is `NO_RESULTS`, not a 404-shaped
    // failure: the register answered and said it has no such company. Treating it as a failure
    // would open a coverage gap for a question that was fully answered.
    return Promise.resolve(
      found === undefined ? noResults(this.descriptor, now) : ok(this.descriptor, now, found),
    );
  }
}
