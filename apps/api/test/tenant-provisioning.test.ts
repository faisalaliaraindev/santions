/**
 * I1 — what a provisioned tenant is made of, and who may hold a live credential.
 *
 * Both of the things under test here are pure, and that is the point of their being pure: the
 * shape a customer is provisioned with, and the decision about live access, can be asserted on
 * a clean checkout with no database, no stack and no clock.
 */

import { describe, expect, it } from 'vitest';

import { ADVERSE_CATEGORIES } from '@adverse-search/domain';

import {
  CREATED_VIA_SIGNUP,
  decideLiveAccess,
  LIVE_ACCESS_EMAIL_NOT_VERIFIED,
} from '../src/tenancy/live-access.js';
import {
  buildTenantProvisioning,
  DEFAULT_ENABLED_COUNTRIES,
  DEFAULT_EVIDENCE_RETENTION_DAYS,
  INITIAL_VERSION,
} from '../src/tenancy/provisioning.js';

const NOW = new Date('2026-09-16T12:00:00.000Z');

function provision(overrides: Partial<Parameters<typeof buildTenantProvisioning>[0]> = {}) {
  return buildTenantProvisioning({
    tenantId: 'tenant-under-test',
    name: 'Acme Compliance',
    environments: ['sandbox', 'live'],
    provisionedBy: 'signup',
    decisionRef: 'test',
    now: NOW,
    ...overrides,
  });
}

describe('I1 — a provisioned tenant has all four records', () => {
  it('builds the tenant, entitlement, taxonomy and policy together', () => {
    const provisioned = provision();

    // Every one of the four, at version 1, under the same tenant id. A tenant missing any of
    // them fails later with an error that reads like a defect in search rather than like a
    // signup that stopped halfway.
    expect(provisioned.tenant.tenantId).toBe('tenant-under-test');
    expect(provisioned.entitlement.tenantId).toBe('tenant-under-test');
    expect(provisioned.taxonomy.tenantId).toBe('tenant-under-test');
    expect(provisioned.policy.tenantId).toBe('tenant-under-test');

    expect(provisioned.entitlement.version).toBe(INITIAL_VERSION);
    expect(provisioned.taxonomy.version).toBe(INITIAL_VERSION);
    expect(provisioned.policy.version).toBe(INITIAL_VERSION);
  });

  it('activates all three versioned records, because a PROPOSED one is not usable', () => {
    const provisioned = provision();

    // `activeEntitlement` and `pinVersions` both filter on ACTIVE. A version left PROPOSED is a
    // tenant whose first search is refused with INVALID_POLICY.
    expect(provisioned.entitlement.status).toBe('ACTIVE');
    expect(provisioned.taxonomy.status).toBe('ACTIVE');
    expect(provisioned.policy.status).toBe('ACTIVE');
    expect(provisioned.entitlement.activatedAt).toBe(NOW.toISOString());
  });

  it('enables all seventeen FR-03 categories, from the domain list rather than a copy', () => {
    const provisioned = provision();

    expect(provisioned.taxonomy.categories).toHaveLength(ADVERSE_CATEGORIES.length);
    expect(provisioned.taxonomy.categories.map((entry) => entry.category)).toEqual([
      ...ADVERSE_CATEGORIES,
    ]);
    for (const entry of provisioned.taxonomy.categories) {
      expect(entry.enabledCountries).toEqual([...DEFAULT_ENABLED_COUNTRIES]);
    }
  });

  it('declares every language unmeasured, so provisioning cannot enable one by accident', () => {
    // FR-03: a language is enabled only with a measured recall figure from the evaluation set.
    // None is measured, so none may arrive carrying a number here.
    for (const language of provision().taxonomy.languages) {
      expect(language.measuredRecall).toBeNull();
      expect(language.measuredByEvaluationRunId).toBeNull();
    }
  });

  it('withholds the FR-02 historical scope unless it is asked for', () => {
    expect(provision().policy.historicalScopeApproved).toBe(false);
    expect(provision({ historicalScopeApproved: true }).policy.historicalScopeApproved).toBe(true);
  });

  it('carries the retention and traversal bounds the pipeline reads', () => {
    const policy = provision().policy;

    expect(policy.evidenceRetentionDays).toBe(DEFAULT_EVIDENCE_RETENTION_DAYS);
    expect(policy.queryPlanCap).toBeGreaterThan(0);
    expect(policy.associationBounds.maxEdgesPerSnapshot).toBeGreaterThan(0);
    // D2 is open: no source has been measured, so there is no archive horizon to state.
    expect(policy.archiveHorizon).toBeNull();
  });

  it('grants exactly the environments it was told to, and does not widen them', () => {
    expect(provision({ environments: ['sandbox'] }).entitlement.environments).toEqual(['sandbox']);
    expect(provision().entitlement.environments).toEqual(['sandbox', 'live']);
  });

  it('is pure: the same input builds the same records', () => {
    expect(provision()).toEqual(provision());
  });
});

describe('I1 — who may hold a live credential', () => {
  const liveEntitlement = { environments: ['sandbox', 'live'] };
  const sandboxOnly = { environments: ['sandbox'] };

  it('refuses a tenant whose entitlement does not include live', () => {
    const decision = decideLiveAccess({
      tenant: { createdVia: CREATED_VIA_SIGNUP, emailVerifiedAt: new Date().toISOString() },
      entitlement: sandboxOnly,
    });

    // Entitlement first, deliberately: telling an unentitled tenant to verify their email
    // describes a route to live access that verifying will not open.
    expect(decision.granted).toBe(false);
    expect(decision.blockedBy).toBe('NOT_ENTITLED');
  });

  it('holds a self-signed-up tenant until the contact address is confirmed (D-052)', () => {
    const decision = decideLiveAccess({
      tenant: { createdVia: CREATED_VIA_SIGNUP, emailVerifiedAt: null },
      entitlement: liveEntitlement,
    });

    expect(decision.granted).toBe(false);
    expect(decision.blockedBy).toBe('EMAIL_NOT_VERIFIED');
    expect(decision.detail).toBe(LIVE_ACCESS_EMAIL_NOT_VERIFIED);
  });

  it('admits that tenant once the address is confirmed', () => {
    const decision = decideLiveAccess({
      tenant: { createdVia: CREATED_VIA_SIGNUP, emailVerifiedAt: '2026-09-16T12:00:00.000Z' },
      entitlement: liveEntitlement,
    });

    expect(decision.granted).toBe(true);
    expect(decision.blockedBy).toBeNull();
  });

  it('does not take live access away from a tenant provisioned before the field existed', () => {
    // The record a hand-onboarded tenant actually has: no `createdVia`, no `emailVerifiedAt`.
    // Reading that absence as "not verified" would refuse every existing live customer on
    // deploy, with no verification email to re-send for an address never collected.
    const decision = decideLiveAccess({
      tenant: { createdVia: undefined, emailVerifiedAt: undefined },
      entitlement: liveEntitlement,
    });

    expect(decision.granted).toBe(true);
  });

  it('refuses when there is no tenant record at all', () => {
    // Not an academic case: a credential can outlive the tenant it was issued for. Whatever
    // that state is, it is not a reason to hand out a live credential.
    expect(decideLiveAccess({ tenant: null, entitlement: liveEntitlement }).granted).toBe(false);
    expect(decideLiveAccess({ tenant: {}, entitlement: null }).granted).toBe(false);
  });
});
