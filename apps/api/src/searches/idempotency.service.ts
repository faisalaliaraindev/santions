/**
 * FR-12 — HTTP-layer duplicate control (tests T22, T23).
 *
 * "Tenant/client-scoped idempotency key; same canonical request returns the same operation,
 * changed body returns 409. Handle concurrent submissions atomically."
 *
 * This is now a thin HTTP-facing wrapper over `InboxReceiptService`, which holds the one
 * claim protocol this service has (section 6.3 `InboxReceipt`). What stays here is what is
 * genuinely HTTP: the canonical request hash, and turning a key conflict into the 409 the
 * contract promises. The queue consumer uses the same receipt on a different channel, so the
 * two paths cannot drift into disagreeing about what "already done" means.
 *
 * The atomicity still matters, and still lives in the claim: two identical requests arriving
 * together must produce **one** committed operation, and a check-then-insert cannot promise
 * that — both callers can pass the check before either inserts.
 */

import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { ApiException } from '../common/api-exception.js';
import {
  HTTP_IDEMPOTENCY_CHANNEL,
  InboxReceiptService,
  type ReceiptOutcome,
} from '../persistence/inbox-receipt.service.js';

/**
 * How long a key is remembered. Expiring a receipt must not let a late duplicate repeat a
 * committed effect — persisted run identity remains the final guard (section 6.3), so this is
 * a convenience window, not the correctness mechanism.
 */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type IdempotencyOutcome = Exclude<ReceiptOutcome, { kind: 'CONFLICT' }>;

@Injectable()
export class IdempotencyService {
  constructor(private readonly receipts: InboxReceiptService) {}

  /** Stable hash of the request, so key reuse with a different body is detectable. */
  static hashRequest(body: unknown): string {
    return createHash('sha256').update(canonicalise(body)).digest('hex');
  }

  /**
   * Claim a key, or discover what already holds it.
   *
   * `PROCEED` means this caller won and must go on to `complete()`. `REPLAY` returns the
   * existing result. `IN_FLIGHT` means a concurrent identical request is still working — the
   * caller is told to retry rather than being given a second operation.
   */
  async claim(input: {
    readonly tenantId: string;
    readonly key: string;
    readonly operation: string;
    readonly requestHash: string;
    readonly now: Date;
  }): Promise<IdempotencyOutcome> {
    const outcome = await this.receipts.claim({
      tenantId: input.tenantId,
      channel: HTTP_IDEMPOTENCY_CHANNEL,
      key: input.key,
      operation: input.operation,
      requestHash: input.requestHash,
      now: input.now,
      ttlMs: IDEMPOTENCY_WINDOW_MS,
    });

    if (outcome.kind === 'CONFLICT') {
      // T23 — same key, different body. Never silently returns the first result, because the
      // caller clearly meant something else and would be misled by the old one.
      throw new ApiException(
        'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY',
        'This idempotency key was already used with a different request body.',
        { internalDetail: `tenant=${input.tenantId} key=${input.key}` },
      );
    }

    return outcome;
  }

  async complete(input: {
    readonly tenantId: string;
    readonly key: string;
    readonly operation: string;
    readonly resultId: string;
    readonly now: Date;
  }): Promise<void> {
    await this.receipts.complete({ ...input, channel: HTTP_IDEMPOTENCY_CHANNEL });
  }

  /** Release a claim whose work failed, so a retry is not blocked by a dead reservation. */
  async release(input: {
    readonly tenantId: string;
    readonly key: string;
    readonly operation: string;
  }): Promise<void> {
    await this.receipts.release({ ...input, channel: HTTP_IDEMPOTENCY_CHANNEL });
  }
}

/** Deterministic serialisation: key order must not change the hash. */
function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);
  return `{${entries.join(',')}}`;
}
