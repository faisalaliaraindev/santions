/**
 * Building the URL a discovery connector reads — shared by every one of them.
 *
 * # Why this is not inside each adapter
 *
 * It contains a security rule, and a security rule that exists in two places is a security rule
 * that eventually disagrees with itself. **The query is set as one search parameter on the
 * recorded endpoint, never spliced into a string**: the registry records the parameter's *name*,
 * this parses the recorded URL, sets that one parameter, and serialises. A query therefore cannot
 * introduce a path segment, a host, a scheme, or a second parameter — not because the escaping is
 * careful, but because `URL` does the assembling.
 *
 * The second connector to need this was GDELT. Copying twenty lines would have been quicker and
 * would have produced exactly the "weaker of two paths" the phase brief warns about.
 *
 * # What the registry decides, and what this does
 *
 * - `endpointUrl` — the address, which an approver signed (**D-043**). A connector never invents
 *   one, and a source recording none is refused rather than guessed at.
 * - `endpointKind` — `FIXED_FEED` is polled whole and matched locally; `QUERY_FEED` takes the
 *   query as a parameter, so every planned query is a separate request. The difference is the
 *   **rate**, which is why it is recorded rather than inferred.
 * - `queryParam` — the parameter's name, for a `QUERY_FEED`.
 *
 * The result is screened by `screenUrl` here as well as at the gate, because this is the one URL
 * in the system assembled from two sources rather than taken whole.
 */

import { screenUrl } from '@erly/adverse-domain';

import type { ActiveSourceVersion } from '../source-version.service.js';

export type EndpointResult =
  | { readonly kind: 'URL'; readonly url: string }
  | { readonly kind: 'REFUSED'; readonly detail: string };

/**
 * The URL to read for this source and this query text.
 *
 * `queryText` is ignored for a `FIXED_FEED` — the publisher maintains the list and the planned
 * query is matched against what comes back.
 */
export function buildEndpoint(
  version: ActiveSourceVersion,
  queryText: string,
  extraParams: Readonly<Record<string, string>> = {},
): EndpointResult {
  if (version.endpointUrl === null) {
    return {
      kind: 'REFUSED',
      detail:
        `${version.sourceName} records no endpoint, so there is no address to read. A connector ` +
        `never invents one — the address is part of what an approver signed (D-043).`,
    };
  }

  let url: URL;
  try {
    url = new URL(version.endpointUrl);
  } catch {
    return {
      kind: 'REFUSED',
      detail: `${version.sourceName} records an endpoint that is not a URL.`,
    };
  }

  if (version.endpointKind === 'QUERY_FEED') {
    if (version.queryParam === null) {
      return {
        kind: 'REFUSED',
        detail:
          `${version.sourceName} is recorded as a QUERY_FEED and names no query parameter, so ` +
          `this connector would have to guess where the query goes. A guess aimed at a third ` +
          `party's server is not one worth making.`,
      };
    }
    url.searchParams.set(version.queryParam, queryText);
  }

  // Parameters the connector itself requires — GDELT's `mode` and `format`, for instance. Set
  // after the query so a recorded endpoint cannot be made to override them, and never used to
  // carry anything a caller supplied.
  for (const [name, value] of Object.entries(extraParams)) {
    url.searchParams.set(name, value);
  }

  const screening = screenUrl(url.toString());
  if (!screening.allowed) {
    return {
      kind: 'REFUSED',
      detail:
        `The endpoint built for ${version.sourceName} was refused by the SEC-02 address policy ` +
        `(${screening.rejection ?? 'REJECTED'}): ${screening.detail ?? url.toString()}`,
    };
  }

  return { kind: 'URL', url: url.toString() };
}
