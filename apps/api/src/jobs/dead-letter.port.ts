/**
 * The dead-letter seam.
 *
 * SQS already has a redrive policy — `maxReceiveCount: 5`, set in `scripts/bootstrap/aws.mjs`
 * — and that covers the case it is designed for: a message the consumer keeps failing on for
 * reasons nobody understands. It does **not** cover the case where the consumer understands
 * the problem perfectly and knows the message must never be attempted again.
 *
 * Those are different failures and they deserve different handling:
 *
 * - **Redrive** is a backstop. It takes five deliveries, five visibility timeouts and five
 *   attempts to notice, and it records nothing about *why*.
 * - **An explicit dead-letter** is a decision. A forged tenant (SEC-01) or an unparsable
 *   envelope will fail identically on every future delivery, and letting the backstop discover
 *   that means four more attempts to act on a message we have already judged. Worse, the DLQ
 *   entry that eventually appears carries no reason, so the operator investigating it starts
 *   from nothing.
 *
 * So the consumer sends explicitly, with a reason, and the redrive policy stays as the
 * backstop for what the consumer could not classify. Both are wanted; neither replaces the
 * other.
 *
 * **A dead-letter is never a delete.** Everything sent here is retained for an operator. A
 * message this service decided not to process is evidence of a producer bug, a configuration
 * error or an attack, and the one thing that must not happen to it is quiet disposal.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import type { JobEnvelope } from './queue.port.js';

/** Why a message was given up on. Recorded as a message attribute, not just a log line. */
export const DEAD_LETTER_REASONS = [
  /** The body was not a valid envelope. A producer bug, or something else writing to a queue. */
  'MALFORMED_ENVELOPE',
  /** The envelope claimed a tenant that does not own the aggregate (SEC-01). A security event. */
  'TENANT_MISMATCH',
  /** Delivered more times than the redrive policy allows for; it is not going to succeed. */
  'POISON_MESSAGE',
  /** No handler is registered for this event type in this consumer. */
  'UNROUTABLE',
] as const;
export type DeadLetterReason = (typeof DEAD_LETTER_REASONS)[number];

export interface DeadLetter {
  readonly reason: DeadLetterReason;
  /** The raw body, exactly as received. Never re-serialised from a parse that may have lost. */
  readonly body: string;
  /** Safe operator-facing detail. Never a credential, never evidence text (SEC-04). */
  readonly detail: string;
  readonly envelope: JobEnvelope | null;
  readonly receivedAt: Date;
}

export interface DeadLetterPort {
  send(letter: DeadLetter): Promise<void>;
}

export const DEAD_LETTER_PORT = 'DEAD_LETTER_PORT';

export interface SqsDeadLetterConfig {
  readonly queueUrl: string;
  readonly region: string;
  readonly endpoint?: string | undefined;
  readonly credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
}

@Injectable()
export class SqsDeadLetterAdapter implements DeadLetterPort {
  private readonly client: SQSClient;

  constructor(private readonly config: SqsDeadLetterConfig) {
    this.client = new SQSClient({
      region: config.region,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
      retryMode: 'adaptive',
      maxAttempts: 3,
    });
  }

  async send(letter: DeadLetter): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.config.queueUrl,
        // The original body, byte for byte. An operator replaying a fixed message needs what
        // was actually sent, not this service's interpretation of it.
        MessageBody: letter.body,
        MessageAttributes: {
          deadLetterReason: { DataType: 'String', StringValue: letter.reason },
          deadLetterDetail: { DataType: 'String', StringValue: letter.detail.slice(0, 1024) },
          deadLetterAt: { DataType: 'String', StringValue: letter.receivedAt.toISOString() },
        },
      }),
    );
  }
}

/**
 * An in-process dead-letter sink.
 *
 * Used by tests, and by a development run with no DLQ configured — where it logs at `error`
 * rather than `warn`, because a dead-lettered message in development is exactly as much of a
 * defect as it is in production, and the only difference is that nobody is paged for it.
 */
export class InMemoryDeadLetterSink implements DeadLetterPort {
  private readonly logger = new Logger('DeadLetter');
  private readonly letters: DeadLetter[] = [];

  async send(letter: DeadLetter): Promise<void> {
    this.letters.push(letter);
    this.logger.error(
      `Dead-lettered (${letter.reason}): ${letter.detail}. Held in process memory only.`,
    );
    await Promise.resolve();
  }

  all(): readonly DeadLetter[] {
    return [...this.letters];
  }
}
