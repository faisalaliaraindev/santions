import { describe, expect, it, vi } from 'vitest';

import type { SubjectVersion } from '@erly/adverse-contracts';

import { IndexedSourceSearchService } from '../src/sources/indexed/indexed-source-search.service.js';
import type {
  IndexedSourceRefreshState,
  StoredIndexedSourceRecord,
} from '../src/sources/indexed/indexed-source.types.js';

const NOW = new Date('2026-09-18T12:00:00.000Z');
const subject = (dob: string | null): SubjectVersion => ({
  subjectId: 'subject-1',
  subjectVersionId: 'subject-version-1',
  version: 1,
  tenantId: 'tenant-1',
  fullName: 'Alex Example',
  normalised: {
    folded: 'alex example',
    sortedCoreKey: 'alex example',
    phoneticKeys: [],
    scripts: ['LATIN'],
  },
  aliases: [],
  dateOfBirth: dob === null ? null : { value: dob, precision: 'DAY' },
  countryContext: ['US'],
  knownCompanies: [],
  externalSubjectRef: null,
  externalCaseRef: null,
  purpose: 'CUSTOMER_ONBOARDING',
  nameFrequencyPrior: null,
  createdAt: NOW.toISOString(),
  supersededAt: null,
});

const state = (overrides: Partial<IndexedSourceRefreshState> = {}): IndexedSourceRefreshState => ({
  sourceId: 'ofac-sdn',
  activeSourceVersion: 1,
  lastAttemptAt: NOW,
  lastSuccessfulRefreshAt: NOW,
  refreshStatus: 'SUCCEEDED',
  httpStatus: 200,
  artifactHash: 'artifact-hash',
  etag: 'etag',
  lastModified: null,
  parserVersion: 'ofac-legacy-xml-1',
  rowCount: 10_000,
  insertedCount: 10_000,
  updatedCount: 0,
  removedCount: 0,
  activeSnapshotVersion: 'ofac-sdn:snapshot',
  failureReason: null,
  freshness: 'CURRENT',
  nextRefreshDueAt: NOW,
  refreshLease: null,
  ...overrides,
});

const record = (dob: string | null): StoredIndexedSourceRecord => ({
  sourceId: 'ofac-sdn',
  sourceRecordId: '123',
  recordType: 'PERSON',
  primaryName: 'Alex Example',
  aliases: [],
  originalScriptNames: [],
  datesOfBirth: dob === null ? [] : [{ value: dob, precision: 'DAY' }],
  placesOfBirth: [],
  nationalities: ['US'],
  citizenships: [],
  countries: ['US'],
  addresses: [],
  identifiers: [],
  companyIdentifiers: [],
  listingDate: { value: '2026-01-01', precision: 'DAY' },
  programmes: ['TEST'],
  sanctionTypes: ['SDN'],
  grounds: null,
  status: 'LISTED',
  effectiveDate: null,
  expiryDate: null,
  publisherUrl: 'https://ofac.treasury.gov/',
  sourceDocumentUrl: 'https://example.test/sdn.xml',
  rawEvidence: { uid: '123' },
  sourceSnapshotVersion: 'ofac-sdn:snapshot',
  sourceVersion: 1,
  parserVersion: 'ofac-legacy-xml-1',
  retrievedAt: NOW,
  artifactHash: 'artifact-hash',
  nameKeys: ['alex example'],
  rawEvidenceHash: 'raw-hash',
  createdAt: NOW,
});

function service(refreshState: IndexedSourceRefreshState, candidate: StoredIndexedSourceRecord) {
  const repository = {
    listStates: vi.fn(() => Promise.resolve([refreshState])),
    search: vi.fn(() => Promise.resolve([candidate])),
  };
  const versions = {
    loadActive: vi.fn(() =>
      Promise.resolve({
        sourceId: 'ofac-sdn',
        versionId: 'ofac-sdn:v1',
        version: 1,
        sourceName: 'OFAC SDN',
        publisher: 'Office of Foreign Assets Control',
        authorityTier: 1,
        languages: ['en'],
      }),
    ),
  };
  return { search: new IndexedSourceSearchService(repository as never, versions as never), repository };
}

describe('local indexed-source tenant search', () => {
  it('keeps a name-only authority-list candidate ambiguous', async () => {
    const h = service(state(), record(null));
    const result = await h.search.search({
      tenantId: 'tenant-1',
      searchId: 'search-1',
      subject: subject(null),
      now: NOW,
    });

    expect(result.findings[0]?.band).toBe('AMBIGUOUS');
    expect(result.findings[0]?.document).toMatchObject({
      sourceId: 'ofac-sdn',
      sourceRecordId: '123',
      sourceSnapshotVersion: 'ofac-sdn:snapshot',
      parserVersion: 'ofac-legacy-xml-1',
      rawEvidenceHash: 'raw-hash',
    });
    expect(result.sourceOutcomes[0]?.outcome).toBe('COMPLETED');
  });

  it('supports a candidate when full DOB corroborates identity', async () => {
    const h = service(state(), record('1970-01-02'));
    const result = await h.search.search({
      tenantId: 'tenant-1',
      searchId: 'search-1',
      subject: subject('1970-01-02'),
      now: NOW,
    });

    expect(result.findings[0]?.band).toBe('SUPPORTED');
    expect(result.findings[0]?.axes.identity).toBe('CORROBORATED');
  });

  it('searches last-good data and reports partial coverage after refresh failure', async () => {
    const h = service(
      state({ refreshStatus: 'FAILED', failureReason: 'HTTP 503 from publisher' }),
      record(null),
    );
    const result = await h.search.search({
      tenantId: 'tenant-1',
      searchId: 'search-1',
      subject: subject(null),
      now: NOW,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.sourceOutcomes[0]?.outcome).toBe('PARTIAL');
    expect(result.sourceOutcomes[0]?.detail).toContain('last-known-good snapshot');
    expect(h.repository.search).toHaveBeenCalledTimes(1);
  });
});
