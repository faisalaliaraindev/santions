/**
 * FR-10 — event clustering and independence (the pure rules).
 *
 * Clustering runs *before* banding, because independence is an input to Axis D.
 *
 * The near-duplicate detection itself (SimHash/MinHash over the search index) is I/O and
 * lives in `packages/providers`. What lives here are the rules that must hold whatever the
 * similarity implementation is.
 */

import type { AdverseCategory } from '../taxonomy/categories.js';
import { isOutcomeStage, type StageValue } from '../stages/ladder.js';

export type ClusterLevel = 'DOCUMENT' | 'SYNDICATION_FAMILY' | 'EVENT' | 'EVENT_CHAIN';

export interface ClusterCandidate {
  readonly documentId: string;
  /** The subject this document was retrieved for. Clustering never crosses subjects. */
  readonly subjectId: string;
  /** Company the event concerns, when company-anchored. */
  readonly companyId: string | null;
  readonly category: AdverseCategory | null;
  readonly proceduralStage: StageValue;
  /** ISO date of the event, or null. */
  readonly eventDate: string | null;
  readonly canonicalUrl: string;
  readonly contentHash: string;
  /** SimHash/MinHash bucket assigned by the provider layer. */
  readonly nearDuplicateKey: string | null;
  readonly originatingNewsroomId: string;
}

export interface EventClusterKey {
  readonly subjectId: string;
  readonly companyId: string | null;
  readonly category: AdverseCategory | null;
  readonly proceduralStage: StageValue;
  /**
   * Coarse bucket index for the event date, for *blocking only* — it decides which candidates
   * are compared, never whether they cluster.
   *
   * Fixed buckets have a boundary problem: two reports of the same event dated 30 and 31 May
   * can land either side of a boundary. So a lookup must also fetch the adjacent buckets
   * (see `adjacentBuckets`), and the actual decision uses `withinEventWindow` on the real
   * dates. Null when the event date is unknown or unparsable.
   */
  readonly eventDateBucket: number | null;
}

/** Default event-date window in days. Two reports of one event rarely agree on the day. */
export const DEFAULT_EVENT_DATE_WINDOW_DAYS = 30;

function epochMillis(isoDate: string | null): number | null {
  if (isoDate === null) {
    return null;
  }
  const t = new Date(`${isoDate.slice(0, 10)}T00:00:00.000Z`).getTime();
  return Number.isNaN(t) ? null : t;
}

function dateBucket(isoDate: string | null, windowDays: number): number | null {
  const t = epochMillis(isoDate);
  return t === null ? null : Math.floor(t / (windowDays * 86_400_000));
}

/**
 * The buckets an index lookup must scan for a given key: its own and both neighbours.
 * Without this, the blocking key silently drops events that straddle a bucket boundary.
 */
export function adjacentBuckets(key: EventClusterKey): readonly (number | null)[] {
  return key.eventDateBucket === null
    ? [null]
    : [key.eventDateBucket - 1, key.eventDateBucket, key.eventDateBucket + 1];
}

/**
 * True when two event dates are close enough to be the same event.
 *
 * Two unknown dates are *not* within the window of each other: "we do not know when either
 * happened" is not evidence that they happened at the same time.
 */
export function withinEventWindow(
  a: string | null,
  b: string | null,
  windowDays: number = DEFAULT_EVENT_DATE_WINDOW_DAYS,
): boolean {
  const ta = epochMillis(a);
  const tb = epochMillis(b);
  if (ta === null || tb === null) {
    return false;
  }
  return Math.abs(ta - tb) <= windowDays * 86_400_000;
}

/**
 * Rule: clustering is *entity-anchored*, never text-similarity-only, and never crosses
 * subjects. The subject id is the first component of every key for exactly that reason
 * (T27).
 */
export function eventClusterKey(
  candidate: ClusterCandidate,
  windowDays: number = DEFAULT_EVENT_DATE_WINDOW_DAYS,
): EventClusterKey {
  return {
    subjectId: candidate.subjectId,
    companyId: candidate.companyId,
    category: candidate.category,
    proceduralStage: candidate.proceduralStage,
    eventDateBucket: dateBucket(candidate.eventDate, windowDays),
  };
}

/** Serialise the entity part of a key. The date bucket is deliberately excluded: it is a
 * blocking hint, not part of cluster identity. */
export function serialiseClusterKey(key: EventClusterKey): string {
  return [key.subjectId, key.companyId ?? '-', key.category ?? '-', key.proceduralStage].join('|');
}

export type ClusterDecision =
  | { readonly action: 'MERGE_DOCUMENT'; readonly reason: string }
  | { readonly action: 'MERGE_SYNDICATION_FAMILY'; readonly reason: string }
  | { readonly action: 'MERGE_EVENT'; readonly reason: string }
  | { readonly action: 'LINK_AS_OUTCOME'; readonly reason: string }
  | { readonly action: 'KEEP_SEPARATE'; readonly reason: string };

/**
 * Decide how a new candidate relates to an existing clustered document.
 *
 * The order matters. An outcome document is checked *before* duplicate detection, because
 * suppressing an acquittal as a near-duplicate of the conviction it reverses is the single
 * most damaging clustering bug available (invariant I7, T28).
 */
export function decideClustering(
  existing: ClusterCandidate,
  candidate: ClusterCandidate,
  windowDays: number = DEFAULT_EVENT_DATE_WINDOW_DAYS,
): ClusterDecision {
  if (existing.subjectId !== candidate.subjectId) {
    return {
      action: 'KEEP_SEPARATE',
      reason: 'Different subjects; clustering never crosses subjects.',
    };
  }

  // Outcome documents link, never collapse.
  const candidateIsOutcome = isOutcomeStage(candidate.proceduralStage);
  const existingIsOutcome = isOutcomeStage(existing.proceduralStage);
  if (candidateIsOutcome !== existingIsOutcome) {
    return {
      action: 'LINK_AS_OUTCOME',
      reason:
        'One document carries an outcome stage; linked into the event chain and retained at equal prominence (I7).',
    };
  }

  if (existing.contentHash === candidate.contentHash) {
    return { action: 'MERGE_DOCUMENT', reason: 'Identical content hash; exact copy.' };
  }

  if (existing.canonicalUrl === candidate.canonicalUrl) {
    return {
      action: 'MERGE_DOCUMENT',
      reason: 'Same canonical URL after reviewed tracking-parameter stripping.',
    };
  }

  if (
    candidate.nearDuplicateKey !== null &&
    candidate.nearDuplicateKey === existing.nearDuplicateKey
  ) {
    return {
      action: 'MERGE_SYNDICATION_FAMILY',
      reason:
        'Near-duplicate text with a shared syndication key; retained as provenance and excluded from the independence count (I6).',
    };
  }

  const sameEntity =
    serialiseClusterKey(eventClusterKey(existing, windowDays)) ===
    serialiseClusterKey(eventClusterKey(candidate, windowDays));

  // The date test runs on the real dates, not the blocking bucket, so two reports of one
  // event do not fall apart because they straddle a bucket boundary.
  if (sameEntity && withinEventWindow(existing.eventDate, candidate.eventDate, windowDays)) {
    return {
      action: 'MERGE_EVENT',
      reason: `Same subject, company, category and stage, with event dates within ${String(windowDays)} days.`,
    };
  }

  return { action: 'KEEP_SEPARATE', reason: 'No entity-anchored cluster key agreement.' };
}
