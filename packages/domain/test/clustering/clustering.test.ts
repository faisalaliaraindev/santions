/** FR-10 clustering rules. Tests T25, T26, T27, T28. Guards I6, I7. */

import { describe, expect, it } from 'vitest';

import {
  adjacentBuckets,
  decideClustering,
  eventClusterKey,
  serialiseClusterKey,
  withinEventWindow,
  type ClusterCandidate,
} from '../../src/clustering/rules.js';

function candidate(
  overrides: Partial<ClusterCandidate> & { documentId: string },
): ClusterCandidate {
  return {
    subjectId: 'S1',
    companyId: null,
    category: 'FRAUD_FINANCIAL_CRIME',
    proceduralStage: 'CHARGE_INDICTMENT',
    eventDate: '2024-05-14',
    canonicalUrl: `https://example.test/${overrides.documentId}`,
    contentHash: `hash-${overrides.documentId}`,
    nearDuplicateKey: null,
    originatingNewsroomId: 'newsroom-a',
    ...overrides,
  };
}

describe('decideClustering', () => {
  it('T27 — never clusters across subjects, however similar the text', () => {
    const a = candidate({ documentId: 'A' });
    const b = candidate({ documentId: 'B', subjectId: 'S2', contentHash: 'hash-A' });
    expect(decideClustering(a, b).action).toBe('KEEP_SEPARATE');
  });

  it('collapses exact copies by content hash', () => {
    const a = candidate({ documentId: 'A' });
    const b = candidate({ documentId: 'B', contentHash: 'hash-A' });
    expect(decideClustering(a, b).action).toBe('MERGE_DOCUMENT');
  });

  it('T25 — collapses tracking-parameter variants sharing a canonical URL', () => {
    const a = candidate({ documentId: 'A', canonicalUrl: 'https://example.test/story' });
    const b = candidate({ documentId: 'B', canonicalUrl: 'https://example.test/story' });
    expect(decideClustering(a, b).action).toBe('MERGE_DOCUMENT');
  });

  it('T25 — keeps meaningfully different documents separate', () => {
    const a = candidate({ documentId: 'A', eventDate: '2020-01-01' });
    const b = candidate({
      documentId: 'B',
      category: 'MARKET_ABUSE',
      eventDate: '2023-11-02',
    });
    expect(decideClustering(a, b).action).toBe('KEEP_SEPARATE');
  });

  it('T26 — groups a syndication family and marks it as provenance only', () => {
    const a = candidate({ documentId: 'A', nearDuplicateKey: 'sim-1' });
    const b = candidate({
      documentId: 'B',
      nearDuplicateKey: 'sim-1',
      originatingNewsroomId: 'newsroom-b',
    });
    const decision = decideClustering(a, b);
    expect(decision.action).toBe('MERGE_SYNDICATION_FAMILY');
    expect(decision.reason).toMatch(/excluded from the independence count/);
  });

  it('merges different reports of the same event by entity-anchored key', () => {
    const a = candidate({ documentId: 'A' });
    const b = candidate({
      documentId: 'B',
      eventDate: '2024-05-20',
      originatingNewsroomId: 'newsroom-b',
    });
    expect(decideClustering(a, b).action).toBe('MERGE_EVENT');
  });

  it('T28 — links an acquittal rather than suppressing it as a near-duplicate', () => {
    const charge = candidate({ documentId: 'A', nearDuplicateKey: 'sim-1' });
    const acquittal = candidate({
      documentId: 'B',
      nearDuplicateKey: 'sim-1',
      contentHash: 'hash-A',
      proceduralStage: 'ACQUITTAL_DISMISSAL_OVERTURNED',
    });
    // Identical hash and similarity key: only the outcome check saves this document.
    const decision = decideClustering(charge, acquittal);
    expect(decision.action).toBe('LINK_AS_OUTCOME');
  });

  it('links corrections, retractions and appeals the same way', () => {
    const charge = candidate({ documentId: 'A' });
    for (const stage of [
      'CORRECTION_RETRACTION',
      'APPEAL_PENDING',
      'SPENT_EXPUNGED_TIME_BARRED',
    ] as const) {
      const outcome = candidate({ documentId: 'B', proceduralStage: stage });
      expect(decideClustering(charge, outcome).action, stage).toBe('LINK_AS_OUTCOME');
    }
  });

  it('does not link two outcome documents as an outcome of each other', () => {
    const a = candidate({ documentId: 'A', proceduralStage: 'ACQUITTAL_DISMISSAL_OVERTURNED' });
    const b = candidate({ documentId: 'B', proceduralStage: 'CORRECTION_RETRACTION' });
    expect(decideClustering(a, b).action).not.toBe('LINK_AS_OUTCOME');
  });
});

describe('eventClusterKey', () => {
  it('is entity-anchored: the subject leads the key', () => {
    const key = eventClusterKey(candidate({ documentId: 'A' }));
    expect(key.subjectId).toBe('S1');
    expect(serialiseClusterKey(key)).toMatch(/^S1\|/);
  });

  it('treats the date bucket as a blocking hint, not part of cluster identity', () => {
    const a = eventClusterKey(candidate({ documentId: 'A', eventDate: '2024-05-14' }));
    const c = eventClusterKey(candidate({ documentId: 'C', eventDate: '2025-05-14' }));
    // A year apart is definitively a different bucket.
    expect(a.eventDateBucket).not.toBe(c.eventDateBucket);
    // The serialised identity excludes the bucket entirely.
    expect(serialiseClusterKey(a)).toBe(serialiseClusterKey(c));
  });

  it('scans neighbouring buckets so a boundary-straddling event is still found', () => {
    const key = eventClusterKey(candidate({ documentId: 'A', eventDate: '2024-05-14' }));
    expect(adjacentBuckets(key)).toHaveLength(3);
    expect(adjacentBuckets({ ...key, eventDateBucket: null })).toEqual([null]);
  });

  it('withinEventWindow compares real dates, not buckets', () => {
    // Six days apart: the same event, even if fixed buckets would separate them.
    expect(withinEventWindow('2024-05-14', '2024-05-20')).toBe(true);
    expect(withinEventWindow('2024-05-14', '2025-05-14')).toBe(false);
    // Two unknown dates are not evidence of simultaneity.
    expect(withinEventWindow(null, null)).toBe(false);
    expect(withinEventWindow('2024-05-14', null)).toBe(false);
  });

  it('leaves the bucket null for an unknown or unparsable event date', () => {
    expect(
      eventClusterKey(candidate({ documentId: 'A', eventDate: null })).eventDateBucket,
    ).toBeNull();
    expect(
      eventClusterKey(candidate({ documentId: 'A', eventDate: 'nope' })).eventDateBucket,
    ).toBeNull();
  });
});
