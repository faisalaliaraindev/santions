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

import type { CascadeRung, PreciseDate, QueryFamily, TaxonomyVersion } from '@adverse-search/domain';

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
  /**
   * How a metasearch source found this lead, when one did. Absent for every other connector.
   *
   * See `DiscoveryAttribution`. It is optional because most discovery sources are the publisher
   * themselves — an SEC feed is not "discovered by" anything — and inventing a channel for them
   * would make the field meaningless where it is most likely to be read.
   */
  readonly discovery?: DiscoveryAttribution | undefined;
}

/**
 * The channel a lead came through, as distinct from where the evidence lives.
 *
 * # The distinction this type exists to hold
 *
 * A SearXNG result is **three** different things and collapsing any two of them produces a
 * wrong record:
 *
 * - `discoverySource` — the thing we asked. `searxng-adverse-media`, our own internal service.
 *   It is the registry source, it is what a budget is charged against, and it is **never the
 *   publisher of the evidence**. A finding whose provenance named SearXNG would be a finding
 *   citing a search engine for a fact about a person.
 * - `discoveryEngines` — the upstream engines that surfaced it. `GOOGLE_NEWS`, `BING_NEWS` and
 *   the rest. These are **channels**, not authorities: that Bing returned an article is not
 *   evidence about the article's subject, and four engines returning the same article is one
 *   article rather than four confirmations (FR-10, and §13 of the milestone brief).
 * - the publisher — `Lead.publisher` and `Lead.publisherDomain`, resolved from the article's own
 *   URL. That is the only one of the three that can ever support a finding, and it only does so
 *   after the document itself has been fetched through the gate and read.
 *
 * # Why the engines are a list
 *
 * SearXNG merges results: one Reuters URL returned by Google, Brave and Bing arrives as **one**
 * result carrying `engines: ["google news", "brave.news", "bing news"]`. Keeping all three is
 * what makes "found by three engines" expressible without it becoming three candidates, three
 * fetches and three findings. Dropping to a single engine would lose the attribution; splitting
 * into three leads would manufacture independence the run does not have.
 */
export interface DiscoveryAttribution {
  /** The registry source id of the discovery service. Never the publisher. */
  readonly discoverySource: string;
  /**
   * Every engine that surfaced this URL, deduplicated and sorted.
   *
   * Sorted so that the same set found in a different order is the same value — the record is
   * compared in tests and read by a reviewer, and an order that depends on which engine answered
   * first is noise in both.
   */
  readonly discoveryEngines: readonly string[];
  /**
   * The relevance score the discovery service assigned, or null.
   *
   * Carried because it is what the source said, and **read by nothing**. It is a metasearch
   * instance's opinion about ranking, which is not evidence about a person and is not allowed to
   * become one: FR-06 is explicit that relevance filtering never decides adversity.
   */
  readonly discoveryScore: number | null;
  /** The category the discovery service assigned the result, as it named it. Null when absent. */
  readonly discoveryCategory: string | null;
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
  /**
   * **LOCAL DIAGNOSTIC ONLY.** Engines this run asked to execute beyond the tenant's resolved
   * set. Only the metasearch connector reads it, and only after re-checking its own process's
   * environment (`sources/searxng/local-diagnostic.ts`). Absent on every normal run.
   */
  readonly diagnosticEngines?: readonly string[] | undefined;
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
  /** The FR-04 family this query came from. Fixed feeds use it to avoid non-name polls. */
  readonly family: QueryFamily;
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
