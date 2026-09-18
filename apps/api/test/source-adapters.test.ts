/**
 * Phase D step D2 — the six FR-05 seams, their deterministic mocks, and the mode rule.
 *
 * The properties asserted here are the ones that, if they broke, would break quietly: a mock
 * reachable in live mode, an ordering that drifts, a bound that silently truncates, an empty
 * answer that reads as a failure. None of those throw on their own.
 */

import { describe, expect, it } from 'vitest';

import {
  CompaniesHouseAdapter,
  extractOfficerId,
  normaliseCompanyStatus,
  parseRegisterDate,
} from '../src/sources/companies-house.adapter.js';
import type { Directorship } from '../src/sources/company-registry.port.js';
import { MockCompanyRegistryAdapter } from '../src/sources/mock/company-registry.mock.js';
import { MockEvidenceFetchAdapter } from '../src/sources/mock/evidence-fetch.mock.js';
import { MockExtractionModelAdapter } from '../src/sources/mock/extraction-model.mock.js';
import { MockNewsDiscoveryAdapter } from '../src/sources/mock/news-discovery.mock.js';
import { MockPrimarySourceAdapter } from '../src/sources/mock/primary-source.mock.js';
import { MockWebDiscoveryAdapter } from '../src/sources/mock/web-discovery.mock.js';
import {
  DISCOVERY_QUERY_WITH_NO_RESULTS,
  DISCOVERY_QUERY_WITH_RESULTS,
} from '../src/sources/mock/discovery-fixtures.js';
import {
  ABSENT_NAME,
  HIGH_FREQUENCY_NAME,
  SHARED_NAME,
  TENURE_PROBE_EVENTS,
  TENURE_SUBJECT_NAME,
} from '../src/sources/mock/registry-fixtures.js';
import {
  MOCK_CLOCK_INSTANT,
  MockModeWitness,
  hasData,
  leavesCoverageIncomplete,
  type SourceOutcome,
} from '../src/sources/source-adapter.js';
import { buildSourceAdapters } from '../src/sources/sources.registry.js';
import { labelTenure } from '@erly/adverse-domain';

const witness = MockModeWitness.require('MOCK');

function registry(): MockCompanyRegistryAdapter {
  return new MockCompanyRegistryAdapter(witness);
}

/** Unwrap data or fail the test with the status that actually came back. */
function dataOf<T>(outcome: SourceOutcome<T>): T {
  if (!hasData(outcome)) {
    throw new Error(`expected data, got ${outcome.status}`);
  }
  return outcome.data;
}

describe('the mode rule', () => {
  it('cannot produce a mock-mode witness in live mode', () => {
    expect(MockModeWitness.forMode('LIVE')).toBeNull();
    expect(MockModeWitness.forMode('MOCK')).not.toBeNull();
  });

  it('refuses to build mock adapters in live mode, at the composition root', () => {
    // The whole point of the witness: a live process cannot reach a mock adapter even if every
    // per-adapter check were deleted, because there is no value that would let it construct one.
    const live = buildSourceAdapters({
      mode: 'LIVE',
      companiesHouseApiKey: null,
      fetchContactUrl: null,
    });
    // Empty, not null: the discovery seams are lists now (D-045). The distinction the old
    // assertion carried is preserved — nothing mock is reachable — and an empty list is what
    // makes every rung those seams would serve report as **unsearched** rather than as searched
    // and empty.
    expect(live.newsDiscovery).toHaveLength(0);
    expect(live.webDiscovery).toHaveLength(0);
    expect(live.primarySource).toBeNull();
    // Extraction has a live adapter as of D-048, and it is emphatically **not** the mock: it is
    // the rule-based extractor, stamped LIVE. The null it replaced was honest and produced a
    // dishonest result — every document rejected at EXTRACTION, reported as NO_MATCHES_FOUND.
    expect(live.extractionModel?.descriptor.adapterId).toBe('rule-based-extraction');
    expect(live.extractionModel?.descriptor.mode).toBe('LIVE');
    // Null model id, truthfully: no model participated. FR-07 requires the attribution to be
    // pinned, and naming a model that did not answer would be worse than naming none.
    expect(live.extractionModel?.modelId).toBeNull();
    expect(live.extractionModel?.promptVersion).toBeNull();
    // Null rather than mocked — an unavailable capability, not an empty one.
    expect(live.companyRegistry).toBeNull();
    // The live fetch adapter exists as of Phase E step 1, but it is not constructed without a
    // contact URL and a source-health service. Neither is defaulted: an anonymous crawler and
    // an unthrottled one are both things the requirements forbid rather than degraded modes.
    expect(live.evidenceFetch).toBeNull();
  });

  it('gives a live process the real GB registry when a key is configured', () => {
    const live = buildSourceAdapters({
      mode: 'LIVE',
      companiesHouseApiKey: 'ch-key',
      fetchContactUrl: null,
    });
    expect(live.companyRegistry?.descriptor.adapterId).toBe('companies-house-gb');
    expect(live.companyRegistry?.descriptor.mode).toBe('LIVE');
    // GB, not CR. This is the assertion that stops a UK adapter reading as Costa Rican
    // coverage — see the adapter's file header and D14.
    expect(live.companyRegistry?.descriptor.jurisdictions).toEqual(['GB']);
  });

  it('gives a mock process all six seams, every one stamped MOCK', () => {
    const mock = buildSourceAdapters({
      mode: 'MOCK',
      companiesHouseApiKey: null,
      fetchContactUrl: null,
    });
    const all = [
      // The discovery seams are lists now — the FR-05 ladder has several rungs and each is
      // served by whichever approved sources record it (D-045).
      ...mock.newsDiscovery,
      ...mock.webDiscovery,
      mock.primarySource,
      mock.companyRegistry,
      mock.evidenceFetch,
      mock.extractionModel,
    ];
    expect(all.every((a) => a !== null)).toBe(true);
    for (const adapter of all) {
      expect(adapter?.descriptor.mode).toBe('MOCK');
    }
  });
});

describe('every adapter declares a parser version and a stability class (FR-05)', () => {
  it('does so on all six mocks and on the real adapter', () => {
    const mock = buildSourceAdapters({
      mode: 'MOCK',
      companiesHouseApiKey: null,
      fetchContactUrl: null,
    });
    const descriptors = [
      ...mock.newsDiscovery.map((port) => port.descriptor),
      ...mock.webDiscovery.map((port) => port.descriptor),
      mock.primarySource?.descriptor,
      mock.companyRegistry?.descriptor,
      mock.evidenceFetch?.descriptor,
      mock.extractionModel?.descriptor,
      new CompaniesHouseAdapter({ apiKey: 'k' }).descriptor,
    ];
    expect(descriptors).toHaveLength(7);
    for (const d of descriptors) {
      expect(d?.parserVersion).toMatch(/\S/);
      expect(['DOCUMENTED_STABLE', 'UNDOCUMENTED_VOLATILE']).toContain(d?.stabilityClass);
      expect(d?.jurisdictions.length).toBeGreaterThan(0);
    }
  });
});

describe('T20 — outage, empty answer and bound stay three different things', () => {
  it('reports a registry outage as FAILED, classified by the FR-06 table', async () => {
    const adapter = registry();
    adapter.failWith({ httpStatus: 503 });
    const outcome = await adapter.findOfficers({
      tenantId: 't',
      jurisdiction: 'CR',
      name: SHARED_NAME,
      limit: 10,
    });
    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.policy.failureClass).toBe('TRANSIENT_NETWORK');
      expect(outcome.policy.retryable).toBe(true);
    }
    expect(leavesCoverageIncomplete(outcome)).toBe(true);
  });

  it('reports an empty register answer as NO_RESULTS, which is not a coverage gap', async () => {
    const outcome = await registry().findOfficers({
      tenantId: 't',
      jurisdiction: 'CR',
      name: ABSENT_NAME,
      limit: 10,
    });
    expect(outcome.status).toBe('NO_RESULTS');
    // FR-02: no result from a registry does not prove no associations exist — but the register
    // did answer, so this is not an incomplete-coverage condition either. Both halves matter.
    expect(leavesCoverageIncomplete(outcome)).toBe(false);
    expect(hasData(outcome)).toBe(false);
  });

  it('reports a traversal past its bound as BOUNDED, keeping what fit and the true count', async () => {
    const outcome = await registry().findOfficers({
      tenantId: 't',
      jurisdiction: 'CR',
      name: HIGH_FREQUENCY_NAME,
      limit: 5,
    });
    expect(outcome.status).toBe('BOUNDED');
    if (outcome.status === 'BOUNDED') {
      expect(outcome.data).toHaveLength(5);
      expect(outcome.truncation.reason).toBe('BOUND_EXCEEDED');
      expect(outcome.truncation.availableCount).toBe(12);
    }
    expect(leavesCoverageIncomplete(outcome)).toBe(true);
  });

  it('keeps the three statuses distinguishable from one another', async () => {
    const adapter = registry();
    const empty = await adapter.findOfficers({
      tenantId: 't',
      jurisdiction: 'CR',
      name: ABSENT_NAME,
      limit: 5,
    });
    const overBound = await adapter.findOfficers({
      tenantId: 't',
      jurisdiction: 'CR',
      name: HIGH_FREQUENCY_NAME,
      limit: 5,
    });
    adapter.failWith({ httpStatus: 500 });
    const broken = await adapter.findOfficers({
      tenantId: 't',
      jurisdiction: 'CR',
      name: HIGH_FREQUENCY_NAME,
      limit: 5,
    });
    expect(new Set([empty.status, overBound.status, broken.status]).size).toBe(3);
  });
});

describe('T14 — two officers who share a name', () => {
  it('returns both, distinguished only by their identifiers', async () => {
    const candidates = dataOf(
      await registry().findOfficers({
        tenantId: 't',
        jurisdiction: 'CR',
        name: SHARED_NAME,
        limit: 10,
      }),
    );
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((c) => c.name))).toEqual(new Set([SHARED_NAME]));
    expect(new Set(candidates.map((c) => c.officerRef)).size).toBe(2);

    const births = candidates.map(
      (c) => c.identifiers.find((i) => i.kind === 'DATE_OF_BIRTH')?.value,
    );
    expect(new Set(births).size).toBe(2);
    // Partial, as a register publishes it. If this ever became a full date the test would be
    // proving something easier than the real case.
    expect(
      candidates.every((c) => c.identifiers.every((i) => i.kind !== 'DATE_OF_BIRTH' || i.partial)),
    ).toBe(true);
  });

  it('carries nothing an adapter could use to attach a company', async () => {
    const candidates = dataOf(
      await registry().findOfficers({
        tenantId: 't',
        jurisdiction: 'CR',
        name: SHARED_NAME,
        limit: 10,
      }),
    );
    // FR-02: unresolved officers must not attach companies automatically. There is no score,
    // no confidence and no match flag on the candidate — the type has no room for one, and
    // this asserts it stays that way.
    for (const candidate of candidates) {
      expect(Object.keys(candidate).toSorted()).toEqual([
        'appointmentCount',
        'identifiers',
        'jurisdiction',
        'name',
        'officerRef',
      ]);
    }
  });

  it('gives the two officers disjoint companies, so a wrong attachment is nameable', async () => {
    const adapter = registry();
    const candidates = dataOf(
      await adapter.findOfficers({
        tenantId: 't',
        jurisdiction: 'CR',
        name: SHARED_NAME,
        limit: 10,
      }),
    );
    const companies: string[][] = [];
    for (const candidate of candidates) {
      const appointments = await adapter.listAppointments({
        tenantId: 't',
        officerRef: candidate.officerRef,
        jurisdiction: 'CR',
        limit: 10,
      });
      companies.push(dataOf(appointments).map((d) => d.companyRef));
    }
    expect(companies[0]).not.toEqual(companies[1]);
    expect(companies[0]?.some((c) => companies[1]?.includes(c))).toBe(false);
  });

  it('publishes an appointment count for one officer and not the other', async () => {
    const candidates = dataOf(
      await registry().findOfficers({
        tenantId: 't',
        jurisdiction: 'CR',
        name: SHARED_NAME,
        limit: 10,
      }),
    );
    // Registers vary. Code that decides whether a traversal will exceed its bound by reading
    // this field must cope with the register that does not say.
    expect(candidates.map((c) => c.appointmentCount)).toContain(null);
    expect(candidates.some((c) => c.appointmentCount !== null)).toBe(true);
  });
});

describe('T15 — tenure labels across the fixture directorships', () => {
  /** Found by name, not by a hard-coded ref: the fixture's own search has to work too. */
  async function tenureSubjectAppointments(): Promise<readonly Directorship[]> {
    const adapter = registry();
    const candidates = dataOf(
      await adapter.findOfficers({
        tenantId: 't',
        jurisdiction: 'CR',
        name: TENURE_SUBJECT_NAME,
        limit: 10,
      }),
    );
    expect(candidates).toHaveLength(1);
    const officerRef = candidates[0]?.officerRef ?? '';
    return dataOf(
      await adapter.listAppointments({
        tenantId: 't',
        officerRef,
        jurisdiction: 'CR',
        limit: 20,
      }),
    );
  }

  it('produces all five labels from the one officer', async () => {
    const appointments = dataOf(
      await registry().listAppointments({
        tenantId: 't',
        officerRef: 'cr-officer-0003',
        jurisdiction: 'CR',
        limit: 20,
      }),
    );
    expect(appointments).toHaveLength(5);
    // The same five, reached by name rather than by ref.
    expect((await tenureSubjectAppointments()).map((a) => a.companyRef)).toEqual(
      appointments.map((a) => a.companyRef),
    );

    const labels = TENURE_PROBE_EVENTS.map((probe) => {
      const appointment = appointments.find((a) => a.companyRef === probe.companyRef);
      if (appointment === undefined) {
        throw new Error(`fixture missing directorship for ${probe.companyRef}`);
      }
      return {
        companyRef: probe.companyRef,
        expected: probe.expected,
        actual: labelTenure(appointment.tenure, probe.event),
      };
    });

    for (const { companyRef, expected, actual } of labels) {
      expect(`${companyRef}:${actual}`).toBe(`${companyRef}:${expected}`);
    }
    expect(new Set(labels.map((l) => l.actual)).size).toBe(5);
  });

  it('includes a YEAR-precision appointment and a directorship with no resignation', async () => {
    const appointments = dataOf(
      await registry().listAppointments({
        tenantId: 't',
        officerRef: 'cr-officer-0003',
        jurisdiction: 'CR',
        limit: 20,
      }),
    );
    expect(appointments.some((a) => a.tenure.appointedOn.precision === 'YEAR')).toBe(true);
    expect(appointments.some((a) => a.tenure.resignedOn.value === null)).toBe(true);
  });

  it('does not call a year-precision appointment DURING_TENURE for an event inside that year', async () => {
    // The trap this fixture row exists for: the event falls inside the calendar year of the
    // appointment, and a comparison that ignores precision attaches it to a person who may
    // have been appointed five months later.
    const appointments = dataOf(
      await registry().listAppointments({
        tenantId: 't',
        officerRef: 'cr-officer-0003',
        jurisdiction: 'CR',
        limit: 20,
      }),
    );
    const yearPrecision = appointments.find((a) => a.tenure.appointedOn.precision === 'YEAR');
    if (yearPrecision === undefined) {
      throw new Error('fixture no longer contains a YEAR-precision appointment');
    }
    expect(
      labelTenure(yearPrecision.tenure, {
        start: { value: '2019-07-01', precision: 'DAY' },
        end: { value: '2019-07-01', precision: 'DAY' },
      }),
    ).toBe('UNKNOWN');
  });

  it('records an observed date on every edge (FR-02)', async () => {
    const appointments = dataOf(
      await registry().listAppointments({
        tenantId: 't',
        officerRef: 'cr-officer-0003',
        jurisdiction: 'CR',
        limit: 20,
      }),
    );
    expect(appointments.every((a) => a.observedAt !== '')).toBe(true);
  });
});

describe('determinism', () => {
  it('returns identical results, in identical order, for identical input', async () => {
    const a = dataOf(
      await registry().findOfficers({
        tenantId: 't',
        jurisdiction: 'CR',
        name: HIGH_FREQUENCY_NAME,
        limit: 12,
      }),
    );
    const b = dataOf(
      await registry().findOfficers({
        tenantId: 't',
        jurisdiction: 'CR',
        name: HIGH_FREQUENCY_NAME,
        limit: 12,
      }),
    );
    expect(a).toEqual(b);
    expect(a.map((c) => c.officerRef)).toEqual(a.map((c) => c.officerRef).toSorted());
  });

  it('stamps a fixed retrieval time, so provenance does not drift with the calendar', async () => {
    const outcome = await registry().findOfficers({
      tenantId: 't',
      jurisdiction: 'CR',
      name: SHARED_NAME,
      limit: 10,
    });
    expect(outcome.provenance.retrievedAt).toBe(MOCK_CLOCK_INSTANT);
    expect(outcome.provenance.mode).toBe('MOCK');
  });
});

describe('jurisdiction is never inferred', () => {
  it('refuses an out-of-jurisdiction question rather than reporting a coverage gap', async () => {
    // A throw, not a FAILED outcome. Asking a CR fixture about GB is a programming error;
    // recording it as a gap would put a line in a coverage statement for an attempt never made.
    await expect(
      registry().findOfficers({ tenantId: 't', jurisdiction: 'GB', name: SHARED_NAME, limit: 5 }),
    ).rejects.toThrow(/covers \[CR\]/);
  });

  it('refuses a Costa Rican question of the British adapter', async () => {
    const adapter = new CompaniesHouseAdapter({ apiKey: 'k' });
    await expect(
      adapter.findOfficers({ tenantId: 't', jurisdiction: 'CR', name: SHARED_NAME, limit: 5 }),
    ).rejects.toThrow(/covers \[GB\]/);
  });
});

/**
 * The run context every discovery query carries.
 *
 * The mocks ignore it — they read a fixture — and it is required of them anyway, because an
 * optional gate context is a gate somebody forgets. A live connector authorises its own poll
 * against exactly this.
 */
const TEST_RUN_CONTEXT = {
  jobId: 'job-1',
  subjectId: 'subject-1',
  jurisdictions: ['CR'],
  languages: ['es', 'en'],
  taxonomy: {
    taxonomyVersionId: 't:v1',
    version: 1,
    tenantId: 't',
    categories: [],
    lexicon: [],
    languages: [],
    status: 'ACTIVE' as const,
    proposedBy: 'test',
    approvedBy: 'test',
    activatedAt: '2026-01-01T00:00:00.000Z',
  },
};

describe('news discovery', () => {
  function news(): MockNewsDiscoveryAdapter {
    return new MockNewsDiscoveryAdapter(witness);
  }

  const baseQuery = {
    tenantId: 't',
    // Required of mocks too, and ignored by them. A live connector authorises its own poll
    // against this; making it optional would make the gate something a caller can forget.
    run: TEST_RUN_CONTEXT,
    queryId: 'q1',
    family: 'F1' as const,
    text: DISCOVERY_QUERY_WITH_RESULTS,
    language: null,
    country: 'CR',
    window: null,
    limit: 10,
  };

  it('returns leads carrying the rung they were found at and the query that found them', async () => {
    const leads = dataOf(await news().discover(baseQuery));
    expect(leads.length).toBeGreaterThan(0);
    expect(leads.every((l) => l.queryId === 'q1')).toBe(true);
    expect(leads.every((l) => [2, 3, 4].includes(l.rung))).toBe(true);
    expect(leads.every((l) => l.provenance.mode === 'MOCK')).toBe(true);
  });

  it('never synthesises a snippet the publisher did not write', async () => {
    const leads = dataOf(await news().discover(baseQuery));
    const sparse = leads.find((l) => l.leadId === 'lead-sparse-0001');
    expect(sparse?.snippet).toBeNull();
    expect(sparse?.publishedAt.value).toBeNull();
    expect(sparse?.publishedAt.precision).toBe('UNKNOWN');
  });

  it('treats the date window as a gate, so an undated lead does not slip through it', async () => {
    const windowed = dataOf(
      await news().discover({ ...baseQuery, window: { from: '2024-01-01', to: '2024-12-31' } }),
    );
    expect(windowed.some((l) => l.leadId === 'lead-sparse-0001')).toBe(false);
    expect(windowed.length).toBeGreaterThan(0);
  });

  it('reports an empty news result as NO_RESULTS', async () => {
    const outcome = await news().discover({
      ...baseQuery,
      text: DISCOVERY_QUERY_WITH_NO_RESULTS,
    });
    expect(outcome.status).toBe('NO_RESULTS');
  });

  it('detects a silent shape change, which otherwise looks like a quiet news cycle', async () => {
    const adapter = news();
    expect((await adapter.contractProbe()).shapeStable).toBe(true);

    adapter.simulateShapeChange(true);
    const outcome = await adapter.discover(baseQuery);
    // Nothing threw. Zero leads for a query that has four. This is the failure mode.
    expect(outcome.status).toBe('NO_RESULTS');

    const probe = await adapter.contractProbe();
    expect(probe.shapeStable).toBe(false);
    expect(probe.sampleParsedCount).toBe(0);
    expect(probe.fieldsMissing.length).toBeGreaterThan(0);
  });
});

describe('web discovery', () => {
  const baseQuery = {
    tenantId: 't',
    run: TEST_RUN_CONTEXT,
    queryId: 'q1',
    family: 'F1' as const,
    text: DISCOVERY_QUERY_WITH_RESULTS,
    language: null,
    country: 'CR',
    window: null,
    limit: 10,
  };

  it('refuses a rung-5 query that does not name its engine mix', async () => {
    const adapter = new MockWebDiscoveryAdapter(witness);
    await expect(adapter.search({ ...baseQuery, engines: [] })).rejects.toThrow(/engine mix/);
  });

  it('refuses an engine the instance does not have enabled', async () => {
    const adapter = new MockWebDiscoveryAdapter(witness);
    await expect(adapter.search({ ...baseQuery, engines: ['brave'] })).rejects.toThrow(
      /not enabled/,
    );
  });

  it('refuses a direct site search on an unapproved domain', async () => {
    const adapter = new MockWebDiscoveryAdapter(witness);
    await expect(
      adapter.siteSearch({ ...baseQuery, domain: 'discovered-example.cr' }),
    ).rejects.toThrow(/remains a lead/);
  });

  it('searches an approved domain and labels the lead at rung 6', async () => {
    const adapter = new MockWebDiscoveryAdapter(witness);
    const leads = dataOf(
      await adapter.siteSearch({ ...baseQuery, domain: 'boletin-example.go.cr' }),
    );
    expect(leads).toHaveLength(1);
    expect(leads[0]?.rung).toBe(6);
    expect(leads[0]?.publisherDomain).toBe('boletin-example.go.cr');
  });
});

describe('primary sources', () => {
  function primary(): MockPrimarySourceAdapter {
    return new MockPrimarySourceAdapter(witness);
  }

  it('marks a depersonalised judgment as such rather than as a non-match (D15)', async () => {
    const record = await primary().fetchRecord('cr-judgment-0001');
    const data = dataOf(record);
    expect(data.naming.depersonalised).toBe(true);
    expect(data.naming.subjectNames).toEqual([]);
    // There is no name in it to match. A pipeline that scored this as "not this person" would
    // be claiming to have checked something it could not check.
  });

  it('marks a designation listing as leads-only (FR-05)', async () => {
    const data = dataOf(await primary().fetchRecord('mdb-debarment-0001'));
    expect(data.leadsOnly).toBe(true);
    expect(data.eventDate.value).toBeNull();
    expect(data.publicationDate.precision).toBe('MONTH');
  });

  it('reaches a company-anchored record through the graph, not through the name', async () => {
    const data = dataOf(
      await primary().search({
        tenantId: 't',
        queryId: 'q1',
        jurisdiction: 'CR',
        name: 'irrelevant',
        companyRef: 'CR-3101-100001',
        window: null,
        limit: 10,
      }),
    );
    expect(data.map((r) => r.recordId)).toEqual(['cr-gazette-0001']);
  });

  it('carries no category — classification happens under the pinned taxonomy, later', async () => {
    const data = dataOf(await primary().fetchRecord('cr-gazette-0001'));
    expect(Object.keys(data)).not.toContain('category');
    expect(Object.keys(data)).not.toContain('categoryId');
  });
});

describe('evidence fetch', () => {
  const attribution = {
    tenantId: 't',
    jobId: 'j',
    subjectId: 's',
    queryId: 'q',
    sourceId: 'src',
    egressIdentityId: 'egress-1',
  };
  const authorisation = {
    sourceVersionId: 'sv-1',
    licenceTermsVersion: 'terms-1',
    robotsPosition: 'HONOURED' as const,
    robotsExceptionApprovedBy: null,
    requestCeilingPerSecond: null,
    jurisdictionEnabled: true,
    languageEnabled: true,
    urlPolicyPassed: true,
    ssrfValidated: true,
    relevanceScore: 0.8,
    relevanceMethod: 'TEST_FIXTURE',
    issuedBy: 'FetchGateService',
    issuedAt: '2026-01-01T00:00:00.000Z',
  };
  const budget = {
    maxBytes: 1_000_000,
    maxDecompressedBytes: 5_000_000,
    maxRedirects: 3,
    timeoutMs: 5000,
  };
  const url = 'https://www.nacion-example.cr/sucesos/caso-talamanca-2024';
  const request = {
    url,
    attribution,
    authorisation,
    budget,
    conditional: { etag: null, lastModified: null },
    fetchKey: 'fk-1',
    allowRender: false,
  };

  function fetcher(): MockEvidenceFetchAdapter {
    return new MockEvidenceFetchAdapter(witness);
  }

  it('fetches when every gate has passed', async () => {
    const result = dataOf(await fetcher().fetch(request));
    expect(result.httpStatus).toBe(200);
    expect(result.body).not.toBeNull();
    expect(result.renderTrigger).toBeNull();
  });

  it('refuses a fetch whose robots position was never established', async () => {
    await expect(
      fetcher().fetch({
        ...request,
        authorisation: { ...authorisation, robotsPosition: 'NOT_ESTABLISHED' },
      }),
    ).rejects.toThrow(/robots position not established/);
  });

  it('refuses a robots exception that nobody approved', async () => {
    await expect(
      fetcher().fetch({
        ...request,
        authorisation: {
          ...authorisation,
          robotsPosition: 'EXCEPTION_APPROVED',
          robotsExceptionApprovedBy: null,
          requestCeilingPerSecond: null,
        },
      }),
    ).rejects.toThrow(/approved by nobody/);
  });

  it('refuses an unattributable request (FR-06: that is a defect)', async () => {
    await expect(
      fetcher().fetch({ ...request, attribution: { ...attribution, jobId: '' } }),
    ).rejects.toThrow(/Unattributable/);
  });

  it('distinguishes a 304 from an empty document', async () => {
    const adapter = fetcher();
    adapter.markNotModified(url);
    const result = dataOf(await adapter.fetch(request));
    expect(result.notModified).toBe(true);
    expect(result.httpStatus).toBe(304);
    // Null, not an empty buffer. An empty body here would be stored over a good version.
    expect(result.body).toBeNull();
  });

  it('aborts an oversize body as a non-retryable OVERSIZE failure', async () => {
    const outcome = await fetcher().fetch({ ...request, budget: { ...budget, maxBytes: 10 } });
    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.policy.failureClass).toBe('OVERSIZE');
      expect(outcome.policy.retryable).toBe(false);
    }
  });
});

describe('extraction', () => {
  function extractor(): MockExtractionModelAdapter {
    return new MockExtractionModelAdapter(witness);
  }

  const text =
    'La Fiscalía presentó acusación formal contra María Fernanda Solís Rojas por presunto ' +
    'fraude en Inversiones Talamanca S.A.';

  const input = {
    documentId: 'doc-1',
    documentVersion: 1,
    text,
    language: 'es',
    subjectNameForms: [SHARED_NAME],
    taxonomyVersionId: 'tax-1',
    enabledCategoryIds: ['FRAUD_FINANCIAL_CRIME'],
  };

  it('emits spans that point at the text they came from', async () => {
    const [assertion] = dataOf(await extractor().extract(input));
    expect(assertion).toBeDefined();
    const span = assertion?.subjectMentionSpans[0];
    expect(span).toBeDefined();
    expect(text.slice(span?.start ?? 0, span?.end ?? 0)).toBe(SHARED_NAME);
    const conduct = assertion?.conductSpan;
    expect(text.slice(conduct?.start ?? 0, conduct?.end ?? 0).toLowerCase()).toBe('fraude');
  });

  it('labels itself honestly as a rule-based extraction, with no model id', async () => {
    const [assertion] = dataOf(await extractor().extract(input));
    expect(assertion?.modelId).toBeNull();
    expect(assertion?.promptVersion).toBeNull();
    expect(assertion?.extractorVersion).toMatch(/\S/);
  });

  it('never backfills a missing date with the retrieval time (FR-07)', async () => {
    const [assertion] = dataOf(await extractor().extract(input));
    expect(assertion?.eventDate.value).toBeNull();
    expect(assertion?.publicationDate.value).toBeNull();
  });

  it('refuses to reclassify into the nearest enabled category', async () => {
    // The document is about fraud. The tenant has only bribery enabled. The answer is no
    // assertion, not a bribery assertion.
    const outcome = await extractor().extract({
      ...input,
      enabledCategoryIds: ['BRIBERY_CORRUPTION'],
    });
    expect(outcome.status).toBe('NO_RESULTS');
  });

  it('reports a document that does not name the subject as NO_RESULTS, not a failure', async () => {
    const outcome = await extractor().extract({ ...input, subjectNameForms: ['Otra Persona'] });
    expect(outcome.status).toBe('NO_RESULTS');
  });

  it('picks the more specific stage when two keywords overlap', async () => {
    const [assertion] = dataOf(await extractor().extract(input));
    expect(assertion?.proceduralStage).toBe('CHARGE_INDICTMENT');
    expect(assertion?.partyRole).toBe('ACCUSED_DEFENDANT_CRIMINAL');
  });
});

describe('the Companies House adapter, against a stubbed transport', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function adapterReturning(body: unknown, status = 200): CompaniesHouseAdapter {
    return new CompaniesHouseAdapter({
      apiKey: 'k',
      clock: () => new Date('2026-02-01T00:00:00.000Z'),
      fetchImpl: async () => Promise.resolve(jsonResponse(body, status)),
    });
  }

  it('maps a search response into candidates, with the partial date of birth marked partial', async () => {
    const adapter = adapterReturning({
      total_results: 2,
      items: [
        {
          title: 'SMITH, John',
          appointment_count: 3,
          date_of_birth: { month: 4, year: 1971 },
          address: { locality: 'Leeds' },
          links: { self: '/officers/abc123/appointments' },
        },
      ],
    });
    const outcome = await adapter.findOfficers({
      tenantId: 't',
      jurisdiction: 'GB',
      name: 'John Smith',
      limit: 5,
    });
    const candidates = dataOf(outcome);
    expect(candidates[0]?.officerRef).toBe('abc123');
    expect(candidates[0]?.identifiers).toContainEqual({
      kind: 'DATE_OF_BIRTH',
      value: '1971-04',
      partial: true,
    });
  });

  it('reports a 429 as RATE_LIMITED and honours Retry-After', async () => {
    const adapter = new CompaniesHouseAdapter({
      apiKey: 'k',
      fetchImpl: async () =>
        Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': '30' } })),
    });
    const outcome = await adapter.findOfficers({
      tenantId: 't',
      jurisdiction: 'GB',
      name: 'John Smith',
      limit: 5,
    });
    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.policy.failureClass).toBe('RATE_LIMITED');
      expect(outcome.signal.retryAfterSeconds).toBe(30);
    }
  });

  it('reports an invalid key as AUTH_CREDENTIAL, which is never retried', async () => {
    const adapter = new CompaniesHouseAdapter({
      apiKey: 'k',
      fetchImpl: async () => Promise.resolve(new Response('', { status: 401 })),
    });
    const outcome = await adapter.getCompany('00000001', 'GB');
    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.policy.failureClass).toBe('AUTH_CREDENTIAL');
      expect(outcome.policy.retryable).toBe(false);
      // Free-source keys are revoked silently, so somebody has to be told.
      expect(outcome.policy.alertOperator).toBe(true);
    }
  });

  it('treats a 404 company as an answer, not an outage', async () => {
    const adapter = new CompaniesHouseAdapter({
      apiKey: 'k',
      fetchImpl: async () => Promise.resolve(new Response('', { status: 404 })),
    });
    const outcome = await adapter.getCompany('99999999', 'GB');
    expect(outcome.status).toBe('NO_RESULTS');
  });

  it('reports a bound overrun with the register’s own total', async () => {
    const adapter = adapterReturning({
      total_results: 412,
      items: Array.from({ length: 6 }, (_, i) => ({
        title: 'SMITH, John',
        links: { self: `/officers/id-${String(i)}/appointments` },
      })),
    });
    const outcome = await adapter.findOfficers({
      tenantId: 't',
      jurisdiction: 'GB',
      name: 'John Smith',
      limit: 5,
    });
    expect(outcome.status).toBe('BOUNDED');
    if (outcome.status === 'BOUNDED') {
      expect(outcome.truncation.availableCount).toBe(412);
      expect(outcome.data).toHaveLength(5);
    }
  });

  it('never turns an absent resignation into an open-ended or current one', async () => {
    const adapter = adapterReturning({
      items: [
        {
          appointed_on: '2019-03-04',
          officer_role: 'director',
          appointed_to: { company_number: '01234567', company_name: 'ACME LTD' },
        },
      ],
    });
    const appointments = dataOf(
      await adapter.listAppointments({
        tenantId: 't',
        officerRef: 'abc123',
        jurisdiction: 'GB',
        limit: 5,
      }),
    );
    expect(appointments[0]?.tenure.resignedOn).toEqual({ value: null, precision: 'UNKNOWN' });
    expect(appointments[0]?.tenure.appointedOn).toEqual({ value: '2019-03-04', precision: 'DAY' });
  });

  it('drops an appointment with no company number rather than inventing one', async () => {
    const adapter = adapterReturning({
      items: [{ appointed_on: '2019-03-04', officer_role: 'director', appointed_to: {} }],
    });
    const outcome = await adapter.listAppointments({
      tenantId: 't',
      officerRef: 'abc123',
      jurisdiction: 'GB',
      limit: 5,
    });
    // A synthetic identifier would merge every such appointment into one company.
    expect(outcome.status).toBe('OK');
    if (outcome.status === 'OK') {
      expect(outcome.data).toEqual([]);
    }
  });

  it('treats a non-JSON 200 as a content error rather than parsing it', async () => {
    const adapter = new CompaniesHouseAdapter({
      apiKey: 'k',
      fetchImpl: async () =>
        Promise.resolve(
          new Response('<html>maintenance</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        ),
    });
    const outcome = await adapter.getCompany('01234567', 'GB');
    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.policy.failureClass).toBe('CONTENT_ERROR');
      expect(outcome.policy.retryable).toBe(false);
    }
  });
});

describe('the Companies House field mapping, in isolation', () => {
  it('declares date precision from the shape of the string', () => {
    expect(parseRegisterDate('2019-03-04')).toEqual({ value: '2019-03-04', precision: 'DAY' });
    expect(parseRegisterDate('2019-03')).toEqual({ value: '2019-03-01', precision: 'MONTH' });
    expect(parseRegisterDate('2019')).toEqual({ value: '2019-01-01', precision: 'YEAR' });
    expect(parseRegisterDate(undefined)).toEqual({ value: null, precision: 'UNKNOWN' });
    // Unrecognised is unknown, not a best guess: a parsed-wrong date is believed, a missing
    // one is visibly absent.
    expect(parseRegisterDate('4 March 2019')).toEqual({ value: null, precision: 'UNKNOWN' });
  });

  it('never confuses an unknown status with a dissolved one', () => {
    expect(normaliseCompanyStatus('active')).toBe('ACTIVE');
    expect(normaliseCompanyStatus('dissolved')).toBe('DISSOLVED');
    expect(normaliseCompanyStatus('administration')).toBe('LIQUIDATION');
    expect(normaliseCompanyStatus(undefined)).toBe('UNKNOWN');
    expect(normaliseCompanyStatus('something-new')).toBe('UNKNOWN');
  });

  it('reads the officer id out of the published self link', () => {
    expect(extractOfficerId('/officers/abc123/appointments')).toBe('abc123');
    expect(extractOfficerId('/company/01234567')).toBeNull();
  });
});
