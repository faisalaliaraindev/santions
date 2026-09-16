/**
 * `POST /v1/signup` — the only unauthenticated write in the service (phase I step I1).
 *
 * Public by explicit decoration. Every other route is protected by the global guards, and a
 * route that opts out has to say so where a reviewer reading the controller will see it — which
 * is the reason the guards fail closed and `@Public()` is the exception rather than the default.
 *
 * What being public costs, and what pays for it:
 *
 * - **Nothing here reads a principal**, because there is not one. The tenant id is generated,
 *   the entitlement is the standard grant, and there is no field in the body that any of that
 *   can be steered by.
 * - **The write is bounded per origin** — see `SignupService.recordAttempt`. An open door with
 *   no bound is a collection somebody fills.
 * - **Live access is not granted by getting here.** The response says so in its own body: a
 *   self-signed-up tenant holds sandbox until the contact address is confirmed (D-052).
 */

import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import {
  emailRequestSchema,
  signupSchema,
  verifyEmailSchema,
  type AcceptedResponse,
  type EmailRequestInput,
  type SignupInput,
  type SignupResult,
  type VerifyEmailInput,
  type VerifyEmailResult,
} from '@erly/adverse-contracts';

import { ACCEPTED_DETAIL, AccountService, toTokenRefusal } from '../auth/account.service.js';
import { Public } from '../auth/auth.guard.js';
import { CorrelationId } from '../common/principal.decorator.js';
import { validate } from '../common/zod-validation.pipe.js';
import { SignupError, SignupService, signupRejectionToApiException } from './signup.service.js';

@Controller({ path: 'signup', version: '1' })
export class SignupController {
  // Explicitly injected by token, like every other controller here: `emitDecoratorMetadata`
  // is off, so a constructor parameter typed but not named resolves to `undefined` at runtime
  // rather than failing at boot.
  constructor(
    @Inject(SignupService) private readonly signups: SignupService,
    @Inject(AccountService) private readonly accounts: AccountService,
  ) {}

  /**
   * Create a tenant. `201`, because one is created — unlike the key disable/enable routes,
   * which move a flag and answer 200.
   */
  @Post()
  @Public()
  async signUp(
    @Req() request: Request,
    @CorrelationId() correlationId: string,
    @Body(validate(signupSchema)) body: SignupInput,
  ): Promise<SignupResult> {
    try {
      return await this.signups.signUp(body, { ip: request.ip, correlationId });
    } catch (error) {
      if (error instanceof SignupError) {
        throw signupRejectionToApiException(error);
      }
      throw error;
    }
  }

  /**
   * Confirm the address signup was given (I2, D-052).
   *
   * Public, because the customer confirming it has no credential yet — the token from the email
   * **is** the credential, and it is single-use and expiring for that reason.
   *
   * `200`, not 201: nothing is created. What changes is `tenants.emailVerifiedAt`, which is the
   * value `decideLiveAccess` reads, so this call is the moment a self-signed-up tenant becomes
   * able to hold a live key. The response says so rather than leaving it to be inferred from a
   * 403 that stops happening.
   */
  @Post('verify')
  @HttpCode(200)
  @Public()
  async verifyEmail(
    @Body(validate(verifyEmailSchema)) body: VerifyEmailInput,
  ): Promise<VerifyEmailResult> {
    try {
      const result = await this.accounts.verifyEmail(body.token);
      return {
        tenantId: result.tenantId,
        emailVerifiedAt: result.verifiedAt.toISOString(),
        liveAccessUnlocked: result.liveAccessUnlocked,
      };
    } catch (error) {
      throw toTokenRefusal(error);
    }
  }

  /**
   * Send the confirmation link again.
   *
   * `202`, and the same sentence for every address — known, unknown, or already confirmed. A
   * different answer for a known address would make this route a list of customers, which is the
   * rule every account route here follows and the reason signup is documented as the exception
   * (D-057).
   */
  @Post('resend-verification')
  @HttpCode(202)
  @Public()
  async resendVerification(
    @Body(validate(emailRequestSchema)) body: EmailRequestInput,
  ): Promise<AcceptedResponse> {
    await this.accounts.requestVerificationResend(body.email);
    return { accepted: true, detail: ACCEPTED_DETAIL };
  }
}
