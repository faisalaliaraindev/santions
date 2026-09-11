import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';

import {
  cancelSearchSchema,
  createSearchSchema,
  paginationQuerySchema,
  type CancelSearchInput,
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
    @Res({ passthrough: true }) res: Response,
  ): Promise<SearchSummary> {
    const search = await this.searches.findById(requireTenant(principal), searchId);
    // The revision, as an ETag, so the caller has something to put in `If-Match`. A concurrency
    // scheme the client cannot see is one the client cannot take part in (matrix row FI-13).
    res.setHeader('ETag', `"${String(search.revision)}"`);
    return search;
  }

  /**
   * POST /v1/searches/:searchId/cancel — stop a run, against the revision last read.
   *
   * `If-Match` is **required**, not optional. Making it optional would mean the common path is
   * the unguarded one, and an unconditional cancellation is a decision taken on state the
   * caller may never have seen. A missing header is a 400 here rather than a silent overwrite.
   */
  @Post(':searchId/cancel')
  @RequirePermission('search:cancel')
  @RequireScope('search:write')
  async cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('searchId') searchId: string,
    @Body(validate(cancelSearchSchema)) body: CancelSearchInput,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<SearchSummary> {
    return this.searches.cancel({
      principal,
      searchId,
      expectedRevision: parseIfMatch(ifMatch),
      data: body,
      now: new Date(),
    });
  }
}

/**
 * Read a revision out of `If-Match`.
 *
 * Accepts both the quoted ETag form the server emits and a bare number, because a client that
 * echoes exactly what it was given and a client that sends the number it parsed are both
 * behaving reasonably. Anything else is rejected rather than coerced: `Number('')` is 0 and
 * `Number('abc')` is NaN, and a revision silently becoming 0 would fail the fence with a
 * conflict that misdescribes what happened.
 */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined || header.trim() === '') {
    throw new ApiException(
      'VALIDATION_FAILED',
      'If-Match is required. Send the revision from the last read of this search.',
      { details: [{ path: 'If-Match', message: 'required' }] },
    );
  }

  const unquoted = header
    .trim()
    .replace(/^W\//, '')
    .replace(/^"(.*)"$/, '$1');
  if (!/^[0-9]+$/.test(unquoted)) {
    throw new ApiException('VALIDATION_FAILED', 'If-Match must carry a revision number.', {
      details: [{ path: 'If-Match', message: 'not a revision' }],
    });
  }

  const revision = Number(unquoted);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new ApiException('VALIDATION_FAILED', 'If-Match must carry a revision number.', {
      details: [{ path: 'If-Match', message: 'not a revision' }],
    });
  }
  return revision;
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
