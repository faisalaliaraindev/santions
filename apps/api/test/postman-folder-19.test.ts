/**
 * Folder 19 — the structure of the final manual acceptance, checked without running it.
 *
 * The folder is the one thing a developer runs by hand against Google, so it must be complete
 * before anyone opens Postman: the right requests in the right order, the normal tenant endpoints
 * (never a special Google one), a guard that stops everything unless armed, every variable either
 * pre-set in the template environment or set by an earlier script, and no placeholder other than
 * the two secrets.
 *
 * The scripts are also **executed** here, against a minimal `pm` sandbox with Postman's own
 * assertion library (chai), on canned responses: the guard must refuse an unarmed environment,
 * and the Google proof must pass on a diagnostic run and fail on a run a stale worker executed.
 * Nothing here opens a socket.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script as VmScript, runInNewContext } from 'node:vm';

import { chai, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const COLLECTION = JSON.parse(
  readFileSync(resolve(ROOT, 'postman/adverse-search-service-full.postman_collection.json'), 'utf8'),
) as Collection;
const TEMPLATE_ENV = JSON.parse(
  readFileSync(resolve(ROOT, 'postman/local.postman_environment.json'), 'utf8'),
) as { values: { key: string; value: string }[] };

const FOLDER_NAME = '19 - Target Platform LIVE Google Diagnostic';

interface Script {
  listen: 'prerequest' | 'test';
  script: { exec: string[] };
}
interface Item {
  name: string;
  event?: Script[];
  item?: Item[];
  request?: {
    method: string;
    url: { raw: string };
    header: { key: string; value: string }[];
    auth?: { type: string; apikey?: { key: string; value: string }[] };
    body?: { raw: string };
  };
}
interface Collection {
  event: Script[];
  item: Item[];
  variable: { key: string }[];
}

const folder = COLLECTION.item.find((item) => item.name === FOLDER_NAME) as Item;
const requests = folder.item ?? [];
const byPrefix = (prefix: string): Item => {
  const found = requests.find((item) => item.name.startsWith(`${prefix} `));
  if (found === undefined) {
    throw new Error(`no request ${prefix}`);
  }
  return found;
};
/** A script as Postman runs it: the body of a function, so a top-level `return` is legal. */
const wrap = (source: string): string =>
  `(function (pm, postman, console, setTimeout) {
${source}
})`;
const scriptOf = (item: { event?: Script[] }, listen: Script['listen']): string =>
  (item.event ?? []).find((event) => event.listen === listen)?.script.exec.join('\n') ?? '';

// ---------------------------------------------------------------------------------------------
// A minimal Postman sandbox
// ---------------------------------------------------------------------------------------------

interface RunResult {
  readonly passed: string[];
  readonly failed: string[];
  readonly nextRequest: string | null | undefined;
  readonly env: Map<string, string>;
  readonly locals: Map<string, string>;
}

function run(
  source: string,
  input: {
    readonly env?: Record<string, string>;
    readonly status?: number;
    readonly json?: unknown;
    readonly requestName?: string;
  } = {},
): RunResult {
  const env = new Map(Object.entries(input.env ?? {}));
  const locals = new Map<string, string>();
  const passed: string[] = [];
  const failed: string[] = [];
  let nextRequest: string | null | undefined;
  const store = (map: Map<string, string>) => ({
    get: (key: string) => map.get(key),
    set: (key: string, value: unknown) => map.set(key, String(value)),
    unset: (key: string) => map.delete(key),
  });
  const pm = {
    environment: store(env),
    variables: store(locals),
    collectionVariables: store(new Map([['baseUrl', 'http://127.0.0.1:3000']])),
    info: { requestName: input.requestName ?? '' },
    request: { url: { getPath: () => '/v1/searches' } },
    response: {
      code: input.status ?? 200,
      json: () => input.json,
      text: () => JSON.stringify(input.json),
    },
    expect: chai.expect,
    test: (name: string, fn: () => void) => {
      try {
        fn();
        passed.push(name);
      } catch (error) {
        failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    execution: { setNextRequest: (name: string | null) => (nextRequest = name) },
  };
  const postman = { setNextRequest: (name: string | null) => (nextRequest = name) };
  const quietConsole = { log: () => undefined };
  // Postman wraps each script in a function, which is why a top-level `return` is legal there.
  const script = runInNewContext(wrap(source), {}) as (...args: unknown[]) => void;
  script(pm, postman, quietConsole, () => undefined);
  return { passed, failed, nextRequest, env, locals };
}

const ARMED = {
  baseUrl: 'http://127.0.0.1:3000',
  googleDiagnosticConfirm: 'yes-run-google-live-local',
  zquenceApiKey: 'asvc_live_abc_def',
  zquenceTenantId: 'tenant-target-platform',
};

// ---------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------

describe('Folder 19 structure', () => {
  it('exists, under its exact name, directly after folder 18', () => {
    expect(folder).toBeDefined();
    const index = COLLECTION.item.findIndex((item) => item.name === FOLDER_NAME);
    expect(COLLECTION.item[index - 1]?.name.startsWith('18 - ')).toBe(true);
  });

  it('runs the acceptance steps in order', () => {
    expect(requests.map((item) => item.name.split(' ')[0])).toEqual([
      '19.0',
      '19.1',
      '19.2a',
      '19.2b',
      '19.3',
      '19.4',
      '19.5',
      '19.6',
      '19.7',
      '19.8',
      '19.9',
      '19.10',
    ]);
  });

  it('uses the normal tenant endpoints, and no special Google endpoint', () => {
    const endpoints = requests.map(
      (item) => `${item.request?.method ?? ''} ${item.request?.url.raw ?? ''}`,
    );
    expect(endpoints).toEqual([
      'GET {{baseUrl}}/auth/session',
      'GET {{baseUrl}}/v1/tenant/discovery/engines',
      'GET {{baseUrl}}/health/ready',
      'GET {{searxngUrl}}/healthz',
      'POST {{baseUrl}}/v1/subjects',
      'POST {{baseUrl}}/v1/searches',
      'GET {{baseUrl}}/v1/searches/{{g19SearchId}}',
      'GET {{baseUrl}}/v1/searches/{{g19SearchId}}/findings',
      'GET {{baseUrl}}/v1/searches/{{g19SearchId}}/findings',
      'GET {{baseUrl}}/v1/searches/{{g19SearchId}}/findings',
      'GET {{baseUrl}}/v1/searches/{{g19SearchId}}/findings',
      'GET {{baseUrl}}/v1/tenant/discovery/engines',
    ]);
    for (const endpoint of endpoints) {
      expect(endpoint.toLowerCase()).not.toContain('google');
    }
  });

  it('sends the diagnostic header on the LIVE search, and nowhere else', () => {
    const search = byPrefix('19.4').request;
    expect(search?.header).toContainEqual(
      expect.objectContaining({ key: 'X-Local-Discovery-Diagnostic', value: 'GOOGLE_NEWS' }),
    );
    expect(search?.body?.raw).toContain('"environment": "live"');
    const others = requests.filter((item) => !item.name.startsWith('19.4 '));
    for (const item of others) {
      expect(
        (item.request?.header ?? []).some(
          (h) => h.key.toLowerCase() === 'x-local-discovery-diagnostic',
        ),
        item.name,
      ).toBe(false);
    }
  });

  it('authenticates every tenant request with the Target Platform key, never the default apiKey', () => {
    for (const item of requests) {
      const auth = item.request?.auth;
      if (item.name.startsWith('19.2')) {
        expect(auth?.type, item.name).toBe('noauth');
        continue;
      }
      expect(auth?.type, item.name).toBe('apikey');
      expect(auth?.apikey?.find((entry) => entry.key === 'value')?.value, item.name).toBe(
        'ApiKey {{zquenceApiKey}}',
      );
    }
  });

  it('every script compiles', () => {
    const scripts = [
      scriptOf(folder, 'prerequest'),
      ...requests.flatMap((item) => [scriptOf(item, 'prerequest'), scriptOf(item, 'test')]),
    ];
    for (const source of scripts) {
      expect(() => new VmScript(wrap(source))).not.toThrow();
    }
  });

  it('every variable is pre-set in the template environment or set by an earlier script', () => {
    const templated = new Set(TEMPLATE_ENV.values.map((value) => value.key));
    const collectionVars = new Set(COLLECTION.variable.map((variable) => variable.key));
    const setByScripts = new Set<string>();
    for (const item of requests) {
      const source = `${scriptOf(item, 'prerequest')}\n${scriptOf(item, 'test')}`;
      for (const match of source.matchAll(
        /pm\.(?:environment|variables)\.set\('([A-Za-z0-9]+)'/g,
      )) {
        setByScripts.add(match[1] ?? '');
      }
    }
    const used = new Set<string>();
    for (const item of requests) {
      const text = JSON.stringify(item.request);
      for (const match of text.matchAll(/\{\{([A-Za-z0-9$]+)\}\}/g)) {
        used.add(match[1] ?? '');
      }
    }
    for (const variable of used) {
      if (variable.startsWith('$')) {
        continue;
      }
      expect(
        templated.has(variable) || collectionVars.has(variable) || setByScripts.has(variable),
        variable,
      ).toBe(true);
    }
  });

  it('the template environment carries every Folder 19 variable; only the two secrets are blank', () => {
    const env = new Map(TEMPLATE_ENV.values.map((value) => [value.key, value.value]));
    expect(env.get('zquenceApiKey')).toBe('');
    expect(env.get('zquenceTenantId')).toBe('');
    expect(env.get('googleDiagnosticConfirm')).toBe('yes-run-google-live-local');
    expect(env.get('googleSubjectName')).toBe('Bernard Madoff');
    expect(env.get('searxngUrl')).toBe('http://127.0.0.1:28888');
    expect(env.get('baseUrl')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('contains no placeholder', () => {
    // The requests themselves: URLs, headers and bodies are complete.
    expect(JSON.stringify(requests.map((item) => item.request))).not.toMatch(
      /CHANGE ME|TODO|FIXME|<[a-z ]+>/i,
    );
    // And no script was left unfinished.
    for (const item of [folder, ...requests]) {
      const source = `${scriptOf(item, 'prerequest')}
${scriptOf(item, 'test')}`;
      expect(source, item.name).not.toMatch(/TODO|FIXME/);
    }
  });

  it('the collection-level key check exempts Folder 19 and nothing else', () => {
    const source = scriptOf(COLLECTION, 'prerequest');
    expect(() => run(source, { requestName: '19.4 Start' })).not.toThrow();
    expect(() => run(source, { requestName: '18.12 Start' })).toThrow(/No apiKey set/);
  });
});

// ---------------------------------------------------------------------------------------------
// Behaviour of the scripts
// ---------------------------------------------------------------------------------------------

describe('Folder 19 guard', () => {
  const guard = scriptOf(folder, 'prerequest');

  it('stops everything unless every value is present', () => {
    // baseUrl is not in this list: an empty environment value falls back to the collection's
    // own local default, and a non-local one is refused by the next test.
    for (const missing of ['googleDiagnosticConfirm', 'zquenceApiKey', 'zquenceTenantId']) {
      const env = { ...ARMED, [missing]: '' };
      expect(() => run(guard, { env }), missing).toThrow(/not armed - nothing was sent/);
    }
  });

  it('requires the exact confirmation value', () => {
    expect(() => run(guard, { env: { ...ARMED, googleDiagnosticConfirm: 'yes' } })).toThrow(
      /yes-run-google-live-local/,
    );
  });

  it('refuses a non-local baseUrl', () => {
    expect(() => run(guard, { env: { ...ARMED, baseUrl: 'https://api.example.com' } })).toThrow(
      /baseUrl must be a local API/,
    );
  });

  it('lets an armed, local run through', () => {
    expect(() => run(guard, { env: ARMED })).not.toThrow();
  });

  it('19.0 stops the folder when the key belongs to another tenant or is not LIVE', () => {
    const source = scriptOf(byPrefix('19.0'), 'test');
    const other = run(source, {
      env: ARMED,
      json: { tenantId: 'tenant-other', environment: 'live' },
    });
    expect(other.nextRequest).toBeNull();
    expect(other.failed.length).toBeGreaterThan(0);
    const sandbox = run(source, {
      env: ARMED,
      json: { tenantId: 'tenant-target-platform', environment: 'sandbox' },
    });
    expect(sandbox.nextRequest).toBeNull();
    const good = run(source, {
      env: ARMED,
      json: { tenantId: 'tenant-target-platform', environment: 'live' },
    });
    expect(good.failed).toEqual([]);
    expect(good.nextRequest).toBeUndefined();
  });

  it('19.3 builds a normal subject body with a stable Target Platform reference and the optional DOB', () => {
    const result = run(scriptOf(byPrefix('19.3'), 'prerequest'), {
      env: { ...ARMED, googleSubjectName: 'Bernard Madoff', googleSubjectDob: '1938-04-29' },
    });
    const body = JSON.parse(result.locals.get('g19SubjectBody') ?? '{}') as Record<string, unknown>;
    expect(body).toEqual({
      fullName: 'Bernard Madoff',
      aliases: [],
      countryContext: ['US'],
      knownCompanies: [],
      externalSubjectRef: 'target-platform-google-diagnostic:bernard-madoff',
      purpose: 'CUSTOMER_ONBOARDING',
      dateOfBirth: { value: '1938-04-29', precision: 'DAY' },
    });
  });
});

const GOOGLE_ROW = {
  engine: 'GOOGLE_NEWS',
  searxngEngineName: 'google news',
  attempted: true,
  outcome: 'RETURNED_RESULTS',
  queriesAttempted: 3,
  queriesReturnedResults: 3,
  queriesFailed: 0,
  durationMs: 1840,
  resultsReturned: 10,
  uniqueResultsContributed: 7,
  failureReasons: [],
  governanceStatus: 'REFUSED',
  decisionId: 'D20',
  diagnosticOverride: true,
  diagnosticOnly: true,
  effectiveEnabled: true,
};

function findingsPage(google: Record<string, unknown>): Record<string, unknown> {
  return {
    mode: 'LIVE',
    execution: 'PARTIAL',
    findingCounts: { total: 1 },
    findings: [
      {
        findingId: 'f-1',
        band: 'B',
        document: {
          url: 'https://www.sec.gov/litigation/litreleases/2009/lr21123.htm',
          publisher: 'SEC',
          mode: 'LIVE',
        },
      },
    ],
    rejectedLeads: [
      {
        url: 'https://www.bloomberg.com/news/articles/madoff',
        publisher: 'bloomberg.com',
        publisherDomain: 'www.bloomberg.com',
        stage: 'FETCH',
        fetchAttempted: false,
        reason:
          'The document was not requested. No approved source record covers www.bloomberg.com, so ...',
        discoveredByEngines: ['GOOGLE_NEWS'],
      },
    ],
    sourceOutcomes: [
      { sourceId: 'ofac-sdn', outcome: 'SUCCEEDED', snapshotVersion: 'v1' },
      { sourceId: 'sec-litigation-releases', outcome: 'SUCCEEDED' },
      { sourceId: 'searxng-adverse-media', outcome: 'PARTIAL' },
    ],
    searxngDiscovery: {
      perEngine: [
        google,
        { engine: 'BING_NEWS', attempted: true, outcome: 'ZERO_RESULTS', durationMs: 900 },
      ],
    },
  };
}

describe('Folder 19 proofs, on canned responses', () => {
  it('19.7 passes on a diagnostic run', () => {
    const result = run(scriptOf(byPrefix('19.7'), 'test'), { json: findingsPage(GOOGLE_ROW) });
    expect(result.failed).toEqual([]);
    expect(result.passed.length).toBeGreaterThanOrEqual(7);
  });

  it('19.7 fails, naming the stale worker, when Google was not overridden', () => {
    const stale = {
      ...GOOGLE_ROW,
      attempted: false,
      outcome: 'DISABLED_BY_POLICY',
      resultsReturned: 0,
      durationMs: 0,
      diagnosticOverride: undefined,
      diagnosticOnly: undefined,
      effectiveEnabled: undefined,
    };
    const result = run(scriptOf(byPrefix('19.7'), 'test'), { json: findingsPage(stale) });
    expect(result.failed.join('\n')).toMatch(/Stop old workers/);
  });

  it('19.8 passes when Google candidates are refused at the publisher gate', () => {
    const result = run(scriptOf(byPrefix('19.8'), 'test'), { json: findingsPage(GOOGLE_ROW) });
    expect(result.failed).toEqual([]);
  });

  it('19.8 fails if Google is recorded as the publisher, or a search URL becomes a finding', () => {
    const page = findingsPage(GOOGLE_ROW) as {
      rejectedLeads: Record<string, unknown>[];
      findings: { document: Record<string, unknown> }[];
    };
    const asPublisher = structuredClone(page);
    asPublisher.rejectedLeads[0] = {
      ...asPublisher.rejectedLeads[0],
      url: 'https://news.google.com/rss/articles/CBMi',
      publisherDomain: 'news.google.com',
    };
    expect(
      run(scriptOf(byPrefix('19.8'), 'test'), { json: asPublisher }).failed.length,
    ).toBeGreaterThan(0);

    const searchFinding = structuredClone(page);
    const first = searchFinding.findings[0];
    if (first !== undefined) {
      first.document['url'] = 'https://www.bing.com/news/search?q=madoff';
    }
    expect(
      run(scriptOf(byPrefix('19.8'), 'test'), { json: searchFinding }).failed.length,
    ).toBeGreaterThan(0);
  });

  it('19.8 fails if an unapproved publisher was contacted', () => {
    const page = findingsPage(GOOGLE_ROW) as { rejectedLeads: Record<string, unknown>[] };
    page.rejectedLeads[0] = { ...page.rejectedLeads[0], fetchAttempted: true };
    expect(run(scriptOf(byPrefix('19.8'), 'test'), { json: page }).failed.length).toBeGreaterThan(
      0,
    );
  });

  it('19.9 passes when indexed and SEC outcomes survive', () => {
    const result = run(scriptOf(byPrefix('19.9'), 'test'), { json: findingsPage(GOOGLE_ROW) });
    expect(result.failed).toEqual([]);
  });

  it('19.10 fails if the Google row changed since 19.1', () => {
    const before = {
      engine: 'GOOGLE_NEWS',
      governanceStatus: 'REFUSED',
      defaultEnabledForDiscovery: false,
      effectiveEnabled: false,
      tenantEnabled: false,
    };
    const source = scriptOf(byPrefix('19.10'), 'test');
    const same = run(source, {
      env: { g19GoogleBefore: JSON.stringify(before) },
      json: { engines: [before] },
    });
    expect(same.failed).toEqual([]);
    const changed = run(source, {
      env: { g19GoogleBefore: JSON.stringify(before) },
      json: { engines: [{ ...before, tenantEnabled: true, configuredByTenant: true }] },
    });
    expect(changed.failed.length).toBeGreaterThan(0);
  });
});
