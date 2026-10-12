/**
 * The breaker key — decision **D-040**.
 *
 * The property worth asserting is not "it gets every domain right", because without the Public
 * Suffix List it cannot. It is that **where it is wrong, it is wrong in the safe direction**:
 * broader than the true registrable domain, never narrower. A key that is too broad holds back
 * a publisher who did nothing wrong, visibly, in a coverage statement. A key that is too narrow
 * keeps calling a publisher who has already refused us.
 */

import { describe, expect, it } from 'vitest';

import {
  registrableDomain,
  registrableDomainOfUrl,
} from '../../src/reliability/registrable-domain.js';

describe('registrableDomain', () => {
  it('folds subdomains of one publisher onto one key', () => {
    // The reason the key is not the host. These are one organisation and one set of servers,
    // and a breaker per host would let a publisher who refused us at `www` keep being called
    // at `amp` and `feeds`.
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(registrableDomain('amp.example.com')).toBe('example.com');
    expect(registrableDomain('feeds.news.example.com')).toBe('example.com');
  });

  it('keeps a bare registrable domain unchanged', () => {
    expect(registrableDomain('example.com')).toBe('example.com');
  });

  it('keeps three labels where the second level belongs to the registry', () => {
    // The key must not become the bare ccTLD. `nacion.go.cr` and `hacienda.go.cr` are separate
    // institutions, and one failing must not suspend the other — still less every `.cr` site.
    expect(registrableDomain('www.nacion.go.cr')).toBe('nacion.go.cr');
    expect(registrableDomain('sub.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('www.gob.com.mx')).toBe('gob.com.mx');
    expect(registrableDomain('a.b.example.com.au')).toBe('example.com.au');
  });

  it('never returns a bare public suffix for a host it knows', () => {
    for (const host of ['www.nacion.go.cr', 'x.y.example.co.uk', 'q.example.com.br']) {
      const key = registrableDomain(host);
      expect(key.split('.').length).toBeGreaterThanOrEqual(3);
    }
  });

  it('does not treat a three-letter TLD as a country second level', () => {
    // `co.com` is not `co.uk`: the rule applies only where the TLD is a two-letter country code.
    expect(registrableDomain('shop.co.com')).toBe('co.com');
  });

  it('is case- and trailing-dot-insensitive', () => {
    expect(registrableDomain('WWW.Example.COM.')).toBe('example.com');
  });

  it('returns an IP literal unchanged', () => {
    // No registrable domain exists above an address, and the address is the right key for one.
    // Such a host never reaches a socket — SEC-02 refuses it — but a refusal still has to be
    // recorded against something.
    expect(registrableDomain('203.0.113.5')).toBe('203.0.113.5');
    expect(registrableDomain('[2001:db8::1]')).toBe('[2001:db8::1]');
  });

  it('answers rather than throwing for an empty or malformed host', () => {
    // One malformed lead must not become an exception in the middle of a run over a hundred.
    expect(registrableDomain('')).toBe('');
    expect(registrableDomain('   ')).toBe('');
    expect(registrableDomain('localhost')).toBe('localhost');
  });
});

describe('registrableDomainOfUrl', () => {
  it('reads the host out of a URL', () => {
    expect(registrableDomainOfUrl('https://www.sec.gov/litigation/litreleases/lr-26000')).toBe(
      'sec.gov',
    );
  });

  it('returns null for a string that is not a URL', () => {
    expect(registrableDomainOfUrl('not a url')).toBeNull();
    expect(registrableDomainOfUrl('')).toBeNull();
  });
});
