/**
 * FR-09 — party role taxonomy. Extracted explicitly from a span, never defaulted.
 *
 * The default-to-accused failure is the reason this axis exists: a system that treats an
 * unlabelled mention as an accusation will classify victims and witnesses as perpetrators.
 */

export const PARTY_ROLES = [
  'ACCUSED_DEFENDANT_CRIMINAL',
  'CONVICTED_SANCTIONED_PARTY',
  'DEFENDANT_CIVIL',
  'PLAINTIFF_CLAIMANT',
  'VICTIM',
  'WITNESS',
  'INVESTIGATED_NOT_CHARGED',
  'ASSOCIATE_MENTIONED',
  'OFFICIAL_EXPERT_COMMENTATOR',
  'NAMESAKE_DISTINGUISHED',
  'UNSPECIFIED',
] as const;

export type PartyRole = (typeof PARTY_ROLES)[number];

/** Roles that can carry an adverse finding at all. */
const ADVERSE_ROLES: ReadonlySet<PartyRole> = new Set<PartyRole>([
  'ACCUSED_DEFENDANT_CRIMINAL',
  'CONVICTED_SANCTIONED_PARTY',
  'DEFENDANT_CIVIL',
  'INVESTIGATED_NOT_CHARGED',
]);

/**
 * VICTIM and WITNESS are never adverse (FR-09, T17). They are recorded as roles precisely so
 * that they can never be silently reclassified as perpetrators.
 */
const NEVER_ADVERSE_ROLES: ReadonlySet<PartyRole> = new Set<PartyRole>([
  'VICTIM',
  'WITNESS',
  'PLAINTIFF_CLAIMANT',
  'OFFICIAL_EXPERT_COMMENTATOR',
  'NAMESAKE_DISTINGUISHED',
]);

export function isAdverseRole(role: PartyRole): boolean {
  return ADVERSE_ROLES.has(role);
}

export function isNeverAdverseRole(role: PartyRole): boolean {
  return NEVER_ADVERSE_ROLES.has(role);
}

/**
 * NAMESAKE_DISTINGUISHED is a strong contradicting identity signal (FR-09): the document
 * itself has told us this is a different person.
 */
export function isIdentityContradictingRole(role: PartyRole): boolean {
  return role === 'NAMESAKE_DISTINGUISHED';
}

/**
 * FR-09: "No finding advances beyond AMBIGUOUS on an UNSPECIFIED role."
 * Consumed by the banding engine as a hard ceiling.
 */
export function roleCapsBandAtAmbiguous(role: PartyRole): boolean {
  return role === 'UNSPECIFIED';
}

/**
 * Invariant I5 support: a civil matter must never render as a criminal one.
 * Returns the procedural family a role belongs to, for display selection.
 */
export function roleProceduralFamily(
  role: PartyRole,
): 'CRIMINAL' | 'CIVIL' | 'REGULATORY' | 'NONE' {
  switch (role) {
    case 'ACCUSED_DEFENDANT_CRIMINAL':
    case 'CONVICTED_SANCTIONED_PARTY':
      return 'CRIMINAL';
    case 'DEFENDANT_CIVIL':
    case 'PLAINTIFF_CLAIMANT':
      return 'CIVIL';
    case 'INVESTIGATED_NOT_CHARGED':
      return 'REGULATORY';
    default:
      return 'NONE';
  }
}
