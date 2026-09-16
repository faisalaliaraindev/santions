/**
 * Turning what a discovery source returned into a `Lead` — shared by every connector.
 *
 * Three rules live here rather than in each adapter, and each one is a rule this product is built
 * on rather than a convenience:
 *
 * **A missing date stays null.** FR-07: never backfilled with the retrieval time. A date nobody
 * published is a date a reviewer would reason about as though the publisher had stated it, and
 * recency is judged on it.
 *
 * **A snippet is never synthesised.** FR-06's relevance filter scores the snippet, so a snippet
 * invented from the title would be scored as though the publisher had written it.
 *
 * **One story is one lead.** The lead id is derived from the canonicalised URL, so the same
 * article reached from rung 2 and again from rung 4 deduplicates — which is what stops axis D
 * counting one story as two independent sources (FR-10).
 */

import { canonicalise, screenUrl, type PreciseDate } from '@erly/adverse-domain';

import type { CascadeRung, Lead } from '../lead.js';
import type { AdapterProvenance } from '../source-adapter.js';

/** What a connector extracted from one entry, before it is a lead. */
export interface RawCandidate {
  readonly title: string | null;
  readonly link: string | null;
  readonly snippet: string | null;
  /** Exactly as the source wrote it, unparsed. Null when it published none. */
  readonly publishedAtRaw: string | null;
  /** The source's declared language for this item, if it declared one. Never guessed. */
  readonly language: string | null;
}

/**
 * Map candidates to leads, dropping what cannot honestly become one.
 *
 * Dropped rather than carried: an entry with no link has nothing to fetch, and one whose URL the
 * SEC-02 policy refuses is a URL we may never fetch. Carrying either into the coverage view would
 * present something as a candidate that was never a candidate.
 */
export function leadsFrom(input: {
  readonly candidates: readonly RawCandidate[];
  readonly fallbackLanguage: string;
  readonly publisherName: string;
  readonly rung: CascadeRung;
  readonly queryId: string;
  readonly provenance: AdapterProvenance;
  /** Applied only where the source was not asked the query — a fixed feed, not a search. */
  readonly matches?: ((candidate: RawCandidate) => boolean) | undefined;
}): readonly Lead[] {
  const leads: Lead[] = [];
  const seen = new Set<string>();

  for (const candidate of input.candidates) {
    if (candidate.link === null || candidate.title === null) {
      continue;
    }

    const screening = screenUrl(candidate.link);
    if (!screening.allowed || screening.canonical === null) {
      continue;
    }

    if (input.matches !== undefined && !input.matches(candidate)) {
      continue;
    }

    const canonical = canonicalise(new URL(screening.canonical));
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);

    leads.push({
      leadId: `lead-${hashUrl(canonical)}`,
      url: canonical,
      title: candidate.title,
      snippet: candidate.snippet,
      publisher: input.publisherName,
      publisherDomain: new URL(canonical).hostname,
      publishedAt: parsePublished(candidate.publishedAtRaw),
      language: candidate.language ?? input.fallbackLanguage,
      rung: input.rung,
      queryId: input.queryId,
      provenance: input.provenance,
    });
  }

  return leads;
}

/**
 * The publication date a source declared, with its precision.
 *
 * `DAY` rather than anything finer even when a time is given: the day is what a reviewer reasons
 * about, and claiming minute precision from a feed timestamp — which publishers routinely set to
 * the moment of *generation* — would be precision we do not have.
 *
 * An unparsable value stays null rather than being guessed at, for the same reason a missing one
 * does.
 */
export function parsePublished(raw: string | null): PreciseDate {
  if (raw === null) {
    return { value: null, precision: 'UNKNOWN' };
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    return { value: null, precision: 'UNKNOWN' };
  }
  return { value: new Date(parsed).toISOString().slice(0, 10), precision: 'DAY' };
}

/**
 * Case- and accent-folded, for matching a planned query against a fixed feed.
 *
 * Folding accents widens what is *considered*, which is the right direction here: every candidate
 * still goes through Axis A afterwards, and Axis A does not fold.
 */
export function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Does this candidate match the planned query?
 *
 * Only ever applied where the publisher was **not** asked the question — a fixed feed is their
 * whole list.
 *
 * **It matches on the query's quoted phrases, and ignores the bare terms.** `buildQueryPlan`
 * writes the subject's name as a phrase (`"Jon P. Kipp"`) and appends conduct terms unquoted
 * (`"Jon P. Kipp" fraud`). Those bare terms are relevance hints addressed to a **search engine**
 * — they tell a query feed what to rank. Applied instead as filters against a publisher's own
 * list, they are a guarantee of nothing: an SEC litigation-release item is titled with the
 * defendant's name and nothing else, so requiring `fraud` to appear in it discards the very
 * entry the query was looking for.
 *
 * That was not hypothetical. It made every live search against the SEC feed return
 * `NO_MATCHES_FOUND` for names that were *in the feed at the time*, which is the worst shape a
 * bug here can take: a confident, well-formed, entirely wrong "nothing found".
 *
 * Every quoted phrase must appear, not merely one. The plan already contains a name-only query
 * in its own right, so a feed entry naming just the person is still reached by that query; the
 * stricter reading only affects queries that anchor on a name *and* a company, where requiring
 * both is the correct meaning.
 *
 * Falls back to the old term-wise behaviour when the query carries no quoted phrase at all, so a
 * caller that builds a query some other way is not silently matched against everything.
 *
 * **This is not relevance filtering and decides nothing about adversity.** It decides whether a
 * headline is about the person the query names. FR-06's nine-signal filter is a separate step
 * whose weights belong to the labelled corpus rather than to a guess here.
 */
export function matchesQuery(queryText: string, candidate: RawCandidate): boolean {
  const haystack = `${fold(candidate.title ?? '')} ${fold(candidate.snippet ?? '')}`;

  const phrases = [...queryText.matchAll(/"([^"]+)"/g)]
    .map((match) => fold(match[1] ?? '').trim())
    .filter((phrase) => phrase.length > 1);

  if (phrases.length > 0) {
    return phrases.every((phrase) => haystack.includes(phrase));
  }

  const terms = fold(queryText)
    .split(/\s+/)
    .filter((term) => term.length > 1);
  if (terms.length === 0) {
    return true;
  }
  return terms.every((term) => haystack.includes(term));
}

/**
 * A short, stable hash of a canonical URL, for a deterministic lead id.
 *
 * Deterministic within and across runs, so one story found twice is one lead. Not cryptographic
 * and does not need to be: a collision costs two articles sharing an id inside one run's
 * deduplication, and the canonical URL is compared as well.
 */
export function hashUrl(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
