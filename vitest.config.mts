import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
          exclude: ['packages/evaluation/test/invariants/**'],
          environment: 'node',
        },
      },
      {
        // Runs the I1-I10 release gate. Must execute with no I/O dependency (section 11).
        test: {
          name: 'invariants',
          include: ['packages/evaluation/test/invariants/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'evaluation',
          include: ['packages/evaluation/test/metrics/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: { name: 'security', include: ['tests/security/**/*.test.ts'], environment: 'node' },
      },
      {
        // The **API** end-to-end suite: in through the HTTP door, out through it, with the real
        // queue and a real worker in between. The browser end-to-end suite is a different thing
        // and belongs to gate G8 — see `tests/e2e/api-lifecycle.test.ts` for why the two are not
        // allowed to stand in for each other.
        test: { name: 'e2e-api', include: ['tests/e2e/**/*.test.ts'], environment: 'node' },
      },
      {
        /**
         * The **live** suite. It contacts real publishers.
         *
         * Its own project, named, and nothing runs it by default: `pnpm verify:local` and CI both
         * enumerate their projects by name and neither names this one. `pnpm test:live` runs it,
         * and the suite itself still refuses without `SEC_LIVE_E2E=yes-contact-the-sec` — two
         * gates, because one of them being wrong would mean a test making requests at somebody
         * else's server.
         */
        test: { name: 'live', include: ['tests/live/**/*.test.ts'], environment: 'node' },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['packages/domain/src/**', 'packages/evaluation/src/**'],
      thresholds: { statements: 85, branches: 80, functions: 85, lines: 85 },
    },
  },
});
