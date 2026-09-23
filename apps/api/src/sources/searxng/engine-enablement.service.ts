/**
 * Which discovery engines a **tenant** has switched on — the store behind the control API.
 *
 * # What is per tenant and what is not
 *
 * The engine matrix in `engine-governance.ts` is platform-wide, because it records readings of
 * somebody else's terms of use and those do not vary by customer. What varies by customer is
 * whether they want a given engine used on their searches — a coverage and cost preference, and
 * theirs to set.
 *
 * So this holds one row per `(tenantId, engine)` and nothing else. A tenant with no row for an
 * engine gets `defaultEnabledForDiscovery` from the matrix; a tenant with a row gets their row.
 * The resolution is in one place, `resolveFor`, so a caller cannot accidentally read the default
 * where it should have read the override or the other way round.
 *
 * # The row is the decision, so it carries who made it
 *
 * `changedBy` and `reason` are required on every write, and neither is defaulted. This follows
 * `firstContactApproval` rather than an ordinary settings table: switching an engine on is
 * accepting that this service will query a third party on that tenant's behalf, and a settings
 * row that cannot say who asked for it is not a record of a decision — it is a value that
 * appeared. The audit entry is written in the same transaction as the row.
 *
 * # It never overrides the governance execution gate
 *
 * A tenant switching an engine on does not make `governanceStatus` `PERMITTED`, and this service
 * will not write that field — it is not in this collection at all. What a write does is set the
 * switch, and the resolved record carries the *unchanged* reading beside it, so every diagnostic
 * row and every control-API response shows both. `effectiveEnabled` combines integration, the
 * tenant switch, and governance. A `REFUSED` engine is never executable, even when the tenant
 * switch is on.
 *
 * # Tenant scoping is in the query, never a check afterwards (SEC-01)
 *
 * Every read and write leads with `tenantId`, and the unique index does too. There is no method
 * that reads across tenants.
 */

import { Injectable } from '@nestjs/common';
import type { ClientSession, Collection, Db } from 'mongodb';

import {
  ENGINE_GOVERNANCE,
  engineRecord,
  integratedEngines,
  type DiscoveryEngine,
  type EngineGovernanceRecord,
} from './engine-governance.js';

/** One tenant's stored preference for one engine. Absent means "use the matrix default". */
export interface StoredEngineSetting {
  readonly tenantId: string;
  readonly engine: DiscoveryEngine;
  readonly enabledForDiscovery: boolean;
  /** Who asked for this. Required — see the file header. */
  readonly changedBy: string;
  /** Why, in their own words. Required. */
  readonly reason: string;
  /**
   * The governance reading at the moment of the change.
   *
   * Stored rather than looked up later, because it answers a question a live lookup cannot:
   * *what did the person switching this on know at the time?* If a reading moves from `PENDING`
   * to `REFUSED` afterwards, a row saying `acknowledgedGovernanceStatus: 'PENDING'` correctly
   * records that they did not override a refusal — they acted before there was one.
   */
  readonly acknowledgedGovernanceStatus: string;
  readonly changedAt: Date;
}

/**
 * An engine as the control API and the diagnostics see it: the matrix, plus this tenant's switch.
 *
 * Carries **both** the governance reading and the effective switch, always. A consumer that got
 * only the switch could not explain it, and one that got only the reading could not predict what
 * a search would do.
 */
export interface ResolvedEngine {
  readonly engine: DiscoveryEngine;
  readonly searxngEngineName: string;
  readonly integrated: boolean;
  /** The tenant's requested switch. It never overrides platform governance. */
  readonly tenantEnabled: boolean;
  /** What a search will actually do after technical, tenant, and governance gates. */
  readonly effectiveEnabled: boolean;
  /** True when this came from a stored tenant row rather than the matrix default. */
  readonly configuredByTenant: boolean;
  readonly defaultEnabledForDiscovery: boolean;
  readonly governanceStatus: string;
  readonly decisionId: string;
  readonly reviewedAt: string;
  readonly reviewedBy: string | null;
  readonly usesPublisherDocumentedApi: boolean;
  readonly evidenceNote: string;
  /** Present only when a tenant row exists. */
  readonly changedBy?: string | undefined;
  readonly reason?: string | undefined;
  readonly changedAt?: string | undefined;
}

/** The narrow thing the connector needs. A port so the adapter is testable without Mongo. */
export interface EngineEnablementPort {
  resolveFor(tenantId: string): Promise<readonly ResolvedEngine[]>;
}

@Injectable()
export class EngineEnablementService implements EngineEnablementPort {
  private readonly settings: Collection<StoredEngineSetting>;

  constructor(private readonly db: Db) {
    this.settings = db.collection<StoredEngineSetting>('searxngEngineSettings');
  }

  async ensureIndexes(): Promise<void> {
    // Tenant context leads the key (section 6.3), and one row per engine per tenant.
    await this.settings.createIndex({ tenantId: 1, engine: 1 }, { unique: true });
  }

  /**
   * Every integrated engine, with this tenant's effective switch and the governance reading.
   *
   * Always returns **every** integrated engine, including the ones that are off. An engine
   * missing from this list would be an engine missing from the tenant's diagnostics, and
   * "nothing was said about Google" is precisely the report this whole arrangement exists to
   * avoid.
   */
  async resolveFor(tenantId: string): Promise<readonly ResolvedEngine[]> {
    const stored = await this.settings.find({ tenantId }).toArray();
    const byEngine = new Map(stored.map((row) => [row.engine, row]));

    return integratedEngines().map((record) => this.resolve(record, byEngine.get(record.engine)));
  }

  /**
   * Set one engine's switch for one tenant.
   *
   * Returns the resolved engine so the caller responds with the same shape it reads, rather than
   * with a bare acknowledgement the client then has to re-fetch to interpret.
   *
   * Refuses an engine the matrix does not integrate: a stored row for a name nothing can query
   * would be a setting that silently does nothing, which is worse than an error.
   */
  async setFor(input: {
    readonly tenantId: string;
    readonly engine: string;
    readonly enabled: boolean;
    readonly changedBy: string;
    readonly reason: string;
    readonly now: Date;
    readonly session?: ClientSession | undefined;
  }): Promise<ResolvedEngine | null> {
    const record = engineRecord(input.engine);
    if (record === null) {
      return null;
    }

    const row: StoredEngineSetting = {
      tenantId: input.tenantId,
      engine: record.engine,
      enabledForDiscovery: input.enabled,
      changedBy: input.changedBy,
      reason: input.reason,
      // What they knew at the time. See the field's own comment.
      acknowledgedGovernanceStatus: record.governanceStatus,
      changedAt: input.now,
    };

    await this.settings.updateOne(
      { tenantId: input.tenantId, engine: record.engine },
      { $set: row },
      { upsert: true, ...(input.session === undefined ? {} : { session: input.session }) },
    );

    return this.resolve(record, row);
  }

  /** Drop a tenant's row, returning that engine to the matrix default. */
  async clearFor(input: {
    readonly tenantId: string;
    readonly engine: string;
    readonly session?: ClientSession | undefined;
  }): Promise<ResolvedEngine | null> {
    const record = engineRecord(input.engine);
    if (record === null) {
      return null;
    }
    await this.settings.deleteOne(
      { tenantId: input.tenantId, engine: record.engine },
      input.session === undefined ? {} : { session: input.session },
    );
    return this.resolve(record, undefined);
  }

  private resolve(
    record: EngineGovernanceRecord,
    row: StoredEngineSetting | undefined,
  ): ResolvedEngine {
    const tenantEnabled = row?.enabledForDiscovery ?? record.defaultEnabledForDiscovery;
    const effectiveEnabled =
      record.integrated && tenantEnabled && record.governanceStatus !== 'REFUSED';
    return {
      engine: record.engine,
      searxngEngineName: record.searxngEngineName,
      integrated: record.integrated,
      tenantEnabled,
      effectiveEnabled,
      configuredByTenant: row !== undefined,
      defaultEnabledForDiscovery: record.defaultEnabledForDiscovery,
      governanceStatus: record.governanceStatus,
      decisionId: record.decisionId,
      reviewedAt: record.reviewedAt,
      reviewedBy: record.reviewedBy,
      usesPublisherDocumentedApi: record.usesPublisherDocumentedApi,
      evidenceNote: record.evidenceNote,
      ...(row === undefined
        ? {}
        : {
            changedBy: row.changedBy,
            reason: row.reason,
            changedAt: row.changedAt.toISOString(),
          }),
    };
  }
}

/**
 * The matrix defaults, resolved for a tenant with no stored rows.
 *
 * For tests and for any caller that has no database — it must produce exactly what
 * `resolveFor` produces for an unconfigured tenant, so it is built from the same `resolve`
 * shape rather than from a second copy of the rules.
 */
export function defaultResolvedEngines(): readonly ResolvedEngine[] {
  return integratedEngines().map((record) => ({
    engine: record.engine,
    searxngEngineName: record.searxngEngineName,
    integrated: record.integrated,
    tenantEnabled: record.defaultEnabledForDiscovery,
    effectiveEnabled:
      record.integrated &&
      record.defaultEnabledForDiscovery &&
      record.governanceStatus !== 'REFUSED',
    configuredByTenant: false,
    defaultEnabledForDiscovery: record.defaultEnabledForDiscovery,
    governanceStatus: record.governanceStatus,
    decisionId: record.decisionId,
    reviewedAt: record.reviewedAt,
    reviewedBy: record.reviewedBy,
    usesPublisherDocumentedApi: record.usesPublisherDocumentedApi,
    evidenceNote: record.evidenceNote,
  }));
}

/** Every engine name the matrix knows, for a schema that must not accept a free string. */
export const ENGINE_NAMES: readonly string[] = Object.keys(ENGINE_GOVERNANCE);
