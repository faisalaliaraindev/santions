/**
 * `POST/GET/DELETE /v1/tenant/api-keys` — a tenant issues, pauses and revokes its own machine
 * keys.
 *
 * # Off for now, and off for good, are different routes
 *
 * `POST .../{keyId}/disable` and `.../enable` move a reversible `disabledAt`. `DELETE` sets a
 * one-way `revokedAt`. Both stop the key authenticating; only one of them can be undone, and
 * that is the entire distinction (I4). A single switch would have to be either reversible — so
 * a leaked secret could be turned back on — or permanent — so pausing an integration for an
 * afternoon destroys the credential. Neither is acceptable, so there are two.
 *
 * Replaces the `501` this path used to return. D-007 deferred self-service while keys were
 * provider-managed; **D-050** records that they no longer are, because a tenant that cannot
 * rotate its own credential without a human on the provider's side ends up not rotating it.
 *
 * # The three things self-service must not become
 *
 * **1. A path to privilege.** A key may carry only roles the caller already holds. Without that
 * rule the weakest `tenant_admin` credential mints a `platform_admin` one and the role model is
 * decoration. The check is against the *caller's* roles, not against what is merely a valid role
 * name.
 *
 * **2. A way across a tenant boundary.** The tenant is taken from the authenticated principal.
 * There is no tenant field in the request body to ignore, and `requireTenant` fails closed on a
 * principal without one rather than treating it as "any tenant" (SEC-01).
 *
 * **3. A way into the live environment.** Three independent conditions, all required: the
 * tenant's entitlement must include `live`, the calling credential must itself be live, and the
 * tenant's own state must permit live today — which for a self-signed-up tenant means the
 * contact address has been confirmed (D-052). That third condition is read from tenant state by
 * `decideLiveAccess` rather than written into this route, so the payment gate D-053 defers can
 * be turned on by writing a value instead of by finding every tenant created before it existed.
 * Entitlement is a commercial act by the provider — self-service issues credentials *within*
 * what was sold; it does not sell. The second condition stops a sandbox credential minting a
 * live one, which would make the sandbox/live split a formality (T62).
 *
 * # The secret
 *
 * Returned once, in the creation response, and never again. Only a hash is stored, so no
 * endpoint can return it a second time and no support process can recover it. That is the point:
 * a credential the provider can read back is one the provider can leak.
 */

import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';

import {
  createApiKeySchema,
  disableApiKeySchema,
  enableApiKeySchema,
  revokeApiKeySchema,
  type ApiKeySummary,
  type CreateApiKeyInput,
  type DisableApiKeyInput,
  type EnableApiKeyInput,
  type IssuedApiKeyResponse,
  type RevokeApiKeyInput,
} from '@adverse-search/contracts';
import { scopesForRoles, type MachineScope, type Principal, type Role } from '@adverse-search/domain';

import { RequirePermission, RequireScope } from '../auth/auth.guard.js';
import { ApiException } from '../common/api-exception.js';
import { CurrentPrincipal } from '../common/principal.decorator.js';
import { validate } from '../common/zod-validation.pipe.js';
import { requireTenant } from '../subjects/subjects.controller.js';
import { ApiKeyError, ApiKeyService } from './api-key.service.js';
import { EntitlementsService } from './entitlements.service.js';
import { decideLiveAccess } from './live-access.js';

const DAY_MS = 24 * 60 * 60 * 1000;

@Controller({ path: 'tenant/api-keys', version: '1' })
export class TenantApiKeysController {
  constructor(
    @Inject(ApiKeyService) private readonly keys: ApiKeyService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  @Post()
  @RequirePermission('apikey:manage')
  @RequireScope('admin:write')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body(validate(createApiKeySchema)) body: CreateApiKeyInput,
  ): Promise<IssuedApiKeyResponse> {
    const tenantId = requireTenant(principal);
    const now = new Date();

    // No escalation. Named individually in the message, because "forbidden" sends an integrator
    // to re-read the role table when the answer is which specific role they were missing.
    const held = new Set<Role>(principal.roles);
    const overreach = body.roles.filter((role) => !held.has(role));
    if (overreach.length > 0) {
      throw new ApiException(
        'FORBIDDEN',
        `A key cannot carry roles you do not hold yourself: ${overreach.join(', ')}.`,
        {
          internalDetail:
            `tenant=${tenantId} caller=${principal.subject} ` +
            `holds=[${principal.roles.join(', ')}] requested=[${body.roles.join(', ')}]`,
        },
      );
    }

    if (body.environment === 'live') {
      // A sandbox credential cannot mint a live one, whatever the body asks for (T62).
      if (principal.environment === 'sandbox') {
        throw new ApiException(
          'SANDBOX_CANNOT_ACCESS_LIVE',
          'A sandbox credential cannot issue a live key. Ask the provider for live access.',
          { internalDetail: `tenant=${tenantId} caller=${principal.subject}` },
        );
      }
      // And the tenant must actually be sold the live environment. This throws
      // SANDBOX_CANNOT_ACCESS_LIVE with a message naming the entitlement.
      const entitlement = await this.entitlements.assertCapability({
        tenantId,
        capability: 'adverse_media',
        environment: 'live',
      });

      // Then the tenant's own state has to permit it (I1). The entitlement says what was
      // granted; this says whether the tenant has done what the grant is conditional on — today
      // that is D-052's confirmed contact address, and a later payment gate is another value
      // read by the same function. Deliberately not an `if` written here: a gate added to this
      // route later would have to be applied retrospectively to every tenant issued a live key
      // while there was none, and that hunt is the expensive part, not the check.
      const tenant = await this.entitlements.findTenant(tenantId);
      const liveAccess = decideLiveAccess({ tenant, entitlement });
      if (!liveAccess.granted) {
        throw new ApiException('SANDBOX_CANNOT_ACCESS_LIVE', liveAccess.detail, {
          internalDetail: `tenant=${tenantId} live refused: ${liveAccess.blockedBy}`,
        });
      }
    }

    // Scopes narrow a key below its roles and never widen it, so an explicit list is intersected
    // with what the roles could use rather than trusted. Asking for more than the roles allow is
    // refused rather than silently trimmed: a key quietly narrower than requested is a support
    // ticket that starts "it worked yesterday".
    const derived = scopesForRoles(body.roles);
    const scopes: MachineScope[] = body.scopes ?? derived;
    const beyond = scopes.filter((scope) => !derived.includes(scope));
    if (beyond.length > 0) {
      throw new ApiException(
        'INVALID_SCOPE',
        `Scope(s) ${beyond.join(', ')} are not available to the roles requested. ` +
          `Those roles grant: ${derived.join(', ')}.`,
        { internalDetail: `tenant=${tenantId} roles=[${body.roles.join(', ')}]` },
      );
    }

    const expiresAt =
      body.expiresInDays === null ? null : new Date(now.getTime() + body.expiresInDays * DAY_MS);

    const issued = await this.keys.create({
      tenantId,
      environment: body.environment,
      label: body.label,
      roles: body.roles,
      scopes,
      createdBy: principal.subject,
      expiresAt,
      now,
    });

    return {
      keyId: issued.keyId,
      secret: issued.secret,
      environment: issued.environment,
      label: body.label,
      roles: body.roles,
      scopes,
      createdAt: now.toISOString(),
      expiresAt: expiresAt?.toISOString() ?? null,
      warning:
        'This secret is shown once and is not recoverable. Only a hash is stored, so it cannot ' +
        'be read back by you or by the provider. Store it now; if it is lost, revoke this key ' +
        'and issue another.',
    };
  }

  /** Every key this tenant holds. No secrets, and no hash of one. */
  @Get()
  @RequirePermission('apikey:manage')
  @RequireScope('admin:read')
  async list(@CurrentPrincipal() principal: Principal): Promise<{ items: ApiKeySummary[] }> {
    const tenantId = requireTenant(principal);
    const now = new Date();
    const records = await this.keys.listForTenant(tenantId);

    return {
      items: records.map((record) => ({
        keyId: record.keyId,
        label: record.label,
        environment: record.environment,
        roles: record.roles as ApiKeySummary['roles'],
        scopes: record.scopes as ApiKeySummary['scopes'],
        createdAt: record.createdAt.toISOString(),
        createdBy: record.createdBy,
        lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
        expiresAt: record.expiresAt?.toISOString() ?? null,
        disabledAt: record.disabledAt?.toISOString() ?? null,
        disabledReason: record.disabledReason ?? null,
        revokedAt: record.revokedAt?.toISOString() ?? null,
        revokedReason: record.revokedReason,
        // Derived rather than stored: an expiry that passed while nothing was running still
        // expired, and a status field written at creation would say otherwise.
        //
        // A key can be in more than one of these states at once, and one field can only name
        // one. The order is what the holder must do about it, most permanent first: revoked and
        // expired both mean "issue a new one", disabled means "turn it back on". So a key that
        // was paused and has since expired reads EXPIRED — enabling it would not make it work —
        // and `disabledAt` above still says it was paused.
        status:
          record.revokedAt !== null
            ? 'REVOKED'
            : record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()
              ? 'EXPIRED'
              : (record.disabledAt ?? null) !== null
                ? 'DISABLED'
                : 'ACTIVE',
      })),
    };
  }

  /**
   * Revoke one of this tenant's keys. Immediate, irreversible, and audited with the reason.
   *
   * The tenant check is the point of the lookup: without it, a `keyId` from another tenant would
   * be revocable by anyone who could guess one. A key that is not this tenant's is reported as
   * `NOT_FOUND` rather than `FORBIDDEN`, because the second confirms it exists.
   */
  @Delete(':keyId')
  @RequirePermission('apikey:manage')
  @RequireScope('admin:write')
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('keyId') keyId: string,
    @Body(validate(revokeApiKeySchema)) body: RevokeApiKeyInput,
  ): Promise<{ keyId: string; revoked: true }> {
    await this.assertOwned(principal, keyId);

    await this.keys.revoke({ keyId, actor: principal.subject, reason: body.reason });
    return { keyId, revoked: true };
  }

  /**
   * Switch one of this tenant's keys off — reversibly (I4).
   *
   * This is the routine one: pausing an integration, parking a key during a rotation, taking
   * something out of service while a question is answered. The key stops authenticating
   * immediately, exactly as a revoked one does, and `POST .../enable` brings it back.
   *
   * **It is not for a leaked secret.** Anything that can be undone is the wrong answer to a
   * credential someone else now holds — use `DELETE`, which cannot be. That is why the two are
   * separate fields and separate routes rather than one switch with a flag.
   *
   * Idempotent, so a client that retries a timeout does not get an error for a state it already
   * achieved; a revoked key answers **409**, because revocation is terminal and pretending to
   * disable it would imply `enable` could undo it.
   */
  @Post(':keyId/disable')
  // 200, not Nest's default 201 for a POST: nothing is created here. A `Created` on a route
  // that only moves a flag is the kind of small untruth an integrator writes a branch around.
  @HttpCode(200)
  @RequirePermission('apikey:manage')
  @RequireScope('admin:write')
  async disable(
    @CurrentPrincipal() principal: Principal,
    @Param('keyId') keyId: string,
    @Body(validate(disableApiKeySchema)) body: DisableApiKeyInput,
  ): Promise<{ keyId: string; disabled: true }> {
    const tenantId = await this.assertOwned(principal, keyId);

    try {
      await this.keys.disable({ keyId, actor: principal.subject, reason: body.reason });
    } catch (error) {
      this.rethrow(error, tenantId, keyId, 'disabled');
    }
    return { keyId, disabled: true };
  }

  /**
   * Turn a disabled key back on. The same secret works again immediately.
   *
   * A revoked key answers **409** rather than coming back to life. The reason is recorded in the
   * audit trail beside the disabling it undoes, so the pause reads as a pair of events with an
   * actor on each rather than as a gap nobody can account for.
   */
  @Post(':keyId/enable')
  @HttpCode(200)
  @RequirePermission('apikey:manage')
  @RequireScope('admin:write')
  async enable(
    @CurrentPrincipal() principal: Principal,
    @Param('keyId') keyId: string,
    @Body(validate(enableApiKeySchema)) body: EnableApiKeyInput,
  ): Promise<{ keyId: string; disabled: false }> {
    const tenantId = await this.assertOwned(principal, keyId);

    try {
      await this.keys.enable({ keyId, actor: principal.subject, reason: body.reason });
    } catch (error) {
      this.rethrow(error, tenantId, keyId, 'enabled');
    }
    return { keyId, disabled: false };
  }

  /**
   * The key must be this tenant's, and saying so is the whole point of the lookup.
   *
   * Without it, a `keyId` from another tenant would be disabled — or enabled — by anyone who
   * could guess one. A key that is not this tenant's answers `NOT_FOUND` rather than
   * `FORBIDDEN`, because the second confirms it exists.
   */
  private async assertOwned(principal: Principal, keyId: string): Promise<string> {
    const tenantId = requireTenant(principal);
    const owned = await this.keys.listForTenant(tenantId);
    if (!owned.some((record) => record.keyId === keyId)) {
      throw new ApiException('NOT_FOUND', 'No such API key.', {
        internalDetail: `tenant=${tenantId} keyId=${keyId} is not this tenant's`,
      });
    }
    return tenantId;
  }

  /**
   * The only `ApiKeyError` these two routes can raise after the ownership check is `REVOKED` —
   * `UNKNOWN` is impossible, because the key was just found in this tenant's list. It is a 409
   * rather than a 404 or a 403: the key exists and is yours, and the state it is in is the
   * reason the call cannot be honoured.
   */
  private rethrow(error: unknown, tenantId: string, keyId: string, verb: string): never {
    if (error instanceof ApiKeyError && error.rejection === 'REVOKED') {
      throw new ApiException(
        'ALREADY_TERMINAL',
        `This key has been revoked. Revocation is permanent, so it cannot be ${verb}. ` +
          'Issue a new key.',
        { internalDetail: `tenant=${tenantId} keyId=${keyId} is revoked` },
      );
    }
    throw error;
  }
}
