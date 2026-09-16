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
 * The refusals themselves now live in `../fetch-authorisation.ts` and are shared with the real
 * `HttpEvidenceFetchAdapter`. They were written here first and moved there unchanged when the
 * real adapter arrived: two copies of a gate is how the live one ends up the more permissive.
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
import { assertAttributable, assertAuthorised } from '../fetch-authorisation.js';
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

  // ─── Documents for the demo cast in `discovery-fixtures.ts` ──────────────────────────────
  //
  // Every person here is invented and every host is an `example` domain that resolves nowhere.
  // The conduct and stage wording is chosen to hit the mock extractor's term tables in
  // `extraction-model.mock.ts` — change a term there and these stop producing findings.

  // ── Vargas: the investigation, and then the acquittal that supersedes it.
  {
    url: 'https://www.nacion-example.cr/sucesos/caso-vargas-investigacion',
    contentType: 'text/html; charset=utf-8',
    body:
      '<html><body><article><h1>Fiscalía abre investigación contra Rodrigo Alberto Vargas ' +
      'Méndez por presunto fraude</h1><p>La Fiscalía Adjunta de Delitos Económicos confirmó ' +
      'la apertura de una investigación contra Rodrigo Alberto Vargas Méndez por presunto ' +
      'fraude en la administración de fondos de la cooperativa, el 2 de noviembre de 2023.</p>' +
      '</article></body></html>',
    etag: 'W/"vargas-investigacion-1"',
    lastModified: 'Thu, 02 Nov 2023 14:10:00 GMT',
    robots: 'ALLOWED',
  },
  {
    // The acquittal. An extractor that takes the first or the strongest match would report the
    // fraud and drop this, which is the failure D-047 names: the service would be better at
    // confirming a suspicion than at testing it.
    url: 'https://www.crhoy-example.com/nacionales/caso-vargas-absolutoria',
    contentType: 'text/html; charset=utf-8',
    body:
      '<html><body><article><h1>Tribunal dicta sentencia absolutoria a favor de Rodrigo ' +
      'Alberto Vargas Méndez</h1><p>El Tribunal Penal dictó sentencia absolutoria a favor de ' +
      'Rodrigo Alberto Vargas Méndez en la causa por presunto fraude, por falta de prueba, el ' +
      '20 de junio de 2024.</p></article></body></html>',
    etag: 'W/"vargas-absolutoria-1"',
    lastModified: 'Thu, 20 Jun 2024 16:45:00 GMT',
    robots: 'ALLOWED',
  },

  // ── Jiménez: one conviction, two publishers, materially different wording.
  {
    url: 'https://www.nacion-example.cr/sucesos/caso-jimenez-sentencia',
    contentType: 'text/html; charset=utf-8',
    body:
      '<html><body><article><h1>Sentencia condenatoria contra Ana Lucía Jiménez Castro por ' +
      'lavado de activos</h1><p>El Tribunal Penal dictó sentencia condenatoria contra Ana ' +
      'Lucía Jiménez Castro por lavado de activos, el 8 de febrero de 2024.</p></article>' +
      '</body></html>',
    etag: 'W/"jimenez-sentencia-1"',
    lastModified: 'Thu, 08 Feb 2024 10:20:00 GMT',
    robots: 'ALLOWED',
  },
  {
    url: 'https://www.observador-example.cr/judiciales/jimenez-castro-condena',
    contentType: 'text/html; charset=utf-8',
    body:
      '<html><body><article><h1>Condena firme en el caso de lavado que involucra a Ana Lucía ' +
      'Jiménez Castro</h1><p>La resolución, que confirma la sentencia condenatoria por lavado ' +
      'de activos impuesta a Ana Lucía Jiménez Castro, detalla el movimiento de fondos a ' +
      'través de tres sociedades constituidas entre 2019 y 2021.</p></article></body></html>',
    etag: 'W/"jimenez-condena-1"',
    lastModified: 'Sun, 11 Feb 2024 08:05:00 GMT',
    robots: 'ALLOWED',
  },

  // ── Rojas Mora: one early-stage report, and deliberately no second source.
  {
    url: 'https://www.observador-example.cr/politica/rojas-mora-cohecho',
    contentType: 'text/html; charset=utf-8',
    body:
      '<html><body><article><h1>Investigación por presunto cohecho salpica a Carlos Eduardo ' +
      'Rojas Mora</h1><p>Una investigación preliminar examina pagos presuntamente irregulares ' +
      'vinculados a Carlos Eduardo Rojas Mora. No se han presentado cargos.</p></article>' +
      '</body></html>',
    etag: 'W/"rojasmora-cohecho-1"',
    lastModified: 'Thu, 30 May 2024 07:30:00 GMT',
    robots: 'ALLOWED',
  },

  // ── Turner: English, so a walkthrough is not entirely in Spanish.
  {
    url: 'https://www.ledger-example.com/business/turner-indictment-2024',
    contentType: 'text/html; charset=utf-8',
    body:
      '<html><body><article><h1>Prosecutors file formal charges against James Whitfield ' +
      'Turner over securities fraud</h1><p>Federal prosecutors filed formal charges against ' +
      'James Whitfield Turner on 5 September 2024, alleging securities fraud in a scheme to ' +
      'misstate revenue across four quarters.</p></article></body></html>',
    etag: 'W/"turner-indictment-1"',
    lastModified: 'Thu, 05 Sep 2024 13:00:00 GMT',
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
      return Promise.resolve(
        failed(
          this.descriptor,
          now,
          { limitExceeded: true },
          `The fixture at ${request.url} is deliberately larger than any sane byte budget, and ` +
            `the fetch was abandoned rather than buffered.`,
        ),
      );
    }

    const fixture = FIXTURE_DOCUMENTS.find((d) => d.url === request.url);
    if (fixture === undefined) {
      return Promise.resolve(
        failed(
          this.descriptor,
          now,
          { httpStatus: 404 },
          `The fixture corpus holds no document at ${request.url}.`,
        ),
      );
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
      return Promise.resolve(
        failed(
          this.descriptor,
          now,
          { limitExceeded: true },
          `The document at ${request.url} is ${String(body.byteLength)} bytes, over the ` +
            `${String(request.budget.maxBytes)}-byte budget for this fetch.`,
        ),
      );
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
