/**
 * The per-tenant engine control surface — the resolution rules behind the API.
 *
 * `EngineEnablementService` is where a customer preference and a platform legal reading meet, and
 * the whole value of the design is that they meet **without merging**. Four properties carry it:
 *
 * 1. **Two axes stay two.** A tenant's switch never writes `governanceStatus`, and nothing
 *    computes one from the other. An engine can be ON with a reading of `REFUSED`, and that
 *    disagreement is reported rather than resolved by quietly rewriting the reading.
 * 2. **Every engine is always present.** Resolving returns the whole matrix, switched off ones
 *    included, so "what happened to Google?" has an answer at the API as well as in the
 *    diagnostics.
 * 3. **The default is the platform's, the override is the tenant's.** A tenant with no row gets
 *    the default and says so (`configuredByTenant: false`); a tenant with a row gets their row.
 * 4. **The row is a decision, so it names somebody.** `changedBy` and `reason` are required, and
 *    the reading at the time is stored rather than looked up later — so a reading that hardens
 *    afterwards does not retroactively make an earlier change look like an override.
 *
 * These run against the pure resolution logic and a small in-memory stand-in for the collection.
 * The HTTP surface, the permissions and the audit entry are exercised by the e2e suite; what is
 * here is the part that decides what a search will actually do.
 */

import { describe, expect, it } from 'vitest';

import type { Db } from 'mongodb';

import {
  EngineEnablementService,
  defaultResolvedEngines,
  ENGINE_NAMES,
  type StoredEngineSetting,
} from '../src/sources/searxng/engine-enablement.service.js';
import { ALL_ENGINES, ENGINE_GOVERNANCE } from '../src/sources/searxng/engine-governance.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');

/**
 * The collection, in memory.
 *
 * Small enough to be obviously correct, and it keeps the tenant filter honest: `find` applies it
 * rather than returning everything, so a service that forgot to scope would fail here rather than
 * passing and leaking across tenants in production (SEC-01).
 */
function dbWith(rows: StoredEngineSetting[]): Db {
  return {
    collection: () => ({
      find: (filter: { tenantId: string }) => ({
        toArray: () => Promise.resolve(rows.filter((row) => row.tenantId === filter.tenantId)),
      }),
      createIndex: () => Promise.resolve('ok'),
      updateOne: (
        filter: { tenantId: string; engine: string },
        update: { $set: StoredEngineSetting },
      ) => {
        const index = rows.findIndex(
          (row) => row.tenantId === filter.tenantId && row.engine === filter.engine,
        );
        if (index === -1) {
          rows.push(update.$set);
        } else {
          rows[index] = update.$set;
        }
        return Promise.resolve({ acknowledged: true });
      },
      deleteOne: (filter: { tenantId: string; engine: string }) => {
        const index = rows.findIndex(
          (row) => row.tenantId === filter.tenantId && row.engine === filter.engine,
        );
        if (index !== -1) {
          rows.splice(index, 1);
        }
        return Promise.resolve({ acknowledged: true });
      },
    }),
  } as unknown as Db;
}

describe('the default applies until a tenant sets something', () => {
  it('returns every integrated engine, on or off', async () => {
    const service = new EngineEnablementService(dbWith([]));
    const engines = await service.resolveFor('tenant-1');

    // Six rows, always. An engine missing from this list is an engine a customer cannot discover
    // and an operator cannot explain.
    expect(engines).toHaveLength(ALL_ENGINES.length);
    expect(engines.map((engine) => engine.engine).toSorted()).toEqual([...ALL_ENGINES].toSorted());
    expect(engines.every((engine) => engine.integrated)).toBe(true);
  });

  it('marks an unconfigured engine as the platform default rather than a tenant choice', async () => {
    const service = new EngineEnablementService(dbWith([]));
    const engines = await service.resolveFor('tenant-1');

    for (const engine of engines) {
      expect(engine.configuredByTenant).toBe(false);
      expect(engine.tenantEnabled).toBe(engine.defaultEnabledForDiscovery);
      expect(engine.effectiveEnabled).toBe(
        engine.integrated &&
          engine.defaultEnabledForDiscovery &&
          engine.governanceStatus !== 'REFUSED',
      );
      // Absent rather than nulled: "nobody has set this" and "somebody set it and we lost their
      // name" are different facts.
      expect(engine.changedBy).toBeUndefined();
      expect(engine.reason).toBeUndefined();
    }
  });

  it('agrees with the pure default helper', async () => {
    // Two code paths produce this shape — the service for a real tenant, and
    // `defaultResolvedEngines` for callers with no database. They must not drift.
    const service = new EngineEnablementService(dbWith([]));
    const fromService = await service.resolveFor('tenant-1');
    expect(fromService).toEqual(defaultResolvedEngines());
  });
});

describe('a tenant setting overrides the default, and only for that tenant', () => {
  it('applies one tenant’s switch without touching another’s', async () => {
    const rows: StoredEngineSetting[] = [];
    const service = new EngineEnablementService(dbWith(rows));

    await service.setFor({
      tenantId: 'tenant-1',
      engine: 'REUTERS',
      enabled: false,
      changedBy: 'user-a',
      reason: 'We only want wire coverage we have licensed separately.',
      now: NOW,
    });

    const one = await service.resolveFor('tenant-1');
    const two = await service.resolveFor('tenant-2');

    expect(one.find((engine) => engine.engine === 'REUTERS')?.tenantEnabled).toBe(false);
    expect(one.find((engine) => engine.engine === 'REUTERS')?.configuredByTenant).toBe(true);
    // The other tenant is untouched and still on the platform default.
    expect(two.find((engine) => engine.engine === 'REUTERS')?.tenantEnabled).toBe(
      ENGINE_GOVERNANCE.REUTERS.defaultEnabledForDiscovery,
    );
    expect(two.find((engine) => engine.engine === 'REUTERS')?.configuredByTenant).toBe(false);
  });

  it('records who changed it and why, and what they knew at the time', async () => {
    const rows: StoredEngineSetting[] = [];
    const service = new EngineEnablementService(dbWith(rows));

    await service.setFor({
      tenantId: 'tenant-1',
      engine: 'BING_NEWS',
      enabled: false,
      changedBy: 'user-a',
      reason: 'Too much syndicated noise.',
      now: NOW,
    });

    const row = rows[0];
    expect(row?.changedBy).toBe('user-a');
    expect(row?.reason).toBe('Too much syndicated noise.');
    // The reading at the moment of the change, stored rather than looked up later. If the
    // reading hardens to REFUSED afterwards, this row correctly records that they did not
    // override a refusal — they acted before there was one. BING_NEWS reads PERMITTED since
    // the D21 approval of 2026-09-22; what is asserted here is that the row snapshots
    // whatever the reading *was*, not any particular value of it.
    expect(row?.acknowledgedGovernanceStatus).toBe('PERMITTED');
  });

  it('returns an engine to the platform default when the setting is cleared', async () => {
    const rows: StoredEngineSetting[] = [];
    const service = new EngineEnablementService(dbWith(rows));

    await service.setFor({
      tenantId: 'tenant-1',
      engine: 'WIKINEWS',
      enabled: false,
      changedBy: 'user-a',
      reason: 'Not useful for our subjects.',
      now: NOW,
    });
    expect(
      (await service.resolveFor('tenant-1')).find((e) => e.engine === 'WIKINEWS')?.tenantEnabled,
    ).toBe(false);

    const cleared = await service.clearFor({ tenantId: 'tenant-1', engine: 'WIKINEWS' });
    expect(cleared?.configuredByTenant).toBe(false);
    expect(cleared?.tenantEnabled).toBe(ENGINE_GOVERNANCE.WIKINEWS.defaultEnabledForDiscovery);
  });

  it('refuses an engine the matrix does not integrate', async () => {
    // A stored row for a name nothing can query would be a setting that silently does nothing,
    // which is worse than an error.
    const service = new EngineEnablementService(dbWith([]));
    expect(
      await service.setFor({
        tenantId: 'tenant-1',
        engine: 'YANDEX_NEWS',
        enabled: true,
        changedBy: 'user-a',
        reason: 'x',
        now: NOW,
      }),
    ).toBeNull();
    expect(await service.clearFor({ tenantId: 'tenant-1', engine: 'YANDEX_NEWS' })).toBeNull();
  });
});

describe('the switch never rewrites the governance reading', () => {
  it('leaves the reading untouched when a tenant switches a refused engine on', async () => {
    const rows: StoredEngineSetting[] = [];
    const service = new EngineEnablementService(dbWith(rows));

    const resolved = await service.setFor({
      tenantId: 'tenant-1',
      engine: 'GOOGLE_NEWS',
      enabled: true,
      changedBy: 'user-a',
      reason: 'Accepted commercially; see our own counsel note.',
      now: NOW,
    });

    // The tenant switch moved. The reading did not, and the execution gate remains closed.
    expect(resolved?.tenantEnabled).toBe(true);
    expect(resolved?.effectiveEnabled).toBe(false);
    expect(resolved?.governanceStatus).toBe('REFUSED');
    expect(resolved?.decisionId).toBe('D20');
    expect(ENGINE_GOVERNANCE.GOOGLE_NEWS.governanceStatus).toBe('REFUSED');
  });

  it('allows a pending engine to be effectively enabled without rewriting D21', async () => {
    const service = new EngineEnablementService(dbWith([]));
    const resolved = await service.setFor({
      tenantId: 'tenant-1',
      engine: 'WIKINEWS',
      enabled: true,
      changedBy: 'user-a',
      reason: 'Documented API, CC BY content.',
      now: NOW,
    });
    // WIKINEWS reads PERMITTED under D21 (2026-09-22). Unlike REFUSED, it does not close the
    // execution gate, so an enabled tenant switch resolves to effectiveEnabled.
    expect(resolved?.governanceStatus).toBe('PERMITTED');
    expect(resolved?.tenantEnabled).toBe(true);
    expect(resolved?.effectiveEnabled).toBe(true);
  });

  it('keeps a refused engine disabled when its tenant switch is off', async () => {
    const service = new EngineEnablementService(dbWith([]));
    const resolved = await service.setFor({
      tenantId: 'tenant-1',
      engine: 'GOOGLE_NEWS',
      enabled: false,
      changedBy: 'user-a',
      reason: 'D20 says no.',
      now: NOW,
    });
    expect(resolved?.tenantEnabled).toBe(false);
    expect(resolved?.effectiveEnabled).toBe(false);
  });

  it('carries the evidence note through, so the switch is never shown without context', async () => {
    const service = new EngineEnablementService(dbWith([]));
    const engines = await service.resolveFor('tenant-1');
    for (const engine of engines) {
      // A control surface that showed only on/off would let somebody enable an engine without
      // ever being shown what is known about it.
      expect(engine.evidenceNote.length).toBeGreaterThan(80);
      expect(engine.decisionId).not.toBe('');
      expect(typeof engine.usesPublisherDocumentedApi).toBe('boolean');
    }
  });
});

describe('the contract and the matrix name the same engines', () => {
  it('exports exactly the engines the matrix integrates', () => {
    // A schema enum that drifted from the matrix would accept an engine nothing can query, or
    // refuse one that works. Either way the control API would be lying about its own surface.
    expect([...ENGINE_NAMES].toSorted()).toEqual([...ALL_ENGINES].toSorted());
  });
});
