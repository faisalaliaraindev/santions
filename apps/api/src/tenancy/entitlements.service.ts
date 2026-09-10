/**
 * FR-15 — tenancy and entitlement seams.
 *
 * Structural seams only, per decision D-007: no plan management, no usage ledger, no overage
 * rules, no provider commercial screens. What exists here is what a later commercial layer
 * would need to attach to without a redesign.
 *
 * Two properties carry real weight:
 *
 *  - **The entitlement version is pinned to every search.** A historical run must be able to
 *    explain why it was permitted and how it was scoped at the time, even after the tenant's
 *    configuration has changed (section 6.3).
 *  - **An entitlement denial is not a rate limit and not a coverage gap** (REL-02). A tenant
 *    without the capability gets a distinct error, and no external source call is made.
 */

import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import { ApiException } from '../common/api-exception.js';

export interface TenantRecord {
  readonly tenantId: string;
  readonly name: string;
  readonly environment: 'sandbox' | 'live';
  readonly mode?: string;
}

export interface EntitlementVersionRecord {
  readonly tenantId: string;
  readonly version: number;
  readonly capabilities: readonly string[];
  readonly environments: readonly ('sandbox' | 'live')[];
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'SUPERSEDED';
  readonly activatedAt: string;
}

export interface PinnedVersions {
  readonly taxonomyVersion: number;
  readonly policyVersion: number;
  readonly entitlementVersion: number;
  readonly bandingRulesVersion: string;
}

/** The only capability in this phase (FR-15). */
export const ADVERSE_MEDIA = 'adverse_media';

@Injectable()
export class EntitlementsService {
  private readonly tenants: Collection<TenantRecord>;
  private readonly entitlements: Collection<EntitlementVersionRecord>;
  private readonly taxonomies: Collection<{ tenantId: string; version: number; status: string }>;
  private readonly policies: Collection<{ tenantId: string; version: number; status: string }>;

  constructor(db: Db) {
    this.tenants = db.collection<TenantRecord>('tenants');
    this.entitlements = db.collection<EntitlementVersionRecord>('tenantEntitlementVersions');
    this.taxonomies = db.collection('taxonomyVersions');
    this.policies = db.collection('policyVersions');
  }

  async findTenant(tenantId: string): Promise<TenantRecord | null> {
    return this.tenants.findOne({ tenantId });
  }

  async activeEntitlement(tenantId: string): Promise<EntitlementVersionRecord | null> {
    return this.entitlements.findOne({ tenantId, status: 'ACTIVE' }, { sort: { version: -1 } });
  }

  /**
   * The capability check. Called in the API **before** a search is created, and again in the
   * worker before any external source work.
   *
   * Throws a distinct error rather than a generic 403 so the panel and integrators can tell an
   * entitlement problem from a permission problem — the operator's next action differs
   * entirely (tests T63, T67).
   */
  async assertCapability(input: {
    readonly tenantId: string;
    readonly capability: string;
    readonly environment: 'sandbox' | 'live';
  }): Promise<EntitlementVersionRecord> {
    const entitlement = await this.activeEntitlement(input.tenantId);

    if (entitlement === null) {
      throw new ApiException(
        'ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN',
        'This tenant has no active entitlement.',
        { internalDetail: `tenant=${input.tenantId} has no ACTIVE entitlement version` },
      );
    }

    if (!entitlement.capabilities.includes(input.capability)) {
      throw new ApiException(
        'ADVERSE_MEDIA_NOT_INCLUDED_IN_PLAN',
        `The capability "${input.capability}" is not included for this tenant.`,
        {
          internalDetail: `tenant=${input.tenantId} entitlement v${String(entitlement.version)} grants [${entitlement.capabilities.join(', ')}]`,
        },
      );
    }

    if (!entitlement.environments.includes(input.environment)) {
      throw new ApiException(
        'SANDBOX_CANNOT_ACCESS_LIVE',
        `This tenant is not entitled to the "${input.environment}" environment.`,
        {
          internalDetail: `tenant=${input.tenantId} entitled to [${entitlement.environments.join(', ')}]`,
        },
      );
    }

    return entitlement;
  }

  /**
   * Collect the versions to pin onto a search.
   *
   * Resolved once, at creation, and stored on the run. Re-reading "the current version" when
   * displaying a historical result is how a report starts explaining itself under rules it
   * never ran on.
   */
  async pinVersions(tenantId: string, entitlementVersion: number): Promise<PinnedVersions> {
    const [taxonomy, policy] = await Promise.all([
      this.taxonomies.findOne({ tenantId, status: 'ACTIVE' }, { sort: { version: -1 } }),
      this.policies.findOne({ tenantId, status: 'ACTIVE' }, { sort: { version: -1 } }),
    ]);

    if (taxonomy === null) {
      throw new ApiException('INVALID_POLICY', 'No active taxonomy version for this tenant.', {
        internalDetail: `tenant=${tenantId}`,
      });
    }
    if (policy === null) {
      throw new ApiException('INVALID_POLICY', 'No active policy version for this tenant.', {
        internalDetail: `tenant=${tenantId}`,
      });
    }

    return {
      taxonomyVersion: taxonomy.version,
      policyVersion: policy.version,
      entitlementVersion,
      // Pinned so a historical finding can still explain which rules produced its band.
      bandingRulesVersion: 'banding-v1',
    };
  }
}
