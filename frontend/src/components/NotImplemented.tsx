import { Link } from 'react-router-dom';

export interface NotImplementedProps {
  readonly page: string;
  /** The gate that delivers this page, or '—' where none applies. */
  readonly gate: string;
  /** What the page will show once built. */
  readonly describes: string;
  /** What has to exist first. Null when nothing is blocking. */
  readonly blockedBy: string | null;
}

/**
 * Stands in for an FR-14 page that is not built.
 *
 * It shows no data, because there is no data — and a screening panel that displays plausible
 * fabricated findings is worse than one that displays nothing. The plan forbids mock screens
 * for exactly this reason. This component states what the page will be, which gate delivers
 * it and what is blocking it, so a reader can tell "not built yet" from "built and empty".
 */
export function NotImplemented({ page, gate, describes, blockedBy }: NotImplementedProps) {
  return (
    <main className="page">
      <nav aria-label="Sections" className="page__nav">
        <Link to="/dashboard">Dashboard</Link>
        <Link to="/searches/new">New search</Link>
        <Link to="/coverage">Coverage matrix</Link>
      </nav>

      <article className="notice">
        <p className="notice__badge">Not implemented{gate === '—' ? '' : ` · gate ${gate}`}</p>
        <h1 className="notice__title">{page}</h1>
        <p className="notice__body">{describes}</p>

        {blockedBy !== null && (
          <p className="notice__blocked">
            <strong>Blocked by:</strong> {blockedBy}
          </p>
        )}

        <p className="notice__footnote">
          This page shows no data because none exists yet. It is not a preview and not a mock-up —
          the control panel is backed by the real service API, and that API is not built. See{' '}
          <code>docs/implementation-status.md</code> in the backend repository for gate-by-gate
          status.
        </p>
      </article>
    </main>
  );
}
