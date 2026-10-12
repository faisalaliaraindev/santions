/**
 * A3 — search index bootstrap, behind the `SEARCH_INDEX_KIND` seam.
 *
 * Open decision D12 (OpenSearch vs Meilisearch) is settled by the Phase C matcher-latency
 * workload test, not here. So this module dispatches on `SEARCH_INDEX_KIND` and keeps every
 * index-specific call inside its own implementation. Nothing outside this file knows which
 * index is running.
 *
 * If that looks like premature abstraction: the measurement genuinely may go the other way,
 * and the cost of finding out that index-specific calls have leaked across the codebase is
 * paid at exactly the moment we are trying to change it.
 */

import { log, waitFor } from '../lib/local-guard.mjs';

/**
 * The indexes the service needs.
 *
 * `subjects` backs FR-08 name matching — the searchable fields are the *derived* name forms
 * from `normaliseName`, not the raw name, because matching happens on folded and phonetic
 * keys. `documents` is the FR-05 rung-0 local corpus.
 */
const INDEXES = [
  {
    uid: 'subjects',
    primaryKey: 'subjectVersionId',
    searchable: ['nameFolded', 'nameOriginal', 'aliasesFolded', 'phoneticKeys', 'sortedCoreKey'],
    filterable: ['tenantId', 'countryContext', 'scripts'],
  },
  {
    uid: 'documents',
    primaryKey: 'documentVersionId',
    searchable: ['title', 'text', 'publisher'],
    filterable: ['tenantId', 'sourceId', 'language', 'jurisdiction', 'publicationDate', 'tier'],
  },
];

async function bootstrapMeilisearch() {
  const host = process.env['MEILI_HOST'] ?? 'http://127.0.0.1:28700';
  const key = process.env['MEILI_MASTER_KEY'] ?? '';
  const headers = {
    'Content-Type': 'application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };

  await waitFor(
    'Meilisearch',
    async () => {
      const response = await fetch(`${host}/health`, { headers });
      return response.ok;
    },
    { timeoutMs: 60_000 },
  );

  for (const index of INDEXES) {
    const existing = await fetch(`${host}/indexes/${index.uid}`, { headers });

    if (existing.status === 404) {
      const created = await fetch(`${host}/indexes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ uid: index.uid, primaryKey: index.primaryKey }),
      });
      if (!created.ok) {
        throw new Error(`Could not create index ${index.uid}: ${await created.text()}`);
      }
      log.created(`index ${index.uid} (primary key ${index.primaryKey})`);
    } else if (existing.ok) {
      log.exists(`index ${index.uid}`);
    } else {
      throw new Error(`Unexpected response for index ${index.uid}: ${String(existing.status)}`);
    }

    // Settings are applied every run: idempotent, and it repairs drift.
    const settings = await fetch(`${host}/indexes/${index.uid}/settings`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        searchableAttributes: index.searchable,
        filterableAttributes: index.filterable,
        // Tenant isolation is enforced in the application and in the repository layer
        // (SEC-01). This filter is defence in depth, never the only control.
        distinctAttribute: null,
      }),
    });
    if (!settings.ok) {
      throw new Error(`Could not apply settings to ${index.uid}: ${await settings.text()}`);
    }
  }

  return { kind: 'meilisearch', host, indexes: INDEXES.map((i) => i.uid) };
}

async function bootstrapOpenSearch() {
  // Not implemented. If D12 selects OpenSearch, this is where it lands — and failing loudly
  // is correct until then, rather than silently doing nothing and reporting success.
  throw new Error(
    [
      'SEARCH_INDEX_KIND=opensearch is not implemented.',
      '',
      'Open decision D12 currently carries Meilisearch as a working assumption, settled by the',
      'Phase C matcher-latency workload test. If that test selects OpenSearch, implement',
      'bootstrapOpenSearch() here and add the service to infra/local/docker-compose.yml.',
    ].join('\n'),
  );
}

export async function bootstrapSearchIndex() {
  const kind = process.env['SEARCH_INDEX_KIND'] ?? 'meilisearch';
  log.step(`Search index (${kind})`);

  switch (kind) {
    case 'meilisearch':
      return bootstrapMeilisearch();
    case 'opensearch':
      return bootstrapOpenSearch();
    default:
      throw new Error(
        `Unknown SEARCH_INDEX_KIND "${kind}". Expected "meilisearch" or "opensearch" (see decision D12).`,
      );
  }
}
