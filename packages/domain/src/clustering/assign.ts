/**
 * FR-10 — turning the pairwise clustering rules into an assignment over a whole run.
 *
 * # Why this file exists
 *
 * `decideClustering` answers "how does this one candidate relate to that one". It was fully
 * implemented, fully unit-tested, and **had no runtime caller at all**: the pipeline built a
 * one-element `ClusteredSource[]` per finding and handed it to `computeAuthority`, so every
 * document in a run was its own independent corroboration. Ten sites carrying one wire story
 * counted as ten independent reports, which is precisely the inflation invariant I6 exists to
 * forbid.
 *
 * This file closes that gap. It is pure: it decides groupings from values it is given. The
 * fingerprints it compares are computed by `near-duplicate.ts`, also pure.
 *
 * # The distinction that matters, and it is not the obvious one
 *
 * There are two separate questions, and collapsing them is the bug most likely to be introduced
 * here by someone tidying up:
 *
 *  - **Is this the same underlying document?** A Reuters story copied by forty sites, one SEC
 *    press release rediscovered through three aggregators, the same page under two URLs. These
 *    are *copies*. They are folded into one finding, the copies retained as provenance, and they
 *    contribute **one** to the independence count.
 *
 *  - **Is this the same underlying event?** An SEC action, a DOJ prosecution, an FCA warning and
 *    an OFAC designation may all concern one person and one course of conduct. They are *not*
 *    copies. Each is an independent authority that reached its own conclusion, each stays a
 *    finding in its own right, and each contributes separately to the independence count.
 *
 * So: copies collapse, independent authorities cluster. Clustering an event together is not a
 * demotion — it is what lets `computeAuthority` see four distinct issuing authorities on one
 * event and band it CORROBORATED. Collapsing them would destroy exactly the corroboration the
 * subject is entitled to have counted.
 *
 * The guard is `isIndependentAuthority` on the candidate. A Tier 1 record from a named issuing
 * authority is never treated as a copy of anything, whatever its text similarity to a press
 * report of the same action — a newswire summarising an SEC order can share a near-duplicate key
 * with the order itself, and suppressing the order would leave the finding resting on the
 * summary.
 */

import {
  decideClustering,
  DEFAULT_EVENT_DATE_WINDOW_DAYS,
  type ClusterCandidate,
  type ClusterDecision,
} from './rules.js';
import { isNearDuplicate } from './near-duplicate.js';

/**
 * A candidate plus the facts the assignment needs that `ClusterCandidate` does not carry.
 */
export interface AssignableCandidate extends ClusterCandidate {
  /**
   * True for a record published by the authority that issued it — an SEC litigation release, a
   * DOJ indictment, an OFAC designation, an FCA warning. Such a record is never suppressed as a
   * duplicate of another source's account of the same action.
   */
  readonly isIndependentAuthority: boolean;
  /**
   * The authority that issued it, for Axis D's distinct-authority count. Null for press.
   */
  readonly issuingAuthorityId: string | null;
  /**
   * SimHash of the document text (`fingerprintText`), or null when the text was too short to
   * fingerprint honestly.
   *
   * Separate from `ClusterCandidate.nearDuplicateKey`, which is an *exact* bucket key and is
   * compared for equality by `decideClustering`. A SimHash is compared by Hamming distance, and a
   * threshold comparison cannot be expressed as key equality — which is why the syndication rule
   * needed a second signal here rather than a cleverer key there.
   */
  readonly nearDuplicateFingerprint?: string | null;
}

export type MembershipReason =
  | 'FIRST_OF_CLUSTER'
  | 'DUPLICATE_DOCUMENT'
  | 'SYNDICATED_COPY'
  | 'SAME_EVENT'
  | 'EVENT_CHAIN_OUTCOME';

export interface ClusterMember {
  readonly documentId: string;
  readonly reason: MembershipReason;
  /** The sentence explaining the relation, kept for the reviewer-facing rationale. */
  readonly detail: string;
  /**
   * True when this document is a copy of another in the cluster and must not appear as its own
   * finding, nor raise the independence count. It is retained as provenance (I6).
   */
  readonly isSuppressedCopy: boolean;
}

export interface AssignedCluster {
  readonly clusterId: string;
  /** Every document assigned here, copies included. */
  readonly members: readonly ClusterMember[];
  /** The documents that remain findings in their own right, in input order. */
  readonly representatives: readonly string[];
}

export interface ClusterAssignment {
  readonly clusters: readonly AssignedCluster[];
  /** documentId -> clusterId, for every input candidate. */
  readonly clusterOf: ReadonlyMap<string, string>;
  /** documentId -> membership, for every input candidate. */
  readonly memberOf: ReadonlyMap<string, ClusterMember>;
}

function reasonFor(decision: ClusterDecision): MembershipReason | null {
  switch (decision.action) {
    case 'MERGE_DOCUMENT':
      return 'DUPLICATE_DOCUMENT';
    case 'MERGE_SYNDICATION_FAMILY':
      return 'SYNDICATED_COPY';
    case 'MERGE_EVENT':
      return 'SAME_EVENT';
    case 'LINK_AS_OUTCOME':
      return 'EVENT_CHAIN_OUTCOME';
    case 'KEEP_SEPARATE':
      return null;
  }
}

/**
 * Assign every candidate in a run to a cluster.
 *
 * Single-pass and greedy: each candidate is compared against the members of each existing
 * cluster in order and joins the first that accepts it. The comparison is against every member
 * rather than a representative, because syndication is transitive in practice — B is recognised
 * as a copy of A, and C may share its near-duplicate key with B rather than with A.
 *
 * Deterministic in input order, which the pipeline fixes by putting indexed-source findings
 * (authority records) before discovery findings. That ordering is load-bearing: the first member
 * of a cluster is the one a copy is recognised against, and an authority record is the right
 * thing to recognise copies against.
 *
 * O(n * members). Runs over one search's findings, which the query-plan cap bounds.
 */
export function assignClusters(
  candidates: readonly AssignableCandidate[],
  windowDays: number = DEFAULT_EVENT_DATE_WINDOW_DAYS,
): ClusterAssignment {
  interface Building {
    readonly clusterId: string;
    readonly candidates: AssignableCandidate[];
    readonly members: ClusterMember[];
  }

  const building: Building[] = [];
  const clusterOf = new Map<string, string>();
  const memberOf = new Map<string, ClusterMember>();

  for (const candidate of candidates) {
    let placed = false;

    for (const cluster of building) {
      let joinReason: MembershipReason | null = null;
      let joinDetail = '';

      for (const existing of cluster.candidates) {
        const decision = decideClustering(existing, candidate, windowDays);
        let reason = reasonFor(decision);
        let detailSource = decision.reason;

        // The fingerprint relation, applied only where the exact rules found nothing stronger.
        // `decideClustering` already returns LINK_AS_OUTCOME before any duplicate test, so an
        // acquittal can never be suppressed here as a near-duplicate of the conviction it
        // reverses (I7) — that ordering is load-bearing and this check must stay behind it.
        if (
          (reason === null || reason === 'SAME_EVENT') &&
          existing.subjectId === candidate.subjectId &&
          decision.action !== 'LINK_AS_OUTCOME' &&
          isNearDuplicate(
            existing.nearDuplicateFingerprint ?? null,
            candidate.nearDuplicateFingerprint ?? null,
          )
        ) {
          reason = 'SYNDICATED_COPY';
          detailSource =
            'Document text fingerprints match within the near-duplicate threshold; this is a ' +
            'copy of text already counted. Retained as provenance and excluded from the ' +
            'independence count (I6).';
        }

        if (reason === null) {
          continue;
        }

        // An independent authority record is never demoted to a copy. If the strongest relation
        // found is "duplicate" or "syndicated", it is re-read as "same event": the two documents
        // do concern one event, and that is what clustering should record — but the authority
        // record keeps its own finding and its own contribution to independence.
        const adjusted =
          candidate.isIndependentAuthority &&
          (reason === 'DUPLICATE_DOCUMENT' || reason === 'SYNDICATED_COPY') &&
          existing.documentId !== candidate.documentId
            ? 'SAME_EVENT'
            : reason;
        const detail =
          adjusted === reason
            ? detailSource
            : `${detailSource} Retained as an independent finding: this record is published ` +
              `by the authority that issued it, so it is provenance in its own right and not a ` +
              `copy of another account of the same action.`;

        // Prefer the most specific relation found against any member: a true duplicate beats a
        // same-event link, because it changes whether the document becomes a finding at all.
        const specificity: Record<MembershipReason, number> = {
          FIRST_OF_CLUSTER: 0,
          EVENT_CHAIN_OUTCOME: 1,
          SAME_EVENT: 2,
          SYNDICATED_COPY: 3,
          DUPLICATE_DOCUMENT: 4,
        };
        if (joinReason === null || specificity[adjusted] > specificity[joinReason]) {
          joinReason = adjusted;
          joinDetail = detail;
        }
      }

      if (joinReason !== null) {
        const member: ClusterMember = {
          documentId: candidate.documentId,
          reason: joinReason,
          detail: joinDetail,
          isSuppressedCopy:
            joinReason === 'DUPLICATE_DOCUMENT' || joinReason === 'SYNDICATED_COPY',
        };
        cluster.candidates.push(candidate);
        cluster.members.push(member);
        clusterOf.set(candidate.documentId, cluster.clusterId);
        memberOf.set(candidate.documentId, member);
        placed = true;
        break;
      }
    }

    if (!placed) {
      const clusterId = `cluster-${String(building.length + 1)}`;
      const member: ClusterMember = {
        documentId: candidate.documentId,
        reason: 'FIRST_OF_CLUSTER',
        detail: 'First document assigned to this event cluster.',
        isSuppressedCopy: false,
      };
      building.push({ clusterId, candidates: [candidate], members: [member] });
      clusterOf.set(candidate.documentId, clusterId);
      memberOf.set(candidate.documentId, member);
    }
  }

  return {
    clusters: building.map((cluster) => ({
      clusterId: cluster.clusterId,
      members: cluster.members,
      representatives: cluster.members
        .filter((member) => !member.isSuppressedCopy)
        .map((member) => member.documentId),
    })),
    clusterOf,
    memberOf,
  };
}
