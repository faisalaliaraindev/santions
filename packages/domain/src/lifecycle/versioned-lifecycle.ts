/**
 * The versioned approval lifecycle, shared by sources, taxonomy and policy (§4.2, FR-05).
 *
 * One lifecycle, not three. Three copies of an approval workflow drift, and the copy that
 * drifts is the one whose four-eyes test nobody wrote. It lives in the domain package for the
 * same reason `permissions.ts` does: the same decision is made by the HTTP layer, by a worker
 * checking whether a pinned version may still be used, and eventually by the panel — and one
 * place is the only way it stays the same decision.
 *
 * ```
 *   PROPOSED ──submit──▶ AWAITING_APPROVAL ──approve──▶ APPROVED ──begin──▶ ACTIVATING
 *      ▲                        │                                              │
 *      └──── request changes ───┘                          complete ──▶ ACTIVE │
 *                                                          abort ────▶ APPROVED
 *
 *   ACTIVE ──suspend──▶ SUSPENDED ──restore──▶ ACTIVE
 *   ACTIVE ──supersede──▶ SUPERSEDED                    (a newer version took over)
 *   any non-terminal ──retire──▶ RETIRED
 * ```
 *
 * Four properties are load-bearing, and each exists because of a specific way this goes wrong:
 *
 * - **Only `PROPOSED` is editable.** Once a version is submitted for approval its content is
 *   frozen, or the approver approves one thing and a different thing becomes active.
 * - **Only `ACTIVE` is usable.** Every other state — including `APPROVED` — must not be
 *   queryable. Approval is permission to activate, not activation.
 * - **Suspension does not need four eyes; restoring does.** Requiring a second person to *stop*
 *   using a source is how a source that is harming somebody stays live over a weekend. The
 *   asymmetry is deliberate and is not an oversight.
 * - **Activation is two steps, not one.** `BEGIN_ACTIVATION` moves to `ACTIVATING`, the SEC-05
 *   rights evaluation happens against that recorded state, and only `COMPLETE_ACTIVATION`
 *   reaches `ACTIVE`. A single-step activation makes the rights gate an `if` inside a method,
 *   which leaves no evidence when it refuses; this way a refusal is a state transition with an
 *   audit entry and a reason attached to it.
 */

export const LIFECYCLE_STATES = [
  /** Being drafted. The only state in which content may be edited. */
  'PROPOSED',
  /** Submitted. Content frozen, waiting for a different authorised user. */
  'AWAITING_APPROVAL',
  /** Approved by a second person. Permission to activate — not yet in use. */
  'APPROVED',
  /** Activation in progress. The SEC-05 rights gate is evaluated against this state. */
  'ACTIVATING',
  /** In use. The only state anything may read, query or fetch under. */
  'ACTIVE',
  /** Withdrawn from use, reversibly. Kill switch and licence expiry both land here. */
  'SUSPENDED',
  /** A newer version took over. Terminal, and retained so history explains itself. */
  'SUPERSEDED',
  /** Withdrawn permanently. Terminal. */
  'RETIRED',
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const LIFECYCLE_ACTIONS = [
  'SUBMIT',
  'APPROVE',
  'REQUEST_CHANGES',
  'BEGIN_ACTIVATION',
  'COMPLETE_ACTIVATION',
  'ABORT_ACTIVATION',
  'SUSPEND',
  'RESTORE',
  'SUPERSEDE',
  'RETIRE',
] as const;

export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export interface TransitionRule {
  readonly action: LifecycleAction;
  /** States this action may be applied from. */
  readonly from: readonly LifecycleState[];
  readonly to: LifecycleState;
  /** The actor must differ from the proposer (§4.2, T45). */
  readonly requiresFourEyes: boolean;
  /** A free-text reason is mandatory and is recorded in the audit entry (SEC-06). */
  readonly requiresReason: boolean;
  /** A passing SEC-05 rights clearance must be supplied to perform this action. */
  readonly requiresRightsClearance: boolean;
}

const RULES: Readonly<Record<LifecycleAction, TransitionRule>> = {
  SUBMIT: {
    action: 'SUBMIT',
    from: ['PROPOSED'],
    to: 'AWAITING_APPROVAL',
    requiresFourEyes: false,
    requiresReason: false,
    requiresRightsClearance: false,
  },
  APPROVE: {
    action: 'APPROVE',
    from: ['AWAITING_APPROVAL'],
    to: 'APPROVED',
    requiresFourEyes: true,
    requiresReason: true,
    requiresRightsClearance: false,
  },
  REQUEST_CHANGES: {
    action: 'REQUEST_CHANGES',
    from: ['AWAITING_APPROVAL'],
    to: 'PROPOSED',
    requiresFourEyes: true,
    requiresReason: true,
    requiresRightsClearance: false,
  },
  BEGIN_ACTIVATION: {
    action: 'BEGIN_ACTIVATION',
    from: ['APPROVED'],
    to: 'ACTIVATING',
    requiresFourEyes: false,
    requiresReason: false,
    requiresRightsClearance: false,
  },
  COMPLETE_ACTIVATION: {
    action: 'COMPLETE_ACTIVATION',
    from: ['ACTIVATING'],
    to: 'ACTIVE',
    requiresFourEyes: false,
    // The gate. Nothing reaches ACTIVE without a passing rights clearance to point at.
    requiresReason: false,
    requiresRightsClearance: true,
  },
  ABORT_ACTIVATION: {
    action: 'ABORT_ACTIVATION',
    from: ['ACTIVATING'],
    to: 'APPROVED',
    requiresFourEyes: false,
    requiresReason: true,
    requiresRightsClearance: false,
  },
  SUSPEND: {
    // Reachable mid-activation too: a source found to be harmful while activating should not
    // have to finish activating first.
    action: 'SUSPEND',
    from: ['ACTIVE', 'ACTIVATING'],
    to: 'SUSPENDED',
    requiresFourEyes: false,
    requiresReason: true,
    requiresRightsClearance: false,
  },
  RESTORE: {
    action: 'RESTORE',
    from: ['SUSPENDED'],
    to: 'ACTIVE',
    requiresFourEyes: true,
    requiresReason: true,
    // Restoring puts a source back into use, so the rights position is re-evaluated. A licence
    // that expired during the suspension must not be restored past.
    requiresRightsClearance: true,
  },
  SUPERSEDE: {
    action: 'SUPERSEDE',
    from: ['ACTIVE', 'SUSPENDED'],
    to: 'SUPERSEDED',
    requiresFourEyes: false,
    requiresReason: false,
    requiresRightsClearance: false,
  },
  RETIRE: {
    action: 'RETIRE',
    from: ['PROPOSED', 'AWAITING_APPROVAL', 'APPROVED', 'ACTIVATING', 'ACTIVE', 'SUSPENDED'],
    to: 'RETIRED',
    requiresFourEyes: false,
    requiresReason: true,
    requiresRightsClearance: false,
  },
};

export function ruleFor(action: LifecycleAction): TransitionRule {
  return RULES[action];
}

export type LifecycleTransitionDecision =
  | { readonly allowed: true; readonly to: LifecycleState; readonly rule: TransitionRule }
  | { readonly allowed: false; readonly reason: string };

/**
 * May `action` be applied to a version currently in `from`?
 *
 * Content-level and identity-level checks are deliberately **not** here: four-eyes is
 * `canApprove` in `access/permissions.ts`, and the rights gate is `decideRights` in
 * `rights/rights.ts`. This function answers only "is that a legal move", and the rule it
 * returns says which of the other two checks the caller still owes.
 */
export function canTransition(
  from: LifecycleState,
  action: LifecycleAction,
): LifecycleTransitionDecision {
  const rule = RULES[action];
  if (!rule.from.includes(from)) {
    return {
      allowed: false,
      reason:
        `${action} is not permitted from ${from}. ` +
        `It applies to: ${rule.from.join(', ')}. Current state reached ${from}.`,
    };
  }
  return { allowed: true, to: rule.to, rule };
}

/** Terminal states accept no further action. */
export function isTerminal(state: LifecycleState): boolean {
  return state === 'SUPERSEDED' || state === 'RETIRED';
}

/**
 * May the version's content still be edited?
 *
 * Only while `PROPOSED`. An edit after submission means the approver approved content that is
 * no longer what activates.
 */
export function isEditable(state: LifecycleState): boolean {
  return state === 'PROPOSED';
}

/**
 * May this version be used to run anything?
 *
 * `ACTIVE` only. `APPROVED` is permission to activate, not activation, and `ACTIVATING` has
 * not passed the rights gate yet. Anything that reads a version before querying calls this
 * rather than comparing to a string, so there is one definition of "in use" to change.
 */
export function isUsable(state: LifecycleState): boolean {
  return state === 'ACTIVE';
}

/**
 * Every action legally available from a state. For a panel that must not offer a button the
 * server will refuse.
 */
export function availableActions(from: LifecycleState): readonly LifecycleAction[] {
  return LIFECYCLE_ACTIONS.filter((action) => RULES[action].from.includes(from));
}
