import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';

import { createSubjectSchema, type SubjectVersion } from '@erly/adverse-contracts';
import type { Principal } from '@erly/adverse-domain';

import { RequirePermission } from '../auth/auth.guard.js';
import { CurrentPrincipal } from '../common/principal.decorator.js';
import { ApiException } from '../common/api-exception.js';
import { validate } from '../common/zod-validation.pipe.js';
import { SubjectsService } from './subjects.service.js';

@Controller({ path: 'subjects', version: '1' })
export class SubjectsController {
  constructor(@Inject(SubjectsService) private readonly subjects: SubjectsService) {}

  /** POST /v1/subjects — create a service-owned scoped identity snapshot (section 6.1). */
  @Post()
  @RequirePermission('search:create')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body(validate(createSubjectSchema)) body: unknown,
  ): Promise<SubjectVersion> {
    return this.subjects.create({
      tenantId: requireTenant(principal),
      data: body as Parameters<SubjectsService['create']>[0]['data'],
      now: new Date(),
    });
  }

  @Get(':subjectId/versions/:version')
  @RequirePermission('search:read')
  async findVersion(
    @CurrentPrincipal() principal: Principal,
    @Param('subjectId') subjectId: string,
    @Param('version') version: string,
  ): Promise<SubjectVersion> {
    const parsed = Number.parseInt(version, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new ApiException('VALIDATION_FAILED', 'Version must be a positive integer.');
    }
    return this.subjects.findVersion({
      tenantId: requireTenant(principal),
      subjectId,
      version: parsed,
    });
  }
}

/** Missing tenant context fails closed; it is never treated as "any tenant" (SEC-01). */
export function requireTenant(principal: Principal): string {
  if (principal.tenantId === null) {
    throw new ApiException('FORBIDDEN', 'Access denied.', {
      internalDetail: 'Tenant-scoped route reached without an authenticated tenant context.',
    });
  }
  return principal.tenantId;
}
