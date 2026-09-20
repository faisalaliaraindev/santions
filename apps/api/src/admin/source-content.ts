/**
 * FR-05 conformance for source version content — the half of D1 that D2 owns.
 *
 * D1 built the lifecycle and left version content as an opaque object: the schema existed in
 * `packages/contracts`, and nothing checked anything against it. That was the right place to
 * stop, because until the adapters existed nobody could say which fields were load-bearing and
 * a schema enforced on guesswork is a schema that gets loosened the first time it is
 * inconvenient. The adapters exist now, so this is the check.
 *
 * **Where it runs, and why not at propose.** A draft is allowed to be incomplete — that is
 * what a draft is, and refusing to save a half-filled form is how people end up keeping source
 * configuration in a text file until it is finished. Conformance is enforced at **submit**,
 * the moment the version is put in front of an approver, and again at **activation** as the
 * backstop. An approver must never be asked to approve a record that cannot be interpreted:
 * approving is the act that carries responsibility, and "I approved it, I assumed the fields
 * were right" is not a position anyone should be put in.
 *
 * **Sources only.** Taxonomy and policy content have no field-level schema yet; taxonomy's
 * lands in D6 with the lexicon audit on the activation path, and policy's with the retention
 * decision (D-012). Enforcing an invented schema on them now would be enforcing a guess.
 */

import { sourceContentSchema } from '@erly/adverse-contracts';

import { ApiException } from '../common/api-exception.js';

import type { AdminRecordKind } from './versioned-record.service.js';

/**
 * The fields the adapters actually read, named here because the list is the answer to "which
 * of these twenty fields is load-bearing?" and that answer belongs somewhere a person can find
 * it. Everything in this list has a consumer in `apps/api/src/sources`:
 *
 * - `connectorType` → which port the source is served through
 * - `canonicalDomains` → the fetch gate, and the rung-6 site-search refusal
 * - `countries` / `languages` → `assertJurisdictionCovered`, and the FR-03 language rule
 * - `parserVersion` / `stabilityClass` → the provenance stamp, the contract probe, D5's breaker
 * - `robotsPosition` → the fetch authorisation, which refuses `NOT_ESTABLISHED`
 * - `authorityTier` → carried onto every `PrimaryRecord`, read by the FR-11 authority axis
 * - `cascadeRung` → which rung of the FR-05 ladder this source answers at
 * - `contentFormat` → whether extraction gets HTML or a PDF
 * - `freeTier*Budget` → what the planner spends against (FR-06)
 * - `credentialsRef` → a reference, never a credential (SEC-04)
 * - `licenceTermsVersion` → the unexpired-terms half of the fetch gate
 */
export const LOAD_BEARING_SOURCE_FIELDS: readonly string[] = [
  'connectorType',
  'canonicalDomains',
  'jurisdictionScope',
  'countries',
  'languages',
  'parserVersion',
  'stabilityClass',
  'robotsPosition',
  'authorityTier',
  'cascadeRung',
  'contentFormat',
  'licenceTermsVersion',
  'refreshPolicy',
];

/**
 * Check a source version's content against FR-05.
 *
 * Throws `ApiException('INVALID_REQUEST')` listing every problem, not the first. A caller
 * fixing a twenty-field record one round trip per mistake will stop using the API and start
 * writing to the collection directly, which is how the approval trail gets bypassed.
 */
export function assertSourceContentConforms(content: Record<string, unknown>): void {
  // `mode` is the envelope's, stamped from process configuration. A version that carries it in
  // its content is claiming to decide whether it is a fixture, which is the T55 hazard exactly.
  if ('mode' in content) {
    throw new ApiException(
      'VALIDATION_FAILED',
      'Source content must not declare `mode`. The operating mode is stamped on the version ' +
        'from the running configuration, so that fixture data cannot declare itself live (T55).',
      { details: [{ path: 'mode', message: 'Stamped by the service; not caller-supplied.' }] },
    );
  }

  const parsed = sourceContentSchema.safeParse(content);
  if (parsed.success) {
    return;
  }

  const details = parsed.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));

  throw new ApiException(
    'VALIDATION_FAILED',
    `Source content does not satisfy the FR-05 registry field list (${String(details.length)} ` +
      `problem(s)). Every field it names is read by an adapter or a gate; see ` +
      `apps/api/src/admin/source-content.ts.`,
    { details },
  );
}

/**
 * The kind-aware entry point, called by the lifecycle service.
 *
 * A `switch` over the kind rather than a nullable schema on the kind definition, so that
 * adding a fourth record kind is a compile error here — the place where somebody has to decide
 * what conformance means for it — rather than a silent pass.
 */
export function assertContentConforms(
  kind: AdminRecordKind,
  content: Record<string, unknown>,
): void {
  switch (kind) {
    case 'SOURCE':
      assertSourceContentConforms(content);
      return;
    case 'TAXONOMY':
    case 'POLICY':
      // No field-level schema yet. See the file header: D6 and D-012 respectively.
      return;
  }
}
