/**
 * Correlation IDs.
 *
 * Every response and every log line carries one, so an operator can follow a request through
 * the API, the queue and the workers. Deliberately opaque and generated server-side: a
 * client-supplied ID would let a caller poison another tenant's log correlation.
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = randomUUID();
  req.correlationId = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  next();
}
