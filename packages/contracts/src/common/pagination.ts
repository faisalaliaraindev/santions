/**
 * Section 6.1 — cursor pagination.
 *
 * A frozen report must paginate without duplicating or dropping items. Offset pagination
 * cannot promise that when the underlying set can change, so the cursor encodes a stable
 * ordering key rather than a position.
 */

import { z } from 'zod';

export const paginationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    /** Opaque. Clients must not construct or parse one. */
    cursor: z.string().max(500).optional(),
  })
  .strict();

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      items: z.array(item),
      /** Null when this is the last page. */
      nextCursor: z.string().nullable(),
    })
    .strict();
}
