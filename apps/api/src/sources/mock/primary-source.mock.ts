/**
 * The deterministic mock `PrimarySourcePort` — cascade rung 1.
 *
 * Its fixture corpus is three records, and each one is a case D0's Costa Rica dossier said
 * this phase will actually meet:
 *
 * - **A depersonalised judgment (D15).** The Poder Judicial publishes judgments through a
 *   de-identification protocol. The fixture carries `depersonalised: true` and an empty
 *   `subjectNames`, because that is what such a document is: not a weak match, but a document
 *   with no name in it to match. A pipeline that scores it as a non-match is claiming to have
 *   checked something it could not check.
 * - **A gazette notice that names a company but not a person.** The FR-02 graph is what makes
 *   it reachable at all, and it is the case where "no person named" must not become "no
 *   finding".
 * - **A designation listing marked `leadsOnly`.** FR-05 permits designation and notice lists
 *   as leads only. The flag is on the record so a downstream layer cannot treat it as a naming
 *   authority by forgetting which list it came from.
 */

import {
  assertJurisdictionCovered,
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
  PrimaryRecord,
  PrimaryRecordKind,
  PrimarySourcePort,
  PrimarySourceQuery,
} from '../primary-source.port.js';
import type { FailureSignal } from '@adverse-search/domain';

import { SHARED_NAME } from './registry-fixtures.js';

export const MOCK_PRIMARY_SOURCE_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'mock-primary-source',
  portKind: 'PRIMARY_SOURCE',
  sourceId: 'src-mock-primary',
  parserVersion: 'mock-1',
  stabilityClass: 'DOCUMENTED_STABLE',
  mode: 'MOCK',
  jurisdictions: ['CR'],
};

const UNKNOWN_DATE = { value: null, precision: 'UNKNOWN' } as const;

export const FIXTURE_PRIMARY_RECORDS: readonly PrimaryRecord[] = [
  {
    recordId: 'cr-judgment-0001',
    kind: 'COURT_JUDGMENT',
    jurisdiction: 'CR',
    url: 'https://nexuspj-example.poder-judicial.go.cr/sentencias/2024-000481',
    title: 'Sentencia 2024-000481',
    naming: {
      // D15: the names are stripped by the publisher's de-identification protocol.
      subjectNames: [],
      namingAuthority: 'Tribunal Penal del Segundo Circuito Judicial de San José',
      depersonalised: true,
    },
    eventDate: { value: '2024-05-20', precision: 'DAY' },
    publicationDate: { value: '2024-06-03', precision: 'DAY' },
    updateDate: UNKNOWN_DATE,
    language: 'es',
    companyRefs: [],
    authorityTier: 1,
    leadsOnly: false,
  },
  {
    recordId: 'cr-gazette-0001',
    kind: 'GAZETTE_NOTICE',
    jurisdiction: 'CR',
    url: 'https://boletin-example.go.cr/notificaciones/2024/03/18',
    title: 'Notificación en el expediente 24-000123-0042-PE',
    naming: {
      subjectNames: [SHARED_NAME],
      namingAuthority: 'Imprenta Nacional — Boletín Judicial',
      depersonalised: false,
    },
    eventDate: { value: '2024-03-18', precision: 'DAY' },
    publicationDate: { value: '2024-03-18', precision: 'DAY' },
    updateDate: UNKNOWN_DATE,
    language: 'es',
    companyRefs: ['CR-3101-100001'],
    authorityTier: 2,
    leadsOnly: false,
  },
  {
    recordId: 'mdb-debarment-0001',
    kind: 'DESIGNATION_LISTING',
    jurisdiction: 'CR',
    url: 'https://example-mdb.org/debarred/2023/entry-8812',
    title: 'Debarred entities and individuals — entry 8812',
    naming: {
      subjectNames: [SHARED_NAME],
      namingAuthority: 'Example Development Bank',
      depersonalised: false,
    },
    // A listing with no event date at all. FR-07: it stays null, and the retrieval time is
    // never written into it.
    eventDate: UNKNOWN_DATE,
    publicationDate: { value: '2023-11', precision: 'MONTH' },
    updateDate: UNKNOWN_DATE,
    language: 'en',
    companyRefs: [],
    authorityTier: 3,
    // FR-05: designation and notice lists are leads only.
    leadsOnly: true,
  },
];

export class MockPrimarySourceAdapter implements PrimarySourcePort {
  readonly descriptor = MOCK_PRIMARY_SOURCE_DESCRIPTOR;
  readonly recordKinds: readonly PrimaryRecordKind[] = [
    'COURT_JUDGMENT',
    'GAZETTE_NOTICE',
    'DESIGNATION_LISTING',
  ];

  private fault: FailureSignal | null = null;

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

  async search(query: PrimarySourceQuery): Promise<SourceOutcome<readonly PrimaryRecord[]>> {
    assertJurisdictionCovered(this.descriptor, query.jurisdiction);
    const now = this.clock();
    if (this.fault !== null) {
      return Promise.resolve(
        failed(
          this.descriptor,
          now,
          this.fault,
          `The injected fault for the primary-source fixture answered a search in ` +
            `${query.jurisdiction} with ${JSON.stringify(this.fault)}.`,
        ),
      );
    }

    const matches = FIXTURE_PRIMARY_RECORDS.filter((r) => {
      if (r.jurisdiction !== query.jurisdiction) {
        return false;
      }
      if (query.companyRef !== null) {
        return r.companyRefs.includes(query.companyRef);
      }
      // A depersonalised record can never be matched by name, by construction. It is reachable
      // only through a company reference or a direct fetch — which is the honest consequence of
      // D15 and not a gap in the mock.
      return r.naming.subjectNames.includes(query.name);
    }).toSorted((a, b) => a.recordId.localeCompare(b.recordId));

    if (matches.length === 0) {
      return Promise.resolve(noResults(this.descriptor, now));
    }
    return Promise.resolve(ok(this.descriptor, now, matches.slice(0, query.limit)));
  }

  async fetchRecord(recordId: string): Promise<SourceOutcome<PrimaryRecord>> {
    const now = this.clock();
    if (this.fault !== null) {
      return Promise.resolve(
        failed(
          this.descriptor,
          now,
          this.fault,
          `The injected fault for the primary-source fixture answered a fetch of ${recordId} ` +
            `with ${JSON.stringify(this.fault)}.`,
        ),
      );
    }
    const found = FIXTURE_PRIMARY_RECORDS.find((r) => r.recordId === recordId);
    return Promise.resolve(
      found === undefined ? noResults(this.descriptor, now) : ok(this.descriptor, now, found),
    );
  }
}
