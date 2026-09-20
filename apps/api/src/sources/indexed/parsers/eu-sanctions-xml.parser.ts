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
  attr,
  compactRaw,
  parseDate,
  parseSafeXml,
  records,
  requireText,
  text,
  unique,
} from './xml-record-utils.js';

export class EuSanctionsXmlParser implements IndexedArtifactParser {
  readonly parserId = 'eu-fsf-xml-1.1';
  readonly parserVersion = 'eu-fsf-xml-1.1-1';

  parse(input: {
    readonly sourceId: string;
    readonly artifactUrl: string;
    readonly body: Uint8Array;
  }): ParsedSourceArtifact {
    const root = parseSafeXml(input.body);
    const exportRoot = asRecord(root['export']);
    if (exportRoot === null) {
      throw new Error('EU sanctions artifact root is not <export>.');
    }
    const entities = records(exportRoot['sanctionEntity']);
    return {
      records: entities.map((entity) => this.record(input, entity)),
      publisherVersion: attr(exportRoot, 'generationDate'),
    };
  }

  private record(
    input: { readonly sourceId: string; readonly artifactUrl: string },
    entity: Record<string, unknown>,
  ): NormalizedSourceRecord {
    const sourceRecordId =
      attr(entity, 'euReferenceNumber') ??
      attr(entity, 'logicalId') ??
      requireText(entity['euReferenceNumber'], 'sanctionEntity.euReferenceNumber');
    const names = records(entity['nameAlias']);
    const strong = names.filter((name) => (attr(name, 'strong') ?? 'true') === 'true');
    const primary = strong[0] ?? names[0];
    const primaryName = primary === undefined ? null : attr(primary, 'wholeName');
    if (primaryName === null) {
      throw new Error(`EU sanctions record ${sourceRecordId} has no wholeName.`);
    }
    const aliases = names
      .filter((name) => name !== primary)
      .map((name) => attr(name, 'wholeName'))
      .filter((name): name is string => name !== null);
    const birthDates = records(entity['birthdate']).map((birth) =>
      parseDate(attr(birth, 'birthdate') ?? attr(birth, 'year')),
    );
    const addresses = records(entity['address']).map(readAddress);
    const identifications = records(entity['identification']).map(readIdentification);
    const regulations = records(entity['regulation']);
    const subjectType = attr(asRecord(entity['subjectType']) ?? {}, 'code') ?? 'OTHER';

    return {
      sourceId: input.sourceId,
      sourceRecordId,
      recordType: /person/i.test(subjectType) ? 'PERSON' : /enterprise|entity/i.test(subjectType) ? 'ENTITY' : 'OTHER',
      primaryName,
      aliases: unique(aliases),
      originalScriptNames: unique(
        names
          .filter((name) => (attr(name, 'nameLanguage') ?? 'EN') !== 'EN')
          .map((name) => attr(name, 'wholeName'))
          .filter((name): name is string => name !== null),
      ),
      datesOfBirth: birthDates.filter((date): date is IndexedSourceDate => date !== null),
      placesOfBirth: unique(
        records(entity['birthdate']).flatMap((birth) =>
          [attr(birth, 'place'), attr(birth, 'city'), attr(birth, 'countryDescription')].filter(
            (value): value is string => value !== null,
          ),
        ),
      ),
      nationalities: unique(
        records(entity['citizenship'])
          .map((item) => attr(item, 'countryDescription') ?? attr(item, 'countryIso2Code'))
          .filter((value): value is string => value !== null),
      ),
      citizenships: [],
      countries: unique(addresses.map((address) => address.country).filter((value): value is string => value !== null)),
      addresses,
      identifiers: identifications,
      companyIdentifiers: identifications.filter((identifier) => /registration|tax/i.test(identifier.type)),
      listingDate: parseDate(attr(regulations[0] ?? {}, 'publicationDate')),
      programmes: unique(
        regulations
          .map((regulation) => attr(regulation, 'programme'))
          .filter((value): value is string => value !== null),
      ),
      sanctionTypes: ['EU_ASSET_FREEZE'],
      grounds: text(entity['remark']),
      status: 'LISTED',
      effectiveDate: parseDate(attr(regulations[0] ?? {}, 'entryIntoForceDate')),
      expiryDate: null,
      publisherUrl: 'https://finance.ec.europa.eu/eu-and-world/sanctions-restrictive-measures_en',
      sourceDocumentUrl: input.artifactUrl,
      rawEvidence: compactRaw(entity),
    };
  }
}

function readAddress(address: Record<string, unknown>): IndexedSourceAddress {
  return {
    lines: unique(
      [attr(address, 'street'), attr(address, 'place')].filter((value): value is string => value !== null),
    ),
    city: attr(address, 'city'),
    region: attr(address, 'region'),
    postalCode: attr(address, 'zipCode'),
    country: attr(address, 'countryDescription') ?? attr(address, 'countryIso2Code'),
  };
}

function readIdentification(identification: Record<string, unknown>): IndexedSourceIdentifier {
  return {
    type: attr(identification, 'identificationTypeCode') ?? 'UNSPECIFIED',
    value: requireText(
      attr(identification, 'number') ?? attr(identification, 'logicalId'),
      'identification.number',
    ),
    issuingCountry:
      attr(identification, 'countryDescription') ?? attr(identification, 'countryIso2Code'),
  };
}
