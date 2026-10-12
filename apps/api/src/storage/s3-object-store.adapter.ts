/**
 * The S3 implementation of `ObjectStorePort`.
 *
 * Uses the AWS SDK, for the same reason `SqsQueueAdapter` does and not for convenience: in
 * production this process authenticates with a rotating role credential (instance role, task
 * role, IRSA), and SigV4 over a rotating credential is a security control that should be used
 * rather than re-implemented. Locally the same code path runs with the endpoint pointed at
 * LocalStack and a static dummy credential. That is the opposite trade from `MeilisearchAdapter`,
 * deliberately — there the dependency would buy a thin wrapper over four unauthenticated
 * endpoints on the local network.
 *
 * **The checksum is S3's, not ours.** Every write sends `ChecksumSHA256` and every read asks for
 * `ChecksumMode: ENABLED`, so the value compared in `EvidenceStagingService` is the one S3
 * computed over the bytes it actually stored. Echoing the caller's own hash back would verify
 * that we can hash a buffer, which was never the risk; the risk is a truncated or corrupted
 * transfer, and only the far end can detect that.
 *
 * `forcePathStyle` is on for LocalStack, where virtual-host addressing would resolve
 * `bucket.localhost` and fail confusingly.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type {
  ListedObject,
  ObjectStorePort,
  PutObjectInput,
  StoredObject,
} from './object-store.port.js';

export interface S3ObjectStoreConfig {
  readonly bucket: string;
  readonly region: string;
  /** Set only for LocalStack. Absent in production, where the real endpoint is derived. */
  readonly endpoint?: string | undefined;
  /** Static credentials for LocalStack only. Production uses the SDK's credential chain. */
  readonly credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
}

@Injectable()
export class S3ObjectStoreAdapter implements ObjectStorePort {
  readonly kind = 's3';
  readonly bucket: string;
  private readonly logger = new Logger('S3ObjectStore');
  private readonly client: S3Client;

  constructor(config: S3ObjectStoreConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      // Both conditional, for the reason the SQS adapter states: passing static credentials in
      // production would override the role credential chain, which is exactly how a long-lived
      // key ends up living in an environment variable.
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint, forcePathStyle: true }),
      ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
      retryMode: 'adaptive',
      maxAttempts: 3,
    });
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const response = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        // S3 verifies this against the bytes it received and rejects the write if it disagrees,
        // so a corrupted upload fails here rather than becoming a stored object we later
        // discover is wrong.
        ChecksumAlgorithm: 'SHA256',
        ChecksumSHA256: input.checksumValue,
      }),
    );

    const checksumValue = response.ChecksumSHA256;
    if (checksumValue === undefined) {
      // Not a warning. Without the store's own checksum there is nothing to verify against, and
      // continuing would commit a reference on the strength of our own arithmetic.
      throw new Error(
        `S3 accepted ${input.key} without returning a SHA-256 checksum, so the stored bytes ` +
          'cannot be verified. Refusing to treat the upload as staged.',
      );
    }

    return {
      bucket: this.bucket,
      key: input.key,
      byteSize: input.body.byteLength,
      contentType: input.contentType,
      checksumAlgorithm: 'SHA256',
      checksumValue,
    };
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: 'ENABLED' }),
      );
      const checksumValue = response.ChecksumSHA256;
      if (checksumValue === undefined) {
        throw new Error(`S3 returned no SHA-256 checksum for ${key}; it cannot be verified.`);
      }
      return {
        bucket: this.bucket,
        key,
        byteSize: response.ContentLength ?? 0,
        contentType: response.ContentType ?? 'application/octet-stream',
        checksumAlgorithm: 'SHA256',
        checksumValue,
      };
    } catch (error) {
      if (isNotFound(error)) {
        // Absent is an answer, not an error — it is precisely the FI-03 question.
        return null;
      }
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (response.Body === undefined) {
        return null;
      }
      return await response.Body.transformToByteArray();
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    // S3 delete is already idempotent — deleting an absent key succeeds — which is what FI-15's
    // sweeper needs, since a retry after a successful-but-unrecorded delete must still close.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string): Promise<readonly ListedObject[]> {
    const out: ListedObject[] = [];
    let continuationToken: string | undefined;

    // Paginated to the end, deliberately. A truncated listing would make the orphan sweep
    // silently skip everything past the first page, and the symptom of that is storage cost
    // rather than an error — so nobody would notice.
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        }),
      );
      for (const item of response.Contents ?? []) {
        if (item.Key !== undefined) {
          out.push({
            key: item.Key,
            byteSize: item.Size ?? 0,
            lastModified: item.LastModified ?? new Date(0),
          });
        }
      }
      continuationToken =
        response.IsTruncated === true ? response.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);

    return out;
  }

  async healthy(): Promise<boolean> {
    try {
      await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
      return true;
    } catch (error) {
      this.logger.warn(`Evidence bucket is not reachable: ${String(error)}`);
      return false;
    }
  }
}

/**
 * Whether an SDK error means "no such object".
 *
 * Checked on name and status rather than by instance, because `HeadObject` answers with a bare
 * 404 carrying `NotFound` while `GetObject` answers `NoSuchKey`, and the SDK models them as
 * different shapes.
 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const named = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    named.name === 'NotFound' ||
    named.name === 'NoSuchKey' ||
    named.$metadata?.httpStatusCode === 404
  );
}
