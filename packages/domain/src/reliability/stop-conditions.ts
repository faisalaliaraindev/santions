/**
 * Stop conditions — the fourth thing **D17** had to decide, as a value rather than a comment.
 *
 * # What a stop condition is, and what it is not
 *
 * FR-06's table says what to do about a failure *in general*: a 403 is a soft block, so cool the
 * identity, degrade the domain and try once more. That is the right general answer and it is not
 * always the right answer for a **named source under a named approval**. The SEC's fair-access
 * policy, for instance, says plainly that a 403 means the user agent is wrong — so retrying it
 * from a second identity is not a recovery strategy, it is the thing their policy tells us not
 * to do. D17 recorded the answer for that source: **403 halts, and resuming needs fresh
 * approval.**
 *
 * So a stop condition is a per-source escalation of FR-06, recorded beside the source's
 * approval. The invariant that makes it safe to have two rules about one failure is stated here
 * and asserted by a test:
 *
 * > **A stop condition can only ever stop.** It never makes a request permitted that FR-06
 * > refused, never shortens a backoff, never lowers a class. `evaluateStopConditions` returns
 * > "halt" or "nothing to add", and there is no third answer.
 *
 * Without that rule, a per-source override is a hole in the one taxonomy this service has.
 *
 * # Why halting is not the same as a breaker opening
 *
 * A breaker reopens on a clock. A halt does not: the whole point of "403 → halt and require
 * fresh approval" is that a human looks at why the publisher refused before anything is sent
 * again. The service implements a halt by engaging the source's kill switch, which is already
 * one-person-to-engage and four-eyes-to-release (D5) — exactly the shape "fresh approval" needs,
 * and no new mechanism.
 *
 * Pure. The caller supplies the observed signal and the counters; nothing here reads a clock.
 */

import {
  classifyFailure,
  type FailureClass,
  type FailurePolicy,
  type FailureSignal,
} from './failure-classification.js';
import { engageKillSwitch, observeFailure, type SourceHealth } from './source-health.js';

/**
 * The stop conditions recorded for one source, at its approval.
 *
 * Every field is an escalation. A policy with everything switched off — `NO_STOP_CONDITIONS` —
 * leaves FR-06 exactly as it is, which is what a source whose approver recorded none gets.
 */
export interface StopConditionPolicy {
  /**
   * HTTP statuses that halt the source outright.
   *
   * D17 records `[403]` for the SEC: their policy states that a request without a descriptive
   * user agent is refused with 403 and that the IP may be blocked for about ten minutes, so a
   * 403 from them is a statement about *us* and a retry is the wrong response to it.
   */
  readonly haltOnStatuses: readonly number[];
  /**
   * Whether a rate limit halts after its cooldown rather than resuming.
   *
   * FR-06 would honour `Retry-After` and try again up to three times. For a first live source
   * under a first live approval, being rate-limited at all means the recorded rate was wrong,
   * and the thing to do about a wrong rate is to look at it, not to re-enter it more slowly.
   */
  readonly haltOnRateLimit: boolean;
  /** The cooldown applied to a rate limit when the publisher named no `Retry-After`. */
  readonly rateLimitCooldownMs: number;
  /**
   * How many consecutive server errors halt the source. Null means FR-06's own limits stand.
   *
   * A 5xx streak is the publisher's server failing, which is not our fault — but continuing to
   * poll a publisher whose site is down is still traffic they did not want, and a streak is the
   * signal that backing off is not working.
   */
  readonly serverErrorStreakToHalt: number | null;
  /**
   * Whether resuming after a halt needs a fresh named approval rather than a restart.
   *
   * True for anything that halted because the publisher refused us. The service honours it by
   * engaging the kill switch, whose release is four-eyes; false would mean an automatic halt
   * a single operator can wave away, which is not what "fresh approval" means.
   */
  readonly requiresFreshApprovalOnHalt: boolean;
}

/** No escalation: FR-06's table stands unmodified. The default for any source without D17-style terms. */
export const NO_STOP_CONDITIONS: StopConditionPolicy = {
  haltOnStatuses: [],
  haltOnRateLimit: false,
  rateLimitCooldownMs: 0,
  serverErrorStreakToHalt: null,
  requiresFreshApprovalOnHalt: false,
};

export const STOP_REASONS = [
  'HALT_ON_STATUS',
  'HALT_ON_RATE_LIMIT',
  'HALT_ON_SERVER_ERROR_STREAK',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface StopVerdict {
  readonly halt: boolean;
  readonly reason: StopReason | null;
  /** Written for the operator who will be asked to approve a resumption. Never empty on a halt. */
  readonly detail: string;
  /**
   * How long to wait before the halt is even *considered* liftable, in milliseconds, or null.
   *
   * Only meaningful for a rate limit, where the publisher stated a cooldown we must not
   * shorten. It does not lift the halt on its own — a halt is lifted by a person.
   */
  readonly cooldownMs: number | null;
  readonly requiresFreshApproval: boolean;
  /** FR-06's own verdict on the same signal, unchanged. Carried so the caller applies both. */
  readonly policy: FailurePolicy;
}

const SERVER_ERROR_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504, 507, 508]);

/**
 * Evaluate the recorded stop conditions against one observed failure.
 *
 * Returns FR-06's classification either way, so a caller applies the table's policy *and* the
 * halt — the halt never replaces the classification, because the classification is what the
 * coverage record and the breakers read.
 *
 * `consecutiveServerErrors` counts the streak **including this failure**, and is the caller's to
 * keep: the source health document already holds a consecutive-failure counter, and inventing a
 * second one inside a pure function with no memory would be a counter that resets whenever a
 * process restarts.
 */
export function evaluateStopConditions(input: {
  readonly signal: FailureSignal;
  readonly conditions: StopConditionPolicy;
  readonly consecutiveServerErrors: number;
}): StopVerdict {
  const policy = classifyFailure(input.signal);
  const status = input.signal.httpStatus;
  const nothing: StopVerdict = {
    halt: false,
    reason: null,
    detail: '',
    cooldownMs: null,
    requiresFreshApproval: false,
    policy,
  };

  // Our own gate refusing a URL is not the publisher doing anything, so it can never halt the
  // source. Same rule as D-035, one layer up: a refusal is our decision not to ask.
  if (input.signal.policyRefusal === true || input.signal.robotsDisallow === true) {
    return nothing;
  }

  const halt = (reason: StopReason, detail: string, cooldownMs: number | null): StopVerdict => ({
    halt: true,
    reason,
    detail,
    cooldownMs,
    requiresFreshApproval: input.conditions.requiresFreshApprovalOnHalt,
    policy,
  });

  if (status !== undefined && input.conditions.haltOnStatuses.includes(status)) {
    return halt(
      'HALT_ON_STATUS',
      `The source returned ${String(status)}, which its recorded stop conditions treat as a ` +
        `halt rather than as a retryable failure. Polling is stopped. Resuming requires a ` +
        `person to establish why the publisher refused the request — typically that the ` +
        `user agent or the rate is not what was approved.`,
      null,
    );
  }

  if (
    input.conditions.haltOnRateLimit &&
    (status === 429 || input.signal.retryAfterSeconds !== undefined)
  ) {
    const cooldownMs =
      input.signal.retryAfterSeconds === undefined
        ? input.conditions.rateLimitCooldownMs
        : Math.round(input.signal.retryAfterSeconds * 1000);
    return halt(
      'HALT_ON_RATE_LIMIT',
      `The source rate-limited this request. The cooldown it asked for is honoured in full ` +
        `(${String(cooldownMs)}ms) and polling is then stopped rather than resumed: being ` +
        `rate-limited at all means the approved rate was wrong, and the answer to a wrong rate ` +
        `is to look at it.`,
      cooldownMs,
    );
  }

  const streakLimit = input.conditions.serverErrorStreakToHalt;
  if (
    streakLimit !== null &&
    status !== undefined &&
    SERVER_ERROR_STATUSES.has(status) &&
    input.consecutiveServerErrors >= streakLimit
  ) {
    return halt(
      'HALT_ON_SERVER_ERROR_STREAK',
      `${String(input.consecutiveServerErrors)} consecutive server errors (last: ` +
        `${String(status)}), at or past the recorded limit of ${String(streakLimit)}. Backing ` +
        `off further would still be traffic at a publisher whose site is not answering, so ` +
        `polling is stopped.`,
      null,
    );
  }

  return nothing;
}

/**
 * Does this signal count toward a server-error streak?
 *
 * Exported so the caller keeping the counter uses the same definition the evaluation does. A
 * streak counted one way and checked another is a limit that fires at the wrong number.
 */
export function isServerError(signal: FailureSignal): boolean {
  return signal.httpStatus !== undefined && SERVER_ERROR_STATUSES.has(signal.httpStatus);
}

/** What one observed failure did to a source: to its health, and to whether it may continue. */
export interface FailureApplication {
  readonly health: SourceHealth;
  readonly failureClass: FailureClass;
  readonly verdict: StopVerdict;
  /** True when this failure halted the source — the kill switch is engaged on `health`. */
  readonly halted: boolean;
  /** The streak as it stands after this failure. The caller stores it. */
  readonly consecutiveServerErrors: number;
}

/**
 * Apply one observed failure: classify it, fold it into health, and apply the stop conditions.
 *
 * **This composition lives here rather than in the service, deliberately.** The service is the
 * only caller that talks to a database, so a test of the stop conditions end to end would
 * otherwise have to re-compose these four steps itself — and a test that re-implements the thing
 * it is testing passes whenever the two implementations agree, including when both are wrong.
 * With the composition in one pure function, the trip-wire harness and the live service run the
 * *same* code and the test means what it claims.
 *
 * The order is the policy:
 *
 * 1. **Classify**, through the FR-06 table. Nothing below may reclassify.
 * 2. **Fold into health**, so the breaker sees this failure whatever the stop conditions decide.
 * 3. **Evaluate the stop conditions**, which may escalate to a halt and may do nothing else.
 * 4. **Halt by engaging the kill switch**, if they said so and it is not already engaged.
 *
 * Step 2 before step 4 matters: a halt must not hide the failure from the breaker, or releasing
 * the halt would release a source whose recorded state says it was healthy.
 */
export function applyObservedFailure(input: {
  readonly health: SourceHealth;
  readonly signal: FailureSignal;
  readonly conditions: StopConditionPolicy;
  /** The streak **before** this failure. Zero for a source that has not been failing. */
  readonly consecutiveServerErrors: number;
  readonly now: Date;
  /** Recorded as the engager on an automatic halt. The service passes its system actor. */
  readonly haltedBy: string;
}): FailureApplication {
  const failureClass = classifyFailure(input.signal).failureClass;
  const health = observeFailure({ health: input.health, failureClass, now: input.now });

  const consecutiveServerErrors = isServerError(input.signal)
    ? input.consecutiveServerErrors + 1
    : 0;

  const verdict = evaluateStopConditions({
    signal: input.signal,
    conditions: input.conditions,
    consecutiveServerErrors,
  });

  if (!verdict.halt || health.killSwitch !== null) {
    return { health, failureClass, verdict, halted: false, consecutiveServerErrors };
  }

  return {
    health: engageKillSwitch({
      health,
      reason: haltReason(verdict, failureClass),
      engagedBy: input.haltedBy,
      now: input.now,
    }),
    failureClass,
    verdict,
    halted: true,
    consecutiveServerErrors,
  };
}

/**
 * The sentence recorded on the kill switch, and therefore on every coverage statement that
 * wanted this source afterwards. Written for the person who will be asked to release it.
 */
export function haltReason(verdict: StopVerdict, failureClass: FailureClass): string {
  return (
    `Stop condition ${verdict.reason ?? 'HALT'} (${failureClass}): ${verdict.detail}` +
    (verdict.requiresFreshApproval
      ? ' Releasing this source requires a different authorised person, who must first ' +
        'establish why the publisher refused.'
      : '')
  );
}
