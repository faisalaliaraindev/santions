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

export class OfacXmlParser implements IndexedArtifactParser {
  readonly parserId = 'ofac-legacy-xml';
  readonly parserVersion = 'ofac-legacy-xml-1';

  parse(input: {
    readonly sourceId: string;
    readonly artifactUrl: string;
    readonly body: Uint8Array;
  }): ParsedSourceArtifact {
    const root = parseSafeXml(input.body);
    const list = asRecord(root['sdnList']);
    if (list === null) {
      throw new Error('OFAC artifact root is not <sdnList>.');
    }
    const entries = records(list['sdnEntry']);
    const parsed = entries.map((entry) => this.record(input, entry));
    const publication = asRecord(list['publshInformation']);
    return {
      records: parsed,
      publisherVersion:
        publication === null
          ? null
          : (text(publication['Publish_Date']) ?? text(publication['Record_Count'])),
    };
  }

  private record(
    input: { readonly sourceId: string; readonly artifactUrl: string },
    entry: Record<string, unknown>,
  ): NormalizedSourceRecord {
    const sourceRecordId = requireText(entry['uid'], 'sdnEntry.uid');
    const primaryName =
      joinName([entry['firstName'], entry['middleName'], entry['lastName']]) ??
      requireText(entry['lastName'], 'sdnEntry.lastName');
    const type = text(entry['sdnType'])?.toUpperCase() ?? 'OTHER';
    const aliases = records(asRecord(entry['akaList'])?.['aka'])
      .map((aka) => joinName([aka['firstName'], aka['middleName'], aka['lastName']]))
      .filter((value): value is string => value !== null);
    const addresses = records(asRecord(entry['addressList'])?.['address']).map(readAddress);
    const identifiers = records(asRecord(entry['idList'])?.['id']).map(readIdentifier);
    const datesOfBirth = records(asRecord(entry['dateOfBirthList'])?.['dateOfBirthItem'])
      .map((item) => parseDate(item['dateOfBirth']))
      .filter((date): date is IndexedSourceDate => date !== null);
    const placesOfBirth = records(
      asRecord(entry['placeOfBirthList'])?.['placeOfBirthItem'],
    ).flatMap((item) => texts(item['placeOfBirth']));

    return {
      sourceId: input.sourceId,
      sourceRecordId,
      recordType: type.includes('INDIVIDUAL')
        ? 'PERSON'
        : type.includes('VESSEL')
          ? 'VESSEL'
          : type.includes('AIRCRAFT')
            ? 'AIRCRAFT'
            : type.includes('ENTITY')
              ? 'ENTITY'
              : 'OTHER',
      primaryName,
      aliases: unique(aliases),
      originalScriptNames: [],
      datesOfBirth,
      placesOfBirth: unique(placesOfBirth),
      nationalities: [],
      citizenships: [],
      countries: unique([
        ...addresses
          .map((address) => address.country)
          .filter((value): value is string => value !== null),
        ...identifiers
          .map((identifier) => identifier.issuingCountry)
          .filter((value): value is string => value !== null),
      ]),
      addresses,
      identifiers,
      companyIdentifiers: identifiers.filter((identifier) =>
        /business|company|registration|tax/i.test(identifier.type),
      ),
      listingDate: null,
      programmes: texts(asRecord(entry['programList'])?.['program']),
      sanctionTypes: [input.sourceId === 'ofac-sdn' ? 'SDN' : 'CONSOLIDATED_NON_SDN'],
      grounds: text(entry['remarks']),
      status: 'LISTED',
      effectiveDate: null,
      expiryDate: null,
      publisherUrl: 'https://ofac.treasury.gov/',
      sourceDocumentUrl: input.artifactUrl,
      rawEvidence: compactRaw(entry),
    };
  }
}

function readAddress(value: Record<string, unknown>): IndexedSourceAddress {
  return {
    lines: unique(
      [value['address1'], value['address2'], value['address3']]
        .map(text)
        .filter((v): v is string => v !== null),
    ),
    city: text(value['city']),
    region: text(value['stateOrProvince']),
    postalCode: text(value['postalCode']),
    country: text(value['country']),
  };
}

function readIdentifier(value: Record<string, unknown>): IndexedSourceIdentifier {
  return {
    type: text(value['idType']) ?? 'UNSPECIFIED',
    value: requireText(value['idNumber'], 'sdnEntry.idList.id.idNumber'),
    issuingCountry: text(value['idCountry']),
  };
}
