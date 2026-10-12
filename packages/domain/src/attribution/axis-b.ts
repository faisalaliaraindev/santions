/**
 * FR-08 Axis B — attribution.
 *
 * "Is the subject connected to the entity the document is about, and was the connection
 * live at the time?"
 *
 * Two rules from FR-08 are load-bearing and are enforced here rather than left to callers:
 *  - VIA_ROLE requires the graph to show *exactly one* person held the named role at the
 *    event date, and produces a personal finding at SUPPORTED at most (T73, T74).
 *  - COMPANY_ONLY can never produce a personal adverse finding at any band (invariant I3).
 */

import type { TenureLabel } from '../tenure/tenure.js';

export const ATTRIBUTION_GRADES = [
  'DIRECT_PERSONAL',
  'VIA_ROLE',
  'COMPANY_ONLY',
  'NOT_ESTABLISHED',
] as const;
export type AttributionGrade = (typeof ATTRIBUTION_GRADES)[number];

export interface RoleHolderEvidence {
  /** The role named in the document, e.g. "chief financial officer". */
  readonly roleNamed: string;
  /** Number of people the frozen graph shows holding that role at the event date. */
  readonly holdersAtEventDate: number;
  /** True when the single holder is the subject. Only meaningful when holders === 1. */
  readonly soleHolderIsSubject: boolean;
}

export interface AxisBInput {
  /** The document names the subject personally as a party to the conduct, span-supported. */
  readonly namesSubjectPersonally: boolean;
  /** The document is about a company the subject is associated with in the frozen graph. */
  readonly companyInGraph: boolean;
  readonly tenureLabel: TenureLabel;
  /** Present when the document names a role rather than a person. */
  readonly roleEvidence: RoleHolderEvidence | null;
}

export interface AxisBResult {
  readonly grade: AttributionGrade;
  /** True when the grade rests on an inference, which must be displayed as an inference. */
  readonly isInference: boolean;
  /** Shown verbatim next to the finding when `isInference` is true. */
  readonly inferenceStatement: string | null;
  readonly rationale: readonly string[];
}

/**
 * Tenure labels under which a company event may be attached to the person at all.
 * BEFORE_TENURE and AFTER_TENURE mean the person was not there.
 */
function tenurePermitsPersonalAttribution(label: TenureLabel): boolean {
  return label === 'DURING_TENURE' || label === 'SPANNING';
}

export function gradeAttribution(input: AxisBInput): AxisBResult {
  const rationale: string[] = [];

  if (input.namesSubjectPersonally) {
    rationale.push('The document names the subject personally as a party to the conduct.');
    return { grade: 'DIRECT_PERSONAL', isInference: false, inferenceStatement: null, rationale };
  }

  if (input.roleEvidence !== null) {
    const { roleNamed, holdersAtEventDate, soleHolderIsSubject } = input.roleEvidence;
    if (holdersAtEventDate === 1 && soleHolderIsSubject) {
      if (!tenurePermitsPersonalAttribution(input.tenureLabel)) {
        rationale.push(
          `Role "${roleNamed}" is named, but the tenure label is ${input.tenureLabel}: the subject did not hold it at the event date.`,
        );
        return {
          grade: 'COMPANY_ONLY',
          isInference: false,
          inferenceStatement: null,
          rationale,
        };
      }
      rationale.push(
        `The graph shows exactly one holder of "${roleNamed}" at the event date, and it is the subject.`,
      );
      return {
        grade: 'VIA_ROLE',
        isInference: true,
        inferenceStatement:
          `Inferred: the document names the role "${roleNamed}", not the subject. ` +
          `The sourced association graph shows the subject as the only holder of that role at the event date. ` +
          `This is an inference from the graph, not a statement in the document.`,
        rationale,
      };
    }

    // Two or more holders, or a sole holder who is not the subject: no personal finding.
    rationale.push(
      `Role "${roleNamed}" was held by ${String(holdersAtEventDate)} person(s) at the event date; the role does not identify the subject.`,
    );
    return { grade: 'COMPANY_ONLY', isInference: false, inferenceStatement: null, rationale };
  }

  if (input.companyInGraph) {
    if (!tenurePermitsPersonalAttribution(input.tenureLabel)) {
      rationale.push(
        `Company event outside the subject's tenure (${input.tenureLabel}); company context only.`,
      );
    } else {
      rationale.push(
        'The document concerns an associated company but does not name the subject or a role the subject held.',
      );
    }
    return { grade: 'COMPANY_ONLY', isInference: false, inferenceStatement: null, rationale };
  }

  rationale.push('No sourced connection between the subject and the entity in this document.');
  return { grade: 'NOT_ESTABLISHED', isInference: false, inferenceStatement: null, rationale };
}

/** Invariant I3, expressed as a predicate the banding engine consults. */
export function permitsPersonalFinding(grade: AttributionGrade): boolean {
  return grade === 'DIRECT_PERSONAL' || grade === 'VIA_ROLE';
}
