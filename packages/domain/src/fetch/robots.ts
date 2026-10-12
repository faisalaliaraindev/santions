/**
 * FR-06 — robots.txt, parsed and applied.
 *
 * "robots.txt honoured, with a per-source, per-jurisdiction exception process recorded in the
 * registry and approved by a named person — never a global setting."
 *
 * Pure. Given the text of a robots.txt and a path, this says whether we may fetch it. Fetching
 * the file, caching it and deciding what to do when it cannot be fetched are the adapter's job.
 *
 * # The decision that matters most is the one about failure
 *
 * A publisher who blocks us has said no, and that is easy. The hard case is **not being able to
 * tell**: robots.txt times out, returns a 500, or returns an HTML error page. The tempting
 * reading is "no rule found, therefore allowed", and it is wrong — it makes an outage at the
 * publisher into permission. `robotsUnavailable` returns `UNKNOWN`, and the caller's gate treats
 * `UNKNOWN` as a refusal unless the source registry carries an approved exception.
 *
 * A 404 is different and is treated as permission: a site with no robots.txt has not restricted
 * anything, which is the settled convention and the publisher's own choice not to write one.
 */

export type RobotsVerdict = 'ALLOWED' | 'DISALLOWED' | 'UNKNOWN';

export interface RobotsRule {
  /** `allow` or `disallow`. */
  readonly kind: 'ALLOW' | 'DISALLOW';
  /** The path pattern as written, supporting `*` and `$` per the de facto standard. */
  readonly pattern: string;
}

export interface RobotsGroup {
  /** Lower-cased user-agent tokens this group applies to. `*` is the catch-all. */
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
  /** Seconds the publisher asks us to wait between requests. Null when unstated. */
  readonly crawlDelaySeconds: number | null;
}

export interface RobotsFile {
  readonly groups: readonly RobotsGroup[];
  /** True when the file was fetched and parsed; false when we could not tell. */
  readonly known: boolean;
}

/** The file could not be read. Not the same as "no rules". */
export function robotsUnavailable(): RobotsFile {
  return { groups: [], known: false };
}

/** A site with no robots.txt has restricted nothing. */
export function robotsAbsent(): RobotsFile {
  return { groups: [], known: true };
}

/**
 * Parse a robots.txt.
 *
 * Follows the de facto standard rather than the 1994 draft: `Allow` is honoured, `*` and `$`
 * are wildcards, and the most specific matching rule wins. Unknown directives are ignored
 * rather than treated as errors — real files carry `Sitemap`, `Host`, comments and typos, and a
 * parser that refuses the whole file over one unrecognised line ends up honouring nothing.
 */
export function parseRobots(text: string): RobotsFile {
  const groups: RobotsGroup[] = [];

  let agents: string[] = [];
  let rules: RobotsRule[] = [];
  let crawlDelay: number | null = null;
  // True while consecutive `User-agent` lines are accumulating into one group.
  let collectingAgents = false;

  const flush = (): void => {
    if (agents.length > 0) {
      groups.push({ agents, rules, crawlDelaySeconds: crawlDelay });
    }
    agents = [];
    rules = [];
    crawlDelay = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') {
      continue;
    }

    const at = line.indexOf(':');
    if (at === -1) {
      continue;
    }
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();

    if (field === 'user-agent') {
      // A new agent line after rules have started means a new group.
      if (!collectingAgents && rules.length > 0) {
        flush();
      }
      agents.push(value.toLowerCase());
      collectingAgents = true;
      continue;
    }

    collectingAgents = false;

    if (field === 'disallow') {
      // `Disallow:` with an empty value means "nothing is disallowed" — it is an allow.
      rules.push({
        kind: value === '' ? 'ALLOW' : 'DISALLOW',
        pattern: value === '' ? '/' : value,
      });
    } else if (field === 'allow') {
      if (value !== '') {
        rules.push({ kind: 'ALLOW', pattern: value });
      }
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        crawlDelay = seconds;
      }
    }
  }

  flush();
  return { groups, known: true };
}

/**
 * May this user agent fetch this path?
 *
 * Group selection follows the standard: the most specific matching user-agent group wins, and
 * `*` is used only when no named group matches. Within a group, the **longest** matching
 * pattern wins, and `Allow` beats `Disallow` on an exact-length tie — which is what lets a
 * publisher disallow a directory and permit one file inside it.
 */
export function robotsVerdict(robots: RobotsFile, userAgent: string, path: string): RobotsVerdict {
  if (!robots.known) {
    // We could not read the file. Silence is not consent: an outage at the publisher must not
    // become permission. The caller decides what to do with UNKNOWN.
    return 'UNKNOWN';
  }

  const agent = userAgent.toLowerCase();
  const named = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const applicable = named.length > 0 ? named : robots.groups.filter((g) => g.agents.includes('*'));

  if (applicable.length === 0) {
    return 'ALLOWED';
  }

  let best: { rule: RobotsRule; length: number } | null = null;
  for (const group of applicable) {
    for (const rule of group.rules) {
      if (!matchesPattern(rule.pattern, path)) {
        continue;
      }
      const length = specificity(rule.pattern);
      if (
        best === null ||
        length > best.length ||
        // Equal specificity: Allow wins. This is what makes "disallow /news/, allow /news/free"
        // behave the way a publisher expects when the patterns are the same length.
        (length === best.length && rule.kind === 'ALLOW')
      ) {
        best = { rule, length };
      }
    }
  }

  if (best === null) {
    return 'ALLOWED';
  }
  return best.rule.kind === 'ALLOW' ? 'ALLOWED' : 'DISALLOWED';
}

/** The crawl delay the publisher asked for, for the groups that apply to us. */
export function crawlDelayFor(robots: RobotsFile, userAgent: string): number | null {
  const agent = userAgent.toLowerCase();
  const named = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a)));
  const applicable = named.length > 0 ? named : robots.groups.filter((g) => g.agents.includes('*'));

  const delays = applicable.map((g) => g.crawlDelaySeconds).filter((d): d is number => d !== null);

  // The most conservative request wins. A publisher asking for 10 seconds in one group and 1 in
  // another has still asked for 10 somewhere, and honouring the smaller one is choosing the
  // reading that suits us.
  return delays.length === 0 ? null : Math.max(...delays);
}

/** `*` matches any run of characters; a trailing `$` anchors the end. */
function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const expression = body
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  return new RegExp(`^${expression}${anchored ? '$' : ''}`).test(path);
}

/** Longer patterns are more specific. Wildcards do not count toward length. */
function specificity(pattern: string): number {
  return pattern.replace(/[*$]/g, '').length;
}
