/**
 * The search-index seam.
 *
 * **MongoDB is the system of record. The index is derived state.** If the two disagree, MongoDB
 * wins and the index is rebuilt — never the other way round. Everything in this directory
 * follows from that one sentence: the index is a fast way to find things that are already
 * durably recorded, and it is never consulted to decide what is true.
 *
 * Open decision **D12** (OpenSearch vs Meilisearch) is settled by C4's measurement, not by
 * preference and not by inertia. That is the reason this port exists and the reason nothing
 * outside this directory may name a concrete index: if index-specific calls leak into the
 * matcher, into a repository or into a controller, then switching becomes expensive exactly at
 * the moment the measurement tells us to switch — and the decision gets made by the cost of
 * changing rather than by the numbers. Phase A established the same seam in
 * `scripts/bootstrap/search-index.mjs`; this is its application-side half.
 *
 * **Tenant scoping is mandatory in every query.** SEC-01 lists search-index queries explicitly
 * among the places scope must be enforced. The filter is applied here *and* the caller passes a
 * tenant that came from a validated credential — the index filter is defence in depth, never
 * the only control, because an index is a cache and a cache can be stale or wrong.
 */

export const SEARCH_INDEX_PORT = 'SEARCH_INDEX_PORT';

/** The two indexes the service keeps, named as Phase A's bootstrap created them. */
export const SUBJECTS_INDEX = 'subjects';
export const DOCUMENTS_INDEX = 'documents';

/**
 * A subject as the FR-08 matcher needs to find it.
 *
 * The searchable fields are the **derived** name forms, not the raw name: matching happens on
 * folded, sorted-core and phonetic keys, because "José María Solís-Rojas" and "Jose Maria Solis
 * Rojas" are the same person written twice. The original is carried for display only and is
 * never the thing matched on.
 */
export interface SubjectIndexDocument {
  readonly subjectVersionId: string;
  readonly subjectId: string;
  readonly version: number;
  readonly tenantId: string;
  readonly nameOriginal: string;
  readonly nameFolded: string;
  readonly sortedCoreKey: string;
  readonly phoneticKeys: readonly string[];
  readonly aliasesFolded: readonly string[];
  readonly countryContext: readonly string[];
  readonly scripts: readonly string[];
}

/** A source document in the rung-0 local corpus. */
export interface DocumentIndexDocument {
  readonly documentVersionId: string;
  readonly documentId: string;
  readonly tenantId: string;
  readonly title: string;
  readonly text: string;
  readonly publisher: string;
  readonly sourceId: string;
  readonly language: string | null;
  readonly tier: string;
  /** Epoch milliseconds: a numeric field is filterable and sortable in both candidate indexes. */
  readonly publicationDate: number | null;
}

export interface IndexHit<T> {
  readonly document: T;
  /** The index's own relevance figure. Never surfaced to a reviewer as a confidence (FR-11). */
  readonly score: number | null;
}

export interface SearchQuery {
  /** Always required. A query with no tenant is a defect, not a broad search. */
  readonly tenantId: string;
  readonly text: string;
  readonly limit: number;
  readonly filters?: Readonly<Record<string, string | readonly string[]>> | undefined;
}

export interface IndexWriteOutcome {
  readonly indexed: readonly string[];
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
}

export interface SearchIndexPort {
  /** Which implementation is running. Recorded in health output and in C4's measurement. */
  readonly kind: string;

  upsertSubjects(documents: readonly SubjectIndexDocument[]): Promise<IndexWriteOutcome>;
  upsertDocuments(documents: readonly DocumentIndexDocument[]): Promise<IndexWriteOutcome>;

  searchSubjects(query: SearchQuery): Promise<readonly IndexHit<SubjectIndexDocument>[]>;
  searchDocuments(query: SearchQuery): Promise<readonly IndexHit<DocumentIndexDocument>[]>;

  /**
   * Several subject queries in one round trip, results returned positionally.
   *
   * This exists because C4 measured the need for it rather than anticipating it. The FR-08
   * matcher cannot use a single query: retrieving on the raw name alone loses recall as the
   * population grows — 81.9% at a thousand subjects, 67.6% at a hundred thousand — because the
   * top *k* fills with lookalikes before the right person is reached. Retrieving on the
   * expanded name forms holds recall flat at 95.2% across the same range, and that is the
   * matcher's real access pattern: one query per name form, every time.
   *
   * Issued sequentially those forms cost a round trip each (p95 9.37ms). Issued as one batch
   * they cost 5.70ms for identical results — so the sequential version is spending 40% of
   * matcher latency on round trips that buy nothing. See `docs/measurements/c4-search-index.md`.
   *
   * Positional results, not merged: which form produced a hit is evidence the matcher uses to
   * decide what the agreement is worth (FR-08), and merging here would throw that away and make
   * every caller that needs it issue the queries separately again.
   */
  searchSubjectsBatch(
    queries: readonly SearchQuery[],
  ): Promise<readonly (readonly IndexHit<SubjectIndexDocument>[])[]>;

  /**
   * Remove entries by primary key.
   *
   * Not an optimisation: SEC-05 requires deletion and suppression to propagate to indexes as
   * well as to evidence objects and exports. A restricted document that remains searchable is
   * still disclosed, whatever the record says.
   */
  removeSubjects(subjectVersionIds: readonly string[]): Promise<void>;
  removeDocuments(documentVersionIds: readonly string[]): Promise<void>;

  /** Everything for one tenant, for a rebuild or an erasure request. */
  purgeTenant(tenantId: string): Promise<void>;

  healthy(): Promise<boolean>;
}

/**
 * An in-process index, for tests and for a development run with no index container.
 *
 * Deliberately simple-minded — substring matching over the searchable fields — because its job
 * is to prove the *wiring* is right, never to stand in for the real thing. C4 measures the real
 * index; a measurement taken against this would be measuring a `filter()`.
 */
export class InMemorySearchIndex implements SearchIndexPort {
  readonly kind = 'in-memory';

  private readonly subjects = new Map<string, SubjectIndexDocument>();
  private readonly documents = new Map<string, DocumentIndexDocument>();
  /** Set by a test to make writes fail, so the reconciler's path can be exercised. */
  failWrites: string | null = null;

  async upsertSubjects(documents: readonly SubjectIndexDocument[]): Promise<IndexWriteOutcome> {
    return Promise.resolve(this.upsert(documents, this.subjects, (d) => d.subjectVersionId));
  }

  async upsertDocuments(documents: readonly DocumentIndexDocument[]): Promise<IndexWriteOutcome> {
    return Promise.resolve(this.upsert(documents, this.documents, (d) => d.documentVersionId));
  }

  private upsert<T>(
    incoming: readonly T[],
    store: Map<string, T>,
    idOf: (value: T) => string,
  ): IndexWriteOutcome {
    if (this.failWrites !== null) {
      return {
        indexed: [],
        failed: incoming.map((d) => ({ id: idOf(d), reason: this.failWrites ?? 'failed' })),
      };
    }
    for (const value of incoming) {
      store.set(idOf(value), value);
    }
    return { indexed: incoming.map(idOf), failed: [] };
  }

  async searchSubjects(query: SearchQuery): Promise<readonly IndexHit<SubjectIndexDocument>[]> {
    const needle = query.text.toLowerCase();
    const hits = [...this.subjects.values()]
      .filter((d) => d.tenantId === query.tenantId)
      .filter(
        (d) =>
          d.nameFolded.includes(needle) ||
          d.nameOriginal.toLowerCase().includes(needle) ||
          d.sortedCoreKey.includes(needle) ||
          d.phoneticKeys.some((k) => k.includes(needle)) ||
          d.aliasesFolded.some((a) => a.includes(needle)),
      )
      .slice(0, query.limit)
      .map((document) => ({ document, score: null }));
    return Promise.resolve(hits);
  }

  async searchSubjectsBatch(
    queries: readonly SearchQuery[],
  ): Promise<readonly (readonly IndexHit<SubjectIndexDocument>[])[]> {
    // No round trip to save in process, so the batch is the loop. The shape still has to match
    // the real adapter exactly — positional, one result list per query — or a test that passes
    // against this one proves nothing about the adapter it stands in for.
    const results: (readonly IndexHit<SubjectIndexDocument>[])[] = [];
    for (const query of queries) {
      results.push(await this.searchSubjects(query));
    }
    return results;
  }

  async searchDocuments(query: SearchQuery): Promise<readonly IndexHit<DocumentIndexDocument>[]> {
    const needle = query.text.toLowerCase();
    const hits = [...this.documents.values()]
      .filter((d) => d.tenantId === query.tenantId)
      .filter(
        (d) =>
          d.title.toLowerCase().includes(needle) ||
          d.text.toLowerCase().includes(needle) ||
          d.publisher.toLowerCase().includes(needle),
      )
      .slice(0, query.limit)
      .map((document) => ({ document, score: null }));
    return Promise.resolve(hits);
  }

  async removeSubjects(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.subjects.delete(id);
    }
    return Promise.resolve();
  }

  async removeDocuments(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.documents.delete(id);
    }
    return Promise.resolve();
  }

  async purgeTenant(tenantId: string): Promise<void> {
    for (const [id, value] of this.subjects) {
      if (value.tenantId === tenantId) {
        this.subjects.delete(id);
      }
    }
    for (const [id, value] of this.documents) {
      if (value.tenantId === tenantId) {
        this.documents.delete(id);
      }
    }
    return Promise.resolve();
  }

  async healthy(): Promise<boolean> {
    return Promise.resolve(true);
  }

  /** Test helper. */
  size(): { subjects: number; documents: number } {
    return { subjects: this.subjects.size, documents: this.documents.size };
  }
}
