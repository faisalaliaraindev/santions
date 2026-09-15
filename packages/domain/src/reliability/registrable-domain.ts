/**
 * The registrable domain — the key the per-domain breaker is kept under (decision **D-040**).
 *
 * # Why a registrable domain and not a host
 *
 * FR-06's failure policies speak of a **domain** being degraded or suspended, and a publisher is
 * a domain rather than a host. `www.example.com`, `amp.example.com` and `feeds.example.com` are
 * one organisation, one set of servers, one person who would write and ask us to stop. Keying
 * the breaker on the host would let a source that has refused us from one hostname keep being
 * called at four others, which is the behaviour the breaker exists to prevent.
 *
 * Keying it on the bare TLD would be the opposite mistake and a much worse one: one failing
 * Costa Rican publisher would suspend every `.cr` site in the registry.
 *
 * # No public suffix list, and what that costs
 *
 * The exact answer needs the Public Suffix List, which is a data file that changes weekly and
 * whose npm distributions are a supply chain this project has not reviewed. So this is a rule
 * rather than a table: strip to two labels, or to three when the second-to-last label is one of
 * the generic second-level labels a two-letter country code normally publishes under (`co.uk`,
 * `go.cr`, `com.mx`).
 *
 * **Where the rule is wrong, it is wrong in the safe direction**, and that is the property worth
 * stating. An unlisted multi-label suffix — a country using a second level this rule does not
 * know — produces a key that is *broader* than the true registrable domain, so two unrelated
 * publishers share one breaker and one failing publisher can hold the other back. That costs
 * coverage, visibly, in a coverage statement that names the domain. The opposite error, a key
 * narrower than the publisher, would let us keep calling a publisher who has already refused —
 * and that is a cost paid by somebody who did not ask to hear from us.
 *
 * Pure, like everything in this package: a string in, a string out, no network and no clock.
 */

/**
 * Generic second-level labels that two-letter country codes publish registrations under.
 *
 * Deliberately short. Every entry here makes the key *narrower* (three labels instead of two),
 * so an entry added by mistake is the unsafe direction and the list is kept to labels that are
 * genuinely registry-operated rather than to every label somebody might use.
 */
const COUNTRY_SECOND_LEVELS: ReadonlySet<string> = new Set([
  'ac',
  'co',
  'com',
  'ed',
  'edu',
  'fi',
  'go',
  'gob',
  'gov',
  'gouv',
  'in',
  'int',
  'mil',
  'ne',
  'net',
  'nom',
  'or',
  'org',
  'sa',
  'sch',
]);

/** Multi-label suffixes that the rule above does not catch, listed because they are common. */
const EXPLICIT_SUFFIXES: ReadonlySet<string> = new Set([
  'com.au',
  'net.au',
  'org.au',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.br',
  'com.cn',
  'com.tr',
]);

/**
 * The registrable domain for a host, lower-cased.
 *
 * An IP literal is returned unchanged: there is no registrable domain above an address, and the
 * address itself is the right breaker key for one. (Such a host never reaches a socket — SEC-02
 * refuses every private literal and `screenUrl` allows no others that matter here — but the
 * function must still answer rather than throw, because it is also called on URLs that were
 * refused, to record *which* domain was refused.)
 *
 * An empty or malformed host returns the input trimmed and lower-cased. A key nobody can parse
 * is still a key, and a breaker keyed under it behaves correctly; throwing here would turn a
 * malformed lead into an exception in the middle of a run.
 */
export function registrableDomain(hostname: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (host === '') {
    return '';
  }

  // IPv6 in URL form arrives bracketed; IPv4 is all digits and dots.
  if (host.startsWith('[') || host.includes(':') || /^[0-9.]+$/.test(host)) {
    return host;
  }

  const labels = host.split('.').filter((label) => label !== '');
  if (labels.length <= 2) {
    return labels.join('.');
  }

  const tld = labels[labels.length - 1] ?? '';
  const second = labels[labels.length - 2] ?? '';
  const suffix = `${second}.${tld}`;

  const isCountrySecondLevel = tld.length === 2 && COUNTRY_SECOND_LEVELS.has(second);
  if (isCountrySecondLevel || EXPLICIT_SUFFIXES.has(suffix)) {
    return labels.slice(-3).join('.');
  }

  return labels.slice(-2).join('.');
}

/**
 * The registrable domain for a URL string, or null when it has no host.
 *
 * Takes the string rather than a `URL` so that a caller holding a lead's raw URL does not have
 * to construct one — and so a malformed URL answers null instead of throwing inside a loop over
 * a hundred leads.
 */
export function registrableDomainOfUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    return host === '' ? null : registrableDomain(host);
  } catch {
    return null;
  }
}
