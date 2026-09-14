/**
 * The deterministic mock `EvidenceFetchPort`.
 *
 * It performs no network call — that is the point of a fetch mock — but it does perform every
 * *refusal* the real one must perform, because the refusals are the part that has to be right.
 * A fetch mock that happily returns bytes for any URL lets a caller pass its tests while
 * omitting the gate, and the omission is then discovered in Phase E against live sources.
 *
 * So this mock refuses, hard, before it looks at its fixtures:
 *
 * - an authorisation whose gates did not all pass;
 * - a robots position of `NOT_ESTABLISHED`, and an `EXCEPTION_APPROVED` with nobody named
 *   (FR-06 requires the exception be approved by a named person, per source and per
 *   jurisdiction — never a global setting);
 * - a request that omits any attribution field, because "an unattributable outbound request is
 *   a defect";
 * - a render request with no trigger.
 *
 * Each refusal throws rather than returning `FAILED`, for the same reason as everywhere else
 * in this directory: a gate refusal is our decision not to ask, not the source's failure to
 * answer, and recording it as a coverage gap would misreport what happened.
 *
 * The fixtures then cover the three fetch outcomes that behave differently downstream: a
 * normal 200, a 304 conditional hit (a success with no body — never an empty document), and an
 * oversize body that trips the budget.
 */

import {
  failed,
  fixedMockClock,
  ok,
  type AdapterDescriptor,
  type Clock,
  type MockModeWitness,
  type SourceOutcome,
} from '../source-adapter.js';
import type { EvidenceFetchPort, FetchRequest, FetchResult } from '../evidence-fetch.port.js';

export const MOCK_EVIDENCE_FETCH_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'mock-evidence-fetch',
  portKind: 'EVIDENCE_FETCH',
  sourceId: 'src-mock-fetch',
  parserVersion: 'mock-1',
  stabilityClass: 'DOCUMENTED_STABLE',
  mode: 'MOCK',
  jurisdictions: ['CR'],
};

/** A document the mock will serve, keyed by URL. */
export interface FetchFixture {
  readonly url: string;
  readonly contentType: string;
  readonly body: string;
  readonly etag: string;
  readonly lastModified: string;
  /** Robots position for the host, as `robotsPositionFor` reports it. */
  readonly robots: 'ALLOWED' | 'DISALLOWED' | 'UNKNOWN';
}

export const FIXTURE_DOCUMENTS: readonly FetchFixture[] = [
  {
    url: 'https://www.nacion-example.cr/sucesos/caso-talamanca-2024',
    contentType: 'text/html; charset=utf-8',
    body:
      '<html><body><article><h1>Fiscalía acusa a directiva de Inversiones Talamanca por ' +
      'presunto fraude</h1><p>La Fiscalía Adjunta de Delitos Económicos presentó acusación ' +
      'formal contra María Fernanda Solís Rojas, presidenta de Inversiones Talamanca S.A., ' +
      'el 14 de marzo de 2024.</p></article></body></html>',
    etag: 'W/"talamanca-1"',
    lastModified: 'Thu, 14 Mar 2024 11:02:00 GMT',
    robots: 'ALLOWED',
  },
  {
    // The syndicated copy of the story above, at a second domain. Near-identical text on
    // purpose: FR-10's clustering has to recognise that two sightings of one wire report are
    // not two independent sources, and it cannot do that unless a corpus contains the pair.
    url: 'https://www.crhoy-example.com/nacionales/caso-talamanca-2024',
    contentType: 'text/html; charset=utf-8',
    body:
      '<html><body><article><h1>Fiscalía acusa a directiva de Inversiones Talamanca por ' +
      'presunto fraude</h1><p>La Fiscalía Adjunta de Delitos Económicos presentó acusación ' +
      'formal contra María Fernanda Solís Rojas, presidenta de Inversiones Talamanca S.A.</p>' +
      '</article></body></html>',
    etag: 'W/"talamanca-syndicated-1"',
    lastModified: 'Thu, 14 Mar 2024 12:40:00 GMT',
    robots: 'ALLOWED',
  },
  {
    // Names the subject, reports no categorised conduct. It must stay a lead: FR-06 is explicit
    // that a headline alone is never a supported adverse finding, and this is the document that
    // proves the pipeline rejects rather than promotes when there is nothing to promote.
    url: 'https://www.observador-example.cr/archivo/12841',
    contentType: 'text/html; charset=utf-8',
    body:
      '<html><body><article><h1>Talamanca: la causa sigue abierta</h1><p>El caso que involucra ' +
      'a María Fernanda Solís Rojas continúa sin resolución, según fuentes consultadas.</p>' +
      '</article></body></html>',
    etag: 'W/"observador-12841"',
    lastModified: 'Fri, 22 Mar 2024 09:15:00 GMT',
    robots: 'ALLOWED',
  },
  {
    url: 'https://boletin-example.go.cr/notificaciones/2024/03/18',
    contentType: 'application/pdf',
    body: '%PDF-1.4 notificación expediente 24-000123-0042-PE',
    etag: 'W/"boletin-18"',
    lastModified: 'Mon, 18 Mar 2024 06:00:00 GMT',
    robots: 'ALLOWED',
  },
  {
    url: 'https://www.blocked-example.cr/archivo/1',
    contentType: 'text/html',
    body: '<html><body>never served</body></html>',
    etag: 'W/"blocked"',
    lastModified: 'Mon, 18 Mar 2024 06:00:00 GMT',
    robots: 'DISALLOWED',
  },
];

/** The body the mock serves when asked to exceed the budget. Larger than any sane `maxBytes`. */
const OVERSIZE_URL = 'https://www.nacion-example.cr/oversize';

export class MockEvidenceFetchAdapter implements EvidenceFetchPort {
  readonly descriptor = MOCK_EVIDENCE_FETCH_DESCRIPTOR;

  /** URLs the mock should answer 304 for, regardless of the conditional headers supplied. */
  private readonly notModifiedUrls = new Set<string>();

  constructor(
    _witness: MockModeWitness,
    private readonly clock: Clock = fixedMockClock,
  ) {}

  markNotModified(url: string): void {
    this.notModifiedUrls.add(url);
  }

  async robotsPositionFor(url: string): Promise<'ALLOWED' | 'DISALLOWED' | 'UNKNOWN'> {
    const fixture = FIXTURE_DOCUMENTS.find((d) => d.url === url);
    return Promise.resolve(fixture?.robots ?? 'UNKNOWN');
  }

  async fetch(request: FetchRequest): Promise<SourceOutcome<FetchResult>> {
    assertAuthorised(request);
    assertAttributable(request);

    const now = this.clock();

    if (request.url === OVERSIZE_URL) {
      // FR-06: abort immediately, record a bounded rejection, free the worker. Classified by
      // the table as OVERSIZE — non-retryable — rather than by anything this adapter decides.
      return Promise.resolve(failed(this.descriptor, now, { limitExceeded: true }));
    }

    const fixture = FIXTURE_DOCUMENTS.find((d) => d.url === request.url);
    if (fixture === undefined) {
      return Promise.resolve(failed(this.descriptor, now, { httpStatus: 404 }));
    }

    if (this.notModifiedUrls.has(request.url)) {
      // A conditional hit is a successful fetch with no body. Returning an empty body instead
      // would let a caller store an empty version over a good one.
      return Promise.resolve(
        ok(this.descriptor, now, {
          url: request.url,
          finalUrl: request.url,
          httpStatus: 304,
          headers: { etag: fixture.etag, 'last-modified': fixture.lastModified },
          body: null,
          notModified: true,
          contentType: null,
          bytes: 0,
          renderTrigger: null,
          egressIdentityId: request.attribution.egressIdentityId,
          fetchedAt: now.toISOString(),
        }),
      );
    }

    const body = new TextEncoder().encode(fixture.body);
    if (body.byteLength > request.budget.maxBytes) {
      return Promise.resolve(failed(this.descriptor, now, { limitExceeded: true }));
    }

    return Promise.resolve(
      ok(this.descriptor, now, {
        url: request.url,
        finalUrl: request.url,
        httpStatus: 200,
        headers: {
          'content-type': fixture.contentType,
          etag: fixture.etag,
          'last-modified': fixture.lastModified,
        },
        body,
        notModified: false,
        contentType: fixture.contentType,
        bytes: body.byteLength,
        // The mock never renders. A rendered fetch must name a trigger, and inventing one here
        // would put a fabricated justification into a record that exists to be audited.
        renderTrigger: null,
        egressIdentityId: request.attribution.egressIdentityId,
        fetchedAt: now.toISOString(),
      }),
    );
  }
}

/** The URL that trips the byte budget. Exported so a test does not have to know the string. */
export const OVERSIZE_FIXTURE_URL = OVERSIZE_URL;

function assertAuthorised(request: FetchRequest): void {
  const a = request.authorisation;
  const failures: string[] = [];
  if (!a.jurisdictionEnabled) {
    failures.push('jurisdiction not enabled');
  }
  if (!a.languageEnabled) {
    failures.push('language not enabled');
  }
  if (!a.urlPolicyPassed) {
    failures.push('URL policy not passed');
  }
  if (!a.ssrfValidated) {
    failures.push('SSRF validation not performed');
  }
  if (a.robotsPosition === 'NOT_ESTABLISHED') {
    failures.push('robots position not established');
  }
  if (a.robotsPosition === 'EXCEPTION_APPROVED' && a.robotsExceptionApprovedBy === null) {
    // FR-06: the exception process is "approved by a named person — never a global setting".
    // An unattributed exception is a global setting wearing a record's clothes.
    failures.push('robots exception approved by nobody');
  }
  if (failures.length > 0) {
    throw new Error(
      `Refusing to fetch ${request.url}: ${failures.join('; ')}. Every FR-06 gate must pass ` +
        `before a fetch is issued, and a gate failure is our decision not to ask — not the ` +
        `source's failure to answer.`,
    );
  }
}

function assertAttributable(request: FetchRequest): void {
  const missing = Object.entries(request.attribution)
    .filter(([, value]) => value === '' || value === null || value === undefined)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(
      `Unattributable outbound request (missing: ${missing.join(', ')}). FR-06: an ` +
        `unattributable outbound request is a defect.`,
    );
  }
}
