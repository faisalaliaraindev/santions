/**
 * A2 — S3 and SQS bootstrap against LocalStack.
 *
 * Idempotent: running it twice is a no-op, not an error.
 *
 * Uses LocalStack's REST surface directly rather than the AWS SDK, so the bootstrap has no
 * production dependency and cannot accidentally be pointed at real AWS by a stray profile.
 *
 * SEC-03 note: creating a private bucket here proves nothing about real AWS. Bucket policy,
 * IAM and KMS are verified against actual AWS at gate G11. This script says so in its output
 * rather than letting a green tick imply otherwise.
 */

import { log, waitFor } from '../lib/local-guard.mjs';

const endpoint = process.env['AWS_ENDPOINT_URL'] ?? 'http://127.0.0.1:28566';
const region = process.env['AWS_REGION'] ?? 'eu-west-2';
const bucket = process.env['S3_EVIDENCE_BUCKET'] ?? 'adverse-search-evidence-local';
const queueName = 'adverse-search-jobs';
const dlqName = 'adverse-search-jobs-dlq';

/**
 * LocalStack accepts unsigned requests, so a static placeholder credential is enough. These
 * are LocalStack's documented dummy values, not a secret.
 */
function awsHeaders(target) {
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=test/20260910/${region}/${target}/aws4_request, SignedHeaders=host, Signature=test`,
    // S3 takes XML bodies; SQS takes form-encoded ones. Sending the wrong content type makes
    // LocalStack ignore the body entirely, which surfaces as a confusing 400 complaining about
    // an "unspecified location constraint" rather than as a parse error.
    'Content-Type': target === 's3' ? 'application/xml' : 'application/x-www-form-urlencoded',
  };
}

async function s3(method, path, body, extraHeaders = {}) {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: { ...awsHeaders('s3'), ...extraHeaders },
    ...(body === undefined ? {} : { body }),
  });
  return response;
}

async function sqs(action, params) {
  const body = new URLSearchParams({ Action: action, Version: '2012-11-05', ...params });
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: awsHeaders('sqs'),
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`SQS ${action} failed (${String(response.status)}): ${text.slice(0, 400)}`);
  }
  return text;
}

function extractTag(xml, tag) {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'u').exec(xml);
  return match?.[1] ?? null;
}

async function ensureBucket() {
  const head = await s3('HEAD', `/${bucket}`);
  if (head.status === 200) {
    log.exists(`s3://${bucket}`);
  } else {
    const created = await s3(
      'PUT',
      `/${bucket}`,
      `<CreateBucketConfiguration><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`,
    );
    if (!created.ok && created.status !== 409) {
      throw new Error(`Could not create bucket ${bucket}: ${String(created.status)}`);
    }
    log.created(`s3://${bucket}`);
  }

  // Public access block. Local emulation only — the real control is verified at G11.
  const block = await s3(
    'PUT',
    `/${bucket}?publicAccessBlock`,
    '<PublicAccessBlockConfiguration>' +
      '<BlockPublicAcls>true</BlockPublicAcls>' +
      '<IgnorePublicAcls>true</IgnorePublicAcls>' +
      '<BlockPublicPolicy>true</BlockPublicPolicy>' +
      '<RestrictPublicBuckets>true</RestrictPublicBuckets>' +
      '</PublicAccessBlockConfiguration>',
  );
  if (block.ok) {
    log.info('public access blocked (local emulation; real AWS policy is verified at G11)');
  } else {
    log.warn(`could not set public access block: ${String(block.status)}`);
  }

  // Versioning, so an evidence object is never silently replaced.
  await s3(
    'PUT',
    `/${bucket}?versioning`,
    '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
  );
  log.info('versioning enabled');
}

async function ensureQueues() {
  // DLQ first: the main queue's redrive policy needs its ARN.
  const dlqXml = await sqs('CreateQueue', { QueueName: dlqName });
  const dlqUrl = extractTag(dlqXml, 'QueueUrl');
  log.created(`queue ${dlqName}`);

  const attrsXml = await sqs('GetQueueAttributes', {
    QueueUrl: dlqUrl,
    'AttributeName.1': 'QueueArn',
  });
  const dlqArn = extractTag(attrsXml, 'Value');
  if (dlqArn === null) {
    throw new Error('Could not read the DLQ ARN; cannot attach a redrive policy.');
  }

  // At-least-once delivery is a given (REL-01), so the application must be idempotent
  // regardless. maxReceiveCount bounds how many times a poison message is retried before it
  // stops consuming worker capacity.
  const redrive = JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 5 });
  const queueXml = await sqs('CreateQueue', {
    QueueName: queueName,
    'Attribute.1.Name': 'RedrivePolicy',
    'Attribute.1.Value': redrive,
    'Attribute.2.Name': 'VisibilityTimeout',
    'Attribute.2.Value': '300',
    'Attribute.3.Name': 'MessageRetentionPeriod',
    'Attribute.3.Value': '345600',
  });
  const queueUrl = extractTag(queueXml, 'QueueUrl');
  log.created(`queue ${queueName} (redrive → ${dlqName}, maxReceiveCount 5)`);

  return { queueUrl, dlqUrl };
}

export async function bootstrapAws() {
  log.step('AWS emulation (S3 + SQS)');

  await waitFor(
    'LocalStack',
    async () => {
      const response = await fetch(`${endpoint}/_localstack/health`);
      if (!response.ok) {
        return false;
      }
      const health = await response.json();
      return health.services?.s3 !== undefined && health.services?.sqs !== undefined;
    },
    { timeoutMs: 90_000 },
  );

  await ensureBucket();
  const queues = await ensureQueues();

  return { bucket, ...queues };
}
