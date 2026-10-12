/**
 * The live rule-based `ExtractionModelPort` — D-048.
 *
 * What these tests hold in place is less the matching than the honesty around it: that it is not
 * the mock, that it says no model produced its assertions, that it refuses a category the tenant
 * has not enabled, that a term far from the subject is not a claim about the subject, and that an
 * acquittal beats a charge when both are near.
 */

import { describe, expect, it } from 'vitest';

import {
  RuleBasedExtractionAdapter,
  RULE_BASED_EXTRACTOR_VERSION,
} from '../src/sources/rule-based-extraction.adapter.js';
import type { ExtractedAssertion, ExtractionInput } from '../src/sources/extraction-model.port.js';
import type { SourceOutcome } from '../src/sources/source-adapter.js';
import { ADVERSE_CATEGORIES } from '@adverse-search/domain';

const CLOCK = (): Date => new Date('2026-09-16T00:00:00.000Z');

function inputFor(text: string, overrides: Partial<ExtractionInput> = {}): ExtractionInput {
  return {
    documentId: 'doc-1',
    documentVersion: 1,
    text,
    language: 'en',
    subjectNameForms: ['Ana Jiménez'],
    taxonomyVersionId: 'tenant-1:v1',
    enabledCategoryIds: [...ADVERSE_CATEGORIES],
    ...overrides,
  };
}

async function extract(
  text: string,
  overrides: Partial<ExtractionInput> = {},
): Promise<SourceOutcome<readonly ExtractedAssertion[]>> {
  return new RuleBasedExtractionAdapter(CLOCK).extract(inputFor(text, overrides));
}

function assertionsOf(
  outcome: SourceOutcome<readonly ExtractedAssertion[]>,
): readonly ExtractedAssertion[] {
  if (outcome.status !== 'OK' && outcome.status !== 'BOUNDED') {
    throw new Error(`Expected assertions, got ${outcome.status}`);
  }
  return outcome.data;
}

describe('what it declares about itself', () => {
  it('is a live adapter that needs no mock-mode witness', () => {
    const adapter = new RuleBasedExtractionAdapter(CLOCK);
    expect(adapter.descriptor.mode).toBe('LIVE');
    expect(adapter.descriptor.adapterId).toBe('rule-based-extraction');
    // Not the mock, which is MOCK / ['CR'] and stays that way so a fixture can never serve a
    // live run (T55).
    expect(adapter.descriptor.adapterId).not.toContain('mock');
  });

  it('reports no model, and is reachable because there is nothing to reach', async () => {
    const described = await new RuleBasedExtractionAdapter(CLOCK).describeModel();
    expect(described).toEqual({ modelId: null, reachable: true });
  });
});

describe('extraction', () => {
  it('emits an assertion whose spans point at the words it read', async () => {
    const text =
      'The Securities and Exchange Commission charged Ana Jiménez with securities fraud. ' +
      'Ana Jiménez was indicted in March.';
    const assertions = assertionsOf(await extract(text));

    expect(assertions).toHaveLength(1);
    const assertion = assertions[0];
    expect(assertion?.categoryId).toBe('FRAUD_FINANCIAL_CRIME');
    expect(assertion?.proceduralStage).toBe('CHARGE_INDICTMENT');
    expect(assertion?.partyRole).toBe('ACCUSED_DEFENDANT_CRIMINAL');
    expect(assertion?.namingAuthority).toBe('Securities and Exchange Commission');

    // Spans, not restatements: every one of them resolves to the text it claims.
    const mention = assertion?.subjectMentionSpans[0];
    expect(text.slice(mention?.start ?? 0, mention?.end ?? 0)).toBe('Ana Jiménez');
    expect(text.slice(assertion?.conductSpan?.start ?? 0, assertion?.conductSpan?.end ?? 0)).toBe(
      'fraud',
    );
    expect(text.slice(assertion?.stageSpan?.start ?? 0, assertion?.stageSpan?.end ?? 0)).toBe(
      'indicted',
    );
  });

  it('says on every assertion that no model produced it (FR-07, D-048)', async () => {
    const assertions = assertionsOf(
      await extract('Ana Jiménez was convicted of money laundering.'),
    );
    expect(assertions[0]?.modelId).toBeNull();
    expect(assertions[0]?.promptVersion).toBeNull();
    // The version string is where a reader learns what read the document.
    expect(assertions[0]?.extractorVersion).toBe(RULE_BASED_EXTRACTOR_VERSION);
    expect(RULE_BASED_EXTRACTOR_VERSION).toContain('rule-based');
    expect(RULE_BASED_EXTRACTOR_VERSION).toContain('unbenchmarked');
  });

  it('leaves all four dates null rather than backfilling any of them', async () => {
    const assertions = assertionsOf(
      await extract('Ana Jiménez was convicted of fraud on 14 March 2024.'),
    );
    expect(assertions[0]?.eventDate).toEqual({ value: null, precision: 'UNKNOWN' });
    expect(assertions[0]?.publicationDate).toEqual({ value: null, precision: 'UNKNOWN' });
    expect(assertions[0]?.updateDate).toEqual({ value: null, precision: 'UNKNOWN' });
  });

  it('reads a document the subject is not named in as no result, not as a failure', async () => {
    const outcome = await extract('Someone else entirely was charged with fraud.');
    expect(outcome.status).toBe('NO_RESULTS');
  });

  it('does not match a name form inside a longer word', async () => {
    // "Ana" inside "Santana" is a different person. Over real prose a substring match attributes
    // a stranger's conviction to the subject.
    const outcome = await extract('Roberto Santana was convicted of fraud.', {
      subjectNameForms: ['Ana'],
    });
    expect(outcome.status).toBe('NO_RESULTS');
  });

  it('will not use a category the tenant has not enabled', async () => {
    const outcome = await extract('Ana Jiménez was charged with money laundering.', {
      enabledCategoryIds: ['BRIBERY_CORRUPTION'],
    });
    // Not rounded to the nearest enabled category: that would turn a disabled category into an
    // enabled one at extraction time.
    expect(outcome.status).toBe('NO_RESULTS');
  });

  it('does not attribute conduct that is nowhere near the subject', async () => {
    const text =
      'Ana Jiménez opened a bakery in Cartago. ' +
      'x'.repeat(900) +
      ' In unrelated news, a former minister was convicted of bribery.';
    const outcome = await extract(text);
    expect(outcome.status).toBe('NO_RESULTS');
  });

  it('takes the acquittal over the charge when the document carries both', async () => {
    // D-047's rule reaches extraction: the exoneration has to come through as readily as the
    // accusation, or the service is better at confirming suspicions than at testing them.
    const assertions = assertionsOf(
      await extract(
        'Ana Jiménez, who was charged with fraud in 2023, was acquitted by the court last week.',
      ),
    );
    expect(assertions[0]?.proceduralStage).toBe('ACQUITTAL_DISMISSAL_OVERTURNED');
    // An acquittal is not an adverse role. The banding engine decides what to do with it; the
    // extractor's job is not to have decided already.
    expect(assertions[0]?.partyRole).toBe('UNSPECIFIED');
  });

  it('leaves the stage unspecified, with no span, when no stage term is near', async () => {
    const assertions = assertionsOf(
      await extract('A report describes the fraud that Ana Jiménez is said to have uncovered.'),
    );
    expect(assertions[0]?.proceduralStage).toBe('UNSPECIFIED');
    // I4: a stage is only ever set from the span that establishes it.
    expect(assertions[0]?.stageSpan).toBeNull();
  });

  it('emits one assertion per category, in a deterministic order', async () => {
    const assertions = assertionsOf(
      await extract(
        'Ana Jiménez was charged with money laundering and bribery of a public official.',
      ),
    );
    expect(assertions.map((assertion) => assertion.categoryId)).toEqual([
      'BRIBERY_CORRUPTION',
      'MONEY_LAUNDERING_TF',
    ]);
  });

  it('reads Spanish prose as well as English', async () => {
    const assertions = assertionsOf(
      await extract(
        'La Fiscalía presentó una acusación formal contra Ana Jiménez por fraude y lavado de dinero.',
        { language: 'es' },
      ),
    );
    expect(assertions.map((assertion) => assertion.proceduralStage)).toEqual([
      'CHARGE_INDICTMENT',
      'CHARGE_INDICTMENT',
    ]);
    expect(assertions[0]?.namingAuthority).toBe('Fiscalía');
  });

  it('fails, rather than returning nothing, when there is no text to read', async () => {
    // "Could not read it" and "read it and it said nothing about this person" are different
    // facts about the run, and merging them is how an unreadable document becomes a clean
    // negative (D-046, D-048).
    const outcome = await extract('');
    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED') {
      expect(outcome.detail).toContain('normalised to no text');
    }
  });

  it('never invents a company reference or an identity attribute', async () => {
    const assertions = assertionsOf(
      await extract(
        'Ana Jiménez, 52, a director of Inversiones Talamanca, was charged with fraud.',
      ),
    );
    // Companies attach through the FR-02 graph, from the registry. A name lifted out of a
    // sentence is not a company ref, and an age matched by pattern is a guess about which
    // person the document means.
    expect(assertions[0]?.companyRefs).toEqual([]);
    expect(assertions[0]?.identityAttributes).toEqual([]);
  });
});
