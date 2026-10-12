/**
 * The GDELT DOC 2.0 parser — rung 3.
 *
 * One thing carries the weight, and it is the same thing the RSS parser carries: **three
 * outcomes, not two.** A body that is not JSON, JSON without an `articles` array, and an empty
 * `articles` array are three different facts, and only the last one means "GDELT has nothing
 * about this person". Collapsing them turns a shape change into clean results for everybody
 * searched afterwards, silently, with nothing thrown (FR-05 volatility control, T84).
 *
 * The shape here is GDELT's documented one. **It has not been verified against the live service
 * by this project** — no request has been made — which is exactly why the parser fails loudly on
 * a mismatch instead of returning nothing.
 */

import { describe, expect, it } from 'vitest';

import { gdeltDate, parseGdelt } from '../src/sources/gdelt-discovery.adapter.js';

const ARTICLES = JSON.stringify({
  articles: [
    {
      url: 'https://www.example-news.us/sec-charges-whitfield',
      url_mobile: '',
      title: 'SEC charges Jane Marie Whitfield with fraud',
      seendate: '20260818T140000Z',
      socialimage: 'https://www.example-news.us/img.jpg',
      domain: 'example-news.us',
      language: 'English',
      sourcecountry: 'United States',
    },
    {
      url: 'https://www.otra-fuente.cr/nota',
      title: 'Otra nota',
      seendate: '20260819T090000Z',
      domain: 'otra-fuente.cr',
      language: 'Spanish',
      sourcecountry: 'Costa Rica',
    },
  ],
});

describe('three outcomes, not two', () => {
  it('parses a documented article list', () => {
    const result = parseGdelt(ARTICLES);
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') {
      return;
    }
    expect(result.articles).toHaveLength(2);
    expect(result.articles[0]?.title).toBe('SEC charges Jane Marie Whitfield with fraud');
    expect(result.articles[0]?.link).toBe('https://www.example-news.us/sec-charges-whitfield');
  });

  it('treats an empty article list as a genuine empty answer', () => {
    // The one case that is not a gap. GDELT was asked, GDELT answered, GDELT had nothing.
    const result = parseGdelt(JSON.stringify({ articles: [] }));
    expect(result.kind).toBe('OK');
    if (result.kind === 'OK') {
      expect(result.articles).toHaveLength(0);
    }
  });

  it('reports a non-JSON body as UNPARSABLE, never as empty', () => {
    // GDELT serves an HTML error page on some failures. It parses as neither JSON nor articles,
    // and reporting it as "no news" would be the worst available answer.
    const result = parseGdelt('<html><body>Service temporarily unavailable</body></html>');
    expect(result.kind).toBe('UNPARSABLE');
  });

  it('reports JSON with no articles array as UNRECOGNISED, never as empty', () => {
    const result = parseGdelt(JSON.stringify({ status: 'error', message: 'query too broad' }));
    expect(result.kind).toBe('UNRECOGNISED');
    if (result.kind === 'UNRECOGNISED') {
      // The detail names the keys it did find, because "the shape changed" is not actionable at
      // three in the morning and "it returned status and message" is.
      expect(result.detail).toContain('status');
      expect(result.detail).toContain('message');
    }
  });

  it('reports a JSON array at the root as UNRECOGNISED', () => {
    expect(parseGdelt('[]').kind).toBe('UNRECOGNISED');
  });
});

describe('what it reads off an article, and what it refuses to', () => {
  it('never synthesises a snippet GDELT did not publish', () => {
    // The article list carries no snippet. Null, not the title — a snippet is what FR-06's
    // relevance filter scores, and one invented from the title would be scored as though the
    // publisher had written it.
    const result = parseGdelt(ARTICLES);
    if (result.kind === 'OK') {
      expect(result.articles[0]?.snippet).toBeNull();
    }
  });

  it('carries the declared language rather than guessing one', () => {
    const result = parseGdelt(ARTICLES);
    if (result.kind === 'OK') {
      expect(result.articles[0]?.language).toBe('English');
      expect(result.articles[1]?.language).toBe('Spanish');
    }
  });

  it('leaves an article with no url as something the lead mapper will drop', () => {
    const result = parseGdelt(JSON.stringify({ articles: [{ title: 'No link here' }] }));
    if (result.kind === 'OK') {
      expect(result.articles[0]?.link).toBeNull();
    }
  });
});

describe('seendate', () => {
  it('reshapes GDELT time into something Date.parse accepts', () => {
    // `YYYYMMDDTHHMMSSZ` is not ISO and `Date.parse` rejects it. Reshaped rather than
    // hand-parsed, so the failure mode is a null date rather than a wrong one.
    expect(gdeltDate('20260818T140000Z')).toBe('2026-08-18T14:00:00Z');
    expect(Number.isNaN(Date.parse(gdeltDate('20260818T140000Z') ?? ''))).toBe(false);
  });

  it('returns null for anything that is not that shape', () => {
    // FR-07: a date nobody published is never invented, and a half-understood timestamp is
    // exactly how one gets invented.
    for (const bad of ['2026-08-18', '20260818', 'yesterday', '', 'T140000Z']) {
      expect(gdeltDate(bad), bad).toBeNull();
    }
  });

  it('returns null for a missing date', () => {
    expect(gdeltDate(null)).toBeNull();
  });
});
