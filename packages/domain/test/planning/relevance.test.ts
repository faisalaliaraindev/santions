/**
 * FR-06 relevance filtering.
 *
 * Two properties carry the weight:
 *
 * 1. **It never decides adversity.** A candidate that mentions the subject and no adverse term is
 *    still fetched. A filter that dropped innocuous-looking candidates would make the service
 *    better at confirming suspicions than at testing them.
 * 2. **The score does not gate.** Rejections are categorical — a fact about the candidate, not a
 *    number nobody validated. The number is recorded and explained so a corpus can one day
 *    calibrate against real runs.
 */

import { describe, expect, it } from 'vitest';

import {
  NEAR_NAME_TOKEN_DISTANCE,
  RELEVANCE_METHOD,
  RELEVANCE_SIGNALS,
  assessRelevance,
  signalPolarity,
  type RelevanceInput,
} from '../../src/planning/relevance.js';

const NAME = 'María Fernanda Solís Rojas';

function input(overrides: Partial<RelevanceInput> = {}): RelevanceInput {
  return {
    title: `Fiscalía acusa a ${NAME} de fraude`,
    snippet: 'La Fiscalía presentó cargos esta semana.',
    url: 'https://www.example-news.cr/sucesos/acusacion-solis',
    subjectNameForms: [NAME],
    disambiguators: [],
    adverseTerms: ['fraude', 'acusa'],
    publisherTier: 2,
    publishedOn: '2026-08-18',
    window: null,
    acceptedTitlesFromDomain: [],
    originAlreadyFetched: false,
    ...overrides,
  };
}

describe('the nine signals', () => {
  it('names all nine, in FR-06 order', () => {
    expect(RELEVANCE_SIGNALS).toHaveLength(9);
    expect(RELEVANCE_SIGNALS[0]).toBe('NAME_IN_TITLE_OR_SNIPPET');
    expect(RELEVANCE_SIGNALS[4]).toBe('WITHIN_REQUESTED_WINDOW');
  });

  it('treats the window as a gate rather than a weight, as FR-06 does', () => {
    // "publication date inside the requested window (a gate)" — its own words.
    expect(signalPolarity('WITHIN_REQUESTED_WINDOW')).toBe('GATE');
  });

  it('assesses every signal, and reports the one it cannot', () => {
    const result = assessRelevance(input());
    expect(result.signals.map((s) => s.signal)).toContain('ADVERSE_TERM_NEAR_NAME');
    // Not knowable from a headline and a URL. Declared, never guessed at.
    expect(result.unevaluable).toContain('NAME_ONLY_IN_PERIPHERAL_MODULE');
  });
});

describe('it never decides adversity', () => {
  it('fetches a candidate that names the subject and no adverse term at all', () => {
    // The load-bearing test. A filter that required an adverse term would only ever find
    // evidence that confirms a suspicion, and would never find the article that clears someone.
    const result = assessRelevance(
      input({
        title: `${NAME} nombrada directora de la fundación`,
        snippet: 'Asumirá el cargo en septiembre.',
        adverseTerms: ['fraude', 'acusa'],
      }),
    );
    expect(result.decision).toBe('FETCH');
  });

  it('fetches an acquittal as readily as an accusation', () => {
    const result = assessRelevance(
      input({ title: `Tribunal absuelve a ${NAME}`, snippet: null, adverseTerms: ['absuelve'] }),
    );
    expect(result.decision).toBe('FETCH');
  });

  it('says plainly that an adverse term near the name is about topic, not conduct', () => {
    const result = assessRelevance(input());
    const signal = result.signals.find((s) => s.signal === 'ADVERSE_TERM_NEAR_NAME');
    expect(signal?.fired).toBe(true);
    expect(signal?.detail).toContain('says nothing about what they did');
  });
});

describe('the refusals are categorical, not scored', () => {
  it('does NOT refuse a candidate whose headline does not name the subject', () => {
    // The first draft refused these, and the mock discovery fixtures caught it. The FR-04 plan
    // has company-anchored query families whose whole purpose is to find documents naming a
    // *company* rather than the person — "Fiscalía acusa a directiva de Inversiones Talamanca"
    // names the company and the role and not the person. Refusing them would delete the
    // association half of the product while the coverage statement said the sources were
    // searched. A headline is also not the document.
    const result = assessRelevance(
      input({
        title: 'Fiscalía acusa a directiva de Inversiones Talamanca por presunto fraude',
        snippet: null,
      }),
    );
    expect(result.decision).toBe('FETCH');
    // It is a missing positive signal, and the score says so.
    const named = result.signals.find((s) => s.signal === 'NAME_IN_TITLE_OR_SNIPPET');
    expect(named?.fired).toBe(false);
    expect(result.score ?? 1).toBeLessThan(0.5);
  });

  it('refuses a candidate published outside the requested window', () => {
    const result = assessRelevance(
      input({ publishedOn: '2019-01-01', window: { from: '2026-01-01', to: '2026-12-31' } }),
    );
    expect(result.decision).toBe('REJECT');
    expect(result.rejection).toBe('OUTSIDE_REQUESTED_WINDOW');
  });

  it('does NOT refuse an undated candidate', () => {
    // FR-07 keeps a missing date null rather than inventing one, and refusing every undated
    // candidate would silently drop whole publishers who put no dates in their feeds — a recall
    // loss that would look like an absence of news.
    const result = assessRelevance(
      input({ publishedOn: null, window: { from: '2026-01-01', to: '2026-12-31' } }),
    );
    expect(result.decision).toBe('FETCH');
    const gate = result.signals.find((s) => s.signal === 'WITHIN_REQUESTED_WINDOW');
    expect(gate?.detail).toContain('never invented');
  });

  it('refuses a URL that is not a document', () => {
    for (const url of [
      'https://www.example-news.cr/tag/fraude',
      'https://www.example-news.cr/author/redaccion',
      'https://www.example-news.cr/search?q=solis',
      'https://www.example-news.cr/photo.jpg',
    ]) {
      const result = assessRelevance(input({ url }));
      expect(result.rejection, url).toBe('NOT_AN_ARTICLE_URL');
    }
  });

  it('refuses a copy whose origin has already been fetched', () => {
    // One story is one lead. Fetching the copy adds distribution, not verification (FR-10) —
    // and counting it twice is what would inflate axis D's independence count.
    const result = assessRelevance(input({ originAlreadyFetched: true }));
    expect(result.rejection).toBe('DUPLICATE_OF_FETCHED_ORIGIN');
  });

  it('keeps a real article whose URL merely looks busy', () => {
    // The non-article list is deliberately narrow: a false positive here refuses a real article.
    const result = assessRelevance({
      ...input(),
      url: 'https://www.example-news.cr/2026/08/18/sucesos/acusacion-contra-solis-rojas.html',
    });
    expect(result.decision).toBe('FETCH');
  });
});

describe('the score', () => {
  it('is uncalibrated, and says so in its method name', () => {
    expect(RELEVANCE_METHOD).toContain('UNCALIBRATED');
    expect(assessRelevance(input()).method).toBe(RELEVANCE_METHOD);
  });

  it('does not gate by default', () => {
    // The weakest candidate that still mentions the subject: no disambiguator, no adverse term,
    // an unknown publisher. It scores low and is fetched anyway, because no corpus has said
    // where the line goes.
    const result = assessRelevance(
      input({
        title: `Algo sobre ${NAME}`,
        snippet: null,
        adverseTerms: ['fraude'],
        publisherTier: null,
        disambiguators: [],
      }),
    );
    expect(result.decision).toBe('FETCH');
    expect(result.score).toBeLessThan(0.5);
  });

  it('gates only when a threshold is deliberately configured', () => {
    const weak = input({
      title: `Algo sobre ${NAME}`,
      snippet: null,
      adverseTerms: ['fraude'],
      publisherTier: null,
      minimumScore: 0.9,
    });
    const result = assessRelevance(weak);
    expect(result.decision).toBe('REJECT');
    expect(result.rejection).toBe('BELOW_CONFIGURED_THRESHOLD');
    // The refusal says the number is uncalibrated, so nobody reads it as a measured judgement.
    expect(result.detail).toContain('uncalibrated');
  });

  it('is computed only from signals that could be evaluated', () => {
    // A score from six of nine signals must not be presented as a score from nine.
    const result = assessRelevance(input());
    expect(result.unevaluable.length).toBeGreaterThan(0);
    expect(result.detail).toContain('cannot be evaluated before a fetch');
  });

  it('rises as more signals fire', () => {
    const bare = assessRelevance(
      input({ title: `Algo sobre ${NAME}`, snippet: null, publisherTier: null }),
    );
    const rich = assessRelevance(
      input({
        title: `Fiscalía acusa a ${NAME} de fraude`,
        snippet: 'Nacida en 1972, dirigió Inversiones Talamanca S.A.',
        disambiguators: ['1972', 'Inversiones Talamanca'],
        publisherTier: 1,
      }),
    );
    expect(rich.score ?? 0).toBeGreaterThan(bare.score ?? 0);
  });
});

describe('near-duplicate detection', () => {
  it('spots a re-headlined copy from the same domain', () => {
    const result = assessRelevance(
      input({
        title: `ÚLTIMA HORA: Fiscalía acusa a ${NAME} de fraude`,
        acceptedTitlesFromDomain: [`Fiscalía acusa a ${NAME} de fraude`],
      }),
    );
    const signal = result.signals.find((s) => s.signal === 'NEAR_DUPLICATE_FROM_DOMAIN');
    expect(signal?.fired).toBe(true);
  });

  it('does not treat two different stories about one person as duplicates', () => {
    const result = assessRelevance(
      input({
        title: `Fiscalía acusa a ${NAME} de fraude`,
        acceptedTitlesFromDomain: [`${NAME} nombrada directora de la fundación`],
      }),
    );
    const signal = result.signals.find((s) => s.signal === 'NEAR_DUPLICATE_FROM_DOMAIN');
    expect(signal?.fired).toBe(false);
  });

  it('records a near-duplicate without refusing it', () => {
    // Recorded and shown, not dropped: a second report from one domain is weak corroboration,
    // and whether it counts is axis D's decision after clustering, not this filter's.
    const result = assessRelevance(
      input({
        title: `ÚLTIMA HORA: Fiscalía acusa a ${NAME} de fraude`,
        acceptedTitlesFromDomain: [`Fiscalía acusa a ${NAME} de fraude`],
      }),
    );
    expect(result.decision).toBe('FETCH');
  });
});

describe('matching', () => {
  it('folds accents, so a query without them still matches a headline with them', () => {
    const result = assessRelevance(
      input({ title: 'Fiscalia acusa a Maria Fernanda Solis Rojas', snippet: null }),
    );
    expect(result.decision).toBe('FETCH');
  });

  it('matches any searched alias, not only the primary name', () => {
    const result = assessRelevance(
      input({
        title: 'Cargos contra M. F. Solís',
        snippet: null,
        subjectNameForms: [NAME, 'M. F. Solís'],
      }),
    );
    expect(result.decision).toBe('FETCH');
  });

  it('does not fire the adverse-term signal for a term far from the name', () => {
    const filler = 'palabra '.repeat(NEAR_NAME_TOKEN_DISTANCE + 6);
    const result = assessRelevance(
      input({ title: `${NAME} ${filler} fraude`, snippet: null, adverseTerms: ['fraude'] }),
    );
    const signal = result.signals.find((s) => s.signal === 'ADVERSE_TERM_NEAR_NAME');
    expect(signal?.fired).toBe(false);
    // And it is still fetched: distance weakens a signal, it does not refuse a candidate.
    expect(result.decision).toBe('FETCH');
  });
});
