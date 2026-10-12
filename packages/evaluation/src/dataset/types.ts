/**
 * FR-16 — the labelled dataset.
 *
 * Split by *entity* and by *syndication family*, never randomly, so the same event cannot
 * appear in both the tuning and held-out sets. Random splitting of a corpus that contains
 * twelve copies of one wire story produces a model that has memorised the story and a recall
 * figure that means nothing.
 */

import type { CaseScenario } from './scenario.js';
import type {
  AdverseCategory,
  AttributionGrade,
  AuthorityTier,
  EvidenceBand,
  ExclusionReason,
  IdentityGrade,
  PartyRole,
  StageValue,
  TenureLabel,
} from '@adverse-search/domain';

export type DatasetSplit = 'TUNING' | 'HELD_OUT';

/** Why this case is in the dataset. Hard negatives are named so coverage can be asserted. */
export const CASE_KINDS = [
  'TRUE_POSITIVE',
  'COMMON_NAME',
  'SPARSE_IDENTITY',
  'PERSON_VS_COMPANY',
  'VICTIM',
  'WITNESS',
  'PLAINTIFF',
  'NAMESAKE_CONTRADICTING_DOB',
  'SYNDICATION_FAMILY',
  'PROCEDURAL_CHANGE_OVER_TIME',
  'CORRECTION',
  'ACQUITTAL',
  'COMPANY_ONLY_EVENT',
  'UNSPECIFIED_ROLE',
  'HIGH_FREQUENCY_NAME',
  'SETTLEMENT_NO_ADMISSION',
] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export interface LabelledDocument {
  readonly documentId: string;
  readonly language: string;
  readonly jurisdiction: string;
  readonly tier: AuthorityTier;
  readonly originatingNewsroomId: string;
  readonly issuingAuthorityId: string | null;
  readonly isSyndicatedCopy: boolean;
  /**
   * The syndication family this document belongs to. Documents sharing a family must never
   * be split across tuning and held-out.
   */
  readonly syndicationFamilyId: string;
  readonly canonicalUrl: string;
  readonly contentHash: string;
  readonly nearDuplicateKey: string | null;
  /** Normalised document text. Spans in assertions index into this exact string. */
  readonly text: string;
}

/** The ground truth a case asserts. Every field is what a careful human reviewer decided. */
export interface CaseLabel {
  readonly identity: IdentityGrade;
  readonly attribution: AttributionGrade;
  readonly category: AdverseCategory | null;
  readonly partyRole: PartyRole;
  readonly proceduralStage: StageValue;
  readonly tenureLabel: TenureLabel;
  readonly band: EvidenceBand;
  readonly independenceCount: number;
  readonly exclusionReason: ExclusionReason | null;
  /** True when the case must be discoverable at all — used for end-to-end recall. */
  readonly discoverable: boolean;
}

export interface LabelledCase {
  readonly caseId: string;
  /** Entity the case is about. Cases sharing an entity never split across sets. */
  readonly entityId: string;
  readonly kinds: readonly CaseKind[];
  readonly subjectName: string;
  readonly language: string;
  readonly jurisdiction: string;
  readonly documents: readonly LabelledDocument[];
  readonly label: CaseLabel;
  /** Free-text note explaining why this case is hard. Shown in failure reports. */
  readonly note: string;
  /** Axis inputs a pipeline would produce for this case, so the harness runs with no I/O. */
  readonly scenario: CaseScenario;
}

export interface LabelledDataset {
  readonly datasetVersion: string;
  readonly cases: readonly LabelledCase[];
}
