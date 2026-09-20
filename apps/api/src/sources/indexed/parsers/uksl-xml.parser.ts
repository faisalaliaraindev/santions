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
  first,
  joinName,
  parseDate,
  parseSafeXml,
  records,
  requireText,
  text,
  texts,
  unique,
} from './xml-record-utils.js';

export class UkslXmlParser implements IndexedArtifactParser {
  readonly parserId = 'uksl-xml';
  readonly parserVersion = 'uksl-xml-1';

  parse(input: {
    readonly sourceId: string;
    readonly artifactUrl: string;
    readonly body: Uint8Array;
  }): ParsedSourceArtifact {
    const root = parseSafeXml(input.body);
    const list = asRecord(root['UK_SANCTIONS_LIST']) ?? asRecord(root['SanctionsList']) ?? root;
    const designations = findRecords(list, ['Designation', 'DESIGNATION']);
    if (designations.length === 0) {
      throw new Error('UKSL XML contains no <Designation> records in the documented schema.');
    }
    return {
      records: designations.map((designation) => this.record(input, designation)),
      publisherVersion: text(first(list, 'LastUpdated', 'LAST_UPDATED', '@_lastUpdated')),
    };
  }

  private record(
    input: { readonly sourceId: string; readonly artifactUrl: string },
    designation: Record<string, unknown>,
  ): NormalizedSourceRecord {
    const sourceRecordId = requireText(
      first(designation, 'UniqueID', 'UniqueId', 'UKSanctionsListRef'),
      'Designation.UniqueID',
    );
    const namesContainer = asRecord(first(designation, 'Names', 'NAMES'));
    const names = records(first(namesContainer ?? {}, 'Name', 'NAME'));
    const primary =
      names.find((name) => /primary name$/i.test(text(first(name, 'NameType', 'NAME_TYPE')) ?? '')) ??
      names[0] ??
      designation;
    const primaryName = readName(primary);
    if (primaryName === null) {
      throw new Error(`UKSL designation ${sourceRecordId} has no primary name.`);
    }
    const aliases = names
      .filter((name) => name !== primary)
      .map(readName)
      .filter((name): name is string => name !== null);
    const originalScriptNames = names.flatMap((name) =>
      texts(first(name, 'NameNonLatinScript', 'NAME_NON_LATIN_SCRIPT')),
    );
    const addresses = findRecords(designation, ['Address', 'ADDRESS']).map(readAddress);
    const type = text(first(designation, 'IndividualEntityShip', 'GroupType', 'TYPE')) ?? 'OTHER';
    const passportNumbers = texts(first(designation, 'PassportNumber', 'PassportNumbers'));
    const nationalIds = texts(
      first(designation, 'NationalIdentifierNumber', 'NationalIdentificationNumber'),
    );
    const companyIds = texts(
      first(designation, 'BusinessRegistrationNumber', 'BusinessRegistrationNumbers'),
    );
    const identifiers: IndexedSourceIdentifier[] = [
      ...passportNumbers.map((value) => ({ type: 'PASSPORT', value, issuingCountry: null })),
      ...nationalIds.map((value) => ({ type: 'NATIONAL_ID', value, issuingCountry: null })),
    ];
    const companyIdentifiers = companyIds.map((value) => ({
      type: 'BUSINESS_REGISTRATION',
      value,
      issuingCountry: null,
    }));

    return {
      sourceId: input.sourceId,
      sourceRecordId,
      recordType: /individual/i.test(type)
        ? 'PERSON'
        : /ship|vessel/i.test(type)
          ? 'VESSEL'
          : /entity/i.test(type)
            ? 'ENTITY'
            : 'OTHER',
      primaryName,
      aliases: unique(aliases),
      originalScriptNames: unique(originalScriptNames),
      datesOfBirth: texts(first(designation, 'DOB', 'DateOfBirth', 'DatesOfBirth'))
        .map(parseDate)
        .filter((date): date is IndexedSourceDate => date !== null),
      placesOfBirth: unique([
        ...texts(first(designation, 'TownOfBirth', 'PlaceOfBirth')),
        ...texts(first(designation, 'CountryOfBirth')),
      ]),
      nationalities: texts(first(designation, 'Nationalities', 'Nationality')),
      citizenships: [],
      countries: unique(addresses.map((address) => address.country).filter((value): value is string => value !== null)),
      addresses,
      identifiers,
      companyIdentifiers,
      listingDate: parseDate(first(designation, 'DateDesignated', 'DATE_DESIGNATED')),
      programmes: texts(first(designation, 'RegimeName', 'Regimes', 'REGIME')),
      sanctionTypes: readSanctions(designation),
      grounds: text(first(designation, 'UKStatementOfReasons', 'StatementOfReasons', 'OtherInformation')),
      status: text(first(designation, 'Status', 'DesignationStatus')) ?? 'LISTED',
      effectiveDate: parseDate(first(designation, 'DateDesignated', 'DATE_DESIGNATED')),
      expiryDate: null,
      publisherUrl: 'https://www.gov.uk/government/publications/the-uk-sanctions-list',
      sourceDocumentUrl: input.artifactUrl,
      rawEvidence: compactRaw(designation),
    };
  }
}

function readName(name: Record<string, unknown>): string | null {
  return (
    text(first(name, 'FullName', 'FULL_NAME')) ??
    joinName([
      first(name, 'Name1', 'NAME1'),
      first(name, 'Name2', 'NAME2'),
      first(name, 'Name3', 'NAME3'),
      first(name, 'Name4', 'NAME4'),
      first(name, 'Name5', 'NAME5'),
      first(name, 'Name6', 'NAME6'),
    ])
  );
}

function readAddress(address: Record<string, unknown>): IndexedSourceAddress {
  return {
    lines: unique(
      [1, 2, 3, 4].map((index) => text(first(address, `AddressLine${String(index)}`, `ADDRESS_${String(index)}`))).filter((value): value is string => value !== null),
    ),
    city: text(first(address, 'AddressLine5', 'TownCity', 'CITY')),
    region: text(first(address, 'AddressLine6', 'StateRegion', 'STATE_PROVINCE')),
    postalCode: text(first(address, 'AddressPostalCode', 'PostZipCode', 'POSTAL_CODE')),
    country: text(first(address, 'AddressCountry', 'Country', 'COUNTRY')),
  };
}

function readSanctions(designation: Record<string, unknown>): string[] {
  const sanctions = asRecord(first(designation, 'SanctionsImposed', 'SANCTIONS_IMPOSED'));
  if (sanctions === null) {
    return [];
  }
  return unique(
    Object.entries(sanctions)
      .filter(([, value]) => text(value)?.toLowerCase() === 'true' || text(value) === '1')
      .map(([key]) => key),
  );
}

function findRecords(
  root: Record<string, unknown>,
  keys: readonly string[],
): readonly Record<string, unknown>[] {
  for (const [key, value] of Object.entries(root)) {
    if (keys.includes(key)) {
      return records(value);
    }
    const child = asRecord(value);
    if (child !== null) {
      const found = findRecords(child, keys);
      if (found.length > 0) {
        return found;
      }
    }
  }
  return [];
}
