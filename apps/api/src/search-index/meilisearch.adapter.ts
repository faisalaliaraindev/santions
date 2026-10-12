/**
 * The Meilisearch implementation of `SearchIndexPort`.
 *
 * Meilisearch is the **working assumption**, carried since Phase A because it has the smaller
 * footprint. It is not the decision. D12 closes on C4's measurement, and if that measurement
 * favours OpenSearch then writing `OpenSearchAdapter` next to this file is the whole migration —
 * which is the point of the port.
 *
 * Talks to the HTTP API directly rather than through the official client, for the same reason
 * the bootstrap scripts do: one fewer dependency whose version has to be reconciled with a
 * container image, and a surface small enough that the direct calls are clearer than the
 * wrapper. That trade is the opposite of the one made for SQS, and deliberately so — there the
 * dependency buys SigV4 over a rotating credential, which is a security control; here it would
 * buy a thin wrapper over four endpoints.
 *
 * **Writes are asynchronous in Meilisearch.** Every write returns a task, and the document is
 * not searchable until that task finishes. This adapter therefore does *not* report a write as
 * indexed until it has confirmed the task succeeded — reporting the enqueue as success would
 * mark a document `INDEXED` in MongoDB while it is still invisible to the matcher, which is
 * exactly the silent-clean-result failure that matrix row FI-10 exists to prevent.
 */

import { Injectable, Logger } from '@nestjs/common';

import type {
  DocumentIndexDocument,
  IndexHit,
  IndexWriteOutcome,
  SearchIndexPort,
  SearchQuery,
  SubjectIndexDocument,
} from './search-index.port.js';
import { DOCUMENTS_INDEX, SUBJECTS_INDEX } from './search-index.port.js';

export interface MeilisearchConfig {
  readonly host: string;
  readonly apiKey: string | null;
  /** How long to wait for an enqueued write to become searchable. */
  readonly taskTimeoutMs?: number;
}

interface MeiliTask {
  readonly taskUid: number;
  readonly status?: string;
  readonly error?: { readonly message?: string };
}

const DEFAULT_TASK_TIMEOUT_MS = 10_000;
const TASK_POLL_MS = 25;

@Injectable()
export class MeilisearchAdapter implements SearchIndexPort {
  readonly kind = 'meilisearch';
  private readonly logger = new Logger('MeilisearchIndex');

  constructor(private readonly config: MeilisearchConfig) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      // Ask for an uncompressed response, explicitly.
      //
      // `fetch` sends `Accept-Encoding: gzip, deflate, br` by default, and this is a
      // service-to-service hop carrying small JSON over a local network: compression costs CPU
      // on both ends and saves nothing worth having. It also turned out to cost a great deal
      // more than nothing — C4 measured a **flat ~45ms stall on every gzip-encoded response
      // over roughly one TCP segment** when the stack runs behind the Docker Desktop port
      // proxy (Windows and macOS). The same query answered in ~2ms from inside the Docker
      // network, and in ~3ms from the host with this header set. The stall is the proxy's, not
      // Meilisearch's, but every developer running the local stack pays it on every search,
      // and it is large enough to swamp a latency measurement — which is how C4 found it.
      'Accept-Encoding': 'identity',
      ...(this.config.apiKey === null ? {} : { Authorization: `Bearer ${this.config.apiKey}` }),
    };
  }

  async upsertSubjects(documents: readonly SubjectIndexDocument[]): Promise<IndexWriteOutcome> {
    return this.upsert(SUBJECTS_INDEX, documents, (d) => d.subjectVersionId);
  }

  async upsertDocuments(documents: readonly DocumentIndexDocument[]): Promise<IndexWriteOutcome> {
    return this.upsert(DOCUMENTS_INDEX, documents, (d) => d.documentVersionId);
  }

  private async upsert<T>(
    index: string,
    documents: readonly T[],
    idOf: (value: T) => string,
  ): Promise<IndexWriteOutcome> {
    if (documents.length === 0) {
      return { indexed: [], failed: [] };
    }
    const ids = documents.map(idOf);

    try {
      const response = await fetch(`${this.config.host}/indexes/${index}/documents`, {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify(documents),
      });

      if (!response.ok) {
        const reason = `${String(response.status)}: ${(await response.text()).slice(0, 200)}`;
        return { indexed: [], failed: ids.map((id) => ({ id, reason })) };
      }

      const task = (await response.json()) as MeiliTask;
      const settled = await this.awaitTask(task.taskUid);

      if (settled.status !== 'succeeded') {
        const reason = settled.error?.message ?? `task ${settled.status ?? 'unknown'}`;
        return { indexed: [], failed: ids.map((id) => ({ id, reason })) };
      }

      return { indexed: ids, failed: [] };
    } catch (error) {
      // The index being unreachable is not a failure of the run. The documents are committed;
      // the reconciler will index them when it comes back (FI-10).
      return { indexed: [], failed: ids.map((id) => ({ id, reason: String(error) })) };
    }
  }

  /**
   * Wait for an enqueued write to finish.
   *
   * A timeout is reported as a failure rather than assumed to have succeeded. An optimistic
   * assumption here would mark documents `INDEXED` that the matcher cannot see, and the
   * symptom of that is a screening result with nothing in it.
   */
  private async awaitTask(taskUid: number): Promise<MeiliTask> {
    const deadline = Date.now() + (this.config.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);

    for (;;) {
      const response = await fetch(`${this.config.host}/tasks/${String(taskUid)}`, {
        headers: this.headers(),
      });
      if (response.ok) {
        const task = (await response.json()) as MeiliTask;
        if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'canceled') {
          return task;
        }
      }
      if (Date.now() >= deadline) {
        return { taskUid, status: 'timed-out' };
      }
      await new Promise((resolve) => setTimeout(resolve, TASK_POLL_MS));
    }
  }

  async searchSubjects(query: SearchQuery): Promise<readonly IndexHit<SubjectIndexDocument>[]> {
    return this.search<SubjectIndexDocument>(SUBJECTS_INDEX, query);
  }

  async searchDocuments(query: SearchQuery): Promise<readonly IndexHit<DocumentIndexDocument>[]> {
    return this.search<DocumentIndexDocument>(DOCUMENTS_INDEX, query);
  }

  /**
   * The filter expression for a query.
   *
   * Tenant first, always. SEC-01 names index queries explicitly; this filter is defence in
   * depth behind the caller's validated tenant, never the only control. Built in one place so
   * the batch path cannot drift from the single-query path and quietly lose the tenant clause.
   */
  private filterFor(query: SearchQuery): string {
    const filters = [`tenantId = ${quote(query.tenantId)}`];
    for (const [field, value] of Object.entries(query.filters ?? {})) {
      const values = Array.isArray(value) ? value : [value];
      if (values.length > 0) {
        filters.push(`(${values.map((v) => `${field} = ${quote(String(v))}`).join(' OR ')})`);
      }
    }
    return filters.join(' AND ');
  }

  private async search<T>(index: string, query: SearchQuery): Promise<readonly IndexHit<T>[]> {
    const response = await fetch(`${this.config.host}/indexes/${index}/search`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        q: query.text,
        limit: query.limit,
        filter: this.filterFor(query),
        showRankingScore: true,
      }),
    });

    if (!response.ok) {
      // An index that cannot answer is a coverage problem, not an empty result. Throwing is
      // correct: a caller that swallowed this would report "no matches found" for an outage.
      throw new Error(
        `Search on ${index} failed (${String(response.status)}): ${(await response.text()).slice(0, 200)}`,
      );
    }

    const body = (await response.json()) as {
      hits?: (T & { _rankingScore?: number })[];
    };

    return (body.hits ?? []).map((hit) => {
      const { _rankingScore, ...document } = hit;
      return { document: document as unknown as T, score: _rankingScore ?? null };
    });
  }

  /**
   * Several subject queries in one request, through Meilisearch's `/multi-search`.
   *
   * The whole point is the single round trip, so a failure is one failure for the batch — there
   * is no partial success to report, and throwing matches `search()`: an index that cannot
   * answer is an outage, and returning empty lists would render it as "no matches found".
   */
  async searchSubjectsBatch(
    queries: readonly SearchQuery[],
  ): Promise<readonly (readonly IndexHit<SubjectIndexDocument>[])[]> {
    if (queries.length === 0) {
      return [];
    }

    const response = await fetch(`${this.config.host}/multi-search`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        queries: queries.map((query) => ({
          indexUid: SUBJECTS_INDEX,
          q: query.text,
          limit: query.limit,
          filter: this.filterFor(query),
          showRankingScore: true,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Batch search on ${SUBJECTS_INDEX} failed (${String(response.status)}): ` +
          (await response.text()).slice(0, 200),
      );
    }

    const body = (await response.json()) as {
      results?: { hits?: (SubjectIndexDocument & { _rankingScore?: number })[] }[];
    };
    const results = body.results ?? [];

    // Results are positional, and a caller that pairs form *i* with result *i* would silently
    // mis-attribute every hit if the index ever returned a different number of result sets.
    if (results.length !== queries.length) {
      throw new Error(
        `Batch search returned ${String(results.length)} result sets for ` +
          `${String(queries.length)} queries.`,
      );
    }

    return results.map((result) =>
      (result.hits ?? []).map((hit) => {
        const { _rankingScore, ...document } = hit;
        return { document, score: _rankingScore ?? null };
      }),
    );
  }

  async removeSubjects(ids: readonly string[]): Promise<void> {
    await this.removeFrom(SUBJECTS_INDEX, ids);
  }

  async removeDocuments(ids: readonly string[]): Promise<void> {
    await this.removeFrom(DOCUMENTS_INDEX, ids);
  }

  private async removeFrom(index: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const response = await fetch(`${this.config.host}/indexes/${index}/documents/delete-batch`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(ids),
    });
    if (!response.ok) {
      // Deletion is a rights obligation (SEC-05). A failure here must be loud, because the
      // record will say "restricted" while the index still serves the content.
      throw new Error(
        `Could not remove from ${index} (${String(response.status)}): ` +
          (await response.text()).slice(0, 200),
      );
    }
    const task = (await response.json()) as MeiliTask;
    const settled = await this.awaitTask(task.taskUid);
    if (settled.status !== 'succeeded') {
      throw new Error(
        `Removal from ${index} did not complete: ${settled.error?.message ?? String(settled.status)}`,
      );
    }
  }

  async purgeTenant(tenantId: string): Promise<void> {
    for (const index of [SUBJECTS_INDEX, DOCUMENTS_INDEX]) {
      const response = await fetch(`${this.config.host}/indexes/${index}/documents/delete`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ filter: `tenantId = ${quote(tenantId)}` }),
      });
      if (!response.ok) {
        throw new Error(
          `Could not purge ${index} for tenant (${String(response.status)}): ` +
            (await response.text()).slice(0, 200),
        );
      }
      const task = (await response.json()) as MeiliTask;
      const settled = await this.awaitTask(task.taskUid);
      if (settled.status !== 'succeeded') {
        throw new Error(`Purge of ${index} did not complete: ${String(settled.status)}`);
      }
    }
    this.logger.log('Tenant purged from every index.');
  }

  async healthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.host}/health`, { headers: this.headers() });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Quote a filter value.
 *
 * Meilisearch filter expressions are a query language, so an unescaped value is an injection
 * (SEC-04 names search-query operator injection explicitly). Tenant IDs are internal, but "this
 * value happens to be safe today" is not a reason to build a string unsafely.
 */
function quote(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}
