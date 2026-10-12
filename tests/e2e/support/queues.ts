/**
 * The queue an end-to-end suite runs on — one per suite, never the stack's own.
 *
 * # Why this file exists
 *
 * A worker consumes from a queue. It does not, and cannot, ask whether the message it just took
 * was addressed to it. So any second consumer on the same queue is a thief, and the theft is
 * silent: the message is gone, the suite that published it polls its search until the timeout,
 * and the failure it reports (`expected 0 to be greater than 0`, or a run that settled `FAILED`
 * in 130ms) describes the *victim* rather than the thief.
 *
 * Two thieves have actually cost sessions here:
 *
 * 1. **A long-running `pnpm dev` stack.** It polls `adverse-search-jobs` — the value in `.env` —
 *    for as long as a developer leaves it open, in whatever mode `.env` names, running whatever
 *    code was on disk when it booted. On 2026-09-21 it was a **live** worker holding a
 *    pre-refactor build, and it took messages from the mock e2e suites: a live worker handed a
 *    fixture search refuses every source (T55) and returns zero findings. Three separate symptoms
 *    were investigated as pipeline defects before the running process was noticed.
 * 2. **Another e2e suite.** `indexed-adverse-search-e2e.test.ts` runs a *live-mode* worker where
 *    its neighbours run mock-mode ones, so it took its own queue first; this file generalises
 *    what it did rather than leaving the other two suites to rediscover it.
 *
 * # Why a separate queue rather than stopping the dev stack
 *
 * Because "remember to stop `pnpm dev`" is a rule enforced by nobody, and its failure mode is a
 * misleading test result rather than an error. Isolation makes the hazard unreachable instead of
 * merely documented. It costs one idempotent `CreateQueue` per suite.
 *
 * This is **not** a claim that production should shard its queue by consumer. There, one queue
 * and many workers is right — precisely because every worker there runs the same mode and the
 * same build. Two modes over one queue is the thing that does not happen in production, so the
 * fix belongs here rather than in the queue design.
 *
 * # Why the generic `JOBS_QUEUE_URL` is deliberately not consulted
 *
 * A suite that falls back to `process.env['JOBS_QUEUE_URL']` rejoins the shared queue the moment
 * anything exports it — a shell that sourced `.env`, a CI job setting it for the integration
 * suite. The isolation would then be undone by an environment variable nobody meant to aim at
 * these tests. Each suite reads **its own** variable and nothing else, so an override has to name
 * the suite it is overriding.
 */

/** Where LocalStack answers, and the credentials it accepts (any, but they must be present). */
interface SqsEndpoint {
  readonly endpointUrl: string;
  readonly region: string;
  readonly accessKeyId: string;
}

/**
 * The URL of a suite-owned queue, honouring `overrideEnvVar` when it is set.
 *
 * `queueName` is the suite's own name and must be unique across `tests/e2e` — two suites sharing
 * a name is the bug this module exists to prevent, wearing a different hat.
 */
export function suiteQueueUrl(
  endpoint: SqsEndpoint,
  queueName: string,
  overrideEnvVar: string,
): string {
  const override = process.env[overrideEnvVar];
  if (override !== undefined && override.trim() !== '') {
    return override;
  }
  return `${endpoint.endpointUrl.replace(/\/$/u, '')}/000000000000/${queueName}`;
}

/**
 * Create the queue over the SQS query API. Returns normally when it already exists.
 *
 * Driven over the query API rather than the AWS SDK because the SDK is a dependency of
 * `apps/api`, not of the test workspace, and `scripts/bootstrap/aws.mjs` already creates the
 * stack's queues exactly this way. Called from `beforeAll`: a queue the test cannot run without
 * is part of the test's setup, not a step somebody has to remember.
 */
export async function createQueue(endpoint: SqsEndpoint, name: string): Promise<void> {
  const response = await fetch(endpoint.endpointUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization:
        `AWS4-HMAC-SHA256 Credential=${endpoint.accessKeyId}/20260921/` +
        `${endpoint.region}/sqs/aws4_request, SignedHeaders=host, Signature=local`,
    },
    body: new URLSearchParams({
      Action: 'CreateQueue',
      Version: '2012-11-05',
      QueueName: name,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `Could not create the SQS queue ${name}: HTTP ${String(response.status)} ` +
        `${await response.text()}. Is the local stack running?`,
    );
  }
}

/**
 * Both queues a suite needs: the one its worker polls, and the one its failures land in.
 *
 * The dead letter queue is per-suite for the same reason the jobs queue is. It is never consumed
 * by the dev stack, so it is not a theft hazard — but a poisoned fixture message from a test run
 * sitting in the stack's real DLQ is an operator looking at a genuine-looking failure that came
 * from a test, and `pnpm source:health` and the operator views read that queue.
 */
export async function createSuiteQueues(
  endpoint: SqsEndpoint,
  queueName: string,
): Promise<void> {
  await createQueue(endpoint, queueName);
  await createQueue(endpoint, `${queueName}-dlq`);
}
