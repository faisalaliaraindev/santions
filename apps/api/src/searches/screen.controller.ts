import { Body, Controller, Inject, Post } from '@nestjs/common';

import {
  screenRequestSchema,
  type ScreenRequest,
  type ScreenResult,
} from '@erly/adverse-contracts';
import type { Principal } from '@erly/adverse-domain';

import { RequirePermission, RequireScope } from '../auth/auth.guard.js';
import { CurrentPrincipal } from '../common/principal.decorator.js';
import { validate } from '../common/zod-validation.pipe.js';
import { ScreenService } from './screen.service.js';

@Controller({ path: 'screen', version: '1' })
export class ScreenController {
  constructor(@Inject(ScreenService) private readonly screens: ScreenService) {}

  @Post()
  @RequirePermission('search:create')
  @RequireScope('search:write')
  async screen(
    @CurrentPrincipal() principal: Principal,
    @Body(validate(screenRequestSchema)) body: ScreenRequest,
  ): Promise<ScreenResult> {
    return this.screens.screen({ principal, request: body, now: new Date() });
  }
}
