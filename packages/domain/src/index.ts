/**
 * `@erly/adverse-domain` — pure domain core.
 *
 * Everything exported here is a pure function or a type. No I/O, no database, no network,
 * no clock reads. That is a hard constraint, not a preference: `pnpm test:invariants` runs
 * the I1-I10 release gate against this package with no infrastructure at all (section 11).
 */

export * from './taxonomy/categories.js';
export * from './taxonomy/types.js';
export * from './taxonomy/lexicon-audit.js';
export * from './taxonomy/activation.js';
export * from './taxonomy/seed-lexicon.js';

export * from './stages/ladder.js';
export * from './stages/transitions.js';

export * from './roles/party-roles.js';

export * from './tenure/tenure.js';

export * from './identity/name-forms.js';
export * from './identity/axis-a.js';

export * from './attribution/axis-b.js';

export * from './events/axis-c.js';

export * from './authority/axis-d.js';

export * from './banding/bands.js';
export * from './banding/finding-attributes.js';

export * from './clustering/rules.js';

export * from './planning/query-families.js';
export * from './planning/build-plan.js';

export * from './coverage/result-state.js';
export * from './identity/transliteration.js';
export * from './access/permissions.js';
export * from './lifecycle/versioned-lifecycle.js';
export * from './rights/rights.js';
export * from './capability/capability.js';

export * from './reliability/failure-classification.js';
export * from './reliability/source-health.js';

export * from './fetch/url-policy.js';
export * from './fetch/robots.js';

export * from './identity/name-frequency-distribution.js';

export * from './association/officer-resolution.js';
export * from './association/scope.js';
export * from './association/bounds.js';
export * from './association/association-coverage.js';
