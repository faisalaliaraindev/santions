/**
 * Folder 20 — the one-endpoint tests, checked without running them.
 *
 * Everything in the folder must go through `POST /v1/screen`: that is the point of the folder, and
 * a request that quietly used `/v1/searches` would be testing a different door. The guard must stop
 * an unarmed run, every variable must be pre-set in the template environment or set by an earlier
 * script, and every script must at least compile. Its behaviour against a running API was checked
 * with newman in the session that added it; nothing here opens a socket.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script as VmScript, runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const COLLECTION = JSON.parse(
  readFileSync(resolve(ROOT, 'postman/erly-adverse-search-full.postman_collection.json'), 'utf8'),
) as { item: Item[] };
const TEMPLATE_ENV = JSON.parse(
  readFileSync(resolve(ROOT, 'postman/local.postman_environment.json'), 'utf8'),
) as { values: { key: string; value: string }[] };

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
    body?: { raw: string };
  };
}

const folder = COLLECTION.item.find((item) => item.name.startsWith('20 - One Endpoint')) as Item;
const requests = folder.item ?? [];
const wrap = (source: string): string => `(function (pm, postman, console) {\n${source}\n})`;
const scriptOf = (item: { event?: Script[] }, listen: Script['listen']): string =>
  (item.event ?? []).find((event) => event.listen === listen)?.script.exec.join('\n') ?? '';

describe('Postman Folder 20 — one endpoint', () => {
  it('exists, with 20.0 to 20.4 in order', () => {
    expect(folder).toBeDefined();
    expect(requests.map((item) => item.name.split(' ')[0])).toEqual([
      '20.0',
      '20.1',
      '20.2',
      '20.3',
      '20.4',
    ]);
  });

  it('sends every request to POST /v1/screen and nowhere else', () => {
    for (const item of requests) {
      expect(item.request?.method, item.name).toBe('POST');
      expect(item.request?.url.raw, item.name).toBe('{{baseUrl}}/v1/screen');
    }
  });

  it('restricts 20.0, 20.2 and 20.3 with `sources`, and leaves 20.1 and 20.4 unrestricted', () => {
    const body = (prefix: string) =>
      requests.find((item) => item.name.startsWith(`${prefix} `))?.request?.body?.raw ?? '';
    expect(body('20.0')).toContain('"sources"');
    expect(body('20.2')).toContain('{{screenCurrentSource}}');
    expect(body('20.3')).toContain('{{screenSource}}');
    expect(body('20.1')).not.toContain('"sources"');
    expect(body('20.4')).not.toContain('"sources"');
  });

  it('carries the Google diagnostic header on 20.4 only', () => {
    const withHeader = requests.filter((item) =>
      (item.request?.header ?? []).some((h) => h.key === 'X-Local-Discovery-Diagnostic'),
    );
    expect(withHeader.map((item) => item.name.split(' ')[0])).toEqual(['20.4']);
  });

  it('pre-sets every folder variable in the template environment', () => {
    const keys = new Set(TEMPLATE_ENV.values.map((value) => value.key));
    for (const key of ['screenConfirm', 'screenName', 'screenEnvironment', 'screenSource']) {
      expect(keys.has(key), key).toBe(true);
    }
    // Not armed by default: nothing is sent until a person sets it.
    expect(TEMPLATE_ENV.values.find((value) => value.key === 'screenConfirm')?.value).toBe('');
  });

  it('compiles every script', () => {
    const sources = [scriptOf(folder, 'prerequest')];
    for (const item of requests) {
      sources.push(scriptOf(item, 'prerequest'), scriptOf(item, 'test'));
    }
    for (const source of sources) {
      expect(() => new VmScript(wrap(source))).not.toThrow();
    }
  });

  it('the guard refuses an unarmed environment and stops the run', () => {
    const env = new Map<string, string>([['baseUrl', 'http://127.0.0.1:3000']]);
    let next: string | null | undefined;
    const pm = {
      environment: {
        get: (key: string) => env.get(key),
        set: (key: string, value: string) => env.set(key, value),
      },
      collectionVariables: { get: () => undefined },
    };
    const postman = { setNextRequest: (name: string | null) => (next = name) };
    const run = runInNewContext(wrap(scriptOf(folder, 'prerequest'))) as (
      ...args: unknown[]
    ) => void;
    expect(() => {
      run(pm, postman, console);
    }).toThrow(/not armed/);
    expect(next).toBeNull();

    env.set('screenConfirm', 'yes-run-one-endpoint');
    expect(() => {
      run(pm, postman, console);
    }).not.toThrow();
  });
});
