/**
 * FR-08 Axis D — source authority and independence.
 *
 * Two separate things that are commonly conflated:
 *  - *Authority* describes how much weight a publisher carries for the reported act.
 *  - *Independence* is a count of distinct originating newsrooms plus distinct Tier 1
 *    authorities. It is computed after clustering, and syndicated copies never raise it
 *    (invariant I6). Ten copies of one wire story are one independent report.
 *
 * Neither ever raises Axis A (invariant I1). A prestigious newspaper reporting about
 * someone with the subject's name has not established that it is the subject.
 */

export type AuthorityTier = 1 | 2 | 3 | 4 | 5;

export interface AuthorityTierDefinition {
  readonly tier: AuthorityTier;
  readonly label: string;
  readonly description: string;
  /** Whether a document at this tier can contribute to the independence count. */
  readonly countsTowardIndependence: boolean;
  /** Whether a document at this tier can support a finding at all, or is a lead only. */
  readonly canSupportFinding: boolean;
}

export const AUTHORITY_TIERS: readonly AuthorityTierDefinition[] = [
  {
    tier: 1,
    label: 'Issuing authority',
    description:
      'Judgment, docket, charging document, decision notice or official designation, published by the body that issued it.',
    countsTowardIndependence: true,
    canSupportFinding: true,
  },
  {
    tier: 2,
    label: 'Established news organisation',
    description: 'Named masthead with an editorial standard and a published corrections policy.',
    countsTowardIndependence: true,
    canSupportFinding: true,
  },
  {
    tier: 3,
    label: 'Local, regional or specialist trade press',
    description: 'Narrower reach, often the only outlet covering a local matter.',
    countsTowardIndependence: true,
    canSupportFinding: true,
  },
  {
    tier: 4,
    label: 'Aggregator, syndicated copy, wire or translation',
    description:
      'Provenance only. Never independent corroboration — the copy adds distribution, not verification.',
    countsTowardIndependence: false,
    canSupportFinding: true,
  },
  {
    tier: 5,
    label: 'Blog, forum, user-generated or unattributed',
    description: 'Lead only. Never a supported finding.',
    countsTowardIndependence: false,
    canSupportFinding: false,
  },
];

const BY_TIER = new Map<AuthorityTier, AuthorityTierDefinition>(
  AUTHORITY_TIERS.map((d) => [d.tier, d]),
);

export function tierDefinition(tier: AuthorityTier): AuthorityTierDefinition {
  const def = BY_TIER.get(tier);
  /* c8 ignore next 3 -- unreachable while AuthorityTier is a closed union */
  if (!def) {
    throw new Error(`Unknown authority tier: ${String(tier)}`);
  }
  return def;
}

/** One document's contribution to Axis D, after clustering has run. */
export interface ClusteredSource {
  readonly documentId: string;
  readonly tier: AuthorityTier;
  /**
   * Stable identifier for the newsroom that *originated* the story. Syndicated copies of one
   * wire report all share the originating newsroom of the wire.
   */
  readonly originatingNewsroomId: string;
  /** For Tier 1, the authority that issued the document, e.g. a specific court or regulator. */
  readonly issuingAuthorityId: string | null;
  /** True when this document is a syndicated or translated copy of another. */
  readonly isSyndicatedCopy: boolean;
}

export interface AxisDResult {
  /** Distinct originating newsrooms plus distinct Tier 1 authorities. */
  readonly independenceCount: number;
  /** Highest authority tier present in the cluster (numerically lowest tier number). */
  readonly bestTier: AuthorityTier;
  readonly distinctNewsrooms: readonly string[];
  readonly distinctTier1Authorities: readonly string[];
  /** Documents excluded from the count, with the reason, for reviewer display. */
  readonly excludedFromCount: readonly { readonly documentId: string; readonly reason: string }[];
}

/**
 * Compute independence over a clustered event.
 *
 * Deliberately counts newsrooms and authorities, not domains and not URLs: one newsroom
 * publishing across five regional domains is one independent report, and one story
 * republished under five URLs is one report.
 */
export function computeAuthority(sources: readonly ClusteredSource[]): AxisDResult {
  const newsrooms = new Set<string>();
  const authorities = new Set<string>();
  const excluded: { documentId: string; reason: string }[] = [];
  let bestTier: AuthorityTier = 5;

  for (const source of sources) {
    if (source.tier < bestTier) {
      bestTier = source.tier;
    }

    const def = tierDefinition(source.tier);

    if (source.isSyndicatedCopy) {
      excluded.push({
        documentId: source.documentId,
        reason: 'Syndicated or translated copy; provenance only (invariant I6).',
      });
      continue;
    }

    if (!def.countsTowardIndependence) {
      excluded.push({
        documentId: source.documentId,
        reason: `Tier ${String(source.tier)} (${def.label}) does not contribute independent corroboration.`,
      });
      continue;
    }

    if (source.tier === 1 && source.issuingAuthorityId !== null) {
      authorities.add(source.issuingAuthorityId);
    } else {
      newsrooms.add(source.originatingNewsroomId);
    }
  }

  return {
    independenceCount: newsrooms.size + authorities.size,
    bestTier,
    distinctNewsrooms: [...newsrooms].sort(),
    distinctTier1Authorities: [...authorities].sort(),
    excludedFromCount: excluded,
  };
}

/** FR-11: CORROBORATED requires one Tier 1, or two independent Tier 2-3. */
export function meetsCorroboratedAuthority(result: AxisDResult): boolean {
  if (result.distinctTier1Authorities.length >= 1) {
    return true;
  }
  return result.bestTier <= 3 && result.independenceCount >= 2;
}

/** FR-11: SUPPORTED and COMPANY_CONTEXT require Tier 1-3. */
export function meetsSupportedAuthority(result: AxisDResult): boolean {
  return result.bestTier <= 3;
}
