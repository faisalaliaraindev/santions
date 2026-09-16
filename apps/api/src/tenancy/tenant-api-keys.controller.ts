/**
 * `POST/GET/DELETE /v1/tenant/api-keys` — a tenant issues and revokes its own machine keys.
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
 * **3. A way into the live environment.** Two independent conditions, both required: the
 * tenant's entitlement must include `live`, and the calling credential must itself be live.
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

import { Body, Controller, Delete, Get, Inject, Param, Post } from '@nestjs/common';

import {
  createApiKeySchema,
  revokeApiKeySchema,
  type ApiKeySummary,
  type CreateApiKeyInput,
  type IssuedApiKeyResponse,
  type RevokeApiKeyInput,
} from '@erly/adverse-contracts';
import { scopesForRoles, type MachineScope, type Principal, type Role } from '@erly/adverse-domain';

import { RequirePermission, RequireScope } from '../auth/auth.guard.js';
import { ApiException } from '../common/api-exception.js';
import { CurrentPrincipal } from '../common/principal.decorator.js';
import { validate } from '../common/zod-validation.pipe.js';
import { requireTenant } from '../subjects/subjects.controller.js';
import { ApiKeyService } from './api-key.service.js';
import { EntitlementsService } from './entitlements.service.js';

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
      await this.entitlements.assertCapability({
        tenantId,
        capability: 'adverse_media',
        environment: 'live',
      });
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
        revokedAt: record.revokedAt?.toISOString() ?? null,
        revokedReason: record.revokedReason,
        // Derived rather than stored: an expiry that passed while nothing was running still
        // expired, and a status field written at creation would say otherwise.
        status:
          record.revokedAt !== null
            ? 'REVOKED'
            : record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()
              ? 'EXPIRED'
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
    const tenantId = requireTenant(principal);

    const owned = await this.keys.listForTenant(tenantId);
    if (!owned.some((record) => record.keyId === keyId)) {
      throw new ApiException('NOT_FOUND', 'No such API key.', {
        internalDetail: `tenant=${tenantId} keyId=${keyId} is not this tenant's`,
      });
    }

    await this.keys.revoke({ keyId, actor: principal.subject, reason: body.reason });
    return { keyId, revoked: true };
  }
}
