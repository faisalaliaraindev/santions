import { createHash } from 'node:crypto';

import { decodeXml, parseFeed, type FeedItem } from '../../parse/xml.js';
import type {
  IndexedArtifactParser,
  IndexedFindingMetadata,
  IndexedSourceDate,
  NormalizedSourceRecord,
  ParsedSourceArtifact,
} from '../indexed-source.types.js';

export interface OfficialFeedParserOptions {
  readonly parserId: string;
  readonly parserVersion: string;
  readonly publisherUrl: string;
  readonly category: string;
  readonly defaultStage: string;
  readonly partyRole?: string;
  readonly includeItem?: (item: FeedItem) => boolean;
}

/** One RSS/Atom parser for scheduled regulator publications. Source policy stays in the registry. */
export class OfficialFeedParser implements IndexedArtifactParser {
  readonly parserId: string;
  readonly parserVersion: string;

  constructor(private readonly options: OfficialFeedParserOptions) {
    this.parserId = options.parserId;
    this.parserVersion = options.parserVersion;
  }

  parse(input: {
    readonly sourceId: string;
    readonly artifactUrl: string;
    readonly contentType: string | null;
    readonly body: Uint8Array;
  }): ParsedSourceArtifact {
    const parsed = parseFeed(decodeXml(input.body, charset(input.contentType)));
    if (parsed.kind !== 'OK') {
      throw new Error(`Feed parser ${this.parserVersion} refused the artifact: ${parsed.detail}`);
    }

    const records = parsed.feed.items
      .filter((item) => this.options.includeItem?.(item) ?? true)
      .map((item) => this.toRecord(input.sourceId, input.artifactUrl, item))
      .filter((record): record is NormalizedSourceRecord => record !== null);
    return { records, publisherVersion: null };
  }

  private toRecord(
    sourceId: string,
    artifactUrl: string,
    item: FeedItem,
  ): NormalizedSourceRecord | null {
    const title = item.title?.trim() ?? '';
    const link = item.link?.trim() ?? '';
    if (title === '' || link === '') {
      return null;
    }
    const summary = item.summary?.trim() ?? '';
    const searchableText = [title, summary].filter(Boolean).join('\n');
    const stage = inferStage(searchableText, this.options.defaultStage);
    const sourceRecordId = stableItemId(item, link);
    const publicationDate = parsePublicationDate(item.publishedAtRaw);
    const findingMetadata: IndexedFindingMetadata = {
      category: this.options.category,
      proceduralStage: stage.value,
      partyRole: this.options.partyRole ?? 'UNSPECIFIED',
      stageEvidence: stage.evidence,
    };

    return {
      sourceId,
      sourceRecordId,
      recordKind: 'OFFICIAL_PUBLICATION',
      recordType: 'OTHER',
      primaryName: title,
      aliases: [],
      originalScriptNames: [],
      datesOfBirth: [],
      placesOfBirth: [],
      nationalities: [],
      citizenships: [],
      countries: [],
      addresses: [],
      identifiers: [],
      companyIdentifiers: [],
      listingDate: null,
      programmes: [],
      sanctionTypes: ['OFFICIAL_ENFORCEMENT_PUBLICATION'],
      grounds: summary === '' ? null : summary,
      status: 'PUBLISHED',
      effectiveDate: publicationDate,
      expiryDate: null,
      publisherUrl: this.options.publisherUrl,
      sourceDocumentUrl: link,
      searchableText,
      publicationDate,
      findingMetadata,
      rawEvidence: {
        feedUrl: artifactUrl,
        id: item.id,
        title,
        link,
        summary: item.summary,
        publishedAtRaw: item.publishedAtRaw,
      },
    };
  }
}

function stableItemId(item: FeedItem, link: string): string {
  const publisherId = item.id?.trim();
  if (publisherId !== undefined && publisherId !== '') {
    return publisherId;
  }
  return `url-sha256:${createHash('sha256').update(link).digest('hex')}`;
}

function parsePublicationDate(raw: string | null): IndexedSourceDate | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime())
    ? null
    : { value: parsed.toISOString().slice(0, 10), precision: 'DAY' };
}

function inferStage(
  text: string,
  fallback: string,
): { readonly value: string; readonly evidence: string | null } {
  const rules: readonly [RegExp, string][] = [
    [/\b(sentenced|convicted|found guilty|final judgment)\b/i, 'CONVICTION_FINAL_JUDGMENT'],
    [/\b(pleaded guilty|pleads guilty|guilty plea)\b/i, 'CONVICTION_FINAL_JUDGMENT'],
    [/\b(settlement|settles|consent order)\b/i, 'SETTLEMENT_CONSENT_ORDER'],
    [/\b(fined|penalty|regulatory action)\b/i, 'REGULATORY_ACTION_FINE'],
    [/\b(charged|indicted|indictment)\b/i, 'CHARGE_INDICTMENT'],
    [/\b(arrested|detained|raid)\b/i, 'RAID_ARREST_DETENTION'],
    [/\b(investigation|investigating)\b/i, 'INVESTIGATION_OPENED'],
    [/\b(complaint|lawsuit|sues)\b/i, 'COMPLAINT_FILED'],
    [/\b(alleged|allegedly|warning|warns)\b/i, 'ALLEGATION'],
  ];
  for (const [pattern, stage] of rules) {
    const match = pattern.exec(text);
    if (match?.[0] !== undefined) {
      return { value: stage, evidence: match[0] };
    }
  }
  return { value: fallback, evidence: null };
}

function charset(contentType: string | null): string | null {
  return /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType ?? '')?.[1] ?? null;
}
