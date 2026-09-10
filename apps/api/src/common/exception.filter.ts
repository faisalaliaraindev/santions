/**
 * The single exit point for every error.
 *
 * Two responsibilities:
 *
 *  - attach the correlation ID, so a caller reporting a failure can be traced;
 *  - make sure nothing unintended reaches the body. An unexpected exception becomes a generic
 *    500 with no message from the original error, because framework and driver errors
 *    routinely contain connection strings, query fragments and file paths (SEC-04).
 */

import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import type { ApiErrorBody } from '@erly/adverse-contracts';

import { ApiException } from './api-exception.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Api');

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const correlationId = request.correlationId ?? '';

    if (exception instanceof ApiException) {
      const body = { ...(exception.getResponse() as ApiErrorBody), correlationId };
      // The internal detail is logged, never serialised.
      this.logger.warn(
        `${request.method} ${request.path} → ${body.code} [${correlationId}] ${exception.internalDetail ?? ''}`,
      );
      response.status(exception.getStatus()).json(body);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body: ApiErrorBody = {
        code: status === 404 ? 'NOT_FOUND' : 'VALIDATION_FAILED',
        message: status === 404 ? 'Not found.' : 'The request could not be processed.',
        correlationId,
        retryable: false,
      };
      response.status(status).json(body);
      return;
    }

    // Unexpected. Log everything, return nothing.
    this.logger.error(
      `${request.method} ${request.path} → unhandled [${correlationId}]`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    const body: ApiErrorBody = {
      code: 'INTERNAL',
      message: 'An internal error occurred.',
      correlationId,
      retryable: true,
    };
    response.status(500).json(body);
  }
}
