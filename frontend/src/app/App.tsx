import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { NotImplemented } from '../components/NotImplemented.tsx';
import { createQueryClient } from './query-client.ts';

/**
 * Application shell.
 *
 * The FR-14 pages are *not* implemented, and are deliberately not stubbed with hard-coded
 * data. The plan is explicit that the panel must be backed by the real API rather than mock
 * screens, and the API does not exist yet (gate G3). Each route therefore states what it
 * will be and which gate delivers it, rather than showing a fabricated search result.
 */
export function App() {
  const [queryClient] = useState(createQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route
            path="/dashboard"
            element={
              <NotImplemented
                page="Dashboard"
                gate="G8"
                describes="Recent searches, queued and running jobs, incomplete coverage, review workload and the OUTCOME_UNKNOWN queue."
                blockedBy="G3 — the API and authenticated session do not exist yet."
              />
            }
          />
          <Route
            path="/searches/new"
            element={
              <NotImplemented
                page="New search"
                gate="G8"
                describes="Identity, permitted scope, companies, enabled categories, policy, validation and an explicit mock/live label."
                blockedBy="G3 — subject snapshots and search creation are not implemented."
              />
            }
          />
          <Route
            path="/searches/:searchId"
            element={
              <NotImplemented
                page="Search progress and results"
                gate="G8"
                describes="Meaningful stage counts, cascade rung reached and warnings — never a fabricated percentage. Findings filterable by every FR-11 attribute, with a coverage summary independent of the match count."
                blockedBy="G6 and G7 — discovery, fetch, extraction and classification are not implemented."
              />
            }
          />
          <Route
            path="/coverage"
            element={
              <NotImplemented
                page="Coverage matrix"
                gate="G8"
                describes="Per-jurisdiction and per-language source coverage, measured recall where available, and the declared archive horizon."
                blockedBy="G10 — no source has been measured, so there is nothing truthful to display."
              />
            }
          />
          <Route
            path="*"
            element={
              <NotImplemented
                page="Not found"
                gate="—"
                describes="No route matches this address."
                blockedBy={null}
              />
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
