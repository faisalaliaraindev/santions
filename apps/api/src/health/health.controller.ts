import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';

import type { DependencyHealth, HealthStatus } from '@erly/adverse-contracts';

import { Public, RequirePermission } from '../auth/auth.guard.js';

/**
 * Health endpoints (section 6.1).
 *
 * Liveness and readiness are public because a load balancer cannot authenticate. They return
 * the minimum: whether the process is alive and whether it will accept traffic. **Detailed
 * dependency state is exposed only to authorised operators** — a public endpoint listing
 * which database is down tells an attacker where to push.
 */
/**
 * Version-neutral on purpose. A load balancer probing liveness should not have to know which
 * API version is deployed, and a version bump must not silently turn every health probe into
 * a 404 — which reads as "the service is down" to anything watching.
 */
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  @Get('health/live')
  @Public()
  live(): HealthStatus {
    return { status: 'ok' };
  }

  @Get('health/ready')
  @Public()
  ready(): HealthStatus {
    return { status: 'ok' };
  }

  // Part of the versioned API surface: this one returns operator-visible detail, so it is
  // governed by the same compatibility promise as any other route.
  @Get('v1/health/dependencies')
  @RequirePermission('platform:read_health')
  dependencies(): DependencyHealth {
    return {
      status: 'ok',
      note: 'Detailed dependency probes are added with the persistence layer in Phase C.',
    };
  }
}
