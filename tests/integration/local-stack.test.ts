/**
 * T01 and T02 — the gate G1 exit tests.
 *
 * These run against the **real local stack**, not mocks. That is the point: the plan is
 * explicit that mocks do not satisfy tests requiring real infrastructure, and everything
 * built after gate G1 assumes this stack genuinely works.
 *
 * Requires `pnpm local:up && pnpm local:bootstrap` first. If the stack is not running these
 * tests fail with an actionable message rather than being silently skipped — a skipped suite
 * is not a pass.
 */

import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MONGODB_URI =
  process.env['MONGODB_URI'] ??
  'mongodb://127.0.0.1:28017/adverse_search?replicaSet=rs0&directConnection=true';
const AWS_ENDPOINT = process.env['AWS_ENDPOINT_URL'] ?? 'http://127.0.0.1:28566';
const MEILI_HOST = process.env['MEILI_HOST'] ?? 'http://127.0.0.1:28700';
const MEILI_KEY = process.env['MEILI_MASTER_KEY'] ?? 'local-development-master-key-change-me';
const OIDC_ISSUER =
  process.env['OIDC_ISSUER'] ?? 'http://127.0.0.1:28080/realms/adverse-search-local';
const MODEL_RUNTIME = process.env['MODEL_RUNTIME_URL'] ?? 'http://127.0.0.1:28434';
const FIXTURE_SERVER = process.env['FIXTURE_SERVER_URL'] ?? 'http://127.0.0.1:28090';

const STACK_HINT =
  'The local stack is not running. Start it with:\n  pnpm local:up && pnpm local:bootstrap';

let mongo: MongoClient;

beforeAll(async () => {
  mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try {
    await mongo.connect();
  } catch (error) {
    throw new Error(`${STACK_HINT}\n\nMongoDB connection failed: ${String(error)}`);
  }
}, 60_000);

afterAll(async () => {
  await mongo.close();
});

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new Error(`${STACK_HINT}\n\nRequest to ${url} failed: ${String(error)}`);
  }
}

describe('T01 — fresh checkout and local bootstrap', () => {
  it('MongoDB has an elected primary, so transactions are available', async () => {
    const hello = await mongo.db('admin').command({ hello: 1 });
    // A standalone mongod cannot do transactions, and the state/outbox/audit commit needs
    // them. Asserting "responds" would not catch a standalone running by mistake.
    expect(hello['isWritablePrimary']).toBe(true);
    expect(hello['setName']).toBe('rs0');
  });

  it('MongoDB can actually commit a transaction', async () => {
    const session = mongo.startSession();
    try {
      await session.withTransaction(async () => {
        await mongo
          .db()
          .collection('_bootstrapProbe')
          .insertOne({ probe: true, at: new Date().toISOString() }, { session });
      });
    } finally {
      await session.endSession();
    }
    const found = await mongo.db().collection('_bootstrapProbe').findOne({ probe: true });
    expect(found).not.toBeNull();
    await mongo.db().collection('_bootstrapProbe').deleteMany({ probe: true });
  });

  it('the search index is healthy and both indexes exist', async () => {
    const health = await get(`${MEILI_HOST}/health`);
    expect(health.ok).toBe(true);

    for (const uid of ['subjects', 'documents']) {
      const index = await get(`${MEILI_HOST}/indexes/${uid}`, {
        Authorization: `Bearer ${MEILI_KEY}`,
      });
      expect(index.ok, `index "${uid}" is missing — run pnpm local:bootstrap`).toBe(true);
    }
  });

  it('S3 and SQS emulation are healthy', async () => {
    const response = await get(`${AWS_ENDPOINT}/_localstack/health`);
    expect(response.ok).toBe(true);
    const health = (await response.json()) as { services: Record<string, string> };
    expect(health.services['s3']).toBeDefined();
    expect(health.services['sqs']).toBeDefined();
  });

  it('the OIDC provider serves the realm discovery document', async () => {
    const response = await get(`${OIDC_ISSUER}/.well-known/openid-configuration`);
    expect(response.ok, `realm not imported — check infra/local/keycloak/realm-export.json`).toBe(
      true,
    );

    const config = (await response.json()) as Record<string, unknown>;
    expect(config['issuer']).toBe(OIDC_ISSUER);
    expect(config['authorization_endpoint']).toBeDefined();
    expect(config['token_endpoint']).toBeDefined();
    // PKCE is required for the panel's authorisation-code flow (section 4.2).
    expect(config['code_challenge_methods_supported']).toContain('S256');
  });

  it('the model runtime answers, without a model being pulled', async () => {
    const response = await get(`${MODEL_RUNTIME}/api/tags`);
    expect(response.ok).toBe(true);
    // Which open-weight model to use is open decision D7, closing in Phase F. "Healthy" here
    // deliberately means the runtime answers — not that a model is loaded.
  });

  it('the fixture server serves mock content and labels it as mock', async () => {
    const response = await get(`${FIXTURE_SERVER}/health.json`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { mode: string };
    expect(body.mode).toBe('MOCK');
  });

  /** The tenants `local:bootstrap` writes. Records outside these belong to whatever created them. */
  const SEEDED_TENANTS = ['tenant-alpha', 'tenant-beta'];

  it('two synthetic tenants are seeded, so cross-tenant denial is testable', async () => {
    const tenants = await mongo.db().collection('tenants').find({}).toArray();
    const ids = new Set(tenants.map((t) => String(t['tenantId'])));

    // Presence, not exclusivity. Asserting "exactly these two" made this test fail whenever
    // another suite created a tenant of its own — a brittleness that says nothing about
    // whether the bootstrap worked.
    expect(ids.has('tenant-alpha')).toBe(true);
    expect(ids.has('tenant-beta')).toBe(true);
  });

  it('every seeded record is labelled MOCK, so a fixture cannot pass as a live result', async () => {
    // Test T55. The label lives on the data rather than in a config flag someone can flip.
    //
    // **Scoped to what the bootstrap seeds**, for the same reason the tenant test above was
    // scoped to presence rather than exclusivity: a tenant created by a live-mode process is
    // correctly labelled `LIVE`, and counting it here made the label doing its job look like the
    // label being absent. What T55 forbids is a **fixture** passing as a live result, and that is
    // what is asserted — every seeded tenant's records, and every seeded source version, carry
    // `MOCK`. It still fails if the bootstrap ever writes one that does not.
    for (const collection of ['tenants', 'taxonomyVersions', 'policyVersions']) {
      const unlabelled = await mongo
        .db()
        .collection(collection)
        .countDocuments({ tenantId: { $in: SEEDED_TENANTS }, mode: { $ne: 'MOCK' } });
      expect(unlabelled, `${collection} holds seeded records not labelled MOCK`).toBe(0);
    }

    const unlabelledSources = await mongo
      .db()
      .collection('sourceVersions')
      .countDocuments({ connectorType: 'FIXTURE_MOCK', mode: { $ne: 'MOCK' } });
    expect(unlabelledSources, 'a fixture source version is not labelled MOCK').toBe(0);

    // And the other half of the same rule: no record carries a mode this system does not have.
    // An unrecognised value is how a label stops meaning anything.
    for (const collection of ['tenants', 'sourceVersions', 'taxonomyVersions', 'policyVersions']) {
      const strange = await mongo
        .db()
        .collection(collection)
        .countDocuments({ mode: { $nin: ['MOCK', 'LIVE'] } });
      expect(strange, `${collection} holds a record with an unrecognised mode`).toBe(0);
    }
  });

  it('no language is enabled, because none has a measured recall figure', async () => {
    // FR-03. This assertion should start failing at gate G10, when real figures are measured
    // — at which point it is updated deliberately, not quietly.
    const taxonomies = await mongo.db().collection('taxonomyVersions').find({}).toArray();
    expect(taxonomies.length).toBeGreaterThan(0);

    for (const taxonomy of taxonomies) {
      const languages = (taxonomy['languages'] ?? []) as { measuredRecall: number | null }[];
      for (const language of languages) {
        expect(language.measuredRecall).toBeNull();
      }
    }
  });

  it('the entitlement version is pinned and active for each tenant', async () => {
    for (const tenantId of ['tenant-alpha', 'tenant-beta']) {
      const entitlement = await mongo
        .db()
        .collection('tenantEntitlementVersions')
        .findOne({ tenantId, status: 'ACTIVE' });
      expect(entitlement, `no active entitlement for ${tenantId}`).not.toBeNull();
      expect(entitlement?.['capabilities']).toContain('adverse_media');
    }
  });
});

describe('T02 — restart and persistence', () => {
  it('bootstrap is idempotent: re-running changes no record count', async () => {
    // A bootstrap that is not idempotent quietly duplicates seed data on every run, and the
    // duplicates only surface as confusing test failures much later.
    const before = await mongo.db().collection('tenants').countDocuments();

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('node', ['scripts/local-bootstrap.mjs'], {
      cwd: process.cwd(),
      timeout: 180_000,
    });

    const after = await mongo.db().collection('tenants').countDocuments();
    expect(after).toBe(before);
  }, 200_000);

  it('seeded state survives a reconnect', async () => {
    const fresh = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    try {
      await fresh.connect();
      const count = await fresh
        .db()
        .collection('tenants')
        .countDocuments({
          tenantId: { $in: ['tenant-alpha', 'tenant-beta'] },
        });
      expect(count).toBe(2);
    } finally {
      await fresh.close();
    }
  });

  it('the search index reconciles: indexes still exist after bootstrap re-runs', async () => {
    for (const uid of ['subjects', 'documents']) {
      const index = await get(`${MEILI_HOST}/indexes/${uid}`, {
        Authorization: `Bearer ${MEILI_KEY}`,
      });
      expect(index.ok).toBe(true);
      const body = (await index.json()) as { primaryKey: string };
      expect(body.primaryKey).toBeTruthy();
    }
  });
});
