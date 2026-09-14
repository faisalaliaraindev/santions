/**
 * Phase D step D5 — source health: the breaker, the budgets and the kill switch, as pure
 * functions over an observation document.
 *
 * # The separation this file exists to hold
 *
 * A `SourceVersion` is an **immutable approved artefact**: what an approver permitted, frozen so
 * that a search run six months ago can still explain itself under the terms it actually ran
 * under. Observed availability, breaker state and budget counters are the opposite — they change
 * every few seconds and nobody approves them.
 *
 * Putting one inside the other forces a choice between breaking immutability and losing the
 * data, so `SourceHealth` is a **separate mutable document keyed by `sourceId`**, carrying
 * `observedVersion` as a reference to the version it was observing. **The approved version says
 * what is permitted; health says what is happening.**
 *
 * # The breaker invents no failure taxonomy
 *
 * FR-06's classification table is the only failure taxonomy in this service, and the breaker
 * reads it rather than restating it. Two properties of a `FailurePolicy` decide everything:
 *
 * - `domainAction === 'SUSPEND'`, or `alertOperator` — the source has told us to stop, or a human
 *   has to know. The breaker opens **immediately**, without waiting for a threshold. This is the
 *   hard block and the revoked credential: five more attempts at a source that has already
 *   refused is the behaviour the hard constraints exist to prevent.
 * - `domainAction !== 'NONE' || retryable` — the failure says something about the *source*
 *   rather than about one document, so it counts toward the consecutive-failure threshold.
 *
 * What that second rule excludes is the point of writing it as a rule. A `CONTENT_ERROR` (a 404
 * on one article) and an `OVERSIZE` (one enormous PDF) are facts about a document. A breaker that
 * counted them would open on a source that is working perfectly and is merely being asked for
 * things that are not there — and a source wrongly held open is a coverage gap on every
 * subsequent run.
 *
 * # Purity
 *
 * Every function here takes `now` and returns a new value. Nothing reads a clock, a socket or a
 * random number; the service in `apps/api/src/sources/source-health.service.ts` is what persists
 * the results. That is what lets the whole breaker be tested at millisecond boundaries with no
 * infrastructure and no waiting.
 */

import type { SourceCoverageOutcome } from '../coverage/result-state.js';

import { classifyFailure, failurePolicy, type FailureClass } from './failure-classification.js';

/**
 * Breaker states.
 *
 * `HALF_OPEN` is not a nicety. Without it, an open breaker either stays open forever or slams
 * fully closed at the end of a cooldown and sends the whole backlog at a source that has just
 * come back — which is how a recovering source is knocked over by its own clients for the second
 * time. Half-open admits a bounded number of probes and closes only if they succeed.
 */
export const BREAKER_STATES = ['CLOSED', 'OPEN', 'HALF_OPEN'] as const;
export type BreakerState = (typeof BREAKER_STATES)[number];

/**
 * A spend window. `windowStart` is the start of the current hour or day in ISO 8601 UTC.
 *
 * Fixed windows rather than a sliding count, deliberately: a free tier is published as "N calls
 * per hour" and is enforced by the publisher on their clock, so approximating it with a sliding
 * window would let us exceed the published allowance inside a clock hour while believing we had
 * not. Under-spending at a window boundary is the safe error here.
 */
export interface BudgetWindow {
  /** ISO 8601 UTC instant at which this window opened. */
  readonly windowStart: string;
  readonly spent: number;
}

/**
 * The kill switch, and the licence clock that behaves identically (T36).
 *
 * `engagedBy` and `reason` are not optional, and the reason reaches the coverage statement: a
 * run that did not consult a source must say which suspension stopped it, so that a reviewer
 * reading a narrow result learns *why* it is narrow rather than inferring that the source had
 * nothing.
 */
export interface SourceKillSwitch {
  readonly engagedAt: string;
  readonly engagedBy: string;
  readonly reason: string;
}

/** The mutable observation document, in the shape the domain reasons about. */
export interface SourceHealth {
  readonly sourceId: string;
  /**
   * The approved version these observations were made against. A reference, never a copy: when
   * a new version activates, health keeps accumulating and records which version it is now
   * watching, so "this source has been failing since v4" is answerable.
   */
  readonly observedVersion: number;

  readonly breaker: BreakerState;
  /** When the breaker last opened. Null whenever it is `CLOSED`. */
  readonly openedAt: string | null;
  /** Probes admitted since the breaker went half-open. */
  readonly halfOpenProbes: number;
  readonly consecutiveFailures: number;
  readonly lastFailureClass: FailureClass | null;
  readonly lastFailureAt: string | null;
  readonly lastSuccessAt: string | null;

  readonly hourly: BudgetWindow;
  readonly daily: BudgetWindow;

  /** Engaged by an operator. Null when the source is not suspended. */
  readonly killSwitch: SourceKillSwitch | null;
  /**
   * When the licence terms this source runs under expire, if they do.
   *
   * Copied from the approved version onto the health document so that the *decision* to stop
   * fetching is made from one record read at the point of use. T36 names licence expiry
   * explicitly, and it is not a special case: past this instant the source is refused on exactly
   * the path an engaged kill switch takes.
   */
  readonly licenceExpiresAt: string | null;
}

export interface BreakerConfig {
  /** Consecutive qualifying failures that open the breaker. */
  readonly failureThreshold: number;
  /** How long the breaker stays `OPEN` before admitting a probe. */
  readonly openDurationMs: number;
  /** Probes admitted while `HALF_OPEN` before it is treated as open again. */
  readonly halfOpenProbeLimit: number;
}

/**
 * Defaults, stated once.
 *
 * Three failures rather than one: a single timeout is noise, and a breaker that opens on noise
 * produces more coverage gaps than it prevents. Five minutes rather than thirty: the cost of
 * probing too early is one refused request, and the cost of probing too late is every run in
 * between reporting a gap at a source that recovered.
 */
export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 3,
  openDurationMs: 5 * 60_000,
  halfOpenProbeLimit: 1,
};

/** The budgets the planner spends against, as the approved version declares them. */
export interface SourceBudgets {
  /** Free-tier calls per clock hour. Null means the source declares no hourly limit. */
  readonly hourlyBudget: number | null;
  /** Free-tier calls per clock day. Null means the source declares no daily limit. */
  readonly dailyBudget: number | null;
}

function hourStart(now: Date): string {
  const d = new Date(now.getTime());
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function dayStart(now: Date): string {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** A health document for a source nothing has been observed about yet. */
export function newSourceHealth(input: {
  readonly sourceId: string;
  readonly observedVersion: number;
  readonly now: Date;
  readonly licenceExpiresAt?: string | null | undefined;
}): SourceHealth {
  return {
    sourceId: input.sourceId,
    observedVersion: input.observedVersion,
    breaker: 'CLOSED',
    openedAt: null,
    halfOpenProbes: 0,
    consecutiveFailures: 0,
    lastFailureClass: null,
    lastFailureAt: null,
    lastSuccessAt: null,
    hourly: { windowStart: hourStart(input.now), spent: 0 },
    daily: { windowStart: dayStart(input.now), spent: 0 },
    killSwitch: null,
    licenceExpiresAt: input.licenceExpiresAt ?? null,
  };
}

/**
 * Whether a failure of this class says anything about the *source*.
 *
 * Read off the FR-06 policy, never off the class name. A class added to the table with
 * `domainAction: 'DEGRADE'` starts counting here without this file being edited, which is the
 * property that keeps one taxonomy from becoming two.
 */
export function countsAgainstSourceHealth(failureClass: FailureClass): boolean {
  const policy = failurePolicy(failureClass);
  return policy.domainAction !== 'NONE' || policy.retryable;
}

/** Whether a failure of this class opens the breaker without waiting for a threshold. */
export function opensBreakerImmediately(failureClass: FailureClass): boolean {
  const policy = failurePolicy(failureClass);
  return policy.domainAction === 'SUSPEND' || policy.alertOperator;
}

/**
 * Fold in an observed failure.
 *
 * Returns a new health document. The `FailureClass` is supplied by the caller — normally from
 * `classifyFailure` on the signal the fetch layer observed — so that classification stays the
 * single decision it is in FR-06 and is not made twice, differently, here.
 */
export function observeFailure(input: {
  readonly health: SourceHealth;
  readonly failureClass: FailureClass;
  readonly now: Date;
  readonly config?: BreakerConfig | undefined;
}): SourceHealth {
  const config = input.config ?? DEFAULT_BREAKER_CONFIG;
  const at = input.now.toISOString();
  const base: SourceHealth = {
    ...input.health,
    lastFailureClass: input.failureClass,
    lastFailureAt: at,
  };

  // Checked first, and before the counting gate, because "stop" outranks "how many". A revoked
  // credential is not retryable and degrades no domain, so it does not *count* — and it must
  // still open the breaker on its first occurrence, because every subsequent call will fail the
  // same way and a human has to know.
  if (opensBreakerImmediately(input.failureClass)) {
    return { ...base, breaker: 'OPEN', openedAt: at, halfOpenProbes: 0 };
  }

  if (!countsAgainstSourceHealth(input.failureClass)) {
    // A dead link or an oversized document. Recorded, so the operator can see it, and
    // deliberately not counted: this is a fact about one document, not about the source.
    return base;
  }

  const consecutiveFailures = base.consecutiveFailures + 1;
  if (consecutiveFailures >= config.failureThreshold || base.breaker === 'HALF_OPEN') {
    // A probe that fails re-opens the breaker at once. Waiting for a further two failures
    // would mean the half-open state costs three requests at a source that is still down.
    return { ...base, consecutiveFailures, breaker: 'OPEN', openedAt: at, halfOpenProbes: 0 };
  }

  return { ...base, consecutiveFailures };
}

/** Fold in an observed failure from the raw signal, classifying it through FR-06 on the way. */
export function observeFailureSignal(input: {
  readonly health: SourceHealth;
  readonly signal: Parameters<typeof classifyFailure>[0];
  readonly now: Date;
  readonly config?: BreakerConfig | undefined;
}): SourceHealth {
  return observeFailure({
    health: input.health,
    failureClass: classifyFailure(input.signal).failureClass,
    now: input.now,
    ...(input.config === undefined ? {} : { config: input.config }),
  });
}

/**
 * Fold in an observed success.
 *
 * A success closes the breaker outright rather than decrementing a counter. The question the
 * breaker answers is "is this source answering right now?", and one answer is the evidence for
 * yes; a decaying counter would keep a recovered source degraded for no reason a user could be
 * told.
 */
export function observeSuccess(input: {
  readonly health: SourceHealth;
  readonly now: Date;
}): SourceHealth {
  return {
    ...input.health,
    breaker: 'CLOSED',
    openedAt: null,
    halfOpenProbes: 0,
    consecutiveFailures: 0,
    lastSuccessAt: input.now.toISOString(),
  };
}

/**
 * The breaker's state as of `now`, with the cooldown applied.
 *
 * Separate from `observeFailure` because the transition out of `OPEN` is driven by **time**, not
 * by an event: nothing happens at the source to tell us the cooldown elapsed. Callers read this
 * rather than the stored `breaker` field, and the service writes back whatever it returns.
 */
export function breakerAt(
  health: SourceHealth,
  now: Date,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
): SourceHealth {
  if (health.breaker !== 'OPEN' || health.openedAt === null) {
    return health;
  }
  const openedAt = Date.parse(health.openedAt);
  if (Number.isNaN(openedAt)) {
    // An unparsable timestamp is treated as "just opened" rather than "long expired". The safe
    // reading of a corrupt field is the one that does not send traffic.
    return health;
  }
  if (now.getTime() - openedAt < config.openDurationMs) {
    return health;
  }
  return { ...health, breaker: 'HALF_OPEN', halfOpenProbes: 0 };
}

/** Roll a window forward when the clock has moved past it. */
function rolled(window: BudgetWindow, start: string): BudgetWindow {
  return window.windowStart === start ? window : { windowStart: start, spent: 0 };
}

/** Both windows, rolled to `now`. Exported so a caller can read a spend without a decision. */
export function rollBudgets(health: SourceHealth, now: Date): SourceHealth {
  const hourly = rolled(health.hourly, hourStart(now));
  const daily = rolled(health.daily, dayStart(now));
  if (hourly === health.hourly && daily === health.daily) {
    return health;
  }
  return { ...health, hourly, daily };
}

export const ACCESS_REFUSALS = [
  'KILL_SWITCH_ENGAGED',
  'LICENCE_EXPIRED',
  'VERSION_NOT_ACTIVE',
  'BREAKER_OPEN',
  'HOURLY_BUDGET_EXHAUSTED',
  'DAILY_BUDGET_EXHAUSTED',
] as const;
export type AccessRefusal = (typeof ACCESS_REFUSALS)[number];

export interface SourceAccessDecision {
  readonly allowed: boolean;
  readonly refusal: AccessRefusal | null;
  /** Written for a reviewer, not for a log line. It reaches the coverage statement verbatim. */
  readonly detail: string;
  /** The health document as the decision leaves it — cooldown applied, windows rolled. */
  readonly health: SourceHealth;
}

/**
 * May this source be used, **right now**?
 *
 * This is the T36 function. A run pins a source version at plan time, and if access were checked
 * only there, a source suspended for a rights violation would keep being fetched for the length
 * of every in-flight run — minutes or hours during which the operator believes they have stopped
 * it. So the pipeline calls this at the **point of use**, immediately before each call, and the
 * kill switch therefore takes effect mid-run.
 *
 * **Order is the policy.** Rights first (kill switch, licence, an inactive version), then health
 * (the breaker), then economics (budgets). A suspended source must report as suspended even when
 * its breaker is also open and its budget is also spent, because those are three different
 * things to tell an operator and only the first is a reason somebody will be asked about.
 */
export function decideSourceAccess(input: {
  readonly health: SourceHealth;
  readonly budgets: SourceBudgets;
  /** The pinned version's lifecycle status, as the registry holds it right now. */
  readonly versionStatus?: string | undefined;
  readonly now: Date;
  readonly config?: BreakerConfig | undefined;
}): SourceAccessDecision {
  const config = input.config ?? DEFAULT_BREAKER_CONFIG;
  const health = rollBudgets(breakerAt(input.health, input.now, config), input.now);

  const refuse = (refusal: AccessRefusal, detail: string): SourceAccessDecision => ({
    allowed: false,
    refusal,
    detail,
    health,
  });

  if (health.killSwitch !== null) {
    return refuse(
      'KILL_SWITCH_ENGAGED',
      `Suspended by ${health.killSwitch.engagedBy} at ${health.killSwitch.engagedAt}: ` +
        `${health.killSwitch.reason}. No request was made to this source.`,
    );
  }

  if (health.licenceExpiresAt !== null) {
    const expires = Date.parse(health.licenceExpiresAt);
    // An unparsable expiry refuses. A licence clock nobody can read is not a licence we can
    // claim to be inside.
    if (Number.isNaN(expires) || expires <= input.now.getTime()) {
      return refuse(
        'LICENCE_EXPIRED',
        `The licence terms recorded for this source expired at ${health.licenceExpiresAt}. ` +
          `No request was made to this source.`,
      );
    }
  }

  if (input.versionStatus !== undefined && input.versionStatus !== 'ACTIVE') {
    return refuse(
      'VERSION_NOT_ACTIVE',
      `The approved source version is ${input.versionStatus}, not ACTIVE. ` +
        `No request was made to this source.`,
    );
  }

  if (health.breaker === 'OPEN') {
    return refuse(
      'BREAKER_OPEN',
      `The circuit breaker is open after ${String(health.consecutiveFailures)} failure(s)` +
        `${health.lastFailureClass === null ? '' : ` (last: ${health.lastFailureClass})`}. ` +
        `Requests are held until the cooldown elapses.`,
    );
  }

  if (health.breaker === 'HALF_OPEN' && health.halfOpenProbes >= config.halfOpenProbeLimit) {
    return refuse(
      'BREAKER_OPEN',
      `The circuit breaker is half-open and its probe allowance is spent. ` +
        `Requests are held until a probe succeeds.`,
    );
  }

  if (input.budgets.hourlyBudget !== null && health.hourly.spent >= input.budgets.hourlyBudget) {
    return refuse(
      'HOURLY_BUDGET_EXHAUSTED',
      `The hourly free-tier budget of ${String(input.budgets.hourlyBudget)} call(s) is spent ` +
        `for the window opening ${health.hourly.windowStart}.`,
    );
  }

  if (input.budgets.dailyBudget !== null && health.daily.spent >= input.budgets.dailyBudget) {
    return refuse(
      'DAILY_BUDGET_EXHAUSTED',
      `The daily free-tier budget of ${String(input.budgets.dailyBudget)} call(s) is spent ` +
        `for the window opening ${health.daily.windowStart}.`,
    );
  }

  return { allowed: true, refusal: null, detail: 'Permitted.', health };
}

/**
 * Record that a permitted call is being made: spend one unit, and count a half-open probe.
 *
 * Spent **before** the call, not after. A budget decremented on success lets a source that is
 * failing be called without limit, which is exactly the source you most want to stop calling —
 * and the publisher counts the request, not the outcome.
 */
export function spendAccess(input: {
  readonly health: SourceHealth;
  readonly now: Date;
  readonly units?: number | undefined;
}): SourceHealth {
  const units = input.units ?? 1;
  const health = rollBudgets(input.health, input.now);
  return {
    ...health,
    hourly: { ...health.hourly, spent: health.hourly.spent + units },
    daily: { ...health.daily, spent: health.daily.spent + units },
    halfOpenProbes:
      health.breaker === 'HALF_OPEN' ? health.halfOpenProbes + units : health.halfOpenProbes,
  };
}

/** Engage the kill switch. Idempotent on reason: re-engaging keeps the first record. */
export function engageKillSwitch(input: {
  readonly health: SourceHealth;
  readonly reason: string;
  readonly engagedBy: string;
  readonly now: Date;
}): SourceHealth {
  if (input.health.killSwitch !== null) {
    return input.health;
  }
  return {
    ...input.health,
    killSwitch: {
      engagedAt: input.now.toISOString(),
      engagedBy: input.engagedBy,
      reason: input.reason,
    },
  };
}

/**
 * Release the kill switch, and close the breaker with it.
 *
 * The breaker is reset deliberately. A source suspended for an hour has accumulated failures
 * that describe the suspension, not the source, and leaving them in place would mean a released
 * source is refused by its own breaker for a cooldown nobody asked for.
 */
export function releaseKillSwitch(health: SourceHealth): SourceHealth {
  return {
    ...health,
    killSwitch: null,
    breaker: 'CLOSED',
    openedAt: null,
    halfOpenProbes: 0,
    consecutiveFailures: 0,
  };
}

/**
 * Turn a refusal into the run's coverage vocabulary (section 6.2).
 *
 * **A refusal is never a silent skip.** Every one of these produces a `SourceCoverageOutcome`
 * that names what stopped the request, because the alternative — a run that quietly consulted
 * one fewer source — reads to a reviewer as a clean result from a search that was never made.
 *
 * The three outcomes are distinguished on purpose:
 *
 * - `SUSPENDED` for a kill switch, an expired licence or a version that is no longer active:
 *   **we chose not to ask.**
 * - `FAILED` for an open breaker: **we asked, repeatedly, and it did not answer.**
 * - `PARTIAL` with `TRUNCATED_BY_QUOTA` for a spent budget: the brief is explicit that budget
 *   exhaustion is a coverage outcome and not an error. Some of the plan ran.
 */
export function accessCoverageOutcome(input: {
  readonly decision: SourceAccessDecision;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly cascadeRung: number;
  readonly queriesAffected: number;
}): SourceCoverageOutcome | null {
  const { refusal, detail } = input.decision;
  if (refusal === null) {
    return null;
  }

  const outcome: SourceCoverageOutcome['outcome'] =
    refusal === 'KILL_SWITCH_ENGAGED' ||
    refusal === 'LICENCE_EXPIRED' ||
    refusal === 'VERSION_NOT_ACTIVE'
      ? 'SUSPENDED'
      : refusal === 'BREAKER_OPEN'
        ? 'FAILED'
        : 'PARTIAL';

  return {
    sourceId: input.sourceId,
    sourceName: input.sourceName,
    cascadeRung: input.cascadeRung,
    outcome,
    detail,
    queriesAffected: input.queriesAffected,
    truncation: outcome === 'PARTIAL' ? 'TRUNCATED_BY_QUOTA' : null,
  };
}

/**
 * The note a **historical** result carries when its source has since been suspended (T36).
 *
 * T36 says a result produced before a suspension is not retro-actively deleted, and that a
 * subsequent read of it must show the source has since been suspended. This is the sentence that
 * appears on such a read. It says *since*, in those words, because the distinction between "this
 * was gathered from a source we have since stopped using" and "this was gathered from a
 * suspended source" is the whole difference between an honest archive and a misleading one.
 *
 * Returns null when the source is not suspended, or when the suspension predates the result — a
 * result produced *after* a suspension should not exist, and labelling it as "since suspended"
 * would state something false about when the data was gathered.
 */
export function sinceSuspendedNote(input: {
  readonly health: Pick<SourceHealth, 'killSwitch' | 'licenceExpiresAt'>;
  readonly producedAt: string;
  /** The read's clock. A parameter, like every other clock in this package. */
  readonly asOf: Date;
}): string | null {
  const produced = Date.parse(input.producedAt);
  if (Number.isNaN(produced)) {
    return null;
  }

  const kill = input.health.killSwitch;
  if (kill !== null) {
    const engaged = Date.parse(kill.engagedAt);
    if (!Number.isNaN(engaged) && engaged >= produced) {
      return (
        `This result was produced before the source was suspended on ${kill.engagedAt} ` +
        `by ${kill.engagedBy} (${kill.reason}). It is unchanged, and the source has not been ` +
        `consulted since.`
      );
    }
    return null;
  }

  if (input.health.licenceExpiresAt !== null) {
    const expires = Date.parse(input.health.licenceExpiresAt);
    if (!Number.isNaN(expires) && expires >= produced && expires <= input.asOf.getTime()) {
      return (
        `This result was produced before the licence terms recorded for the source expired on ` +
        `${input.health.licenceExpiresAt}. It is unchanged, and the source has not been ` +
        `consulted since.`
      );
    }
  }

  return null;
}
