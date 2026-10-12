import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import {
  screenRequestSchema,
  type ScreenRequest,
  type ScreenResult,
} from '@adverse-search/contracts';
import type { Principal } from '@adverse-search/domain';

import { RequirePermission, RequireScope } from '../auth/auth.guard.js';
import { CurrentPrincipal } from '../common/principal.decorator.js';
import { validate } from '../common/zod-validation.pipe.js';
import type { AppConfig } from '../config/config.js';
import { requireTenant } from '../subjects/subjects.controller.js';
import { APP_CONFIG } from '../tokens.js';
import { diagnosticEnginesFor } from './local-diagnostic-request.js';
import { ScreenService } from './screen.service.js';

@Controller({ path: 'screen', version: '1' })
export class ScreenController {
  constructor(
    @Inject(ScreenService) private readonly screens: ScreenService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
  @RequirePermission('search:create')
  @RequireScope('search:write')
  async screen(
    @CurrentPrincipal() principal: Principal,
    @Body(validate(screenRequestSchema)) body: ScreenRequest,
    @Req() req: Request,
  ): Promise<ScreenResult> {
    // The same local Google diagnostic `POST /v1/searches` honours, decided the same way, so
    // this one endpoint can run every source — Google included, locally — and not most of them.
    const diagnosticEngines = diagnosticEnginesFor(this.config, {
      tenantId: requireTenant(principal),
      req,
      environment: body.environment,
    });
    return this.screens.screen({ principal, request: body, now: new Date(), diagnosticEngines });
  }
}
