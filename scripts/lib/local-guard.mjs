/**
 * Shared guard: refuse to touch anything that is not local.
 *
 * Used by both `local:bootstrap` (which writes seed data) and `local:reset` (which destroys
 * volumes). A seeding script that can reach a real endpoint is a seeding script that
 * eventually seeds one.
 */

const LOCAL_HOST =
  /(^|\/\/)(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|host\.docker\.internal)([:/]|$)/u;

export function isLocalEndpoint(value) {
  return value === undefined || value === '' || LOCAL_HOST.test(value);
}

/**
 * Throws unless every supplied endpoint is local.
 *
 * `entries` is an object of { LABEL: value }, so the error can name exactly which variable
 * is pointing somewhere it should not.
 */
export function assertLocalOnly(entries, action = 'run') {
  const offenders = Object.entries(entries)
    .filter(([, value]) => !isLocalEndpoint(value))
    .map(([label, value]) => `  ${label}=${value}`);

  if (offenders.length > 0) {
    throw new Error(
      [
        `Refusing to ${action}: the environment points at a non-local endpoint.`,
        ...offenders,
        '',
        'This command only ever operates on the local development stack.',
      ].join('\n'),
    );
  }
}

/** Poll a check until it succeeds or the deadline passes. Returns the check's value. */
export async function waitFor(label, check, { timeoutMs = 120_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  for (;;) {
    try {
      const result = await check();
      if (result !== false) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${String(Math.round(timeoutMs / 1000))}s waiting for ${label}.` +
          (lastError ? `\nLast error: ${String(lastError.message ?? lastError)}` : ''),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Consistent, greppable progress output. */
export const log = {
  step: (message) => {
    console.log(`\n▸ ${message}`);
  },
  created: (message) => {
    console.log(`  created  ${message}`);
  },
  exists: (message) => {
    console.log(`  exists   ${message}`);
  },
  info: (message) => {
    console.log(`  ${message}`);
  },
  warn: (message) => {
    console.warn(`  WARN     ${message}`);
  },
};
