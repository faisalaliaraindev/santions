/**
 * SEC-01, the queue half: *verify job ownership against persisted records; do not trust a
 * queue message's tenant field.*
 *
 * This is the **only** place permitted to turn a `JobEnvelope` into a tenant the rest of the
 * code acts on, and it does it by ignoring the envelope's own answer and asking the database.
 *
 * The distinction matters more than it first looks. An envelope's `tenantId` is attacker-
 * influenced in any deployment where a message can be injected — a misconfigured queue policy,
 * a compromised producer, a replayed message from a test harness. A consumer that reads
 * `envelope.tenantId` and then loads `findOne({ tenantId, runId })` will happily do work for
 * whichever tenant the message claimed. Loading by the aggregate's own identity and taking the
 * tenant from the **record** cannot do that: a forged tenant produces a mismatch, not a
 * cross-tenant read.
 *
 * The mismatch is a security event, not a routing correction. It is never repaired by
 * "preferring the record" and carrying on quietly, because the only ways to produce one are a
 * producer bug and an attack, and both need a human to see them.
 */

import type { JobEnvelope } from './queue.port.js';

/** The minimum a persisted aggregate must expose to be checkable. */
export interface OwnedAggregate {
  readonly tenantId: string;
  readonly revision?: number | undefined;
}

export type OwnershipVerdict =
  | { readonly kind: 'OWNED'; readonly tenantId: string; readonly record: OwnedAggregate }
  /** No such aggregate. Could be a replay of a deleted run, or a forged identity. */
  | { readonly kind: 'NOT_FOUND'; readonly detail: string }
  /** The envelope claimed a tenant that does not own this aggregate. A security event. */
  | { readonly kind: 'TENANT_MISMATCH'; readonly claimed: string; readonly detail: string }
  /** The delivery is older than the state already applied (REL-03, T31). */
  | {
      readonly kind: 'STALE_REVISION';
      readonly tenantId: string;
      readonly currentRevision: number;
    };

/**
 * Verify that an envelope may be acted on.
 *
 * `load` is given only the aggregate ID — deliberately not the tenant — so that the lookup
 * cannot be scoped by the very value being verified. A loader that takes the envelope's tenant
 * as a filter turns this check into a tautology: it would find nothing for a forged tenant and
 * report `NOT_FOUND`, which reads like a harmless replay rather than an attempted crossing.
 */
export async function verifyJobOwnership(input: {
  readonly envelope: JobEnvelope;
  readonly load: (aggregateId: string) => Promise<OwnedAggregate | null>;
}): Promise<OwnershipVerdict> {
  const { envelope } = input;

  const record = await input.load(envelope.aggregateId);

  if (record === null) {
    return {
      kind: 'NOT_FOUND',
      detail: `${envelope.aggregateType}=${envelope.aggregateId} does not exist`,
    };
  }

  if (record.tenantId !== envelope.tenantId) {
    return {
      kind: 'TENANT_MISMATCH',
      claimed: envelope.tenantId,
      detail:
        `Envelope for ${envelope.aggregateType}=${envelope.aggregateId} claimed a tenant that ` +
        'does not own it. The envelope was not trusted and no work was done.',
    };
  }

  if (record.revision !== undefined && record.revision > envelope.aggregateRevision) {
    // Out-of-order delivery. Applying it would overwrite newer state with older, which is how
    // a reviewer is shown a result the service has already superseded.
    return { kind: 'STALE_REVISION', tenantId: record.tenantId, currentRevision: record.revision };
  }

  // The tenant that is returned is the record's, not the envelope's — even though they are
  // equal here. Returning the envelope's would make a future edit to this function able to
  // reintroduce the bug it exists to prevent.
  return { kind: 'OWNED', tenantId: record.tenantId, record };
}
