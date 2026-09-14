/**
 * FR-06 / SEC-02 — deciding whether a URL may be fetched at all.
 *
 * Pure, and deliberately so. This is the gate that stands between "a source mentioned a link"
 * and "this service made a request to an address of someone else's choosing". Every input to
 * that decision is a value, so every case can be enumerated in a test rather than discovered in
 * production.
 *
 * # The threat this exists for
 *
 * Discovery returns URLs that **we did not choose**. A news feed, a search engine or a page we
 * parsed can name any address at all, including `http://169.254.169.254/` (cloud credentials),
 * `http://127.0.0.1:28017/` (our own database), or `file:///etc/passwd`. A fetcher that takes a
 * URL from a third party and dials it is a server-side request forgery primitive with a news
 * feed as its input. SEC-02 is the requirement; this is the implementation.
 *
 * # Why the IP check cannot live only here
 *
 * This module rejects what it can see from the URL alone — the scheme, the port, embedded
 * credentials, an IP literal in the host. It **cannot** stop `evil.example.com` resolving to
 * `127.0.0.1`, because that needs DNS, and DNS is I/O.
 *
 * So the rule is split and the caller must do both halves: `screenUrl` before resolving, and
 * `screenResolvedAddress` on **every** address DNS returns, immediately before connecting. The
 * second half is what defeats DNS rebinding, and `isForbiddenAddress` is exported separately so
 * the fetch adapter cannot accidentally skip it.
 */

/** Ports a fetch may use. Anything else is refused rather than attempted. */
const ALLOWED_PORTS: ReadonlySet<number> = new Set([443]);

export type UrlRejection =
  | 'SCHEME_NOT_ALLOWED'
  | 'PORT_NOT_ALLOWED'
  | 'CREDENTIALS_IN_URL'
  | 'HOST_MISSING'
  | 'HOST_IS_FORBIDDEN_ADDRESS'
  | 'MALFORMED';

export interface UrlScreening {
  readonly allowed: boolean;
  readonly rejection: UrlRejection | null;
  /** Why, in words a reviewer or an operator can act on. Null when allowed. */
  readonly detail: string | null;
  /**
   * The canonical form, for deduplication and for the stored record. Null when rejected.
   *
   * Canonicalisation matters beyond tidiness: the same article reached through two feeds must
   * deduplicate to one lead, or axis D counts one story as two independent sources.
   */
  readonly canonical: string | null;
}

/** Query parameters that identify a campaign rather than a document. Dropped when canonical. */
const TRACKING_PARAMS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
];

/**
 * Screen a URL on what the string alone can tell us.
 *
 * Does **not** perform DNS. See the file header: the caller must also screen every resolved
 * address before connecting.
 */
export function screenUrl(raw: string): UrlScreening {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject('MALFORMED', `"${truncate(raw)}" is not a URL.`);
  }

  // https only. Not a style preference: `file:` reads the local disk, `data:` and `javascript:`
  // are not fetches at all, and plain http would let a network position rewrite the evidence
  // we are about to store and cite.
  if (url.protocol !== 'https:') {
    return reject(
      'SCHEME_NOT_ALLOWED',
      `Scheme "${url.protocol}" is not permitted. Evidence is fetched over https only.`,
    );
  }

  if (url.username !== '' || url.password !== '') {
    // Credentials in a discovered URL are either a trap or a leak waiting to be logged.
    return reject('CREDENTIALS_IN_URL', 'The URL carries embedded credentials.');
  }

  if (url.hostname === '') {
    return reject('HOST_MISSING', 'The URL has no host.');
  }

  const port = url.port === '' ? 443 : Number(url.port);
  if (!ALLOWED_PORTS.has(port)) {
    return reject(
      'PORT_NOT_ALLOWED',
      `Port ${String(port)} is not on the allowlist (${[...ALLOWED_PORTS].join(', ')}).`,
    );
  }

  // An IP literal in the host can be judged now, without DNS. A hostname cannot.
  const literal = normaliseHostLiteral(url.hostname);
  if (literal !== null && isForbiddenAddress(literal)) {
    return reject(
      'HOST_IS_FORBIDDEN_ADDRESS',
      `The host ${url.hostname} is a private, loopback, link-local or otherwise internal address.`,
    );
  }

  return { allowed: true, rejection: null, detail: null, canonical: canonicalise(url) };
}

/**
 * Screen an address DNS returned, immediately before connecting.
 *
 * The other half of the gate. `screenUrl` cannot see that `news.example.com` resolves to
 * `10.0.0.5`, and a host that resolved publicly a second ago can resolve privately now — which
 * is exactly how DNS rebinding works. Every address, every time, no cache.
 */
export function screenResolvedAddress(
  hostname: string,
  address: string,
): { readonly allowed: boolean; readonly detail: string | null } {
  if (isForbiddenAddress(address)) {
    return {
      allowed: false,
      detail:
        `${hostname} resolved to ${address}, which is a private, loopback, link-local or ` +
        `otherwise internal address. Refusing to connect (SEC-02).`,
    };
  }
  return { allowed: true, detail: null };
}

/**
 * Is this address one we must never connect to?
 *
 * Exported so the fetch adapter calls it explicitly rather than relying on `screenUrl` having
 * covered it. The list is deliberately broad — a false positive costs one lead, a false negative
 * costs cloud credentials.
 */
export function isForbiddenAddress(address: string): boolean {
  const value = address.trim().toLowerCase();

  if (value.includes(':')) {
    return isForbiddenIpv6(value);
  }
  return isForbiddenIpv4(value);
}

function isForbiddenIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) {
    // Not a dotted quad. Treated as forbidden only when it looked like an IP; a hostname
    // reaches here from `normaliseHostLiteral` returning null, so this path is genuine junk.
    return true;
  }

  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true;
  }
  const [a = 0, b = 0] = octets;

  return (
    a === 0 || // 0.0.0.0/8 — "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 carrier-grade NAT
    (a === 169 && b === 254) || // link-local, including the 169.254.169.254 metadata service
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0) || // 192.0.0/24 IETF protocol assignments, 192.0.2/24 TEST-NET-1
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51) || // TEST-NET-2
    (a === 203 && b === 0) || // TEST-NET-3
    a >= 224 // multicast and reserved, including 255.255.255.255
  );
}

function isForbiddenIpv6(value: string): boolean {
  const address = value.replace(/^\[|\]$/g, '');

  // An IPv4-mapped or IPv4-compatible address is an IPv4 address wearing a costume, and it
  // reaches the same host. Judge it as IPv4 rather than letting the notation bypass the rules.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped?.[1] !== undefined) {
    return isForbiddenIpv4(mapped[1]);
  }

  if (address === '::' || address === '::1') {
    return true; // unspecified, loopback
  }

  const first = address.split(':')[0] ?? '';
  const leading = parseInt(first === '' ? '0' : first, 16);
  if (Number.isNaN(leading)) {
    return true;
  }

  return (
    (leading & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (leading & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (leading & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}

/** An IP literal if the host is one, otherwise null. */
function normaliseHostLiteral(hostname: string): string | null {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return hostname;
  }
  // A bare IPv6 without brackets, and the decimal/octal/hex integer forms of an IPv4 address
  // (`http://2130706433/` is 127.0.0.1). `URL` normalises the integer forms to dotted quads, so
  // by the time we see it, the test above has already caught it.
  if (hostname.includes(':')) {
    return hostname;
  }
  return null;
}

/**
 * The canonical form used for deduplication and storage.
 *
 * Lower-cases the host, drops the default port, strips tracking parameters and the fragment,
 * and sorts the remaining query. The fragment goes because it never reaches the server; the
 * tracking parameters go because the same article shared through two channels is one article,
 * and counting it twice inflates the independence count that axis D reads.
 *
 * Note what is **not** done: the path is left exactly as it is, including its case and any
 * trailing slash. Paths are case-sensitive on most servers, and "helpfully" normalising one can
 * turn a working URL into a 404.
 */
export function canonicalise(url: URL): string {
  const canonical = new URL(url.toString());
  canonical.hostname = canonical.hostname.toLowerCase();
  canonical.hash = '';
  if (canonical.port === '443') {
    canonical.port = '';
  }

  for (const param of TRACKING_PARAMS) {
    canonical.searchParams.delete(param);
  }
  canonical.searchParams.sort();

  return canonical.toString();
}

function reject(rejection: UrlRejection, detail: string): UrlScreening {
  return { allowed: false, rejection, detail, canonical: null };
}

function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}
