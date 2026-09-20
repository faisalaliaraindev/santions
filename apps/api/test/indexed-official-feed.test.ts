import { describe, expect, it } from 'vitest';

import { OfficialFeedParser } from '../src/sources/indexed/parsers/official-feed.parser.js';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function parser(): OfficialFeedParser {
  return new OfficialFeedParser({
    parserId: 'official-feed',
    parserVersion: 'official-feed-test-1',
    publisherUrl: 'https://regulator.example.test/feeds',
    category: 'FRAUD_FINANCIAL_CRIME',
    defaultStage: 'ALLEGATION',
  });
}

describe('scheduled official RSS ingestion', () => {
  it('normalizes an official item with stable provenance and stage evidence', () => {
    const parsed = parser().parse({
      sourceId: 'regulator-feed',
      artifactUrl: 'https://regulator.example.test/feed.xml',
      contentType: 'application/rss+xml; charset=utf-8',
      body: bytes(`<?xml version="1.0"?>
        <rss version="2.0"><channel><title>Enforcement</title><item>
          <guid>release-42</guid>
          <title>Alex Example sentenced for investment fraud</title>
          <link>https://regulator.example.test/releases/42</link>
          <description>Alex Example was sentenced after pleading guilty.</description>
          <pubDate>Thu, 17 Sep 2026 12:00:00 GMT</pubDate>
        </item></channel></rss>`),
    });

    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      sourceRecordId: 'release-42',
      recordKind: 'OFFICIAL_PUBLICATION',
      recordType: 'OTHER',
      primaryName: 'Alex Example sentenced for investment fraud',
      publicationDate: { value: '2026-09-17', precision: 'DAY' },
      findingMetadata: {
        category: 'FRAUD_FINANCIAL_CRIME',
        proceduralStage: 'CONVICTION_FINAL_JUDGMENT',
        partyRole: 'UNSPECIFIED',
        stageEvidence: 'sentenced',
      },
    });
    expect(parsed.records[0]?.searchableText).toContain('Alex Example');
  });

  it('refuses a non-feed XML body instead of treating it as an empty clean source', () => {
    expect(() =>
      parser().parse({
        sourceId: 'regulator-feed',
        artifactUrl: 'https://regulator.example.test/feed.xml',
        contentType: 'text/xml',
        body: bytes('<html><body>Temporary error</body></html>'),
      }),
    ).toThrow(/neither an RSS 2.0/);
  });

  it('refuses markup declarations before the XML parser sees them', () => {
    expect(() =>
      parser().parse({
        sourceId: 'regulator-feed',
        artifactUrl: 'https://regulator.example.test/feed.xml',
        contentType: 'application/rss+xml',
        body: bytes('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>'),
      }),
    ).toThrow(/DOCTYPE/);
  });
});
