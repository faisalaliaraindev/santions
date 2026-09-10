import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import {
  createSearchSchema,
  paginationQuerySchema,
  type CreateSearchInput,
  type SearchSummary,
} from '@erly/adverse-contracts';
import type { Principal } from '@erly/adverse-domain';

import { RequirePermission, RequireScope } from '../auth/auth.guard.js';
import { ApiException } from '../common/api-exception.js';
import { CurrentPrincipal } from '../common/principal.decorator.js';
import { validate } from '../common/zod-validation.pipe.js';
import { requireTenant } from '../subjects/subjects.controller.js';
import { IdempotencyService } from './idempotency.service.js';
import { SearchesService } from './searches.service.js';

const CREATE_SEARCH_OPERATION = 'POST /v1/searches';

@Controller({ path: 'searches', version: '1' })
export class SearchesController {
  constructor(
    @Inject(SearchesService) private readonly searches: SearchesService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * POST /v1/searches — accept a search, return 202 with a status URL (section 6.1).
   *
   * 202, not 200: the run is queued, and returning 200 with a result-shaped body would invite
   * a client to treat "accepted" as "completed with no findings".
   */
  @Post()
  @RequirePermission('search:create')
  @RequireScope('search:write')
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body(validate(createSearchSchema)) body: CreateSearchInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ searchId: string; statusUrl: string; execution: SearchSummary['execution'] }> {
    const tenantId = requireTenant(principal);
    const now = new Date();

    // Without a key there is no duplicate protection, so the simple path runs unguarded and
    // the client owns the consequences. With a key, exactly one run is committed (T22).
    if (idempotencyKey === undefined || idempotencyKey.trim() === '') {
      const created = await this.searches.create({ principal, data: body, now });
      res.status(202);
      return accepted(created);
    }

    const requestHash = IdempotencyService.hashRequest(body);
    const claim = await this.idempotency.claim({
      tenantId,
      key: idempotencyKey,
      operation: CREATE_SEARCH_OPERATION,
      requestHash,
      now,
    });

    if (claim.kind === 'REPLAY') {
      const existing = await this.searches.findById(tenantId, claim.resultId);
      res.status(200);
      return accepted(existing);
    }

    if (claim.kind === 'IN_FLIGHT') {
      // A concurrent identical request is still committing. Telling the caller to retry is
      // honest; inventing a second run to satisfy this one is not.
      throw new ApiException(
        'REVISION_CONFLICT',
        'An identical request is currently in flight. Retry shortly.',
        { internalDetail: `tenant=${tenantId} key=${idempotencyKey}` },
      );
    }

    try {
      const created = await this.searches.create({ principal, data: body, now });
      await this.idempotency.complete({
        tenantId,
        key: idempotencyKey,
        operation: CREATE_SEARCH_OPERATION,
        resultId: created.searchId,
        now,
      });
      res.status(202);
      return accepted(created);
    } catch (error) {
      // Release the claim so a corrected retry is not blocked by a dead reservation.
      await this.idempotency.release({
        tenantId,
        key: idempotencyKey,
        operation: CREATE_SEARCH_OPERATION,
      });
      throw error;
    }
  }

  @Get()
  @RequirePermission('search:read')
  @RequireScope('search:read')
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query(validate(paginationQuerySchema)) query: { limit: number; cursor?: string },
  ): Promise<{ items: SearchSummary[]; nextCursor: string | null }> {
    return this.searches.list({
      tenantId: requireTenant(principal),
      limit: query.limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }

  @Get(':searchId')
  @RequirePermission('search:read')
  @RequireScope('search:read')
  async findOne(
    @CurrentPrincipal() principal: Principal,
    @Param('searchId') searchId: string,
  ): Promise<SearchSummary> {
    return this.searches.findById(requireTenant(principal), searchId);
  }
}

function accepted(search: SearchSummary): {
  searchId: string;
  statusUrl: string;
  execution: SearchSummary['execution'];
} {
  return {
    searchId: search.searchId,
    statusUrl: `/v1/searches/${search.searchId}`,
    execution: search.execution,
  };
}
