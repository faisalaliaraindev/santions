/**
 * The evidence object store seam.
 *
 * **Rule 1, from the C0 failure matrix: stage the object, verify it, then commit the reference.
 * Never the inverse.** A committed reference to an object that is not there is a screening
 * product telling a reviewer that evidence exists when it does not — which is the single worst
 * thing this system can do, because it looks exactly like success. Every signature in this file
 * is shaped to make that ordering the easy path and the inverse awkward.
 *
 * Two consequences worth stating, because they are what the interface is for:
 *
 * 1. **`put` returns what the store actually holds**, not what the caller sent. The checksum is
 *    verified against the bytes *as stored* (FI-03), and a store that reports back the caller's
 *    own numbers cannot verify anything — it would confirm that we computed our own hash
 *    correctly, which is never in doubt.
 * 2. **`list` exists for the orphan sweep**, not for browsing. FI-03's reconciler lists the
 *    tenant prefix and deletes objects older than the window that no committed reference names.
 *
 * Keys are generated server-side from tenant and region context plus an opaque id (SEC-03),
 * never from a publisher name, a URL path, or anything a caller supplied. `keyFor` below is the
 * only place a key is constructed, so that rule is enforced by there being nowhere else to do it.
 *
 * Local emulation against LocalStack proves the code path, and proves nothing about real IAM,
 * bucket policy or KMS. Those are gate G11. Nothing here may imply otherwise.
 */

import { randomUUID } from 'node:crypto';

export const OBJECT_STORE_PORT = 'OBJECT_STORE_PORT';

export interface StoredObject {
  readonly bucket: string;
  readonly key: string;
  /** The size the store reports, not the size the caller believed it was uploading. */
  readonly byteSize: number;
  readonly contentType: string;
  readonly checksumAlgorithm: 'SHA256';
  /** Base64 SHA-256 **as computed by the store over the stored bytes**. */
  readonly checksumValue: string;
}

export interface ListedObject {
  readonly key: string;
  readonly byteSize: number;
  readonly lastModified: Date;
}

export interface PutObjectInput {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  /**
   * The caller's SHA-256 of the bytes it intends to store, base64.
   *
   * Sent to the store so the store can reject a corrupted transfer itself, and compared again
   * on the way back. Belt and braces, deliberately: a transfer can be corrupted in either
   * direction, and the cost of checking twice is a string comparison.
   */
  readonly checksumValue: string;
}

export interface ObjectStorePort {
  /** Which implementation is running. Recorded in health output. */
  readonly kind: string;
  readonly bucket: string;

  /**
   * Store the bytes and report what the store holds.
   *
   * Throws if the store rejects the checksum. Does **not** decide whether the result is
   * acceptable — that is the staging service's job, and splitting it that way keeps the
   * verification decision in one readable place rather than inside an adapter.
   */
  put(input: PutObjectInput): Promise<StoredObject>;

  /** Metadata only. `null` when the object is not there — which is the FI-03 question. */
  head(key: string): Promise<StoredObject | null>;

  get(key: string): Promise<Uint8Array | null>;

  /**
   * Delete. Idempotent: deleting an absent object succeeds.
   *
   * S3 semantics, and the right ones — FI-15's sweeper retries until the object is gone, and a
   * retry that failed because the previous attempt had succeeded would never close.
   */
  remove(key: string): Promise<void>;

  /** Every object under a prefix. Used by the FI-03 orphan sweep. */
  list(prefix: string): Promise<readonly ListedObject[]>;

  healthy(): Promise<boolean>;
}

/**
 * The prefix every object for a tenant lives under.
 *
 * Tenant leads the key, as it leads every tenant-owned index key (C1). That is what makes the
 * orphan sweep a prefix listing rather than a full-bucket scan, and what makes an accidental
 * cross-tenant read a malformed key rather than a plausible one.
 */
export function tenantPrefix(tenantId: string, region: string): string {
  return `evidence/${region}/${tenantId}/`;
}

/**
 * Build an object key.
 *
 * The **only** place a key is constructed. Opaque id, tenant and region context, no caller
 * input anywhere in it (SEC-03): a key derived from a publisher name or a source URL leaks the
 * subject of a screening into object metadata, and a key containing a caller-supplied path is a
 * traversal waiting to be found.
 *
 * The date segment is for operational grouping — lifecycle rules and prefix sharding — and is
 * derived from the clock the caller passes, never read here (the purity rule applies to callers
 * of this module too).
 *
 * There is deliberately no way to supply the id. A test that could pin the key could also pin
 * one that `tenantOfKey` does not recognise, and the orphan sweep would then quietly decline to
 * collect exactly the objects the test created — a hole in the reconciler, opened for the
 * convenience of a fixture.
 */
export function keyFor(input: {
  readonly tenantId: string;
  readonly region: string;
  readonly now: Date;
}): string {
  const day = input.now.toISOString().slice(0, 10);
  return `${tenantPrefix(input.tenantId, input.region)}${day}/${randomUUID()}`;
}

/**
 * Which tenant a key belongs to, or `null` if the key is not shaped like one of ours.
 *
 * **Validates the whole shape, not just the prefix**, and that is the point. The orphan sweep
 * lists a tenant prefix, so every key it sees starts with that prefix by construction — a guard
 * that only re-checked the prefix would be unreachable, which is a guard that does nothing. What
 * the sweep actually needs to know is narrower and more useful: *did this system create this
 * object?* Only `keyFor` creates evidence objects, so only what `keyFor` can produce is eligible
 * for deletion.
 *
 * Anything else under the prefix — an object someone uploaded by hand, a key from an older
 * layout, a name containing `..` (which S3 treats as literal, not as traversal) — is left alone
 * and counted. A scheduled job that deletes objects it did not create is a bucket-wide delete
 * wearing a prefix filter, and it only has to be wrong once.
 */
const KEY_SHAPE =
  /^evidence\/(?<region>[A-Za-z0-9-]+)\/(?<tenant>[A-Za-z0-9._-]+)\/(?<day>\d{4}-\d{2}-\d{2})\/(?<id>[0-9a-f-]{36})$/u;

export function tenantOfKey(key: string, region: string): string | null {
  const match = KEY_SHAPE.exec(key);
  if (match?.groups === undefined || match.groups['region'] !== region) {
    return null;
  }
  return match.groups['tenant'] ?? null;
}

/**
 * An in-process object store, for unit tests and a development run with no LocalStack.
 *
 * Enforces the same checksum contract as the real adapter, because a fake that accepts anything
 * would let a staging bug pass every test that uses it. `failNextPut` and `corruptOnRead` exist
 * so the staging service's failure paths can be exercised — making a real store corrupt bytes on
 * demand means breaking it.
 */
export class InMemoryObjectStore implements ObjectStorePort {
  readonly kind = 'in-memory';

  private readonly objects = new Map<
    string,
    { object: StoredObject; body: Uint8Array; lastModified: Date }
  >();

  /** Set by a test to make the next write fail. */
  failNextPut: string | null = null;
  /** Set by a test to make the store report a checksum that does not match the bytes. */
  corruptChecksum = false;

  constructor(readonly bucket = 'in-memory-evidence') {}

  async put(input: PutObjectInput): Promise<StoredObject> {
    if (this.failNextPut !== null) {
      const reason = this.failNextPut;
      this.failNextPut = null;
      throw new Error(reason);
    }
    const object: StoredObject = {
      bucket: this.bucket,
      key: input.key,
      byteSize: input.body.byteLength,
      contentType: input.contentType,
      checksumAlgorithm: 'SHA256',
      checksumValue: this.corruptChecksum ? 'not-the-checksum' : input.checksumValue,
    };
    this.objects.set(input.key, {
      object,
      body: input.body,
      lastModified: this.now ?? new Date(),
    });
    return Promise.resolve(object);
  }

  /** Set by a test so `lastModified` can be aged without waiting six hours. */
  now: Date | null = null;

  async head(key: string): Promise<StoredObject | null> {
    return Promise.resolve(this.objects.get(key)?.object ?? null);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.objects.get(key)?.body ?? null);
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  async list(prefix: string): Promise<readonly ListedObject[]> {
    const out: ListedObject[] = [];
    for (const [key, held] of this.objects) {
      if (key.startsWith(prefix)) {
        out.push({ key, byteSize: held.object.byteSize, lastModified: held.lastModified });
      }
    }
    return Promise.resolve(out);
  }

  async healthy(): Promise<boolean> {
    return Promise.resolve(true);
  }

  size(): number {
    return this.objects.size;
  }
}
