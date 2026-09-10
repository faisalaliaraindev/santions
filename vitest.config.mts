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
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['packages/domain/src/**', 'packages/evaluation/src/**'],
      thresholds: { statements: 85, branches: 80, functions: 85, lines: 85 },
    },
  },
});
