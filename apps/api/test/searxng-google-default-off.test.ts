/**
 * The regression test for one property: **a governance edit alone cannot activate Google.**
 *
 * # Why this file exists separately from the rest of the engine tests
 *
 * `GOOGLE_NEWS.governanceStatus` is `REFUSED` under D20, and while it stays that way every other
 * assertion about Google passes trivially — `effectiveEnabled` is false because the refusal makes
 * it false, whatever `defaultEnabledForDiscovery` says. That is exactly the problem. The value of
 * the default is **unobservable today** and becomes load-bearing on the single day somebody edits
 * the reading, which is the worst possible moment to discover it was wrong.
 *
 * So these tests do not assert what the system does now. They assert what it will do **after** a
 * change that has not been made, by resolving against a matrix in which Google's reading has been
 * moved to `PERMITTED` and nothing else has. If that one-field edit is enough to make an
 * unconfigured tenant query Google, this file fails.
 *
 * # How the simulation stays honest
 *
 * The resolution rule is not re-implemented here. `vi.doMock` replaces only
 * `engine-governance.js`, and the real `EngineEnablementService` is then imported and asked to
 * resolve for a tenant with no stored rows — the same production method the control API and the
 * connector call. The only thing differing from the live system is the one field whose edit is
 * being simulated. A test that recomputed `integrated && tenantEnabled && status !== 'REFUSED'`
 * itself would keep passing even if that expression were deleted from the service.
 *
 * `vi.resetModules()` with a dynamic import inside each test is what makes the mock apply: these
 * modules are imported statically elsewhere in the suite, so a top-level import here would bind
 * the real matrix before the mock was installed.
 *
 * # What this file is NOT
 *
 * It is not an argument that Google should be permitted, and it does not anticipate that it will
 * be. D20's refusal stands on Google's licence terms; the bounded D20-A diagnostic of 2026-09-22
 * established only that the route is technically usable with original-publisher provenance, which
 * is a fact about infrastructure and never about permission. This file is indifferent to how that
 * decision goes. It guarantees only that whichever way it goes, the *blast radius* of the edit is
 * a single field and not a fleet-wide activation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from 'mongodb';

import type {
  EngineEnablementService as EngineEnablementServiceType,
  StoredEngineSetting,
} from '../src/sources/searxng/engine-enablement.service.js';
import {
  ALL_ENGINES,
  ENGINE_GOVERNANCE,
  type EngineGovernanceRecord,
} from '../src/sources/searxng/engine-governance.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');

/** The in-memory collection. Reads apply the tenant filter, so a lost scope fails here (SEC-01). */
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
      deleteOne: () => Promise.resolve({ acknowledged: true }),
    }),
  } as unknown as Db;
}

/**
 * The real matrix with Google's reading moved to `PERMITTED`, and **nothing else touched**.
 *
 * Built by spreading the real record rather than by writing a fresh one, so the simulated future
 * differs from today in exactly one field. A hand-written stand-in would drift from the real
 * matrix and quietly stop testing it.
 */
function matrixWithGooglePermitted(): Record<string, EngineGovernanceRecord> {
  return {
    ...ENGINE_GOVERNANCE,
    GOOGLE_NEWS: {
      ...ENGINE_GOVERNANCE.GOOGLE_NEWS,
      governanceStatus: 'PERMITTED',
      decisionId: 'D20-SIMULATED-REOPENING',
      reviewedBy: 'simulated, for this test only',
    },
  };
}

/**
 * The real service, bound to the simulated matrix.
 *
 * The mock reproduces every export the service imports — `ENGINE_GOVERNANCE`, `engineRecord`,
 * `integratedEngines` — from the simulated matrix. The service reads the default through
 * `integratedEngines()`, so a mock that replaced only the constant would leave it using the real
 * defaults and make this whole file vacuous.
 */
async function serviceUnderSimulatedPermission(
  rows: StoredEngineSetting[],
): Promise<EngineEnablementServiceType> {
  vi.resetModules();
  const simulated = matrixWithGooglePermitted();

  vi.doMock('../src/sources/searxng/engine-governance.js', () => ({
    ENGINE_GOVERNANCE: simulated,
    ALL_ENGINES: Object.keys(simulated),
    integratedEngines: () => Object.values(simulated).filter((record) => record.integrated),
    engineRecord: (engine: string) => simulated[engine] ?? null,
    engineFromSearxngName: (name: string) =>
      Object.keys(simulated).find(
        (key) => simulated[key]?.searxngEngineName.toLowerCase() === name.trim().toLowerCase(),
      ) ?? null,
  }));

  const module = await import('../src/sources/searxng/engine-enablement.service.js');
  return new module.EngineEnablementService(dbWith(rows));
}

/** The real service against the real matrix, imported after a reset so no mock is in force. */
async function realService(rows: StoredEngineSetting[]): Promise<EngineEnablementServiceType> {
  const module = await import('../src/sources/searxng/engine-enablement.service.js');
  return new module.EngineEnablementService(dbWith(rows));
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../src/sources/searxng/engine-governance.js');
});

describe('the Google default is off, and it is the only one', () => {
  it('records GOOGLE_NEWS as the single engine defaulting to off', () => {
    expect(ENGINE_GOVERNANCE.GOOGLE_NEWS.defaultEnabledForDiscovery).toBe(false);

    const off = ALL_ENGINES.filter(
      (engine) => !ENGINE_GOVERNANCE[engine].defaultEnabledForDiscovery,
    );
    // Exactly one. If a second engine is ever defaulted off, that is a decision belonging in the
    // file header beside Google's, not a quiet edit.
    expect(off).toEqual(['GOOGLE_NEWS']);
  });

  it('keeps the refusal and the default as two separate facts', () => {
    // Neither is derived from the other. The refusal is a reading of Google's terms; the default
    // is a blast-radius control. A reader who collapses them will delete one as redundant.
    expect(ENGINE_GOVERNANCE.GOOGLE_NEWS.governanceStatus).toBe('REFUSED');
    expect(ENGINE_GOVERNANCE.GOOGLE_NEWS.integrated).toBe(true);
    expect(ENGINE_GOVERNANCE.GOOGLE_NEWS.decisionId).toBe('D20');
  });

  it('still reports Google to every tenant rather than hiding it', async () => {
    const engines = await (await realService([])).resolveFor('tenant-1');
    const google = engines.find((engine) => engine.engine === 'GOOGLE_NEWS');

    // Off is not absent. The whole matrix resolves, so "what happened to Google?" has an answer.
    expect(engines).toHaveLength(ALL_ENGINES.length);
    expect(google?.tenantEnabled).toBe(false);
    expect(google?.effectiveEnabled).toBe(false);
    expect(google?.governanceStatus).toBe('REFUSED');
    expect(google?.evidenceNote.length).toBeGreaterThan(80);
  });
});

describe('a governance-state edit alone cannot globally activate Google', () => {
  it('leaves an unconfigured tenant NOT querying Google after the refusal is lifted', async () => {
    const service = await serviceUnderSimulatedPermission([]);
    const engines = await service.resolveFor('tenant-with-no-preferences');
    const google = engines.find((engine) => engine.engine === 'GOOGLE_NEWS');

    // The simulated edit landed: the reading says PERMITTED, so the execution gate D20 held shut
    // is now open.
    expect(google?.governanceStatus).toBe('PERMITTED');

    // And Google is still queried by nobody, because no tenant asked for it. THIS is the
    // property. Were the default `true`, both of these would now be `true` for every tenant on
    // the platform as a result of that one edit.
    expect(google?.tenantEnabled).toBe(false);
    expect(google?.effectiveEnabled).toBe(false);
    expect(google?.configuredByTenant).toBe(false);
  });

  it('does not disturb the five engines D21 permitted', async () => {
    const service = await serviceUnderSimulatedPermission([]);
    const engines = await service.resolveFor('tenant-with-no-preferences');

    // The control is narrow on purpose. It removes Google from an unconfigured tenant's engine
    // set and nothing else — a fix that also silenced the working engines would be a regression
    // dressed as caution.
    for (const engine of engines.filter((row) => row.engine !== 'GOOGLE_NEWS')) {
      expect(engine.effectiveEnabled).toBe(true);
    }
    expect(engines.filter((engine) => engine.effectiveEnabled)).toHaveLength(ALL_ENGINES.length - 1);
  });

  it('activates Google only when a named tenant switches it on, one tenant at a time', async () => {
    const rows: StoredEngineSetting[] = [];
    const service = await serviceUnderSimulatedPermission(rows);

    const resolved = await service.setFor({
      tenantId: 'tenant-alpha',
      engine: 'GOOGLE_NEWS',
      enabled: true,
      changedBy: 'user-a',
      reason: 'Reviewed the reopened decision and accepted it for our searches.',
      now: NOW,
    });

    // This is the act that activates it: an API call by a named person with a reason, not a code
    // edit, and it is the second of the two acts rather than a consequence of the first.
    expect(resolved?.tenantEnabled).toBe(true);
    expect(resolved?.effectiveEnabled).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.changedBy).toBe('user-a');

    // And it reaches exactly that one tenant. Their neighbour is unaffected.
    const neighbour = (await service.resolveFor('tenant-beta')).find(
      (engine) => engine.engine === 'GOOGLE_NEWS',
    );
    expect(neighbour?.effectiveEnabled).toBe(false);
  });

  it('cannot be activated by a tenant switch while the refusal stands', async () => {
    // The other direction, against the REAL matrix: the two gates are independent, so neither
    // alone opens the path. The tenant switch is the act available today, and it does not work
    // either.
    const resolved = await (
      await realService([])
    ).setFor({
      tenantId: 'tenant-alpha',
      engine: 'GOOGLE_NEWS',
      enabled: true,
      changedBy: 'user-a',
      reason: 'We would like Google.',
      now: NOW,
    });

    expect(resolved?.tenantEnabled).toBe(true);
    expect(resolved?.governanceStatus).toBe('REFUSED');
    expect(resolved?.effectiveEnabled).toBe(false);
  });
});
