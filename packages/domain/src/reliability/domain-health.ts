/**
 * The **per-domain** half of FR-06's reliability controls — decision **D-040**.
 *
 * # Why there are two breakers and not one
 *
 * D5 built the per-source breaker: a source is a registry entry somebody approved, with a
 * licence, a budget and a kill switch, and the breaker there answers "is this *source* usable
 * right now?". FR-06 asks for something else as well. Its policy table says a `SOFT_BLOCK`
 * marks the **domain** degraded and a `HARD_BLOCK` **suspends the domain** — not the source —
 * and for a discovery source those are genuinely different things.
 *
 * A news feed is one source that hands us links to a hundred publishers. When `elmundo.example`
 * starts returning 403 to every request, the fact belongs to `elmundo.example`, not to the feed
 * that mentioned it: suspending the feed would cost every other publisher it lists, and doing
 * nothing would keep us hammering a host that has already refused. The per-source breaker
 * cannot express that, because the source and the host it linked to are not the same entity.
 *
 * So: the source breaker guards the **agreement**, this one guards the **publisher**. Both must
 * allow a request before it is made, and the reason they can coexist without arguing is that
 * neither invents a taxonomy — both read the same FR-06 policy table through the same two
 * predicates, `opensBreakerImmediately` and `countsAgainstSourceHealth`, imported from
 * `source-health.ts` rather than restated here.
 *
 * # Suspension is sticky; degradation expires
 *
 * A `DEGRADE` is a wait: a rate limit, a soft block, a publisher saying "not so fast". It ends
 * on a clock, and preferably on the publisher's own clock — `Retry-After` is honoured exactly
 * when they gave one.
 *
 * A `SUSPEND` is a refusal, and FR-06 pairs it with `alertOperator: true`. It does **not** end
 * on a clock, because nothing about the passage of time answers the question a hard block
 * raises. Releasing it is an operator's act, exactly as releasing a source kill switch is.
 *
 * Pure. Every function takes `now` and returns a new value; nothing reads a clock or a socket.
 */

import { failurePolicy, type FailureClass } from './failure-classification.js';
import {
  countsAgainstSourceHealth,
  opensBreakerImmediately,
  type BreakerConfig,
  type BreakerState,
  DEFAULT_BREAKER_CONFIG,
} from './source-health.js';

/** Why a domain is suspended, in terms an operator can act on. */
export interface DomainSuspension {
  readonly at: string;
  readonly failureClass: FailureClass;
  /** The sentence the fetch layer observed. Reaches the coverage statement verbatim. */
  readonly detail: string;
  /**
   * Who or what suspended it.
   *
   * `SYSTEM` for a suspension the FR-06 table produced, and an operator's identifier for one a
   * person engaged. Recorded because releasing is four-eyes in the operator case and the
   * release check has to know which case it is looking at.
   */
  readonly suspendedBy: string;
}

/** The mutable observation document for one registrable domain. */
export interface DomainHealth {
  /** The registrable domain, from `registrableDomain`. Never a bare host and never a TLD. */
  readonly domain: string;
  readonly breaker: BreakerState;
  readonly openedAt: string | null;
  readonly halfOpenProbes: number;
  readonly consecutiveFailures: number;
  readonly lastFailureClass: FailureClass | null;
  readonly lastFailureAt: string | null;
  readonly lastSuccessAt: string | null;
  /**
   * When the current degradation lifts, ISO 8601 UTC, or null when the domain is not degraded.
   *
   * Set from `Retry-After` where the publisher sent one, because a publisher who says "wait
   * thirty seconds" has answered the question and substituting our own number is us deciding we
   * know better.
   */
  readonly degradedUntil: string | null;
  readonly suspension: DomainSuspension | null;
}

export interface DomainBreakerConfig extends BreakerConfig {
  /**
   * How long a `DEGRADE` holds the domain when the publisher named no `Retry-After`.
   *
   * Ten minutes, matching the block duration the largest published fair-access policy this
   * project has read states for an exceeded rate (the SEC's, D17). Guessing shorter than a
   * publisher's own cooldown means walking straight back into the block.
   */
  readonly degradeCooldownMs: number;
}

export const DEFAULT_DOMAIN_BREAKER_CONFIG: DomainBreakerConfig = {
  ...DEFAULT_BREAKER_CONFIG,
  degradeCooldownMs: 10 * 60_000,
};

/** A health document for a domain nothing has been observed about yet. */
export function newDomainHealth(input: { readonly domain: string }): DomainHealth {
  return {
    domain: input.domain,
    breaker: 'CLOSED',
    openedAt: null,
    halfOpenProbes: 0,
    consecutiveFailures: 0,
    lastFailureClass: null,
    lastFailureAt: null,
    lastSuccessAt: null,
    degradedUntil: null,
    suspension: null,
  };
}

/**
 * Fold in a failure observed against this domain.
 *
 * `failureClass` is supplied by the caller, from `classifyFailure` on the signal the fetch layer
 * saw, so classification stays the single decision FR-06 makes it and is not made twice.
 *
 * **A gate refusal must never reach this function**, for the same reason D-035 keeps it away
 * from source health: `policyRefusal` and `robotsDisallow` classify as `HARD_BLOCK`, and
 * suspending a publisher because one of their URLs failed *our* screening would be recording
 * our decision as their refusal.
 */
export function observeDomainFailure(input: {
  readonly health: DomainHealth;
  readonly failureClass: FailureClass;
  readonly detail: string;
  readonly now: Date;
  readonly retryAfterSeconds?: number | undefined;
  readonly config?: DomainBreakerConfig | undefined;
}): DomainHealth {
  const config = input.config ?? DEFAULT_DOMAIN_BREAKER_CONFIG;
  const policy = failurePolicy(input.failureClass);
  const at = input.now.toISOString();

  const base: DomainHealth = {
    ...input.health,
    lastFailureClass: input.failureClass,
    lastFailureAt: at,
  };

  if (policy.domainAction === 'SUSPEND') {
    // Sticky. Re-observing keeps the first suspension: the first one is the one an operator was
    // alerted about, and overwriting its timestamp would make the alert and the record disagree
    // about when the publisher refused us.
    return {
      ...base,
      breaker: 'OPEN',
      openedAt: at,
      halfOpenProbes: 0,
      suspension: base.suspension ?? {
        at,
        failureClass: input.failureClass,
        detail: input.detail,
        suspendedBy: 'SYSTEM',
      },
    };
  }

  const degraded: DomainHealth =
    policy.domainAction === 'DEGRADE'
      ? {
          ...base,
          degradedUntil: laterOf(
            base.degradedUntil,
            new Date(
              input.now.getTime() +
                (input.retryAfterSeconds === undefined
                  ? config.degradeCooldownMs
                  : Math.round(input.retryAfterSeconds * 1000)),
            ).toISOString(),
          ),
        }
      : base;

  if (opensBreakerImmediately(input.failureClass)) {
    return { ...degraded, breaker: 'OPEN', openedAt: at, halfOpenProbes: 0 };
  }

  if (!countsAgainstSourceHealth(input.failureClass)) {
    // A 404 or an oversize document. A fact about one URL, not about the publisher.
    return degraded;
  }

  const consecutiveFailures = degraded.consecutiveFailures + 1;
  if (consecutiveFailures >= config.failureThreshold || degraded.breaker === 'HALF_OPEN') {
    return { ...degraded, consecutiveFailures, breaker: 'OPEN', openedAt: at, halfOpenProbes: 0 };
  }
  return { ...degraded, consecutiveFailures };
}

/**
 * Fold in a success.
 *
 * Closes the breaker, and **deliberately does not clear a degradation**. The two answer
 * different questions: the breaker asks "is this host answering?", which one success settles,
 * while `degradedUntil` is a wait the publisher asked for and only their clock ends. Clearing it
 * on a success would mean one request that slipped through the cooldown cancels the cooldown.
 *
 * A suspension is likewise untouched. Nothing this side of an operator releases a hard block.
 */
export function observeDomainSuccess(input: {
  readonly health: DomainHealth;
  readonly now: Date;
}): DomainHealth {
  return {
    ...input.health,
    breaker: 'CLOSED',
    openedAt: null,
    halfOpenProbes: 0,
    consecutiveFailures: 0,
    lastSuccessAt: input.now.toISOString(),
  };
}

/** The breaker's state as of `now`, with the cooldown applied. Mirrors `breakerAt` for sources. */
export function domainBreakerAt(
  health: DomainHealth,
  now: Date,
  config: DomainBreakerConfig = DEFAULT_DOMAIN_BREAKER_CONFIG,
): DomainHealth {
  if (health.breaker !== 'OPEN' || health.openedAt === null || health.suspension !== null) {
    // A suspended domain never cools down into a probe. That is the whole difference between
    // `SUSPEND` and `DEGRADE`, and letting the cooldown apply here would erase it.
    return health;
  }
  const openedAt = Date.parse(health.openedAt);
  if (Number.isNaN(openedAt) || now.getTime() - openedAt < config.openDurationMs) {
    // An unparsable timestamp reads as "just opened" rather than "long expired": the safe
    // reading of a corrupt field is the one that does not send traffic.
    return health;
  }
  return { ...health, breaker: 'HALF_OPEN', halfOpenProbes: 0 };
}

/** Record that a permitted request is being made: count a half-open probe. */
export function spendDomainProbe(health: DomainHealth): DomainHealth {
  return health.breaker === 'HALF_OPEN'
    ? { ...health, halfOpenProbes: health.halfOpenProbes + 1 }
    : health;
}

export const DOMAIN_REFUSALS = [
  'DOMAIN_SUSPENDED',
  'DOMAIN_COOLING',
  'DOMAIN_BREAKER_OPEN',
] as const;
export type DomainRefusal = (typeof DOMAIN_REFUSALS)[number];

export interface DomainAccessDecision {
  readonly allowed: boolean;
  readonly refusal: DomainRefusal | null;
  /** Written for a reviewer. It reaches the coverage statement verbatim. */
  readonly detail: string;
  /** The health document as the decision leaves it — cooldown applied. */
  readonly health: DomainHealth;
}

/**
 * May this domain be called, **right now**?
 *
 * Ordered the way the source decision is ordered, and for the same reason: a domain that has
 * refused us must report as refused even when it is also cooling and its breaker is also open,
 * because those are three different things to tell an operator and only the first is one
 * somebody will be asked about.
 */
export function decideDomainAccess(input: {
  readonly health: DomainHealth;
  readonly now: Date;
  readonly config?: DomainBreakerConfig | undefined;
}): DomainAccessDecision {
  const config = input.config ?? DEFAULT_DOMAIN_BREAKER_CONFIG;
  const health = domainBreakerAt(input.health, input.now, config);

  const refuse = (refusal: DomainRefusal, detail: string): DomainAccessDecision => ({
    allowed: false,
    refusal,
    detail,
    health,
  });

  if (health.suspension !== null) {
    return refuse(
      'DOMAIN_SUSPENDED',
      `${health.domain} was suspended at ${health.suspension.at} after a ` +
        `${health.suspension.failureClass}: ${health.suspension.detail} No request was made. ` +
        `A suspended domain is released by an operator, not by a cooldown.`,
    );
  }

  if (health.degradedUntil !== null) {
    const until = Date.parse(health.degradedUntil);
    if (Number.isNaN(until) || until > input.now.getTime()) {
      return refuse(
        'DOMAIN_COOLING',
        `${health.domain} is in a cooldown until ${health.degradedUntil} after a ` +
          `${health.lastFailureClass ?? 'failure'}. No request was made.`,
      );
    }
  }

  if (health.breaker === 'OPEN') {
    return refuse(
      'DOMAIN_BREAKER_OPEN',
      `The circuit breaker for ${health.domain} is open after ` +
        `${String(health.consecutiveFailures)} failure(s)` +
        `${health.lastFailureClass === null ? '' : ` (last: ${health.lastFailureClass})`}. ` +
        `Requests are held until the cooldown elapses.`,
    );
  }

  if (health.breaker === 'HALF_OPEN' && health.halfOpenProbes >= config.halfOpenProbeLimit) {
    return refuse(
      'DOMAIN_BREAKER_OPEN',
      `The circuit breaker for ${health.domain} is half-open and its probe allowance is spent.`,
    );
  }

  return { allowed: true, refusal: null, detail: 'Permitted.', health };
}

/** Suspend a domain by hand. One person, effective immediately — as the kill switch is (D5). */
export function suspendDomain(input: {
  readonly health: DomainHealth;
  readonly reason: string;
  readonly suspendedBy: string;
  readonly now: Date;
}): DomainHealth {
  if (input.health.suspension !== null) {
    return input.health;
  }
  const at = input.now.toISOString();
  return {
    ...input.health,
    breaker: 'OPEN',
    openedAt: at,
    halfOpenProbes: 0,
    suspension: {
      at,
      failureClass: 'HARD_BLOCK',
      detail: input.reason,
      suspendedBy: input.suspendedBy,
    },
  };
}

/**
 * Release a suspension, and reset the breaker and the cooldown with it.
 *
 * All three are cleared on the same reasoning `releaseKillSwitch` clears the breaker: the
 * failures accumulated during a suspension describe the suspension, not the publisher, and
 * leaving them would mean a released domain is refused by its own breaker for a cooldown
 * nobody asked for. Whether the *releaser* may be the person who suspended it is a four-eyes
 * question for the service, not for a pure function.
 */
export function releaseDomainSuspension(health: DomainHealth): DomainHealth {
  return {
    ...health,
    suspension: null,
    breaker: 'CLOSED',
    openedAt: null,
    halfOpenProbes: 0,
    consecutiveFailures: 0,
    degradedUntil: null,
  };
}

/** The later of two ISO instants, treating null and unparsable values as "no constraint". */
function laterOf(existing: string | null, candidate: string): string {
  if (existing === null) {
    return candidate;
  }
  const a = Date.parse(existing);
  const b = Date.parse(candidate);
  if (Number.isNaN(a)) {
    return candidate;
  }
  return a >= b ? existing : candidate;
}
