/**
 * Server-side validation from the shared contract schemas.
 *
 * Client-side validation improves the experience; it never substitutes for this (section 3.1).
 * Schemas are `.strict()`, so an unknown field is rejected rather than silently dropped — a
 * client sending `dateofBirth` should be told, not quietly screened without a date of birth.
 */

import { Injectable, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodTypeAny, type z } from 'zod';

import { ApiException } from './api-exception.js';

@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    try {
      return this.schema.parse(value) as z.infer<T>;
    } catch (error) {
      if (error instanceof ZodError) {
        const unknownKey = error.issues.find((i) => i.code === 'unrecognized_keys');
        const details = error.issues.map((i) => ({
          path: i.path.join('.') || '(root)',
          message: i.message,
        }));

        if (unknownKey !== undefined) {
          throw new ApiException('UNKNOWN_FIELD', 'The request contains unknown fields.', {
            details,
          });
        }
        throw new ApiException('VALIDATION_FAILED', 'The request failed validation.', { details });
      }
      throw error;
    }
  }
}

/** Convenience for route parameter decoration. */
export function validate<T extends ZodTypeAny>(schema: T): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
