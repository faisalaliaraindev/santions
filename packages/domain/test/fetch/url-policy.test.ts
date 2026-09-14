/**
 * SEC-02 — the URL gate.
 *
 * Enumerated rather than sampled. This is the boundary between "a stranger named an address"
 * and "we connected to it", and the cost of a gap is cloud credentials or our own database.
 */

import { describe, expect, it } from 'vitest';

import { isForbiddenAddress, screenResolvedAddress, screenUrl } from '../../src/index.js';

describe('schemes and ports', () => {
  it('allows an ordinary https URL', () => {
    const result = screenUrl('https://www.example.cr/sucesos/caso-2024');
    expect(result.allowed).toBe(true);
    expect(result.canonical).toBe('https://www.example.cr/sucesos/caso-2024');
  });

  it('refuses every scheme that is not https', () => {
    for (const url of [
      'http://www.example.cr/x',
      'file:///etc/passwd',
      'ftp://example.cr/x',
      'data:text/html,<script>1</script>',
      'javascript:alert(1)',
      'gopher://example.cr/x',
    ]) {
      const result = screenUrl(url);
      expect(result.allowed, url).toBe(false);
    }
  });

  it('refuses a non-standard port even over https', () => {
    // A discovered link to https://host:28017/ is a link to our own database.
    const result = screenUrl('https://example.cr:28017/x');
    expect(result.allowed).toBe(false);
    expect(result.rejection).toBe('PORT_NOT_ALLOWED');
  });

  it('allows an explicit :443 and drops it from the canonical form', () => {
    const result = screenUrl('https://example.cr:443/x');
    expect(result.allowed).toBe(true);
    expect(result.canonical).toBe('https://example.cr/x');
  });

  it('refuses embedded credentials', () => {
    const result = screenUrl('https://user:secret@example.cr/x');
    expect(result.allowed).toBe(false);
    expect(result.rejection).toBe('CREDENTIALS_IN_URL');
  });

  it('refuses a malformed URL rather than guessing at it', () => {
    expect(screenUrl('not a url').allowed).toBe(false);
    expect(screenUrl('').allowed).toBe(false);
  });
});

describe('IP literals in the host', () => {
  it('refuses loopback, private, link-local and metadata addresses', () => {
    for (const host of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // the cloud metadata service
      '0.0.0.0',
      '100.64.0.1', // carrier-grade NAT
      '255.255.255.255',
      '224.0.0.1', // multicast
    ]) {
      expect(screenUrl(`https://${host}/x`).allowed, host).toBe(false);
    }
  });

  it('refuses the integer form of a loopback address', () => {
    // `https://2130706433/` is 127.0.0.1 written as a decimal. URL normalises it, and the
    // dotted-quad check then catches it — but it is worth asserting, because this notation is
    // exactly what an attacker reaches for first.
    expect(screenUrl('https://2130706433/x').allowed).toBe(false);
  });

  it('refuses IPv6 loopback, unique-local, link-local and multicast', () => {
    for (const host of ['[::1]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[ff02::1]', '[::]']) {
      expect(screenUrl(`https://${host}/x`).allowed, host).toBe(false);
    }
  });

  it('refuses an IPv4-mapped IPv6 address, which reaches the same host', () => {
    expect(isForbiddenAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isForbiddenAddress('::ffff:10.0.0.1')).toBe(true);
  });

  it('allows a genuine public address', () => {
    expect(isForbiddenAddress('93.184.216.34')).toBe(false);
    expect(isForbiddenAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });
});

describe('the resolved-address half of the gate', () => {
  it('refuses a public hostname that resolves privately (DNS rebinding)', () => {
    // The case `screenUrl` structurally cannot catch: the URL looks perfect, and DNS points it
    // at our own network.
    const result = screenResolvedAddress('news.example.cr', '10.0.0.5');
    expect(result.allowed).toBe(false);
    expect(result.detail).toMatch(/SEC-02/);
  });

  it('allows a public hostname that resolves publicly', () => {
    expect(screenResolvedAddress('news.example.cr', '93.184.216.34').allowed).toBe(true);
  });
});

describe('canonicalisation', () => {
  it('lower-cases the host but leaves the path alone', () => {
    // Paths are case-sensitive on most servers; "normalising" one turns a working URL into a 404.
    const result = screenUrl('https://WWW.Example.CR/Sucesos/Caso-2024');
    expect(result.canonical).toBe('https://www.example.cr/Sucesos/Caso-2024');
  });

  it('drops the fragment, which never reaches the server', () => {
    expect(screenUrl('https://example.cr/x#section-3').canonical).toBe('https://example.cr/x');
  });

  it('strips tracking parameters so one article does not count as two sources', () => {
    const a = screenUrl('https://example.cr/x?utm_source=news&id=7').canonical;
    const b = screenUrl('https://example.cr/x?id=7&fbclid=abc').canonical;
    expect(a).toBe(b);
  });

  it('sorts the remaining query, so parameter order does not create a second lead', () => {
    const a = screenUrl('https://example.cr/x?b=2&a=1').canonical;
    const b = screenUrl('https://example.cr/x?a=1&b=2').canonical;
    expect(a).toBe(b);
  });

  it('keeps parameters that identify the document', () => {
    expect(screenUrl('https://example.cr/article?id=7').canonical).toContain('id=7');
  });
});
