import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { NotImplemented } from './NotImplemented.tsx';

function renderPage(props: Partial<React.ComponentProps<typeof NotImplemented>> = {}) {
  return render(
    <MemoryRouter>
      <NotImplemented
        page="Dashboard"
        gate="G8"
        describes="Recent searches and review workload."
        blockedBy="G3 — the API does not exist yet."
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('NotImplemented', () => {
  it('says plainly that the page is not built, and which gate delivers it', () => {
    renderPage();
    expect(screen.getByText(/Not implemented · gate G8/u)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  it('names what is blocking it', () => {
    renderPage();
    expect(screen.getByText(/the API does not exist yet/u)).toBeInTheDocument();
  });

  it('omits the blocked notice when nothing is blocking', () => {
    renderPage({ blockedBy: null });
    expect(screen.queryByText(/Blocked by:/u)).not.toBeInTheDocument();
  });

  it('states that it is not a preview, so an empty page is not mistaken for an empty result', () => {
    renderPage();
    expect(screen.getByText(/not a preview and not a\s+mock-up/u)).toBeInTheDocument();
  });

  it('exposes a labelled navigation landmark for keyboard and screen-reader users', () => {
    renderPage();
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
