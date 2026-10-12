import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { Principal } from '@adverse-search/domain';

import { ApiException } from './api-exception.js';

/**
 * The authenticated caller.
 *
 * Throws rather than returning undefined if the guard did not populate it. A route that reads
 * a principal on an unauthenticated path is a bug, and returning undefined would let it
 * proceed with `principal?.tenantId` quietly equal to nothing.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.principal === undefined) {
      throw new ApiException('UNAUTHENTICATED', 'Authentication is required.');
    }
    return request.principal;
  },
);

/** The server-generated correlation ID for this request. */
export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    context.switchToHttp().getRequest<Request>().correlationId ?? '',
);
