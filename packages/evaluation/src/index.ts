/**
 * `@erly/adverse-evaluation` — labelled dataset, FR-16 metrics and the I1-I10 harness.
 *
 * Like `@erly/adverse-domain`, this package performs no I/O. The invariant harness is a
 * release gate that must run on every pull request without infrastructure.
 */

export * from './dataset/types.js';
export * from './dataset/scenario.js';
export * from './dataset/split.js';
export * from './dataset/seed.js';

export * from './invariants/harness.js';

export * from './metrics/metrics.js';
