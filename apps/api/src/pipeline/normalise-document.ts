/**
 * F1 — fetched bytes into the **normalised text** the extractor is documented to receive.
 *
 * `ExtractionInput.text` says "normalised text, with the offset mapping back to the original
 * held by the caller", and until this module existed the pipeline satisfied it with
 * `new TextDecoder().decode(body)`. That one line carried two defects, both recorded in
 * `docs/execution/phase-f.md` §3.2:
 *
 * **It handed markup to the extractor and called it text.** Every span an extractor produced —
 * the offsets a reviewer is shown, and the offsets the FR-07 validator will check — pointed into
 * raw HTML. It never surfaced because the fetch fixtures are nearly plain text. The first real
 * page breaks it: a name inside `<h1>` has a different offset from the name a reader sees, and a
 * keyword that appears only inside a `<script>` block is not something the document says at all.
 *
 * **It ignored the declared encoding.** `TextDecoder()` is UTF-8 whatever the publisher said. A
 * Spanish page served as ISO-8859-1 — not rare on Latin American news sites — decodes to
 * mojibake, and name-form matching then silently stops matching. The symptom is a clean
 * `NO_MATCHES_FOUND` that reads like an absence of news, which is the failure shape this whole
 * service is built to avoid.
 *
 * # What this module guarantees
 *
 * 1. **The charset comes from the declaration**, in the order a browser uses it: a byte-order
 *    mark, then the `Content-Type` charset parameter, then the document's own `<meta charset>`
 *    or XML declaration, and only then a default. Which of those decided is **recorded**, so a
 *    run can say whether the encoding was declared or assumed rather than implying it was known.
 * 2. **Every character of the output maps back to the character of the decoded original that
 *    produced it.** `originalOffsets[i]` is that index. This is the mapping the port says the
 *    caller holds, and `mapSpanToOriginal` is how a caller uses it.
 * 3. **Markup is removed rather than read.** Script, style and other non-prose elements are
 *    dropped with their contents; block boundaries become line breaks; inline elements do not
 *    split a word; character references are decoded; runs of whitespace collapse.
 *
 * # What it does not do, deliberately
 *
 * No PDF, and no OCR. Both are F1 work and both are separate, testable concerns; a PDF arriving
 * here is reported as a media type this module does not normalise rather than being decoded as
 * if its bytes were text. A caller that treats "not normalisable" as "empty document" would
 * reintroduce exactly the failure above, so the result says which it is.
 *
 * Pure: no I/O, no clock. It lives beside the pipeline rather than in `packages/domain` because
 * it works on transport bytes and media types, which the domain packages do not know about.
 */

/** Bumped whenever the output of `normaliseDocument` changes for the same input. */
export const NORMALISER_VERSION = 'normalise-1';

/** Which declaration decided the charset. `DEFAULTED` means nothing declared one. */
export type CharsetSource =
  'BYTE_ORDER_MARK' | 'CONTENT_TYPE_HEADER' | 'DOCUMENT_DECLARATION' | 'DEFAULTED';

export interface NormalisedDocument {
  /** The text an extractor reads. Spans point in here, and nowhere else. */
  readonly text: string;
  /**
   * `originalOffsets[i]` is the index in `original` of the character that produced `text[i]`.
   *
   * Length is always `text.length`. Several output characters can share one input index — a
   * decoded `&amp;`, a composed accent — and that is the honest mapping: the reader's character
   * came from that point in the document.
   */
  readonly originalOffsets: readonly number[];
  /** The decoded document before markup removal. The thing `originalOffsets` indexes into. */
  readonly original: string;
  /** The encoding label actually used to decode, and what said so. */
  readonly charset: { readonly label: string; readonly source: CharsetSource };
  /** Lower-cased media type without parameters, or null when the server declared none. */
  readonly mediaType: string | null;
  /** True when markup was stripped; false when the body was treated as plain text. */
  readonly markupRemoved: boolean;
  /**
   * False when this module cannot turn these bytes into text at all — a PDF, an image.
   *
   * `text` is then empty, and a caller must report the document as unextractable rather than as
   * one that said nothing.
   */
  readonly normalisable: boolean;
  /**
   * Anything a reader of the run should know about how this text was produced: an undeclared
   * encoding, a label this runtime cannot decode, replacement characters in the output.
   *
   * Sentences, not codes: they are written into the run's warnings verbatim.
   */
  readonly warnings: readonly string[];
}

export interface NormaliseInput {
  readonly body: Uint8Array;
  /** The `Content-Type` as the server sent it, parameters included. */
  readonly contentType: string | null;
}

const MARKUP_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/rdf+xml',
]);

const TEXT_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'application/json',
  'application/ld+json',
  'text/csv',
]);

/**
 * Turn a fetched body into normalised text plus the mapping back to the original.
 *
 * Never throws: a body this module cannot handle comes back as `normalisable: false` with a
 * sentence saying why. Throwing would make one odd document end a run.
 */
export function normaliseDocument(input: NormaliseInput): NormalisedDocument {
  const warnings: string[] = [];
  const mediaType = parseMediaType(input.contentType);
  const isMarkup = mediaType === null ? true : MARKUP_TYPES.has(mediaType);
  const isText = mediaType !== null && TEXT_TYPES.has(mediaType);

  if (mediaType === null) {
    // No declared type. Treated as markup because that is what a web document usually is, and
    // stripping markup from text that has none is a no-op — whereas failing to strip it is not.
    warnings.push(
      'The server declared no Content-Type for a fetched document, so it was normalised as ' +
        'markup. Nothing was assumed about its encoding beyond what the bytes themselves ' +
        'declare.',
    );
  } else if (!isMarkup && !isText) {
    return {
      text: '',
      originalOffsets: [],
      original: '',
      charset: { label: 'utf-8', source: 'DEFAULTED' },
      mediaType,
      markupRemoved: false,
      normalisable: false,
      warnings: [
        `A document of type ${mediaType} was fetched, and this service cannot yet turn it into ` +
          `text (PDF and OCR are not built). It was stored as evidence and nothing was ` +
          `extracted from it. That is a gap in coverage, not a document that said nothing.`,
      ],
    };
  }

  const detected = detectCharset(input.body, input.contentType, isMarkup);
  if (detected.source === 'DEFAULTED') {
    warnings.push(
      'A fetched document declared no character encoding, in its headers or in its own markup, ' +
        'so it was decoded as UTF-8. If the publisher served another encoding, accented ' +
        'characters in it did not match and the document may read as silent about a name it ' +
        'does mention.',
    );
  }

  const decoded = decodeWithLabel(input.body, detected.label);
  if (decoded.fellBackToUtf8) {
    warnings.push(
      `A fetched document declared the encoding "${detected.label}", which this runtime cannot ` +
        `decode. It was decoded as UTF-8 instead, and any text in it that is not UTF-8 is now ` +
        `wrong rather than missing.`,
    );
  }
  if (decoded.text.includes('�')) {
    warnings.push(
      `A fetched document decoded as "${decoded.label}" contains replacement characters, which ` +
        `means the declared encoding does not describe its bytes. Names with accented ` +
        `characters in it cannot be relied on to match.`,
    );
  }

  const stripped = isMarkup ? stripMarkup(decoded.text) : collapsePlainText(decoded.text);
  const composed = composeClusters(stripped.chars, stripped.offsets);

  return {
    text: composed.text,
    originalOffsets: composed.offsets,
    original: decoded.text,
    charset: { label: decoded.label, source: detected.source },
    mediaType,
    markupRemoved: isMarkup,
    normalisable: true,
    warnings,
  };
}

/**
 * A span in the normalised text, as the offsets it covers in the decoded original.
 *
 * Returns null for a span outside the text: a caller handed an offset that does not belong to
 * this document, and silently clamping it would put a quotation mark around whatever happened
 * to be at the nearest valid position.
 */
export function mapSpanToOriginal(
  document: NormalisedDocument,
  span: { readonly start: number; readonly end: number },
): { readonly start: number; readonly end: number } | null {
  if (span.start < 0 || span.end > document.text.length || span.start >= span.end) {
    return null;
  }
  const start = document.originalOffsets[span.start];
  const lastIndex = document.originalOffsets[span.end - 1];
  if (start === undefined || lastIndex === undefined) {
    return null;
  }
  // `end` is exclusive and the original character at `lastIndex` may itself be several
  // characters long — `&amp;` is five — so the end is one past the last mapped index, which is
  // the most a per-character map can honestly say.
  return { start, end: lastIndex + 1 };
}

/** Lower-cased type/subtype with parameters removed. Null when there is nothing to parse. */
function parseMediaType(contentType: string | null): string | null {
  if (contentType === null) {
    return null;
  }
  const head = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return head.length === 0 ? null : head;
}

interface CharsetDecision {
  readonly label: string;
  readonly source: CharsetSource;
}

/**
 * The declared encoding, in the order a browser trusts declarations.
 *
 * A BOM outranks a header because it is in the bytes themselves and cannot be a stale server
 * configuration. The header outranks the document because the transport is what the bytes
 * actually arrived under. Both outrank a guess, and there is no content sniffing here at all:
 * guessing an encoding from byte statistics is how a document silently becomes a different
 * document, and an undeclared encoding is recorded as undeclared instead.
 */
function detectCharset(
  body: Uint8Array,
  contentType: string | null,
  isMarkup: boolean,
): CharsetDecision {
  const bom = detectBom(body);
  if (bom !== null) {
    return { label: bom, source: 'BYTE_ORDER_MARK' };
  }

  const fromHeader = charsetParameter(contentType);
  if (fromHeader !== null) {
    return { label: fromHeader, source: 'CONTENT_TYPE_HEADER' };
  }

  if (isMarkup) {
    const declared = charsetFromDocument(body);
    if (declared !== null) {
      return { label: declared, source: 'DOCUMENT_DECLARATION' };
    }
  }

  return { label: 'utf-8', source: 'DEFAULTED' };
}

function detectBom(body: Uint8Array): string | null {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    return 'utf-8';
  }
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
    return 'utf-16le';
  }
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
    return 'utf-16be';
  }
  return null;
}

function charsetParameter(contentType: string | null): string | null {
  if (contentType === null) {
    return null;
  }
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  const label = match?.[1]?.trim().toLowerCase();
  return label === undefined || label.length === 0 ? null : label;
}

/**
 * `<meta charset>`, `<meta http-equiv="content-type">` or an XML declaration.
 *
 * Read from the first 1024 bytes as Latin-1, which is what the HTML standard's pre-scan does and
 * is safe for exactly the reason it looks unsafe: every encoding this matters for agrees with
 * ASCII on the characters a declaration is written in.
 */
function charsetFromDocument(body: Uint8Array): string | null {
  const prefix = latin1(body.subarray(0, 1024));

  const metaCharset = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.+-]+)/i.exec(prefix);
  if (metaCharset?.[1] !== undefined) {
    return metaCharset[1].toLowerCase();
  }
  const xmlDeclaration = /<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_:.+-]+)["']/i.exec(prefix);
  if (xmlDeclaration?.[1] !== undefined) {
    return xmlDeclaration[1].toLowerCase();
  }
  return null;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }
  return out;
}

/**
 * Decode, falling back to UTF-8 when the runtime does not know the label.
 *
 * `TextDecoder` throws `RangeError` for an unknown encoding. A publisher naming an encoding
 * nobody supports is a document we can still read approximately, and refusing it outright would
 * lose a real document; the fallback is reported rather than silent.
 */
function decodeWithLabel(
  body: Uint8Array,
  label: string,
): { readonly text: string; readonly label: string; readonly fellBackToUtf8: boolean } {
  try {
    const decoder = new TextDecoder(label, { ignoreBOM: false });
    return { text: decoder.decode(body), label: decoder.encoding, fellBackToUtf8: false };
  } catch {
    return { text: new TextDecoder('utf-8').decode(body), label: 'utf-8', fellBackToUtf8: true };
  }
}

/** Elements whose contents are not prose and must not reach an extractor. */
const DROPPED_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'iframe',
  'object',
  'embed',
  'canvas',
]);

/**
 * Elements that end a line of prose.
 *
 * Inline elements are deliberately absent: `<b>Jo</b>hn` is one word, and inserting a space at
 * every tag boundary would break a name in half — which is a name-matching failure that would
 * look exactly like the person not being mentioned.
 */
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'description',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'item',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'title',
  'tr',
  'ul',
]);

interface CharStream {
  readonly chars: string[];
  readonly offsets: number[];
}

/** Whitespace pending before the next character: none, a space, or a line break. */
type Break = 0 | 1 | 2;

class Emitter {
  readonly chars: string[] = [];
  readonly offsets: number[] = [];
  private pending: Break = 0;
  private pendingAt = -1;

  /** Note that a boundary was crossed. The strongest boundary in a run wins. */
  mark(level: Break, at: number): void {
    if (level === 0) {
      return;
    }
    if (this.pending === 0) {
      this.pendingAt = at;
    }
    if (level > this.pending) {
      this.pending = level;
    }
  }

  push(char: string, at: number): void {
    if (this.pending !== 0) {
      // Never leading: a document that opens with markup does not open with a blank line.
      if (this.chars.length > 0) {
        this.chars.push(this.pending === 2 ? '\n' : ' ');
        this.offsets.push(this.pendingAt);
      }
      this.pending = 0;
      this.pendingAt = -1;
    }
    this.chars.push(char);
    this.offsets.push(at);
  }

  pushAll(text: string, at: number): void {
    for (const char of text) {
      this.push(char, at);
    }
  }

  stream(): CharStream {
    // Trailing whitespace is simply never flushed, so there is nothing to trim.
    return { chars: this.chars, offsets: this.offsets };
  }
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

/** Plain text still needs whitespace collapsed, so a span is not full of layout. */
function collapsePlainText(source: string): CharStream {
  const emitter = new Emitter();
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? '';
    if (isWhitespace(char)) {
      emitter.mark(char === '\n' ? 2 : 1, i);
      continue;
    }
    emitter.push(char, i);
  }
  return emitter.stream();
}

/**
 * Markup to prose, keeping every character's origin.
 *
 * Hand-written rather than parsed with a DOM library for two reasons. It never fails — real
 * pages are not well-formed, and a parse error here would turn a readable document into a
 * coverage gap — and a DOM library's `textContent` gives no offsets at all, which is the one
 * thing this module exists to produce.
 */
function stripMarkup(source: string): CharStream {
  const emitter = new Emitter();
  let i = 0;

  while (i < source.length) {
    const char = source[i] ?? '';

    if (char === '<') {
      if (source.startsWith('<!--', i)) {
        const close = source.indexOf('-->', i + 4);
        emitter.mark(1, i);
        i = close === -1 ? source.length : close + 3;
        continue;
      }
      if (source.startsWith('<![CDATA[', i)) {
        // The delimiters go; the contents are read as ordinary markup, because an RSS
        // `<description>` routinely wraps a whole HTML fragment in CDATA.
        i += 9;
        continue;
      }
      if (source.startsWith('<!', i) || source.startsWith('<?', i)) {
        const close = source.indexOf('>', i);
        emitter.mark(2, i);
        i = close === -1 ? source.length : close + 1;
        continue;
      }

      const tag = readTag(source, i);
      if (tag === null) {
        // A bare `<` that starts no tag is a character the reader sees.
        emitter.push('<', i);
        i += 1;
        continue;
      }
      if (!tag.closing && DROPPED_ELEMENTS.has(tag.name)) {
        emitter.mark(2, i);
        i = tag.selfClosing ? tag.end : skipElement(source, tag.name, tag.end);
        continue;
      }
      emitter.mark(BLOCK_ELEMENTS.has(tag.name) ? 2 : 0, i);
      i = tag.end;
      continue;
    }

    if (source.startsWith(']]>', i)) {
      i += 3;
      continue;
    }

    if (char === '&') {
      const entity = readEntity(source, i);
      if (entity !== null) {
        if (entity.text.split('').every(isWhitespace)) {
          emitter.mark(1, i);
        } else {
          emitter.pushAll(entity.text, i);
        }
        i = entity.end;
        continue;
      }
      emitter.push('&', i);
      i += 1;
      continue;
    }

    if (isWhitespace(char)) {
      emitter.mark(1, i);
      i += 1;
      continue;
    }

    emitter.push(char, i);
    i += 1;
  }

  return emitter.stream();
}

interface ParsedTag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  /** Index just past the closing `>`. */
  readonly end: number;
}

function readTag(source: string, at: number): ParsedTag | null {
  const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9:._-]*)/.exec(source.slice(at, at + 64));
  if (match?.[2] === undefined) {
    return null;
  }
  let i = at + match[0].length;
  let quote: string | null = null;
  while (i < source.length) {
    const char = source[i] ?? '';
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return {
        name: match[2].toLowerCase(),
        closing: match[1] === '/',
        selfClosing: source[i - 1] === '/',
        end: i + 1,
      };
    }
    i += 1;
  }
  // An unterminated tag ends the document. Emitting its attribute text as prose would put
  // markup into a span, which is the defect this module exists to remove.
  return {
    name: match[2].toLowerCase(),
    closing: match[1] === '/',
    selfClosing: false,
    end: source.length,
  };
}

/** Everything up to the matching close tag, or to the end if the publisher never closed it. */
function skipElement(source: string, name: string, from: number): number {
  const lower = source.toLowerCase();
  const close = lower.indexOf(`</${name}`, from);
  if (close === -1) {
    return source.length;
  }
  const gt = source.indexOf('>', close);
  return gt === -1 ? source.length : gt + 1;
}

/**
 * The named references that appear in real prose, plus every numeric one.
 *
 * Deliberately not the full HTML5 table of 2231 names: the long tail is mathematical and
 * typographic symbols that do not change whether a name matches, and an unknown reference is
 * left exactly as written rather than guessed at.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  hellip: '…',
  middot: '·',
  deg: '°',
  euro: '€',
  pound: '£',
  cent: '¢',
  sect: '§',
  para: '¶',
  copy: '©',
  reg: '®',
  trade: '™',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  agrave: 'à',
  egrave: 'è',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  Uuml: 'Ü',
  ouml: 'ö',
  auml: 'ä',
  ccedil: 'ç',
  Ccedil: 'Ç',
  ordf: 'ª',
  ordm: 'º',
  iquest: '¿',
  iexcl: '¡',
};

function readEntity(
  source: string,
  at: number,
): { readonly text: string; readonly end: number } | null {
  const match = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(
    source.slice(at, at + 40),
  );
  const body = match?.[1];
  if (match === null || body === undefined) {
    return null;
  }
  const end = at + match[0].length;

  if (body.startsWith('#')) {
    const code =
      body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
      return null;
    }
    try {
      return { text: String.fromCodePoint(code), end };
    } catch {
      // A lone surrogate. Left as written rather than turned into a replacement character.
      return null;
    }
  }

  const named = NAMED_ENTITIES[body];
  return named === undefined ? null : { text: named, end };
}

/**
 * Unicode NFC, applied per base character and its combining marks.
 *
 * Applied at all because `José` written as `e` plus a combining acute and `José` written as a
 * single code point are the same name to a reader and different strings to `indexOf`, and the
 * name forms this text is matched against come from a database in composed form.
 *
 * Applied per cluster rather than to the whole string because normalising the whole string gives
 * no way to know which output character came from which input character, and losing that is
 * losing the mapping this module exists to keep.
 */
function composeClusters(
  chars: readonly string[],
  offsets: readonly number[],
): { text: string; offsets: number[] } {
  const out: string[] = [];
  const outOffsets: number[] = [];
  let i = 0;

  while (i < chars.length) {
    let end = i + 1;
    while (end < chars.length && isCombiningMark(chars[end] ?? '')) {
      end += 1;
    }
    const cluster = chars.slice(i, end).join('');
    const composed = end === i + 1 ? cluster : cluster.normalize('NFC');
    const origin = offsets[i] ?? 0;
    for (const char of composed) {
      out.push(char);
      outOffsets.push(origin);
    }
    i = end;
  }

  return { text: out.join(''), offsets: outOffsets };
}

const COMBINING_MARK = /^\p{M}$/u;

function isCombiningMark(char: string): boolean {
  return COMBINING_MARK.test(char);
}
