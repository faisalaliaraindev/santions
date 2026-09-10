/** FR-08 — cross-script matching through the transliteration port. */

import { describe, expect, it } from 'vitest';

import { normaliseName } from '../../src/identity/name-forms.js';
import {
  identityTransliteration,
  matchAcrossScripts,
  type TransliterationPort,
} from '../../src/identity/transliteration.js';

/** A fixture port standing in for ICU. Real romanisations come from the provider layer. */
const fixturePort: TransliterationPort = {
  romanisations: (name) => {
    const table: Record<string, readonly string[]> = {
      'Владимир Петров': ['Владимир Петров', 'Vladimir Petrov', 'Wladimir Petroff'],
      'محمد الأحمد': ['محمد الأحمد', 'Mohammed Al-Ahmad', 'Muhammad Alahmad'],
    };
    return table[name] ?? [name];
  },
};

describe('matchAcrossScripts', () => {
  it('matches a Latin subject against a Cyrillic document via a romanisation', () => {
    const match = matchAcrossScripts(
      normaliseName('Vladimir Petrov'),
      normaliseName('Владимир Петров'),
      fixturePort,
    );
    expect(match.form).toBe('EXACT');
    // The finding stores the form as it appeared in the document, not our romanisation.
    expect(match.matchedForm).toBe('Владимир Петров');
    expect(match.matchedScripts).toContain('Cyrillic');
    expect(match.viaRomanisation).toBe('Vladimir Petrov');
  });

  it('retains every candidate romanisation, not just the first', () => {
    const match = matchAcrossScripts(
      normaliseName('Muhammad Alahmad'),
      normaliseName('محمد الأحمد'),
      fixturePort,
    );
    expect(match.form).not.toBe('NO_MATCH');
  });

  it('reports no romanisation when the direct comparison already matched', () => {
    const match = matchAcrossScripts(
      normaliseName('Rhys Mordaunt'),
      normaliseName('Rhys Mordaunt'),
      fixturePort,
    );
    expect(match.form).toBe('EXACT');
    expect(match.viaRomanisation).toBeNull();
  });

  it('still returns NO_MATCH for genuinely different names', () => {
    const match = matchAcrossScripts(
      normaliseName('Elin Lindqvist'),
      normaliseName('Владимир Петров'),
      fixturePort,
    );
    expect(match.form).toBe('NO_MATCH');
  });

  it('the identity port is a correct implementation for Latin-only deployments', () => {
    expect(identityTransliteration.romanisations('Rhys Mordaunt')).toEqual(['Rhys Mordaunt']);
  });
});
