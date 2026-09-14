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
 *
 * None of these leads carry a category, a stage or a role — see `lead.ts` for why the type has
 * no room for them.
 */

import type { CascadeRung, Lead } from '../lead.js';

/** A fixture lead before the adapter stamps its provenance onto it. */
export type UnstampedLead = Omit<Lead, 'provenance' | 'queryId' | 'rung'>;

export interface FixtureLead {
  /** Which query text this lead answers. Matched case-insensitively, whole string. */
  readonly matches: string;
  readonly rung: CascadeRung;
  readonly lead: UnstampedLead;
}

export const DISCOVERY_QUERY_WITH_RESULTS = 'María Fernanda Solís Rojas fraude';
export const DISCOVERY_QUERY_WITH_NO_RESULTS = 'Wilberth Zamora Quesada';

export const FIXTURE_LEADS: readonly FixtureLead[] = [
  {
    matches: DISCOVERY_QUERY_WITH_RESULTS,
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
    matches: DISCOVERY_QUERY_WITH_RESULTS,
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
    matches: DISCOVERY_QUERY_WITH_RESULTS,
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
    matches: DISCOVERY_QUERY_WITH_RESULTS,
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
];
