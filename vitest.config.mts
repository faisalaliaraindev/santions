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
        //
        // A suite here that runs a worker in a **different mode** from its neighbours must use
        // its own queue: a live worker handed a fixture search refuses every source and returns
        // zero findings, failing the mock suite for a reason that is in the live one. Every suite
        // in `tests/e2e` now creates and polls its own queue — see `tests/e2e/support/queues.ts`.
        //
        // **`fileParallelism: false` is the other half of that isolation, and it is not a
        // workaround for flakiness.**
        //
        // Per-suite queues stop a *consumer* crossing. They cannot stop a *producer* crossing,
        // because these suites share one database and therefore one `outboxEvents` collection.
        // `OutboxPublisher.publishOnce` claims whatever is due — it has no deployment filter, and
        // it is right not to have one: in production many API instances publish from one outbox
        // into one queue, which is exactly how horizontal scaling works. What cannot happen in
        // production is several instances sharing an outbox while each holds a *different*
        // `JOBS_QUEUE_URL`. Run these files concurrently and that is precisely the arrangement:
        // the indexed suite's publisher picks up a mock suite's `search.queued` event and posts it
        // to the indexed suite's queue, where a LIVE worker takes it, refuses every fixture source
        // (T55) and settles the run in ~600ms with zero findings.
        //
        // That failure names the victim, never the thief — `expected 0 to be greater than 0` in
        // `tenant-onboarding-e2e.test.ts`, or a search that never leaves `QUEUED`. It cost two
        // sessions. Running the files one at a time means only one publisher is ever live, so the
        // event and the queue belong to the same suite by construction.
        //
        // Tests *within* a file still run in order, as they always did. The cost is wall clock:
        // roughly 145s serial against roughly 70s concurrent.
        //
        // **The flag lives in the `test:e2e:api` script, not here.** `fileParallelism: false` set
        // on a project is accepted silently and does not take effect — the files still overlap,
        // and the only way to notice is that the summed test time exceeds the wall-clock duration.
        // So `package.json` runs this project with `--no-file-parallelism`, which does. If that
        // flag is ever dropped from the script, this project goes back to crossing its own
        // searches between suites; re-read the paragraphs above before concluding the pipeline
        // broke.
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
        test: {
          name: 'live',
          include: ['tests/live/**/*.test.ts'],
          // The combined acceptance run is its own project below. Excluded here so that arming
          // one live suite does not arm the other: `pnpm test:live` with `SEC_LIVE_E2E` set would
          // otherwise pull in a file that refuses without a different variable, and report that
          // refusal as a failure.
          exclude: ['tests/live/acceptance/**'],
          environment: 'node',
        },
      },
      {
        /**
         * The **combined acceptance** project: nine indexed sources from local snapshots and two
         * SEC discovery sources live, in one run, asserted claim by claim.
         *
         * Separate from `live` for the same reason `live` is separate from everything else — it
         * contacts a real publisher, so nothing may reach it by accident. Two gates: no ordinary
         * command names this project, and the suite refuses without
         * `COMBINED_LIVE_ACCEPTANCE=yes-contact-the-sec`.
         */
        test: {
          name: 'live-acceptance',
          include: ['tests/live/acceptance/**/*.test.ts'],
          environment: 'node',
        },
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
