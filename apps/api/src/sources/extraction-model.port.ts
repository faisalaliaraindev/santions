/**
 * `ExtractionModelPort` — the FR-07 extraction contract.
 *
 * The seam between normalised document text and a structured assertion. It is a port for a
 * reason beyond substitutability: D7 (which model) is **open**, and Phase F closes it by
 * benchmarking candidates against the labelled set. A benchmark can only compare candidates
 * that are interchangeable, so the interchangeable shape has to exist before the benchmark is
 * written. A model reached directly from an extraction service would decide D7 by making the
 * comparison expensive.
 *
 * **The rule this port exists to enforce:** an extraction is a *derived* artefact, and derived
 * artefacts must be labelled and reproducible. FR-07 requires the model id and prompt version
 * pinned on every assertion the model produced; both are required fields of
 * `ExtractedAssertion`, not optional ones, so an unattributable extraction does not type-check.
 * Historical searches have to explain themselves under the version they ran, and an assertion
 * whose model is unknown cannot.
 *
 * **Spans, not restatements.** Every claim points back into the normalised text by offset —
 * `subjectMentionSpans`, `conductSpan`, `stageSpan`. The model does not get to say "he was
 * charged"; it says "characters 402–431 assert a charge". A restatement with no span cannot be
 * checked by a reviewer and cannot be checked by the validator either, which is the whole
 * reason FR-07's validation rules can reject an assertion at all.
 *
 * **No adapter here is written in Phase D.** The mock is deterministic and rule-based; Phase E
 * wires a real extractor and Phase F chooses the model.
 */

import type { PartyRole, PreciseDate, StageValue } from '@adverse-search/domain';

import type { AdapterDescriptor, SourceOutcome } from './source-adapter.js';

export const EXTRACTION_MODEL_PORT = 'EXTRACTION_MODEL_PORT';

/** A half-open character range in the **normalised** text, never in the original HTML. */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/** The document as extraction sees it: normalised text plus what it was derived from. */
export interface ExtractionInput {
  readonly documentId: string;
  readonly documentVersion: number;
  /** Normalised text, with the offset mapping back to the original held by the caller. */
  readonly text: string;
  /** Language as retrieved, per FR-07. Null when the source declared none. */
  readonly language: string | null;
  /** The name forms to look for. Supplied, not inferred — FR-08 owns name derivation. */
  readonly subjectNameForms: readonly string[];
  /**
   * The taxonomy version this extraction runs under. Required: a category assigned under an
   * unnamed taxonomy cannot be re-explained later, which FR-03's version pinning forbids.
   */
  readonly taxonomyVersionId: string;
  /** Category ids the tenant has enabled. The model may not return one outside this set. */
  readonly enabledCategoryIds: readonly string[];
}

/**
 * FR-07's assertion, as the model produces it.
 *
 * `validationResult` is deliberately **not** here. The model does not get to declare its own
 * output valid; FR-07's validation rules are applied by the caller after the fact, and a model
 * that could self-certify would make the rules advisory.
 */
export interface ExtractedAssertion {
  readonly documentId: string;
  readonly documentVersion: number;
  /** A category id from `enabledCategoryIds`. Never a free-text label. */
  readonly categoryId: string;
  readonly partyRole: PartyRole;
  readonly proceduralStage: StageValue;
  /** The body that made the statement, as named in the text. Null when the text names none. */
  readonly namingAuthority: string | null;
  readonly subjectMentionSpans: readonly TextSpan[];
  /** Where the conduct is asserted. Null when the document reports no conduct at all. */
  readonly conductSpan: TextSpan | null;
  /** Where the procedural stage is asserted. Null when the stage is `UNSPECIFIED`. */
  readonly stageSpan: TextSpan | null;
  readonly eventDate: PreciseDate;
  readonly publicationDate: PreciseDate;
  readonly updateDate: PreciseDate;
  readonly companyRefs: readonly string[];
  /** Identity attributes the text itself states — an age, a role, a town. Never inferred. */
  readonly identityAttributes: readonly { readonly kind: string; readonly value: string }[];
  readonly language: string | null;
  /** The rule-based extractor's version. Always present, model or not. */
  readonly extractorVersion: string;
  /** FR-07: pinned. Null only for a purely rule-based extraction, which must say so. */
  readonly modelId: string | null;
  readonly promptVersion: string | null;
}

export interface ExtractionModelPort {
  readonly descriptor: AdapterDescriptor;
  /** The model this adapter calls, or null when the extraction is purely rule-based. */
  readonly modelId: string | null;
  readonly promptVersion: string | null;

  extract(input: ExtractionInput): Promise<SourceOutcome<readonly ExtractedAssertion[]>>;

  /**
   * Whether the model endpoint is reachable and is the pinned version.
   *
   * FR-05 forbids runtime administration from pointing at unapproved model endpoints, and D7
   * is still open — so "which model actually answered" is a question the system must be able
   * to ask at runtime, not one answered by the configuration file's intent.
   */
  describeModel(): Promise<{ readonly modelId: string | null; readonly reachable: boolean }>;
}
