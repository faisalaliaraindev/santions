// @vitest-environment node
/**
 * Enforces decision D-001 as a test, not only as a lint rule.
 *
 * The plan requires the control panel and external integrators to invoke the same
 * application services, and forbids a second matching engine in the browser. In a single
 * monorepo a shared build makes that hard to violate by accident. Across two repositories it
 * is only a convention — so it is checked here, where a violation fails CI with an
 * explanation rather than shipping.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

// Resolved from the project root rather than from import.meta.url: the transformed module
// URL is not guaranteed to be a file: URL, and this test walks the real source tree.
const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === 'generated' ? [] : sourceFiles(full);
    }
    return ['.ts', '.tsx'].includes(extname(entry)) ? [full] : [];
  });
}

const FILES = sourceFiles(SRC);

/** Patterns that would mean domain logic had been copied into the browser. */
const FORBIDDEN_IMPORTS = [
  /from\s+['"]@example.com\/adverse-domain/u,
  /from\s+['"]@example.com\/adverse-evaluation/u,
  /from\s+['"][^'"]*\/(?:domain|evaluation)\//u,
];

describe('decision D-001 — no second matching engine in the browser', () => {
  it('finds source files to check', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it.each(FILES.map((f) => [relative(SRC, f), f] as const))(
    '%s does not import the backend domain packages',
    (_relative, file) => {
      const content = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_IMPORTS) {
        expect(
          pattern.test(content),
          `${file} imports backend domain code. Banding, identity resolution and stage logic ` +
            `reach the panel only as API responses (decision D-001).`,
        ).toBe(false);
      }
    },
  );

  it('reaches the service only through the versioned API client', () => {
    // Only the API client itself may call fetch. Everything else goes through it, so that
    // credentials handling, CSRF, idempotency and error typing exist in exactly one place.
    const offenders = FILES.filter((file) => {
      if (file.endsWith(join('lib', 'api', 'client.ts'))) {
        return false;
      }
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) {
        return false;
      }
      return /\bfetch\s*\(/u.test(readFileSync(file, 'utf8'));
    });

    expect(
      offenders,
      'These files call fetch directly instead of using src/lib/api/client.ts.',
    ).toEqual([]);
  });

  it('never renders untrusted evidence as HTML', () => {
    const offenders = FILES.filter(
      (file) =>
        !file.endsWith('boundaries.test.ts') &&
        /dangerouslySetInnerHTML/u.test(readFileSync(file, 'utf8')),
    );
    expect(
      offenders,
      'Publisher content and model output are untrusted (SEC-04). Render them as text.',
    ).toEqual([]);
  });

  it('stores nothing sensitive in browser storage', () => {
    const offenders = FILES.filter(
      (file) =>
        !file.endsWith('boundaries.test.ts') &&
        /\b(?:localStorage|sessionStorage)\s*\./u.test(readFileSync(file, 'utf8')),
    );
    expect(
      offenders,
      'FR-14 forbids sensitive browser storage. Session state lives in the BFF session cookie.',
    ).toEqual([]);
  });
});
