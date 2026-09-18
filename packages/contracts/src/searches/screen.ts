/**
 * `POST /v1/screen` — one call, a name in, a finished result out.
 *
 * Every other route on this service is deliberately asynchronous. `POST /v1/searches` answers
 * `202` with a status URL because a run takes as long as the publishers take, and returning a
 * result-shaped body to a caller whose work has not started is how "accepted" gets read as
 * "completed with no findings". None of that changes. This route does not replace it.
 *
 * What this route is for is the case the async pair serves badly: **a caller who wants one
 * answer and has nowhere to put a callback** — a demonstration, a manual check, a spreadsheet
 * macro, an analyst with a name and a question. For those, four round trips (create subject,
 * create search, poll, read findings) is four opportunities to show a partial state that means
 * nothing on its own.
 *
 * # It is the same run, not a shortcut past one
 *
 * The request creates a real subject version and a real search run, executes the **same**
 * pipeline through the **same** job handler under the **same** stage lease the worker would
 * take, and stores the same records. `searchId` comes back on the response, and every async
 * route works against it afterwards. Nothing here is a second, weaker path: if this answers,
 * `POST /v1/searches` answers identically, and the reverse.
 *
 * The stage lease is the load-bearing part. The run is queued as usual, so the worker will
 * receive it; taking the lease here means the worker finds the stage already finished and
 * discards its delivery, rather than both of them doing the work.
 *
 * # What the caller pays for the convenience
 *
 * **The request is held open for as long as the sources take.** That is the honest cost and it
 * is why this is not the default. A live query feed paced at its recorded ceiling can run for
 * minutes; the response carries `elapsedMs` so the caller can see what it cost rather than
 * inferring it from a stopwatch.
 *
 * It is also why `POST /v1/searches` remains the route for volume: a held connection is a
 * resource this service does not control the lifetime of, and a caller screening a book of
 * business should be queuing, not waiting.
 */

import { z } from 'zod';

import { findingsPageSchema } from './findings.js';
import { findingCountsSchema, searchSummarySchema } from './search.js';
import { aliasSchema, preciseDateSchema, screeningPurposeSchema } from '../subjects/subject.js';

const REGIONAL_PSEUDO_CODES = ['EU', 'EC', 'UK', 'AF', 'AS', 'NA', 'SA', 'OC', 'AN', 'ZZ', 'XX'];

const screenCountryCodeSchema = z
  .string()
  .length(2)
  .regex(/^[A-Za-z]{2}$/, 'Must be an ISO 3166-1 alpha-2 country code.')
  .transform((value) => value.toUpperCase())
  .refine((value) => !REGIONAL_PSEUDO_CODES.includes(value), {
    message:
      'Regional groupings cannot be searched as a jurisdiction. Name each country explicitly ' +
      '(FR-05) — coverage, rights and source permissions are all recorded per country.',
  });

/**
 * The smallest honest request: a name and why you are asking.
 *
 * `purpose` is **not** optional and never will be. FR-01 requires it and SEC-05 treats purpose
 * limitation as a data-protection control, not paperwork: it decides what may be retained and
 * for how long. A convenience route that dropped it would be a convenience route that quietly
 * retained personal data under no stated basis.
 *
 * Everything else has a default, because a demonstration should not have to know the shape of
 * the scope object to ask a question. The defaults are narrow on purpose and the response
 * states what was actually searched, which may be narrower still.
 */
export const screenRequestSchema = z
  .object({
    /** The full name as written, in its original script. Not split into parts. */
    fullName: z.string().min(1).max(500),

    aliases: z.array(aliasSchema).max(50).default([]),

    /** Partial dates are supported. Sparse identity stays unresolved, never invented (FR-01). */
    dateOfBirth: preciseDateSchema.optional(),

    /** Identity context, not a search scope. */
    countryContext: z.array(z.string().length(2).toUpperCase()).max(20).default([]),

    purpose: screeningPurposeSchema,

    /**
     * Where to search. Defaults to `['US']` — the only jurisdiction any currently active source
     * covers, so a default of anything wider would promise reach this deployment does not have.
     */
    jurisdictions: z.array(screenCountryCodeSchema).min(1).max(50).default(['US']),

    /**
     * Which languages. Defaults to `['en']`.
     *
     * No language has a measured recall figure (FR-03), so **every** language a run searches in
     * is reported as unmeasured in the coverage statement. The default does not change that and
     * is not a claim that English is covered.
     */
    languages: z.array(z.string().max(35)).min(1).max(30).default(['en']),

    /** Historical directorships require an approved historical scope (FR-02). */
    includeFormerDirectorships: z.boolean().default(false),

    /** Recorded so an integrator can correlate. Not a lookup instruction (section 4.1). */
    externalCaseRef: z.string().max(200).optional(),

    /** `sandbox` cannot run live searches or reach live evidence (FR-15). */
    environment: z.enum(['sandbox', 'live']).default('sandbox'),
  })
  .strict();

export type ScreenRequest = z.infer<typeof screenRequestSchema>;

/**
 * The finished result.
 *
 * It is the findings page, plus the identifiers needed to go on working with the run through
 * the ordinary routes, plus what it cost. Deliberately **not** a reduced "matched: true/false"
 * shape: the three result dimensions exist because "the job finished", "we found nothing" and
 * "we searched everything we said we would" are three different facts, and a convenience route
 * that collapsed them would be the exact failure section 6.2 is written against.
 */
export const screenResultSchema = z
  .object({
    /** The run this created. Every `/v1/searches/{id}` route works against it afterwards. */
    searchId: z.string(),
    /** The subject version created from the snapshot, pinned to this run. */
    subjectId: z.string(),
    subjectVersion: z.number().int().positive(),

    /** Section 6.2's three dimensions. Read them together; none of them stands alone. */
    execution: searchSummarySchema.shape.execution,
    findingsState: searchSummarySchema.shape.findings,
    coverage: searchSummarySchema.shape.coverage,
    findingCounts: findingCountsSchema,

    /** `MOCK` means fixture data. It is never servable as a live result (T55). */
    mode: z.enum(['MOCK', 'LIVE']),

    /** The full page, identical to `GET /v1/searches/{searchId}/findings`. */
    result: findingsPageSchema,

    /** How long the caller waited. Stated rather than left to a stopwatch. */
    elapsedMs: z.number().int().nonnegative(),
  })
  .strict();

export type ScreenResult = z.infer<typeof screenResultSchema>;
