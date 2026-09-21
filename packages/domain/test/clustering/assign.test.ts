/**
 * FR-10 — clustering assignment and the independence count.
 *
 * The distinction these tests exist to protect, in one line each:
 *
 *  - ten copies of one story are one confirmation;
 *  - four regulators naming one person are four.
 *
 * Getting the first wrong inflates evidence against a person. Getting the second wrong destroys
 * corroboration they are entitled to have counted. A change here that fixes one by breaking the
 * other has not fixed anything.
 */

import { describe, expect, it } from 'vitest';

import {
  assignClusters,
  computeAuthority,
  DEFAULT_NEAR_DUPLICATE_DISTANCE,
  fingerprintDistance,
  fingerprintText,
  isNearDuplicate,
  type AssignableCandidate,
  type ClusteredSource,
} from '../../src/index.js';

/** Enough running text to clear `MIN_SHINGLES`, so the fingerprint is trusted. */
const WIRE_STORY =
  'The Securities and Exchange Commission today announced charges against a former investment ' +
  'adviser who the agency says misappropriated client funds over a period of four years. ' +
  'According to the complaint filed in federal district court, the adviser transferred money ' +
  'from pooled client accounts into a personal brokerage account and concealed the transfers ' +
  'with fabricated account statements sent to investors every quarter.';

/** The same story as a syndicating site would carry it: new headline, trimmed tail. */
const SYNDICATED_COPY =
  'Regulator charges former adviser. The Securities and Exchange Commission today announced ' +
  'charges against a former investment adviser who the agency says misappropriated client ' +
  'funds over a period of four years. According to the complaint filed in federal district ' +
  'court, the adviser transferred money from pooled client accounts into a personal brokerage ' +
  'account and concealed the transfers with fabricated account statements sent to investors.';

/**
 * A different enforcement action entirely, in the **same** publisher house style. This is the
 * hard negative: everything about it reads like the wire story except the facts.
 */
const DIFFERENT_ACTION_SAME_BOILERPLATE =
  'The Securities and Exchange Commission today announced charges against a former portfolio ' +
  'manager who the agency says engaged in insider trading ahead of three merger announcements. ' +
  'According to the complaint filed in federal district court, the manager purchased call ' +
  'options in advance of public announcements and tipped a relative who traded in the same ' +
  'securities on the following morning.';

/** The wire story after a heavier edit: new lede, house note appended. */
const HEAVILY_EDITED_COPY =
  'Former adviser charged with misappropriating client money, regulator says. ' +
  WIRE_STORY +
  ' This article was produced by our newsroom.';

/** A different story about the same person, written independently. */
const INDEPENDENT_REPORT =
  'A tribunal in London has barred a financial adviser from the industry after finding that ' +
  'she failed to disclose commission arrangements to twenty three retail clients between the ' +
  'years in question. The decision notice sets out that the adviser accepted payments from ' +
  'product providers while presenting herself to clients as offering wholly independent advice ' +
  'on the products she recommended to them over that period.';

function candidate(overrides: Partial<AssignableCandidate> = {}): AssignableCandidate {
  return {
    documentId: 'doc',
    subjectId: 'subject-1',
    companyId: null,
    category: 'FRAUD_FINANCIAL_CRIME',
    proceduralStage: 'CHARGE_INDICTMENT',
    eventDate: '2025-03-01',
    canonicalUrl: 'https://example.test/a',
    contentHash: 'hash-a',
    nearDuplicateKey: null,
    originatingNewsroomId: 'example.test',
    isIndependentAuthority: false,
    issuingAuthorityId: null,
    nearDuplicateFingerprint: null,
    ...overrides,
  };
}

function axisDFor(
  assignment: ReturnType<typeof assignClusters>,
  candidates: readonly AssignableCandidate[],
  tiers: Readonly<Record<string, 1 | 2 | 3 | 4 | 5>>,
): ReturnType<typeof computeAuthority> {
  const cluster = assignment.clusters[0];
  const byId = new Map(candidates.map((c) => [c.documentId, c] as const));
  const sources: ClusteredSource[] = (cluster?.members ?? []).map((member): ClusteredSource => {
    const c = byId.get(member.documentId);
    return {
      documentId: member.documentId,
      tier: tiers[member.documentId] ?? 2,
      originatingNewsroomId: c?.originatingNewsroomId ?? member.documentId,
      issuingAuthorityId: c?.issuingAuthorityId ?? null,
      isSyndicatedCopy: member.isSuppressedCopy,
    };
  });
  return computeAuthority(sources);
}

describe('FR-10 — duplicate and syndicated evidence collapses', () => {
  it('the same document under two URLs is one finding', () => {
    const candidates = [
      candidate({ documentId: 'A', canonicalUrl: 'https://wire.test/story' }),
      candidate({
        documentId: 'B',
        canonicalUrl: 'https://wire.test/story',
        contentHash: 'hash-b',
        originatingNewsroomId: 'other.test',
      }),
    ];
    const assignment = assignClusters(candidates);

    expect(assignment.clusters).toHaveLength(1);
    expect(assignment.clusters[0]?.representatives).toEqual(['A']);
    expect(assignment.memberOf.get('B')?.isSuppressedCopy).toBe(true);
  });

  it('identical content under different URLs is one finding', () => {
    const candidates = [
      candidate({ documentId: 'A', contentHash: 'same' }),
      candidate({
        documentId: 'B',
        contentHash: 'same',
        canonicalUrl: 'https://elsewhere.test/b',
        originatingNewsroomId: 'elsewhere.test',
      }),
    ];
    const assignment = assignClusters(candidates);

    expect(assignment.clusters[0]?.representatives).toEqual(['A']);
    expect(assignment.memberOf.get('B')?.reason).toBe('DUPLICATE_DOCUMENT');
  });

  it('ten sites carrying one wire story are one independent confirmation, not ten', () => {
    const origin = fingerprintText(WIRE_STORY);
    const copy = fingerprintText(SYNDICATED_COPY);
    expect(isNearDuplicate(origin, copy)).toBe(true);

    const candidates: AssignableCandidate[] = [
      candidate({
        documentId: 'wire',
        canonicalUrl: 'https://wire.test/story',
        contentHash: 'h-wire',
        originatingNewsroomId: 'wire.test',
        nearDuplicateFingerprint: origin,
      }),
      ...Array.from({ length: 9 }, (_, i) =>
        candidate({
          documentId: `copy-${String(i)}`,
          canonicalUrl: `https://site${String(i)}.test/story`,
          contentHash: `h-copy-${String(i)}`,
          originatingNewsroomId: `site${String(i)}.test`,
          nearDuplicateFingerprint: copy,
        }),
      ),
    ];

    const assignment = assignClusters(candidates);

    expect(assignment.clusters).toHaveLength(1);
    expect(assignment.clusters[0]?.representatives).toEqual(['wire']);
    expect(
      assignment.clusters[0]?.members.filter((member) => member.isSuppressedCopy),
    ).toHaveLength(9);

    // The point of the whole exercise: the independence count.
    const axisD = axisDFor(assignment, candidates, {});
    expect(axisD.independenceCount).toBe(1);
    expect(axisD.excludedFromCount).toHaveLength(9);
  });

  it('one SEC press release rediscovered through three aggregators counts once', () => {
    const text = fingerprintText(WIRE_STORY);
    const candidates = [
      candidate({
        documentId: 'sec',
        canonicalUrl: 'https://sec.gov/litigation/1',
        contentHash: 'h-sec',
        originatingNewsroomId: 'sec.gov',
        isIndependentAuthority: true,
        issuingAuthorityId: 'us-sec',
        nearDuplicateFingerprint: text,
      }),
      ...['agg-1', 'agg-2', 'agg-3'].map((id) =>
        candidate({
          documentId: id,
          canonicalUrl: `https://${id}.test/sec-release`,
          contentHash: `h-${id}`,
          originatingNewsroomId: `${id}.test`,
          nearDuplicateFingerprint: text,
        }),
      ),
    ];

    const assignment = assignClusters(candidates);
    const axisD = axisDFor(assignment, candidates, { sec: 1 });

    expect(assignment.clusters[0]?.representatives).toEqual(['sec']);
    expect(axisD.independenceCount).toBe(1);
    expect(axisD.distinctTier1Authorities).toEqual(['us-sec']);
  });

  it('two independently written reports of one event are two confirmations', () => {
    const candidates = [
      candidate({
        documentId: 'A',
        canonicalUrl: 'https://one.test/a',
        contentHash: 'h-a',
        originatingNewsroomId: 'one.test',
        nearDuplicateFingerprint: fingerprintText(WIRE_STORY),
      }),
      candidate({
        documentId: 'B',
        canonicalUrl: 'https://two.test/b',
        contentHash: 'h-b',
        originatingNewsroomId: 'two.test',
        nearDuplicateFingerprint: fingerprintText(INDEPENDENT_REPORT),
      }),
    ];

    const assignment = assignClusters(candidates);
    const axisD = axisDFor(assignment, candidates, {});

    // They cluster as one event, and both survive as findings.
    expect(assignment.clusters).toHaveLength(1);
    expect(assignment.clusters[0]?.representatives).toEqual(['A', 'B']);
    expect(axisD.independenceCount).toBe(2);
  });

  it('a document too short to fingerprint is never suppressed on similarity', () => {
    const short = fingerprintText('Adviser charged.');
    expect(short).toBeNull();

    const candidates = [
      candidate({
        documentId: 'A',
        canonicalUrl: 'https://one.test/a',
        contentHash: 'h-a',
        originatingNewsroomId: 'one.test',
        nearDuplicateFingerprint: short,
      }),
      candidate({
        documentId: 'B',
        canonicalUrl: 'https://two.test/b',
        contentHash: 'h-b',
        originatingNewsroomId: 'two.test',
        nearDuplicateFingerprint: short,
      }),
    ];

    const assignment = assignClusters(candidates);
    expect(assignment.clusters[0]?.representatives).toEqual(['A', 'B']);
  });
});

describe('FR-10 — independent authority evidence never collapses', () => {
  it('SEC, DOJ, FCA and OFAC on one subject and one event remain four findings', () => {
    const shared = {
      canonicalUrl: 'https://authority.test/x',
      eventDate: '2025-03-01',
    } as const;
    const candidates: AssignableCandidate[] = [
      candidate({
        ...shared,
        documentId: 'sec',
        contentHash: 'h',
        canonicalUrl: 'https://sec.gov/x',
        originatingNewsroomId: 'sec.gov',
        isIndependentAuthority: true,
        issuingAuthorityId: 'us-sec',
      }),
      candidate({
        ...shared,
        documentId: 'doj',
        contentHash: 'h',
        canonicalUrl: 'https://justice.gov/x',
        originatingNewsroomId: 'justice.gov',
        isIndependentAuthority: true,
        issuingAuthorityId: 'us-doj',
      }),
      candidate({
        ...shared,
        documentId: 'fca',
        contentHash: 'h',
        canonicalUrl: 'https://fca.org.uk/x',
        originatingNewsroomId: 'fca.org.uk',
        isIndependentAuthority: true,
        issuingAuthorityId: 'uk-fca',
      }),
      candidate({
        ...shared,
        documentId: 'ofac',
        contentHash: 'h',
        canonicalUrl: 'https://treasury.gov/x',
        originatingNewsroomId: 'treasury.gov',
        isIndependentAuthority: true,
        issuingAuthorityId: 'us-ofac',
      }),
    ];

    const assignment = assignClusters(candidates);

    // Note the shared `contentHash`: even with the strongest possible duplicate signal, an
    // authority record is not folded away. It clusters as the same event and keeps its finding.
    expect(assignment.clusters).toHaveLength(1);
    expect(assignment.clusters[0]?.representatives).toEqual(['sec', 'doj', 'fca', 'ofac']);
    expect(assignment.clusters[0]?.members.some((member) => member.isSuppressedCopy)).toBe(false);

    const axisD = axisDFor(assignment, candidates, { sec: 1, doj: 1, fca: 1, ofac: 1 });
    expect(axisD.independenceCount).toBe(4);
    expect(axisD.distinctTier1Authorities).toEqual(['uk-fca', 'us-doj', 'us-ofac', 'us-sec']);
  });

  it('an authority record explains in its detail why it was not folded away', () => {
    const candidates = [
      candidate({ documentId: 'press', contentHash: 'same', originatingNewsroomId: 'press.test' }),
      candidate({
        documentId: 'sec',
        contentHash: 'same',
        canonicalUrl: 'https://sec.gov/x',
        originatingNewsroomId: 'sec.gov',
        isIndependentAuthority: true,
        issuingAuthorityId: 'us-sec',
      }),
    ];

    const assignment = assignClusters(candidates);
    const member = assignment.memberOf.get('sec');

    expect(member?.isSuppressedCopy).toBe(false);
    expect(member?.reason).toBe('SAME_EVENT');
    expect(member?.detail).toContain('published by the authority that issued it');
  });

  it('clustering never crosses subjects', () => {
    const assignment = assignClusters([
      candidate({ documentId: 'A', subjectId: 'subject-1', contentHash: 'same' }),
      candidate({ documentId: 'B', subjectId: 'subject-2', contentHash: 'same' }),
    ]);

    expect(assignment.clusters).toHaveLength(2);
  });

  it('an outcome document links into the chain and is never suppressed (I7)', () => {
    const text = fingerprintText(WIRE_STORY);
    const assignment = assignClusters([
      candidate({
        documentId: 'charge',
        proceduralStage: 'CHARGE_INDICTMENT',
        nearDuplicateFingerprint: text,
      }),
      candidate({
        documentId: 'acquittal',
        proceduralStage: 'ACQUITTAL_DISMISSAL_OVERTURNED',
        canonicalUrl: 'https://example.test/b',
        contentHash: 'hash-b',
        // Deliberately the same fingerprint: an acquittal reported in near-identical words to
        // the charge must still not be suppressed as a copy of it.
        nearDuplicateFingerprint: text,
      }),
    ]);

    expect(assignment.memberOf.get('acquittal')?.reason).toBe('EVENT_CHAIN_OUTCOME');
    expect(assignment.memberOf.get('acquittal')?.isSuppressedCopy).toBe(false);
    expect(assignment.clusters[0]?.representatives).toEqual(['charge', 'acquittal']);
  });
});

describe('FR-10 — the near-duplicate threshold, and the measurements behind it', () => {
  // These four figures are why `DEFAULT_NEAR_DUPLICATE_DISTANCE` is what it is. They are pinned
  // so that a change to the hash, the shingle width or the token rules fails here rather than
  // silently moving the boundary between "copy" and "independent report".
  it('a syndicated copy with a new headline is 6 bits away', () => {
    expect(fingerprintDistance(fingerprintText(WIRE_STORY), fingerprintText(SYNDICATED_COPY))).toBe(
      6,
    );
  });

  it('a heavier edit of the same story is 9 bits away', () => {
    expect(
      fingerprintDistance(fingerprintText(WIRE_STORY), fingerprintText(HEAVILY_EDITED_COPY)),
    ).toBe(9);
  });

  it('a DIFFERENT action in identical house style is 21 bits away and must not collapse', () => {
    const distance = fingerprintDistance(
      fingerprintText(WIRE_STORY),
      fingerprintText(DIFFERENT_ACTION_SAME_BOILERPLATE),
    );
    expect(distance).toBe(21);
    expect(distance).toBeGreaterThan(DEFAULT_NEAR_DUPLICATE_DISTANCE);
  });

  it('unrelated stories are 34 bits away', () => {
    expect(
      fingerprintDistance(fingerprintText(WIRE_STORY), fingerprintText(INDEPENDENT_REPORT)),
    ).toBe(34);
  });

  it('the threshold sits in the gap, with margin on both sides', () => {
    expect(DEFAULT_NEAR_DUPLICATE_DISTANCE).toBeGreaterThan(9);
    expect(DEFAULT_NEAR_DUPLICATE_DISTANCE).toBeLessThan(21);
  });

  it('two different actions in one house style stay two findings', () => {
    const assignment = assignClusters([
      candidate({
        documentId: 'A',
        contentHash: 'h-a',
        canonicalUrl: 'https://sec.gov/a',
        proceduralStage: 'CHARGE_INDICTMENT',
        eventDate: '2025-03-01',
        nearDuplicateFingerprint: fingerprintText(WIRE_STORY),
      }),
      candidate({
        documentId: 'B',
        contentHash: 'h-b',
        canonicalUrl: 'https://sec.gov/b',
        proceduralStage: 'CHARGE_INDICTMENT',
        // Far enough apart in time that they are not the same event either.
        eventDate: '2025-11-20',
        nearDuplicateFingerprint: fingerprintText(DIFFERENT_ACTION_SAME_BOILERPLATE),
      }),
    ]);

    expect(assignment.clusters).toHaveLength(2);
  });
});

describe('FR-10 — near-duplicate fingerprints', () => {
  it('is stable for identical text and insensitive to case and punctuation', () => {
    const a = fingerprintText(WIRE_STORY);
    const b = fingerprintText(WIRE_STORY.toUpperCase().replace(/,/gu, ';'));
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('separates genuinely different stories', () => {
    expect(isNearDuplicate(fingerprintText(WIRE_STORY), fingerprintText(INDEPENDENT_REPORT))).toBe(
      false,
    );
  });

  it('a null fingerprint never matches anything, including another null', () => {
    expect(isNearDuplicate(null, null)).toBe(false);
    expect(isNearDuplicate(fingerprintText(WIRE_STORY), null)).toBe(false);
  });

  it('returns null below the shingle floor rather than an untrustworthy fingerprint', () => {
    expect(fingerprintText('')).toBeNull();
    expect(fingerprintText('one two three four five six')).toBeNull();
  });
});
