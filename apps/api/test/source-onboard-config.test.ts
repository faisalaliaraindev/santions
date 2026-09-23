/**
 * First-contact approvals — the guard against a publisher borrowing somebody else's signature.
 *
 * `accessPolicy.firstContactApproval` is a named person accepting that this service will start
 * making requests to a publisher who did not ask to hear from us (D-042). `source-onboard.mjs`
 * writes it onto every proposal it sends, and it also writes the decision id into the reason on
 * the submit and approve audit entries.
 *
 * The quiet failure that matters: a publisher gets added to the onboarding script, nobody notices
 * it has no decision of its own, and it is proposed carrying **D19** — a decision that names ten
 * indexed publishers, none of them the new one, dated before it existed. Nothing throws, nothing
 * warns, and the registry ends up asserting something untrue about a real person. That is worse
 * than a missing approval, because it is specific and checkable and wrong.
 *
 * So `scripts/lib/first-contact-approvals.mjs` has no fallback, and these tests hold that:
 * membership of D19 is enumerated, later publishers carry their own decision, and anything
 * covered by neither throws rather than defaulting.
 *
 * The module is plain `.mjs` — a script's library, not application code — so it is imported here
 * by URL rather than through the package graph.
 */

import { describe, expect, it } from 'vitest';

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { WIKINEWS_EN_CONTENT, WIKINEWS_EN_SOURCE_ID } from '../src/sources/registry/wikinews-en.js';

const approvals = (await import(
  pathToFileURL(
    join(process.cwd(), 'scripts/lib/first-contact-approvals.mjs'),
  ).href
)) as {
  D19: { decision: string; approvedBy: string; approvedOn: string };
  D19_SOURCES: Set<string>;
  BY_SOURCE: Record<string, { decision: string; approvedBy: string; approvedOn: string }>;
  firstContactApprovalFor: (sourceId: string) => { decision: string };
  firstContactBannerFor: (ids: readonly string[], isInternal: (id: string) => boolean) => string;
};

describe('every onboarded publisher is covered by a decision that names it', () => {
  it('resolves the ten indexed publishers to D19 and nothing else to D19', () => {
    expect(approvals.D19_SOURCES.size).toBe(10);
    for (const sourceId of approvals.D19_SOURCES) {
      expect(approvals.firstContactApprovalFor(sourceId).decision).toBe('D19');
    }
  });

  it('throws for a publisher no decision names, rather than defaulting to D19', () => {
    // THIS is the property. A future publisher added to the script without a decision must stop
    // the run, not inherit a signature.
    expect(() => approvals.firstContactApprovalFor('some-new-publisher')).toThrowError(
      /No first-contact approval covers some-new-publisher/u,
    );
  });

  it('covers wikinews-en by its own decision, D22, and not by D19', () => {
    const approval = approvals.firstContactApprovalFor(WIKINEWS_EN_SOURCE_ID);
    expect(approval.decision).toBe('D22');
    expect(approvals.D19_SOURCES.has(WIKINEWS_EN_SOURCE_ID)).toBe(false);
  });

  it('keeps the registry template free of the approval the script supplies', () => {
    // The template ships unapprovable on purpose, and the governance values are set by the run a
    // named person authorised. If this ever passes because somebody "tidied up" the template,
    // the lifecycle has been bypassed rather than followed.
    expect(WIKINEWS_EN_CONTENT.accessPolicy.firstContactApproval).toBeNull();
    expect(WIKINEWS_EN_CONTENT.robotsPosition).toBe('NOT_ESTABLISHED');
  });

  it('names the decisions actually covering a run in the banner', () => {
    const internal = (id: string) => id === 'searxng-adverse-media';

    // A run of one publisher announces that publisher's decision, never a fixed string.
    expect(approvals.firstContactBannerFor(['wikinews-en'], internal)).toContain('D22');
    expect(approvals.firstContactBannerFor(['wikinews-en'], internal)).not.toContain('D19');

    // An internal service has no publisher to contact, so it contributes no decision rather than
    // inventing one.
    expect(approvals.firstContactBannerFor(['searxng-adverse-media'], internal)).toContain(
      'no publisher to contact',
    );
  });
});

describe('the approval scope stays narrow', () => {
  it('approves one domain, not a wildcard and not the discovery layer', () => {
    // The whole architectural point of D-042 as strengthened on 2026-09-22: approving the
    // SearXNG layer approves querying our own instance, never fetching from whatever it names.
    // An approval here that covered wikinews.org, or *.wikimedia.org, would be the blanket
    // approval that rule exists to refuse.
    expect(WIKINEWS_EN_CONTENT.canonicalDomains).toEqual(['en.wikinews.org']);
    for (const domain of WIKINEWS_EN_CONTENT.canonicalDomains) {
      expect(domain.startsWith('*')).toBe(false);
    }
  });

  it('records no endpoint, because this publisher is never polled', () => {
    // D-043. A recorded endpoint would be a second way to reach the publisher that the discovery
    // path does not go through.
    expect(WIKINEWS_EN_CONTENT.accessPolicy.endpointUrl).toBeNull();
    expect(WIKINEWS_EN_CONTENT.connectorType).toBe('EVIDENCE_FETCH_HTTP');
  });
});
