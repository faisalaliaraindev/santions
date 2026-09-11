/**
 * The SQS implementation of `QueuePort`.
 *
 * Uses the AWS SDK rather than the unsigned REST calls the bootstrap scripts make. The reason
 * is credentials, not convenience: in production this process authenticates with a rotating
 * role credential (instance role, task role, IRSA), and SigV4 over a rotating credential is a
 * security control that should be used, not re-implemented. Locally the same code path runs
 * with the endpoint overridden at LocalStack and a static dummy credential.
 *
 * Cost decisions taken here rather than deferred:
 *
 * - **Long polling** (`WaitTimeSeconds: 20`). Short polling bills a request per empty receive,
 *   which on an idle queue is the entire bill for nothing. It also reduces empty-response
 *   churn, so it is both cheaper and lower-latency.
 * - **Batched sends** (ten per request, which is SQS's maximum and what it bills as one).
 * - **Adaptive retry mode.** Throttling from SQS is answered with a client-side rate reduction
 *   rather than a tight retry loop that turns a throttle into an outage.
 *
 * Partial batch failure is normal and is reported, never swallowed: SQS answers a batch send
 * with a per-entry result, and treating the call as all-or-nothing would either lose events or
 * republish ones that already went.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SQSClient,
  type SendMessageBatchRequestEntry,
} from '@aws-sdk/client-sqs';

import {
  MAX_BATCH,
  MAX_VISIBILITY_SECONDS,
  parseEnvelope,
  type JobEnvelope,
  type PublishOutcome,
  type QueuePort,
  type ReceivedMessage,
} from './queue.port.js';

export interface SqsQueueConfig {
  readonly queueUrl: string;
  readonly region: string;
  /** Set only for LocalStack. Absent in production, where the real endpoint is derived. */
  readonly endpoint?: string | undefined;
  /** Static credentials for LocalStack only. Production uses the SDK's credential chain. */
  readonly credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
}

const LONG_POLL_SECONDS = 20;

@Injectable()
export class SqsQueueAdapter implements QueuePort {
  private readonly logger = new Logger('SqsQueue');
  private readonly client: SQSClient;

  constructor(private readonly config: SqsQueueConfig) {
    this.client = new SQSClient({
      region: config.region,
      // Both are conditional: passing `endpoint: undefined` explicitly is fine, but passing
      // static credentials in production would override the role credential chain, which is
      // exactly the mistake that leaves a long-lived key in an environment variable.
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
      retryMode: 'adaptive',
      maxAttempts: 3,
    });
  }

  async publish(envelopes: readonly JobEnvelope[]): Promise<PublishOutcome> {
    const published: string[] = [];
    const failed: { eventId: string; reason: string }[] = [];

    for (let i = 0; i < envelopes.length; i += MAX_BATCH) {
      const chunk = envelopes.slice(i, i + MAX_BATCH);
      const entries: SendMessageBatchRequestEntry[] = chunk.map((envelope, index) => ({
        // Batch-local identifier only; the durable identity is `eventId` in the body.
        Id: String(index),
        MessageBody: JSON.stringify(envelope),
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: envelope.eventType },
          // Present for routing and metrics. Consumers must still verify ownership against
          // the persisted record (SEC-01) — this attribute proves nothing.
          tenantId: { DataType: 'String', StringValue: envelope.tenantId },
        },
      }));

      try {
        const response = await this.client.send(
          new SendMessageBatchCommand({ QueueUrl: this.config.queueUrl, Entries: entries }),
        );

        for (const success of response.Successful ?? []) {
          const envelope = chunk[Number(success.Id)];
          if (envelope !== undefined) {
            published.push(envelope.eventId);
          }
        }
        for (const failure of response.Failed ?? []) {
          const envelope = chunk[Number(failure.Id)];
          if (envelope !== undefined) {
            failed.push({
              eventId: envelope.eventId,
              reason: `${failure.Code ?? 'unknown'}: ${failure.Message ?? ''}`.trim(),
            });
          }
        }
      } catch (error) {
        // The whole call failed. Every envelope in it is unpublished — and the outbox row is
        // still there, which is the entire point of publishing from an outbox (FI-04).
        for (const envelope of chunk) {
          failed.push({ eventId: envelope.eventId, reason: String(error) });
        }
      }
    }

    return { published, failed };
  }

  async receive(input: {
    readonly maxMessages: number;
    readonly waitSeconds?: number;
  }): Promise<readonly ReceivedMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.config.queueUrl,
        MaxNumberOfMessages: Math.min(input.maxMessages, MAX_BATCH),
        WaitTimeSeconds: input.waitSeconds ?? LONG_POLL_SECONDS,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );

    const received: ReceivedMessage[] = [];
    for (const message of response.Messages ?? []) {
      if (message.Body === undefined || message.ReceiptHandle === undefined) {
        continue;
      }
      const envelope = parseEnvelope(message.Body);
      if (envelope === null) {
        // Surfaced, not swallowed. The consumer dead-letters it with a reason; deciding that
        // here would hide a producer bug inside a transport adapter.
        this.logger.error(
          `Unparsable job envelope: ${message.MessageId ?? 'unknown id'}. Passed to the consumer.`,
        );
      }
      received.push({
        envelope,
        body: message.Body,
        receiptHandle: message.ReceiptHandle,
        approximateReceiveCount: Number(message.Attributes?.['ApproximateReceiveCount'] ?? '1'),
      });
    }
    return received;
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.config.queueUrl, ReceiptHandle: receiptHandle }),
    );
  }

  async release(receiptHandle: string, delaySeconds = 0): Promise<void> {
    // Visibility zero returns it immediately, so a worker that cannot proceed does not hold a
    // message hostage for the rest of its visibility timeout. A non-zero delay is the FR-06
    // backoff: SQS holds the message and redelivers it when it is due, which costs no worker
    // and survives this process dying in the meantime.
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.config.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.min(Math.max(0, Math.round(delaySeconds)), MAX_VISIBILITY_SECONDS),
      }),
    );
  }
}
