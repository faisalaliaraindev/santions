/**
 * `FetchGateService` — Phase E step 2.
 *
 * What these tests are really for: the pipeline used to build a `FetchAuthorisation` inline with
 * every gate asserted true and nothing checked. The point of the service is that each field is
 * **derived**, so the tests are mostly of the form "change one fact about the world, watch the
 * corresponding gate refuse" — which is the only way to tell a derived field from a constant.
 *
 * No I/O: the registry is a stub reader, so every refusal is provable without Mongo and without a
 * socket. **Nothing here makes an outbound request**, and nothing here can: the gate issues a
 * record, it does not fetch.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { TaxonomyVersion } from '@erly/adverse-domain';

import {
  FETCH_GATE_ISSUER,
  FetchGateService,
  PRELIMINARY_RELEVANCE_METHOD,
  isSourceLevelRefusal,
  preliminaryRelevance,
  type FetchGateInput,
} from '../src/sources/fetch-gate.service.js';
import {
  MOCK_EGRESS_IDENTITY_ID,
  PRIMARY_EGRESS_IDENTITY_ID,
  buildEgressIdentity,
} from '../src/sources/egress-identity.js';
import {
  assertAuthorised,
  assertNotFixtureAuthorisation,
} from '../src/sources/fetch-authorisation.js';
import type { FetchRequest } from '../src/sources/evidence-fetch.port.js';
import type {
  ActiveSourceVersion,
  SourceVersionReader,
} from '../src/sources/source-version.service.js';

const NOW = new Date('2026-09-14T12:00:00.000Z');

const NEWS_SOURCE: ActiveSourceVersion = {
  sourceId: 'src-news-cr',
  versionId: 'src-news-cr:v4',
  version: 4,
  sourceName: 'Costa Rican news feed',
  connectorType: 'NEWS_DISCOVERY_RSS',
  canonicalDomains: ['news-example.cr'],
  countries: ['CR'],
  languages: ['es', 'en'],
  robotsPosition: 'HONOURED',
  licenceTermsVersion: 'terms-2026-03',
  licenceExpiresAt: null,
  cascadeRung: 2,
  authorityTier: 3,
  // A named person accepted contact with this publisher (D-042). Without it the gate refuses
  // every live fetch to the source, however well configured it is — see the D-042 tests below.
  firstContactApproval: {
    approvedBy: 'A. Approver',
    role: 'Source admin',
    approvedOn: '2026-09-14',
    decision: 'D17',
  },
  endpointUrl: 'https://news-example.cr/feed.xml',
  endpointKind: 'FIXED_FEED',
  queryParam: null,
  pollFloorMs: 15 * 60_000,
  requestCeilingPerSecond: null,
};

const FIXTURE_SOURCE: ActiveSourceVersion = {
  ...NEWS_SOURCE,
  sourceId: 'src-mock-news-discovery',
  versionId: 'src-mock-news-discovery:v1',
  sourceName: 'Mock news discovery (fixture)',
  connectorType: 'FIXTURE_MOCK',
  robotsPosition: 'NOT_ESTABLISHED',
};

const TAXONOMY: TaxonomyVersion = {
  taxonomyVersionId: 't-1:v1',
  version: 1,
  tenantId: 't-1',
  categories: [{ category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 4, enabledCountries: ['CR'] }],
  lexicon: [],
  languages: [{ language: 'es', measuredRecall: null, measuredByEvaluationRunId: null }],
  status: 'ACTIVE',
  proposedBy: 'test',
  approvedBy: 'test',
  activatedAt: NOW.toISOString(),
};

function readerFor(version: ActiveSourceVersion | null): SourceVersionReader {
  return { loadActive: () => Promise.resolve(version) };
}

function gateFor(
  version: ActiveSourceVersion | null,
  options: { mode?: 'MOCK' | 'LIVE'; contactUrl?: string | null } = {},
): FetchGateService {
  const mode = options.mode ?? 'LIVE';
  return new FetchGateService(readerFor(version), mode, {
    mode,
    contactUrl:
      options.contactUrl === undefined ? 'https://erlystage.com/bots' : options.contactUrl,
  });
}

function inputFor(overrides: Partial<FetchGateInput> = {}): FetchGateInput {
  return {
    sourceId: 'src-news-cr',
    url: 'https://news-example.cr/sucesos/uno',
    jurisdiction: 'CR',
    language: 'es',
    runJurisdictions: ['CR'],
    runLanguages: ['es'],
    taxonomy: TAXONOMY,
    subjectNameForms: ['María Fernanda Solís Rojas'],
    leadTitle: 'Fiscalía acusa a María Fernanda Solís Rojas',
    leadSnippet: null,
    now: NOW,
    ...overrides,
  };
}

describe('an authorisation is derived, not asserted', () => {
  it('names the approved version and its unexpired licence terms', async () => {
    const decision = await gateFor(NEWS_SOURCE).authorise(inputFor());

    expect(decision.authorised).toBe(true);
    if (!decision.authorised) {
      return;
    }
    // The fields the pipeline used to invent. `fixture-source-v1` was not a version of anything.
    expect(decision.authorisation.sourceVersionId).toBe('src-news-cr:v4');
    expect(decision.authorisation.licenceTermsVersion).toBe('terms-2026-03');
    expect(decision.authorisation.robotsPosition).toBe('HONOURED');
    expect(decision.authorisation.issuedBy).toBe(FETCH_GATE_ISSUER);
    expect(decision.authorisation.issuedAt).toBe(NOW.toISOString());
  });

  it('carries the method that produced the relevance score, not a bare number', async () => {
    const decision = await gateFor(NEWS_SOURCE).authorise(inputFor());

    if (!decision.authorised) {
      throw new Error('expected an authorisation');
    }
    // A score with no method is uninterpretable: 0.4 from FR-06's nine signals and 0.4 from a
    // name-presence heuristic mean different things to a reviewer.
    expect(decision.authorisation.relevanceMethod).toBe(PRELIMINARY_RELEVANCE_METHOD);
    expect(decision.authorisation.relevanceScore).toBe(1);
  });

  it('passes `assertAuthorised`, which is the gate the adapters share', async () => {
    const decision = await gateFor(NEWS_SOURCE).authorise(inputFor());
    if (!decision.authorised) {
      throw new Error('expected an authorisation');
    }
    expect(() => {
      assertAuthorised({
        url: 'https://news-example.cr/sucesos/uno',
        authorisation: decision.authorisation,
      } as FetchRequest);
    }).not.toThrow();
  });
});

describe('every gate refuses on its own fact', () => {
  it('refuses a URL the SEC-02 policy rejects, before it reads the registry', async () => {
    // A registry that would throw if consulted: the URL gate must decide first, because a URL the
    // policy refuses is refused whatever the source says.
    const gate = new FetchGateService(
      {
        loadActive: () => {
          throw new Error('the registry must not be consulted for a refused URL');
        },
      },
      'LIVE',
      { mode: 'LIVE', contactUrl: 'https://erlystage.com/bots' },
    );

    const decision = await gate.authorise(inputFor({ url: 'http://169.254.169.254/latest/meta' }));

    expect(decision.authorised).toBe(false);
    if (decision.authorised) {
      return;
    }
    expect(decision.refusal).toBe('URL_POLICY_REJECTED');
  });

  it('refuses a source with no active approved version', async () => {
    const decision = await gateFor(null).authorise(inputFor());
    expect(decision.authorised).toBe(false);
    if (!decision.authorised) {
      expect(decision.refusal).toBe('NO_ACTIVE_SOURCE_VERSION');
    }
  });

  it('refuses a source whose recorded licence terms have expired', async () => {
    const decision = await gateFor({
      ...NEWS_SOURCE,
      licenceExpiresAt: '2026-01-01T00:00:00.000Z',
    }).authorise(inputFor());

    expect(decision.authorised).toBe(false);
    if (!decision.authorised) {
      expect(decision.refusal).toBe('LICENCE_EXPIRED');
      expect(decision.detail).toContain('2026-01-01');
    }
  });

  it('refuses a source that records no licence terms at all', async () => {
    const decision = await gateFor({ ...NEWS_SOURCE, licenceTermsVersion: null }).authorise(
      inputFor(),
    );
    expect(decision.authorised).toBe(false);
    if (!decision.authorised) {
      expect(decision.refusal).toBe('LICENCE_TERMS_NOT_RECORDED');
    }
  });

  it('refuses a jurisdiction the run never asked for', async () => {
    const decision = await gateFor(NEWS_SOURCE).authorise(
      inputFor({ jurisdiction: 'GB', runJurisdictions: ['CR'] }),
    );
    expect(decision.authorised).toBe(false);
    if (!decision.authorised) {
      expect(decision.refusal).toBe('JURISDICTION_NOT_IN_RUN_SCOPE');
    }
  });

  it('refuses a jurisdiction the source is not approved for (FR-05)', async () => {
    const decision = await gateFor({ ...NEWS_SOURCE, countries: ['GB'] }).authorise(inputFor());
    expect(decision.authorised).toBe(false);
    if (!decision.authorised) {
      expect(decision.refusal).toBe('SOURCE_DOES_NOT_COVER_JURISDICTION');
    }
  });

  it('refuses a jurisdiction the pinned taxonomy enables no category for', async () => {
    const decision = await gateFor(NEWS_SOURCE).authorise(
      inputFor({
        taxonomy: {
          ...TAXONOMY,
          categories: [
            { category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 4, enabledCountries: ['GB'] },
          ],
        },
      }),
    );
    expect(decision.authorised).toBe(false);
    if (!decision.authorised) {
      expect(decision.refusal).toBe('JURISDICTION_NOT_ENABLED');
    }
  });

  it('refuses a lead whose language the discovery source never declared', async () => {
    // Never inferred from the text: the language decides which lexicon the document is read
    // under, so a guess here becomes a wrong reading downstream.
    const decision = await gateFor(NEWS_SOURCE).authorise(inputFor({ language: null }));
    expect(decision.authorised).toBe(false);
    if (!decision.authorised) {
      expect(decision.refusal).toBe('LANGUAGE_NOT_DECLARED_BY_LEAD');
    }
  });

  it('refuses a language the pinned taxonomy does not declare', async () => {
    const decision = await gateFor(NEWS_SOURCE).authorise(
      inputFor({ language: 'fr', runLanguages: ['es', 'fr'] }),
    );
    expect(decision.authorised).toBe(false);
    if (!decision.authorised) {
      expect(decision.refusal).toBe('LANGUAGE_NOT_ENABLED');
    }
  });

  it('refuses a language the source is not approved for', async () => {
    const decision = await gateFor({ ...NEWS_SOURCE, languages: ['en'] }).authorise(inputFor());
    expect(decision.authorised).toBe(false);
    if (!decision.authorised) {
      expect(decision.refusal).toBe('SOURCE_DOES_NOT_COVER_LANGUAGE');
    }
  });

  it('refuses a source whose robots position is not established', async () => {
    const decision = await gateFor({
      ...NEWS_SOURCE,
      robotsPosition: 'NOT_ESTABLISHED',
    }).authorise(inputFor());

    expect(decision.authorised).toBe(false);
    if (!decision.authorised) {
      expect(decision.refusal).toBe('ROBOTS_POSITION_NOT_ESTABLISHED');
      expect(decision.detail).toContain('not permission');
    }
  });
});

describe('open decision D6: no exception can be applied while it is open (T86)', () => {
  it('refuses an EXCEPTION_APPROVED source, and says why and who owns the decision', async () => {
    const decision = await gateFor({
      ...NEWS_SOURCE,
      robotsPosition: 'EXCEPTION_APPROVED',
    }).authorise(inputFor());

    expect(decision.authorised).toBe(false);
    if (decision.authorised) {
      return;
    }
    expect(decision.refusal).toBe('ROBOTS_EXCEPTION_NOT_APPROVABLE');
    // The registry has nowhere to record the approver FR-06 demands, so the exception is
    // unattributable and is refused rather than applied. D6 decides how the name is recorded.
    expect(decision.detail).toContain('D6');
  });

  it('never issues an authorisation carrying an unnamed exception', async () => {
    for (const position of ['HONOURED', 'EXCEPTION_APPROVED', 'NOT_ESTABLISHED'] as const) {
      const decision = await gateFor({ ...NEWS_SOURCE, robotsPosition: position }).authorise(
        inputFor(),
      );
      if (decision.authorised) {
        expect(decision.authorisation.robotsPosition).not.toBe('EXCEPTION_APPROVED');
        expect(decision.authorisation.robotsExceptionApprovedBy).toBeNull();
      }
    }
  });
});

describe('a fixture is not a publisher (T55)', () => {
  it('records FIXTURE_NOT_A_PUBLISHER in mock mode rather than claiming HONOURED', async () => {
    const decision = await gateFor(FIXTURE_SOURCE, { mode: 'MOCK', contactUrl: null }).authorise(
      inputFor({ sourceId: FIXTURE_SOURCE.sourceId }),
    );

    expect(decision.authorised).toBe(true);
    if (!decision.authorised) {
      return;
    }
    // The old inline record said `HONOURED` for a local fixture, which is a statement about a
    // robots.txt that does not exist.
    expect(decision.authorisation.robotsPosition).toBe('FIXTURE_NOT_A_PUBLISHER');
    expect(decision.egressIdentity.identityId).toBe(MOCK_EGRESS_IDENTITY_ID);
  });

  it('refuses a fixture source in a live process', async () => {
    const decision = await gateFor(FIXTURE_SOURCE, { mode: 'LIVE' }).authorise(
      inputFor({ sourceId: FIXTURE_SOURCE.sourceId }),
    );
    expect(decision.authorised).toBe(false);
    if (!decision.authorised) {
      expect(decision.refusal).toBe('FIXTURE_SOURCE_IN_LIVE_MODE');
    }
  });

  it('a fixture authorisation is refused by the live transport', () => {
    expect(() => {
      assertNotFixtureAuthorisation({
        url: 'https://news-example.cr/x',
        authorisation: { robotsPosition: 'FIXTURE_NOT_A_PUBLISHER' },
      } as FetchRequest);
    }).toThrow(/fixture authorisation/i);
  });
});

describe('one honest egress identity (E3 minimum)', () => {
  it('refuses every fetch in a live process with no contact URL', async () => {
    const decision = await gateFor(NEWS_SOURCE, { mode: 'LIVE', contactUrl: null }).authorise(
      inputFor(),
    );

    expect(decision.authorised).toBe(false);
    if (!decision.authorised) {
      // An anonymous crawler is not a degraded honest one: it is the thing FR-06 forbids.
      expect(decision.refusal).toBe('NO_EGRESS_IDENTITY');
    }
  });

  it('names a real identity whose user agent carries the contact URL', async () => {
    const decision = await gateFor(NEWS_SOURCE, {
      contactUrl: 'https://erlystage.com/bots/adverse-search',
    }).authorise(inputFor());

    if (!decision.authorised) {
      throw new Error('expected an authorisation');
    }
    // `mock-egress-1` used to be written into live attribution records by this path.
    expect(decision.egressIdentity.identityId).toBe(PRIMARY_EGRESS_IDENTITY_ID);
    expect(decision.egressIdentity.identityId).not.toBe('mock-egress-1');
    expect(decision.egressIdentity.userAgent).toContain(
      'https://erlystage.com/bots/adverse-search',
    );
  });

  it('builds the same user agent the fetch adapter sends, from the same contact URL', () => {
    const identity = buildEgressIdentity({ mode: 'LIVE', contactUrl: 'https://example.org/bot' });
    // `HttpEvidenceFetchAdapter` composes `${serviceName}/1.0 (+${contactUrl})`. Two spellings
    // of one identity would make the record and the wire disagree about who called.
    expect(identity?.userAgent).toBe('ErlyAdverseSearch/1.0 (+https://example.org/bot)');
  });

  it('gives a live process with a blank contact URL no identity at all', () => {
    expect(buildEgressIdentity({ mode: 'LIVE', contactUrl: '   ' })).toBeNull();
  });
});

describe('the preliminary relevance score', () => {
  it('scores a whole name form present in the lead text as 1', () => {
    expect(
      preliminaryRelevance({
        nameForms: ['María Fernanda Solís Rojas'],
        // Folded for comparison, so the diacritics the publisher wrote do not decide the answer.
        title: 'MARIA FERNANDA SOLIS ROJAS acusada',
        snippet: null,
      }),
    ).toBe(1);
  });

  it('scores partial token presence, rather than rounding up to a default', () => {
    const score = preliminaryRelevance({
      nameForms: ['María Fernanda Solís Rojas'],
      title: 'Solís Rojas y otros',
      snippet: null,
    });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('scores a lead that names nobody as 0, and does not refuse it', async () => {
    expect(
      preliminaryRelevance({
        nameForms: ['María Fernanda Solís Rojas'],
        title: 'Fiscalía acusa a directiva de Inversiones Talamanca',
        snippet: null,
      }),
    ).toBe(0);

    // The score does not gate. FR-06's threshold belongs to step 4 and is to be set against the
    // FR-16 corpus; refusing on a number nobody validated would silently drop real leads.
    const decision = await gateFor(NEWS_SOURCE).authorise(
      inputFor({ leadTitle: 'Fiscalía acusa a directiva de Inversiones Talamanca' }),
    );
    expect(decision.authorised).toBe(true);
  });

  it('never invents a snippet the source did not return', () => {
    // Title only, snippet null: the score is computed over what the source actually said.
    const withNull = preliminaryRelevance({
      nameForms: ['Ana Solís'],
      title: 'Ana Solís',
      snippet: null,
    });
    const withEmpty = preliminaryRelevance({
      nameForms: ['Ana Solís'],
      title: 'Ana Solís',
      snippet: '',
    });
    expect(withNull).toBe(withEmpty);
  });
});

describe('a refusal is never a silent skip', () => {
  it('separates refusals that cost a source from refusals that cost one URL', () => {
    // A source-level refusal belongs in the coverage statement; a URL-level one belongs on the
    // lead. Getting this backwards either hides a missing source or reports a gap that is not one.
    expect(isSourceLevelRefusal('ROBOTS_EXCEPTION_NOT_APPROVABLE')).toBe(true);
    expect(isSourceLevelRefusal('LICENCE_EXPIRED')).toBe(true);
    expect(isSourceLevelRefusal('URL_POLICY_REJECTED')).toBe(false);
    expect(isSourceLevelRefusal('JURISDICTION_NOT_IN_RUN_SCOPE')).toBe(false);
  });

  it('gives every refusal a sentence a reviewer can act on', async () => {
    const decisions = await Promise.all([
      gateFor(null).authorise(inputFor()),
      gateFor({ ...NEWS_SOURCE, robotsPosition: 'NOT_ESTABLISHED' }).authorise(inputFor()),
      gateFor(NEWS_SOURCE).authorise(inputFor({ url: 'https://127.0.0.1/x' })),
    ]);

    for (const decision of decisions) {
      expect(decision.authorised).toBe(false);
      if (!decision.authorised) {
        expect(decision.detail.length).toBeGreaterThan(40);
      }
    }
  });
});

describe('the gate is the only issuer', () => {
  /**
   * Enforced by a scan, following the precedent the control panel sets for decision D-001: a
   * boundary that matters is checked by a test rather than by everyone remembering it.
   *
   * `urlPolicyPassed` is the marker because it is the field that cannot be honestly set by
   * anything that has not run `screenUrl` — which is exactly what the pipeline used to do.
   */
  it('no other file in apps/api/src constructs a FetchAuthorisation', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const offenders: string[] = [];

    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) {
          continue;
        }
        // The port declares the type; the gate issues it. Everything else must receive one.
        if (entry.name === 'fetch-gate.service.ts' || entry.name === 'evidence-fetch.port.ts') {
          continue;
        }
        if (readFileSync(path, 'utf8').includes('urlPolicyPassed:')) {
          offenders.push(path);
        }
      }
    };
    walk(root);

    expect(offenders).toEqual([]);
  });
});

describe('D-042 — no live request to a publisher nobody accepted contact with', () => {
  // `SourceVersionService` reads the approval strictly: any missing field resolves the whole
  // approval to null rather than to a partial one, because a half-filled approval the gate
  // accepted would be a live request made under a name nobody actually wrote down. So null is
  // the only shape the gate ever sees for "not properly approved", and it is what is tested.
  const UNAPPROVED: ActiveSourceVersion = { ...NEWS_SOURCE, firstContactApproval: null };

  it('refuses a source that is fully configured and approved but has no first-contact approval', async () => {
    // The separation this rule exists for: approving a registry entry says the configuration is
    // right; accepting first contact says somebody will answer for the requests. One signature
    // covering both makes the second invisible.
    const decision = await gateFor(UNAPPROVED).authorise(inputFor());

    expect(decision.authorised).toBe(false);
    if (decision.authorised) {
      return;
    }
    expect(decision.refusal).toBe('NO_FIRST_CONTACT_APPROVAL');
    expect(decision.detail).toContain('no named person');
  });

  it('treats it as a source-level refusal, so it reaches the coverage statement', () => {
    // Every lead from this source is affected, not one URL. A reviewer reading a narrow result
    // has to learn that a whole source was excluded and why.
    expect(isSourceLevelRefusal('NO_FIRST_CONTACT_APPROVAL')).toBe(true);
  });

  it('does not apply to a fixture source in mock mode, because no publisher is involved', async () => {
    const fixture: ActiveSourceVersion = { ...FIXTURE_SOURCE, firstContactApproval: null };
    const decision = await gateFor(fixture, { mode: 'MOCK' }).authorise(
      inputFor({ sourceId: fixture.sourceId }),
    );
    expect(decision.authorised).toBe(true);
  });
});
