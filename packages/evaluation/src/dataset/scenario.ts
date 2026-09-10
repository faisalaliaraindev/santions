/**
 * A runnable scenario attached to a labelled case.
 *
 * G2 requires I1-I10 to execute with no I/O, no database and no network. That means the
 * dataset must carry the *axis inputs* a real pipeline would produce, not only the ground
 * truth. At G7 the same labels are re-applied to axis inputs produced by the real extraction
 * and classification path, and the identical harness runs against them — which is how "I1-I10
 * pass against real pipeline output, not only against the G2 fixtures" is verified.
 */

import type {
  AxisAInput,
  AxisBInput,
  AxisCInput,
  BandingRuleVersion,
  ClusteredSource,
} from '@erly/adverse-domain';

export interface CaseScenario {
  readonly axisA: AxisAInput;
  readonly axisB: AxisBInput;
  readonly axisC: AxisCInput;
  readonly sources: readonly ClusteredSource[];
}

export const SEED_RULES_VERSION: BandingRuleVersion = {
  bandingRulesVersionId: 'banding-v1',
  version: 1,
  activatedAt: '2026-09-10T00:00:00.000Z',
};
