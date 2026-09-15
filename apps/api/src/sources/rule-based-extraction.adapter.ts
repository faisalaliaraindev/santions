/**
 * The live, rule-based `ExtractionModelPort` — decision **D-048**.
 *
 * # Why this exists
 *
 * Live mode had no extractor at all. `buildSourceAdapters` returned `extractionModel: null`, and
 * the pipeline rejects a document when the extractor is null — so a live run discovered real
 * leads, filtered them, passed the fetch gate, opened a real socket, committed real evidence, and
 * then rejected **every** document at `EXTRACTION`, finishing `NO_MATCHES_FOUND`. To anyone
 * reading the result that is indistinguishable from "the source had nothing on this person",
 * which is the worst shape a failure can take in this product.
 *
 * The null was honest — no live extractor existed, and serving the **mock** in live mode would
 * have been far worse (T55). This adapter is the honest thing that also works.
 *
 * # What it is, and what it is not
 *
 * It is **not the D7 model**. D7 is open and cannot close yet: it requires a benchmark, and the
 * labelled set has no document bodies to benchmark against (phase-f.md §3.1). So this is a
 * keyword-and-span extractor, and it says so everywhere a reader can see it — `modelId` and
 * `promptVersion` are null on the adapter and on every assertion it emits, and
 * `extractorVersion` names it as rule-based and unbenchmarked.
 *
 * It is **not the mock**. The mock is `mode: 'MOCK'`, `jurisdictions: ['CR']`, and requires a
 * `MockModeWitness` that a live process cannot construct. Both of those stay exactly as they
 * are: a fixture must never serve a live run.
 *
 * # What it costs, stated plainly (D-048)
 *
 * A keyword extractor finds what its table already knows and nothing else. Recall against real
 * prose will be poor, and it is **unmeasured** — there is no corpus, so no figure can be quoted,
 * and the extraction quality must never be reported as a measurement. It is the same honesty
 * problem as the unreviewed Spanish lexicon (D-033): a term that is not in the table does not
 * fail, it returns nothing. The pipeline puts that sentence in the run's warnings on every run
 * that uses this adapter, because a reader of a result cannot see this file.
 *
 * # The three rules it keeps
 *
 * **Spans, never restatements.** Every claim carries the offsets it came from, in the normalised
 * text. An assertion whose conduct span is null is one a reviewer and the FR-07 validator can
 * both refuse, which is the point.
 *
 * **It never invents a category.** `enabledCategoryIds` is a closed set. A document whose
 * keywords map to a category the tenant has not enabled produces no assertion for that category
 * rather than a nearest-neighbour one — rounding to the nearest enabled category would turn a
 * disabled category into an enabled one at extraction time.
 *
 * **Proximity, not presence.** A conduct term somewhere in a document is not a claim about the
 * subject of the search. A term is only read as being about this person when it sits within
 * `PROXIMITY_WINDOW` characters of a mention of one of the subject's name forms. Long pages
 * carry unrelated crime reporting in their sidebars and their "related articles" lists, and a
 * presence test over a whole page attributes all of it to whoever the page happens to name.
 *
 * **An outcome wins.** Where several stage terms sit near the subject, an **outcome** stage — an
 * acquittal, a dismissal, an overturned conviction — is taken over a non-outcome one. D-047's
 * rule applies to extraction: the acquittal has to come through the pipeline as readily as the
 * accusation, and a rule that took the earliest or the highest match would systematically
 * report the charge and drop the exoneration.
 */

import {
  failed,
  noResults,
  ok,
  type AdapterDescriptor,
  type Clock,
  type SourceOutcome,
} from './source-adapter.js';
import type {
  ExtractedAssertion,
  ExtractionInput,
  ExtractionModelPort,
  TextSpan,
} from './extraction-model.port.js';
import {
  isOutcomeStage,
  stageRung,
  type AdverseCategory,
  type PartyRole,
  type StageValue,
} from '@erly/adverse-domain';

export const RULE_BASED_EXTRACTION_DESCRIPTOR: AdapterDescriptor = {
  adapterId: 'rule-based-extraction',
  portKind: 'EXTRACTION_MODEL',
  // Extraction reads no registry source: it reads whatever document the fetch seam committed.
  // The id names the adapter's own configuration so a record can still be traced to it.
  sourceId: 'src-rule-based-extraction',
  parserVersion: 'rule-1',
  // The "parser" here is this file's own term tables, which change only when someone edits them
  // deliberately and bumps `parserVersion`. Nothing about it is a publisher's undocumented shape.
  stabilityClass: 'DOCUMENTED_STABLE',
  mode: 'LIVE',
  // The term tables are English and Spanish. They are not jurisdiction-specific — a rule that
  // reads "convicted" reads it wherever the document was published — so the countries named are
  // the ones whose reporting the tables were authored against and tested on.
  jurisdictions: ['US', 'GB', 'CR'],
};

/**
 * The version string a reader sees on every finding. It says what produced the assertion,
 * because "rule-based" must not become permanent by default (D-048, START-HERE rule 6).
 */
export const RULE_BASED_EXTRACTOR_VERSION = 'rule-based-1-unbenchmarked';

/** The languages the term tables cover. Nothing else is claimed. */
export const RULE_BASED_EXTRACTION_LANGUAGES: readonly string[] = ['en', 'es'];

/**
 * How near a mention of the subject a term has to be before it is read as being about them.
 *
 * Roughly a long paragraph. Large enough that "Smith … was charged" survives a sentence of
 * intervening detail; small enough that a sidebar three screens away does not attach.
 */
const PROXIMITY_WINDOW = 600;

interface Term {
  readonly term: string;
  readonly categoryId: AdverseCategory;
}

/**
 * Conduct term → category, English and Spanish.
 *
 * Multi-word wherever a single word would fire on ordinary prose. "Fraud" is safe; "penalty" is
 * not, and is absent. A term that produces a false category is worse than a missing term: a
 * missing term returns nothing, a wrong one puts a person in a category of conduct the document
 * never described.
 */
const CONDUCT_TERMS: readonly Term[] = [
  // FRAUD_FINANCIAL_CRIME
  { term: 'fraud', categoryId: 'FRAUD_FINANCIAL_CRIME' },
  { term: 'fraudulent', categoryId: 'FRAUD_FINANCIAL_CRIME' },
  { term: 'defrauded', categoryId: 'FRAUD_FINANCIAL_CRIME' },
  { term: 'ponzi scheme', categoryId: 'FRAUD_FINANCIAL_CRIME' },
  { term: 'embezzlement', categoryId: 'FRAUD_FINANCIAL_CRIME' },
  { term: 'embezzled', categoryId: 'FRAUD_FINANCIAL_CRIME' },
  { term: 'misappropriated', categoryId: 'FRAUD_FINANCIAL_CRIME' },
  { term: 'misappropriation', categoryId: 'FRAUD_FINANCIAL_CRIME' },
  { term: 'fraude', categoryId: 'FRAUD_FINANCIAL_CRIME' },
  { term: 'estafa', categoryId: 'FRAUD_FINANCIAL_CRIME' },
  { term: 'malversación', categoryId: 'FRAUD_FINANCIAL_CRIME' },
  // MARKET_ABUSE
  { term: 'insider trading', categoryId: 'MARKET_ABUSE' },
  { term: 'market manipulation', categoryId: 'MARKET_ABUSE' },
  { term: 'manipulative trading', categoryId: 'MARKET_ABUSE' },
  { term: 'información privilegiada', categoryId: 'MARKET_ABUSE' },
  { term: 'manipulación del mercado', categoryId: 'MARKET_ABUSE' },
  // MONEY_LAUNDERING_TF
  { term: 'money laundering', categoryId: 'MONEY_LAUNDERING_TF' },
  { term: 'terrorist financing', categoryId: 'MONEY_LAUNDERING_TF' },
  { term: 'lavado de dinero', categoryId: 'MONEY_LAUNDERING_TF' },
  { term: 'lavado de activos', categoryId: 'MONEY_LAUNDERING_TF' },
  { term: 'legitimación de capitales', categoryId: 'MONEY_LAUNDERING_TF' },
  { term: 'financiamiento del terrorismo', categoryId: 'MONEY_LAUNDERING_TF' },
  // BRIBERY_CORRUPTION
  { term: 'bribery', categoryId: 'BRIBERY_CORRUPTION' },
  { term: 'bribe', categoryId: 'BRIBERY_CORRUPTION' },
  { term: 'kickback', categoryId: 'BRIBERY_CORRUPTION' },
  { term: 'foreign corrupt practices act', categoryId: 'BRIBERY_CORRUPTION' },
  { term: 'cohecho', categoryId: 'BRIBERY_CORRUPTION' },
  { term: 'soborno', categoryId: 'BRIBERY_CORRUPTION' },
  { term: 'corrupción', categoryId: 'BRIBERY_CORRUPTION' },
  { term: 'peculado', categoryId: 'BRIBERY_CORRUPTION' },
  // SANCTIONS_EVASION_EXPORT_CONTROL
  { term: 'sanctions evasion', categoryId: 'SANCTIONS_EVASION_EXPORT_CONTROL' },
  { term: 'evading sanctions', categoryId: 'SANCTIONS_EVASION_EXPORT_CONTROL' },
  { term: 'export control violation', categoryId: 'SANCTIONS_EVASION_EXPORT_CONTROL' },
  { term: 'evasión de sanciones', categoryId: 'SANCTIONS_EVASION_EXPORT_CONTROL' },
  // TAX_OFFENCES
  { term: 'tax evasion', categoryId: 'TAX_OFFENCES' },
  { term: 'tax fraud', categoryId: 'TAX_OFFENCES' },
  { term: 'evasión fiscal', categoryId: 'TAX_OFFENCES' },
  { term: 'defraudación fiscal', categoryId: 'TAX_OFFENCES' },
  // ORGANISED_CRIME
  { term: 'racketeering', categoryId: 'ORGANISED_CRIME' },
  { term: 'organised crime', categoryId: 'ORGANISED_CRIME' },
  { term: 'organized crime', categoryId: 'ORGANISED_CRIME' },
  { term: 'crimen organizado', categoryId: 'ORGANISED_CRIME' },
  // DRUG_OFFENCES
  { term: 'drug trafficking', categoryId: 'DRUG_OFFENCES' },
  { term: 'narcotics trafficking', categoryId: 'DRUG_OFFENCES' },
  { term: 'narcotráfico', categoryId: 'DRUG_OFFENCES' },
  { term: 'tráfico de drogas', categoryId: 'DRUG_OFFENCES' },
  // HUMAN_TRAFFICKING_MODERN_SLAVERY
  { term: 'human trafficking', categoryId: 'HUMAN_TRAFFICKING_MODERN_SLAVERY' },
  { term: 'forced labour', categoryId: 'HUMAN_TRAFFICKING_MODERN_SLAVERY' },
  { term: 'forced labor', categoryId: 'HUMAN_TRAFFICKING_MODERN_SLAVERY' },
  { term: 'trata de personas', categoryId: 'HUMAN_TRAFFICKING_MODERN_SLAVERY' },
  // TERRORISM_VIOLENT_EXTREMISM
  { term: 'material support for terrorism', categoryId: 'TERRORISM_VIOLENT_EXTREMISM' },
  { term: 'terrorist organisation', categoryId: 'TERRORISM_VIOLENT_EXTREMISM' },
  { term: 'terrorist organization', categoryId: 'TERRORISM_VIOLENT_EXTREMISM' },
  { term: 'terrorismo', categoryId: 'TERRORISM_VIOLENT_EXTREMISM' },
  // VIOLENT_CRIME
  { term: 'homicide', categoryId: 'VIOLENT_CRIME' },
  { term: 'manslaughter', categoryId: 'VIOLENT_CRIME' },
  { term: 'aggravated assault', categoryId: 'VIOLENT_CRIME' },
  { term: 'homicidio', categoryId: 'VIOLENT_CRIME' },
  { term: 'asesinato', categoryId: 'VIOLENT_CRIME' },
  // CYBERCRIME
  { term: 'computer intrusion', categoryId: 'CYBERCRIME' },
  { term: 'ransomware', categoryId: 'CYBERCRIME' },
  { term: 'unauthorised access to computer', categoryId: 'CYBERCRIME' },
  { term: 'delito informático', categoryId: 'CYBERCRIME' },
  // REGULATORY_PROFESSIONAL_MISCONDUCT
  { term: 'unregistered broker', categoryId: 'REGULATORY_PROFESSIONAL_MISCONDUCT' },
  { term: 'professional misconduct', categoryId: 'REGULATORY_PROFESSIONAL_MISCONDUCT' },
  { term: 'ejercicio ilegal de la profesión', categoryId: 'REGULATORY_PROFESSIONAL_MISCONDUCT' },
  // ENVIRONMENTAL_HEALTH_SAFETY
  { term: 'environmental violation', categoryId: 'ENVIRONMENTAL_HEALTH_SAFETY' },
  { term: 'illegal dumping', categoryId: 'ENVIRONMENTAL_HEALTH_SAFETY' },
  { term: 'contaminación ilegal', categoryId: 'ENVIRONMENTAL_HEALTH_SAFETY' },
  // CONSUMER_HARM_MISSELLING
  { term: 'deceptive marketing', categoryId: 'CONSUMER_HARM_MISSELLING' },
  { term: 'mis-selling', categoryId: 'CONSUMER_HARM_MISSELLING' },
  { term: 'publicidad engañosa', categoryId: 'CONSUMER_HARM_MISSELLING' },
  // INSOLVENCY_MISCONDUCT
  { term: 'bankruptcy fraud', categoryId: 'INSOLVENCY_MISCONDUCT' },
  { term: 'quiebra fraudulenta', categoryId: 'INSOLVENCY_MISCONDUCT' },
  // GOVERNANCE_INTEGRITY
  { term: 'breach of fiduciary duty', categoryId: 'GOVERNANCE_INTEGRITY' },
  { term: 'conflict of interest', categoryId: 'GOVERNANCE_INTEGRITY' },
  { term: 'conflicto de interés', categoryId: 'GOVERNANCE_INTEGRITY' },
];

interface StageTerm {
  readonly term: string;
  readonly stage: StageValue;
}

/**
 * Stage term → rung on the FR-09 ladder.
 *
 * `RUMOUR_UNATTRIBUTED` has no terms on purpose: nothing in a keyword table can establish that
 * something is a rumour, and asserting rung 0 from a keyword would be a stage claim with no
 * basis. A document whose stage terms are all absent stays `UNSPECIFIED`, which is what the
 * banding engine is built to handle.
 */
const STAGE_TERMS: readonly StageTerm[] = [
  { term: 'acquitted', stage: 'ACQUITTAL_DISMISSAL_OVERTURNED' },
  { term: 'acquittal', stage: 'ACQUITTAL_DISMISSAL_OVERTURNED' },
  { term: 'charges were dismissed', stage: 'ACQUITTAL_DISMISSAL_OVERTURNED' },
  { term: 'charges were dropped', stage: 'ACQUITTAL_DISMISSAL_OVERTURNED' },
  { term: 'conviction was overturned', stage: 'ACQUITTAL_DISMISSAL_OVERTURNED' },
  { term: 'absolutoria', stage: 'ACQUITTAL_DISMISSAL_OVERTURNED' },
  { term: 'sobreseimiento', stage: 'ACQUITTAL_DISMISSAL_OVERTURNED' },
  { term: 'retraction', stage: 'CORRECTION_RETRACTION' },
  { term: 'rectificación', stage: 'CORRECTION_RETRACTION' },
  { term: 'convicted', stage: 'CONVICTION_FINAL_JUDGMENT' },
  { term: 'conviction', stage: 'CONVICTION_FINAL_JUDGMENT' },
  { term: 'pleaded guilty', stage: 'CONVICTION_FINAL_JUDGMENT' },
  { term: 'pled guilty', stage: 'CONVICTION_FINAL_JUDGMENT' },
  { term: 'final judgment', stage: 'CONVICTION_FINAL_JUDGMENT' },
  { term: 'was sentenced', stage: 'CONVICTION_FINAL_JUDGMENT' },
  { term: 'sentencia condenatoria', stage: 'CONVICTION_FINAL_JUDGMENT' },
  { term: 'fue condenado', stage: 'CONVICTION_FINAL_JUDGMENT' },
  { term: 'consent order', stage: 'SETTLEMENT_CONSENT_ORDER' },
  { term: 'without admitting or denying', stage: 'SETTLEMENT_CONSENT_ORDER' },
  { term: 'agreed to settle', stage: 'SETTLEMENT_CONSENT_ORDER' },
  { term: 'settled the charges', stage: 'SETTLEMENT_CONSENT_ORDER' },
  { term: 'acuerdo conciliatorio', stage: 'SETTLEMENT_CONSENT_ORDER' },
  { term: 'cease-and-desist order', stage: 'REGULATORY_ACTION_FINE' },
  { term: 'civil penalty', stage: 'REGULATORY_ACTION_FINE' },
  { term: 'administrative proceeding', stage: 'REGULATORY_ACTION_FINE' },
  { term: 'sanción administrativa', stage: 'REGULATORY_ACTION_FINE' },
  { term: 'officer-and-director bar', stage: 'DEBARMENT_DISQUALIFICATION' },
  { term: 'was barred from', stage: 'DEBARMENT_DISQUALIFICATION' },
  { term: 'debarred', stage: 'DEBARMENT_DISQUALIFICATION' },
  { term: 'inhabilitación', stage: 'DEBARMENT_DISQUALIFICATION' },
  { term: 'indicted', stage: 'CHARGE_INDICTMENT' },
  { term: 'indictment', stage: 'CHARGE_INDICTMENT' },
  { term: 'criminal charges', stage: 'CHARGE_INDICTMENT' },
  { term: 'charged with', stage: 'CHARGE_INDICTMENT' },
  { term: 'acusación formal', stage: 'CHARGE_INDICTMENT' },
  { term: 'formal charges', stage: 'CHARGE_INDICTMENT' },
  { term: 'arrested', stage: 'RAID_ARREST_DETENTION' },
  { term: 'detenido', stage: 'RAID_ARREST_DETENTION' },
  { term: 'allanamiento', stage: 'RAID_ARREST_DETENTION' },
  { term: 'civil complaint', stage: 'CIVIL_CLAIM_FILED' },
  { term: 'civil action', stage: 'CIVIL_CLAIM_FILED' },
  { term: 'demanda civil', stage: 'CIVIL_CLAIM_FILED' },
  { term: 'filed a complaint', stage: 'COMPLAINT_FILED' },
  { term: 'denuncia', stage: 'COMPLAINT_FILED' },
  { term: 'querella', stage: 'COMPLAINT_FILED' },
  { term: 'under investigation', stage: 'INVESTIGATION_OPENED' },
  { term: 'investigation', stage: 'INVESTIGATION_OPENED' },
  { term: 'investigación', stage: 'INVESTIGATION_OPENED' },
  { term: 'on appeal', stage: 'APPEAL_PENDING' },
  { term: 'apelación', stage: 'APPEAL_PENDING' },
  { term: 'alleged', stage: 'ALLEGATION' },
  { term: 'allegations', stage: 'ALLEGATION' },
  { term: 'presuntamente', stage: 'ALLEGATION' },
];

/**
 * Bodies that can name someone, as they write their own names.
 *
 * A fixed list, not a heuristic. FR-11 bands partly on who said it, so attributing a blog's
 * claim to a prosecutor's office would raise a band on evidence that does not exist — a wrong
 * naming authority is worse than none at all.
 */
const AUTHORITIES: readonly string[] = [
  'Securities and Exchange Commission',
  'Department of Justice',
  'U.S. Attorney',
  'Commodity Futures Trading Commission',
  'Federal Bureau of Investigation',
  'Financial Conduct Authority',
  'Serious Fraud Office',
  'Crown Prosecution Service',
  'Ministerio Público',
  'Fiscalía',
  'Poder Judicial',
  'Tribunal',
  'Procuraduría',
  'Contraloría',
];

/** Stage → the role the text supports. Never stronger than the stage establishes. */
function roleForStage(stage: StageValue): PartyRole {
  switch (stage) {
    case 'CHARGE_INDICTMENT':
    case 'RAID_ARREST_DETENTION':
      return 'ACCUSED_DEFENDANT_CRIMINAL';
    case 'CONVICTION_FINAL_JUDGMENT':
    case 'DEBARMENT_DISQUALIFICATION':
    case 'DESIGNATION_SANCTION':
      return 'CONVICTED_SANCTIONED_PARTY';
    case 'INVESTIGATION_OPENED':
      return 'INVESTIGATED_NOT_CHARGED';
    case 'CIVIL_CLAIM_FILED':
    case 'REGULATORY_ACTION_FINE':
    case 'SETTLEMENT_CONSENT_ORDER':
      return 'DEFENDANT_CIVIL';
    default:
      // Being named in a document is not a role, and a complaint can be criminal in one
      // jurisdiction and civil in another. UNSPECIFIED is the correct answer far more often
      // than any guess, and the banding engine already knows what to do with it.
      return 'UNSPECIFIED';
  }
}

export class RuleBasedExtractionAdapter implements ExtractionModelPort {
  readonly descriptor = RULE_BASED_EXTRACTION_DESCRIPTOR;
  /** Null, and truthfully so: no model participated in this extraction (D-048, FR-07). */
  readonly modelId = null;
  readonly promptVersion = null;

  constructor(private readonly clock: Clock = (): Date => new Date()) {}

  /**
   * There is no model endpoint, so there is nothing to be unreachable.
   *
   * `reachable: true` with `modelId: null` is the pair that says "this extraction runs in this
   * process and calls nothing", which is the answer FR-05 wants from the question "which model
   * actually answered".
   */
  async describeModel(): Promise<{ readonly modelId: string | null; readonly reachable: boolean }> {
    return Promise.resolve({ modelId: null, reachable: true });
  }

  async extract(input: ExtractionInput): Promise<SourceOutcome<readonly ExtractedAssertion[]>> {
    const now = this.clock();

    if (input.text.length === 0) {
      // Nothing to read is not the same as having read nothing. The caller committed a document
      // whose normalised text is empty — an image page, a body we cannot normalise — and that is
      // a gap in what was extracted, not a document that made no claims.
      return Promise.resolve(
        failed(
          this.descriptor,
          now,
          // The FR-06 table classifies it; this adapter states the fact and nothing else.
          { unparsableBody: true },
          `Document ${input.documentId} normalised to no text at all, so nothing could be ` +
            `extracted from it. It was retrieved and stored; it was not read.`,
        ),
      );
    }

    const haystack = input.text.toLowerCase();
    const mentions = findNameSpans(input.text, haystack, input.subjectNameForms);
    if (mentions.length === 0) {
      // The extractor read the document and the subject is not named in it. A fact worth
      // recording as such, and distinct from a failure to read it.
      return Promise.resolve(noResults(this.descriptor, now));
    }

    const enabled = new Set(input.enabledCategoryIds);
    /** One assertion per category, anchored at the conduct mention nearest the subject. */
    const byCategory = new Map<AdverseCategory, TextSpan>();

    for (const { term, categoryId } of CONDUCT_TERMS) {
      if (!enabled.has(categoryId)) {
        // Not reclassified into the nearest enabled category. See the file header.
        continue;
      }
      const span = nearestOccurrence(haystack, term, mentions);
      if (span === null) {
        continue;
      }
      const held = byCategory.get(categoryId);
      if (
        held === undefined ||
        distanceToNearestMention(span, mentions) < distanceToNearestMention(held, mentions)
      ) {
        byCategory.set(categoryId, span);
      }
    }

    if (byCategory.size === 0) {
      return Promise.resolve(noResults(this.descriptor, now));
    }

    const namingAuthority = findNamingAuthority(input.text);
    const assertions: ExtractedAssertion[] = [];

    for (const [categoryId, conductSpan] of byCategory) {
      const stageHit = chooseStage(haystack, mentions, conductSpan);
      const stage = stageHit?.stage ?? 'UNSPECIFIED';
      assertions.push({
        documentId: input.documentId,
        documentVersion: input.documentVersion,
        categoryId,
        partyRole: roleForStage(stage),
        proceduralStage: stage,
        namingAuthority,
        subjectMentionSpans: mentions,
        conductSpan,
        // I4: a stage is only ever set from the span that establishes it. No span, no stage.
        stageSpan: stageHit?.span ?? null,
        // FR-07: four dates, and a missing one stays null — never backfilled with the retrieval
        // time. This extractor parses none of them. Date parsing is a separate, testable concern
        // (F1), and putting an unverified date here would hand the validator something to trust.
        eventDate: { value: null, precision: 'UNKNOWN' },
        publicationDate: { value: null, precision: 'UNKNOWN' },
        updateDate: { value: null, precision: 'UNKNOWN' },
        // The FR-02 graph decides which companies attach to this subject, from the registry
        // rather than from prose. A company name lifted out of a sentence is not a company ref.
        companyRefs: [],
        // Only attributes the text states would belong here, and none are read yet: an age or a
        // town matched by pattern is a guess about which person the document means, and axis A
        // is where a guess does the most damage.
        identityAttributes: [],
        language: input.language,
        extractorVersion: RULE_BASED_EXTRACTOR_VERSION,
        modelId: null,
        promptVersion: null,
      });
    }

    // Deterministic order, so two runs over the same document produce the same record.
    assertions.sort((a, b) => a.categoryId.localeCompare(b.categoryId));
    return Promise.resolve(ok(this.descriptor, now, assertions));
  }
}

/**
 * Every occurrence of every name form, on word boundaries, de-duplicated and in document order.
 *
 * Boundaries matter more here than in the mock: over real prose a substring match puts "Ana"
 * inside "Santana" and attributes a stranger's conviction to the subject.
 */
function findNameSpans(
  text: string,
  haystack: string,
  forms: readonly string[],
): readonly TextSpan[] {
  const spans: TextSpan[] = [];
  for (const form of forms) {
    const needle = form.toLowerCase().trim();
    if (needle.length === 0) {
      continue;
    }
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) {
        break;
      }
      if (isWordBounded(text, at, at + needle.length)) {
        spans.push({ start: at, end: at + needle.length });
      }
      from = at + needle.length;
    }
  }
  return spans
    .toSorted((a, b) => a.start - b.start || b.end - a.end)
    .filter((span, i, all) => i === 0 || all[i - 1]?.start !== span.start);
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function isWordBounded(text: string, start: number, end: number): boolean {
  const before = start === 0 ? '' : (text[start - 1] ?? '');
  const after = text[end] ?? '';
  return !WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after);
}

/** The occurrence of `term` nearest any mention, or null when every occurrence is too far. */
function nearestOccurrence(
  haystack: string,
  term: string,
  mentions: readonly TextSpan[],
): TextSpan | null {
  let best: TextSpan | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(term, from);
    if (at === -1) {
      break;
    }
    const span = { start: at, end: at + term.length };
    const distance = distanceToNearestMention(span, mentions);
    if (distance <= PROXIMITY_WINDOW && distance < bestDistance) {
      best = span;
      bestDistance = distance;
    }
    from = at + term.length;
  }
  return best;
}

function distanceToNearestMention(span: TextSpan, mentions: readonly TextSpan[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const mention of mentions) {
    const gap =
      span.start >= mention.end
        ? span.start - mention.end
        : mention.start >= span.end
          ? mention.start - span.end
          : 0;
    if (gap < nearest) {
      nearest = gap;
    }
  }
  return nearest;
}

/**
 * The stage the text supports near this conduct, or null when it supports none.
 *
 * An outcome stage wins over a non-outcome one wherever both are near (see the file header).
 * Among stages of the same kind the lower rung wins, because a keyword table cannot tell which
 * of two claims the document actually makes and the lower rung is the one that says less.
 */
function chooseStage(
  haystack: string,
  mentions: readonly TextSpan[],
  conductSpan: TextSpan,
): { readonly stage: StageValue; readonly span: TextSpan } | null {
  const anchors = [...mentions, conductSpan];
  let best: { stage: StageValue; span: TextSpan } | null = null;

  for (const { term, stage } of STAGE_TERMS) {
    const span = nearestOccurrence(haystack, term, anchors);
    if (span === null) {
      continue;
    }
    if (best === null || beats(stage, best.stage)) {
      best = { stage, span };
    }
  }
  return best;
}

function beats(candidate: StageValue, incumbent: StageValue): boolean {
  const candidateIsOutcome = isOutcomeStage(candidate);
  const incumbentIsOutcome = isOutcomeStage(incumbent);
  if (candidateIsOutcome !== incumbentIsOutcome) {
    return candidateIsOutcome;
  }
  return stageRung(candidate) < stageRung(incumbent);
}

function findNamingAuthority(text: string): string | null {
  return AUTHORITIES.find((authority) => text.includes(authority)) ?? null;
}
