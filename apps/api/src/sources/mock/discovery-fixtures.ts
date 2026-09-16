/**
 * Discovery fixture corpus, shared by the news and web discovery mocks.
 *
 * Deliberately small and deliberately awkward. It is not trying to be a realistic news feed;
 * it is trying to contain the cases that break a discovery pipeline:
 *
 * - **The same article at two rungs.** `lead-duplicate-*` is one story syndicated to two
 *   domains, so a relevance filter that counts sightings as independent corroboration is
 *   caught here rather than in Phase F, where it would look like a banding bug. The clustering
 *   rules in `@erly/adverse-domain` already handle syndication; this gives them something to
 *   handle.
 * - **A headline with no snippet.** Sources frequently omit the description. Code that
 *   synthesises one from the title scores a sentence the publisher never wrote.
 * - **A missing publication date.** FR-07 is explicit that it stays null and is never
 *   backfilled with the retrieval time. The fixture carries one so that a backfill has
 *   something to be caught by.
 * - **A Spanish-language item.** D-010 enables Costa Rica, whose language is Spanish, and a
 *   fixture corpus in English only would let an English-only pipeline pass every test.
 * - **A lead that is not a document.** `lead-nonarticle-0001` is a tag page: a real URL, on a
 *   real publisher, naming the subject, that has no article behind it. Web search returns these
 *   constantly. The FR-06 relevance filter is supposed to refuse it before a socket opens, and
 *   without a lead of this shape nothing in a mock run would ever exercise that refusal — a
 *   filter that never fires looks exactly like a filter that was never wired in. There is
 *   deliberately no document at this URL in `evidence-fetch.mock.ts`, so if the filter is
 *   removed the lead becomes a 404 and an INCOMPLETE run rather than passing quietly.
 *
 * None of these leads carry a category, a stage or a role — see `lead.ts` for why the type has
 * no room for them.
 */

import type { CascadeRung, Lead } from '../lead.js';

/** A fixture lead before the adapter stamps its provenance onto it. */
export type UnstampedLead = Omit<Lead, 'provenance' | 'queryId' | 'rung'>;

export interface FixtureLead {
  /**
   * Terms a query must contain for this lead to be returned. **All** of them, compared after
   * folding case and diacritics.
   *
   * This replaced whole-string equality, which was a mistake worth naming: a mock that answers
   * exactly one query string tests string equality, not the pipeline. Every planned query is
   * built by the FR-04 family templates — `"Name"`, `"Name" director`, `"Name" fraude` — so an
   * equality match meant the planner and the fixtures had to agree character for character, and
   * the first realistic plan returned nothing while looking like a discovery failure.
   */
  readonly requires: readonly string[];
  readonly rung: CascadeRung;
  readonly lead: UnstampedLead;
}

/** Fold for comparison: lower case, diacritics stripped, whitespace collapsed. */
export function foldForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Does this query carry every term the fixture requires? */
export function queryMatchesFixture(queryText: string, requires: readonly string[]): boolean {
  const haystack = foldForMatch(queryText);
  return requires.every((term) => haystack.includes(foldForMatch(term)));
}

export const DISCOVERY_SUBJECT_NAME = 'María Fernanda Solís Rojas';
/** A planned query that reaches the fixture corpus. Any query naming the subject does. */
export const DISCOVERY_QUERY_WITH_RESULTS = 'María Fernanda Solís Rojas fraude';
export const DISCOVERY_QUERY_WITH_NO_RESULTS = 'Wilberth Zamora Quesada';

export const VARGAS_NAME = 'Rodrigo Alberto Vargas Méndez';
export const JIMENEZ_NAME = 'Ana Lucía Jiménez Castro';
export const ROJAS_MORA_NAME = 'Carlos Eduardo Rojas Mora';
export const TURNER_NAME = 'James Whitfield Turner';

/**
 * The names a tester can type, and what each one is for.
 *
 * One subject was enough to prove the pipeline runs; it is not enough to show what the pipeline
 * *says*. Every demo against a single charged subject returns the same shape, so nothing in a
 * walkthrough ever showed an acquittal surviving, a conviction corroborated by two independent
 * publishers, a lone early-stage report, or a document in English.
 *
 * **These are invented people.** Every name, publisher and case here is fabricated, every
 * domain is an `example` host that resolves nowhere, and every record the service stores from
 * them is stamped `mode: "MOCK"` so a fixture cannot be read back as a live result (T55).
 * Nothing in this corpus refers to a real person, and nothing in it should ever be replaced
 * with one — a real name in a fixture corpus is an allegation with a test fixture's care behind
 * it.
 */
export const DEMO_SUBJECTS: readonly {
  readonly name: string;
  readonly jurisdiction: string;
  readonly language: string;
  readonly shows: string;
}[] = [
  {
    name: DISCOVERY_SUBJECT_NAME,
    jurisdiction: 'CR',
    language: 'es',
    shows:
      'A formal charge for fraud, plus the awkward cases: the same story syndicated to a second ' +
      'domain, a tag page that is not a document, and an item with neither snippet nor date.',
  },
  {
    name: VARGAS_NAME,
    jurisdiction: 'CR',
    language: 'es',
    shows:
      'An investigation followed by an ACQUITTAL. The outcome wins (D-047) — read the stage, ' +
      'not just the fact that something was found.',
  },
  {
    name: JIMENEZ_NAME,
    jurisdiction: 'CR',
    language: 'es',
    shows:
      'A money-laundering CONVICTION reported by two independent publishers in different words ' +
      '— corroboration, as opposed to the Talamanca pair, which is one story twice.',
  },
  {
    name: ROJAS_MORA_NAME,
    jurisdiction: 'CR',
    language: 'es',
    shows: 'A single early-stage bribery investigation from one publisher, and nothing else.',
  },
  {
    name: TURNER_NAME,
    jurisdiction: 'US',
    language: 'en',
    shows:
      'An English-language prosecution. Search him with jurisdictions: ["US"] — the mock source ' +
      'covers CR, GB and US, and a lead attributed anywhere else is refused at the fetch ' +
      'gate (FR-05), which is the gate working rather than a missing fixture.',
  },
  {
    name: DISCOVERY_QUERY_WITH_NO_RESULTS,
    jurisdiction: 'CR',
    language: 'es',
    shows:
      'Nothing at all — NO_MATCHES_FOUND with a noMatchStatement saying what was searched. ' +
      'The absence of a finding is a result, not a blank.',
  },
];

export const FIXTURE_LEADS: readonly FixtureLead[] = [
  {
    requires: [DISCOVERY_SUBJECT_NAME],
    rung: 2,
    lead: {
      leadId: 'lead-primary-0001',
      url: 'https://www.nacion-example.cr/sucesos/caso-talamanca-2024',
      title: 'Fiscalía acusa a directiva de Inversiones Talamanca por presunto fraude',
      snippet: 'La Fiscalía Adjunta de Delitos Económicos presentó acusación formal contra…',
      publisher: 'La Nación (example)',
      publisherDomain: 'nacion-example.cr',
      publishedAt: { value: '2024-03-14', precision: 'DAY' },
      language: 'es',
    },
  },
  {
    // Same story, different domain. Syndication, not corroboration.
    requires: [DISCOVERY_SUBJECT_NAME],
    rung: 2,
    lead: {
      leadId: 'lead-duplicate-0001',
      url: 'https://www.crhoy-example.com/nacionales/caso-talamanca-2024',
      title: 'Fiscalía acusa a directiva de Inversiones Talamanca por presunto fraude',
      snippet: 'La Fiscalía Adjunta de Delitos Económicos presentó acusación formal contra…',
      publisher: 'CRHoy (example)',
      publisherDomain: 'crhoy-example.com',
      publishedAt: { value: '2024-03-14', precision: 'DAY' },
      language: 'es',
    },
  },
  {
    // No snippet, and no publication date. Both absent, both stay absent.
    requires: [DISCOVERY_SUBJECT_NAME],
    rung: 4,
    lead: {
      leadId: 'lead-sparse-0001',
      url: 'https://www.observador-example.cr/archivo/12841',
      title: 'Talamanca: la causa sigue abierta',
      snippet: null,
      publisher: 'El Observador (example)',
      publisherDomain: 'observador-example.cr',
      publishedAt: { value: null, precision: 'UNKNOWN' },
      language: 'es',
    },
  },
  {
    // A tag page: names the subject, is not a document. FR-06 refuses it before the fetch.
    requires: [DISCOVERY_SUBJECT_NAME],
    rung: 5,
    lead: {
      leadId: 'lead-nonarticle-0001',
      url: 'https://www.nacion-example.cr/tag/maria-fernanda-solis-rojas',
      title: 'María Fernanda Solís Rojas — La Nación (example)',
      snippet: 'Todas las noticias sobre María Fernanda Solís Rojas.',
      publisher: 'La Nación (example)',
      publisherDomain: 'nacion-example.cr',
      publishedAt: { value: null, precision: 'UNKNOWN' },
      language: 'es',
    },
  },
  {
    requires: [DISCOVERY_SUBJECT_NAME],
    rung: 5,
    lead: {
      leadId: 'lead-web-0001',
      url: 'https://boletin-example.go.cr/notificaciones/2024/03/18',
      title: 'Notificación en el expediente 24-000123-0042-PE',
      snippet: 'Se notifica a las partes del expediente…',
      publisher: 'Boletín Judicial (example)',
      publisherDomain: 'boletin-example.go.cr',
      publishedAt: { value: '2024-03-18', precision: 'DAY' },
      language: 'es',
    },
  },

  // ─── The demo cast (see DEMO_SUBJECTS below) ────────────────────────────────────────────
  //
  // Added so that a tester can type more than one name and get more than one shape of answer.
  // With a single subject in the corpus, every demo returns the same charge and the reader
  // learns nothing about what the service does with an acquittal, a conviction, a lone weak
  // lead, or a document in another language.

  // ── Rodrigo Alberto Vargas Méndez — investigated, then ACQUITTED.
  // The most important case in the corpus after the first. An acquittal has to travel through
  // the pipeline as readily as an accusation (D-047), and a demo that only ever shows charges
  // teaches the opposite.
  {
    requires: [VARGAS_NAME],
    rung: 2,
    lead: {
      leadId: 'lead-vargas-0001',
      url: 'https://www.nacion-example.cr/sucesos/caso-vargas-investigacion',
      title: 'Fiscalía abre investigación contra Rodrigo Alberto Vargas Méndez por presunto fraude',
      snippet: 'La Fiscalía confirmó la apertura de una investigación por presunto fraude…',
      publisher: 'La Nación (example)',
      publisherDomain: 'nacion-example.cr',
      publishedAt: { value: '2023-11-02', precision: 'DAY' },
      language: 'es',
    },
  },
  {
    requires: [VARGAS_NAME],
    rung: 2,
    lead: {
      leadId: 'lead-vargas-0002',
      url: 'https://www.crhoy-example.com/nacionales/caso-vargas-absolutoria',
      title: 'Tribunal dicta sentencia absolutoria a favor de Rodrigo Alberto Vargas Méndez',
      snippet: 'El tribunal absolvió al imputado por falta de prueba…',
      publisher: 'CRHoy (example)',
      publisherDomain: 'crhoy-example.com',
      publishedAt: { value: '2024-06-20', precision: 'DAY' },
      language: 'es',
    },
  },

  // ── Ana Lucía Jiménez Castro — CONVICTED, money laundering, two independent publishers.
  // Two different domains carrying materially different text, so this is corroboration rather
  // than the syndication the Talamanca pair tests.
  {
    requires: [JIMENEZ_NAME],
    rung: 2,
    lead: {
      leadId: 'lead-jimenez-0001',
      url: 'https://www.nacion-example.cr/sucesos/caso-jimenez-sentencia',
      title: 'Sentencia condenatoria contra Ana Lucía Jiménez Castro por lavado de activos',
      snippet: 'El Tribunal Penal dictó sentencia condenatoria por lavado de activos…',
      publisher: 'La Nación (example)',
      publisherDomain: 'nacion-example.cr',
      publishedAt: { value: '2024-02-08', precision: 'DAY' },
      language: 'es',
    },
  },
  {
    requires: [JIMENEZ_NAME],
    rung: 4,
    lead: {
      leadId: 'lead-jimenez-0002',
      url: 'https://www.observador-example.cr/judiciales/jimenez-castro-condena',
      title: 'Condena firme en el caso de lavado que involucra a Ana Lucía Jiménez Castro',
      snippet: 'La resolución detalla el movimiento de fondos a través de tres sociedades…',
      publisher: 'El Observador (example)',
      publisherDomain: 'observador-example.cr',
      publishedAt: { value: '2024-02-11', precision: 'DAY' },
      language: 'es',
    },
  },

  // ── Carlos Eduardo Rojas Mora — one lone early-stage report, and nothing else.
  // An investigation named by a single publisher is the case a reviewer most often has to
  // judge, and the one a demo corpus usually lacks.
  {
    requires: [ROJAS_MORA_NAME],
    rung: 5,
    lead: {
      leadId: 'lead-rojasmora-0001',
      url: 'https://www.observador-example.cr/politica/rojas-mora-cohecho',
      title: 'Investigación por presunto cohecho salpica a Carlos Eduardo Rojas Mora',
      snippet: 'Una investigación preliminar examina pagos presuntamente irregulares…',
      publisher: 'El Observador (example)',
      publisherDomain: 'observador-example.cr',
      publishedAt: { value: '2024-05-30', precision: 'DAY' },
      language: 'es',
    },
  },

  // ── James Whitfield Turner — English, so a demo is not entirely in Spanish.
  // Search him with `jurisdictions: ["US"]`: the seeded taxonomy enables US (D-044, D17) and the
  // fixture source covers it. A lead only survives the fetch gate where those two overlap.
  {
    requires: [TURNER_NAME],
    rung: 2,
    lead: {
      leadId: 'lead-turner-0001',
      url: 'https://www.ledger-example.com/business/turner-indictment-2024',
      title: 'Prosecutors file formal charges against James Whitfield Turner over securities fraud',
      snippet: 'The indictment alleges a scheme to misstate revenue across four quarters…',
      publisher: 'The Ledger (example)',
      publisherDomain: 'ledger-example.com',
      publishedAt: { value: '2024-09-05', precision: 'DAY' },
      language: 'en',
    },
  },
];
