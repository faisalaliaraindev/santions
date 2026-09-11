import { describe, expect, it } from 'vitest';

import {
  availableActions,
  canTransition,
  isEditable,
  isTerminal,
  isUsable,
  LIFECYCLE_ACTIONS,
  LIFECYCLE_STATES,
  ruleFor,
  type LifecycleState,
} from '../../src/lifecycle/versioned-lifecycle.js';

describe('the versioned approval lifecycle', () => {
  it('walks the whole path from proposal to active', () => {
    let state: LifecycleState = 'PROPOSED';
    for (const action of [
      'SUBMIT',
      'APPROVE',
      'BEGIN_ACTIVATION',
      'COMPLETE_ACTIVATION',
    ] as const) {
      const decision = canTransition(state, action);
      expect(decision.allowed, `${action} from ${state}`).toBe(true);
      if (decision.allowed) {
        state = decision.to;
      }
    }
    expect(state).toBe('ACTIVE');
  });

  it('refuses to skip approval and activate a proposal directly', () => {
    const decision = canTransition('PROPOSED', 'COMPLETE_ACTIVATION');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('ACTIVATING');
    }
  });

  it('refuses to approve something that was never submitted', () => {
    expect(canTransition('PROPOSED', 'APPROVE').allowed).toBe(false);
  });

  describe('the asymmetry between stopping and starting', () => {
    it('suspends without a second person', () => {
      const decision = canTransition('ACTIVE', 'SUSPEND');
      expect(decision.allowed).toBe(true);
      expect(ruleFor('SUSPEND').requiresFourEyes).toBe(false);
      expect(ruleFor('SUSPEND').requiresReason).toBe(true);
    });

    it('restores only with a second person and a fresh rights clearance', () => {
      expect(canTransition('SUSPENDED', 'RESTORE').allowed).toBe(true);
      expect(ruleFor('RESTORE').requiresFourEyes).toBe(true);
      expect(ruleFor('RESTORE').requiresRightsClearance).toBe(true);
    });

    it('can suspend a version that is still activating', () => {
      expect(canTransition('ACTIVATING', 'SUSPEND').allowed).toBe(true);
    });
  });

  describe('the rights gate', () => {
    it('is required to reach ACTIVE and nowhere else on the happy path', () => {
      expect(ruleFor('COMPLETE_ACTIVATION').requiresRightsClearance).toBe(true);
      expect(ruleFor('SUBMIT').requiresRightsClearance).toBe(false);
      expect(ruleFor('APPROVE').requiresRightsClearance).toBe(false);
      expect(ruleFor('BEGIN_ACTIVATION').requiresRightsClearance).toBe(false);
    });

    it('lets a failed activation fall back to APPROVED with a reason', () => {
      const decision = canTransition('ACTIVATING', 'ABORT_ACTIVATION');
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.to).toBe('APPROVED');
      }
      expect(ruleFor('ABORT_ACTIVATION').requiresReason).toBe(true);
    });
  });

  describe('editability and usability', () => {
    it('allows editing only while proposed', () => {
      for (const state of LIFECYCLE_STATES) {
        expect(isEditable(state), state).toBe(state === 'PROPOSED');
      }
    });

    it('treats only ACTIVE as usable — APPROVED is permission, not activation', () => {
      for (const state of LIFECYCLE_STATES) {
        expect(isUsable(state), state).toBe(state === 'ACTIVE');
      }
      expect(isUsable('APPROVED')).toBe(false);
    });
  });

  describe('terminal states', () => {
    it('names exactly SUPERSEDED and RETIRED', () => {
      const terminal = LIFECYCLE_STATES.filter(isTerminal);
      expect([...terminal].sort()).toEqual(['RETIRED', 'SUPERSEDED']);
    });

    it('accepts no action at all from a terminal state', () => {
      for (const state of LIFECYCLE_STATES.filter(isTerminal)) {
        expect(availableActions(state), state).toEqual([]);
        for (const action of LIFECYCLE_ACTIONS) {
          expect(canTransition(state, action).allowed, `${action} from ${state}`).toBe(false);
        }
      }
    });

    it('retires from every non-terminal state, so nothing can get stuck', () => {
      for (const state of LIFECYCLE_STATES.filter((s) => !isTerminal(s))) {
        expect(canTransition(state, 'RETIRE').allowed, state).toBe(true);
      }
    });
  });

  it('offers a panel only the actions the server would accept', () => {
    expect([...availableActions('AWAITING_APPROVAL')].sort()).toEqual([
      'APPROVE',
      'REQUEST_CHANGES',
      'RETIRE',
    ]);
  });
});
