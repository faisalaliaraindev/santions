import { describe, expect, it } from 'vitest';

import {
  GLOBAL_INDEXED_SOURCE_CONTENT,
  globalIndexedSourceContent,
} from '../src/sources/registry/global-indexed-sources.js';
import {
  REGULATOR_INDEXED_SOURCE_CONTENT,
  regulatorIndexedSourceContent,
} from '../src/sources/registry/regulator-indexed-sources.js';
import {
  WORLD_BANK_DEBARRED_CONTENT,
  worldBankDebarredContent,
} from '../src/sources/registry/world-bank-indexed-source.js';

describe('global indexed source proposals', () => {
  it('validates every proposed version against the source contract', () => {
    for (const sourceId of Object.keys(GLOBAL_INDEXED_SOURCE_CONTENT) as Array<
      keyof typeof GLOBAL_INDEXED_SOURCE_CONTENT
    >) {
      expect(() => globalIndexedSourceContent(sourceId)).not.toThrow();
    }
    for (const sourceId of Object.keys(REGULATOR_INDEXED_SOURCE_CONTENT) as Array<
      keyof typeof REGULATOR_INDEXED_SOURCE_CONTENT
    >) {
      expect(() => regulatorIndexedSourceContent(sourceId)).not.toThrow();
    }
    expect(() => worldBankDebarredContent()).not.toThrow();
  });

  it('keeps every new source inert until governance records human approval and robots evidence', () => {
    const proposals = [
      ...Object.values(GLOBAL_INDEXED_SOURCE_CONTENT),
      WORLD_BANK_DEBARRED_CONTENT,
      ...Object.values(REGULATOR_INDEXED_SOURCE_CONTENT),
    ];
    for (const proposal of proposals) {
      expect(proposal.accessPolicy.firstContactApproval).toBeNull();
      expect(proposal.robotsPosition).toBe('NOT_ESTABLISHED');
    }
  });

  it('uses separate source IDs for OFAC SDN and non-SDN list semantics only', () => {
    expect(Object.keys(GLOBAL_INDEXED_SOURCE_CONTENT)).toContain('ofac-sdn');
    expect(Object.keys(GLOBAL_INDEXED_SOURCE_CONTENT)).toContain('ofac-consolidated-non-sdn');
    expect(GLOBAL_INDEXED_SOURCE_CONTENT['ofac-sdn'].parserVersion).toBe(
      GLOBAL_INDEXED_SOURCE_CONTENT['ofac-consolidated-non-sdn'].parserVersion,
    );
  });
});
