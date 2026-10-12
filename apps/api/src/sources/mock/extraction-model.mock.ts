/**
 * The deterministic mock `ExtractionModelPort`.
 *
 * **Rule-based, and it says so.** `modelId` and `promptVersion` are null, and every assertion
 * it emits carries them as null too. That is not a placeholder for a model id that will arrive
 * later — it is the honest value for an extraction no model participated in, and FR-07's
 * requirement that derived artefacts be labelled cuts both ways: an extraction that names a
 * model it did not use is worse than one that names none.
 *
 * It matches on the supplied subject name forms and on a small keyword table, and it does two
 * things that matter more than the matching.
 *
 * **It emits real spans.** Every claim points at the offsets in the text it came from. A mock
 * that returned plausible-looking assertions with `{start: 0, end: 0}` would let every
 * downstream consumer — the validator, the quotation display, the reviewer view — be built
 * against spans that never had to be right.
 *
 * **It refuses to invent a category.** `enabledCategoryIds` is the closed set; a document whose
 * keywords map to a category the tenant has not enabled produces **no assertion for that
 * category** rather than a nearest-neighbour one. FR-03's enablement is per tenant and per
 * jurisdiction, and a model that rounds to the nearest enabled category turns a disabled
 * category into an enabled one at extraction time.
 */

import {
  fixedMockClock,
  noResults,
  ok,
  type AdapterDescriptor,
  type Clock,
  type MockModeWitness,
  type SourceOutcome,
} from '../source-adapter.js';
import type {
  ExtractedAssertion,
  ExtractionInput,
  ExtractionModelPort,
  TextSpan,
} from '../extraction-model.port.js';
import type { AdverseCategory, PartyRole, StageValue } from '@adverse-search/domain';

export const MOCK_EXTRACTION_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'mock-extraction',
  portKind: 'EXTRACTION_MODEL',
  sourceId: 'src-mock-extraction',
  parserVersion: 'mock-1',
  stabilityClass: 'DOCUMENTED_STABLE',
  mode: 'MOCK',
  jurisdictions: ['CR'],
};

export const MOCK_EXTRACTOR_VERSION = 'mock-rule-extractor-1';

/**
 * Keyword → stage, in Spanish and English.
 *
 * Ordered most-specific first and scanned in order, because "acusación formal" and "acusa"
 * both appear in the same sentence and the first match wins. An unordered map would make the
 * stage depend on object key order, which is a determinism bug that survives review.
 */
const STAGE_KEYWORDS: readonly { readonly term: string; readonly stage: StageValue }[] = [
  { term: 'sentencia condenatoria', stage: 'CONVICTION_FINAL_JUDGMENT' },
  { term: 'acusación formal', stage: 'CHARGE_INDICTMENT' },
  { term: 'formal charges', stage: 'CHARGE_INDICTMENT' },
  { term: 'investigación', stage: 'INVESTIGATION_OPENED' },
  { term: 'investigation', stage: 'INVESTIGATION_OPENED' },
  { term: 'denuncia', stage: 'COMPLAINT_FILED' },
  { term: 'absolutoria', stage: 'ACQUITTAL_DISMISSAL_OVERTURNED' },
];

/**
 * Keyword → taxonomy category. Only emitted when the tenant has the category enabled.
 *
 * The ids are the **real** `AdverseCategory` values from `@adverse-search/domain`, not a local
 * spelling. An earlier version of this file invented kebab-case ids (`fraud-financial-crime`),
 * which typechecked because `categoryId` is a string and matched nothing because the taxonomy
 * uses `FRAUD_FINANCIAL_CRIME`. Every extraction was silently discarded as "category not
 * enabled" — a mock disagreeing with the domain about its own vocabulary, which no unit test
 * caught because both halves were internally consistent.
 */
const CATEGORY_KEYWORDS: readonly {
  readonly term: string;
  readonly categoryId: AdverseCategory;
}[] = [
  { term: 'fraude', categoryId: 'FRAUD_FINANCIAL_CRIME' },
  { term: 'fraud', categoryId: 'FRAUD_FINANCIAL_CRIME' },
  { term: 'lavado', categoryId: 'MONEY_LAUNDERING_TF' },
  { term: 'cohecho', categoryId: 'BRIBERY_CORRUPTION' },
  { term: 'soborno', categoryId: 'BRIBERY_CORRUPTION' },
];

/** Stage → the party role the text supports. Conservative: never stronger than the stage. */
function roleForStage(stage: StageValue): PartyRole {
  switch (stage) {
    case 'CHARGE_INDICTMENT':
      return 'ACCUSED_DEFENDANT_CRIMINAL';
    case 'CONVICTION_FINAL_JUDGMENT':
      return 'CONVICTED_SANCTIONED_PARTY';
    case 'INVESTIGATION_OPENED':
      return 'INVESTIGATED_NOT_CHARGED';
    default:
      // Named in a document is not a role. UNSPECIFIED is the correct answer far more often
      // than any guess, and the banding engine already knows what to do with it.
      return 'UNSPECIFIED';
  }
}

export class MockExtractionModelAdapter implements ExtractionModelPort {
  readonly descriptor = MOCK_EXTRACTION_DESCRIPTOR;
  /** Null, and truthfully so. See the file header. */
  readonly modelId = null;
  readonly promptVersion = null;

  constructor(
    _witness: MockModeWitness,
    private readonly clock: Clock = fixedMockClock,
  ) {}

  async describeModel(): Promise<{ readonly modelId: string | null; readonly reachable: boolean }> {
    return Promise.resolve({ modelId: null, reachable: true });
  }

  async extract(input: ExtractionInput): Promise<SourceOutcome<readonly ExtractedAssertion[]>> {
    const now = this.clock();
    const haystack = input.text.toLowerCase();

    const mentionSpans = findNameSpans(input.text, input.subjectNameForms);
    if (mentionSpans.length === 0) {
      // The subject is not named in this document. Not a failure, and not an empty document —
      // the extractor read it and found no mention, which is a fact worth recording as such.
      return Promise.resolve(noResults(this.descriptor, now));
    }

    const stageHit = STAGE_KEYWORDS.find((k) => haystack.includes(k.term));
    const categoryHit = CATEGORY_KEYWORDS.find(
      (k) => haystack.includes(k.term) && input.enabledCategoryIds.includes(k.categoryId),
    );

    // No enabled category means no assertion. The document is not reclassified into the
    // nearest enabled category — see the file header.
    if (categoryHit === undefined) {
      return Promise.resolve(noResults(this.descriptor, now));
    }

    const stage: StageValue = stageHit?.stage ?? 'UNSPECIFIED';
    const stageSpan = stageHit === undefined ? null : spanOf(haystack, stageHit.term);
    const conductSpan = spanOf(haystack, categoryHit.term);

    const assertion: ExtractedAssertion = {
      documentId: input.documentId,
      documentVersion: input.documentVersion,
      categoryId: categoryHit.categoryId,
      partyRole: roleForStage(stage),
      proceduralStage: stage,
      namingAuthority: findNamingAuthority(input.text),
      subjectMentionSpans: mentionSpans,
      conductSpan,
      stageSpan,
      // FR-07: four dates, and a missing one stays null. This extractor parses none of them —
      // date parsing is a separate, testable concern and pretending otherwise here would put
      // unverified dates into the assertion that the validator then trusts.
      eventDate: { value: null, precision: 'UNKNOWN' },
      publicationDate: { value: null, precision: 'UNKNOWN' },
      updateDate: { value: null, precision: 'UNKNOWN' },
      companyRefs: [],
      identityAttributes: [],
      language: input.language,
      extractorVersion: MOCK_EXTRACTOR_VERSION,
      modelId: null,
      promptVersion: null,
    };

    return Promise.resolve(ok(this.descriptor, now, [assertion]));
  }
}

/** Every occurrence of every supplied name form, in document order, de-duplicated. */
function findNameSpans(text: string, forms: readonly string[]): readonly TextSpan[] {
  const spans: TextSpan[] = [];
  const haystack = text.toLowerCase();
  for (const form of forms) {
    const needle = form.toLowerCase();
    if (needle.length === 0) {
      continue;
    }
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) {
        break;
      }
      spans.push({ start: at, end: at + needle.length });
      from = at + needle.length;
    }
  }
  return spans
    .toSorted((a, b) => a.start - b.start || a.end - b.end)
    .filter((span, i, all) => i === 0 || all[i - 1]?.start !== span.start);
}

function spanOf(haystack: string, term: string): TextSpan | null {
  const at = haystack.indexOf(term);
  return at === -1 ? null : { start: at, end: at + term.length };
}

/**
 * The naming authority, when the text states one.
 *
 * A tiny fixed list rather than a heuristic. A wrong naming authority is worse than none: FR-11
 * bands partly on who said it, so attributing a blog's claim to a prosecutor's office would
 * raise a band on evidence that does not exist.
 */
const AUTHORITIES: readonly string[] = ['Fiscalía', 'Tribunal', 'Poder Judicial', 'Ministerio'];

function findNamingAuthority(text: string): string | null {
  return AUTHORITIES.find((a) => text.includes(a)) ?? null;
}
