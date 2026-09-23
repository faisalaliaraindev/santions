/**
 * `loadActiveByDomain` against the real database — the publisher-authorisation lookup.
 *
 * # Why this suite exists, and why it is an integration test rather than a unit test
 *
 * This lookup is what stands between a discovered candidate and a request to a publisher: the
 * fetch gate asks it whether any ACTIVE registry record covers the domain about to be contacted,
 * and a null answer is `PUBLISHER_NOT_APPROVED` (D-042).
 *
 * On 2026-09-23 it returned null for **every** domain, including ones with a perfectly good
 * ACTIVE record. `wikinews-en` was taken through the full four-eyes lifecycle to ACTIVE, and the
 * Madoff article it authorises was still refused with "No approved source record covers
 * en.wikinews.org". The whole rung-5 chain was blocked by it and the failure looked exactly like
 * a governance gap, which is the most expensive way for a query bug to present.
 *
 * The cause was a **field path**: the Mongo query filtered on a top-level `canonicalDomains`
 * while the documents carry `content.canonicalDomains`, which is where the in-memory matching
 * loop immediately below the query reads it from. The query matched nothing, so the correct loop
 * never ran.
 *
 * **Nine unit-test files stub `loadActiveByDomain` and all of them passed throughout.** They have
 * to — they are testing the gate's behaviour given an answer, not how the answer is fetched. But
 * it means no unit test could have caught this, and adding another one would not catch the next
 * one either. The defect lived in the shape of a real document, so the test has to use a real
 * document in a real collection.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap`.
 *
 * Seeds its own source ids and deletes them afterwards: these suites run in parallel against one
 * database, and shared fixture state makes some other file fail.
 */

import { randomUUID } from 'node:crypto';

import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SourceVersionService,
  domainMatchCandidates,
} from '../../apps/api/src/sources/source-version.service.js';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

const SUITE = `pdl-${randomUUID().slice(0, 8)}`;
const NARROW = `${SUITE}-narrow`;
const BROAD = `${SUITE}-broad`;
const LEGACY = `${SUITE}-legacy`;
const RETIRED = `${SUITE}-retired`;

let client: MongoClient;
let db: Db;
let service: SourceVersionService;

/** A version document in the shape the admin lifecycle actually writes: content is nested. */
function version(sourceId: string, domains: readonly string[], status: string) {
  return {
    sourceId,
    versionId: randomUUID(),
    version: 1,
    status,
    kind: 'SOURCE',
    tenantId: null,
    content: {
      sourceName: sourceId,
      publisher: 'Test publisher',
      connectorType: 'EVIDENCE_FETCH_HTTP',
      canonicalDomains: [...domains],
      authorityTier: 4,
      cascadeRung: 5,
      robotsPosition: 'HONOURED',
      contentFormat: 'HTML',
      accessPolicy: { endpointUrl: null, requestCeilingPerSecond: 1 },
    },
  };
}

beforeAll(async () => {
  try {
    client = await MongoClient.connect(MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
    db = client.db();
    await db.command({ ping: 1 });
  } catch (error) {
    throw new Error(`${STACK_HINT}\n${String(error)}`);
  }

  await db.collection('sourceVersions').insertMany([
    version(NARROW, ['news.example-pdl.com'], 'ACTIVE'),
    version(BROAD, ['example-pdl.com'], 'ACTIVE'),
    // The tolerated legacy shape: domains at the top level rather than under `content`.
    // `mapActiveVersion` accepts both, so the query must too.
    {
      sourceId: LEGACY,
      versionId: randomUUID(),
      version: 1,
      status: 'ACTIVE',
      canonicalDomains: ['legacy-pdl.org'],
      sourceName: LEGACY,
      publisher: 'Legacy publisher',
      connectorType: 'EVIDENCE_FETCH_HTTP',
      robotsPosition: 'HONOURED',
      accessPolicy: { endpointUrl: null },
    },
    version(RETIRED, ['retired-pdl.com'], 'SUPERSEDED'),
  ]);

  service = new SourceVersionService(db);
});

afterAll(async () => {
  await db.collection('sourceVersions').deleteMany({ sourceId: { $regex: `^${SUITE}` } });
  await client.close();
});

describe('an ACTIVE record is actually found by the domain it covers', () => {
  it('finds a record whose domains live under content — the shape the lifecycle writes', async () => {
    // The regression. This returned null for every domain on 2026-09-23.
    const found = await service.loadActiveByDomain('news.example-pdl.com');
    expect(found).not.toBeNull();
    expect(found?.sourceId).toBe(NARROW);
  });

  it('covers a subdomain from the registered parent domain', async () => {
    const found = await service.loadActiveByDomain('www.example-pdl.com');
    expect(found?.sourceId).toBe(BROAD);
  });

  it('still finds a record stored in the legacy top-level shape', async () => {
    // `mapActiveVersion` tolerates both shapes; narrowing the query to one while the mapper
    // accepts two is how the two drifted apart in the first place.
    const found = await service.loadActiveByDomain('legacy-pdl.org');
    expect(found?.sourceId).toBe(LEGACY);
  });

  it('prefers the more specific record when two cover the same host', async () => {
    // The narrower approval is the one somebody thought about.
    const found = await service.loadActiveByDomain('news.example-pdl.com');
    expect(found?.sourceId).toBe(NARROW);
  });
});

describe('it still refuses everything it is supposed to refuse', () => {
  it('refuses a domain no record covers', async () => {
    expect(await service.loadActiveByDomain('nobody-pdl.com')).toBeNull();
  });

  it('refuses a look-alike that shares a suffix but not a whole label', async () => {
    // `notexample-pdl.com` must not match a record for `example-pdl.com`.
    expect(await service.loadActiveByDomain('notexample-pdl.com')).toBeNull();
  });

  it('refuses a record that is not ACTIVE', async () => {
    // A superseded approval is not an approval. The fix widened the field path, and it must not
    // have widened the status filter with it.
    expect(await service.loadActiveByDomain('retired-pdl.com')).toBeNull();
  });

  it('refuses a bare TLD and an empty domain', async () => {
    expect(domainMatchCandidates('com')).toEqual([]);
    expect(await service.loadActiveByDomain('')).toBeNull();
  });
});
