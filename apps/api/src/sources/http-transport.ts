/**
 * Phase E step 1 — one HTTPS request, with the SEC-02 screening inside the connection itself.
 *
 * # Why this is not `fetch`
 *
 * Two things the fetch API cannot do, and both of them are requirements rather than preferences.
 *
 * **1. Screen the address the socket actually uses.** `screenResolvedAddress` exists to defeat
 * DNS rebinding, and it defeats nothing if the screening resolves the host and the connection
 * then resolves it again — that second resolution is the attack. `fetch` gives no way in. But
 * `https.request` takes a `lookup` function *that the connection calls*, so screening inside it
 * means an unscreened address is not reachable: not because somebody remembered to check before
 * calling, but because the only path from a hostname to a socket runs through the check. TLS is
 * untouched — `servername` stays the hostname, so the certificate is verified against the name,
 * not the address.
 *
 * **2. Enforce two byte budgets instead of one.** `fetch` transparently decompresses, so the
 * wire size is unobservable and `maxBytes` and `maxDecompressedBytes` collapse into the same
 * number. Here the wire bytes are counted as they arrive and the decompressed bytes are bounded
 * by `zlib`'s own `maxOutputLength`, so a 40KB response that inflates to a gigabyte trips the
 * second budget while the first is nowhere near its limit. That is the compression half of T38,
 * and one budget cannot express it.
 *
 * # What this does not do
 *
 * It does not follow redirects, apply robots, check source health, or decide anything. It opens
 * one connection, enforces the budget, and reports **facts** — a status code, a syscall name, a
 * byte count. Everything that is a judgement belongs to `HttpEvidenceFetchAdapter`, and
 * everything that is a retry policy belongs to `classifyFailure`. An adapter that decided its own
 * retry policy would be the second failure taxonomy the FR-06 table exists to prevent.
 */

import dns from 'node:dns';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import zlib from 'node:zlib';

import { screenResolvedAddress, type FailureSignal } from '@adverse-search/domain';

export interface TransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Bytes on the wire, before decompression. */
  readonly maxWireBytes: number;
  /** Bytes after decompression. The one that catches a compression bomb. */
  readonly maxDecompressedBytes: number;
}

export type TransportResult =
  | {
      readonly kind: 'RESPONSE';
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      /** Decompressed. Empty for a 304 or a redirect, both of which carry no document. */
      readonly body: Uint8Array;
      /** Bytes on the wire, for the record and for the budget a caller spends against. */
      readonly wireBytes: number;
    }
  | {
      readonly kind: 'FAILURE';
      readonly signal: FailureSignal;
      /** For the operator log. The `FailureSignal` is what the FR-06 table reads. */
      readonly detail: string;
    };

/** One HTTPS request. The seam exists so the adapter is testable without opening a socket. */
export interface HttpTransport {
  send(request: TransportRequest): Promise<TransportResult>;
}

/**
 * Thrown by `screeningLookup` when a host resolves somewhere we must never connect to.
 *
 * A distinct type rather than a string match, because the transport has to tell "this host is
 * forbidden" apart from "DNS is down" — the first is a policy refusal that must never be
 * retried and must never be recorded against the source's health, the second is an ordinary
 * transient network failure that should be.
 */
export class ForbiddenAddressError extends Error {
  readonly code = 'ERR_FORBIDDEN_ADDRESS';
}

/**
 * The `lookup` the connection calls, with SEC-02 screening inside it.
 *
 * **Every address, every time, and no cache.** `dns.lookup` is asked for all of them rather than
 * the first, because a host that answers with one public and one private address is a rebinding
 * or split-horizon signature and taking "the first one" makes it a coin toss.
 *
 * **One forbidden address refuses the whole host**, rather than connecting to whichever addresses
 * passed. A false positive costs one lead; a false negative costs cloud credentials, and the
 * asymmetry is the whole reason `isForbiddenAddress` is deliberately broad.
 *
 * Exported so it can be tested directly — the guarantee it carries is worth asserting on its own
 * rather than only through a socket that must not be opened in a test.
 */
export const screeningLookup: LookupFunction = (hostname, options, callback): void => {
  // `verbatim` keeps the resolver's own ordering rather than re-sorting IPv4 ahead of IPv6;
  // re-ordering would not change what is screened, but it would change which address is dialled
  // and make a reproduction depend on Node's sort rather than on the DNS answer.
  dns.lookup(hostname, { family: options.family ?? 0, all: true, verbatim: true }, (error, all) => {
    if (error !== null) {
      callback(error, '', 0);
      return;
    }

    const addresses: dns.LookupAddress[] = Array.isArray(all) ? all : [all];
    const forbidden = addresses.filter(
      (entry) => !screenResolvedAddress(hostname, entry.address).allowed,
    );
    const first = addresses[0];
    if (forbidden.length > 0 || first === undefined) {
      callback(
        new ForbiddenAddressError(
          first === undefined
            ? `${hostname} resolved to no addresses.`
            : `${hostname} resolved to ${forbidden.map((e) => e.address).join(', ')}, which ` +
                `must never be connected to (SEC-02). Refusing the host entirely rather than ` +
                `connecting to the addresses that passed: a host answering with both a public ` +
                `and a private address is a rebinding signature, not a usable one.`,
        ),
        '',
        0,
      );
      return;
    }

    if (options.all === true) {
      callback(null, addresses);
      return;
    }
    callback(null, first.address, first.family);
  });
};

export interface NodeHttpsTransportOptions {
  /** Injected so a test can assert the screening without a network, and never defaulted away. */
  readonly lookup?: LookupFunction;
}

export class NodeHttpsTransport implements HttpTransport {
  private readonly lookup: LookupFunction;

  constructor(options: NodeHttpsTransportOptions = {}) {
    this.lookup = options.lookup ?? screeningLookup;
  }

  async send(request: TransportRequest): Promise<TransportResult> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return { kind: 'FAILURE', signal: { policyRefusal: true }, detail: 'Malformed URL.' };
    }

    return new Promise<TransportResult>((resolve) => {
      // Resolved at most once. Several of the paths below can race — a timeout firing while the
      // last chunk arrives — and a second resolve would be silently ignored by the promise but
      // would leave the request object still attached to a live socket.
      let settled = false;
      const finish = (result: TransportResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        outbound.destroy();
        resolve(result);
      };

      const outbound = https.request(
        {
          protocol: 'https:',
          hostname: url.hostname,
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: { ...request.headers, host: url.host },
          // The screening. See the file header: this is the only path to a socket.
          lookup: this.lookup,
          // The certificate is checked against the name, not the address the lookup returned.
          servername: url.hostname,
          // Never follow a redirect here. The adapter re-screens every hop, and a transport that
          // followed one would carry the request past the gate without the gate being consulted.
        },
        (response) => {
          const chunks: Buffer[] = [];
          let wireBytes = 0;

          response.on('data', (chunk: Buffer) => {
            wireBytes += chunk.byteLength;
            if (wireBytes > request.maxWireBytes) {
              // FR-06: abort immediately, record a bounded rejection, free the worker. Aborting
              // on the chunk that crosses the line is the point — buffering the whole body and
              // checking afterwards is the behaviour the budget exists to prevent.
              finish({
                kind: 'FAILURE',
                signal: { limitExceeded: true },
                detail:
                  `Response exceeded the ${String(request.maxWireBytes)}-byte wire budget and ` +
                  `was abandoned mid-stream.`,
              });
              return;
            }
            chunks.push(chunk);
          });

          response.on('end', () => {
            const headers = flattenHeaders(response.headers);
            const status = response.statusCode ?? 0;
            const decoded = decompress(
              Buffer.concat(chunks),
              headers['content-encoding'] ?? null,
              request.maxDecompressedBytes,
            );
            if (decoded.kind === 'FAILURE') {
              finish(decoded);
              return;
            }
            finish({ kind: 'RESPONSE', status, headers, body: decoded.body, wireBytes });
          });

          response.on('error', (error: NodeJS.ErrnoException) => {
            finish({ kind: 'FAILURE', signal: networkSignal(error), detail: error.message });
          });
        },
      );

      const timer = setTimeout(() => {
        // The whole request, not the idle gap between packets. A source that sends one byte a
        // second is a slow-response attack (T38), and a socket-level idle timeout never fires
        // against it.
        finish({
          kind: 'FAILURE',
          signal: { syscallCode: 'ETIMEDOUT' },
          detail: `No complete response within ${String(request.timeoutMs)}ms.`,
        });
      }, request.timeoutMs);

      outbound.on('error', (error: NodeJS.ErrnoException) => {
        finish({ kind: 'FAILURE', signal: networkSignal(error), detail: error.message });
      });

      outbound.end();
    });
  }
}

/**
 * A transport-level error, reduced to the facts the FR-06 table reads.
 *
 * The one case that is not a network fact is a refused address: it is **our** policy, so it is
 * reported as `policyRefusal` rather than as a syscall. The difference matters downstream —
 * a policy refusal is never counted against the source's health, and a `ECONNREFUSED` is.
 */
export function networkSignal(error: NodeJS.ErrnoException): FailureSignal {
  if (error instanceof ForbiddenAddressError || error.code === 'ERR_FORBIDDEN_ADDRESS') {
    return { policyRefusal: true };
  }
  return { syscallCode: error.code ?? 'ECONNRESET' };
}

/**
 * Decompress within a hard output bound.
 *
 * `maxOutputLength` is enforced by zlib itself, so the bomb is stopped inside the decompressor
 * rather than by a length check on a buffer that has already been allocated. An unrecognised
 * encoding is returned as-is rather than guessed at: the content type check downstream will
 * reject it, and guessing would turn a garbled body into a confidently wrong document.
 */
function decompress(
  body: Buffer,
  encoding: string | null,
  maxOutputLength: number,
): { kind: 'OK'; body: Uint8Array } | Extract<TransportResult, { kind: 'FAILURE' }> {
  const scheme = encoding?.trim().toLowerCase() ?? '';
  try {
    switch (scheme) {
      case '':
      case 'identity':
        if (body.byteLength > maxOutputLength) {
          return {
            kind: 'FAILURE',
            signal: { limitExceeded: true },
            detail: `Body exceeded the ${String(maxOutputLength)}-byte decompressed budget.`,
          };
        }
        return { kind: 'OK', body };
      case 'gzip':
      case 'x-gzip':
        return { kind: 'OK', body: zlib.gunzipSync(body, { maxOutputLength }) };
      case 'deflate':
        return { kind: 'OK', body: zlib.inflateSync(body, { maxOutputLength }) };
      case 'br':
        return { kind: 'OK', body: zlib.brotliDecompressSync(body, { maxOutputLength }) };
      default:
        return { kind: 'OK', body };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      return {
        kind: 'FAILURE',
        signal: { limitExceeded: true },
        detail:
          `A ${String(body.byteLength)}-byte ${scheme} body exceeded the ` +
          `${String(maxOutputLength)}-byte decompressed budget. Abandoned without allocating it.`,
      };
    }
    // A body that will not decompress is a fact about the document, not about the source, so it
    // is a content error and is never retried.
    return {
      kind: 'FAILURE',
      signal: { unparsableBody: true },
      detail: `Could not decompress a ${scheme} body: ${code ?? 'unknown'}.`,
    };
  }
}

/** Node gives repeated headers as arrays. Joined, lower-cased, so a caller reads one shape. */
function flattenHeaders(headers: NodeJS.Dict<string | string[]>): Readonly<Record<string, string>> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    flat[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return flat;
}
