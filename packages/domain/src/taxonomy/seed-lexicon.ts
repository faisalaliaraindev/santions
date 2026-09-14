/**
 * Phase D step D6 — the FR-03 lexicon: the conduct, procedural and authority terms a query plan
 * is built from.
 *
 * # Read this before using the Spanish list
 *
 * **No Spanish reader has reviewed these terms.** Every `es` entry below is marked
 * `UNREVIEWED_AUTHORED`, the coverage statement says so on every run that searches in Spanish,
 * and the handoff log says so. The brief allowed two honest outcomes — a reviewed list, or an
 * unreviewed one whose state is recorded — and this is the second, because no Spanish-reading
 * reviewer was available. It is **not** the third option: nothing here is machine-translated, and
 * `auditTaxonomyForActivation` refuses a `MACHINE_TRANSLATED` term outright (D-010).
 *
 * What "unreviewed" costs, stated plainly so nobody has to infer it: the Costa Rican terms for
 * the procedural stages are the load-bearing half of this list, and a wrong one does not fail —
 * it returns nothing, quietly, and the run reports no findings in a language it searched badly.
 * `imputado` and `acusación formal` are the two that matter most, because almost every real CR
 * report of a charge uses one of them, and if they are wrong the Spanish half of the system finds
 * approximately nothing while looking fully configured.
 *
 * **What a reviewer should check, in priority order:**
 *
 *  1. The procedural terms. Costa Rican criminal procedure has its own vocabulary and it is not
 *     the Spanish of Spain or Mexico — `legitimación de capitales` rather than `lavado de dinero`
 *     is the clearest example, and it is a statutory term (Ley 8204), not a stylistic choice.
 *  2. The authority names. A wrong authority name is a query that returns the authority's whole
 *     press archive.
 *  3. The conduct terms per category, for false friends and for terms that are legally correct
 *     but journalistically unused.
 *
 * # Why this is data in the pure package
 *
 * The taxonomy is versioned configuration, and these are the **seed values for version 1** — the
 * bootstrap writes them onto the tenant's `TaxonomyVersion`, from where an admin can revise them
 * through the D1 approval lifecycle. They live here rather than in the bootstrap script so that
 * `auditLexicon` runs against them in CI: a protected-characteristic term in this file fails the
 * build (T79) before it can reach a database, let alone a source.
 *
 * # What is deliberately absent
 *
 * No term naming a protected characteristic, obviously — but also **no term that is only a person
 * category**: `activista`, `manifestante`, `sindicalista`, `opositor`. FR-03 excludes political
 * opinion and lawful activism from the taxonomy entirely, and a term list is where that exclusion
 * gets quietly reversed if nobody is watching.
 */

import type { AdverseCategory } from './categories.js';
import type { LexiconTerm, TermKind } from './types.js';

/**
 * Every seeded term is `UNREVIEWED_AUTHORED`, English included.
 *
 * The English list is no more reviewed than the Spanish one — one engineer wrote both — and
 * marking it `REVIEWED_BY_SPEAKER` because the author happens to read English would be exactly
 * the self-certification the field exists to prevent. What differs between the two is the *cost*
 * of being wrong, and D-010 is about that: an English error is visible to anyone reading the
 * list, and a Costa Rican Spanish error is not.
 */
const UNREVIEWED = 'UNREVIEWED_AUTHORED' as const;

function term(
  value: string,
  language: string,
  kind: TermKind,
  category: AdverseCategory | null,
  rank: number,
): LexiconTerm {
  return { term: value, language, kind, category, rank, reviewState: UNREVIEWED };
}

/**
 * Conduct terms, per category.
 *
 * Ranked, because FR-04 keeps the top-N per (category, language) when the plan is bounded, and
 * rank 1 should be the phrase a real report of that conduct is most likely to use — not the most
 * legally precise one. `estafa` outranks `defraudación` for that reason.
 */
const CONDUCT: Readonly<
  Record<AdverseCategory, { readonly en: readonly string[]; readonly es: readonly string[] }>
> = {
  FRAUD_FINANCIAL_CRIME: {
    en: ['fraud', 'embezzlement', 'misappropriation', 'false accounting'],
    es: ['estafa', 'fraude', 'apropiación indebida', 'administración fraudulenta'],
  },
  MONEY_LAUNDERING_TF: {
    // `legitimación de capitales` is the Costa Rican statutory term (Ley 8204). `lavado de
    // dinero` is what a non-CR outlet writes, so both are carried and the statutory one ranks
    // first.
    en: ['money laundering', 'terrorist financing', 'proceeds of crime'],
    es: ['legitimación de capitales', 'lavado de dinero', 'financiamiento al terrorismo'],
  },
  BRIBERY_CORRUPTION: {
    en: ['bribery', 'corruption', 'kickback', 'illicit enrichment', 'influence peddling'],
    es: [
      'cohecho',
      'peculado',
      'soborno',
      'enriquecimiento ilícito',
      'tráfico de influencias',
      'dádiva',
    ],
  },
  MARKET_ABUSE: {
    en: ['insider dealing', 'market manipulation', 'market abuse'],
    es: ['uso de información privilegiada', 'manipulación del mercado'],
  },
  SANCTIONS_EVASION_EXPORT_CONTROL: {
    en: ['sanctions evasion', 'export control breach', 'designated entity'],
    es: ['evasión de sanciones', 'incumplimiento de controles de exportación'],
  },
  TAX_OFFENCES: {
    en: ['tax evasion', 'tax fraud', 'undeclared income'],
    es: ['evasión fiscal', 'defraudación fiscal', 'evasión tributaria'],
  },
  ORGANISED_CRIME: {
    en: ['organised crime', 'criminal conspiracy', 'criminal organisation'],
    es: ['crimen organizado', 'asociación ilícita', 'estructura criminal'],
  },
  DRUG_OFFENCES: {
    en: ['drug trafficking', 'narcotics offence', 'drug seizure'],
    es: ['narcotráfico', 'tráfico de drogas', 'decomiso de droga'],
  },
  HUMAN_TRAFFICKING_MODERN_SLAVERY: {
    en: ['human trafficking', 'forced labour', 'modern slavery', 'people smuggling'],
    es: ['trata de personas', 'explotación laboral', 'tráfico ilícito de personas'],
  },
  TERRORISM_VIOLENT_EXTREMISM: {
    en: ['terrorism', 'terrorist offence', 'violent extremism'],
    es: ['terrorismo', 'delito de terrorismo'],
  },
  VIOLENT_CRIME: {
    en: ['homicide', 'assault', 'kidnapping', 'aggravated robbery'],
    es: ['homicidio', 'agresión', 'secuestro', 'robo agravado'],
  },
  CYBERCRIME: {
    en: ['cybercrime', 'computer fraud', 'data breach offence', 'unauthorised access'],
    es: ['delito informático', 'estafa informática', 'acceso no autorizado'],
  },
  REGULATORY_PROFESSIONAL_MISCONDUCT: {
    en: ['regulatory breach', 'disciplinary sanction', 'struck off', 'disqualified'],
    es: ['sanción disciplinaria', 'inhabilitación', 'falta grave', 'incumplimiento normativo'],
  },
  ENVIRONMENTAL_HEALTH_SAFETY: {
    en: ['environmental offence', 'pollution offence', 'safety breach'],
    es: ['delito ambiental', 'daño ambiental', 'contaminación'],
  },
  CONSUMER_HARM_MISSELLING: {
    en: ['mis-selling', 'misleading advertising', 'consumer protection breach'],
    es: ['publicidad engañosa', 'cláusulas abusivas', 'competencia desleal'],
  },
  INSOLVENCY_MISCONDUCT: {
    en: ['fraudulent trading', 'wrongful trading', 'fraudulent bankruptcy'],
    es: ['quiebra fraudulenta', 'insolvencia fraudulenta', 'concurso de acreedores'],
  },
  GOVERNANCE_INTEGRITY: {
    en: ['conflict of interest', 'breach of duty', 'governance failure'],
    es: ['conflicto de interés', 'falta de probidad', 'incumplimiento de deberes'],
  },
};

/**
 * Procedural terms — the stage vocabulary, which is not category-specific.
 *
 * `category: null`, because "charged" narrows *any* category and attaching it to one would mean
 * a plan that looks for charges only in fraud. These are the terms that decide whether the
 * Spanish half of the system finds a real Costa Rican court report at all, which is why they are
 * first on the reviewer's list at the top of this file.
 */
const PROCEDURAL: Readonly<Record<string, readonly string[]>> = {
  en: [
    'charged',
    'indicted',
    'convicted',
    'sentenced',
    'arrested',
    'under investigation',
    'criminal proceedings',
    'guilty plea',
    'acquitted',
    'appeal',
    'fined',
    'settlement',
  ],
  es: [
    // Ranked as a Costa Rican report would use them. `imputado` is the single most load-bearing
    // term in this file.
    'imputado',
    'acusación formal',
    'condenado',
    'sentencia condenatoria',
    'detenido',
    'investigación penal',
    'allanamiento',
    'prisión preventiva',
    'medidas cautelares',
    'juicio oral',
    'sobreseimiento',
    'querella',
    'denuncia penal',
    'absuelto',
    'apelación',
    'multa',
  ],
};

/**
 * Authority names — never a search term for a person on their own.
 *
 * `topTermsFor` in `build-plan.ts` filters `AUTHORITY_NAME` out of F3 deliberately: `"Ana Solís"
 * Fiscalía` finds every article that mentions the prosecutor, which is most of them. They are
 * carried because extraction needs them — FR-11's authority axis has to recognise the naming
 * authority in a document — not because the planner does.
 */
const AUTHORITIES: Readonly<Record<string, readonly string[]>> = {
  en: [
    'public prosecutor',
    'attorney general',
    'financial regulator',
    'supreme court',
    'court of appeal',
  ],
  es: [
    'Ministerio Público',
    'Fiscalía General de la República',
    'Organismo de Investigación Judicial',
    'Poder Judicial',
    'Sala Tercera',
    'Contraloría General de la República',
    'Procuraduría de la Ética Pública',
    'SUGEF',
    'SUGEVAL',
    'Instituto Costarricense sobre Drogas',
  ],
};

/** The seed lexicon for taxonomy version 1: every conduct, procedural and authority term. */
export const SEED_LEXICON: readonly LexiconTerm[] = [
  ...Object.entries(CONDUCT).flatMap(([category, byLanguage]) =>
    (['en', 'es'] as const).flatMap((language) =>
      byLanguage[language].map((value, index) =>
        term(value, language, 'CONDUCT', category as AdverseCategory, index + 1),
      ),
    ),
  ),
  ...(['en', 'es'] as const).flatMap((language) =>
    (PROCEDURAL[language] ?? []).map((value, index) =>
      term(value, language, 'PROCEDURAL', null, index + 1),
    ),
  ),
  ...(['en', 'es'] as const).flatMap((language) =>
    (AUTHORITIES[language] ?? []).map((value, index) =>
      term(value, language, 'AUTHORITY_NAME', null, index + 1),
    ),
  ),
];

/** The languages the seed lexicon carries terms in. */
export const SEED_LEXICON_LANGUAGES: readonly string[] = ['en', 'es'];

/**
 * The sentence a coverage statement must carry while a language's terms are unreviewed.
 *
 * Returns null when every term in that language has been reviewed by a speaker, so that the
 * warning disappears by itself the moment a review lands rather than requiring somebody to
 * remember to delete it.
 */
export function unreviewedLexiconNote(
  terms: readonly LexiconTerm[],
  language: string,
): string | null {
  const inLanguage = terms.filter((t) => t.language === language);
  if (inLanguage.length === 0) {
    return null;
  }
  const unreviewed = inLanguage.filter((t) => t.reviewState !== 'REVIEWED_BY_SPEAKER');
  if (unreviewed.length === 0) {
    return null;
  }
  return (
    `The ${language} term list (${String(unreviewed.length)} of ${String(inLanguage.length)} terms) ` +
    `has not been reviewed by a reader of that language. Terms were authored by hand and are not ` +
    `machine-translated, but an unreviewed term does not fail — it returns nothing, so a category ` +
    `searched in ${language} may report no findings because the query was wrong rather than ` +
    `because nothing exists (D-010).`
  );
}
