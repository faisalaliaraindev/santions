/**
 * FR-16 — splitting. By entity and by syndication family, never randomly.
 *
 * The split is deterministic (a stable hash of the group key), so the held-out set does not
 * silently change between runs and a recall figure remains comparable across releases.
 */

import type { DatasetSplit, LabelledCase, LabelledDataset } from './types.js';

/** FNV-1a. Small, stable across Node versions, and adequate for bucketing. */
function hash32(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Group cases into leakage-safe units.
 *
 * A group is the transitive closure of "shares an entity" and "shares a syndication family".
 * Two cases about different people that both republish the same wire story must land on the
 * same side of the split, or the held-out figure is measuring memorisation.
 */
export function leakageSafeGroups(cases: readonly LabelledCase[]): readonly (readonly string[])[] {
  const parent = new Map<string, string>();

  const find = (x: string): string => {
    let root = x;
    for (;;) {
      const next = parent.get(root);
      if (next === undefined || next === root) {
        break;
      }
      root = next;
    }
    // Path compression: point every node on the way to the root directly at it.
    let cur = x;
    for (;;) {
      const next = parent.get(cur);
      if (next === undefined || next === cur) {
        break;
      }
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  const union = (a: string, b: string): void => {
    parent.set(a, parent.get(a) ?? a);
    parent.set(b, parent.get(b) ?? b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent.set(rb, ra);
    }
  };

  for (const c of cases) {
    const caseKey = `case:${c.caseId}`;
    union(caseKey, `entity:${c.entityId}`);
    for (const doc of c.documents) {
      union(caseKey, `family:${doc.syndicationFamilyId}`);
    }
  }

  const groups = new Map<string, string[]>();
  for (const c of cases) {
    const root = find(`case:${c.caseId}`);
    const bucket = groups.get(root) ?? [];
    bucket.push(c.caseId);
    groups.set(root, bucket);
  }

  return [...groups.values()].map((ids) => [...ids].sort());
}

export interface SplitResult {
  readonly tuning: readonly LabelledCase[];
  readonly heldOut: readonly LabelledCase[];
  /** Group keys assigned to each side, for the evaluation report. */
  readonly groupCount: number;
}

/**
 * Split a dataset. `heldOutFraction` is applied over *groups*, not cases, so a large
 * syndication family does not skew the ratio.
 */
export function splitDataset(dataset: LabelledDataset, heldOutFraction = 0.4): SplitResult {
  const groups = leakageSafeGroups(dataset.cases);
  const byCaseId = new Map(dataset.cases.map((c) => [c.caseId, c]));

  const tuning: LabelledCase[] = [];
  const heldOut: LabelledCase[] = [];
  const threshold = Math.floor(heldOutFraction * 0xffffffff);

  for (const group of groups) {
    // Hash the sorted group key so the assignment is stable and independent of case order.
    const target = hash32(group.join(',')) < threshold ? heldOut : tuning;
    for (const id of group) {
      const c = byCaseId.get(id);
      /* c8 ignore next 3 -- ids come from the dataset itself */
      if (c) {
        target.push(c);
      }
    }
  }

  return { tuning, heldOut, groupCount: groups.length };
}

/**
 * Assert the split is leakage-free. Called by the evaluation suite: a leak silently inflates
 * every metric downstream of it, so it fails loudly rather than being reported as a warning.
 */
export function assertNoLeakage(split: SplitResult): void {
  const entitiesInTuning = new Set(split.tuning.map((c) => c.entityId));
  const familiesInTuning = new Set(
    split.tuning.flatMap((c) => c.documents.map((d) => d.syndicationFamilyId)),
  );

  const leakedEntities = [
    ...new Set(
      split.heldOut.filter((c) => entitiesInTuning.has(c.entityId)).map((c) => c.entityId),
    ),
  ];
  const leakedFamilies = [
    ...new Set(
      split.heldOut
        .flatMap((c) => c.documents.map((d) => d.syndicationFamilyId))
        .filter((f) => familiesInTuning.has(f)),
    ),
  ];

  if (leakedEntities.length > 0 || leakedFamilies.length > 0) {
    throw new Error(
      `Dataset split leaks across tuning and held-out sets. ` +
        `Entities: [${leakedEntities.join(', ')}]. Syndication families: [${leakedFamilies.join(', ')}].`,
    );
  }
}

export function splitOf(split: SplitResult, caseId: string): DatasetSplit | null {
  if (split.heldOut.some((c) => c.caseId === caseId)) {
    return 'HELD_OUT';
  }
  if (split.tuning.some((c) => c.caseId === caseId)) {
    return 'TUNING';
  }
  return null;
}
