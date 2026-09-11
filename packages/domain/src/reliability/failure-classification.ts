/**
 * FR-06 — failure classification, as written in the specification.
 *
 * This table is the *only* failure taxonomy in the service. REL-01 says classification precedes
 * retry, and the reason it lives here — in the pure package, with no I/O — is that a second
 * taxonomy written next to the retry loop is how "do not blindly retry invalid credentials"
 * becomes a comment rather than a rule. Four of the seven classes must never be retried, and that
 * fact has to be a value the code reads, not a condition someone remembers to write.
 *
 * Pure. The caller supplies the observed signal and the jitter source; nothing here reads a
 * clock, a socket or a random number.
 */

export const FAILURE_CLASSES = [
  'TRANSIENT_NETWORK',
  'RATE_LIMITED',
  'SOFT_BLOCK',
  'HARD_BLOCK',
  'CONTENT_ERROR',
  'AUTH_CREDENTIAL',
  'OVERSIZE',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * What to do after a failure of this class.
 *
 * `maxAttempts` counts total attempts, not retries: 1 means "the first attempt was the only
 * one". The distinction matters because an off-by-one here retries something the specification
 * says must never be retried.
 */
export interface FailurePolicy {
  readonly failureClass: FailureClass;
  readonly retryable: boolean;
  readonly maxAttempts: number;
  /** Cap on a single backoff delay, in milliseconds. */
  readonly backoffCapMs: number | null;
  /** Rotate to a different egress identity before the next attempt (FR-06 egress pool). */
  readonly rotateIdentity: boolean;
  /** Put the current egress identity into `cooling`. */
  readonly coolDownIdentity: boolean;
  /** Mark the domain degraded, or suspend it entirely and alert an operator. */
  readonly domainAction: 'NONE' | 'DEGRADE' | 'SUSPEND';
  /** True when a human has to know: silent revocation and hard blocks do not fix themselves. */
  readonly alertOperator: boolean;
  /** Why this policy, in the words of the specification. Surfaced in coverage detail. */
  readonly rationale: string;
}

const POLICIES: Readonly<Record<FailureClass, FailurePolicy>> = {
  TRANSIENT_NETWORK: {
    failureClass: 'TRANSIENT_NETWORK',
    retryable: true,
    maxAttempts: 5,
    backoffCapMs: 60_000,
    rotateIdentity: false,
    coolDownIdentity: false,
    domainAction: 'NONE',
    alertOperator: false,
    rationale: 'Exponential backoff with full jitter, same identity.',
  },
  RATE_LIMITED: {
    failureClass: 'RATE_LIMITED',
    retryable: true,
    maxAttempts: 3,
    backoffCapMs: 60_000,
    rotateIdentity: true,
    coolDownIdentity: true,
    domainAction: 'DEGRADE',
    alertOperator: false,
    rationale: 'Honour Retry-After exactly; else back off and rotate identity, marking it cooling.',
  },
  SOFT_BLOCK: {
    failureClass: 'SOFT_BLOCK',
    retryable: true,
    maxAttempts: 2,
    backoffCapMs: 60_000,
    rotateIdentity: true,
    coolDownIdentity: true,
    domainAction: 'DEGRADE',
    alertOperator: false,
    // The specification is unambiguous and this is a product rule, not a technical limit.
    rationale:
      'Cool down the identity, mark the domain degraded, one retry from a different identity. ' +
      'Never attempt to solve the challenge.',
  },
  HARD_BLOCK: {
    failureClass: 'HARD_BLOCK',
    retryable: false,
    maxAttempts: 1,
    backoffCapMs: null,
    rotateIdentity: false,
    coolDownIdentity: false,
    domainAction: 'SUSPEND',
    alertOperator: true,
    rationale: 'Do not retry. Suspend the domain and alert an operator.',
  },
  CONTENT_ERROR: {
    failureClass: 'CONTENT_ERROR',
    retryable: false,
    maxAttempts: 1,
    backoffCapMs: null,
    rotateIdentity: false,
    coolDownIdentity: false,
    domainAction: 'NONE',
    alertOperator: false,
    rationale: 'Do not retry. Record a dead lead with provenance.',
  },
  AUTH_CREDENTIAL: {
    failureClass: 'AUTH_CREDENTIAL',
    retryable: false,
    maxAttempts: 1,
    backoffCapMs: null,
    rotateIdentity: false,
    coolDownIdentity: false,
    domainAction: 'NONE',
    alertOperator: true,
    rationale: 'Do not retry. Alert — free-source keys are revoked silently.',
  },
  OVERSIZE: {
    failureClass: 'OVERSIZE',
    retryable: false,
    maxAttempts: 1,
    backoffCapMs: null,
    rotateIdentity: false,
    coolDownIdentity: false,
    domainAction: 'NONE',
    alertOperator: false,
    rationale: 'Abort immediately, record a bounded rejection, free the worker.',
  },
};

/**
 * The policy for a class.
 *
 * `POLICIES` is a total `Record` over `FailureClass`, so adding a class to `FAILURE_CLASSES`
 * without adding its policy is a type error rather than an `undefined` discovered at runtime.
 * That is why there is no defensive check here.
 */
export function failurePolicy(failureClass: FailureClass): FailurePolicy {
  return POLICIES[failureClass];
}

/** The classes that must never be retried, for tests that assert the count directly. */
export const NON_RETRYABLE_CLASSES: readonly FailureClass[] = FAILURE_CLASSES.filter(
  (c) => !POLICIES[c].retryable,
);

/**
 * The observation a caller makes about a failed attempt.
 *
 * Deliberately not an `Error`. Classification must be decidable from facts the fetch layer
 * actually has — a status code, a syscall name, a content-type — rather than from a message
 * string, because message strings change with a library upgrade and would silently reclassify
 * a hard block as a transient one.
 */
export interface FailureSignal {
  readonly httpStatus?: number | undefined;
  /** ECONNRESET, ETIMEDOUT, EAI_AGAIN, and so on. */
  readonly syscallCode?: string | undefined;
  readonly retryAfterSeconds?: number | undefined;
  /** A challenge, interstitial or CAPTCHA page was recognised in the body. */
  readonly challengeDetected?: boolean | undefined;
  /** A 200 whose body was empty after boilerplate removal — a soft block signal. */
  readonly emptyBody?: boolean | undefined;
  /** robots.txt disallows this URL, or the source registry records an explicit refusal. */
  readonly robotsDisallow?: boolean | undefined;
  /** This domain has already refused from more than one egress identity. */
  readonly repeatedAcrossIdentities?: boolean | undefined;
  readonly unparsableBody?: boolean | undefined;
  readonly unexpectedContentType?: boolean | undefined;
  /** Byte or decompressed-size limit exceeded, or a redirect loop. */
  readonly limitExceeded?: boolean | undefined;
}

const TRANSIENT_SYSCALLS = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND_TRANSIENT',
]);
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const CONTENT_STATUSES = new Set([404, 410]);

/**
 * Classify an observed failure.
 *
 * Order matters, and it is ordered by severity of the mistake rather than by likelihood:
 * misclassifying a hard block as transient produces five more requests at a source that has
 * already refused us, which is the behaviour the hard constraints exist to prevent. So the
 * checks that can only mean "stop" are evaluated first.
 */
export function classifyFailure(signal: FailureSignal): FailurePolicy {
  // Stop-immediately signals first.
  if (signal.limitExceeded === true) {
    return failurePolicy('OVERSIZE');
  }
  if (signal.robotsDisallow === true) {
    return failurePolicy('HARD_BLOCK');
  }
  if (signal.httpStatus === 401) {
    return failurePolicy('AUTH_CREDENTIAL');
  }
  if (signal.httpStatus === 403 && signal.repeatedAcrossIdentities === true) {
    return failurePolicy('HARD_BLOCK');
  }

  if (signal.httpStatus === 429 || signal.retryAfterSeconds !== undefined) {
    return failurePolicy('RATE_LIMITED');
  }

  if (
    signal.httpStatus === 403 ||
    signal.challengeDetected === true ||
    (signal.emptyBody === true && signal.httpStatus === 200)
  ) {
    return failurePolicy('SOFT_BLOCK');
  }

  if (
    (signal.httpStatus !== undefined && CONTENT_STATUSES.has(signal.httpStatus)) ||
    signal.unparsableBody === true ||
    signal.unexpectedContentType === true
  ) {
    return failurePolicy('CONTENT_ERROR');
  }

  if (
    (signal.httpStatus !== undefined && TRANSIENT_STATUSES.has(signal.httpStatus)) ||
    (signal.syscallCode !== undefined && TRANSIENT_SYSCALLS.has(signal.syscallCode))
  ) {
    return failurePolicy('TRANSIENT_NETWORK');
  }

  // Unrecognised. Treated as a content error — the *non-retrying* default.
  //
  // The alternative default, "transient", retries something nobody understands against a
  // third-party source. An unknown failure that is genuinely transient costs one lost lead and
  // a visible coverage gap; an unknown failure that is a block and gets retried five times
  // costs the relationship with the source.
  return failurePolicy('CONTENT_ERROR');
}

/**
 * Bounded exponential backoff with full jitter (REL-01).
 *
 * Full jitter, not "base plus a bit": every retry after a shared outage otherwise fires in the
 * same narrow window and the recovering source is knocked over by its own clients. `random`
 * is a parameter so this stays pure and so a test can assert the bounds at both extremes.
 *
 * `Retry-After` is honoured **exactly** when the source gave one. A source that says "wait 30
 * seconds" has told us the answer, and jittering it is us deciding we know better.
 */
export function backoffDelayMs(input: {
  readonly policy: FailurePolicy;
  readonly attempt: number;
  readonly baseMs: number;
  readonly retryAfterSeconds?: number | undefined;
  /** Uniform in [0, 1). Injected, so the bounds are testable. */
  readonly random: number;
}): number {
  if (input.retryAfterSeconds !== undefined) {
    return Math.round(input.retryAfterSeconds * 1000);
  }

  const cap = input.policy.backoffCapMs ?? input.baseMs;
  // attempt is 1-based: the delay before the second attempt is the first backoff.
  const exponential = input.baseMs * 2 ** Math.max(0, input.attempt - 1);
  const ceiling = Math.min(cap, exponential);
  return Math.floor(input.random * ceiling);
}

/** Whether another attempt is permitted, given the class and what has been tried. */
export function shouldRetry(policy: FailurePolicy, attemptsSoFar: number): boolean {
  return policy.retryable && attemptsSoFar < policy.maxAttempts;
}
