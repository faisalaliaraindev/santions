/**
 * Section 4.2 — roles and permissions.
 *
 * This is pure policy, so it lives in the domain package: it is the same decision whether it
 * is made by an HTTP guard, a worker, an export job or a webhook dispatcher, and having one
 * place to make it is the only way SEC-01 stays true across all of them.
 *
 * Two rules are load-bearing and easy to lose to convenience:
 *
 *  - **`platform_operator` cannot read customer evidence.** Operating the infrastructure does
 *    not imply permission to read what it holds (test T06). The role exists to run the
 *    platform, and it is deliberately not a convenience alias for administrator.
 *  - **There is no implicit super-admin tenant bypass.** Cross-tenant access requires an
 *    explicit break-glass grant with a reason and an audit record.
 */

export const ROLES = [
  'viewer',
  'analyst',
  'reviewer',
  'tenant_admin',
  'source_admin',
  'taxonomy_admin',
  'auditor',
  'platform_operator',
  'platform_admin',
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Every permission the service checks. Enumerated explicitly rather than derived from route
 * names, so adding a route cannot silently create an unguarded capability.
 */
export const PERMISSIONS = [
  // Reading results
  'search:read',
  'finding:read',
  'coverage:read',
  'association:read',
  // Evidence is separated from findings on purpose: a finding is a summary, evidence is the
  // publisher's text about an identifiable person.
  'evidence:read',
  // Running work
  'search:create',
  'search:cancel',
  'search:refresh',
  // Review
  'review:create',
  'event:split_merge',
  // Export is separate from read: exporting removes data from the service's controls.
  'export:create',
  'export:read',
  // Administration
  'source:propose',
  'source:approve',
  'taxonomy:propose',
  'taxonomy:approve',
  'policy:propose',
  'policy:approve',
  'tenant:manage',
  'client:manage',
  'webhook:manage',
  'apikey:manage',
  'entitlement:manage',
  // Audit read and write are separately controlled (SEC-06).
  'audit:read',
  'audit:write',
  // Platform operation
  'platform:operate',
  'platform:read_health',
  // Break-glass cross-tenant access. Never implied by any other permission.
  'breakglass:request',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const READ_RESULTS: readonly Permission[] = [
  'search:read',
  'finding:read',
  'coverage:read',
  'association:read',
];

/**
 * The role-to-permission matrix.
 *
 * Deliberately flat and explicit rather than hierarchical. A hierarchy invites "admin implies
 * everything", which is exactly how `platform_operator` would acquire `evidence:read`.
 */
const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  viewer: [...READ_RESULTS],

  analyst: [
    ...READ_RESULTS,
    'evidence:read',
    'search:create',
    'search:cancel',
    'search:refresh',
    'export:create',
    'export:read',
  ],

  // A reviewer records reasoned decisions. Note this does NOT include search:create — the
  // separation keeps "who ran it" and "who judged it" distinguishable in the audit trail.
  reviewer: [
    ...READ_RESULTS,
    'evidence:read',
    'review:create',
    'event:split_merge',
    'export:create',
    'export:read',
  ],

  tenant_admin: [
    ...READ_RESULTS,
    'tenant:manage',
    'client:manage',
    'webhook:manage',
    'apikey:manage',
    'audit:read',
  ],

  // Four-eyes: a source_admin may both propose and approve, but never the same version. That
  // constraint is enforced in `canApprove` below, not by splitting the role.
  source_admin: [
    ...READ_RESULTS,
    'source:propose',
    'source:approve',
    'policy:propose',
    'policy:approve',
  ],

  taxonomy_admin: [...READ_RESULTS, 'taxonomy:propose', 'taxonomy:approve'],

  auditor: ['audit:read', 'coverage:read'],

  // Runs the platform. Cannot read a single customer finding or evidence document (T06).
  platform_operator: ['platform:operate', 'platform:read_health'],

  // Provider-side administration. Still no evidence access, and no implicit cross-tenant
  // reach — cross-tenant work goes through an audited break-glass grant.
  platform_admin: [
    'platform:read_health',
    'tenant:manage',
    'entitlement:manage',
    'client:manage',
    'apikey:manage',
    'audit:read',
    'breakglass:request',
  ],
};

export function permissionsForRoles(roles: readonly Role[]): ReadonlySet<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      granted.add(permission);
    }
  }
  return granted;
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * The authenticated caller, as the service understands them after token validation.
 *
 * `tenantId` comes from a validated token claim bound to authenticated entitlement — never
 * from a client-supplied header (SEC-01, test T05).
 */
export interface Principal {
  readonly subject: string;
  readonly kind: 'HUMAN' | 'MACHINE';
  readonly tenantId: string | null;
  readonly roles: readonly Role[];
  /** Scopes on a machine token. Narrow a machine client below its roles, never above. */
  readonly scopes: readonly string[];
  /** `sandbox` keys can never reach live searches or live evidence (FR-15). */
  readonly environment: 'sandbox' | 'live';
  /** Present only during an approved, time-bounded break-glass grant. */
  readonly breakGlass: BreakGlassGrant | null;
}

export interface BreakGlassGrant {
  readonly grantId: string;
  readonly targetTenantId: string;
  readonly reason: string;
  readonly approvedBy: string;
  readonly expiresAt: string;
}

export type AccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: AccessDenialReason; readonly detail: string };

export type AccessDenialReason =
  | 'NO_TENANT_CONTEXT'
  | 'CROSS_TENANT'
  | 'MISSING_PERMISSION'
  | 'MISSING_SCOPE'
  | 'SANDBOX_CANNOT_ACCESS_LIVE';

const ALLOWED: AccessDecision = { allowed: true };

function deny(reason: AccessDenialReason, detail: string): AccessDecision {
  return { allowed: false, reason, detail };
}

export interface AccessRequest {
  readonly principal: Principal;
  readonly permission: Permission;
  /** The tenant that owns the resource, taken from the persisted record — never from input. */
  readonly resourceTenantId: string | null;
  /** The environment the resource belongs to. */
  readonly resourceEnvironment?: 'sandbox' | 'live';
  /** Required scope for machine callers, when the route declares one. */
  readonly requiredScope?: string;
}

/**
 * The single authorisation decision.
 *
 * Order matters. Tenant isolation is checked before permissions, because a caller who lacks
 * the permission entirely and a caller reaching across tenants are different failures, and
 * conflating them makes cross-tenant probing harder to detect in the audit log.
 */
export function decideAccess(request: AccessRequest): AccessDecision {
  const { principal, permission, resourceTenantId } = request;

  // Platform-level permissions are not tenant-scoped.
  const isPlatformPermission =
    permission === 'platform:operate' || permission === 'platform:read_health';

  if (!isPlatformPermission) {
    // Missing tenant context fails closed (SEC-01). It is never treated as "any tenant".
    if (resourceTenantId === null) {
      return deny('NO_TENANT_CONTEXT', 'The resource carries no tenant context.');
    }
    if (principal.tenantId === null) {
      return deny('NO_TENANT_CONTEXT', 'The caller carries no authenticated tenant context.');
    }

    if (principal.tenantId !== resourceTenantId) {
      const grant = principal.breakGlass;
      const grantCovers = grant !== null && grant.targetTenantId === resourceTenantId;
      if (!grantCovers) {
        return deny(
          'CROSS_TENANT',
          `Caller is bound to ${principal.tenantId}; the resource belongs to ${resourceTenantId}.`,
        );
      }
    }
  }

  // A sandbox credential can never reach live data, whatever its roles say (FR-15, test T62).
  if (principal.environment === 'sandbox' && request.resourceEnvironment === 'live') {
    return deny(
      'SANDBOX_CANNOT_ACCESS_LIVE',
      'A sandbox credential cannot run live searches or access live evidence.',
    );
  }

  if (!permissionsForRoles(principal.roles).has(permission)) {
    return deny(
      'MISSING_PERMISSION',
      `None of the caller's roles (${principal.roles.join(', ') || 'none'}) grants ${permission}.`,
    );
  }

  // Scopes narrow a machine client below its roles. They never widen it.
  if (
    request.requiredScope !== undefined &&
    principal.kind === 'MACHINE' &&
    !principal.scopes.includes(request.requiredScope)
  ) {
    return deny('MISSING_SCOPE', `Machine client token lacks scope ${request.requiredScope}.`);
  }

  return ALLOWED;
}

/**
 * Four-eyes approval (section 4.2, test T45).
 *
 * The proposer and the approver must be different authorised users. Enforced on identity, not
 * on role, because a single `source_admin` holding both permissions is normal and expected —
 * what is forbidden is one person doing both to the same version.
 */
export function canApprove(input: {
  readonly approver: Principal;
  readonly proposedBy: string;
  readonly permission: Extract<Permission, `${string}:approve`>;
}): AccessDecision {
  if (input.approver.subject === input.proposedBy) {
    return deny(
      'MISSING_PERMISSION',
      'Four-eyes: the proposer of a version may not approve it. A different authorised user must.',
    );
  }
  if (!permissionsForRoles(input.approver.roles).has(input.permission)) {
    return deny('MISSING_PERMISSION', `Caller lacks ${input.permission}.`);
  }
  return ALLOWED;
}

/** True when a break-glass grant is currently usable. Expiry is checked against a passed clock. */
export function isBreakGlassActive(grant: BreakGlassGrant | null, asOf: Date): boolean {
  if (grant === null) {
    return false;
  }
  const expires = Date.parse(grant.expiresAt);
  return !Number.isNaN(expires) && expires > asOf.getTime();
}
