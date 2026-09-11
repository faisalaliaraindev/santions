/**
 * Section 6.1 — `/v1/admin/sources`, `/v1/admin/policies`, `/v1/admin/taxonomy`, and the
 * jurisdiction coverage view.
 *
 * Three record kinds behind one set of routes, because they share one lifecycle. The kind is a
 * path segment rather than three controllers, so a route added for sources cannot quietly not
 * exist for policy — which is how one of the three ends up without a four-eyes check.
 *
 * Every route declares a permission. The global `PermissionGuard` refuses a route that declares
 * none, so there is no path to an unguarded administrative action; the service then re-checks
 * the permission itself, because a worker or a future internal caller reaching the service
 * directly must meet the same bar as an HTTP client.
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  declareCapabilitySchema,
  lifecycleTransitionSchema,
  proposeVersionSchema,
  updateDraftSchema,
  type CoverageStatementWire,
  type DeclareCapabilityInput,
  type LifecycleTransitionInput,
  type ProposeVersionInput,
  type UpdateDraftInput,
  type VersionSummary,
} from '@erly/adverse-contracts';
import {
  CAPABILITIES,
  permissionsForRoles,
  type Principal,
  type RightsClearance,
} from '@erly/adverse-domain';

import { RequirePermission, RequireScope } from '../auth/auth.guard.js';
import { ApiException } from '../common/api-exception.js';
import { CorrelationId, CurrentPrincipal } from '../common/principal.decorator.js';
import { validate } from '../common/zod-validation.pipe.js';
import { parseIfMatch } from '../searches/searches.controller.js';
import { CapabilityCoverageService } from './capability-coverage.service.js';
import {
  ADMIN_RECORD_KINDS,
  VersionedRecordService,
  type AdminRecordKind,
  type VersionedRecord,
} from './versioned-record.service.js';

/** `sources` → `SOURCE`. A closed map, so a typo is a 404 and never a new record kind. */
const PATH_TO_KIND: Readonly<Record<string, AdminRecordKind>> = {
  sources: 'SOURCE',
  taxonomy: 'TAXONOMY',
  policies: 'POLICY',
};

function kindFromPath(segment: string): AdminRecordKind {
  const kind = PATH_TO_KIND[segment];
  if (kind === undefined) {
    throw ApiException.notFound('Admin collection', segment);
  }
  return kind;
}

@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(
    @Inject(VersionedRecordService) private readonly records: VersionedRecordService,
    @Inject(CapabilityCoverageService) private readonly coverage: CapabilityCoverageService,
  ) {}

  /**
   * Propose a new version.
   *
   * The permission declared here is `source:propose`, and the service checks the *kind's* own
   * propose permission as well. The route-level declaration is the coarse gate that stops an
   * unauthenticated or entirely unprivileged caller; the service's is the one that distinguishes
   * a `source_admin` from a `taxonomy_admin`.
   */
  @Post(':collection')
  @RequirePermission('source:propose', 'taxonomy:propose', 'policy:propose')
  @RequireScope('admin:write')
  async propose(
    @CurrentPrincipal() principal: Principal,
    @Param('collection') collection: string,
    @Body(validate(proposeVersionSchema)) body: ProposeVersionInput,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VersionSummary> {
    const kind = kindFromPath(collection);
    const record = await this.records.propose({
      kind,
      principal,
      recordId: body.recordId,
      content: body.content,
      ...(body.rightsPolicy === undefined ? {} : { rightsPolicy: body.rightsPolicy }),
      ...(body.dataProfile === undefined ? {} : { dataProfile: body.dataProfile }),
      now: new Date(),
      correlationId,
    });
    res.status(201);
    res.setHeader('ETag', `"${String(record.revision)}"`);
    return toWire(record);
  }

  @Get(':collection')
  @RequirePermission('source:propose', 'taxonomy:propose', 'policy:propose')
  @RequireScope('admin:read')
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('collection') collection: string,
    @Query('recordId') recordId: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<{ items: VersionSummary[] }> {
    const kind = kindFromPath(collection);
    const parsed = limit === undefined ? 50 : Number(limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 200) {
      throw new ApiException('VALIDATION_FAILED', 'limit must be between 1 and 200.', {
        details: [{ path: 'limit', message: 'out of range' }],
      });
    }
    const items = await this.records.listVersions({
      kind,
      principal,
      ...(recordId === undefined ? {} : { recordId }),
      limit: parsed,
    });
    return { items: items.map(toWire) };
  }

  @Get(':collection/:recordId/versions/:version')
  @RequirePermission('source:propose', 'taxonomy:propose', 'policy:propose')
  @RequireScope('admin:read')
  async findOne(
    @CurrentPrincipal() principal: Principal,
    @Param('collection') collection: string,
    @Param('recordId') recordId: string,
    @Param('version') version: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VersionSummary> {
    const record = await this.records.findVersion({
      kind: kindFromPath(collection),
      principal,
      recordId,
      version: parseVersion(version),
    });
    // The revision as an ETag, so the caller has something to put in `If-Match` — the same
    // contract searches already use, rather than a second concurrency scheme to learn.
    res.setHeader('ETag', `"${String(record.revision)}"`);
    return toWire(record);
  }

  @Put(':collection/:recordId/versions/:version')
  @RequirePermission('source:propose', 'taxonomy:propose', 'policy:propose')
  @RequireScope('admin:write')
  async updateDraft(
    @CurrentPrincipal() principal: Principal,
    @Param('collection') collection: string,
    @Param('recordId') recordId: string,
    @Param('version') version: string,
    @Body(validate(updateDraftSchema)) body: UpdateDraftInput,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<VersionSummary> {
    const record = await this.records.updateDraft({
      kind: kindFromPath(collection),
      principal,
      recordId,
      version: parseVersion(version),
      ...(body.content === undefined ? {} : { content: body.content }),
      ...(body.rightsPolicy === undefined ? {} : { rightsPolicy: body.rightsPolicy }),
      ...(body.dataProfile === undefined ? {} : { dataProfile: body.dataProfile }),
      expectedRevision: parseIfMatch(ifMatch),
      now: new Date(),
    });
    return toWire(record);
  }

  /**
   * Submit, approve, request changes, suspend, restore or retire.
   *
   * `If-Match` is **required**, as it is on cancellation and for the same reason: an
   * administrative decision taken on state the caller has not seen is the decision that
   * silently overwrites somebody else's.
   */
  @Post(':collection/:recordId/versions/:version/transitions')
  @RequirePermission('source:propose', 'taxonomy:propose', 'policy:propose')
  @RequireScope('admin:write')
  async transition(
    @CurrentPrincipal() principal: Principal,
    @Param('collection') collection: string,
    @Param('recordId') recordId: string,
    @Param('version') version: string,
    @Body(validate(lifecycleTransitionSchema)) body: LifecycleTransitionInput,
    @Headers('if-match') ifMatch: string | undefined,
    @CorrelationId() correlationId: string,
  ): Promise<VersionSummary> {
    const record = await this.records.transition({
      kind: kindFromPath(collection),
      principal,
      recordId,
      version: parseVersion(version),
      action: body.action,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      expectedRevision: parseIfMatch(ifMatch),
      now: new Date(),
      correlationId,
    });
    return toWire(record);
  }

  /**
   * Activate an approved version, through the SEC-05 gate.
   *
   * Returns **200 with the clearance** whether it passed or not, rather than a 403 on refusal.
   * A refusal is a result the administrator needs to read — which operation, which reason code,
   * which policy — and an error body that carries a single message would lose exactly that. The
   * record's state says what happened: `ACTIVE`, or back to `APPROVED` with the clearance
   * attached.
   */
  @Post(':collection/:recordId/versions/:version/activate')
  @RequirePermission('source:approve', 'taxonomy:approve', 'policy:approve')
  @RequireScope('admin:write')
  async activate(
    @CurrentPrincipal() principal: Principal,
    @Param('collection') collection: string,
    @Param('recordId') recordId: string,
    @Param('version') version: string,
    @Headers('if-match') ifMatch: string | undefined,
    @CorrelationId() correlationId: string,
  ): Promise<{ version: VersionSummary; clearance: RightsClearance; activated: boolean }> {
    const result = await this.records.activate({
      kind: kindFromPath(collection),
      principal,
      recordId,
      version: parseVersion(version),
      expectedRevision: parseIfMatch(ifMatch),
      now: new Date(),
      correlationId,
    });
    return {
      version: toWire(result.record),
      clearance: result.clearance,
      activated: result.record.status === 'ACTIVE',
    };
  }

  /**
   * The coverage statement for a jurisdiction.
   *
   * Readable by anyone who may read coverage — including an `auditor`, who has
   * `coverage:read` and nothing else. What the service cannot do in a country is not a secret;
   * hiding it is how a reviewer ends up believing an empty result was a search.
   */
  @Get('coverage/:jurisdiction')
  @RequirePermission('coverage:read')
  @RequireScope('admin:read')
  async coverageFor(@Param('jurisdiction') jurisdiction: string): Promise<CoverageStatementWire> {
    const statement = await this.coverage.statementFor({
      jurisdiction: jurisdiction.toUpperCase(),
      capabilities: [...CAPABILITIES],
      asOf: new Date(),
    });
    return statement as CoverageStatementWire;
  }

  /**
   * Declare or revise a capability's coverage status.
   *
   * `source:approve`, not `source:propose`: a coverage status is an assertion about what this
   * product can do in a country, and it reaches a reviewer's screen unmediated. It is closer to
   * approving a source than to drafting one.
   */
  @Put('coverage')
  @RequirePermission('source:approve')
  @RequireScope('admin:write')
  async declareCapability(
    @CurrentPrincipal() principal: Principal,
    @Body(validate(declareCapabilitySchema)) body: DeclareCapabilityInput,
  ): Promise<CoverageStatementWire> {
    if (!permissionsForRoles(principal.roles).has('source:approve')) {
      throw new ApiException('FORBIDDEN', 'Declaring coverage requires source:approve.');
    }
    await this.coverage.declare({
      jurisdiction: body.jurisdiction,
      capability: body.capability,
      status: body.status,
      rationale: body.rationale,
      ...(body.sourceIds === undefined ? {} : { sourceIds: body.sourceIds }),
      ...(body.evidenceRef === undefined ? {} : { evidenceRef: body.evidenceRef }),
      ...(body.blockedByDecision === undefined
        ? {}
        : { blockedByDecision: body.blockedByDecision }),
      declaredBy: principal.subject,
      now: new Date(),
    });
    const statement = await this.coverage.statementFor({
      jurisdiction: body.jurisdiction,
      capabilities: [...CAPABILITIES],
      asOf: new Date(),
    });
    return statement as CoverageStatementWire;
  }
}

function parseVersion(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApiException('VALIDATION_FAILED', 'version must be a positive integer.', {
      details: [{ path: 'version', message: 'not a version' }],
    });
  }
  return value;
}

/** Dates out as ISO strings, as everywhere else on the wire. */
function toWire(record: VersionedRecord): VersionSummary {
  return {
    kind: record.kind,
    recordId: record.recordId,
    versionId: record.versionId ?? '',
    version: record.version,
    tenantId: record.tenantId,
    status: record.status,
    content: record.content,
    rightsPolicy: record.rightsPolicy as VersionSummary['rightsPolicy'],
    dataProfile: record.dataProfile as VersionSummary['dataProfile'],
    rightsClearance: record.rightsClearance as VersionSummary['rightsClearance'],
    proposedBy: record.proposedBy ?? '',
    approvedBy: record.approvedBy,
    revision: record.revision,
    history: record.history.map((h) => ({
      action: h.action,
      from: h.from,
      to: h.to,
      actor: h.actor,
      reason: h.reason,
      at: h.at instanceof Date ? h.at.toISOString() : String(h.at),
    })),
    createdAt: record.createdAt?.toISOString() ?? '',
    updatedAt: record.updatedAt?.toISOString() ?? '',
    activatedAt: record.activatedAt?.toISOString() ?? null,
    supersededAt: record.supersededAt?.toISOString() ?? null,
  };
}

export { ADMIN_RECORD_KINDS };
