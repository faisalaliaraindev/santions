/**
 * Phase D step D1 — per-jurisdiction capability coverage, stored and surfaced.
 *
 * The domain module (`capability/capability.ts`) decides what a status *means*. This service is
 * where the statuses live and how they reach a result, and it exists so that "we have no way to
 * look for officer associations in this country" is a record somebody wrote down, not an
 * inference drawn from an empty array at render time.
 *
 * **Shared, not tenant-owned**, on the same reasoning as `nameFrequencyProfiles`: what the
 * service is capable of in a jurisdiction is a property of the service and its approved
 * sources, not of a customer. Two tenants screening in Costa Rica face the same absent officer
 * register, and making that per-tenant would invite one tenant's coverage to drift from the
 * truth.
 *
 * **`declaredBy` matters.** A capability status is an assertion about what this product can do,
 * so each row records where the determination came from — a dossier section, a decision, a
 * source review. A status with no evidence reference is how an optimistic guess becomes a
 * coverage claim.
 */

import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import {
  coverageIndex,
  coverageOutcomeFor,
  describeCoverage,
  interpretEmptyResult,
  lookupCoverage,
  type Capability,
  type CapabilityCoverage,
  type CapabilityStatus,
  type CoverageOutcome,
  type EmptyResultMeaning,
} from '@adverse-search/domain';

interface CoverageRecord extends Omit<CapabilityCoverage, 'assessedAt'> {
  readonly assessedAt: Date;
  readonly declaredBy: string;
}

export interface CoverageStatement {
  readonly jurisdiction: string;
  readonly outcome: CoverageOutcome;
  readonly capabilities: readonly {
    readonly capability: Capability;
    readonly status: CapabilityStatus;
    /** What an empty result from this capability is allowed to be called. */
    readonly emptyResultMeans: EmptyResultMeaning;
    readonly statement: string;
    readonly blockedByDecision: string | null;
  }[];
  /** The capabilities a reviewer must be told about explicitly. */
  readonly gaps: readonly string[];
}

@Injectable()
export class CapabilityCoverageService {
  private readonly coverage: Collection<CoverageRecord>;

  constructor(db: Db) {
    this.coverage = db.collection<CoverageRecord>('capabilityCoverage');
  }

  async ensureIndexes(): Promise<void> {
    // Not tenant-led, deliberately — this collection is shared. It joins the documented
    // cross-tenant exceptions in docs/architecture.md alongside `nameFrequencyProfiles`.
    await this.coverage.createIndex({ jurisdiction: 1, capability: 1 }, { unique: true });
  }

  /**
   * Record or revise a capability's status.
   *
   * Upsert rather than versioned: coverage describes present capability, and a historical run
   * already pins what it could see through its own coverage outcome. The `assessedAt` and
   * `evidenceRef` are what make a revision accountable.
   */
  async declare(input: {
    readonly jurisdiction: string;
    readonly capability: Capability;
    readonly status: CapabilityStatus;
    readonly rationale: string;
    readonly sourceIds?: readonly string[] | undefined;
    readonly evidenceRef?: string | null | undefined;
    readonly blockedByDecision?: string | null | undefined;
    readonly declaredBy: string;
    readonly now: Date;
  }): Promise<void> {
    await this.coverage.updateOne(
      { jurisdiction: input.jurisdiction, capability: input.capability },
      {
        $set: {
          status: input.status,
          rationale: input.rationale,
          sourceIds: [...(input.sourceIds ?? [])],
          evidenceRef: input.evidenceRef ?? null,
          blockedByDecision: input.blockedByDecision ?? null,
          assessedAt: input.now,
          declaredBy: input.declaredBy,
        },
      },
      { upsert: true },
    );
  }

  async list(jurisdiction: string): Promise<CapabilityCoverage[]> {
    const records = await this.coverage.find({ jurisdiction }).sort({ capability: 1 }).toArray();
    return records.map(toDomain);
  }

  /**
   * The status of one capability, defaulting to `UNKNOWN` when nothing is recorded.
   *
   * The default is the point. An unrecorded capability must never read as supported, and a
   * caller that forgot to seed a row gets the safe answer rather than a silent clean result.
   */
  async statusOf(
    jurisdiction: string,
    capability: Capability,
    asOf: Date,
  ): Promise<CapabilityCoverage> {
    const records = await this.coverage.find({ jurisdiction, capability }).toArray();
    return lookupCoverage(
      coverageIndex(records.map(toDomain)),
      jurisdiction,
      capability,
      asOf.toISOString(),
    );
  }

  /**
   * Build the coverage statement for a jurisdiction.
   *
   * `gaps` is not decoration. FR-13's no-match statement and the G5 exit condition both require
   * limitations to be visible, and a reviewer scanning a result reads the gap list rather than
   * nine status rows.
   */
  async statementFor(input: {
    readonly jurisdiction: string;
    readonly capabilities: readonly Capability[];
    readonly asOf: Date;
  }): Promise<CoverageStatement> {
    const records = await this.list(input.jurisdiction);
    const index = coverageIndex(records);
    const asOf = input.asOf.toISOString();

    const capabilities = input.capabilities.map((capability) => {
      const coverage = lookupCoverage(index, input.jurisdiction, capability, asOf);
      return {
        capability,
        status: coverage.status,
        emptyResultMeans: interpretEmptyResult(coverage.status),
        statement: describeCoverage(coverage),
        blockedByDecision: coverage.blockedByDecision,
      };
    });

    return {
      jurisdiction: input.jurisdiction,
      outcome: coverageOutcomeFor(capabilities.map((c) => c.status)),
      capabilities,
      gaps: capabilities
        .filter((c) => c.emptyResultMeans === 'NOT_ESTABLISHED')
        .map((c) => c.statement),
    };
  }
}

function toDomain(record: CoverageRecord): CapabilityCoverage {
  return {
    jurisdiction: record.jurisdiction,
    capability: record.capability,
    status: record.status,
    rationale: record.rationale,
    sourceIds: record.sourceIds,
    evidenceRef: record.evidenceRef,
    assessedAt: record.assessedAt.toISOString(),
    blockedByDecision: record.blockedByDecision,
  };
}
