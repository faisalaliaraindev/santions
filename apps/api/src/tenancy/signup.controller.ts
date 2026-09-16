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

import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { signupSchema, type SignupInput, type SignupResult } from '@erly/adverse-contracts';

import { Public } from '../auth/auth.guard.js';
import { CorrelationId } from '../common/principal.decorator.js';
import { validate } from '../common/zod-validation.pipe.js';
import { SignupError, SignupService, signupRejectionToApiException } from './signup.service.js';

@Controller({ path: 'signup', version: '1' })
export class SignupController {
  // Explicitly injected by token, like every other controller here: `emitDecoratorMetadata`
  // is off, so a constructor parameter typed but not named resolves to `undefined` at runtime
  // rather than failing at boot.
  constructor(@Inject(SignupService) private readonly signups: SignupService) {}

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
}
