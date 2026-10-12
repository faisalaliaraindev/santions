/**
 * The discovery-rung templates — FR-05 rungs 2, 3 and 4.
 *
 * These are **templates, not proposals**: nobody has verified their endpoints and this project
 * has made no request to any of them. What these tests protect is that they stay inert — a
 * template that could be activated into a working source would be an unverified address the
 * service actually calls.
 */

import { describe, expect, it } from 'vitest';

import { sourceContentSchema } from '@adverse-search/contracts';

import {
  BING_NEWS_RSS_TEMPLATE,
  DISCOVERY_RUNG_TEMPLATES,
  GDELT_TEMPLATE,
  GOOGLE_NEWS_RSS_TEMPLATE,
  discoveryRungTemplate,
} from '../src/sources/registry/discovery-rungs.js';

describe('every template is submittable', () => {
  it('satisfies the FR-05 schema an approver would submit it against', () => {
    for (const id of Object.keys(
      DISCOVERY_RUNG_TEMPLATES,
    ) as (keyof typeof DISCOVERY_RUNG_TEMPLATES)[]) {
      expect(() => discoveryRungTemplate(id), id).not.toThrow();
    }
  });

  it('covers rungs 2, 3 and 4', () => {
    const rungs = Object.values(DISCOVERY_RUNG_TEMPLATES)
      .map((t) => t.cascadeRung)
      .sort();
    expect(rungs).toEqual([2, 3, 4]);
  });
});

describe('every template is inert, in two independent ways', () => {
  it('names no first-contact approval, so the gate refuses it', () => {
    // D-042. Without this a template could be activated and immediately called at an address
    // nobody has checked.
    for (const [id, template] of Object.entries(DISCOVERY_RUNG_TEMPLATES)) {
      expect(template.accessPolicy.firstContactApproval, id).toBeNull();
    }
  });

  it('establishes no robots position, so the gate refuses it again', () => {
    // Belt and braces, and deliberately so: these are the two independent refusals, and either
    // one alone would be enough. A template should not become live because one was edited.
    for (const [id, template] of Object.entries(DISCOVERY_RUNG_TEMPLATES)) {
      expect(template.robotsPosition, id).toBe('NOT_ESTABLISHED');
    }
  });

  it('says in the record itself that the endpoint is unverified', () => {
    // In the record, not only in the file header — a record is read by whoever approves it, and
    // the file is not.
    for (const [id, template] of Object.entries(DISCOVERY_RUNG_TEMPLATES)) {
      expect(template.accessPolicy.policySummary, id).toContain('ENDPOINT NOT VERIFIED');
    }
  });

  it('records no rate ceiling rather than inventing one', () => {
    // None of these publishers states a numeric limit. A guessed ceiling in the registry is a
    // number somebody would later treat as the publisher's own.
    for (const [id, template] of Object.entries(DISCOVERY_RUNG_TEMPLATES)) {
      expect(template.accessPolicy.requestCeilingPerSecond, id).toBeNull();
    }
  });
});

describe('what each rung costs in code', () => {
  it('serves rung 4 with the same connector as rung 2 — no new code', () => {
    // The point of D-043. Bing News RSS is the RSS connector at a different approved address.
    expect(BING_NEWS_RSS_TEMPLATE.connectorType).toBe('NEWS_DISCOVERY_RSS');
    expect(GOOGLE_NEWS_RSS_TEMPLATE.connectorType).toBe('NEWS_DISCOVERY_RSS');
  });

  it('gives rung 3 its own connector type, because JSON is a different response format', () => {
    // A new connector type means a new format, not a new source. GDELT is the only one here
    // that earns one.
    expect(GDELT_TEMPLATE.connectorType).toBe('NEWS_DISCOVERY_GDELT');
    expect(GDELT_TEMPLATE.contentFormat).toBe('JSON');
  });

  it('marks every search feed as a QUERY_FEED, which is the expensive kind', () => {
    // One request per planned query rather than one per poll. Recorded rather than inferred,
    // because it is the difference between four requests an hour and four hundred.
    for (const [id, template] of Object.entries(DISCOVERY_RUNG_TEMPLATES)) {
      expect(template.accessPolicy.endpointKind, id).toBe('QUERY_FEED');
      expect(template.accessPolicy.queryParam, id).not.toBeNull();
    }
  });
});

describe('what the templates claim about authority', () => {
  it('puts every aggregator at the lowest tier', () => {
    // I6: ten copies of one wire story are one independent report. Tier 5 is what stops axis D
    // treating an aggregator as corroboration rather than as provenance.
    for (const [id, template] of Object.entries(DISCOVERY_RUNG_TEMPLATES)) {
      expect(template.authorityTier, id).toBe(5);
    }
  });

  it('declares real countries, never a regional pseudo-code', () => {
    // FR-05: "EU", "LATAM" and "GLOBAL" are not source permissions. GDELT is global by
    // construction and still has to name what this deployment searches with it.
    for (const [id, template] of Object.entries(DISCOVERY_RUNG_TEMPLATES)) {
      const parsed = sourceContentSchema.parse(template);
      const countries = parsed.countries;
      expect(countries.length, id).toBeGreaterThan(0);
      for (const country of countries) {
        expect(['EU', 'LATAM', 'GLOBAL', 'APAC', 'MENA'], id).not.toContain(country);
      }
    }
  });

  it('declares every feed volatile, because nobody promised us its shape', () => {
    for (const [id, template] of Object.entries(DISCOVERY_RUNG_TEMPLATES)) {
      expect(template.stabilityClass, id).toBe('UNDOCUMENTED_VOLATILE');
    }
  });
});

describe('D20 — Google News RSS is refused, not merely unverified', () => {
  // These are not style checks. `google-news-rss-en-us` is the one template in this file whose
  // evidence has been gathered and whose answer was no, and the registry record is where an
  // administrator reads that before approving anything. If the refusal can be dropped from the
  // record without a test failing, the next person to tidy this file removes it and the source
  // becomes activatable on a reading of "UNVERIFIED — go and verify it".

  it('records the refusal on the version content itself, not only in a comment', () => {
    const summary = GOOGLE_NEWS_RSS_TEMPLATE.accessPolicy.policySummary;
    expect(summary).toContain('DO NOT ACTIVATE');
    expect(summary).toContain('D20');
    // The two independent grounds. Either alone is sufficient, so both must survive.
    expect(summary).toContain('non-commercial use');
    expect(summary).toContain('robot, spider');
  });

  it('still carries no first-contact approval and no established robots position', () => {
    // The fetch gate (D-042) refuses on either of these, so they are the mechanical backstop
    // behind the documentary refusal above. A future edit that "completes" the record by filling
    // them in would make the source callable.
    expect(GOOGLE_NEWS_RSS_TEMPLATE.accessPolicy.firstContactApproval).toBeNull();
    expect(GOOGLE_NEWS_RSS_TEMPLATE.robotsPosition).toBe('NOT_ESTABLISHED');
  });

  it('names no licence terms, because there are none this service may rely on', () => {
    // `UNVERIFIED` here means "no usable licence position exists", which is stronger than the
    // same string on the Bing template, where it means "nobody has looked yet".
    expect(GOOGLE_NEWS_RSS_TEMPLATE.licenceTermsVersion).toBe('UNVERIFIED');
  });
});
