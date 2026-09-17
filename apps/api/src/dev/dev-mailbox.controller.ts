/**
 * `GET /v1/dev/outbound-emails/latest` — read the local mailbox over HTTP, on a local stack only.
 *
 * # Why this exists
 *
 * D-058 made the `outboundEmails` collection the local inbox: no mail transport is configured,
 * so a verification link is written to a collection instead of sent. That closes the loop for a
 * developer with a Mongo shell and leaves it open for everybody else. Finishing a signup from
 * Postman meant running
 *
 * ```js
 * db.outboundEmails.find({ kind: "EMAIL_VERIFICATION" }).sort({ sentAt: -1 }).limit(1)
 * ```
 *
 * by hand, which is the one step in the onboarding flow that leaves the tool the flow is being
 * tested in. This route is that query, and nothing more.
 *
 * # Why it cannot reach production
 *
 * **It is not registered there.** `AppModule` includes this controller only when the config says
 * the deployment is not production, so in production the path does not exist and answers `404`
 * from the router — there is no guard to misconfigure, no environment check inside a handler to
 * invert, and no decorator to forget. A route that is absent cannot be reached by getting a
 * condition backwards.
 *
 * Three things make that fail *closed* rather than merely fail:
 *
 * 1. **The registration is the gate.** Not a `@Public()` route that checks `isProduction` in its
 *    body — that shape is one inverted boolean away from an unauthenticated token oracle.
 * 2. **The constructor refuses anyway.** Belt and braces: if a future refactor registers this
 *    unconditionally, the service fails at boot with a named reason rather than serving tokens.
 * 3. **Production already cannot populate the collection.** `UnconfiguredNotificationAdapter`
 *    rejects every send, so even a successfully mounted route would have nothing to read. The
 *    mailbox adapter and this reader are enabled by the same condition, which is what keeps them
 *    from drifting apart.
 *
 * # What it returns, and what it does not
 *
 * The most recent message matching the filter, for **one** address at a time — `email` is
 * required, so this is never a listing of who the customers are. It returns the token, because
 * returning the body without it would make the route pointless, and the body, because a
 * developer reading a failure needs to see what the customer would have seen.
 *
 * It reads. It never issues, spends or extends a token, so it cannot weaken the verification
 * flow it is a window onto: the token it shows is the same single-use, expiring token the email
 * carries, `POST /v1/signup/verify` still spends it, and a token read twice here is still a
 * token that works once there.
 */

import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import { Public } from '../auth/auth.guard.js';
import { ApiException } from '../common/api-exception.js';
import type { NotificationKind } from '../auth/notification.port.js';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG, MONGO_DB } from '../tokens.js';

/** The shape `MailboxNotificationAdapter` writes. Read-only here. */
interface OutboundEmailRecord {
  readonly to: string;
  readonly kind: NotificationKind;
  readonly subject: string;
  readonly body: string;
  readonly tenantId: string | null;
  readonly sentAt: Date;
}

const KINDS: readonly NotificationKind[] = ['EMAIL_VERIFICATION', 'PASSWORD_RESET'];

/**
 * Pull the token out of the rendered body.
 *
 * Two shapes, because `AccountService.action` writes two: a link when `PUBLIC_APP_URL` is set,
 * and the bare token beneath a line of prose when it is not. Both are matched so this route does
 * not silently start returning `null` the day somebody sets that variable on their stack.
 *
 * Returns `null` rather than guessing. A wrong token produces a confusing `400` from the verify
 * route; an explicit `null` says the parse failed, which is the thing worth knowing.
 */
export function extractToken(body: string): string | null {
  const fromLink = /[?&]token=([A-Za-z0-9._~-]+)/u.exec(body);
  if (fromLink !== null && fromLink[1] !== undefined) {
    return fromLink[1];
  }
  // The bare-token form: the last line that is nothing but a long opaque run of token
  // characters. Anchored per line so a word in the prose above cannot be mistaken for it.
  const candidates = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9._~-]{20,}$/u.test(line));
  return candidates.length === 0 ? null : (candidates[candidates.length - 1] ?? null);
}

@Controller({ path: 'dev/outbound-emails', version: '1' })
export class DevMailboxController {
  private readonly emails: Collection<OutboundEmailRecord>;

  constructor(@Inject(MONGO_DB) db: Db, @Inject(APP_CONFIG) config: AppConfig) {
    if (config.isProduction) {
      // Unreachable through AppModule, which is the point — this catches the refactor that
      // makes it reachable, at boot, rather than at the first request for somebody's token.
      throw new Error(
        'DevMailboxController was registered in production. It reads verification and ' +
          'password-reset tokens out of the local mailbox and must never be mounted on a ' +
          'deployment that serves real customers.',
      );
    }
    this.emails = db.collection<OutboundEmailRecord>('outboundEmails');
  }

  /**
   * The most recent message for one address, optionally narrowed by kind.
   *
   * `404` when there is none, because "no such message" and "a message with no token" are
   * different failures and an empty `200` would collapse them.
   */
  @Get('latest')
  @Public()
  async latest(
    @Query('email') email?: string,
    @Query('kind') kind?: string,
  ): Promise<{
    to: string;
    kind: NotificationKind;
    subject: string;
    body: string;
    tenantId: string | null;
    sentAt: string;
    token: string | null;
  }> {
    if (email === undefined || email.trim() === '') {
      throw new ApiException(
        'VALIDATION_FAILED',
        'Pass ?email= to read the latest message for one address. This route never lists ' +
          'messages for addresses you did not name.',
        { details: [{ path: 'email', message: 'Required.' }] },
      );
    }

    if (kind !== undefined && !KINDS.includes(kind as NotificationKind)) {
      throw new ApiException(
        'VALIDATION_FAILED',
        `Unknown kind "${kind}". Expected one of: ${KINDS.join(', ')}.`,
        { details: [{ path: 'kind', message: 'Unknown notification kind.' }] },
      );
    }

    // Case-insensitive exact match, not a regex the caller controls: addresses are stored as
    // the customer typed them, and a caller-supplied pattern here would turn a single-address
    // lookup into the enumeration this route is shaped to avoid.
    const filter: Record<string, unknown> = {
      to: { $regex: `^${escapeRegex(email.trim())}$`, $options: 'i' },
    };
    if (kind !== undefined) {
      filter['kind'] = kind;
    }

    const record = await this.emails.findOne(filter, { sort: { sentAt: -1 } });
    if (record === null) {
      throw new ApiException(
        'NOT_FOUND',
        `No ${kind ?? 'outbound'} message for that address. Has signup run, and did the ` +
          'mailbox adapter accept it?',
      );
    }

    return {
      to: record.to,
      kind: record.kind,
      subject: record.subject,
      body: record.body,
      tenantId: record.tenantId,
      sentAt: record.sentAt.toISOString(),
      token: extractToken(record.body),
    };
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
