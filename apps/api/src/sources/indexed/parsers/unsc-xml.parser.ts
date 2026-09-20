import type {
  IndexedArtifactParser,
  IndexedSourceAddress,
  IndexedSourceDate,
  IndexedSourceIdentifier,
  NormalizedSourceRecord,
  ParsedSourceArtifact,
} from '../indexed-source.types.js';
import {
  asRecord,
  compactRaw,
  joinName,
  parseDate,
  parseSafeXml,
  records,
  requireText,
  text,
  texts,
  unique,
} from './xml-record-utils.js';

export class UnscXmlParser implements IndexedArtifactParser {
  readonly parserId = 'unsc-consolidated-xml';
  readonly parserVersion = 'unsc-consolidated-xml-1';

  parse(input: {
    readonly sourceId: string;
    readonly artifactUrl: string;
    readonly body: Uint8Array;
  }): ParsedSourceArtifact {
    const root = parseSafeXml(input.body);
    const list = asRecord(root['CONSOLIDATED_LIST']);
    if (list === null) {
      throw new Error('UN artifact root is not <CONSOLIDATED_LIST>.');
    }
    const individuals = records(asRecord(list['INDIVIDUALS'])?.['INDIVIDUAL']).map((entry) =>
      this.record(input, entry, 'PERSON'),
    );
    const entities = records(asRecord(list['ENTITIES'])?.['ENTITY']).map((entry) =>
      this.record(input, entry, 'ENTITY'),
    );
    return {
      records: [...individuals, ...entities],
      publisherVersion: text(list['dateGenerated']) ?? text(list['@_dateGenerated']),
    };
  }

  private record(
    input: { readonly sourceId: string; readonly artifactUrl: string },
    entry: Record<string, unknown>,
    recordType: 'PERSON' | 'ENTITY',
  ): NormalizedSourceRecord {
    const sourceRecordId = requireText(entry['REFERENCE_NUMBER'], 'REFERENCE_NUMBER');
    const primaryName =
      recordType === 'PERSON'
        ? joinName([entry['FIRST_NAME'], entry['SECOND_NAME'], entry['THIRD_NAME'], entry['FOURTH_NAME']])
        : text(entry['FIRST_NAME']);
    if (primaryName === null) {
      throw new Error(`UN record ${sourceRecordId} has no primary name.`);
    }
    const aliases = records(entry[recordType === 'PERSON' ? 'INDIVIDUAL_ALIAS' : 'ENTITY_ALIAS'])
      .flatMap((alias) => texts(alias['ALIAS_NAME']));
    const originalScriptNames = texts(entry['NAME_ORIGINAL_SCRIPT']);
    const addresses = records(
      entry[recordType === 'PERSON' ? 'INDIVIDUAL_ADDRESS' : 'ENTITY_ADDRESS'],
    ).map(readAddress);
    const datesOfBirth = records(entry['INDIVIDUAL_DATE_OF_BIRTH'])
      .map(readBirthDate)
      .filter((date): date is IndexedSourceDate => date !== null);
    const placesOfBirth = records(entry['INDIVIDUAL_PLACE_OF_BIRTH']).flatMap((place) =>
      unique(
        [place['CITY'], place['STATE_PROVINCE'], place['COUNTRY']]
          .map(text)
          .filter((value): value is string => value !== null),
      ),
    );
    const identifiers: IndexedSourceIdentifier[] = [
      ...records(entry['INDIVIDUAL_DOCUMENT']).map((document) => ({
        type: text(document['TYPE_OF_DOCUMENT']) ?? 'DOCUMENT',
        value: requireText(document['NUMBER'], 'INDIVIDUAL_DOCUMENT.NUMBER'),
        issuingCountry: text(document['ISSUING_COUNTRY']),
      })),
      ...texts(entry['UN_LIST_TYPE']).map((value) => ({
        type: 'UN_LIST_TYPE',
        value,
        issuingCountry: null,
      })),
    ];
    const programmes = unique([
      ...texts(entry['UN_LIST_TYPE']),
      sourceRecordId.split(/[ie]\./i, 1)[0] ?? sourceRecordId,
    ]);

    return {
      sourceId: input.sourceId,
      sourceRecordId,
      recordType,
      primaryName,
      aliases: unique(aliases),
      originalScriptNames,
      datesOfBirth,
      placesOfBirth: unique(placesOfBirth),
      nationalities: records(entry['NATIONALITY']).flatMap((item) => texts(item['VALUE'])),
      citizenships: [],
      countries: unique(addresses.map((item) => item.country).filter((value): value is string => value !== null)),
      addresses,
      identifiers,
      companyIdentifiers: [],
      listingDate: parseDate(entry['LISTED_ON']),
      programmes,
      sanctionTypes: ['UN_SECURITY_COUNCIL_DESIGNATION'],
      grounds: text(entry['COMMENTS1']),
      status: 'LISTED',
      effectiveDate: parseDate(entry['LISTED_ON']),
      expiryDate: null,
      publisherUrl: 'https://main.un.org/securitycouncil/en/sanctions/information',
      sourceDocumentUrl: input.artifactUrl,
      rawEvidence: compactRaw(entry),
    };
  }
}

function readAddress(value: Record<string, unknown>): IndexedSourceAddress {
  return {
    lines: unique([value['STREET'], value['NOTE']].map(text).filter((item): item is string => item !== null)),
    city: text(value['CITY']),
    region: text(value['STATE_PROVINCE']),
    postalCode: text(value['ZIP_CODE']),
    country: text(value['COUNTRY']),
  };
}

function readBirthDate(value: Record<string, unknown>): IndexedSourceDate | null {
  const exact = parseDate(value['DATE']);
  if (exact !== null) {
    return exact;
  }
  const year = text(value['YEAR']);
  return year === null ? null : { value: `${year}-01-01`, precision: 'YEAR' };
}
