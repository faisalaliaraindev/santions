/**
 * `wikinews-en` — the proposal is schema-valid AND deliberately not activatable.
 *
 * Both halves matter. A record that does not parse is a conformance error an administrator meets
 * when they try to submit it. A record that parses *and* carries a robots position and a
 * first-contact approval nobody gave is worse: it is activatable, and the first thing it would
 * do is make a request to a publisher this project has never contacted.
 *
 * These tests exist because the second failure is the one a future session would cause
 * accidentally — reading `NOT_ESTABLISHED` as an unfinished field to be tidied up rather than as
 * the recorded state of a decision nobody has taken. Same reason the D20 refusal has tests.
 */

import { describe, expect, it } from 'vitest';

import {
  WIKINEWS_EN_CANONICAL_DOMAIN,
  WIKINEWS_EN_CONTENT,
  WIKINEWS_EN_SOURCE_ID,
  wikinewsEnContent,
} from '../src/sources/registry/wikinews-en.js';

describe('the Wikinews publisher proposal', () => {
  it('parses through the source content schema', () => {
    expect(() => wikinewsEnContent()).not.toThrow();
  });

  it('is scoped to exactly one domain', () => {
    // Not `wikinews.org`, not a Wikimedia wildcard. An approval that covered every project would
    // be an approval nobody scoped.
    expect(WIKINEWS_EN_CONTENT.canonicalDomains).toEqual(['en.wikinews.org']);
    expect(WIKINEWS_EN_CANONICAL_DOMAIN).toBe('en.wikinews.org');
    expect(WIKINEWS_EN_SOURCE_ID).toBe('wikinews-en');
  });

  it('records NO first-contact approval, so the gate refuses it', () => {
    // D-042. Filling this is a named human decision through the approval lifecycle, and this
    // assertion is what makes that load-bearing rather than advisory.
    expect(WIKINEWS_EN_CONTENT.accessPolicy.firstContactApproval).toBeNull();
  });

  it('records NO established robots position, because nobody has read robots.txt', () => {
    expect(WIKINEWS_EN_CONTENT.robotsPosition).toBe('NOT_ESTABLISHED');
  });

  it('says in the policy summary that no request has been made', () => {
    // The summary is the version content an administrator actually reads before approving. A
    // comment in the source file would not reach them.
    expect(WIKINEWS_EN_CONTENT.accessPolicy.policySummary).toContain('DESK RESEARCH ONLY');
    expect(WIKINEWS_EN_CONTENT.accessPolicy.policySummary).toContain('no request has been made');
  });

  it('records no endpoint, because this source is never polled', () => {
    // It is reached only by following a link discovery produced. A recorded endpoint would be a
    // second route to the publisher that the discovery path does not go through (D-043).
    expect(WIKINEWS_EN_CONTENT.accessPolicy.endpointUrl).toBeNull();
    expect(WIKINEWS_EN_CONTENT.connectorType).toBe('EVIDENCE_FETCH_HTTP');
  });

  it('is lead-supporting authority, not a wire service', () => {
    // Above a metasearch snippet, below a regulator's own record. A volunteer news wiki.
    expect(WIKINEWS_EN_CONTENT.authorityTier).toBe(4);
    expect(WIKINEWS_EN_CONTENT.cascadeRung).toBe(5);
  });
});
