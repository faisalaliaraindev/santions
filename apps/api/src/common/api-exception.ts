/**
 * The one way this service returns an error.
 *
 * Every failure goes through here so status codes, retryability and the safe-error contract
 * cannot drift between routes. A stack trace, a source secret or evidence text never reaches
 * a response body (section 6.1, SEC-04).
 */

import { HttpException } from '@nestjs/common';

import {
  isRetryable,
  statusForErrorCode,
  type ApiErrorBody,
  type ErrorCode,
} from '@erly/adverse-contracts';

export class ApiException extends HttpException {
  readonly code: ErrorCode;
  /** Logged, never serialised to the client. */
  readonly internalDetail: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      readonly correlationId?: string;
      readonly details?: readonly { path: string; message: string }[];
      readonly internalDetail?: string;
    } = {},
  ) {
    const body: ApiErrorBody = {
      code,
      message,
      correlationId: options.correlationId ?? '',
      retryable: isRetryable(code),
      ...(options.details === undefined ? {} : { details: [...options.details] }),
    };
    super(body, statusForErrorCode(code));
    this.code = code;
    this.internalDetail = options.internalDetail;
  }

  /**
   * A deliberately non-enumerating "not found".
   *
   * An unauthorised read and a genuinely missing record return the same response, so a caller
   * cannot map another tenant's ID space by watching which IDs 403 and which 404 (section 6.1).
   */
  static notFound(resource: string, internalDetail?: string): ApiException {
    return new ApiException('NOT_FOUND', `${resource} not found.`, {
      ...(internalDetail === undefined ? {} : { internalDetail }),
    });
  }
}
