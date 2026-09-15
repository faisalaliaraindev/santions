/**
 * A lead — the only thing discovery is allowed to produce.
 *
 * FR-05: "An unreviewed discovered domain remains a lead." FR-06: "Search snippets and
 * headlines alone remain leads, not supported adverse findings." Those two sentences are why
 * this type exists separately from anything the banding engine can see: a lead is a URL and a
 * headline, and a headline is a claim about an article, not evidence from one.
 *
 * The type therefore carries **no category, no stage and no party role**. Not "they are
 * optional and discovery leaves them null" — they are absent, so that a discovery adapter
 * cannot classify, and the compiler is what enforces it rather than a review comment. FR-06 is
 * explicit that relevance filtering never decides adversity; this is the same rule one layer
 * earlier.
 *
 * Shared by `NewsDiscoveryPort` and `WebDiscoveryPort` because the cascade treats their output
 * identically — rungs 2–6 all feed the same relevance filter and the same fetch gate. The
 * ports differ in how they are *asked*, not in what they return.
 */

import type { CascadeRung, PreciseDate, TaxonomyVersion } from '@erly/adverse-domain';

import type { AdapterProvenance } from './source-adapter.js';

/**
 * The discovery cascade rung this lead came from (FR-05's table).
 *
 * Recorded on the lead, not just on the run, because a lead from rung 0 (the local index of
 * polled publisher feeds) and a lead from rung 5 (SearXNG over a mixed engine set) deserve
 * different treatment downstream, and because rung 7 — "stop and emit coverage state" — is
 * only meaningful if we can say which rungs were actually reached.
 *
 * **Re-exported from the domain package, not redeclared.** The ladder and its failure policies
 * live in `packages/domain/src/planning/cascade.ts`; two structurally identical definitions would
 * typecheck against each other happily and drift the moment one of them gained a rung.
 */
export type { CascadeRung };

export interface Lead {
  /**
   * Deterministic within a run: derived from the canonicalised URL, so the same article found
   * at rung 2 and again at rung 4 is one lead with two sightings rather than two leads. Set by
   * the adapter, because only the adapter knows what it canonicalised.
   */
  readonly leadId: string;
  /** Canonicalised absolute https URL. The fetch gate (FR-06) re-validates; this is not it. */
  readonly url: string;
  readonly title: string;
  /**
   * The snippet exactly as the discovery source returned it, or null when it returned none.
   * Never synthesised from the title: a snippet is what a relevance filter scores, and a
   * fabricated one would be scored as though the source had said it.
   */
  readonly snippet: string | null;
  /** Publisher as the discovery source names it. Resolved to a registry source later. */
  readonly publisher: string;
  readonly publisherDomain: string;
  /**
   * FR-07: four date fields, each with declared precision, and a missing one stays null. This
   * is the publication date as *discovery* reported it — frequently absent from an RSS item
   * and frequently wrong when present, which is why it is re-parsed from the fetched document
   * rather than trusted.
   */
  readonly publishedAt: PreciseDate;
  /** BCP 47 where the source declares one. Null when it does not — never guessed from text. */
  readonly language: string | null;
  readonly rung: CascadeRung;
  /** Which planned query (FR-04) produced this lead. Carried through to the coverage view. */
  readonly queryId: string;
  readonly provenance: AdapterProvenance;
}

/**
 * The run's pinned scope and identity, carried on every discovery query.
 *
 * **Why a discovery adapter needs this at all.** A mock does not — it reads a fixture. A *live*
 * one has to authorise its own poll before it opens a socket, and authorising means checking the
 * run's pinned scope, the pinned taxonomy and the source's approval, exactly as a document fetch
 * does. Without it a live connector would either skip the gate or build a second, weaker copy of
 * it, and the weaker of two paths is the one that eventually gets used for something it should
 * not be (the phase brief's own words).
 *
 * The **pinned** taxonomy, never the currently active one: a run that started an hour ago is
 * still running under what it pinned, and a source enabled since must not retroactively widen it.
 */
export interface DiscoveryRunContext {
  /** The search run, for attribution. An unattributable outbound request is a defect (FR-06). */
  readonly jobId: string;
  readonly subjectId: string;
  /** The run's requested jurisdictions and languages, as pinned. */
  readonly jurisdictions: readonly string[];
  readonly languages: readonly string[];
  readonly taxonomy: TaxonomyVersion;
}

/**
 * What was asked of a discovery adapter.
 *
 * `language` and `country` are separate and both required-or-explicitly-null, because FR-05
 * asks for "Google News RSS per language and edition" — a Spanish-language query on the Costa
 * Rican edition is a different query from a Spanish-language query on the Spanish edition, and
 * folding them together loses the distinction the cascade is built on.
 */
export interface DiscoveryQuery {
  readonly tenantId: string;
  /**
   * The run this query belongs to. Required, and required of mocks too.
   *
   * Required rather than optional because an optional gate context is a gate somebody forgets:
   * a live adapter handed a query with no run would have to choose between refusing (a coverage
   * gap that looks like an outage) and proceeding unauthorised. Mocks ignore it, and that costs
   * them one line.
   */
  readonly run: DiscoveryRunContext;
  /** The FR-04 planned query this executes. Its id ends up on every resulting lead. */
  readonly queryId: string;
  readonly text: string;
  /** BCP 47, or null for a language-neutral query. */
  readonly language: string | null;
  /** ISO 3166-1 alpha-2 edition, or null. Never a region label — see FR-05. */
  readonly country: string | null;
  /** Inclusive ISO date bounds, or null for unbounded. FR-06 treats the window as a gate. */
  readonly window: { readonly from: string; readonly to: string } | null;
  /** Hard cap on returned leads. Exceeding it produces a `BOUNDED` outcome, never a silent cut. */
  readonly limit: number;
}
