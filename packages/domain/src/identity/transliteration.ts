/**
 * FR-08 — the transliteration seam.
 *
 * ICU transliteration (Arabic, Cyrillic, Chinese, Devanagari and others) is a native
 * dependency and cannot live in this package, which must run with no I/O so the I1-I10
 * harness can gate CI (section 11).
 *
 * So `matchNameForms` compares *strings*. It cannot match "Vladimir Petrov" against
 * "Владимир Петров" on its own, and it does not pretend to. The provider layer implements
 * this port, expands a name into all its candidate romanisations, and the caller matches
 * against each — retaining every candidate, per FR-08.
 */

import {
  matchNameForms,
  normaliseName,
  type NameMatch,
  type NormalisedName,
} from './name-forms.js';

export interface TransliterationPort {
  /**
   * All candidate romanisations of a name, including the input itself.
   *
   * "All candidate" is deliberate: Arabic and Cyrillic names have several defensible
   * romanisations and picking one loses recall. The caller keeps them all.
   */
  romanisations(name: string): readonly string[];
}

/**
 * Identity implementation, for tests and for Latin-script-only deployments. Returns the input
 * unchanged — which is correct behaviour, not a stub: a Latin name needs no transliteration.
 */
export const identityTransliteration: TransliterationPort = {
  romanisations: (name) => [name],
};

export interface TransliteratedMatch extends NameMatch {
  /** The romanisation that produced the match, when it was not the original string. */
  readonly viaRomanisation: string | null;
}

/**
 * Match a subject against a candidate, expanding both through the transliteration port.
 *
 * Returns the strongest match found across every romanisation pair. Both sides are expanded
 * because either may be the non-Latin one: the subject snapshot may hold the original script
 * while the document is romanised, or the reverse.
 */
export function matchAcrossScripts(
  subject: NormalisedName,
  candidate: NormalisedName,
  port: TransliterationPort,
): TransliteratedMatch {
  const direct = matchNameForms(subject, candidate);
  if (direct.form !== 'NO_MATCH') {
    return { ...direct, viaRomanisation: null };
  }

  const subjectForms = port.romanisations(subject.original);
  const candidateForms = port.romanisations(candidate.original);

  for (const s of subjectForms) {
    for (const c of candidateForms) {
      const match = matchNameForms(normaliseName(s), normaliseName(c));
      if (match.form !== 'NO_MATCH') {
        return {
          // The finding stores the form as it appeared in the *document*, per FR-08, not the
          // romanisation we used internally to find it.
          form: match.form,
          matchedForm: candidate.original,
          matchedScripts: candidate.scripts,
          viaRomanisation: c === candidate.original ? s : c,
        };
      }
    }
  }

  return { form: 'NO_MATCH', matchedForm: '', matchedScripts: [], viaRomanisation: null };
}
