/**
 * Reading a tenant's **pinned** policy version.
 *
 * Phase D step D4. The policy version is where per-tenant operating rules live — evidence
 * retention (D-012), the query-plan cap, whether a historical directorship scope is approved,
 * and the FR-02 traversal bounds. It is versioned, goes through the D1 four-eyes approval
 * lifecycle, and is **pinned onto the run** by `pinVersions`.
 *
 * That pinning is the point of this service existing separately from "read the active policy".
 * A run must read the policy version it was created under, not the current one. Otherwise a
 * bound raised in October changes what a search that ran in March is reported to have covered,
 * and the truncation note on that old report stops matching the graph beside it. The same
 * reasoning already applies to the taxonomy: FR-03 requires a historical search to keep
 * explaining itself under the version it ran on.
 *
 * `loadPinned` therefore takes a version number and will not fall back to the active one. A
 * missing pinned version is an error, not a cue to substitute something newer.
 */

import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import { resolveGraphBounds, type GraphBounds } from '@erly/adverse-domain';

import { ApiException } from '../common/api-exception.js';

/** Matches the seeded policy. Used when a version declares none or declares nonsense. */
export const DEFAULT_QUERY_PLAN_CAP = 200;

/**
 * The policy fields this service reads.
 *
 * Deliberately partial. A policy version carries more than this, and listing only what is read
 * keeps it obvious which fields are load-bearing — the same reason `source-content.ts` names
 * the load-bearing registry fields.
 */
interface PolicyVersionRecord {
  readonly tenantId: string;
  readonly version: number;
  readonly status: string;
  /**
   * FR-02: "former-director search is selectable only under an approved historical scope."
   *
   * This is the approval, and it lives here rather than on the commercial entitlement because
   * it is a compliance decision, not a plan feature — and because the policy lifecycle is what
   * gives it four eyes, an audit entry and a version a historical search can cite.
   */
  readonly historicalScopeApproved?: boolean;
  /** The FR-02 traversal bounds, as declared. Validated by `resolveGraphBounds`. */
  readonly associationBounds?: unknown;
  readonly evidenceRetentionDays?: number;
  readonly queryPlanCap?: number;
}

export interface PinnedPolicy {
  readonly tenantId: string;
  readonly version: number;
  readonly historicalScopeApproved: boolean;
  readonly graphBounds: GraphBounds;
  /**
   * FR-04's cap on the bounded query plan. Defaults to 200, matching the seed.
   *
   * A cap of zero would produce an empty plan, which `boundPlan` refuses anyway because F1 and
   * F4 are undroppable — so an absent or nonsensical value falls back rather than producing a
   * search that asked nothing.
   */
  readonly queryPlanCap: number;
  /**
   * Problems found reading the declared bounds. Carried, never thrown: a configuration typo
   * must not take a screening run down, and a run that silently fell back to defaults is a run
   * whose truncation nobody can explain afterwards.
   */
  readonly boundProblems: readonly string[];
}

@Injectable()
export class PolicyService {
  private readonly policies: Collection<PolicyVersionRecord>;

  constructor(db: Db) {
    this.policies = db.collection<PolicyVersionRecord>('policyVersions');
  }

  /**
   * Load the exact version pinned to a run.
   *
   * No `status` filter: a version that has since been superseded is still the version the run
   * used, and refusing to read it would make an old search unexplainable the moment its policy
   * was revised.
   */
  async loadPinned(tenantId: string, version: number): Promise<PinnedPolicy> {
    const record = await this.policies.findOne({ tenantId, version });
    if (record === null) {
      throw new ApiException(
        'INVALID_POLICY',
        'The policy version this search was created under no longer exists.',
        { internalDetail: `tenant=${tenantId} policyVersion=${String(version)}` },
      );
    }

    const { bounds, problems } = resolveGraphBounds(record.associationBounds);

    return {
      tenantId,
      version,
      // Default-deny. An unrecorded field is not an approval, and a policy written before this
      // field existed has not approved anything.
      historicalScopeApproved: record.historicalScopeApproved === true,
      graphBounds: bounds,
      queryPlanCap:
        typeof record.queryPlanCap === 'number' &&
        Number.isInteger(record.queryPlanCap) &&
        record.queryPlanCap > 0
          ? record.queryPlanCap
          : DEFAULT_QUERY_PLAN_CAP,
      boundProblems: problems,
    };
  }

  /**
   * The active policy, for decisions taken at search *creation* — before a version is pinned.
   *
   * The scope check is the one caller: it has to refuse an unentitled historical search before
   * anything is written, and at that moment the run does not exist to have pinned anything. The
   * version it read is then pinned by the same `pinVersions` call, so the check and the run
   * agree.
   */
  async loadActive(tenantId: string): Promise<PinnedPolicy> {
    const record = await this.policies.findOne(
      { tenantId, status: 'ACTIVE' },
      { sort: { version: -1 } },
    );
    if (record === null) {
      throw new ApiException('INVALID_POLICY', 'No active policy version for this tenant.', {
        internalDetail: `tenant=${tenantId}`,
      });
    }
    return this.loadPinned(tenantId, record.version);
  }
}
