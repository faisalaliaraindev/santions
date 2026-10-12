/**
 * FR-06 — robots.txt.
 *
 * The case that matters most is the one where we cannot tell: an unreadable robots.txt must
 * never become permission.
 */

import { describe, expect, it } from 'vitest';

import {
  crawlDelayFor,
  parseRobots,
  robotsAbsent,
  robotsUnavailable,
  robotsVerdict,
} from '../../src/index.js';

const UA = 'ErlyAdverseSearch/1.0 (+https://example.com/bot)';

describe('when we cannot read robots.txt', () => {
  it('answers UNKNOWN, never ALLOWED', () => {
    // Silence is not consent. An outage at the publisher must not become permission.
    expect(robotsVerdict(robotsUnavailable(), UA, '/anything')).toBe('UNKNOWN');
  });

  it('treats a site with no robots.txt as unrestricted', () => {
    // Different case, different answer: the publisher chose not to write one.
    expect(robotsVerdict(robotsAbsent(), UA, '/anything')).toBe('ALLOWED');
  });
});

describe('basic rules', () => {
  const robots = parseRobots(`
    User-agent: *
    Disallow: /private/
    Allow: /private/public-notice
    Disallow: /admin
  `);

  it('disallows a blocked directory', () => {
    expect(robotsVerdict(robots, UA, '/private/file')).toBe('DISALLOWED');
  });

  it('honours a more specific Allow inside a disallowed directory', () => {
    expect(robotsVerdict(robots, UA, '/private/public-notice')).toBe('ALLOWED');
  });

  it('allows anything no rule covers', () => {
    expect(robotsVerdict(robots, UA, '/sucesos/caso-2024')).toBe('ALLOWED');
  });

  it('treats an empty Disallow as permission', () => {
    expect(robotsVerdict(parseRobots('User-agent: *\nDisallow:'), UA, '/x')).toBe('ALLOWED');
  });
});

describe('user-agent group selection', () => {
  const robots = parseRobots(`
    User-agent: *
    Disallow: /

    User-agent: erlyadversesearch
    Disallow: /paywall/
  `);

  it('uses the group naming us rather than the catch-all', () => {
    expect(robotsVerdict(robots, UA, '/news/story')).toBe('ALLOWED');
    expect(robotsVerdict(robots, UA, '/paywall/story')).toBe('DISALLOWED');
  });

  it('falls back to the catch-all for an agent with no group of its own', () => {
    expect(robotsVerdict(robots, 'SomeOtherBot/2.0', '/news/story')).toBe('DISALLOWED');
  });
});

describe('wildcards', () => {
  const robots = parseRobots(`
    User-agent: *
    Disallow: /*.pdf$
    Disallow: /search?
  `);

  it('honours a trailing-anchored extension rule', () => {
    expect(robotsVerdict(robots, UA, '/docs/report.pdf')).toBe('DISALLOWED');
    // Anchored: the extension must end the path.
    expect(robotsVerdict(robots, UA, '/docs/report.pdf.html')).toBe('ALLOWED');
  });

  it('honours a mid-pattern wildcard', () => {
    expect(robotsVerdict(robots, UA, '/search?q=x')).toBe('DISALLOWED');
  });
});

describe('parsing real-world files', () => {
  it('ignores comments, blank lines and directives it does not know', () => {
    const robots = parseRobots(`
      # a comment
      Sitemap: https://example.cr/sitemap.xml
      Host: example.cr

      User-agent: *
      Disallow: /private/   # trailing comment
      Unknown-Directive: whatever
    `);
    expect(robotsVerdict(robots, UA, '/private/x')).toBe('DISALLOWED');
    expect(robotsVerdict(robots, UA, '/x')).toBe('ALLOWED');
  });

  it('applies one rule set to several user-agent lines stacked together', () => {
    const robots = parseRobots(`
      User-agent: botA
      User-agent: botB
      Disallow: /x
    `);
    expect(robotsVerdict(robots, 'botA', '/x')).toBe('DISALLOWED');
    expect(robotsVerdict(robots, 'botB', '/x')).toBe('DISALLOWED');
    expect(robotsVerdict(robots, 'botC', '/x')).toBe('ALLOWED');
  });

  it('does not fall over on an empty file', () => {
    expect(robotsVerdict(parseRobots(''), UA, '/x')).toBe('ALLOWED');
  });
});

describe('crawl delay', () => {
  it('reads the delay the publisher asked for', () => {
    const robots = parseRobots('User-agent: *\nCrawl-delay: 10\nDisallow:');
    expect(crawlDelayFor(robots, UA)).toBe(10);
  });

  it('takes the most conservative delay when groups disagree', () => {
    // Honouring the smaller one is choosing the reading that suits us.
    const robots = parseRobots(
      'User-agent: *\nCrawl-delay: 1\nDisallow:\n\nUser-agent: erlyadversesearch\nCrawl-delay: 10\nDisallow:',
    );
    expect(crawlDelayFor(robots, UA)).toBe(10);
  });

  it('returns null when none is stated, rather than inventing one', () => {
    expect(crawlDelayFor(parseRobots('User-agent: *\nDisallow:'), UA)).toBeNull();
  });
});
