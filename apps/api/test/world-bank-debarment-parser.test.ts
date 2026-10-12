import { describe, expect, it } from 'vitest';

import { WorldBankDebarmentParser } from '../src/sources/indexed/parsers/world-bank-debarment.parser.js';

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

describe('World Bank debarment parser', () => {
  it('maps publisher identifiers, aliases, address, dates, grounds and cross-debarment', () => {
    const parsed = new WorldBankDebarmentParser().parse({
      sourceId: 'world-bank-debarred',
      artifactUrl: 'https://apigwext.worldbank.org/example',
      contentType: 'application/json',
      body: encode({
        response: {
          LAST_UPDATED: '2026-09-18T12:00:00Z',
          ZPROCSUPP: [
            {
              SUPP_ID: 'WB-42',
              SUPP_NAME: 'Example Holdings a.k.a. Example International*71',
              SUPP_TYPE: 'FIRM',
              SUPP_ADDR: '10 Example Road',
              SUPP_CITY: 'Accra',
              COUNTRY_NAME: 'Ghana',
              DEBAR_FROM_DATE: '17-SEP-2026',
              DEBAR_TO_DATE: '16-SEP-2029',
              DEBAR_REASON: 'Cross-debarment following fraudulent and collusive practices',
            },
          ],
        },
      }),
    });

    expect(parsed.publisherVersion).toBe('2026-09-18T12:00:00Z');
    expect(parsed.records[0]).toMatchObject({
      sourceRecordId: 'WB-42',
      recordType: 'ENTITY',
      primaryName: 'Example Holdings',
      aliases: ['Example International'],
      countries: ['Ghana'],
      effectiveDate: { value: '2026-09-17', precision: 'DAY' },
      expiryDate: { value: '2029-09-16', precision: 'DAY' },
      programmes: ['WORLD_BANK_CROSS_DEBARMENT'],
      sanctionTypes: ['CROSS_DEBARMENT'],
      findingMetadata: {
        category: 'BRIBERY_CORRUPTION',
        proceduralStage: 'DEBARMENT_DISQUALIFICATION',
      },
    });
    expect(parsed.records[0]?.addresses[0]).toMatchObject({
      lines: ['10 Example Road'],
      city: 'Accra',
      country: 'Ghana',
    });
  });

  it('fails closed when the publisher response shape changes', () => {
    expect(() =>
      new WorldBankDebarmentParser().parse({
        sourceId: 'world-bank-debarred',
        artifactUrl: 'https://apigwext.worldbank.org/example',
        contentType: 'application/json',
        body: encode({ response: { rows: [] } }),
      }),
    ).toThrow(/response\.ZPROCSUPP/);
  });
});
