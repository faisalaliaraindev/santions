/**
 * The one place this service parses XML — Phase E step 3, decision **D-039**.
 *
 * # Why a module and not a `pnpm add` at the call site
 *
 * The two RSS rungs of the FR-05 cascade (Google News, Bing News) need an XML parser, and a
 * parser is not a neutral dependency here: it is pointed at a document a third party controls.
 * An XML parser that resolves entities reads local files on behalf of whoever wrote the feed
 * (XXE), and one that expands nested entities allocates gigabytes from forty bytes of input
 * (the billion-laughs attack). Both of those attacks **require a DTD** — an XXE payload needs
 * `<!ENTITY ... SYSTEM ...>` and a laughs payload needs nested `<!ENTITY>` definitions, and
 * there is nowhere else in an XML document to put either.
 *
 * So the defence is not a parser option. It is this: **before the parser is called, the document
 * is scanned, and any markup declaration at all refuses it.** That rule is ours, it is provable
 * by a test we own, and it survives a library upgrade that changes the meaning of a flag —
 * which is exactly what a defence resting on `processEntities: false` does not.
 *
 * `fast-xml-parser` is pinned at **4.5.7 exactly**, with one runtime dependency (`strnum`).
 * Version 5 modularised into six runtime dependencies, five of them created in 2026 with thin
 * adoption and one pointing at a GitHub org whose repository name does not match the package.
 * Same maintainer, so not a hostile injection — but not a supply chain this project adopts
 * without a deliberate look. See `docs/decisions.md` D-039.
 *
 * # What this module does not do
 *
 * It does not fetch, and it does not bound bytes. The transport already enforces two byte
 * budgets — wire and decompressed — so a document that reaches here is already bounded, and a
 * second size rule here would be a second place to get the number wrong.
 *
 * It does not decide adversity or relevance: it turns bytes into feed items and says honestly
 * when it could not. A feed whose shape it does not recognise returns `UNRECOGNISED` rather
 * than an empty item list, because "zero items" and "I did not understand this document" are
 * the two facts FR-05's volatility control exists to keep apart — a parser that silently
 * returns zero items turns a shape change into clean results for everybody.
 */

import { XMLParser } from 'fast-xml-parser';

import type { FailureSignal } from '@adverse-search/domain';

/**
 * Bumped whenever the parse changes (FR-05 volatility control), and carried on every adapter
 * that uses this module so the scheduled contract test (step 6) can key off it. The library
 * version is in the string deliberately: an upgrade changes the parse whether or not this file
 * is edited.
 */
export const XML_PARSER_VERSION = 'xml-fxp-4.5.7-1';

/** Why a document was refused before it was parsed. */
export type XmlRefusal = 'MARKUP_DECLARATION';

export type XmlParseResult =
  | { readonly kind: 'OK'; readonly document: unknown }
  | {
      readonly kind: 'REFUSED';
      readonly reason: XmlRefusal;
      readonly detail: string;
      readonly signal: FailureSignal;
    }
  | { readonly kind: 'UNPARSABLE'; readonly detail: string; readonly signal: FailureSignal };

/**
 * A markup declaration found in a document, with enough context for a refusal message.
 *
 * `name` is the declaration keyword as written — `DOCTYPE`, `ENTITY`, `ELEMENT`, `ATTLIST`,
 * `NOTATION` — so an operator reading the refusal learns which one appeared rather than being
 * told "a DTD" and having to go and look.
 */
export interface MarkupDeclaration {
  readonly index: number;
  readonly name: string;
}

/**
 * Find the first markup declaration outside comments, CDATA and processing instructions.
 *
 * This is the gate, and it is written as a scanner rather than as a regular expression or a
 * `includes('<!DOCTYPE')` because both of those get the two hard cases wrong in opposite
 * directions. A substring search false-positives on the literal text `<!DOCTYPE` inside a
 * CDATA section — which is legal content in a feed that quotes HTML, and refusing it would
 * drop real articles. A regular expression written to skip CDATA false-negatives on anything
 * its author did not anticipate, and a false negative here is the whole attack.
 *
 * The scan follows the only four things `<` can begin at markup level in a well-formed XML
 * document: a comment, a CDATA section, a processing instruction, or a tag — plus the fifth,
 * a markup declaration, which is what it is looking for. Text between tags is skipped without
 * being examined, because a raw `<` cannot appear there in well-formed XML.
 *
 * An unterminated comment, CDATA section or processing instruction ends the scan and returns
 * null: everything after it is inside that construct, so no declaration after it is active.
 * The document is then malformed and `fast-xml-parser` reports it as such.
 *
 * Exported because the test that proves XXE and billion-laughs are both refused asserts on this
 * function directly, and that test must not depend on any parser option.
 */
export function findMarkupDeclaration(text: string): MarkupDeclaration | null {
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      return null;
    }

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) {
        return null;
      }
      i = end + 3;
      continue;
    }

    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) {
        return null;
      }
      i = end + 3;
      continue;
    }

    if (text.startsWith('<!', lt)) {
      // DOCTYPE, ENTITY, ELEMENT, ATTLIST or NOTATION. Every one of them is a DTD construct and
      // none of them has a legitimate place in a syndication feed fetched from a stranger.
      const name = /^<!\s*([A-Za-z]*)/.exec(text.slice(lt, lt + 24))?.[1] ?? '';
      return { index: lt, name: name === '' ? 'UNNAMED' : name.toUpperCase() };
    }

    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) {
        return null;
      }
      i = end + 2;
      continue;
    }

    i = endOfTag(text, lt);
  }
  return null;
}

/** The index just past a tag's closing `>`, with quoted attribute values skipped. */
function endOfTag(source: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source.charAt(i);
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') {
      return i + 1;
    }
  }
  return source.length;
}

/**
 * The parser instance.
 *
 * Every option here is chosen, and two of them are load-bearing rather than cosmetic:
 *
 * - **`parseTagValue: false`** and `parseAttributeValue: false`. Without them `strnum` coerces
 *   anything numeric-looking into a number, so a headline that reads "2026" becomes the integer
 *   2026 and a GUID of digits stops comparing equal to the string it was stored as. Feed fields
 *   are text; nothing here wants a number.
 * - **`processEntities`**, deliberately enabled, and it is safe only because of the gate above.
 *   With no DTD the only entities a document can contain are the five XML predefines and
 *   numeric character references, each of which expands to exactly one character. Turning
 *   entity processing off instead would leave `&amp;` sitting in every title as literal text,
 *   which is a wrong title rather than a safe one. `htmlEntities` stays off: an HTML entity set
 *   is a much larger table and this is not HTML.
 *
 *   **`maxTotalExpansions` is raised, and that is not a weakened defence.** The library's
 *   default refuses a document after 1,000 entity expansions, which is a proxy for a
 *   billion-laughs attack — and billion laughs *requires a DTD*, which `parseXmlDocument`
 *   refuses outright before the library ever sees the text. So the count-based limit defends
 *   nothing here while rejecting real documents: the FTC's consumer-protection feed is 143KB of
 *   ordinary press releases containing 1,016 `&amp;` and `&#39;` sequences, and it was refused
 *   as malformed with a message about an attack that cannot occur. What still bounds the work is
 *   `maxExpandedLength` — total expanded output, kept at the library's default — together with
 *   the fetch budget that bounded the bytes before parsing started. A size bound is the honest
 *   defence for an expansion attack; a count of single-character expansions is not.
 *
 * `removeNSPrefix` flattens `dc:date` and `atom:link` to `date` and `link`, so the extractors
 * below read one shape rather than one per publisher's namespace habits.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: {
    enabled: true,
    // Each of these expands to exactly one character (no DTD ⇒ no custom entities), so the count
    // is really "how many ampersands does this publisher use". Bounded output, not bounded count.
    maxTotalExpansions: 5_000_000,
    maxEntityCount: 5_000_000,
    maxExpandedLength: 256 * 1024 * 1024,
  },
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  removeNSPrefix: true,
  isArray: (name) => name === 'item' || name === 'entry',
});

/**
 * Parse a document, refusing any DTD before the library sees it.
 *
 * A refusal and a parse failure are both `unparsableBody` to FR-06, which classifies as
 * `CONTENT_ERROR`: not retried, and **not counted against the source's health**. That is the
 * right reading. A feed carrying a DOCTYPE is a fact about that document, and suspending a
 * publisher's whole feed over one document is the failure mode D-035 was written against.
 */
export function parseXmlDocument(text: string): XmlParseResult {
  const declaration = findMarkupDeclaration(text);
  if (declaration !== null) {
    return {
      kind: 'REFUSED',
      reason: 'MARKUP_DECLARATION',
      detail:
        `The document contains a <!${declaration.name} declaration at byte ` +
        `${String(declaration.index)}. Documents carrying a DTD are refused before parsing: ` +
        `entity expansion and external entity resolution both require one, so refusing the ` +
        `declaration refuses both attacks without depending on a parser option.`,
      signal: { unparsableBody: true },
    };
  }

  try {
    return { kind: 'OK', document: parser.parse(text) as unknown };
  } catch (error) {
    return {
      kind: 'UNPARSABLE',
      detail: `XML did not parse: ${error instanceof Error ? error.message : 'unknown error'}.`,
      signal: { unparsableBody: true },
    };
  }
}

/**
 * Decode a fetched body to text, honouring the encoding the document declares.
 *
 * Not decoration. Costa Rican and Spanish publishers still serve `ISO-8859-1`, and decoding one
 * as UTF-8 turns every accented character into a replacement character — which does not throw,
 * does not look like a failure, and silently costs recall on exactly the names this service
 * exists to find. The declaration is read from the ASCII-compatible prologue, which every
 * encoding this matters for shares.
 *
 * An unsupported or unknown label falls back to UTF-8 rather than failing: a mis-decoded body
 * is a visible mess a reviewer can see, and refusing the document outright would lose it.
 */
export function decodeXml(bytes: Uint8Array, charsetHint?: string | null): string {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }

  const prologue = new TextDecoder('ascii', { fatal: false }).decode(bytes.subarray(0, 256));
  const declared = /encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(prologue)?.[1];
  const label = (declared ?? charsetHint ?? 'utf-8').trim();

  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/** One syndication entry, in the only shape the cascade reads. Strings, or null. Never guessed. */
export interface FeedItem {
  readonly title: string | null;
  /** The article URL as the feed gives it. Not screened here — `screenUrl` is the gate. */
  readonly link: string | null;
  /** The feed's own identifier: RSS `guid`, Atom `id`. Null when the feed publishes none. */
  readonly id: string | null;
  /** RSS `description`, Atom `summary`. Never synthesised from the title (see `lead.ts`). */
  readonly summary: string | null;
  /**
   * The publication date **exactly as the feed wrote it**, unparsed.
   *
   * Left as a string on purpose. FR-07 wants a date with a declared precision, and deciding
   * that precision is the connector's job with the run's clock in hand; a parser that quietly
   * produced a `Date` here would be asserting DAY precision on a field that is frequently
   * absent and frequently wrong.
   */
  readonly publishedAtRaw: string | null;
}

export interface ParsedFeed {
  readonly format: 'RSS_2_0' | 'ATOM_1_0';
  readonly title: string | null;
  /** BCP 47 where the feed declares one. Null when it does not — never inferred from the text. */
  readonly language: string | null;
  readonly items: readonly FeedItem[];
}

export type FeedParseResult =
  | { readonly kind: 'OK'; readonly feed: ParsedFeed }
  | Exclude<XmlParseResult, { kind: 'OK' }>
  | {
      /**
       * The document parsed as XML and was not a feed shape this parser knows.
       *
       * Distinct from an empty feed, and that distinction is the point. A publisher who changes
       * their feed format, or a proxy that returns an HTML error page as XML, produces this —
       * and reporting it as "no items" would turn a broken source into clean results for every
       * subject searched through it (FR-05 volatility control, T84).
       */
      readonly kind: 'UNRECOGNISED';
      readonly detail: string;
      readonly signal: FailureSignal;
    };

/** Parse a syndication feed. The only entry point the discovery connectors call. */
export function parseFeed(text: string): FeedParseResult {
  const parsed = parseXmlDocument(text);
  if (parsed.kind !== 'OK') {
    return parsed;
  }

  const root = asRecord(parsed.document);
  if (root === null) {
    return {
      kind: 'UNRECOGNISED',
      detail: 'The document has no element content.',
      signal: { unexpectedContentType: true },
    };
  }

  const rss = asRecord(root['rss']);
  if (rss !== null) {
    const channel = asRecord(rss['channel']);
    if (channel !== null) {
      return { kind: 'OK', feed: readRssChannel(channel) };
    }
  }

  const feed = asRecord(root['feed']);
  if (feed !== null) {
    return { kind: 'OK', feed: readAtomFeed(feed) };
  }

  return {
    kind: 'UNRECOGNISED',
    detail:
      `The document parsed as XML but its root is [${Object.keys(root).join(', ')}], which is ` +
      `neither an RSS 2.0 <rss><channel> nor an Atom 1.0 <feed>. Reported as unrecognised ` +
      `rather than as an empty feed: a shape change that reads as "no items" is invisible.`,
    signal: { unexpectedContentType: true },
  };
}

function readRssChannel(channel: Record<string, unknown>): ParsedFeed {
  const items = asArray(channel['item']).map((raw): FeedItem => {
    const item = asRecord(raw) ?? {};
    return {
      title: fieldText(item['title']),
      link: fieldText(item['link']),
      id: fieldText(item['guid']),
      summary: fieldText(item['description']),
      // `pubDate` is RSS 2.0; `date` is Dublin Core's `dc:date` after the namespace prefix is
      // stripped. Several CR and ES publishers emit only the second.
      publishedAtRaw: fieldText(item['pubDate']) ?? fieldText(item['date']),
    };
  });

  return {
    format: 'RSS_2_0',
    title: fieldText(channel['title']),
    language: fieldText(channel['language']),
    items,
  };
}

function readAtomFeed(feed: Record<string, unknown>): ParsedFeed {
  const items = asArray(feed['entry']).map((raw): FeedItem => {
    const entry = asRecord(raw) ?? {};
    return {
      title: fieldText(entry['title']),
      link: atomLink(entry['link']),
      id: fieldText(entry['id']),
      summary: fieldText(entry['summary']) ?? fieldText(entry['content']),
      // `published` is when the entry appeared; `updated` is when it last changed. Preferred in
      // that order because a corrected article keeps its publication date, and an edit is not a
      // new event (FR-07).
      publishedAtRaw: fieldText(entry['published']) ?? fieldText(entry['updated']),
    };
  });

  return {
    format: 'ATOM_1_0',
    title: fieldText(feed['title']),
    language: fieldText(feed['@_lang']),
    items,
  };
}

/**
 * Atom links are attributes on possibly several `<link>` elements.
 *
 * `rel="alternate"` is the article; `rel="self"`, `"edit"` and `"replies"` are not, and taking
 * the first link unconditionally fetches the feed's own URL as though it were a story. Atom
 * says a `<link>` with no `rel` means `alternate`, so that case is accepted too.
 */
function atomLink(value: unknown): string | null {
  for (const candidate of asArray(value)) {
    const link = asRecord(candidate);
    if (link === null) {
      continue;
    }
    const rel = fieldText(link['@_rel']);
    if (rel === null || rel === 'alternate') {
      return fieldText(link['@_href']);
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? (value as readonly unknown[]) : [value];
}

/**
 * A field's text, or null.
 *
 * An element that carries attributes as well as text parses to an object with a `#text` member,
 * which is how an RSS `<guid isPermaLink="false">` arrives. Both shapes are read, and anything
 * else — a nested element, an empty string — is null rather than a stringified object.
 */
function fieldText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  const record = asRecord(value);
  if (record !== null && typeof record['#text'] === 'string') {
    return fieldText(record['#text']);
  }
  return null;
}
