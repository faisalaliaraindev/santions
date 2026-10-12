/**
 * `POST /v1/account/password-reset` and `.../confirm` — getting back in (I2, D-051).
 *
 * Both routes are public, and they have to be: a customer who has lost their password has no
 * credential to present. What replaces the credential is the emailed token, which is single-use,
 * expiring, and stored only as a hash.
 *
 * # The request route answers the same way for every address
 *
 * `202 accepted`, with a sentence that promises nothing, whether or not the address is a
 * customer. That is not politeness — an endpoint that answers differently is a list of this
 * service's customers, and a list of compliance firms is worth stealing. The same rule already
 * governs authentication failures (one opaque `401`) and other tenants' keys (`404`, not `403`).
 *
 * # Resetting is a security event, not a convenience
 *
 * A reset ends **every session** the user holds, because a reset may be an account being taken
 * back from somebody who should not have it. It also clears a lockout: whoever holds the mailbox
 * has proved more than a password would, and leaving the lock in place would punish the person
 * recovering their account for the attacker's failed guesses.
 */

import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';

import {
  emailRequestSchema,
  resetPasswordSchema,
  type AcceptedResponse,
  type EmailRequestInput,
  type ResetPasswordInput,
  type ResetPasswordResult,
} from '@adverse-search/contracts';

import { ApiException } from '../common/api-exception.js';
import { validate } from '../common/zod-validation.pipe.js';
import { ACCEPTED_DETAIL, AccountService, toTokenRefusal } from './account.service.js';
import { Public } from './auth.guard.js';
import { assessPassword } from './password.js';
import { UserService } from './user.service.js';

@Controller({ path: 'account', version: '1' })
export class AccountController {
  constructor(
    @Inject(AccountService) private readonly accounts: AccountService,
    @Inject(UserService) private readonly users: UserService,
  ) {}

  /** Ask for a reset link. Says nothing about whether the address is known. */
  @Post('password-reset')
  @HttpCode(202)
  @Public()
  async requestReset(
    @Body(validate(emailRequestSchema)) body: EmailRequestInput,
  ): Promise<AcceptedResponse> {
    await this.accounts.requestPasswordReset(body.email);
    return { accepted: true, detail: ACCEPTED_DETAIL };
  }

  /**
   * Set a new password with the token from the email.
   *
   * The new password meets the same bar as a signup password — length and known-bad values —
   * checked **before** the token is spent, so a customer who chooses a weak one can try again
   * with the link they already have rather than having to request another.
   */
  @Post('password-reset/confirm')
  @HttpCode(200)
  @Public()
  async confirmReset(
    @Body(validate(resetPasswordSchema)) body: ResetPasswordInput,
  ): Promise<ResetPasswordResult> {
    const verdict = assessPassword(body.newPassword);
    if (!verdict.ok) {
      throw new ApiException('VALIDATION_FAILED', verdict.detail, {
        internalDetail: `password rejected: ${verdict.rejection}`,
        // The path, never the value. A rejected password must not be echoed into a response, a
        // log, or an error report somebody forwards.
        details: [{ path: 'newPassword', message: verdict.detail }],
      });
    }

    try {
      const result = await this.users.resetPassword({
        token: body.token,
        newPassword: body.newPassword,
      });
      return { reset: true, sessionsEnded: result.sessionsEnded };
    } catch (error) {
      throw toTokenRefusal(error);
    }
  }
}
