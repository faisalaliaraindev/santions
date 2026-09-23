/**
 * First-contact approvals, by source — who accepted that this service would start calling whom.
 *
 * # Why this is a module and not two constants inside `source-onboard.mjs`
 *
 * `accessPolicy.firstContactApproval` is a named person's signature on a record saying they
 * accepted that this service would begin making requests to a publisher who did not ask to hear
 * from us (D-042). It is the single field on an approved source version that a complaint would be
 * checked against. It is worth more than a fallback in a helper function.
 *
 * The failure this module is shaped to prevent is specific and quiet: a publisher is added to the
 * onboarding script later, nobody notices it has no decision of its own, the `?? D19` fallback
 * fires, and the new record is proposed carrying a signature from a decision that names ten
 * different publishers and was dated before this one existed. Nothing fails, nothing warns, and
 * the registry now asserts something untrue about a real person.
 *
 * So there is **no fallback**. Every source either appears in `D19_SOURCES` or has its own entry
 * in `BY_SOURCE`, and `firstContactApprovalFor` throws for anything else. Adding a publisher
 * therefore cannot be done without deciding, under whose authority, it may be contacted — which
 * is the property the whole lifecycle is for, expressed as a line of code rather than as a note
 * somebody is trusted to read.
 *
 * Internal services take neither: there is no third party on the hop to consent to being
 * contacted, so a signature there would be one nobody gave. `source-onboard.mjs` routes those
 * through `INTERNAL_SERVICE_SOURCES` and never calls this.
 */

/**
 * D19 — first contact with the ten indexed publishers, 2026-09-21.
 *
 * It is not a general permission to contact publishers. It names ten, and this is the list.
 */
export const D19 = {
  approvedBy: 'Faisal Ali',
  role: 'Source admin',
  approvedOn: '2026-09-21',
  decision: 'D19',
};

/** The ten sources D19 actually names. Enumerated, so membership is a fact rather than a default. */
export const D19_SOURCES = new Set([
  'ofac-sdn',
  'ofac-consolidated-non-sdn',
  'uk-sanctions-list',
  'unsc-consolidated',
  'eu-consolidated-financial-sanctions',
  'doj-fraud-enforcement',
  'cftc-enforcement-press-releases',
  'ftc-consumer-protection-press-releases',
  'fca-warnings',
  'world-bank-debarred',
]);

/**
 * Publishers approved under their own decision, after D19.
 *
 * **D22 — `en.wikinews.org`, 2026-09-22.** The first publisher approved for rung-5 evidence
 * fetching. Deliberately one domain: approving the SearXNG discovery layer approves querying our
 * own instance, and never fetching from whatever that instance happens to name. A blanket
 * approval for arbitrary discovered publishers is the thing this record is shaped to refuse.
 */
export const BY_SOURCE = {
  'wikinews-en': {
    approvedBy: 'Faisal Ali',
    role: 'Source admin',
    approvedOn: '2026-09-22',
    decision: 'D22',
  },
};

/**
 * The approval covering this source, or a thrown error.
 *
 * Throws rather than returning null, because every caller's only sensible response to "no
 * approval" is to stop, and a null that reached the proposal body would be indistinguishable from
 * the registry template's deliberate `firstContactApproval: null`.
 */
export function firstContactApprovalFor(sourceId) {
  const own = BY_SOURCE[sourceId];
  if (own !== undefined) {
    return own;
  }
  if (D19_SOURCES.has(sourceId)) {
    return D19;
  }
  throw new Error(
    `No first-contact approval covers ${sourceId}. D19 names ten indexed publishers and this is ` +
      `not one of them, and no later decision names it either. Onboarding it would propose a ` +
      `record whose firstContactApproval is a signature nobody gave. Take the decision, record ` +
      `it in scripts/lib/first-contact-approvals.mjs, then re-run.`,
  );
}

/** Every decision covering this run, deduplicated, for the operator-facing banner. */
export function firstContactBannerFor(sourceIds, isInternalService) {
  const decisions = new Set();
  for (const sourceId of sourceIds) {
    if (isInternalService(sourceId)) {
      continue;
    }
    const approval = firstContactApprovalFor(sourceId);
    decisions.add(`${approval.decision}, ${approval.approvedBy}, ${approval.approvedOn}`);
  }
  return decisions.size === 0
    ? '(none — internal service, no publisher to contact)'
    : [...decisions].join('  |  ');
}
