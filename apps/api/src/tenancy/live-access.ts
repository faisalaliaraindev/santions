/**
 * The one decision about whether a tenant may hold a **live** credential (phase I step I1).
 *
 * # Why this is a function reading state, and not an `if` in the route
 *
 * D-053 defers payment and live-key approval to a later phase. The expensive part of adding a
 * gate later is never the check — it is adding it around tenants that already exist with live
 * keys issued while there was none. So the answer is computed from tenant state, in one place:
 * turning a future gate on is then writing a different value into that state, and every tenant,
 * old and new, is judged by the same function on the next call.
 *
 * # Why a missing flag means "allowed"
 *
 * Tenants provisioned before self-service signup existed were onboarded by a person, by hand,
 * through the bootstrap. Their records carry no `createdVia` and no `emailVerifiedAt`, and
 * reading that absence as "not verified" would take live access away from every customer who
 * already has it, on deploy, with no way for them to restore it — there is no verification
 * email to re-send for an address that was never collected.
 *
 * The gate therefore applies to tenants that **signed themselves up**, which is precisely the
 * population D-052 was reasoning about: a self-signed-up tenant drives traffic to real
 * publishers under our identity, against a rate budget shared by the whole service, and nobody
 * at Adverse Search has spoken to them. A tenant a person onboarded is a tenant a person vouched for.
 *
 * This is the same shape as `disabledAtOf` in `api-key.service.ts`, and for the same reason: a
 * field added today must not change the meaning of records written before it existed.
 */

/** Why live is refused. `NOT_ENTITLED` is commercial; `EMAIL_NOT_VERIFIED` is D-052's gate. */
export type LiveAccessBlock = 'NOT_ENTITLED' | 'EMAIL_NOT_VERIFIED';

export type LiveAccessDecision =
  | { readonly granted: true; readonly blockedBy: null; readonly detail: string }
  | { readonly granted: false; readonly blockedBy: LiveAccessBlock; readonly detail: string };

/** The only parts of a tenant record this decision may read. */
export interface TenantLiveState {
  readonly createdVia?: string | undefined;
  readonly emailVerifiedAt?: string | Date | null | undefined;
}

/** The only part of an entitlement this decision may read. */
export interface EntitlementLiveState {
  readonly environments: readonly string[];
}

/** Marks a tenant that created itself through `POST /v1/signup`. */
export const CREATED_VIA_SIGNUP = 'SIGNUP';

export const LIVE_ACCESS_GRANTED =
  'This tenant may hold live credentials. Live searches reach real publishers under the ' +
  'provider’s identity, against a rate budget shared with every other tenant.';

export const LIVE_ACCESS_NOT_ENTITLED =
  'This tenant’s entitlement does not include the live environment. Entitlement is granted by ' +
  'the provider; self-service issues credentials within what was granted.';

export const LIVE_ACCESS_EMAIL_NOT_VERIFIED =
  'Confirm the contact email address before issuing a live key. Sandbox keys work immediately ' +
  'and behave identically against fixture sources; a live key sends requests to real ' +
  'publishers, so the address has to be one we can reach (decision D-052).';

/**
 * Decide, from persisted state only.
 *
 * Entitlement is checked first because it is the commercial answer, and a tenant who was never
 * sold live should not be told to check their email — that would describe a route to live
 * access that verifying an address will not open.
 */
export function decideLiveAccess(input: {
  readonly tenant: TenantLiveState | null;
  readonly entitlement: EntitlementLiveState | null;
}): LiveAccessDecision {
  if (input.entitlement === null || !input.entitlement.environments.includes('live')) {
    return { granted: false, blockedBy: 'NOT_ENTITLED', detail: LIVE_ACCESS_NOT_ENTITLED };
  }

  // A tenant row that is missing entirely is not a reason to hand out live access: every
  // credential is issued against a tenant, and one with no record is a state nothing should
  // build on. It is reported as the commercial refusal because that is what it is — there is
  // no tenant here to have been sold anything.
  if (input.tenant === null) {
    return { granted: false, blockedBy: 'NOT_ENTITLED', detail: LIVE_ACCESS_NOT_ENTITLED };
  }

  const selfSignedUp = input.tenant.createdVia === CREATED_VIA_SIGNUP;
  const verified = (input.tenant.emailVerifiedAt ?? null) !== null;

  if (selfSignedUp && !verified) {
    return {
      granted: false,
      blockedBy: 'EMAIL_NOT_VERIFIED',
      detail: LIVE_ACCESS_EMAIL_NOT_VERIFIED,
    };
  }

  return { granted: true, blockedBy: null, detail: LIVE_ACCESS_GRANTED };
}
