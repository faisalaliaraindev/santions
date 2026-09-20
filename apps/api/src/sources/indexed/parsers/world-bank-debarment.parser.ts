import type {
  IndexedArtifactParser,
  IndexedRecordType,
  IndexedSourceDate,
  NormalizedSourceRecord,
  ParsedSourceArtifact,
} from '../indexed-source.types.js';

const PUBLISHER_PAGE =
  'https://www.worldbank.org/en/projects-operations/procurement/debarred-firms';

/** Parser for the JSON response used by the World Bank's official ineligible-firms page. */
export class WorldBankDebarmentParser implements IndexedArtifactParser {
  readonly parserId = 'world-bank-debarment-json';
  readonly parserVersion = 'world-bank-debarment-json-1';

  parse(input: {
    readonly sourceId: string;
    readonly artifactUrl: string;
    readonly contentType: string | null;
    readonly body: Uint8Array;
  }): ParsedSourceArtifact {
    let document: unknown;
    try {
      document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.body));
    } catch (error) {
      throw new Error(
        `World Bank artifact is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const root = asRecord(document);
    const response = asRecord(root?.['response']);
    const rows = response?.['ZPROCSUPP'];
    if (!Array.isArray(rows)) {
      throw new Error('World Bank artifact does not contain response.ZPROCSUPP[].');
    }
    const records = rows.map((row, index) => this.toRecord(input.sourceId, row, index));
    return { records, publisherVersion: text(response?.['LAST_UPDATED']) };
  }

  private toRecord(sourceId: string, raw: unknown, index: number): NormalizedSourceRecord {
    const row = asRecord(raw);
    if (row === null) {
      throw new Error(`World Bank row ${String(index)} is not an object.`);
    }
    const sourceRecordId = required(row, 'SUPP_ID', index);
    const rawName = required(row, 'SUPP_NAME', index);
    const names = splitNames(rawName);
    if (names.length === 0) {
      throw new Error(`World Bank row ${String(index)} has no usable SUPP_NAME.`);
    }
    const country = text(row['COUNTRY_NAME']);
    const addressLine = text(row['SUPP_ADDR']);
    const city = text(row['SUPP_CITY']);
    const grounds = text(row['DEBAR_REASON']);
    const effectiveDate = parseDate(text(row['DEBAR_FROM_DATE']));
    const expiryDate = parseDate(text(row['DEBAR_TO_DATE']));
    const recordType = mapRecordType(text(row['SUPP_TYPE']) ?? text(row['ENTITY_TYPE']));
    const crossDebarred = /cross[- ]debar/i.test(grounds ?? '');

    return {
      sourceId,
      sourceRecordId,
      recordKind: 'AUTHORITY_LIST_ENTRY',
      recordType,
      primaryName: names[0] as string,
      aliases: names.slice(1),
      originalScriptNames: [],
      datesOfBirth: [],
      placesOfBirth: [],
      nationalities: [],
      citizenships: [],
      countries: country === null ? [] : [country],
      addresses:
        addressLine === null && city === null && country === null
          ? []
          : [
              {
                lines: addressLine === null ? [] : [addressLine],
                city,
                region: null,
                postalCode: null,
                country,
              },
            ],
      identifiers: [],
      companyIdentifiers: [],
      listingDate: effectiveDate,
      programmes: crossDebarred ? ['WORLD_BANK_CROSS_DEBARMENT'] : ['WORLD_BANK_DEBARMENT'],
      sanctionTypes: [crossDebarred ? 'CROSS_DEBARMENT' : 'DEBARMENT'],
      grounds,
      status: 'INELIGIBLE',
      effectiveDate,
      expiryDate,
      publisherUrl: PUBLISHER_PAGE,
      sourceDocumentUrl: PUBLISHER_PAGE,
      searchableText: null,
      publicationDate: null,
      findingMetadata: {
        category: 'BRIBERY_CORRUPTION',
        proceduralStage: 'DEBARMENT_DISQUALIFICATION',
        partyRole: 'CONVICTED_SANCTIONED_PARTY',
        stageEvidence: null,
      },
      rawEvidence: row,
    };
  }
}

function splitNames(value: string): string[] {
  const cleaned = value.replace(/\*\d+\s*$/u, '').trim();
  return cleaned
    .split(
      /\s+(?:a\.?k\.?a\.?|also known as|f\/k\/a|formerly|d\/b\/a|name change from|successor or assign to)\s+/iu,
    )
    .map((name) => name.replace(/^[(),\s]+|[(),\s]+$/gu, '').trim())
    .filter(Boolean);
}

function parseDate(value: string | null): IndexedSourceDate | null {
  if (value === null || /^(?:ongoing|permanent)$/i.test(value)) {
    return null;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso !== null) {
    return { value, precision: 'DAY' };
  }
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return null;
  }
  const month = MONTHS[match[2].toUpperCase()];
  if (month === undefined) {
    return null;
  }
  return {
    value: `${match[3]}-${month}-${match[1].padStart(2, '0')}`,
    precision: 'DAY',
  };
}

const MONTHS: Readonly<Record<string, string>> = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12',
};

function mapRecordType(value: string | null): IndexedRecordType {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'I' || normalized === 'INDIVIDUAL' || normalized === 'PERSON') {
    return 'PERSON';
  }
  if (normalized === 'F' || normalized === 'FIRM' || normalized === 'ENTITY') {
    return 'ENTITY';
  }
  return 'OTHER';
}

function required(row: Readonly<Record<string, unknown>>, key: string, index: number): string {
  const value = text(row[key]);
  if (value === null) {
    throw new Error(`World Bank row ${String(index)} is missing ${key}.`);
  }
  return value;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}
