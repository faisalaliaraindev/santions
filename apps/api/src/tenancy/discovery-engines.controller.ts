/**
 * `GET/PUT/DELETE /v1/tenant/discovery/engines` — a tenant chooses which media engines are used.
 *
 * # What this controls, and what it cannot
 *
 * It sets a **switch** per engine: may this service query that engine on this tenant's searches?
 * A coverage preference, and theirs.
 *
 * It cannot set `governanceStatus` — the platform's reading of that engine's upstream terms of
 * use. That is not in the request schema, not writable by any route, and platform-wide because
 * somebody else's terms do not vary by customer. Every response carries it beside the switch, so
 * a caller turning an engine on is shown what is known about it. `effectiveEnabled` is computed
 * separately and remains false for `REFUSED`, whatever the tenant switch says.
 *
 * The separation is the point. A single field would mean a customer preference silently
 * rewriting a legal reading, and the next person to look would find an engine marked
 * `PERMITTED` with nobody's name against the decision.
 *
 * # Every engine is always listed
 *
 * `GET` returns the whole matrix — switched on, switched off, and refused alike. An engine that
 * disappeared from this list when it was disabled would be an engine a customer could not
 * discover, and "why is Google not in my results?" would have no answer here either. The same
 * rule the diagnostics follow: a disabled engine is a visible, explained zero rather than a gap.
 *
 * # Tenant scoping
 *
 * The tenant comes from the authenticated principal. There is no tenant field in any body to
 * ignore, and `requireTenant` fails closed on a principal without one rather than treating it as
 * "any tenant" (SEC-01).
 *
 * # Why a reason is required
 *
 * `reason` is required and non-empty on every write, and it is written to the audit trail with
 * the calling principal. Switching an engine on accepts that this service will query a third
 * party on this tenant's behalf. A settings row that cannot say why it was set is not a record of
 * a decision — it is a value that appeared, and six months later nobody can tell whether it was
 * chosen or defaulted.
 */

import { Body, Controller, Delete, Get, Inject, Param, Put } from '@nestjs/common';

import {
  setDiscoveryEngineSchema,
  type DiscoveryEngineList,
  type DiscoveryEngineSetting,
  type SetDiscoveryEngine,
} from '@adverse-search/contracts';
import type { Principal } from '@adverse-search/domain';

import { RequirePermission, RequireScope } from '../auth/auth.guard.js';
import { ApiException } from '../common/api-exception.js';
import { CurrentPrincipal } from '../common/principal.decorator.js';
import { validate } from '../common/zod-validation.pipe.js';
import { AuditService } from '../persistence/audit.service.js';
import { TransactionRunner } from '../persistence/transaction.runner.js';
import {
  EngineEnablementService,
  type ResolvedEngine,
} from '../sources/searxng/engine-enablement.service.js';
import { requireTenant } from '../subjects/subjects.controller.js';

@Controller({ path: 'tenant/discovery/engines', version: '1' })
export class DiscoveryEnginesController {
  constructor(
    @Inject(EngineEnablementService) private readonly engines: EngineEnablementService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TransactionRunner) private readonly transactions: TransactionRunner,
  ) {}

  /**
   * The whole matrix for this tenant.
   *
   * Read with the ordinary tenant-admin permission rather than a source-admin one: choosing your
   * own media coverage is a customer decision, not a platform one.
   */
  @Get()
  @RequirePermission('apikey:manage')
  @RequireScope('admin:read')
  async list(@CurrentPrincipal() principal: Principal): Promise<DiscoveryEngineList> {
    const tenantId = requireTenant(principal);
    const engines = await this.engines.resolveFor(tenantId);
    return this.page(engines);
  }

  /** Switch one engine on or off for this tenant. */
  @Put(':engine')
  @RequirePermission('apikey:manage')
  @RequireScope('admin:write')
  async set(
    @CurrentPrincipal() principal: Principal,
    @Param('engine') engine: string,
    @Body(validate(setDiscoveryEngineSchema)) body: SetDiscoveryEngine,
  ): Promise<DiscoveryEngineSetting> {
    const tenantId = requireTenant(principal);
    const now = new Date();

    // The switch and its audit entry commit together. A row written without its entry is a
    // coverage decision nobody can attribute; an entry written without its row is a record of
    // something that did not happen. Neither is acceptable, so neither can occur alone.
    const resolved = await this.transactions.run(
      async (session) => {
        const applied = await this.engines.setFor({
          tenantId,
          engine,
          enabled: body.enabled,
          changedBy: principal.subject,
          reason: body.reason,
          now,
          session,
        });
        if (applied === null) {
          return null;
        }

        // Audited whichever way the switch moved. Turning an engine OFF is as much a coverage
        // decision as turning one on — a later reviewer asking why a search found nothing needs
        // to see that the engine was disabled, by whom and why.
        await this.audit.append(
          {
            tenantId,
            actor: {
              type: principal.kind === 'MACHINE' ? 'MACHINE' : 'USER',
              subject: principal.subject,
              clientId: null,
            },
            action: body.enabled ? 'discovery.engine.enabled' : 'discovery.engine.disabled',
            target: { type: 'DISCOVERY_ENGINE', id: applied.engine, version: null },
            reason: body.reason,
            result: 'ALLOWED',
            now,
          },
          session,
        );
        return applied;
      },
      { name: 'discovery.engine.set' },
    );

    if (resolved === null) {
      throw new ApiException(
        'NOT_FOUND',
        `No discovery engine named "${engine}". This service integrates a fixed set; GET this ` +
          `collection for the list.`,
        { internalDetail: `tenant=${tenantId} engine=${engine}` },
      );
    }

    return this.toDto(resolved);
  }

  /** Drop this tenant's preference, returning the engine to the platform default. */
  @Delete(':engine')
  @RequirePermission('apikey:manage')
  @RequireScope('admin:write')
  async clear(
    @CurrentPrincipal() principal: Principal,
    @Param('engine') engine: string,
  ): Promise<DiscoveryEngineSetting> {
    const tenantId = requireTenant(principal);
    const now = new Date();
    const resolved = await this.transactions.run(
      async (session) => {
        const applied = await this.engines.clearFor({ tenantId, engine, session });
        if (applied === null) {
          return null;
        }
        await this.audit.append(
          {
            tenantId,
            actor: {
              type: principal.kind === 'MACHINE' ? 'MACHINE' : 'USER',
              subject: principal.subject,
              clientId: null,
            },
            action: 'discovery.engine.reset',
            target: { type: 'DISCOVERY_ENGINE', id: applied.engine, version: null },
            reason: `Returned to the platform default of ${String(
              applied.defaultEnabledForDiscovery,
            )}.`,
            result: 'ALLOWED',
            now,
          },
          session,
        );
        return applied;
      },
      { name: 'discovery.engine.reset' },
    );

    if (resolved === null) {
      throw new ApiException('NOT_FOUND', `No discovery engine named "${engine}".`, {
        internalDetail: `tenant=${tenantId} engine=${engine}`,
      });
    }
    return this.toDto(resolved);
  }

  private page(engines: readonly ResolvedEngine[]): DiscoveryEngineList {
    return {
      engines: engines.map((engine) => this.toDto(engine)),
      enabledCount: engines.filter((engine) => engine.effectiveEnabled).length,
    };
  }

  /**
   * The wire shape.
   *
   * Field by field rather than a spread, so that adding a field to the internal record does not
   * silently publish it. The three optional fields are omitted rather than nulled when the
   * platform default applies: absent means "nobody has set this", and a null `changedBy` would
   * read as "somebody set it and we lost their name".
   */
  private toDto(engine: ResolvedEngine): DiscoveryEngineSetting {
    return {
      engine: engine.engine,
      searxngEngineName: engine.searxngEngineName,
      integrated: engine.integrated,
      tenantEnabled: engine.tenantEnabled,
      effectiveEnabled: engine.effectiveEnabled,
      configuredByTenant: engine.configuredByTenant,
      defaultEnabledForDiscovery: engine.defaultEnabledForDiscovery,
      governanceStatus: engine.governanceStatus as DiscoveryEngineSetting['governanceStatus'],
      decisionId: engine.decisionId,
      reviewedAt: engine.reviewedAt,
      reviewedBy: engine.reviewedBy,
      usesPublisherDocumentedApi: engine.usesPublisherDocumentedApi,
      evidenceNote: engine.evidenceNote,
      ...(engine.changedBy === undefined ? {} : { changedBy: engine.changedBy }),
      ...(engine.reason === undefined ? {} : { reason: engine.reason }),
      ...(engine.changedAt === undefined ? {} : { changedAt: engine.changedAt }),
    };
  }
}
