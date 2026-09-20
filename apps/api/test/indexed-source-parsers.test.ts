import { describe, expect, it } from 'vitest';

import { OfacXmlParser } from '../src/sources/indexed/parsers/ofac-xml.parser.js';
import { EuSanctionsXmlParser } from '../src/sources/indexed/parsers/eu-sanctions-xml.parser.js';
import { UkslXmlParser } from '../src/sources/indexed/parsers/uksl-xml.parser.js';
import { UnscXmlParser } from '../src/sources/indexed/parsers/unsc-xml.parser.js';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('Phase A indexed-source parsers', () => {
  it('normalises OFAC people, aliases, DOBs, addresses, identifiers and programmes', () => {
    const parsed = new OfacXmlParser().parse({
      sourceId: 'ofac-sdn',
      artifactUrl: 'https://sanctionslistservice.ofac.treas.gov/example/sdn.xml',
      body: bytes(`
        <sdnList>
          <publshInformation><Publish_Date>09/18/2026</Publish_Date></publshInformation>
          <sdnEntry>
            <uid>123</uid><firstName>Alex</firstName><lastName>Example</lastName>
            <sdnType>Individual</sdnType>
            <programList><program>TEST</program></programList>
            <akaList><aka><firstName>A.</firstName><lastName>Example</lastName></aka></akaList>
            <dateOfBirthList><dateOfBirthItem><dateOfBirth>14 Jan 1970</dateOfBirth></dateOfBirthItem></dateOfBirthList>
            <placeOfBirthList><placeOfBirthItem><placeOfBirth>Sample City</placeOfBirth></placeOfBirthItem></placeOfBirthList>
            <addressList><address><address1>1 Main St</address1><city>Sample City</city><country>US</country></address></addressList>
            <idList><id><idType>Passport</idType><idNumber>P123</idNumber><idCountry>US</idCountry></id></idList>
          </sdnEntry>
        </sdnList>`),
    });

    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      sourceRecordId: '123',
      recordType: 'PERSON',
      primaryName: 'Alex Example',
      aliases: ['A. Example'],
      placesOfBirth: ['Sample City'],
      programmes: ['TEST'],
    });
    expect(parsed.records[0]?.datesOfBirth[0]).toEqual({
      value: '1970-01-01',
      precision: 'YEAR',
    });
    expect(parsed.records[0]?.identifiers[0]).toEqual({
      type: 'Passport',
      value: 'P123',
      issuingCountry: 'US',
    });
  });

  it('keeps UN individual and entity records independent with permanent reference numbers', () => {
    const parsed = new UnscXmlParser().parse({
      sourceId: 'unsc-consolidated',
      artifactUrl: 'https://scsanctions.un.org/resources/xml/en/name/consolidated.xml',
      body: bytes(`
        <CONSOLIDATED_LIST dateGenerated="2026-09-18">
          <INDIVIDUALS><INDIVIDUAL>
            <REFERENCE_NUMBER>QDi.999</REFERENCE_NUMBER>
            <FIRST_NAME>Alex</FIRST_NAME><SECOND_NAME>Sample</SECOND_NAME>
            <NAME_ORIGINAL_SCRIPT>أليكس</NAME_ORIGINAL_SCRIPT>
            <UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE><LISTED_ON>2026-01-02</LISTED_ON>
            <INDIVIDUAL_ALIAS><ALIAS_NAME>A. Sample</ALIAS_NAME></INDIVIDUAL_ALIAS>
            <INDIVIDUAL_DATE_OF_BIRTH><YEAR>1970</YEAR></INDIVIDUAL_DATE_OF_BIRTH>
            <NATIONALITY><VALUE>Exampleland</VALUE></NATIONALITY>
          </INDIVIDUAL></INDIVIDUALS>
          <ENTITIES><ENTITY>
            <REFERENCE_NUMBER>QDe.999</REFERENCE_NUMBER><FIRST_NAME>Sample Holdings</FIRST_NAME>
            <UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE>
          </ENTITY></ENTITIES>
        </CONSOLIDATED_LIST>`),
    });

    expect(parsed.publisherVersion).toBe('2026-09-18');
    expect(parsed.records.map((record) => record.sourceRecordId)).toEqual(['QDi.999', 'QDe.999']);
    expect(parsed.records[0]).toMatchObject({
      recordType: 'PERSON',
      primaryName: 'Alex Sample',
      aliases: ['A. Sample'],
      originalScriptNames: ['أليكس'],
      nationalities: ['Exampleland'],
    });
    expect(parsed.records[1]).toMatchObject({
      recordType: 'ENTITY',
      primaryName: 'Sample Holdings',
    });
  });

  it('preserves UKSL identifiers, aliases, non-Latin names, regimes and sanctions', () => {
    const parsed = new UkslXmlParser().parse({
      sourceId: 'uk-sanctions-list',
      artifactUrl: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml',
      body: bytes(`<UK_SANCTIONS_LIST><LastUpdated>2026-09-18</LastUpdated><Designations>
        <Designation><UniqueID>UKS1234</UniqueID><IndividualEntityShip>Individual</IndividualEntityShip>
          <Names>
            <Name><NameType>Primary Name</NameType><Name1>Alex</Name1><Name6>Example</Name6><NameNonLatinScript>أليكس</NameNonLatinScript></Name>
            <Name><NameType>Alias</NameType><FullName>A. Example</FullName></Name>
          </Names>
          <DOB>1970-01-14</DOB><Nationality>Exampleland</Nationality>
          <Address><AddressLine1>1 High Street</AddressLine1><TownCity>London</TownCity><AddressCountry>GB</AddressCountry></Address>
          <PassportNumber>P123</PassportNumber><NationalIdentifierNumber>N456</NationalIdentifierNumber>
          <RegimeName>Example regime</RegimeName><DateDesignated>2026-01-02</DateDesignated>
          <SanctionsImposed><AssetFreeze>true</AssetFreeze><TravelBan>false</TravelBan></SanctionsImposed>
          <UKStatementOfReasons>Designated for test conduct.</UKStatementOfReasons>
        </Designation></Designations></UK_SANCTIONS_LIST>`),
    });

    expect(parsed.publisherVersion).toBe('2026-09-18');
    expect(parsed.records[0]).toMatchObject({
      sourceRecordId: 'UKS1234',
      recordType: 'PERSON',
      primaryName: 'Alex Example',
      aliases: ['A. Example'],
      originalScriptNames: ['أليكس'],
      programmes: ['Example regime'],
      sanctionTypes: ['AssetFreeze'],
      listingDate: { value: '2026-01-02', precision: 'DAY' },
    });
    expect(parsed.records[0]?.identifiers).toEqual([
      { type: 'PASSPORT', value: 'P123', issuingCountry: null },
      { type: 'NATIONAL_ID', value: 'N456', issuingCountry: null },
    ]);
  });

  it('preserves EU references, multilingual aliases, DOBs and regulation metadata', () => {
    const parsed = new EuSanctionsXmlParser().parse({
      sourceId: 'eu-consolidated-financial-sanctions',
      artifactUrl: 'https://webgate.ec.europa.eu/example',
      body: bytes(`<export generationDate="2026-09-18T06:00:00">
        <sanctionEntity euReferenceNumber="EU.123" logicalId="42">
          <subjectType code="person"/>
          <nameAlias wholeName="Alex Example" strong="true" nameLanguage="EN"/>
          <nameAlias wholeName="Алекс Пример" strong="false" nameLanguage="RU"/>
          <birthdate birthdate="1970-01-14" place="Sample City" countryDescription="Exampleland"/>
          <citizenship countryIso2Code="EX" countryDescription="Exampleland"/>
          <address street="1 Main Street" city="Sample City" countryDescription="Exampleland"/>
          <identification identificationTypeCode="passport" number="P123" countryIso2Code="EX"/>
          <regulation programme="EU-TEST" publicationDate="2026-01-02" entryIntoForceDate="2026-01-03"/>
          <remark>Listed for test conduct.</remark>
        </sanctionEntity></export>`),
    });

    expect(parsed.publisherVersion).toBe('2026-09-18T06:00:00');
    expect(parsed.records[0]).toMatchObject({
      sourceRecordId: 'EU.123',
      recordType: 'PERSON',
      primaryName: 'Alex Example',
      aliases: ['Алекс Пример'],
      originalScriptNames: ['Алекс Пример'],
      nationalities: ['Exampleland'],
      programmes: ['EU-TEST'],
      listingDate: { value: '2026-01-02', precision: 'DAY' },
      effectiveDate: { value: '2026-01-03', precision: 'DAY' },
    });
  });

  it('rejects an XML artifact carrying a DTD before parsing', () => {
    expect(() =>
      new OfacXmlParser().parse({
        sourceId: 'ofac-sdn',
        artifactUrl: 'https://example.test/sdn.xml',
        body: bytes('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><sdnList/>'),
      }),
    ).toThrow(/DOCTYPE/);
  });
});
