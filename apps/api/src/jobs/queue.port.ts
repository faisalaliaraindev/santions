/**
 * The queue seam.
 *
 * Everything the service publishes leaves through `QueuePort`, and everything it consumes
 * arrives through it. The port exists for two reasons that are not "testability":
 *
 * 1. **The envelope is a contract, not a payload.** `JobEnvelope` fixes what a message carries
 *    and, more importantly, what a message *means* — in particular that `tenantId` on an
 *    envelope is a **routing hint and never an authority** (SEC-01). Keeping the shape in one
 *    place is what makes that rule checkable rather than remembered.
 * 2. **The transport is a deployment choice.** SQS is the assumption because the rest of the
 *    stack is AWS, but nothing above this interface knows that.
 *
 * **Why the AWS SDK rather than the unsigned REST calls the bootstrap scripts use.** Those
 * scripts talk to LocalStack, which accepts unsigned requests; that is fine for a script whose
 * whole purpose is to never touch real AWS. An application running in production cannot do
 * that: it needs SigV4 over credentials that rotate — an instance role, a task role, IRSA —
 * and hand-rolling that is a security control written twice. The SDK's credential chain is the
 * production answer, and it is the same code path locally with only the endpoint overridden.
 *
 * **Cost.** Two levers are taken here rather than left for later, because both are far cheaper
 * to build in than to retrofit:
 *
 * - **Long polling.** `WaitTimeSeconds: 20` on every receive. Short polling bills an API call
 *   per empty poll; on an idle queue that is the entire bill, and it is pure waste.
 * - **Batched sends.** Up to ten envelopes per `SendMessageBatch` call, which is what SQS
 *   charges as one request. A run that fans out to nine sources costs one request, not nine.
 */

import { randomUUID } from 'node:crypto';

export const JOB_ENVELOPE_VERSION = 1;

/**
 * What travels on the queue.
 *
 * `tenantId` is present so a consumer can route, shard and log without a database read. It is
 * **not** an authorisation input. SEC-01: *verify job ownership against persisted records; do
 * not trust a queue message's tenant field.* See `job-ownership.ts`, which is the only place
 * allowed to turn an envelope into a tenant the code acts on.
 */
export interface JobEnvelope {
  readonly envelopeVersion: typeof JOB_ENVELOPE_VERSION;
  /** Deduplication identity. The same `eventId` delivered twice is one event (FI-07). */
  readonly eventId: string;
  readonly eventType: string;
  /** Routing hint only. Never an authority. */
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Lets a receiver discard a delivery that arrives after a newer one (REL-03, T31). */
  readonly aggregateRevision: number;
  readonly occurredAt: string;
  readonly correlationId: string | null;
  readonly payload: Record<string, unknown>;
}

export interface ReceivedMessage {
  readonly envelope: JobEnvelope;
  /** Opaque transport handle used to acknowledge. Never persisted, never logged. */
  readonly receiptHandle: string;
  /** How many times the transport has delivered this message. Feeds DLQ decisions in C6. */
  readonly approximateReceiveCount: number;
}

export interface PublishOutcome {
  readonly published: readonly string[];
  readonly failed: readonly { readonly eventId: string; readonly reason: string }[];
}

export interface QueuePort {
  /** Publish a batch. Partial success is normal and is reported, never thrown away. */
  publish(envelopes: readonly JobEnvelope[]): Promise<PublishOutcome>;
  receive(input: {
    readonly maxMessages: number;
    readonly waitSeconds: number;
  }): Promise<readonly ReceivedMessage[]>;
  acknowledge(receiptHandle: string): Promise<void>;
  /** Return a message to the queue immediately instead of waiting out its visibility timeout. */
  release(receiptHandle: string): Promise<void>;
}

export const QUEUE_PORT = 'QUEUE_PORT';

/** SQS accepts at most ten messages per batch request. */
export const MAX_BATCH = 10;

/**
 * Parse an envelope defensively.
 *
 * A message body is untrusted input from outside the process, exactly like an HTTP body, and
 * it is validated the same way. A malformed envelope is not a crash and not a silent skip: the
 * caller decides, and C6 sends it to the DLQ rather than retrying it forever.
 */
export function parseEnvelope(body: string): JobEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;

  const required: readonly [string, string][] = [
    ['eventId', 'string'],
    ['eventType', 'string'],
    ['tenantId', 'string'],
    ['aggregateType', 'string'],
    ['aggregateId', 'string'],
    ['occurredAt', 'string'],
  ];
  for (const [field, type] of required) {
    if (typeof candidate[field] !== type) {
      return null;
    }
  }
  if (candidate['envelopeVersion'] !== JOB_ENVELOPE_VERSION) {
    return null;
  }
  if (typeof candidate['aggregateRevision'] !== 'number') {
    return null;
  }
  const payload = candidate['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  return {
    envelopeVersion: JOB_ENVELOPE_VERSION,
    eventId: candidate['eventId'] as string,
    eventType: candidate['eventType'] as string,
    tenantId: candidate['tenantId'] as string,
    aggregateType: candidate['aggregateType'] as string,
    aggregateId: candidate['aggregateId'] as string,
    aggregateRevision: candidate['aggregateRevision'],
    occurredAt: candidate['occurredAt'] as string,
    correlationId:
      typeof candidate['correlationId'] === 'string' ? candidate['correlationId'] : null,
    payload: payload as Record<string, unknown>,
  };
}

/**
 * An in-process queue, for tests and for a single-process development run.
 *
 * Not a fallback for a missing configuration. A service that cannot reach its queue must say
 * so rather than quietly publishing into a variable that disappears at shutdown — that is the
 * difference between a degraded service and one that loses a customer's search.
 */
export class InMemoryQueueAdapter implements QueuePort {
  private readonly messages = new Map<string, ReceivedMessage>();
  private readonly inFlight = new Map<string, ReceivedMessage>();
  /** Set by a test to make a publish fail, so the outbox's retry path can be exercised. */
  failNextPublish: string | null = null;

  async publish(envelopes: readonly JobEnvelope[]): Promise<PublishOutcome> {
    const published: string[] = [];
    const failed: { eventId: string; reason: string }[] = [];

    for (const envelope of envelopes) {
      if (this.failNextPublish !== null) {
        failed.push({ eventId: envelope.eventId, reason: this.failNextPublish });
        continue;
      }
      const handle = randomUUID();
      this.messages.set(handle, { envelope, receiptHandle: handle, approximateReceiveCount: 0 });
      published.push(envelope.eventId);
    }

    return await Promise.resolve({ published, failed });
  }

  async receive(input: { readonly maxMessages: number }): Promise<readonly ReceivedMessage[]> {
    const taken: ReceivedMessage[] = [];
    for (const [handle, message] of this.messages) {
      if (taken.length >= input.maxMessages) {
        break;
      }
      this.messages.delete(handle);
      const delivered = {
        ...message,
        approximateReceiveCount: message.approximateReceiveCount + 1,
      };
      this.inFlight.set(handle, delivered);
      taken.push(delivered);
    }
    return await Promise.resolve(taken);
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    this.inFlight.delete(receiptHandle);
    await Promise.resolve();
  }

  async release(receiptHandle: string): Promise<void> {
    const message = this.inFlight.get(receiptHandle);
    if (message !== undefined) {
      this.inFlight.delete(receiptHandle);
      this.messages.set(receiptHandle, message);
    }
    await Promise.resolve();
  }

  /** Test helper: everything currently waiting to be received. */
  pending(): readonly JobEnvelope[] {
    return [...this.messages.values()].map((m) => m.envelope);
  }
}
