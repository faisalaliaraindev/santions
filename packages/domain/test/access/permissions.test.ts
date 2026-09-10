/** Section 4.2 roles and permissions. Tests T04, T05, T06, T45, T62. Guards SEC-01. */

import { describe, expect, it } from 'vitest';

import {
  ROLES,
  canApprove,
  decideAccess,
  isBreakGlassActive,
  isRole,
  permissionsForRoles,
  roleHasPermission,
  type Principal,
  type Role,
} from '../../src/access/permissions.js';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    subject: 'user-1',
    kind: 'HUMAN',
    tenantId: 'tenant-alpha',
    roles: ['analyst'],
    scopes: [],
    environment: 'live',
    breakGlass: null,
    ...overrides,
  };
}

describe('the role matrix', () => {
  it('defines all nine roles from section 4.2', () => {
    expect(ROLES).toHaveLength(9);
    expect(isRole('platform_operator')).toBe(true);
    expect(isRole('superuser')).toBe(false);
  });

  it('T06 — platform_operator cannot read customer evidence', () => {
    // The single most important row in the matrix. Operating the infrastructure does not
    // imply permission to read what it holds.
    expect(roleHasPermission('platform_operator', 'evidence:read')).toBe(false);
    expect(roleHasPermission('platform_operator', 'finding:read')).toBe(false);
    expect(roleHasPermission('platform_operator', 'search:read')).toBe(false);
    expect(roleHasPermission('platform_operator', 'platform:operate')).toBe(true);
  });

  it('platform_admin has no evidence access either', () => {
    expect(roleHasPermission('platform_admin', 'evidence:read')).toBe(false);
    expect(roleHasPermission('platform_admin', 'finding:read')).toBe(false);
  });

  it('T06 — a viewer cannot review', () => {
    expect(roleHasPermission('viewer', 'review:create')).toBe(false);
    expect(roleHasPermission('reviewer', 'review:create')).toBe(true);
  });

  it('T06 — an analyst cannot activate a source', () => {
    expect(roleHasPermission('analyst', 'source:approve')).toBe(false);
    expect(roleHasPermission('analyst', 'source:propose')).toBe(false);
    expect(roleHasPermission('source_admin', 'source:approve')).toBe(true);
  });

  it('separates who runs a search from who judges it', () => {
    expect(roleHasPermission('reviewer', 'search:create')).toBe(false);
    expect(roleHasPermission('analyst', 'review:create')).toBe(false);
  });

  it('separates audit read from audit write (SEC-06)', () => {
    expect(roleHasPermission('auditor', 'audit:read')).toBe(true);
    expect(roleHasPermission('auditor', 'audit:write')).toBe(false);
    // An auditor reads audit records, not customer evidence.
    expect(roleHasPermission('auditor', 'evidence:read')).toBe(false);
  });

  it('grants break-glass to nobody except platform_admin', () => {
    const holders = ROLES.filter((r: Role) => roleHasPermission(r, 'breakglass:request'));
    expect(holders).toEqual(['platform_admin']);
  });

  it('unions permissions across multiple roles', () => {
    const granted = permissionsForRoles(['viewer', 'reviewer']);
    expect(granted.has('review:create')).toBe(true);
    expect(granted.has('search:create')).toBe(false);
  });

  it('grants nothing for an empty role list', () => {
    expect(permissionsForRoles([]).size).toBe(0);
  });
});

describe('decideAccess — tenant isolation', () => {
  it('allows a caller to reach their own tenant', () => {
    const decision = decideAccess({
      principal: principal(),
      permission: 'search:read',
      resourceTenantId: 'tenant-alpha',
    });
    expect(decision.allowed).toBe(true);
  });

  it('T04 — denies a caller reaching another tenant, even with the permission', () => {
    const decision = decideAccess({
      principal: principal(),
      permission: 'search:read',
      resourceTenantId: 'tenant-beta',
    });
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.reason).toBe('CROSS_TENANT');
  });

  it('T05 — fails closed when the caller has no tenant context', () => {
    const decision = decideAccess({
      principal: principal({ tenantId: null }),
      permission: 'search:read',
      resourceTenantId: 'tenant-alpha',
    });
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.reason).toBe('NO_TENANT_CONTEXT');
  });

  it('T05 — fails closed when the resource has no tenant context', () => {
    const decision = decideAccess({
      principal: principal(),
      permission: 'search:read',
      resourceTenantId: null,
    });
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.reason).toBe('NO_TENANT_CONTEXT');
  });

  it('checks tenant isolation before permission, so probing is distinguishable in the audit log', () => {
    const decision = decideAccess({
      // No role grants source:approve here, AND it is the wrong tenant. The cross-tenant
      // reason must win, because that is the one worth alerting on.
      principal: principal({ roles: ['viewer'] }),
      permission: 'source:approve',
      resourceTenantId: 'tenant-beta',
    });
    expect(!decision.allowed && decision.reason).toBe('CROSS_TENANT');
  });

  it('gives platform_operator no tenant-scoped access at all', () => {
    const operator = principal({ roles: ['platform_operator'], tenantId: null });
    const health = decideAccess({
      principal: operator,
      permission: 'platform:read_health',
      resourceTenantId: null,
    });
    expect(health.allowed).toBe(true);

    const evidence = decideAccess({
      principal: operator,
      permission: 'evidence:read',
      resourceTenantId: 'tenant-alpha',
    });
    expect(evidence.allowed).toBe(false);
  });

  it('permits cross-tenant access only under a matching break-glass grant', () => {
    const grant = {
      grantId: 'bg-1',
      targetTenantId: 'tenant-beta',
      reason: 'Regulator request 2026-09-10',
      approvedBy: 'user-2',
      expiresAt: '2026-09-11T00:00:00.000Z',
    };

    const covered = decideAccess({
      principal: principal({ roles: ['platform_admin'], breakGlass: grant }),
      permission: 'tenant:manage',
      resourceTenantId: 'tenant-beta',
    });
    expect(covered.allowed).toBe(true);

    // A grant for one tenant does not open another.
    const uncovered = decideAccess({
      principal: principal({ roles: ['platform_admin'], breakGlass: grant }),
      permission: 'tenant:manage',
      resourceTenantId: 'tenant-gamma',
    });
    expect(uncovered.allowed).toBe(false);
  });

  it('treats an expired break-glass grant as no grant', () => {
    const grant = {
      grantId: 'bg-1',
      targetTenantId: 'tenant-beta',
      reason: 'expired',
      approvedBy: 'user-2',
      expiresAt: '2026-09-09T00:00:00.000Z',
    };
    expect(isBreakGlassActive(grant, new Date('2026-09-10T00:00:00.000Z'))).toBe(false);
    expect(isBreakGlassActive(grant, new Date('2026-09-08T00:00:00.000Z'))).toBe(true);
    expect(isBreakGlassActive(null, new Date())).toBe(false);
  });
});

describe('decideAccess — permissions, scopes and environment', () => {
  it('denies a caller whose roles lack the permission', () => {
    const decision = decideAccess({
      principal: principal({ roles: ['viewer'] }),
      permission: 'review:create',
      resourceTenantId: 'tenant-alpha',
    });
    expect(!decision.allowed && decision.reason).toBe('MISSING_PERMISSION');
  });

  it('T62 — a sandbox credential cannot reach live data', () => {
    const decision = decideAccess({
      principal: principal({ environment: 'sandbox' }),
      permission: 'search:create',
      resourceTenantId: 'tenant-alpha',
      resourceEnvironment: 'live',
    });
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.reason).toBe('SANDBOX_CANNOT_ACCESS_LIVE');
  });

  it('lets a sandbox credential reach sandbox data', () => {
    const decision = decideAccess({
      principal: principal({ environment: 'sandbox' }),
      permission: 'search:create',
      resourceTenantId: 'tenant-alpha',
      resourceEnvironment: 'sandbox',
    });
    expect(decision.allowed).toBe(true);
  });

  it('narrows a machine client by scope, and never widens it', () => {
    const machine = principal({ kind: 'MACHINE', scopes: ['search:read'] });

    const withScope = decideAccess({
      principal: machine,
      permission: 'search:read',
      resourceTenantId: 'tenant-alpha',
      requiredScope: 'search:read',
    });
    expect(withScope.allowed).toBe(true);

    const withoutScope = decideAccess({
      principal: machine,
      permission: 'search:create',
      resourceTenantId: 'tenant-alpha',
      requiredScope: 'search:write',
    });
    expect(!withoutScope.allowed && withoutScope.reason).toBe('MISSING_SCOPE');
  });

  it('does not apply machine scopes to a human session', () => {
    const decision = decideAccess({
      principal: principal({ kind: 'HUMAN', scopes: [] }),
      permission: 'search:create',
      resourceTenantId: 'tenant-alpha',
      requiredScope: 'search:write',
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('canApprove — four-eyes', () => {
  it('T45 — a proposer cannot approve their own version', () => {
    const decision = canApprove({
      approver: principal({ subject: 'source.admin', roles: ['source_admin'] }),
      proposedBy: 'source.admin',
      permission: 'source:approve',
    });
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.detail).toMatch(/Four-eyes/);
  });

  it('allows a different authorised user to approve', () => {
    const decision = canApprove({
      approver: principal({ subject: 'source.approver', roles: ['source_admin'] }),
      proposedBy: 'source.admin',
      permission: 'source:approve',
    });
    expect(decision.allowed).toBe(true);
  });

  it('still requires the approve permission', () => {
    const decision = canApprove({
      approver: principal({ subject: 'someone.else', roles: ['analyst'] }),
      proposedBy: 'source.admin',
      permission: 'source:approve',
    });
    expect(decision.allowed).toBe(false);
  });
});
