/**
 * Phase D step D1 — one propose → approve → activate lifecycle, shared by sources, taxonomy
 * and policy, with four-eyes approval (§4.2, T45) and the SEC-05 rights gate in front of
 * `ACTIVE`.
 *
 * **One service, three record kinds.** Three copies of an approval workflow drift, and the copy
 * that drifts is the one whose T45 test nobody wrote. The kinds differ in four declared ways —
 * their collection, their permissions, whether they are tenant-owned, and which field carries
 * their identity — and in nothing else.
 *
 * **It administers the records that already exist.** `sourceVersions`, `taxonomyVersions` and
 * `policyVersions` were seeded in Phase A and are keyed `{sourceId, version}` and
 * `{tenantId, version}`, with the lifecycle in a `status` field. This service writes exactly
 * that shape rather than a parallel one beside it, which is why an administrator can take the
 * seeded fixture source through a real approval instead of starting a second registry.
 *
 * **Where the decisions actually live.** This service performs no policy reasoning of its own:
 *
 * - which transitions are legal → `canTransition` (`@erly/adverse-domain`)
 * - whether the approver may approve → `canApprove`, enforced on identity, not on role
 * - whether the data may be touched at all → `decideRights` / `clearForActivation` (SEC-05)
 *
 * It is the part that makes those decisions durable: one transaction per transition, carrying
 * the new status, the audit entry and the supersede of the previous version together, so a
 * crash cannot leave a version active with no record of who activated it.
 *
 * **Activation is two transitions, not one.** `APPROVED → ACTIVATING → ACTIVE`. The rights
 * clearance is evaluated against the recorded `ACTIVATING` status and stored on the version, so
 * a refusal leaves evidence — the version falls back to `APPROVED` with the clearance attached
 * and an audit entry saying why. A single-step activation makes the gate an `if` that leaves
 * nothing behind when it says no, and "why is this source not live?" then has no answer.
 */

import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { ClientSession, Collection, Db, Document, Filter, UpdateFilter } from 'mongodb';

import {
  auditTaxonomyForActivation,
  canApprove,
  canTransition,
  clearancePermitsActivation,
  clearForActivation,
  isEditable,
  permissionsForRoles,
  ruleFor,
  summariseTaxonomyRefusals,
  type CountryCode,
  type LifecycleAction,
  type LifecycleState,
  type Permission,
  type Principal,
  type RightsClearance,
  type RightsOperation,
  type RightsPolicy,
  type RightsRequest,
  type TaxonomyRefusal,
  type TaxonomyVersion,
} from '@erly/adverse-domain';

import { ApiException } from '../common/api-exception.js';
import { assertContentConforms } from './source-content.js';
import { AuditService, type AuditActor } from '../persistence/audit.service.js';
import { TransactionRunner } from '../persistence/transaction.runner.js';

export const ADMIN_RECORD_KINDS = ['SOURCE', 'TAXONOMY', 'POLICY'] as const;
export type AdminRecordKind = (typeof ADMIN_RECORD_KINDS)[number];

interface KindDefinition {
  readonly collection: string;
  readonly propose: Permission;
  readonly approve: Permission;
  /**
   * Whether the record belongs to one tenant.
   *
   * Taxonomy and policy are tenant-owned: two customers legitimately screen under different
   * categories and different retention. **Source configuration is shared** (§6.3: "shared
   * source configuration must never contain customer subjects or queries"), because a source's
   * licence, tier and rate limits are properties of the publisher, not of a customer.
   *
   * That sharing has a consequence worth stating plainly rather than discovering later: a
   * change to a shared source affects every tenant, so any `source_admin` has a cross-tenant
   * blast radius. Narrowing shared-registry administration to a platform-level role is open
   * decision **D16**; until it closes, the permission check below is the only gate, and every
   * such change is audited under the actor's own tenant so it is at least attributable.
   */
  readonly tenantOwned: boolean;
  /**
   * The field carrying the record's identity across its versions, as the collection already
   * stores it. A source's identity is its `sourceId`. A taxonomy's and a policy's identity is
   * the **tenant**, because a tenant has exactly one taxonomy timeline and one policy timeline
   * — `EntitlementsService.pinVersions` depends on that, and the unique index
   * `{tenantId, version}` enforces it.
   */
  readonly identityField: 'sourceId' | 'tenantId';
  /** The audit `target.type`, and the noun used in errors. */
  readonly targetType: string;
}

const KINDS: Readonly<Record<AdminRecordKind, KindDefinition>> = {
  SOURCE: {
    collection: 'sourceVersions',
    propose: 'source:propose',
    approve: 'source:approve',
    tenantOwned: false,
    identityField: 'sourceId',
    targetType: 'SourceVersion',
  },
  TAXONOMY: {
    collection: 'taxonomyVersions',
    propose: 'taxonomy:propose',
    approve: 'taxonomy:approve',
    tenantOwned: true,
    identityField: 'tenantId',
    targetType: 'TaxonomyVersion',
  },
  POLICY: {
    collection: 'policyVersions',
    propose: 'policy:propose',
    approve: 'policy:approve',
    tenantOwned: true,
    identityField: 'tenantId',
    targetType: 'PolicyVersion',
  },
};

export function kindDefinition(kind: AdminRecordKind): KindDefinition {
  return KINDS[kind];
}

/**
 * What a source version must declare before it can be cleared for activation.
 *
 * Every field is an input to `decideRights`. A source that declares none of this cannot be
 * activated — not because a field is missing, but because nothing is known about what it would
 * do with personal data, and "unknown" is refused by SEC-05's default-deny rule.
 */
export interface DataProfile {
  readonly jurisdiction: string;
  readonly classification: RightsRequest['classification'];
  readonly collectionMethod: RightsRequest['collectionMethod'];
  readonly intendedUse: RightsRequest['intendedUse'];
  /** Everything this source will do once live. The gate clears all of it, or none of it. */
  readonly operations: readonly RightsOperation[];
  readonly requestedRetentionDays: number | null;
  readonly retainsRawPersonalData: boolean;
  readonly processingRegion: string;
  readonly approval: RightsRequest['approval'];
}

export interface LifecycleTransitionEntry {
  readonly action: LifecycleAction;
  readonly from: LifecycleState;
  readonly to: LifecycleState;
  readonly actor: string;
  readonly reason: string | null;
  readonly at: Date;
}

/**
 * A version as this service works with it.
 *
 * `recordId` is derived on read from whichever field carries identity for the kind, so callers
 * have one name for it without the stored documents growing a duplicate key that could drift
 * from the one the unique index is built on.
 */
export interface VersionedRecord {
  readonly recordId: string;
  readonly versionId: string | null;
  readonly version: number;
  readonly kind: AdminRecordKind;
  /** Null for shared records (sources). */
  readonly tenantId: string | null;
  readonly status: LifecycleState;

  readonly content: Record<string, unknown>;
  /** SEC-05 rules. Required for SOURCE; null for taxonomy and policy versions. */
  readonly rightsPolicy: RightsPolicy | null;
  readonly dataProfile: DataProfile | null;
  /** The clearance the last activation attempt produced. Retained even when it refused. */
  readonly rightsClearance: RightsClearance | null;

  readonly proposedBy: string | null;
  readonly approvedBy: string | null;
  readonly revision: number;
  readonly history: readonly LifecycleTransitionEntry[];

  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
  readonly activatedAt: Date | null;
  readonly supersededAt: Date | null;
}

export interface TransitionInput {
  readonly kind: AdminRecordKind;
  readonly principal: Principal;
  readonly recordId: string;
  readonly version: number;
  readonly action: LifecycleAction;
  readonly reason?: string | undefined;
  /** Optimistic concurrency, as with searches. Omitted means "I have not read it". */
  readonly expectedRevision?: number | undefined;
  readonly now: Date;
  readonly correlationId?: string | undefined;
}

@Injectable()
export class VersionedRecordService {
  /**
   * @param mode the operating mode this process runs in, stamped onto every version written.
   *
   * Test T55: a fixture must never be able to pass as a live result, and the label lives on
   * the record rather than in a config flag someone can flip later. A version proposed through
   * the admin API in a mock stack is as much a fixture as a seeded one — leaving it unlabelled
   * would be the one gap through which an unlabelled record enters these collections.
   */
  constructor(
    private readonly db: Db,
    private readonly transactions: TransactionRunner,
    private readonly audit: AuditService,
    private readonly mode: 'mock' | 'live' = 'mock',
  ) {}

  /**
   * The identity indexes, which already exist from the Phase A bootstrap.
   *
   * Re-declaring them is idempotent and additive — the point is that this service depends on
   * them rather than on indexes of its own, so the uniqueness that stops two versions sharing
   * a number is the same uniqueness the seed relies on.
   */
  async ensureIndexes(): Promise<void> {
    for (const kind of ADMIN_RECORD_KINDS) {
      const definition = KINDS[kind];
      const collection = this.collectionFor(kind);
      await collection.createIndex(
        { [definition.identityField]: 1, version: -1 },
        { unique: true },
      );
      await collection.createIndex({ [definition.identityField]: 1, status: 1 });
    }
  }

  private collectionFor(kind: AdminRecordKind): Collection {
    return this.db.collection(KINDS[kind].collection);
  }

  /**
   * Authorise an administrative action.
   *
   * Tenant-owned kinds require a tenant context; shared kinds check the permission alone — see
   * the `tenantOwned` note above, and D16.
   */
  private authorise(kind: AdminRecordKind, principal: Principal, permission: Permission): void {
    if (KINDS[kind].tenantOwned && principal.tenantId === null) {
      throw new ApiException('FORBIDDEN', 'This action requires an authenticated tenant context.');
    }
    if (!permissionsForRoles(principal.roles).has(permission)) {
      throw new ApiException('FORBIDDEN', `This action requires ${permission}.`, {
        internalDetail: `subject=${principal.subject} roles=[${principal.roles.join(', ')}]`,
      });
    }
  }

  /**
   * The filter that selects one record's versions.
   *
   * For a tenant-owned kind the identity **is** the tenant, so a caller cannot address another
   * tenant's taxonomy by passing its id: the filter is built from the principal, never from the
   * request (SEC-01, the same rule `SubjectsService` follows).
   */
  private identityFilter(
    kind: AdminRecordKind,
    recordId: string,
    principal: Principal,
  ): Filter<Document> {
    const definition = KINDS[kind];
    if (definition.tenantOwned) {
      if (principal.tenantId === null) {
        throw new ApiException(
          'FORBIDDEN',
          'This action requires an authenticated tenant context.',
        );
      }
      if (recordId !== principal.tenantId) {
        throw new ApiException(
          'VALIDATION_FAILED',
          `A ${kind.toLowerCase()} version is identified by its tenant. Use ${principal.tenantId}.`,
          { details: [{ path: 'recordId', message: 'must be the calling tenant' }] },
        );
      }
      return { tenantId: principal.tenantId };
    }
    return { sourceId: recordId };
  }

  private auditTenant(principal: Principal): string {
    if (principal.tenantId === null) {
      throw new ApiException(
        'FORBIDDEN',
        'An administrative action cannot be recorded without a tenant context.',
      );
    }
    return principal.tenantId;
  }

  private actorOf(principal: Principal): AuditActor {
    return {
      type: principal.kind === 'MACHINE' ? 'MACHINE' : 'USER',
      subject: principal.subject,
      clientId: null,
    };
  }

  /**
   * Propose a new version.
   *
   * Always the next version, never an edit of an existing one. A version past `PROPOSED` is
   * immutable, so "change the active source" means "propose its successor", and the record of
   * what was live last month survives the change (§6.3).
   */
  async propose(input: {
    readonly kind: AdminRecordKind;
    readonly principal: Principal;
    readonly recordId: string;
    readonly content: Record<string, unknown>;
    readonly rightsPolicy?: RightsPolicy | undefined;
    readonly dataProfile?: DataProfile | undefined;
    readonly now: Date;
    readonly correlationId?: string | undefined;
  }): Promise<VersionedRecord> {
    const definition = KINDS[input.kind];
    this.authorise(input.kind, input.principal, definition.propose);

    const collection = this.collectionFor(input.kind);
    const identity = this.identityFilter(input.kind, input.recordId, input.principal);
    const auditTenant = this.auditTenant(input.principal);

    return this.transactions.run(
      async (session) => {
        const latest = await collection.findOne(identity, { sort: { version: -1 }, session });

        const document: Document = {
          ...identity,
          mode: this.mode === 'live' ? 'LIVE' : 'MOCK',
          versionId: randomUUID(),
          version: ((latest?.['version'] as number | undefined) ?? 0) + 1,
          status: 'PROPOSED' satisfies LifecycleState,
          content: input.content,
          rightsPolicy: input.rightsPolicy ?? null,
          dataProfile: input.dataProfile ?? null,
          rightsClearance: null,
          proposedBy: input.principal.subject,
          approvedBy: null,
          revision: 1,
          history: [],
          createdAt: input.now,
          updatedAt: input.now,
          activatedAt: null,
          supersededAt: null,
        };

        await collection.insertOne(document, { session });
        await this.appendAudit(session, {
          tenantId: auditTenant,
          principal: input.principal,
          action: `${input.kind.toLowerCase()}:propose`,
          targetType: definition.targetType,
          targetId: input.recordId,
          version: document['version'] as number,
          reason: null,
          correlationId: input.correlationId,
          result: 'ALLOWED',
          now: input.now,
        });

        return toRecord(document, input.kind);
      },
      { name: `admin.propose.${input.kind}` },
    );
  }

  /** Edit a draft. Refused past `PROPOSED` — the approver must approve what activates. */
  async updateDraft(input: {
    readonly kind: AdminRecordKind;
    readonly principal: Principal;
    readonly recordId: string;
    readonly version: number;
    readonly content?: Record<string, unknown> | undefined;
    readonly rightsPolicy?: RightsPolicy | undefined;
    readonly dataProfile?: DataProfile | undefined;
    readonly expectedRevision?: number | undefined;
    readonly now: Date;
  }): Promise<VersionedRecord> {
    const definition = KINDS[input.kind];
    this.authorise(input.kind, input.principal, definition.propose);

    const collection = this.collectionFor(input.kind);
    const identity = this.identityFilter(input.kind, input.recordId, input.principal);

    return this.transactions.run(
      async (session) => {
        const current = await this.load(collection, identity, input.kind, input.version, session);
        this.checkRevision(current, input.expectedRevision);

        if (!isEditable(current.status)) {
          throw new ApiException(
            'ALREADY_TERMINAL',
            `A ${current.status} version cannot be edited. Propose a new version instead.`,
            { internalDetail: `${input.kind} ${input.recordId} v${String(input.version)}` },
          );
        }

        const updated = await collection.findOneAndUpdate(
          { ...identity, version: input.version, revision: current.revision },
          {
            $set: {
              ...(input.content === undefined ? {} : { content: input.content }),
              ...(input.rightsPolicy === undefined ? {} : { rightsPolicy: input.rightsPolicy }),
              ...(input.dataProfile === undefined ? {} : { dataProfile: input.dataProfile }),
              // Re-stamped, not carried forward. `mode` says which kind of process established
              // this version's content, and an edit establishes it again — so a draft written by
              // `local-bootstrap` (which stamps every record `MOCK`) and then edited in a live
              // process must stop claiming to be mock. The alternative is a record about a real
              // publisher carrying a label that says it is a fixture, which is a false statement
              // on a record several gates read.
              //
              // Only a draft reaches here — `isEditable` refused anything else above — so this
              // cannot rewrite the provenance of an approved or active version. Taking a mock
              // draft live still needs everything else it needed: a verified endpoint, a robots
              // position, a named first-contact approval and four eyes.
              mode: this.mode === 'live' ? 'LIVE' : 'MOCK',
              updatedAt: input.now,
            },
            $inc: { revision: 1 },
          },
          { returnDocument: 'after', session },
        );

        if (updated === null) {
          throw ApiException.revisionConflict({
            expectedRevision: current.revision,
            currentRevision: current.revision,
            currentState: current.status,
          });
        }
        return toRecord(updated, input.kind);
      },
      { name: `admin.updateDraft.${input.kind}` },
    );
  }

  /**
   * Apply a lifecycle transition other than activation.
   *
   * `SUBMIT`, `APPROVE`, `REQUEST_CHANGES`, `SUSPEND`, `RESTORE`, `RETIRE`. Activation has its
   * own method because it evaluates the rights gate and supersedes the previous version.
   */
  async transition(input: TransitionInput): Promise<VersionedRecord> {
    if (input.action === 'COMPLETE_ACTIVATION' || input.action === 'BEGIN_ACTIVATION') {
      throw new ApiException(
        'VALIDATION_FAILED',
        'Use activate() — activation evaluates the SEC-05 rights gate and cannot be driven ' +
          'one transition at a time.',
      );
    }

    const definition = KINDS[input.kind];
    const rule = ruleFor(input.action);
    // Approval-side actions need the approve permission; drafting-side actions the propose one.
    const permission = rule.requiresFourEyes ? definition.approve : definition.propose;
    this.authorise(input.kind, input.principal, permission);

    if (rule.requiresReason && (input.reason === undefined || input.reason.trim() === '')) {
      throw new ApiException(
        'VALIDATION_FAILED',
        `${input.action} requires a reason. It is recorded in the audit trail (SEC-06).`,
        { details: [{ path: 'reason', message: 'required' }] },
      );
    }

    const collection = this.collectionFor(input.kind);
    const identity = this.identityFilter(input.kind, input.recordId, input.principal);
    const auditTenant = this.auditTenant(input.principal);

    // Set when the transaction body refuses, so the refusal can be audited after the abort.
    // A holder object rather than a bare `let`: the assignment happens inside a closure, and a
    // narrowed `let` would be typed `null` at the point the `finally` reads it.
    const denial: { refusal: { reason: string; version: number } | null } = { refusal: null };

    try {
      return await this.transactions.run(
        async (session) => {
          const current = await this.load(collection, identity, input.kind, input.version, session);
          this.checkRevision(current, input.expectedRevision);

          const move = canTransition(current.status, input.action);
          if (!move.allowed) {
            denial.refusal = { reason: move.reason, version: current.version };
            throw new ApiException('ALREADY_TERMINAL', move.reason, {
              internalDetail: `${input.kind} ${input.recordId} v${String(input.version)}`,
            });
          }

          // FR-05 conformance, checked at the moment the version is put in front of an
          // approver (D2). A draft may be incomplete; a submission may not, because approving
          // is the act that carries responsibility and nobody should be asked to take it on a
          // record that cannot be interpreted. See `source-content.ts`.
          if (input.action === 'SUBMIT') {
            assertContentConforms(input.kind, current.content);
          }

          if (rule.requiresFourEyes) {
            const decision = canApprove({
              approver: input.principal,
              proposedBy: current.proposedBy ?? '',
              permission: definition.approve as Extract<Permission, `${string}:approve`>,
            });
            if (!decision.allowed) {
              denial.refusal = { reason: decision.detail, version: current.version };
              throw new ApiException('FORBIDDEN', decision.detail, {
                internalDetail:
                  `four-eyes refused: proposer=${current.proposedBy ?? 'unknown'} ` +
                  `approver=${input.principal.subject}`,
              });
            }
          }

          // Restoring puts a version back into use, so it re-enters at the gate rather than
          // stepping straight to ACTIVE: a licence that expired during the suspension must not be
          // restored past. `RESTORE` therefore lands in ACTIVATING.
          const to: LifecycleState = input.action === 'RESTORE' ? 'ACTIVATING' : move.to;

          const updated = await this.applyStatus(collection, identity, current, {
            to,
            action: input.action,
            actor: input.principal.subject,
            reason: input.reason ?? null,
            now: input.now,
            kind: input.kind,
            ...(input.action === 'APPROVE' ? { approvedBy: input.principal.subject } : {}),
            session,
          });

          await this.appendAudit(session, {
            tenantId: auditTenant,
            principal: input.principal,
            action: `${input.kind.toLowerCase()}:${input.action.toLowerCase()}`,
            targetType: definition.targetType,
            targetId: input.recordId,
            version: current.version,
            reason: input.reason ?? null,
            correlationId: input.correlationId,
            result: 'ALLOWED',
            now: input.now,
          });

          return updated;
        },
        { name: `admin.${input.action}.${input.kind}` },
      );
    } finally {
      if (denial.refusal !== null) {
        const refused = denial.refusal;
        await this.auditDenial({
          tenantId: auditTenant,
          principal: input.principal,
          action: `${input.kind.toLowerCase()}:${input.action.toLowerCase()}`,
          targetType: definition.targetType,
          targetId: input.recordId,
          version: refused.version,
          reason: refused.reason,
          correlationId: input.correlationId,
          now: input.now,
        });
      }
    }
  }

  /**
   * Activate an approved version, through the SEC-05 gate.
   *
   * 1. `APPROVED → ACTIVATING`, recorded.
   * 2. The rights clearance is computed and **stored on the version**, whatever it says.
   * 3. On `ALLOW`: supersede the currently active version, then `ACTIVATING → ACTIVE`.
   * 4. On anything else: `ACTIVATING → APPROVED`, with the clearance still attached and an audit
   *    entry carrying the reasons. Nothing becomes active, and the administrator can see exactly
   *    which operation was refused and why.
   */
  async activate(input: {
    readonly kind: AdminRecordKind;
    readonly principal: Principal;
    readonly recordId: string;
    readonly version: number;
    readonly expectedRevision?: number | undefined;
    readonly now: Date;
    readonly correlationId?: string | undefined;
  }): Promise<{ record: VersionedRecord; clearance: RightsClearance }> {
    const definition = KINDS[input.kind];
    this.authorise(input.kind, input.principal, definition.approve);

    const collection = this.collectionFor(input.kind);
    const identity = this.identityFilter(input.kind, input.recordId, input.principal);
    const auditTenant = this.auditTenant(input.principal);

    /**
     * Set when D6's taxonomy audit refuses, and written after the transaction has aborted.
     *
     * A mutable holder rather than a `let`, because the assignment happens inside the transaction
     * callback and TypeScript's control-flow analysis cannot see across it — it would narrow the
     * variable to `null` in the `finally` and reject the read.
     */
    const taxonomyDenial: { refusal: { version: number; reason: string } | null } = {
      refusal: null,
    };

    try {
      return await this.transactions.run(
        async (session) => {
          const current = await this.load(collection, identity, input.kind, input.version, session);
          this.checkRevision(current, input.expectedRevision);

          // The backstop. Submit already checked this, but a record can reach `APPROVED` by
          // other routes — the bootstrap seeds versions directly, and a restore re-enters at the
          // gate — and an active source whose fields the adapters cannot read is a source that
          // silently contributes nothing while appearing in the coverage statement.
          assertContentConforms(input.kind, current.content);

          // Phase D step D6. `assertLexiconClean` already fails CI; this makes the same audit fail
          // **activation**, because CI catches a term an engineer commits and catches nothing a
          // `taxonomy_admin` types into this API. The refusal is audited before it is thrown, so
          // "why is this taxonomy not live?" has an answer that survives the aborted transaction.
          if (input.kind === 'TAXONOMY') {
            const refusals = await this.auditTaxonomy(current, session);
            if (refusals.length > 0) {
              // Recorded on the closure, not audited here. A denial written inside the transaction
              // that is about to throw is rolled back with it, and the refusal leaves no trace —
              // which is the opposite of what SEC-06 wants, because a `taxonomy_admin` trying to
              // activate a protected-characteristic term is precisely the event an auditor needs
              // to see. The `finally` below writes it in its own transaction.
              taxonomyDenial.refusal = {
                version: current.version,
                reason: summariseTaxonomyRefusals(refusals),
              };
              throw new ApiException(
                'VALIDATION_FAILED',
                `This taxonomy version cannot be activated (${String(refusals.length)} problem(s)). ` +
                  `A taxonomy edited at runtime must meet the same bar the build enforces.`,
                {
                  details: refusals.map((refusal) => ({
                    path: refusal.code,
                    message: refusal.detail,
                  })),
                },
              );
            }
          }

          const resuming = current.status === 'ACTIVATING';
          const begin = canTransition(current.status, 'BEGIN_ACTIVATION');
          if (!begin.allowed && !resuming) {
            throw new ApiException('ALREADY_TERMINAL', begin.reason, {
              internalDetail: `${input.kind} ${input.recordId} v${String(input.version)}`,
            });
          }

          const activating = resuming
            ? current
            : await this.applyStatus(collection, identity, current, {
                to: 'ACTIVATING',
                action: 'BEGIN_ACTIVATION',
                actor: input.principal.subject,
                reason: null,
                now: input.now,
                kind: input.kind,
                session,
              });

          const clearance = this.clear(activating, input.now);

          if (!clearancePermitsActivation(clearance)) {
            const aborted = await this.applyStatus(collection, identity, activating, {
              to: 'APPROVED',
              action: 'ABORT_ACTIVATION',
              actor: input.principal.subject,
              reason: summariseClearance(clearance),
              now: input.now,
              kind: input.kind,
              clearance,
              session,
            });

            await this.appendAudit(session, {
              tenantId: auditTenant,
              principal: input.principal,
              action: `${input.kind.toLowerCase()}:activate`,
              targetType: definition.targetType,
              targetId: input.recordId,
              version: current.version,
              reason: summariseClearance(clearance),
              correlationId: input.correlationId,
              result: 'DENIED',
              now: input.now,
            });

            return { record: aborted, clearance };
          }

          // Supersede whatever is live now — in the same transaction, so there is never a moment
          // with two active versions and never one with none.
          await collection.updateMany(
            { ...identity, status: 'ACTIVE', version: { $ne: input.version } },
            { $set: { status: 'SUPERSEDED', supersededAt: input.now }, $inc: { revision: 1 } },
            { session },
          );

          const activated = await this.applyStatus(collection, identity, activating, {
            to: 'ACTIVE',
            action: 'COMPLETE_ACTIVATION',
            actor: input.principal.subject,
            reason: null,
            now: input.now,
            kind: input.kind,
            clearance,
            activatedAt: input.now,
            session,
          });

          await this.appendAudit(session, {
            tenantId: auditTenant,
            principal: input.principal,
            action: `${input.kind.toLowerCase()}:activate`,
            targetType: definition.targetType,
            targetId: input.recordId,
            version: current.version,
            reason: `Rights clearance ${clearance.verdict} under policy ${clearance.policyId}.`,
            correlationId: input.correlationId,
            result: 'ALLOWED',
            now: input.now,
          });

          return { record: activated, clearance };
        },
        { name: `admin.activate.${input.kind}` },
      );
    } finally {
      const refused = taxonomyDenial.refusal;
      if (refused !== null) {
        await this.auditDenial({
          tenantId: auditTenant,
          principal: input.principal,
          action: 'taxonomy:activate',
          targetType: definition.targetType,
          targetId: input.recordId,
          version: refused.version,
          reason: refused.reason,
          correlationId: input.correlationId,
          now: input.now,
        });
      }
    }
  }

  /**
   * The D6 activation audit for a taxonomy version.
   *
   * All the reasoning is in `auditTaxonomyForActivation`, which is pure. This supplies the two
   * facts that need a database: the currently active version (so an administrative edit to a
   * measured recall figure is detectable — FR-16 says only an evaluation run may set one), and
   * the countries in which some source is actually approved and active.
   *
   * **The source-coverage read is deliberately of `sourceVersions`, not of `capabilityCoverage`.**
   * Capability coverage is a human assertion about what the product can do; this question is
   * narrower and mechanical — is there an approved, active source whose declared countries
   * include this one? A category enabled where the answer is no is searched for and never found,
   * which reads to a reviewer as a clean result for that category.
   */
  private async auditTaxonomy(
    record: VersionedRecord,
    session: ClientSession,
  ): Promise<readonly TaxonomyRefusal[]> {
    const candidate = toTaxonomyVersion(record);

    const activeDocument = await this.collectionFor('TAXONOMY').findOne(
      { tenantId: record.tenantId, status: 'ACTIVE', version: { $ne: record.version } },
      { sort: { version: -1 }, session },
    );
    const active =
      activeDocument === null ? null : toTaxonomyVersion(toRecord(activeDocument, 'TAXONOMY'));

    const sources = await this.collectionFor('SOURCE')
      .find({ status: 'ACTIVE' }, { session })
      .toArray();
    const countries = new Set<CountryCode>();
    for (const document of sources) {
      // Seeded records store content flat; versions written through this service nest it.
      const content = (document['content'] as Record<string, unknown> | undefined) ?? document;
      for (const country of asStringArray(content['countries'])) {
        countries.add(country);
      }
    }

    return auditTaxonomyForActivation({
      candidate,
      active,
      countriesWithApprovedSource: [...countries],
    });
  }

  /**
   * Compute the rights clearance for a version.
   *
   * Taxonomy and policy versions perform no external collection, so they clear with an empty
   * operation set — a clearance that evaluated nothing, visible as `perOperation: []` rather
   * than pretending an evaluation happened. Sources must declare both a rights policy and a
   * data profile, or they cannot be cleared at all.
   */
  private clear(record: VersionedRecord, now: Date): RightsClearance {
    if (KINDS[record.kind].tenantOwned) {
      return {
        verdict: 'ALLOW',
        evaluatedAt: now.toISOString(),
        policyId: 'not-applicable',
        perOperation: [],
        restrictions: [],
      };
    }

    const policy = record.rightsPolicy;
    const profile = record.dataProfile;
    if (policy === null || profile === null) {
      return {
        verdict: 'DENY',
        evaluatedAt: now.toISOString(),
        policyId: policy?.policyId ?? 'none',
        perOperation: [],
        restrictions: [],
      };
    }

    return clearForActivation({
      request: {
        jurisdiction: profile.jurisdiction,
        sourceId: record.recordId,
        intendedUse: profile.intendedUse,
        classification: profile.classification,
        collectionMethod: profile.collectionMethod,
        requestedRetentionDays: profile.requestedRetentionDays,
        retainsRawPersonalData: profile.retainsRawPersonalData,
        processingRegion: profile.processingRegion,
        approval: profile.approval,
      },
      operations: profile.operations,
      policy,
      asOf: now,
    });
  }

  private async applyStatus(
    collection: Collection,
    identity: Filter<Document>,
    current: VersionedRecord,
    change: {
      readonly to: LifecycleState;
      readonly action: LifecycleAction;
      readonly actor: string;
      readonly reason: string | null;
      readonly now: Date;
      readonly kind: AdminRecordKind;
      readonly approvedBy?: string;
      readonly clearance?: RightsClearance;
      readonly activatedAt?: Date;
      readonly session: ClientSession;
    },
  ): Promise<VersionedRecord> {
    const entry: LifecycleTransitionEntry = {
      action: change.action,
      from: current.status,
      to: change.to,
      actor: change.actor,
      reason: change.reason,
      at: change.now,
    };

    // Cast because the collection is typed as a loose `Document`: these collections predate
    // this service and hold seeded records with their own fields, so a narrow generic here
    // would describe a shape the database does not actually have.
    const update = {
      $set: {
        status: change.to,
        updatedAt: change.now,
        ...(change.approvedBy === undefined ? {} : { approvedBy: change.approvedBy }),
        ...(change.clearance === undefined ? {} : { rightsClearance: change.clearance }),
        ...(change.activatedAt === undefined ? {} : { activatedAt: change.activatedAt }),
      },
      $inc: { revision: 1 },
      $push: { history: entry },
    } as unknown as UpdateFilter<Document>;

    const updated = await collection.findOneAndUpdate(
      { ...identity, version: current.version, revision: current.revision },
      update,
      { returnDocument: 'after', session: change.session },
    );

    if (updated === null) {
      // Lost a race with another administrator between the read and the write.
      throw ApiException.revisionConflict({
        expectedRevision: current.revision,
        currentRevision: current.revision,
        currentState: current.status,
        internalDetail: `${current.kind} ${current.recordId} v${String(current.version)}`,
      });
    }
    return toRecord(updated, change.kind);
  }

  private async load(
    collection: Collection,
    identity: Filter<Document>,
    kind: AdminRecordKind,
    version: number,
    session: ClientSession,
  ): Promise<VersionedRecord> {
    const document = await collection.findOne({ ...identity, version }, { session });
    if (document === null) {
      throw ApiException.notFound('Version', `${kind} v${String(version)}`);
    }
    return toRecord(document, kind);
  }

  private checkRevision(record: VersionedRecord, expected: number | undefined): void {
    if (expected !== undefined && record.revision !== expected) {
      throw ApiException.revisionConflict({
        expectedRevision: expected,
        currentRevision: record.revision,
        currentState: record.status,
        internalDetail: `${record.kind} ${record.recordId} v${String(record.version)}`,
      });
    }
  }

  private async appendAudit(
    session: ClientSession,
    input: {
      readonly tenantId: string;
      readonly principal: Principal;
      readonly action: string;
      readonly targetType: string;
      readonly targetId: string;
      readonly version: number;
      readonly reason: string | null;
      readonly correlationId: string | undefined;
      readonly result: 'ALLOWED' | 'DENIED';
      readonly now: Date;
    },
  ): Promise<void> {
    await this.audit.append(
      {
        tenantId: input.tenantId,
        actor: this.actorOf(input.principal),
        action: input.action,
        target: { type: input.targetType, id: input.targetId, version: input.version },
        reason: input.reason,
        correlationId: input.correlationId ?? null,
        result: input.result,
        now: input.now,
      },
      session,
    );
  }

  /**
   * Record a refused action, in its own transaction.
   *
   * This is not a stylistic separation. A denial audited **inside** the transaction that then
   * throws is rolled back with it, and the refusal leaves no trace at all — which is the exact
   * opposite of what SEC-06 wants, because an attempt to approve one's own version is precisely
   * the event an auditor needs to see. Found by a test that asserted the entry existed rather
   * than asserting the 403; the 403 was always correct and the audit trail was silently empty.
   *
   * The denial is therefore written after the business transaction has aborted, in a
   * transaction of its own. It cannot be atomic with a transaction that by definition does not
   * commit, and the cost — an audit entry could in principle fail after the refusal — is the
   * right way round: a refused action that is not recorded is worse than a recorded refusal
   * whose record arrives a moment later.
   */
  private async auditDenial(input: {
    readonly tenantId: string;
    readonly principal: Principal;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly version: number;
    readonly reason: string;
    readonly correlationId: string | undefined;
    readonly now: Date;
  }): Promise<void> {
    await this.transactions.run(
      async (session) => {
        await this.appendAudit(session, { ...input, result: 'DENIED' });
      },
      { name: 'admin.auditDenial' },
    );
  }

  /**
   * The version in use, if any.
   *
   * `ACTIVE` only. `APPROVED` is permission to activate, not activation, and `ACTIVATING` has
   * not passed the gate — see `isUsable` in the domain package.
   */
  async findActive(input: {
    readonly kind: AdminRecordKind;
    readonly tenantId: string | null;
    readonly recordId: string;
  }): Promise<VersionedRecord | null> {
    const definition = KINDS[input.kind];
    const identity: Filter<Document> = definition.tenantOwned
      ? { tenantId: input.tenantId }
      : { sourceId: input.recordId };
    const document = await this.collectionFor(input.kind).findOne(
      { ...identity, status: 'ACTIVE' },
      { sort: { version: -1 } },
    );
    return document === null ? null : toRecord(document, input.kind);
  }

  async findVersion(input: {
    readonly kind: AdminRecordKind;
    readonly principal: Principal;
    readonly recordId: string;
    readonly version: number;
  }): Promise<VersionedRecord> {
    const identity = this.identityFilter(input.kind, input.recordId, input.principal);
    const document = await this.collectionFor(input.kind).findOne({
      ...identity,
      version: input.version,
    });
    if (document === null) {
      throw ApiException.notFound('Version', `${input.recordId} v${String(input.version)}`);
    }
    return toRecord(document, input.kind);
  }

  async listVersions(input: {
    readonly kind: AdminRecordKind;
    readonly principal: Principal;
    readonly recordId?: string | undefined;
    readonly limit: number;
  }): Promise<VersionedRecord[]> {
    const definition = KINDS[input.kind];
    const filter: Filter<Document> = definition.tenantOwned
      ? { tenantId: input.principal.tenantId }
      : input.recordId === undefined
        ? {}
        : { sourceId: input.recordId };

    const documents = await this.collectionFor(input.kind)
      .find(filter)
      .sort({ [definition.identityField]: 1, version: -1 })
      .limit(input.limit)
      .toArray();
    return documents.map((document) => toRecord(document, input.kind));
  }
}

/**
 * Map a stored document to the shape callers work with.
 *
 * Tolerant on purpose. The records seeded in Phase A predate this service and carry no
 * `revision`, `history` or `proposedBy`; they are still real active versions, and refusing to
 * read them would mean the registry an administrator sees is not the registry the system uses.
 * A seeded record therefore reads as revision 1 with an empty history, and the first transition
 * applied to it writes the missing fields.
 */
function toRecord(document: Document, kind: AdminRecordKind): VersionedRecord {
  const definition = KINDS[kind];
  const identity: unknown = document[definition.identityField];
  const { content, knownKeys } = splitContent(document);

  return {
    recordId: typeof identity === 'string' ? identity : '',
    versionId: (document['versionId'] as string | undefined) ?? null,
    version: (document['version'] as number | undefined) ?? 1,
    kind,
    tenantId: (document['tenantId'] as string | undefined) ?? null,
    // A seeded record with no status has never been through this lifecycle; treat it as active
    // only if it says so, and as proposed otherwise. Never guess upwards.
    status: ((document['status'] as LifecycleState | undefined) ??
      'PROPOSED') satisfies LifecycleState,
    content: (knownKeys['content'] as Record<string, unknown> | undefined) ?? content,
    rightsPolicy: (document['rightsPolicy'] as RightsPolicy | null | undefined) ?? null,
    dataProfile: (document['dataProfile'] as DataProfile | null | undefined) ?? null,
    rightsClearance: (document['rightsClearance'] as RightsClearance | null | undefined) ?? null,
    proposedBy: (document['proposedBy'] as string | undefined) ?? null,
    approvedBy: (document['approvedBy'] as string | undefined) ?? null,
    revision: (document['revision'] as number | undefined) ?? 1,
    history: (document['history'] as LifecycleTransitionEntry[] | undefined) ?? [],
    createdAt: dateOrNull(document['createdAt']),
    updatedAt: dateOrNull(document['updatedAt']),
    activatedAt: dateOrNull(document['activatedAt']),
    supersededAt: dateOrNull(document['supersededAt']),
  };
}

/**
 * A stored timestamp as a real `Date`, whichever way it was written.
 *
 * These four fields were cast straight to `Date`, and the cast was a lie for half the records in
 * the database: a version written through this lifecycle stores real `Date`s, but one written by
 * `local-bootstrap` stores **ISO strings**. Both are real records — the same flat-versus-nested
 * split `toRecord` already handles for `content` — so every consumer that believed the type and
 * called `.toISOString()` threw `TypeError: ... is not a function`.
 *
 * That surfaced as a **500 on `GET /v1/admin/sources`, `/v1/admin/taxonomy` and
 * `/v1/admin/policies`** — a bootstrapped registry could not be listed at all, which is the first
 * admin request anybody makes. Normalising here rather than at each mapper fixes both call sites
 * (`admin.controller.ts` and `toTaxonomyWire` below) and makes the declared type true, so the
 * next consumer does not have to know.
 */
function dateOrNull(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Envelope fields this service owns. Everything else on a seeded record is its content.
 *
 * `mode` and `seededAt` were missing until D2 and the omission was not cosmetic. A seeded
 * record stores its fields flat, so both were being split into *content* — and once D2 started
 * checking content against the FR-05 schema, a seeded source failed conformance for carrying a
 * `mode` it never declared and a `seededAt` the bootstrap wrote. Both are envelope: the
 * service stamps `mode` from the running configuration on every version it writes, and
 * `seededAt` is bootstrap metadata that no adapter reads.
 */
const ENVELOPE_KEYS = new Set([
  '_id',
  'sourceId',
  'tenantId',
  'versionId',
  'version',
  'status',
  'mode',
  'seededAt',
  'content',
  'rightsPolicy',
  'dataProfile',
  'rightsClearance',
  'proposedBy',
  'approvedBy',
  'revision',
  'history',
  'createdAt',
  'updatedAt',
  'activatedAt',
  'supersededAt',
]);

function splitContent(document: Document): {
  content: Record<string, unknown>;
  knownKeys: Record<string, unknown>;
} {
  const content: Record<string, unknown> = {};
  const knownKeys: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (ENVELOPE_KEYS.has(key)) {
      knownKeys[key] = value;
    } else {
      content[key] = value;
    }
  }
  return { content, knownKeys };
}

/**
 * A stored taxonomy record as the domain's `TaxonomyVersion`.
 *
 * Every absent field defaults to the value that **narrows** what the service claims: no
 * categories, no languages, an empty lexicon. A record missing its language list is one about
 * which nothing is measured, which is the honest reading of a missing field rather than a claim
 * that every language is fine.
 */
function toTaxonomyVersion(record: VersionedRecord): TaxonomyVersion {
  const content = record.content;
  return {
    taxonomyVersionId: `${record.tenantId ?? ''}:v${String(record.version)}`,
    version: record.version,
    tenantId: record.tenantId ?? '',
    categories: (content['categories'] as TaxonomyVersion['categories'] | undefined) ?? [],
    lexicon: (content['lexicon'] as TaxonomyVersion['lexicon'] | undefined) ?? [],
    languages: (content['languages'] as TaxonomyVersion['languages'] | undefined) ?? [],
    status: record.status,
    proposedBy: record.proposedBy ?? '',
    approvedBy: record.approvedBy,
    activatedAt: record.activatedAt?.toISOString() ?? null,
  };
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** A one-line summary of why a clearance refused, for an audit reason and an error message. */
export function summariseClearance(clearance: RightsClearance): string {
  const refusals = clearance.perOperation.filter((r) => r.decision.verdict !== 'ALLOW');
  if (refusals.length === 0) {
    return (
      `Rights clearance ${clearance.verdict} with no operation-level detail. A source version ` +
      `must declare both a rights policy and a data profile before it can be cleared.`
    );
  }
  return refusals
    .map(
      (r) =>
        `${r.operation}: ${r.decision.verdict} (${r.decision.reasons
          .map((reason) => reason.code)
          .join(', ')})`,
    )
    .join('; ');
}
