/**
 * `domainMatchCandidates` — the whole-label domain matcher behind publisher-fetch permission.
 *
 * This is the function that decides which registry record, if any, covers the publisher a
 * discovered document would be fetched from. Two ways it could be wrong, and both are the kind
 * that only show up in production:
 *
 * 1. **Too loose** — matching on a string suffix rather than whole labels would let
 *    `notsec.gov` be covered by an approval written for `sec.gov`, and `evil-example.com` by one
 *    for `example.com`. That is an approval nobody gave, reached by a typo in a URL somebody
 *    else controls.
 * 2. **Too tight** — not walking up the parent domains would mean an approval for `sec.gov`
 *    failed to cover `www.sec.gov`, so every real article would be refused and the refusal would
 *    look like a governance problem rather than a string-handling one.
 *
 * Nothing here touches Mongo: the candidate list is the whole decision, and the query that uses
 * it is an exact `$in` match on `canonicalDomains`.
 */

import { describe, expect, it } from 'vitest';

import { domainMatchCandidates } from '../src/sources/source-version.service.js';

describe('domainMatchCandidates', () => {
  it('walks up the parent domains, most specific first', () => {
    expect(domainMatchCandidates('www.sec.gov')).toEqual(['www.sec.gov', 'sec.gov']);
  });

  it('never offers a bare public suffix as a candidate', () => {
    // `gov` must not appear: a registry record matched on a TLD alone would cover every site
    // under it, which is the broadest possible approval reached by accident.
    expect(domainMatchCandidates('www.sec.gov')).not.toContain('gov');
    expect(domainMatchCandidates('example.com')).toEqual(['example.com']);
    expect(domainMatchCandidates('com')).toEqual([]);
  });

  it('splits on whole labels, so a lookalike cannot match a suffix', () => {
    // The defect this exists to prevent: 'notsec.gov'.endsWith('sec.gov') is true.
    expect(domainMatchCandidates('notsec.gov')).toEqual(['notsec.gov']);
    expect(domainMatchCandidates('notsec.gov')).not.toContain('sec.gov');
  });

  it('handles a multi-label public suffix by offering every parent', () => {
    // `co.uk` is offered and is harmless: nothing is approved against it, so it matches no
    // record. Excluding it would need a public-suffix list, which is a dependency this does not
    // need — being too generous with *candidates* is safe, because the match is still an exact
    // lookup against domains somebody actually wrote down.
    expect(domainMatchCandidates('news.example.co.uk')).toEqual([
      'news.example.co.uk',
      'example.co.uk',
      'co.uk',
    ]);
  });

  it('normalises case and a trailing root dot', () => {
    expect(domainMatchCandidates('WWW.SEC.GOV.')).toEqual(['www.sec.gov', 'sec.gov']);
  });

  it('returns nothing for an empty or whitespace domain', () => {
    expect(domainMatchCandidates('')).toEqual([]);
    expect(domainMatchCandidates('   ')).toEqual([]);
  });
});
