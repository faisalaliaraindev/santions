/**
 * F1 — normalisation and charset (phase-f.md §3.2).
 *
 * These tests exist because the pipeline used to satisfy "normalised text" with
 * `new TextDecoder().decode(body)`, and both halves of that were wrong in a way no existing test
 * could catch: the fetch fixtures were nearly plain text and were all UTF-8, so markup never
 * reached a span and a declared encoding was never disagreed with.
 *
 * The two cases that matter most are the last ones in each group: a span that lands on markup,
 * and a Latin-1 page whose accented name silently stops matching. Both produce a clean
 * `NO_MATCHES_FOUND` in production, which reads as an absence of news rather than as a defect.
 */

import { describe, expect, it } from 'vitest';

import {
  mapSpanToOriginal,
  normaliseDocument,
  type NormalisedDocument,
} from '../src/pipeline/normalise-document.js';

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Latin-1 bytes, one byte per code point. Only valid for code points below 256, as here. */
function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i);
  }
  return bytes;
}

function html(body: string, contentType = 'text/html; charset=utf-8'): NormalisedDocument {
  return normaliseDocument({ body: utf8(body), contentType });
}

describe('markup becomes text, and spans point into the text', () => {
  it('removes tags and keeps the prose a reader would see', () => {
    const doc = html(
      '<html><head><title>Case</title></head><body><article><h1>Fiscalía acusa a ' +
        'Ana Jiménez</h1><p>La <em>acusación formal</em> se presentó el 14 de marzo.</p>' +
        '</article></body></html>',
    );

    expect(doc.text).not.toContain('<');
    expect(doc.text).toContain('Fiscalía acusa a Ana Jiménez');
    // The emphasis tag is inline: it must not put a space into the middle of the phrase.
    expect(doc.text).toContain('La acusación formal se presentó el 14 de marzo.');
  });

  it('drops script and style contents entirely', () => {
    const doc = html(
      '<html><body><script>var fraud = "money laundering";</script>' +
        '<style>.charged { color: red }</style><p>Nothing happened here.</p></body></html>',
    );

    // A keyword inside a script block is not something the document says. Left in, it would
    // categorise a person from a variable name.
    expect(doc.text).toBe('Nothing happened here.');
  });

  it('does not split a word at an inline tag boundary', () => {
    // `Jo` and `hn` in separate elements is one name to a reader. A space here would make the
    // subject's own name unmatchable, which looks exactly like the person not being mentioned.
    const doc = html('<p><b>Jo</b>hn Smith was charged</p>');
    expect(doc.text).toContain('John Smith was charged');
  });

  it('separates block elements so two sentences do not run together', () => {
    const doc = html('<p>First sentence.</p><p>Second sentence.</p>');
    expect(doc.text).toBe('First sentence.\nSecond sentence.');
  });

  it('decodes character references, including the ones that carry accents', () => {
    const doc = html('<p>Fiscal&iacute;a &amp; Tribunal &#8212; caso n&#xba; 42&nbsp;bis</p>');
    expect(doc.text).toBe('Fiscalía & Tribunal — caso nº 42 bis');
  });

  it('leaves an unknown reference exactly as the publisher wrote it', () => {
    // Guessing at `&foo;` would put a character into a span that is not in the document.
    const doc = html('<p>alpha &foo; beta</p>');
    expect(doc.text).toBe('alpha &foo; beta');
  });

  it('reads the contents of a CDATA section, which is where RSS keeps its prose', () => {
    const doc = normaliseDocument({
      body: utf8(
        '<item><description><![CDATA[<p>SEC charges Ana Jiménez</p>]]></description></item>',
      ),
      contentType: 'application/rss+xml',
    });
    expect(doc.text).toBe('SEC charges Ana Jiménez');
  });

  it('gives a span in the text that maps back onto the same words in the original', () => {
    const source =
      '<html><body><h1>Headline</h1><p>The SEC charged <b>Ana Jim&eacute;nez</b> with fraud.</p></body></html>';
    const doc = html(source);

    const start = doc.text.indexOf('Ana Jiménez');
    const span = { start, end: start + 'Ana Jiménez'.length };
    // The offset in the **normalised text** is nothing like the offset in the markup. That is
    // the defect this module fixes: before it, this span indexed into raw HTML.
    expect(source.slice(span.start, span.end)).not.toBe('Ana Jiménez');

    const original = mapSpanToOriginal(doc, span);
    expect(original).not.toBeNull();
    expect(doc.original.slice(original?.start ?? 0, original?.end ?? 0)).toBe('Ana Jim&eacute;nez');
  });

  it('refuses to map a span that is not inside the text', () => {
    const doc = html('<p>short</p>');
    // Clamping would put a quotation mark around whatever happened to be nearby.
    expect(mapSpanToOriginal(doc, { start: 0, end: 900 })).toBeNull();
    expect(mapSpanToOriginal(doc, { start: 3, end: 3 })).toBeNull();
  });

  it('keeps the offset map exactly as long as the text', () => {
    const doc = html('<p>Uno &amp; dos</p><p>tres</p>');
    expect(doc.originalOffsets).toHaveLength(doc.text.length);
  });
});

describe('the charset comes from what was declared', () => {
  it('uses the Content-Type charset rather than assuming UTF-8', () => {
    const doc = normaliseDocument({
      body: latin1('<p>María Jiménez, acusada de fraude</p>'),
      contentType: 'text/html; charset=iso-8859-1',
    });

    expect(doc.charset.source).toBe('CONTENT_TYPE_HEADER');
    expect(doc.text).toContain('María Jiménez');
    // The point of the test: decoded as UTF-8 — which is what the old one-liner did — the same
    // bytes produce replacement characters and the name stops matching.
    expect(new TextDecoder().decode(latin1('María'))).not.toContain('María');
  });

  it("uses the document's own declaration when the header carries none", () => {
    const doc = normaliseDocument({
      body: latin1(
        '<html><head><meta charset="iso-8859-1"></head><body><p>María</p></body></html>',
      ),
      contentType: 'text/html',
    });
    expect(doc.charset).toEqual({ label: 'windows-1252', source: 'DOCUMENT_DECLARATION' });
    expect(doc.text).toBe('María');
  });

  it('reads an XML declaration for a feed', () => {
    const doc = normaliseDocument({
      body: latin1('<?xml version="1.0" encoding="ISO-8859-1"?><item><title>María</title></item>'),
      contentType: 'application/xml',
    });
    expect(doc.charset.source).toBe('DOCUMENT_DECLARATION');
    expect(doc.text).toBe('María');
  });

  it('lets a byte-order mark outrank a header that disagrees with it', () => {
    const body = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('María')]);
    const doc = normaliseDocument({ body, contentType: 'text/html; charset=iso-8859-1' });
    expect(doc.charset.source).toBe('BYTE_ORDER_MARK');
    expect(doc.text).toBe('María');
  });

  it('says so when nothing declared an encoding, rather than implying UTF-8 was known', () => {
    const doc = normaliseDocument({ body: utf8('<p>plain</p>'), contentType: 'text/html' });
    expect(doc.charset).toEqual({ label: 'utf-8', source: 'DEFAULTED' });
    expect(doc.warnings.join(' ')).toContain('declared no character encoding');
  });

  it('falls back, loudly, when the declared encoding is one this runtime cannot decode', () => {
    const doc = normaliseDocument({
      body: utf8('<p>text</p>'),
      contentType: 'text/html; charset=x-imaginary-8',
    });
    expect(doc.charset.label).toBe('utf-8');
    expect(doc.warnings.join(' ')).toContain('x-imaginary-8');
  });

  it('reports replacement characters, because they mean the declaration was wrong', () => {
    // UTF-8 bytes served as if they were UTF-16: decodable, and wrong.
    const doc = normaliseDocument({
      body: new Uint8Array([0xc3, 0x28]),
      contentType: 'text/plain; charset=utf-8',
    });
    expect(doc.warnings.join(' ')).toContain('replacement characters');
  });
});

describe('what it will not pretend to read', () => {
  it('reports a PDF as not normalisable rather than decoding its bytes as text', () => {
    const doc = normaliseDocument({
      body: utf8('%PDF-1.4 notificación expediente 24-000123-0042-PE'),
      contentType: 'application/pdf',
    });

    expect(doc.normalisable).toBe(false);
    expect(doc.text).toBe('');
    // "We cannot read this" must never reach a reader as "this said nothing".
    expect(doc.warnings.join(' ')).toContain('not a document that said nothing');
  });

  it('treats a body with no declared type as markup, and says that it did', () => {
    const doc = normaliseDocument({ body: utf8('<p>hello</p>'), contentType: null });
    expect(doc.normalisable).toBe(true);
    expect(doc.text).toBe('hello');
    expect(doc.warnings.join(' ')).toContain('declared no Content-Type');
  });

  it('collapses layout whitespace in plain text without stripping anything else', () => {
    const doc = normaliseDocument({
      body: utf8('  Ana   Jiménez\n\n   was   charged  '),
      contentType: 'text/plain; charset=utf-8',
    });
    expect(doc.text).toBe('Ana Jiménez\nwas charged');
  });
});

describe('composition', () => {
  it('composes a decomposed accent so a name written either way matches the same string', () => {
    // `Jose` + combining acute is the same name to a reader and a different string to indexOf,
    // and the name forms it is matched against arrive composed.
    const doc = normaliseDocument({
      body: utf8('<p>José Jiménez</p>'),
      contentType: 'text/html; charset=utf-8',
    });
    expect(doc.text).toBe('José Jiménez');
    expect(doc.originalOffsets).toHaveLength(doc.text.length);
    // The mapping survives composition: four characters of text came from five of the original,
    // and the map still points at the right ones.
    const mapped = mapSpanToOriginal(doc, { start: 0, end: 4 });
    expect(mapped).not.toBeNull();
    expect(doc.original.slice(mapped?.start ?? 0, mapped?.end ?? 0)).toBe('Jose');
  });
});
