/**
 * Passwords: how they are hashed, and what is refused before they ever are (I2, D-051).
 *
 * # argon2id, and why not the SHA-256 used a few files away
 *
 * `api-key.service.ts` hashes a key secret with a single SHA-256 and explains why: the secret is
 * 32 bytes of CSPRNG output, there is nothing to brute force, and a slow hash would only add
 * latency to every machine request.
 *
 * A password is the opposite input. It is short, human-chosen, drawn from a distribution an
 * attacker knows, and very often reused somewhere that has already been breached. The whole
 * defence is making each guess expensive, which is what a memory-hard hash buys: argon2id forces
 * an attacker to spend memory per guess, so a GPU farm loses most of its advantage.
 *
 * **Hashed, never encrypted.** The instruction behind D-051 said "encrypted"; anything that can
 * decrypt a password can produce it, and a store the provider can read back is a store the
 * provider can leak. Argon2id is the one-way version of the same intent.
 *
 * # The parameters
 *
 * OWASP's current floor for argon2id: 19 MiB of memory, two iterations, one degree of
 * parallelism. They are written out here rather than left to the library's defaults, because a
 * library default can change under a lock-file update and nobody would notice that every new
 * password is being hashed more cheaply than the old ones.
 *
 * The encoded hash carries its own parameters, so raising them later does not invalidate existing
 * hashes — `verify` reads what each hash was made with. `needsRehash` says when a hash was made
 * with weaker parameters than today's, which is how a store gets stronger without a reset email
 * to every customer.
 */

import { hash, parseOptions, verify, type Algorithm } from '@node-rs/argon2';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type PasswordRejection,
} from '@erly/adverse-contracts';

/**
 * `Algorithm.Argon2id`, by value.
 *
 * The library publishes `Algorithm` as an ambient `const enum`, which `verbatimModuleSyntax`
 * refuses to read at runtime — a const enum has no value to import, only a compile-time
 * substitution. The number is the one the PHC string encodes as `argon2id`, and
 * `ARGON2ID_ALGORITHM` is asserted in `password.test.ts` against a hash this module produced, so
 * a wrong constant here fails a test rather than silently selecting argon2d.
 */
export const ARGON2ID_ALGORITHM = 2 as Algorithm;

/** OWASP's argon2id floor, stated rather than inherited. */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID_ALGORITHM,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Values refused outright, whatever their length.
 *
 * Deliberately short, and deliberately honest about what it is: the top of every leaked-password
 * list, plus the ones this product invites. It is **not** a breach check — claiming one without
 * querying a breach corpus would be a false statement about what the service verified, and this
 * codebase does not make those. A real corpus (a k-anonymity range query against a breach API, or
 * a local list) is the upgrade, and it goes behind this same function.
 *
 * Compared after case folding and after stripping the separators people add to get past exactly
 * this kind of list, so `P@ssw0rd-1234` does not sail through a check that `password1234` fails.
 */
const KNOWN_BAD = new Set([
  'password',
  'passwort',
  'contrasena',
  'password1',
  'password123',
  'passwordpassword',
  'letmein',
  'welcome',
  'welcome1',
  'qwerty',
  'qwertyuiop',
  'iloveyou',
  'admin',
  'administrator',
  'changeme',
  'secret',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'trustno1',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  '12345678910',
  'abc123',
  'abcd1234',
  'aaaaaaaaaaaa',
  'zaq12wsx',
  'qazwsxedc',
  'erly',
  'erlyadverse',
  'adversesearch',
  'adversemedia',
  'sanctions',
  'compliance',
  'screening',
]);

/** Fold to the form the list is written in: lower case, letters and digits only. */
function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^a-z0-9]/gu, '');
}

/**
 * The symbol half of leet, applied **before** folding strips punctuation.
 *
 * `P@ssw0rd` is the case that makes this necessary: folding first deletes the `@` outright and
 * leaves `pssw0rd`, which is in no list and never will be. The substitution has to happen while
 * the symbol is still there.
 */
function deSymbol(value: string): string {
  return value
    .replace(/@/gu, 'a')
    .replace(/\$/gu, 's')
    .replace(/!/gu, 'i')
    .replace(/\+/gu, 't')
    .replace(/\(/gu, 'c');
}

/** `password1234` and `password` are the same password. */
function stripTrailingDigits(value: string): string {
  return value.replace(/[0-9]+$/u, '');
}

/**
 * Leet substitutions, so `p@ssw0rd` folds onto `password`.
 *
 * Applied as a second candidate rather than in place of the first: `4` is a legitimate character
 * in a passphrase, and folding it to `a` unconditionally would reject passwords that only look
 * like bad ones after the substitution.
 */
function deLeet(folded: string): string {
  return folded
    .replace(/0/gu, 'o')
    .replace(/1/gu, 'i')
    .replace(/3/gu, 'e')
    .replace(/4/gu, 'a')
    .replace(/5/gu, 's')
    .replace(/7/gu, 't')
    .replace(/8/gu, 'b')
    .replace(/9/gu, 'g');
}

export interface PasswordContext {
  /** The address the account is for. A password that contains it is one a list of customers gives away. */
  readonly email?: string | undefined;
  /** Same reasoning, for the organisation name — which is public, and often on the website. */
  readonly organisationName?: string | undefined;
}

export type PasswordVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: PasswordRejection; readonly detail: string };

/**
 * Length, known-bad values, and the two strings the signup request already contains.
 *
 * No composition rules — no "one capital and one symbol". NIST SP 800-63B's position, and the one
 * taken here, is that those rules push people to `Password1!` and buy very little; length plus a
 * known-bad check buys a great deal more. The trade is deliberate, not an omission.
 *
 * Pure: no clock, no database, no network. Which is what lets every rule below be asserted in a
 * unit test with nothing running.
 */
export function assessPassword(password: string, context: PasswordContext = {}): PasswordVerdict {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      rejection: 'TOO_SHORT',
      detail: `A password must be at least ${String(PASSWORD_MIN_LENGTH)} characters. Length is what resists guessing; there are no rules here about capitals or symbols.`,
    };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      rejection: 'TOO_LONG',
      detail: `A password may be at most ${String(PASSWORD_MAX_LENGTH)} characters.`,
    };
  }

  const folded = fold(password);

  // The candidates, and the order matters at every step. `P@ssw0rd-1234` is the worked example:
  // substitute symbols first (`@` would otherwise be *deleted* by folding, leaving `pssw0rd`),
  // fold to `passw0rd1234`, strip the trailing digits to `passw0rd`, and only then turn `0` into
  // `o` — which finally matches `password`. Reorder any two of those and it sails through.
  const candidates = new Set<string>([folded, fold(deSymbol(password))]);
  for (const candidate of [...candidates]) {
    candidates.add(stripTrailingDigits(candidate));
  }
  for (const candidate of [...candidates]) {
    candidates.add(deLeet(candidate));
  }

  for (const candidate of candidates) {
    if (candidate.length >= 4 && KNOWN_BAD.has(candidate)) {
      return {
        ok: false,
        rejection: 'TOO_COMMON',
        detail:
          'This password is one of the first an attacker tries — or one of them with digits ' +
          'appended or letters swapped for lookalike digits, which are the first two variations. ' +
          'Choose something else; a passphrase of a few unrelated words is both stronger and ' +
          'easier to remember.',
      };
    }
  }

  const email = context.email === undefined ? '' : fold(context.email);
  const localPart = context.email === undefined ? '' : fold(context.email.split('@')[0] ?? '');
  if (
    email.length > 0 &&
    (folded.includes(email) || (localPart.length >= 4 && folded.includes(localPart)))
  ) {
    return {
      ok: false,
      rejection: 'CONTAINS_EMAIL',
      detail:
        'A password must not contain the email address it signs in with. Anyone holding a list ' +
        'of addresses would try that first.',
    };
  }

  const organisation = context.organisationName === undefined ? '' : fold(context.organisationName);
  if (organisation.length >= 4 && folded.includes(organisation)) {
    return {
      ok: false,
      rejection: 'CONTAINS_ORGANISATION',
      detail:
        'A password must not contain the organisation name. It is public, it is on the website, ' +
        'and it is the second thing an attacker tries.',
    };
  }

  return { ok: true };
}

/** Hash a password for storage. The plaintext exists only as this argument. */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Check a password against a stored hash.
 *
 * Returns `false` rather than throwing on a malformed or unrecognised hash. A stored value this
 * cannot parse is a failed authentication, not a 500 — and a 500 here would tell an attacker,
 * precisely, which accounts have a hash in a format the service no longer understands.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Whether a stored hash was made with weaker parameters than today's.
 *
 * The caller re-hashes on the next successful sign-in, when the plaintext is briefly in hand.
 * That is the only moment a store can be strengthened without asking every customer to reset.
 *
 * Compared **parameter by parameter, and only in the weaker direction**. A hash made with *more*
 * memory than the current policy is not re-hashed down to it: that would quietly weaken every
 * account on a deployment whose parameters were lowered, which is the opposite of what a
 * needs-rehash check is for. The algorithm is checked too, since a hash that is not argon2id
 * fails the policy however generous its cost parameters are.
 */
export function passwordNeedsRehash(storedHash: string): boolean {
  try {
    const parsed = parseOptions(storedHash);
    return (
      parsed.algorithm !== ARGON2_OPTIONS.algorithm ||
      parsed.memoryCost < ARGON2_OPTIONS.memoryCost ||
      parsed.timeCost < ARGON2_OPTIONS.timeCost ||
      parsed.parallelism < ARGON2_OPTIONS.parallelism
    );
  } catch {
    // Unparseable: whatever it is, it is not a hash made under today's policy.
    return true;
  }
}
