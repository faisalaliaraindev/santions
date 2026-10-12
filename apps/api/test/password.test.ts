/**
 * I2 — what a password has to clear, and what happens to it afterwards.
 *
 * Pure and fast enough to live in the unit project: argon2id hashing is CPU work, not I/O, so
 * every claim about the stored form can be asserted on a clean checkout with nothing running.
 */

import { parseOptions } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';

import { PASSWORD_MIN_LENGTH } from '@adverse-search/contracts';

import {
  ARGON2_OPTIONS,
  ARGON2ID_ALGORITHM,
  assessPassword,
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from '../src/auth/password.js';

const GOOD = 'harbour-lantern-drift-98';

describe('I2 — the password policy', () => {
  it('accepts a long passphrase with no capitals, digits or symbols required', () => {
    // The trade this policy makes, stated as a test: length instead of composition rules. A
    // rule demanding a capital and a symbol is what produces `Password1!`.
    expect(assessPassword('correct horse battery staple').ok).toBe(true);
  });

  it('refuses anything shorter than the minimum', () => {
    const verdict = assessPassword('a'.repeat(PASSWORD_MIN_LENGTH - 1));
    expect(verdict).toMatchObject({ ok: false, rejection: 'TOO_SHORT' });
  });

  it('refuses an unbounded one, because the hash is memory-hard on purpose', () => {
    // Without the bound, a megabyte of "password" is a free way to spend the server's memory on
    // every attempt.
    expect(assessPassword('a'.repeat(10_000))).toMatchObject({ ok: false, rejection: 'TOO_LONG' });
  });

  it('refuses the passwords tried first, and their obvious disguises', () => {
    for (const candidate of [
      'passwordpassword',
      'Password123456',
      'P@ssw0rd-1234',
      'administrator',
      // Long enough to clear the length rule, so what refuses them is the known-bad list and
      // not the minimum — otherwise this test would pass without the list existing at all.
      'qwertyuiop12',
      'letmein12345',
    ]) {
      expect(assessPassword(candidate), candidate).toMatchObject({
        ok: false,
        rejection: 'TOO_COMMON',
      });
    }
  });

  it('refuses a password containing the address it signs in with', () => {
    const verdict = assessPassword('compliance-at-acme-2026', {
      email: 'compliance@acme.example',
    });
    expect(verdict).toMatchObject({ ok: false, rejection: 'CONTAINS_EMAIL' });
  });

  it('refuses a password containing the organisation name', () => {
    // Public, on the website, and the second thing an attacker tries.
    const verdict = assessPassword('acmecompliance-winter', {
      organisationName: 'Acme Compliance',
    });
    expect(verdict).toMatchObject({ ok: false, rejection: 'CONTAINS_ORGANISATION' });
  });

  it('does not refuse a long passphrase that merely mentions a short word', () => {
    // A guard against the contains-checks being so eager that they refuse good passwords: a
    // policy that rejects too much is one people work around with a sticky note.
    expect(assessPassword('the quiet harbour at midnight', { organisationName: 'AB' }).ok).toBe(
      true,
    );
  });

  it('is pure: no clock, no database, same answer every time', () => {
    expect(assessPassword(GOOD)).toEqual(assessPassword(GOOD));
  });
});

describe('I2 — how a password is stored', () => {
  it('produces an argon2id hash carrying the parameters it was made with', async () => {
    const stored = await hashPassword(GOOD);

    expect(stored.startsWith('$argon2id$')).toBe(true);

    // The constant is a number rather than the library's ambient const enum, so it is checked
    // against a hash this module actually produced. A wrong value here would silently select
    // argon2d, which resists side channels far less well.
    const parsed = parseOptions(stored);
    expect(parsed.algorithm).toBe(ARGON2ID_ALGORITHM);
    expect(parsed.memoryCost).toBe(ARGON2_OPTIONS.memoryCost);
    expect(parsed.timeCost).toBe(ARGON2_OPTIONS.timeCost);
  });

  it('salts, so two accounts with the same password do not share a hash', async () => {
    const [first, second] = await Promise.all([hashPassword(GOOD), hashPassword(GOOD)]);

    expect(first).not.toBe(second);
    expect(await verifyPassword(first, GOOD)).toBe(true);
    expect(await verifyPassword(second, GOOD)).toBe(true);
  });

  it('never contains the password it was made from', async () => {
    const stored = await hashPassword(GOOD);
    expect(stored).not.toContain(GOOD);
    expect(stored).not.toContain('harbour');
  });

  it('refuses the wrong password, and a malformed stored hash, without throwing', async () => {
    const stored = await hashPassword(GOOD);

    expect(await verifyPassword(stored, 'not the password')).toBe(false);
    // A stored value that cannot be parsed is a failed authentication, not a 500 — a 500 here
    // would tell an attacker exactly which accounts carry an unreadable hash.
    expect(await verifyPassword('not a hash at all', GOOD)).toBe(false);
    expect(await verifyPassword('', GOOD)).toBe(false);
  });
});

describe('I2 — strengthening the store without a reset email', () => {
  it('leaves a hash made under the current policy alone', async () => {
    expect(passwordNeedsRehash(await hashPassword(GOOD))).toBe(false);
  });

  it('flags a hash made with weaker parameters', () => {
    // A PHC string with a quarter of the memory cost: the shape of a hash written before the
    // parameters were raised.
    const weak = '$argon2id$v=19$m=4096,t=2,p=1$c29tZXNhbHQ$0123456789abcdef0123456789abcdef';
    expect(passwordNeedsRehash(weak)).toBe(true);
  });

  it('does not flag a hash made with stronger parameters', () => {
    // The direction that matters: a deployment whose parameters were lowered must not quietly
    // re-hash every account down to the weaker setting on their next sign-in.
    const strong = '$argon2id$v=19$m=65536,t=4,p=1$c29tZXNhbHQ$0123456789abcdef0123456789abcdef';
    expect(passwordNeedsRehash(strong)).toBe(false);
  });

  it('flags anything it cannot parse, and anything that is not argon2id', () => {
    expect(passwordNeedsRehash('$2b$12$notargonatall')).toBe(true);
    expect(passwordNeedsRehash('')).toBe(true);
  });
});
