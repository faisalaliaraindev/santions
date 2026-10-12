/**
 * The customer-facing half of the credential store: confirming an address, and getting back in
 * after losing a password (I2).
 *
 * `UserService` owns the records. This owns what a customer experiences, and the one rule that
 * shapes every method here:
 *
 * # Nothing on these routes says whether an address is a customer
 *
 * `requestVerificationResend` and `requestPasswordReset` do exactly the same visible thing for an
 * address that exists and one that does not: they answer `202 accepted` with a sentence that
 * promises nothing. An endpoint that answers differently is a list of this service's customers,
 * available to anybody with a word list — and a list of compliance firms is a useful thing to
 * steal in a way that a list of, say, recipe-site users is not.
 *
 * The service already refuses to be an oracle elsewhere for exactly this reason: one opaque `401`
 * for every credential failure, `404` rather than `403` for another tenant's key. This is the
 * same rule reaching the account routes.
 *
 * **Signup is the one exception, and it is a deliberate one** — see D-057. It has to return a
 * tenant id, so it cannot answer identically for a taken address without becoming asynchronous.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import { ApiException } from '../common/api-exception.js';
import type { AppConfig } from '../config/config.js';
import { APP_CONFIG } from '../tokens.js';
import { EntitlementsService } from '../tenancy/entitlements.service.js';
import { decideLiveAccess } from '../tenancy/live-access.js';
import { NOTIFICATION_PORT, type NotificationPort } from './notification.port.js';
import { UserError, UserService, type SafeUser } from './user.service.js';

/**
 * The one answer for every unusable token: unknown, expired, already spent, or for a different
 * purpose.
 *
 * Deliberately undifferentiated. A caller who can tell "already used" from "never existed" can
 * probe which links were issued and to whom, and the customer's next action is identical in every
 * case — ask for a new link. `VALIDATION_FAILED` rather than `NOT_FOUND`, because a 404 on a route
 * that exists invites the reader to conclude they have the path wrong.
 */
export function toTokenRefusal(error: unknown): unknown {
  if (error instanceof UserError && error.reason === 'INVALID_TOKEN') {
    return new ApiException(
      'VALIDATION_FAILED',
      'That link is not usable. It may have expired, or already been used. Ask for a new one.',
      { internalDetail: error.message },
    );
  }
  return error;
}

/** One sentence, identical for every caller, promising nothing about what exists. */
export const ACCEPTED_DETAIL =
  'If that address has an account, a message is on its way. It is deliberately not stated ' +
  'whether it does: an endpoint that answered differently would be a list of this service’s ' +
  'customers.';

@Injectable()
export class AccountService {
  private readonly logger = new Logger('Account');

  constructor(
    private readonly users: UserService,
    private readonly entitlements: EntitlementsService,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Send the address-confirmation message for a user that was just created.
   *
   * Returns whether it went, rather than throwing. Signup has already committed by the time this
   * runs, and a mail outage must not undo a tenant — it makes the address unconfirmed, which is
   * a state the product already has a route out of.
   */
  async sendVerification(
    user: SafeUser,
    organisationName: string,
    now: Date = new Date(),
  ): Promise<{ readonly sent: boolean; readonly detail: string }> {
    try {
      const { token, expiresAt } = await this.users.issueToken({
        user,
        purpose: 'EMAIL_VERIFICATION',
        now,
      });

      const { delivered } = await this.notifications.send(
        {
          to: user.email,
          kind: 'EMAIL_VERIFICATION',
          tenantId: user.tenantId,
          subject: `Confirm your email address for ${organisationName}`,
          body: this.verificationBody(organisationName, token, expiresAt),
        },
        now,
      );

      return {
        sent: delivered,
        detail: delivered
          ? 'A confirmation link is on its way. Sandbox keys work now; a live key becomes ' +
            'available once the address is confirmed.'
          : this.undeliveredDetail(),
      };
    } catch (error) {
      // Logged, not raised. The tenant exists; the address is simply unconfirmed.
      this.logger.error(
        `Verification email for ${user.userId} could not be sent: ${String(error)}`,
      );
      return { sent: false, detail: this.undeliveredDetail() };
    }
  }

  /**
   * Ask for the confirmation link again.
   *
   * Does nothing at all for an unknown address, and nothing for one already confirmed — and says
   * the same sentence either way. Re-sending for a confirmed address would let somebody who
   * guessed an address keep a live token flowing to a mailbox they do not hold.
   */
  async requestVerificationResend(email: string, now: Date = new Date()): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (user === null || user.emailVerifiedAt !== null) {
      this.logger.debug('Verification resend requested for an unknown or confirmed address.');
      return;
    }

    const tenant = await this.entitlements.findTenant(user.tenantId);
    await this.sendVerification(user, tenant?.name ?? 'your organisation', now);
  }

  /** Confirm the address, and report what that just unlocked. */
  async verifyEmail(
    token: string,
    now: Date = new Date(),
  ): Promise<{
    readonly tenantId: string;
    readonly verifiedAt: Date;
    readonly liveAccessUnlocked: boolean;
  }> {
    const result = await this.users.verifyEmail(token, now);

    // Read back through the same function key issuance uses, against the records this just
    // wrote — rather than asserting what it must now be. If the two could disagree, the one the
    // customer is told would be the wrong one.
    const [tenant, entitlement] = await Promise.all([
      this.entitlements.findTenant(result.tenantId),
      this.entitlements.activeEntitlement(result.tenantId),
    ]);

    return {
      tenantId: result.tenantId,
      verifiedAt: result.verifiedAt,
      liveAccessUnlocked: decideLiveAccess({ tenant, entitlement }).granted,
    };
  }

  /** Ask for a reset link. Same answer for every address, every time. */
  async requestPasswordReset(email: string, now: Date = new Date()): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (user === null) {
      this.logger.debug('Password reset requested for an unknown address.');
      return;
    }

    try {
      const { token, expiresAt } = await this.users.issueToken({
        user,
        purpose: 'PASSWORD_RESET',
        now,
      });

      await this.notifications.send(
        {
          to: user.email,
          kind: 'PASSWORD_RESET',
          tenantId: user.tenantId,
          subject: 'Reset your Adverse Search Service password',
          body: this.resetBody(token, expiresAt),
        },
        now,
      );
    } catch (error) {
      // Swallowed on purpose, and this is the one place that deserves saying twice: a caller who
      // can tell a failed send from a successful one can tell a real address from an invented
      // one, which is the enumeration this whole route is shaped to avoid.
      this.logger.error(`Password reset email could not be sent: ${String(error)}`);
    }
  }

  private verificationBody(organisationName: string, token: string, expiresAt: Date): string {
    return [
      `A tenant was created for ${organisationName} on the Adverse Search Service service.`,
      '',
      'Confirm this address to finish setting it up:',
      '',
      this.action('verify-email', token),
      '',
      `The link expires at ${expiresAt.toISOString()} and works once.`,
      '',
      'Sandbox keys already work. Confirming this address is what makes a live key available —',
      'live searches reach real publishers under our identity, so we send them only for',
      'addresses we can reach.',
      '',
      'If you did not sign up, ignore this message: nothing else happens without this link.',
    ].join('\n');
  }

  private resetBody(token: string, expiresAt: Date): string {
    return [
      'Somebody asked to reset the password for this address.',
      '',
      this.action('reset-password', token),
      '',
      `The link expires at ${expiresAt.toISOString()} and works once. Using it signs out every`,
      'session on this account.',
      '',
      'If this was not you, no action is needed — the password has not changed, and this link is',
      'the only thing that could change it.',
    ].join('\n');
  }

  /**
   * A link when there is somewhere to link to, and the raw instruction when there is not.
   *
   * `PUBLIC_APP_URL` is optional and is not guessed at. An email carrying a link to the wrong
   * host is worse than one carrying the token and the call to make with it, because the customer
   * cannot tell the first is wrong.
   */
  private action(path: 'verify-email' | 'reset-password', token: string): string {
    if (this.config.publicAppUrl !== null) {
      return `  ${this.config.publicAppUrl.replace(/\/+$/u, '')}/${path}?token=${token}`;
    }
    const endpoint =
      path === 'verify-email'
        ? 'POST /v1/signup/verify'
        : 'POST /v1/account/password-reset/confirm';
    return [
      '  No application URL is configured for this deployment, so here is the token itself.',
      `  Send it to ${endpoint}:`,
      '',
      `  ${token}`,
    ].join('\n');
  }

  private undeliveredDetail(): string {
    return (
      'The confirmation email could not be sent. The tenant exists and sandbox keys work; ask ' +
      'for the link again at POST /v1/signup/resend-verification once the problem is fixed.'
    );
  }
}
