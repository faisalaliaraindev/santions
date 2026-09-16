/**
 * How a verification link or a reset link reaches a customer (I2).
 *
 * A port, like every other outside-world dependency in this codebase, for the usual reason: the
 * thing that sends mail in production is not the thing that must run in a test, and a service
 * that reaches for an SMTP connection inside a signup transaction is a service whose signup fails
 * when the mail provider does.
 *
 * # Two adapters, and a third that deliberately does not exist
 *
 * - **`MailboxNotificationAdapter`** — the local stack. Writes every message to an
 *   `outboundEmails` collection and logs a line. That collection *is* the inbox: it is how a
 *   developer finishes a verification flow with no mail server anywhere, and how the test suite
 *   reads a token it was never handed by an API.
 * - **A real transport** — SMTP or SES. **Not built**, because nothing has decided which, and
 *   guessing would put a dead configuration key into the config schema.
 *
 * So production **refuses to start** rather than running with the mailbox adapter. The
 * alternative is a deployment where signup appears to work, verification emails go into a
 * database nobody reads, and every customer sits unverified and unable to reach live — which is
 * the same class of silent failure as a fixture answering as though it were a live source.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT');

export type NotificationKind = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

export interface OutboundEmail {
  readonly to: string;
  readonly kind: NotificationKind;
  readonly subject: string;
  readonly body: string;
  /** For correlating a message with the request that caused it. Never the token. */
  readonly tenantId: string | null;
}

export interface NotificationPort {
  /**
   * Deliver, and say whether it was delivered.
   *
   * Returns a verdict rather than throwing. A failed send must not roll back a signup: the tenant
   * exists, the address is simply unconfirmed, and `resend-verification` is the way back. A send
   * that took the signup down with it would turn a mail outage into an outage of the product.
   */
  send(email: OutboundEmail, now?: Date): Promise<{ readonly delivered: boolean }>;
}

interface OutboundEmailRecord extends OutboundEmail {
  readonly sentAt: Date;
}

/**
 * The local stack's mailbox: a collection, and a log line.
 *
 * Bodies contain single-use links. They are written to the database on purpose — that is what
 * makes the flow completable without a mail server — and that is also exactly why this adapter
 * must never run in production, where those rows would be live credentials sitting in a
 * collection with no retention rule.
 */
@Injectable()
export class MailboxNotificationAdapter implements NotificationPort {
  private readonly logger = new Logger('Mailbox');
  private readonly emails: Collection<OutboundEmailRecord>;

  constructor(db: Db) {
    this.emails = db.collection<OutboundEmailRecord>('outboundEmails');
  }

  async ensureIndexes(): Promise<void> {
    await this.emails.createIndex({ to: 1, sentAt: -1 });
    await this.emails.createIndex({ kind: 1, sentAt: -1 });
    // A local mailbox holding live links for ever is a local mailbox somebody eventually copies
    // into a bug report. A day is long enough to finish a flow you are in the middle of.
    await this.emails.createIndex({ sentAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
  }

  async send(email: OutboundEmail, now: Date = new Date()): Promise<{ delivered: boolean }> {
    await this.emails.insertOne({ ...email, sentAt: now });
    // The subject and the recipient, never the body: the body holds the link, and a log line is
    // the one place a credential most reliably outlives the thing it was for.
    this.logger.log(
      `Mailbox: "${email.subject}" to ${email.to}. Read it from the outboundEmails collection ` +
        '— no mail is actually sent on this stack.',
    );
    return { delivered: true };
  }
}

/**
 * What production gets until a transport is chosen: a refusal, at boot, naming the problem.
 *
 * Not a silent no-op. A no-op adapter is how a service ends up with a signup flow that looks
 * healthy and a customer base nobody can reach.
 */
export class UnconfiguredNotificationAdapter implements NotificationPort {
  send(): Promise<{ delivered: boolean }> {
    return Promise.reject(
      new Error(
        'No mail transport is configured. Verification and password-reset links cannot be ' +
          'delivered, so signup would create customers nobody can reach. Configure a transport ' +
          'before running this service in production.',
      ),
    );
  }
}
