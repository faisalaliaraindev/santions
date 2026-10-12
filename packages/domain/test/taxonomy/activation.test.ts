/**
 * Phase D step D6 — what activation refuses, and what a search's effective scope resolves to.
 *
 * The three refusals are each a way for a screening product to state something untrue:
 *
 *  - a protected-characteristic term leaves the service as an outbound query (SEC-05, T79);
 *  - a language flipped to "enabled" without measurement erases the distinction the whole
 *    coverage statement rests on (FR-03, D-010);
 *  - a category enabled where no source exists reports a clean result for a category nothing
 *    ever looked for.
 *
 * And the scope resolution exists so that **"a disabled category is never queried" is provable
 * here**, rather than being an assertion about Phase E code.
 */

import { describe, expect, it } from 'vitest';

import {
  auditTaxonomyForActivation,
  resolveEffectiveScope,
  summariseTaxonomyRefusals,
  warnOnTaxonomyDraft,
} from '../../src/taxonomy/activation.js';
import { auditLexicon } from '../../src/taxonomy/lexicon-audit.js';
import {
  SEED_LEXICON,
  SEED_LEXICON_LANGUAGES,
  unreviewedLexiconNote,
} from '../../src/taxonomy/seed-lexicon.js';
import { ADVERSE_CATEGORIES } from '../../src/taxonomy/categories.js';
import type { LexiconTerm, TaxonomyVersion } from '../../src/taxonomy/types.js';

function taxonomy(overrides: Partial<TaxonomyVersion> = {}): TaxonomyVersion {
  return {
    taxonomyVersionId: 'tenant-alpha:v2',
    version: 2,
    tenantId: 'tenant-alpha',
    categories: [
      { category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 4, enabledCountries: ['CR'] },
      { category: 'BRIBERY_CORRUPTION', severityWeight: 5, enabledCountries: ['CR'] },
      { category: 'CYBERCRIME', severityWeight: 3, enabledCountries: [] },
    ],
    lexicon: [],
    languages: [
      { language: 'es', measuredRecall: null, measuredByEvaluationRunId: null },
      { language: 'en', measuredRecall: null, measuredByEvaluationRunId: null },
    ],
    status: 'APPROVED',
    proposedBy: 'admin-a',
    approvedBy: 'admin-b',
    activatedAt: null,
    ...overrides,
  };
}

const COVERED = { countriesWithApprovedSource: ['CR'] as const };

describe('the seed lexicon is clean, and says what it is', () => {
  it('contains no protected-characteristic term (T79)', () => {
    const result = auditLexicon(SEED_LEXICON);
    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.termsChecked).toBeGreaterThan(100);
  });

  it('carries conduct terms for every one of the seventeen categories, in both languages', () => {
    for (const category of ADVERSE_CATEGORIES) {
      for (const language of SEED_LEXICON_LANGUAGES) {
        const terms = SEED_LEXICON.filter(
          (t) => t.category === category && t.language === language && t.kind === 'CONDUCT',
        );
        expect(terms.length, `${category}/${language}`).toBeGreaterThan(0);
      }
    }
  });

  it('marks every term unreviewed, English included, and machine-translates nothing', () => {
    // Marking the English list reviewed because its author reads English would be exactly the
    // self-certification the field exists to prevent.
    for (const t of SEED_LEXICON) {
      expect(t.reviewState).toBe('UNREVIEWED_AUTHORED');
    }
  });

  it('produces the coverage note a run must carry while Spanish is unreviewed', () => {
    const note = unreviewedLexiconNote(SEED_LEXICON, 'es');
    expect(note).toContain('has not been reviewed by a reader of that language');
    expect(note).toContain('not machine-translated');
  });

  it('drops the note by itself once a language is reviewed', () => {
    const reviewed: LexiconTerm[] = SEED_LEXICON.filter((t) => t.language === 'es').map((t) => ({
      ...t,
      reviewState: 'REVIEWED_BY_SPEAKER',
    }));
    expect(unreviewedLexiconNote(reviewed, 'es')).toBeNull();
  });

  it('says nothing about a language it has no terms in', () => {
    expect(unreviewedLexiconNote(SEED_LEXICON, 'ar')).toBeNull();
  });
});

describe('activation refuses a protected-characteristic term (T79)', () => {
  it('refuses, naming the term and the stem it matched', () => {
    const refusals = auditTaxonomyForActivation({
      candidate: taxonomy({
        lexicon: [
          {
            term: 'muslim businessman fraud',
            language: 'en',
            kind: 'CONDUCT',
            category: 'FRAUD_FINANCIAL_CRIME',
            rank: 1,
            reviewState: 'UNREVIEWED_AUTHORED',
          },
        ],
      }),
      active: null,
      ...COVERED,
    });
    expect(refusals.map((r) => r.code)).toContain('PROTECTED_CHARACTERISTIC_TERM');
    expect(summariseTaxonomyRefusals(refusals)).toContain('muslim');
  });

  it('refuses a machine-translated term outright (D-010)', () => {
    const refusals = auditTaxonomyForActivation({
      candidate: taxonomy({
        lexicon: [
          {
            term: 'acusado de fraude',
            language: 'es',
            kind: 'CONDUCT',
            category: 'FRAUD_FINANCIAL_CRIME',
            rank: 1,
            reviewState: 'MACHINE_TRANSLATED',
          },
        ],
      }),
      active: null,
      ...COVERED,
    });
    expect(refusals.map((r) => r.code)).toContain('MACHINE_TRANSLATED_TERM');
  });

  it('permits an unreviewed hand-authored term, which is the state we are actually in', () => {
    const refusals = auditTaxonomyForActivation({
      candidate: taxonomy({ lexicon: [...SEED_LEXICON] }),
      active: null,
      ...COVERED,
    });
    expect(refusals).toEqual([]);
  });

  it('warns on a draft with the same findings, without refusing the save', () => {
    const candidate = taxonomy({
      lexicon: [
        {
          term: 'refugee status fraud',
          language: 'en',
          kind: 'CONDUCT',
          category: 'FRAUD_FINANCIAL_CRIME',
          rank: 1,
        },
      ],
    });
    const warnings = warnOnTaxonomyDraft({ candidate, active: null, ...COVERED });
    expect(warnings.map((w) => w.code)).toContain('PROTECTED_CHARACTERISTIC_TERM');
  });
});

describe('activation refuses a language enabled without measurement (FR-03, FR-16)', () => {
  it('refuses a recall figure with no evaluation run behind it', () => {
    const refusals = auditTaxonomyForActivation({
      candidate: taxonomy({
        languages: [
          { language: 'es', measuredRecall: 0.82, measuredByEvaluationRunId: null },
          { language: 'en', measuredRecall: null, measuredByEvaluationRunId: null },
        ],
      }),
      active: taxonomy(),
      ...COVERED,
    });
    expect(refusals.map((r) => r.code)).toContain('LANGUAGE_ENABLED_WITHOUT_MEASUREMENT');
  });

  it('refuses an admin edit that attaches a run id by hand', () => {
    const refusals = auditTaxonomyForActivation({
      candidate: taxonomy({
        languages: [
          { language: 'es', measuredRecall: 0.82, measuredByEvaluationRunId: 'eval-made-up' },
          { language: 'en', measuredRecall: null, measuredByEvaluationRunId: null },
        ],
      }),
      active: taxonomy(),
      ...COVERED,
    });
    expect(refusals.map((r) => r.code)).toContain('RECALL_NOT_SET_BY_EVALUATION');
  });

  it('refuses a first version that declares a measurement out of nowhere', () => {
    const refusals = auditTaxonomyForActivation({
      candidate: taxonomy({
        languages: [{ language: 'es', measuredRecall: 0.9, measuredByEvaluationRunId: 'eval-1' }],
      }),
      active: null,
      ...COVERED,
    });
    expect(refusals.map((r) => r.code)).toContain('RECALL_NOT_SET_BY_EVALUATION');
  });

  it('permits a measurement that an evaluation run already wrote and this version inherits', () => {
    const measured = taxonomy({
      languages: [
        { language: 'es', measuredRecall: 0.71, measuredByEvaluationRunId: 'eval-2026-09' },
        { language: 'en', measuredRecall: null, measuredByEvaluationRunId: null },
      ],
    });
    const refusals = auditTaxonomyForActivation({
      candidate: measured,
      active: measured,
      ...COVERED,
    });
    expect(refusals).toEqual([]);
  });

  it('permits declaring a new language, as long as it is declared unmeasured', () => {
    const refusals = auditTaxonomyForActivation({
      candidate: taxonomy({
        languages: [
          { language: 'es', measuredRecall: null, measuredByEvaluationRunId: null },
          { language: 'en', measuredRecall: null, measuredByEvaluationRunId: null },
          { language: 'pt', measuredRecall: null, measuredByEvaluationRunId: null },
        ],
      }),
      active: taxonomy(),
      ...COVERED,
    });
    expect(refusals).toEqual([]);
  });
});

describe('activation refuses a category enabled where nothing can look for it', () => {
  it('refuses, naming the category and the country', () => {
    const refusals = auditTaxonomyForActivation({
      candidate: taxonomy({
        categories: [
          { category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 4, enabledCountries: ['CR', 'NI'] },
        ],
      }),
      active: null,
      ...COVERED,
    });
    const refusal = refusals.find((r) => r.code === 'CATEGORY_WITHOUT_SOURCE_COVERAGE');
    expect(refusal?.detail).toContain('FRAUD_FINANCIAL_CRIME');
    expect(refusal?.detail).toContain('NI');
  });

  it('refuses everything when no source is approved anywhere', () => {
    const refusals = auditTaxonomyForActivation({
      candidate: taxonomy(),
      active: null,
      countriesWithApprovedSource: [],
    });
    expect(refusals).toHaveLength(2);
    expect(refusals.every((r) => r.code === 'CATEGORY_WITHOUT_SOURCE_COVERAGE')).toBe(true);
  });

  it('says nothing about a category enabled nowhere', () => {
    // CYBERCRIME has an empty `enabledCountries` in the fixture. Disabled is not a problem.
    const refusals = auditTaxonomyForActivation({
      candidate: taxonomy(),
      active: null,
      ...COVERED,
    });
    expect(refusals).toEqual([]);
  });

  it('reports every refusal, not the first', () => {
    const refusals = auditTaxonomyForActivation({
      candidate: taxonomy({
        categories: [
          { category: 'FRAUD_FINANCIAL_CRIME', severityWeight: 4, enabledCountries: ['NI'] },
          { category: 'BRIBERY_CORRUPTION', severityWeight: 5, enabledCountries: ['PA'] },
        ],
        languages: [{ language: 'es', measuredRecall: 0.5, measuredByEvaluationRunId: null }],
      }),
      active: null,
      ...COVERED,
    });
    expect(refusals.length).toBe(3);
  });
});

describe('effective scope — a disabled category is never queried', () => {
  const withTerms = taxonomy({ lexicon: [...SEED_LEXICON] });

  it('returns only the categories enabled for the country', () => {
    const scope = resolveEffectiveScope({
      taxonomy: withTerms,
      country: 'CR',
      requestedLanguages: ['es', 'en'],
    });
    expect(scope.categories).toEqual(['FRAUD_FINANCIAL_CRIME', 'BRIBERY_CORRUPTION']);
    expect(scope.excludedCategories).toEqual(['CYBERCRIME']);
  });

  it('returns no term for a disabled category, whatever the lexicon holds', () => {
    const scope = resolveEffectiveScope({
      taxonomy: withTerms,
      country: 'CR',
      requestedLanguages: ['es', 'en'],
    });
    // The lexicon carries CYBERCRIME terms. The scope must not.
    expect(SEED_LEXICON.some((t) => t.category === 'CYBERCRIME')).toBe(true);
    expect(scope.terms.some((t) => t.category === 'CYBERCRIME')).toBe(false);
  });

  it('returns nothing at all for a country where nothing is enabled', () => {
    const scope = resolveEffectiveScope({
      taxonomy: withTerms,
      country: 'GB',
      requestedLanguages: ['en'],
    });
    expect(scope.categories).toEqual([]);
    expect(scope.terms.every((t) => t.category === null)).toBe(true);
  });

  it('excludes authority names, which are never a search term for a person', () => {
    const scope = resolveEffectiveScope({
      taxonomy: withTerms,
      country: 'CR',
      requestedLanguages: ['es'],
    });
    expect(scope.terms.some((t) => t.kind === 'AUTHORITY_NAME')).toBe(false);
    expect(scope.terms.some((t) => t.kind === 'PROCEDURAL')).toBe(true);
  });

  it('searches an unmeasured language and reports it, rather than refusing to run', () => {
    const scope = resolveEffectiveScope({
      taxonomy: withTerms,
      country: 'CR',
      requestedLanguages: ['es', 'en'],
    });
    expect(scope.languages).toEqual(['es', 'en']);
    expect(scope.unmeasuredLanguages).toEqual(['es', 'en']);
  });

  it('drops a requested language the taxonomy does not declare, and says which', () => {
    const scope = resolveEffectiveScope({
      taxonomy: withTerms,
      country: 'CR',
      requestedLanguages: ['es', 'ar'],
    });
    expect(scope.languages).toEqual(['es']);
    expect(scope.undeclaredLanguages).toEqual(['ar']);
    expect(scope.terms.every((t) => t.language === 'es')).toBe(true);
  });

  it('names the enabled categories that have no term to search with', () => {
    const empty = resolveEffectiveScope({
      taxonomy: taxonomy(),
      country: 'CR',
      requestedLanguages: ['es'],
    });
    // With an empty lexicon, every enabled category is searched only by the bare-name families.
    expect(empty.categoriesWithoutTerms).toEqual(['FRAUD_FINANCIAL_CRIME', 'BRIBERY_CORRUPTION']);

    const seeded = resolveEffectiveScope({
      taxonomy: withTerms,
      country: 'CR',
      requestedLanguages: ['es'],
    });
    expect(seeded.categoriesWithoutTerms).toEqual([]);
  });

  it('reports the languages whose terms nobody has reviewed', () => {
    const scope = resolveEffectiveScope({
      taxonomy: withTerms,
      country: 'CR',
      requestedLanguages: ['es', 'en'],
    });
    expect([...scope.unreviewedTermLanguages].sort()).toEqual(['en', 'es']);
  });
});
