#!/usr/bin/env node
/**
 * A worked integration, in the shape an integrating application actually needs.
 *
 * Run it against a local stack:
 *
 *   pnpm demo:api            # once, to prove the service works end to end
 *   node examples/zquence-integration.mjs --api-key <key> --name "María Fernanda Solís Rojas"
 *
 * It uses the same typed client that ships in `packages/client`, so this file is the
 * documentation of the integration rather than a parallel implementation of it.
 *
 * # The four things an integrator must get right
 *
 * Everything below is ordinary code except for four points, and those four are the whole reason
 * this file exists. Each is marked **(1)**–**(4)** where it happens.
 *
 * 1. **A submitted search is not a result.** `createSearch` returns 202 and a `searchId`. A
 *    caller that renders the response has rendered a queued run, whose `findings` field reads
 *    `NOT_EVALUATED` — which looks like "nothing found" to anybody not reading closely.
 *
 * 2. **Findings must be read with coverage.** An empty `findings` array means "nothing was
 *    promoted", not "there is nothing". `coverage` says whether the run searched what it
 *    promised, and `noMatchStatement` says in words what an empty result does and does not mean.
 *
 * 3. **A band is not a score, and must not be turned into one.** There is no number here on
 *    purpose (invariant I9). Ranking, averaging or thresholding bands reintroduces exactly the
 *    arithmetic the bands exist to prevent.
 *
 * 4. **Adverse-media results and sanctions-list results are different things.** A designation
 *    reported in the media is a *lead to verify against the primary list*, never a sanctions
 *    hit. Zquence keeps its sanctions.io integration; these two must be rendered as separate,
 *    clearly labelled sections and never merged into one list.
 */

import { AdverseSearchClient } from '../packages/client/dist/index.js';

function arg(name, fallback = undefined) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const client = new AdverseSearchClient({
  baseUrl: arg('base-url', 'http://127.0.0.1:3000'),
  apiKey: arg('api-key') ?? process.env.ADVERSE_API_KEY ?? '',
});

async function screen({ name, externalCaseRef }) {
  // ---- Record the subject ----------------------------------------------------------------
  // A name is enough. Anything more — a date of birth, a known company — materially improves
  // identity resolution, and supplying nothing is a supported, honest outcome: the result comes
  // back unresolved rather than guessed.
  const subject = await client.createSubject({
    fullName: name,
    aliases: [],
    countryContext: ['CR'],
    knownCompanies: [],
    purpose: 'CUSTOMER_ONBOARDING',
    ...(externalCaseRef === undefined ? {} : { externalCaseRef }),
  });

  // ---- Submit ----------------------------------------------------------------------------
  // (1) This returns 202. It is a receipt, not an answer.
  //
  // The idempotency key is the caller's case reference, which is the right choice: submitting
  // the same case twice should not create two runs, and only the caller knows what "the same
  // case" means.
  const accepted = await client.createSearch(
    {
      environment: 'sandbox',
      subjectRef: { subjectId: subject.subjectId, version: subject.version },
      requestedScope: {
        jurisdictions: ['CR'],
        languages: ['es'],
        includeFormerDirectorships: false,
        fromDate: null,
      },
    },
    { idempotencyKey: externalCaseRef ?? `case-${subject.subjectId}` },
  );

  // ---- Wait ------------------------------------------------------------------------------
  // Polling is shown here because it needs no inbound endpoint. `waitForSearch` throws on
  // timeout rather than handing back a QUEUED run, so there is no path where a half-finished
  // search is mistaken for a finished one.
  await client.waitForSearch(accepted.searchId, { timeoutMs: 120_000 });

  // ---- Read ------------------------------------------------------------------------------
  // (2) Findings and coverage arrive together and are read together.
  const page = await client.getFindings(accepted.searchId);
  const graph = await client.getAssociations(accepted.searchId);

  return { searchId: accepted.searchId, page, graph };
}

function render({ searchId, page, graph }) {
  console.log(`\nSearch ${searchId}`);
  console.log(
    `  execution ${page.execution} · findings ${page.findingsState} · coverage ${page.coverage}`,
  );

  // (2) The empty case is not "clear". It is a qualified statement about what was searched.
  if (page.findings.length === 0 && page.noMatchStatement !== null) {
    console.log(`\n  ${page.noMatchStatement.headline}`);
    for (const line of page.noMatchStatement.limitations) console.log(`    - ${line}`);
    console.log(`    ${page.noMatchStatement.disclaimer}`);
  }

  // (3) Findings are listed in the order they were produced and are NOT sorted by band. A band
  // is a statement about how well evidence supports a connection, not a severity ranking, and
  // sorting by it presents it as one.
  for (const finding of page.findings) {
    console.log(`\n  [${finding.band}] ${finding.document.title}`);
    console.log(`    ${finding.document.publisher} — ${finding.document.url}`);
    console.log(`    category ${finding.category} · stage ${finding.proceduralStage}`);
    console.log(
      `    identity ${finding.axes.identity} · attribution ${finding.axes.attribution} · ` +
        `independent sources ${finding.axes.independenceCount}`,
    );
    if (finding.attribution.isInference) {
      console.log(`    INFERENCE: ${finding.attribution.statement}`);
    }
    for (const line of finding.rationale) console.log(`      · ${line}`);
  }

  // (4) A designation reported in the media is a lead to verify against the primary list. If
  // your application also holds sanctions.io results, render them in a separate, clearly
  // labelled section — never merged with these.
  const designations = page.findings.filter((f) => f.proceduralStage === 'DESIGNATION_SANCTION');
  if (designations.length > 0) {
    console.log(
      `\n  ${String(designations.length)} finding(s) report a designation. These are LEADS to ` +
        `verify against the primary sanctions list — they are not sanctions hits.`,
    );
  }

  if (page.rejectedLeads.length > 0) {
    console.log(`\n  Found and not promoted (${String(page.rejectedLeads.length)}):`);
    for (const lead of page.rejectedLeads) console.log(`    - ${lead.title}: ${lead.reason}`);
  }

  console.log(
    `\n  Association graph: ${String(graph.edges.length)} edge(s), coverage ${graph.coverage.outcome}`,
  );
  for (const edge of graph.edges) {
    console.log(`    - ${edge.companyName} (${edge.role}) · ${edge.resolution} · ${edge.currency}`);
  }

  if (page.unmeasuredLanguages.length > 0) {
    console.log(
      `\n  Languages searched with no measured recall figure: ${page.unmeasuredLanguages.join(', ')}.`,
    );
  }
  console.log(
    `\n  mode: ${page.mode}${page.mode === 'MOCK' ? ' — fixture data, not live sources.' : ''}`,
  );
}

const name = arg('name', 'María Fernanda Solís Rojas');
screen({ name, externalCaseRef: arg('case-ref') })
  .then(render)
  .catch((error) => {
    // The client raises a typed error carrying the service's own code and correlation id. Branch
    // on `code`, never on the message: messages are for people, codes are for programs.
    console.error(`\nFailed: [${error.code ?? 'UNKNOWN'}] ${error.message}`);
    if (error.correlationId) console.error(`Correlation id: ${error.correlationId}`);
    process.exitCode = 1;
  });
