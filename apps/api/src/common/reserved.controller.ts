import { All, Controller } from '@nestjs/common';

import { ApiException } from './api-exception.js';
import { RequirePermission } from '../auth/auth.guard.js';

/**
 * FR-15 reserved endpoints.
 *
 * The commercial layer — plan CRUD, usage ledger, overage rules, tenant self-service keys —
 * is deferred by decision D-007. These paths are reserved and return **501 with a documented
 * reason**, so the gap is visible to an integrator rather than looking like a 404 they should
 * work around.
 */
@Controller({ version: '1' })
export class ReservedController {
  @All('admin/plans')
  @RequirePermission('entitlement:manage')
  plans(): never {
    throw new ApiException(
      'NOT_IMPLEMENTED',
      'Plan management is deferred. See decision D-007 (FR-15): this phase builds entitlement seams only.',
    );
  }

  @All('admin/tenants/:tenantId/usage')
  @RequirePermission('entitlement:manage')
  tenantUsage(): never {
    throw new ApiException(
      'NOT_IMPLEMENTED',
      'Usage metering is deferred. Counters are recorded but not yet exposed or billed (decision D-007).',
    );
  }

  @All('tenant/usage')
  @RequirePermission('tenant:manage')
  ownUsage(): never {
    throw new ApiException(
      'NOT_IMPLEMENTED',
      'Tenant usage reporting is deferred (decision D-007).',
    );
  }

  @All('tenant/api-keys')
  @RequirePermission('tenant:manage')
  ownApiKeys(): never {
    throw new ApiException(
      'NOT_IMPLEMENTED',
      'Tenant self-service key management is deferred. Keys are provider-managed in this phase (decision D-007).',
    );
  }
}
