import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  gradeIdentity,
  resolveIdentityEvidence,
  type DocumentIdentityEvidence,
  type EvidenceSpan,
  type IdentityDate,
  type IdentityName,
  type SourceCoverageOutcome,
  type SubjectIdentityEvidence,
} from '@adverse-search/domain';
import type { SubjectVersion } from '@adverse-search/contracts';

import type { FindingRecord } from '../../pipeline/findings.service.js';
import { excludedBySourceFilter } from '../source-filter.js';
import type { SourceVersionReader } from '../source-version.service.js';
import { IndexedSourceRepository } from './indexed-source.repository.js';
import type { IndexedSourceDate, StoredIndexedSourceRecord } from './indexed-source.types.js';

export interface IndexedSearchResult {
  readonly findings: readonly FindingRecord[];
  readonly sourceOutcomes: readonly SourceCoverageOutcome[];
}

@Injectable()
export class IndexedSourceSearchService {
  constructor(
    private readonly repository: IndexedSourceRepository,
    private readonly versions: SourceVersionReader,
    private readonly configuredSourceIds: readonly string[] = [],
  ) {}

  /** The ids of every indexed source this process searches, snapshot or not. */
  async sourceIds(): Promise<readonly string[]> {
    const states = await this.repository.listStates(
      this.configuredSourceIds.length === 0 ? undefined : this.configuredSourceIds,
    );
    return states.map((state) => state.sourceId);
  }

  async search(input: {
    readonly tenantId: string;
    readonly searchId: string;
    readonly subject: SubjectVersion;
    readonly now: Date;
    /** Restrict to these source ids; null/absent searches every configured source. */
    readonly onlySourceIds?: readonly string[] | null | undefined;
  }): Promise<IndexedSearchResult> {
    const all = await this.repository.listStates(
      this.configuredSourceIds.length === 0 ? undefined : this.configuredSourceIds,
    );
    const filter = input.onlySourceIds ?? null;
    const states = filter === null ? all : all.filter((state) => filter.includes(state.sourceId));
    const excludedStates =
      filter === null ? [] : all.filter((state) => !filter.includes(state.sourceId));
    const usable = states.filter((state) => state.activeSnapshotVersion !== null);
    const nameForms = [input.subject.fullName, ...input.subject.aliases.map((alias) => alias.name)];
    const candidates = await this.repository.search({
      nameForms,
      sourceIds: usable.map((state) => state.sourceId),
    });

    const versions = new Map(
      await Promise.all(
        all.map(
          async (state) =>
            [state.sourceId, await this.versions.loadActive(state.sourceId)] as const,
        ),
      ),
    );
    const findings = candidates
      .map((record) => this.toFinding(record, versions.get(record.sourceId) ?? null, input))
      .filter((finding): finding is FindingRecord => finding !== null);
    const counts = new Map<string, number>();
    for (const finding of findings) {
      counts.set(finding.document.sourceId, (counts.get(finding.document.sourceId) ?? 0) + 1);
    }

    // Left out by the request's `sources` filter: reported, never dropped (see the helper).
    const excludedOutcomes = excludedStates.map((state) =>
      excludedBySourceFilter(
        state.sourceId,
        versions.get(state.sourceId)?.sourceName ?? state.sourceId,
        0,
      ),
    );

    return {
      findings,
      sourceOutcomes: [
        ...states.map((state): SourceCoverageOutcome => {
          const version = versions.get(state.sourceId) ?? null;
          const sourceName = version?.sourceName ?? state.sourceId;
          if (state.activeSnapshotVersion === null) {
            return {
              sourceId: state.sourceId,
              sourceName,
              cascadeRung: 0,
              outcome: 'FAILED',
              detail:
                state.failureReason ??
                'No usable local snapshot exists. This source contributed no no-match evidence.',
              queriesAffected: 1,
              truncation: null,
              snapshotVersion: null,
              freshness: state.freshness,
              snapshotRowCount: null,
            };
          }
          const degraded = state.refreshStatus === 'FAILED' || state.freshness === 'STALE';
          return {
            sourceId: state.sourceId,
            sourceName,
            cascadeRung: 0,
            outcome: degraded ? 'PARTIAL' : 'COMPLETED',
            detail: degraded
              ? `Searched last-known-good snapshot ${state.activeSnapshotVersion} ` +
                `(${String(state.rowCount)} records). Latest refresh status: ${state.refreshStatus}; ` +
                `${state.failureReason ?? `freshness ${state.freshness}`}.`
              : `Searched local snapshot ${state.activeSnapshotVersion} ` +
                `(${String(state.rowCount)} records) and found ${String(counts.get(state.sourceId) ?? 0)} match(es).`,
            queriesAffected: 1,
            truncation: null,
            snapshotVersion: state.activeSnapshotVersion,
            freshness: state.freshness,
            snapshotRowCount: state.rowCount,
          };
        }),
        ...excludedOutcomes,
      ],
    };
  }

  private toFinding(
    record: StoredIndexedSourceRecord,
    version: Awaited<ReturnType<SourceVersionReader['loadActive']>>,
    input: {
      readonly tenantId: string;
      readonly searchId: string;
      readonly subject: SubjectVersion;
      readonly now: Date;
    },
  ): FindingRecord | null {
    if (version === null) {
      return null;
    }
    // Both sides of the comparison are built from their own source and handed to the one shared
    // resolver. Until 2026-09-21 this service had its own copy of the factor logic, correct but
    // private, while the discovery pipeline had a second copy that compared the subject's name to
    // itself. One implementation, two callers, is the whole point of the refactor.
    const subjectEvidence = subjectIdentityEvidence(input.subject);
    const documentEvidence = documentIdentityEvidence(record, subjectEvidence);
    const resolved = resolveIdentityEvidence(subjectEvidence, documentEvidence);
    const match = resolved.match;
    if (match.form === 'NO_MATCH') {
      return null;
    }
    const factors = resolved.factors;
    const identity = gradeIdentity({
      nameMatch: match.form,
      factors,
      frequencyPrior: input.subject.nameFrequencyPrior,
      documentDistinguishesNamesake: documentEvidence.distinguishesNamesake,
    });
    if (identity.grade === 'CONTRADICTED') {
      return null;
    }
    const isPublication = record.recordKind === 'OFFICIAL_PUBLICATION';
    const entityTypeUnresolved = !isPublication && record.recordType !== 'PERSON';
    const publisher = version.publisher ?? version.sourceName;
    const band =
      !isPublication &&
      !entityTypeUnresolved &&
      (identity.grade === 'CORROBORATED' || identity.grade === 'PARTIAL')
        ? 'SUPPORTED'
        : 'AMBIGUOUS';
    const day = input.now.toISOString().slice(0, 10);
    const eventDate = toPreciseDate(
      isPublication
        ? (record.publicationDate ?? record.effectiveDate)
        : (record.listingDate ?? record.effectiveDate),
    );
    // The span the finding highlights: where the matched name was actually read. For a
    // publication that is its offset in the feed text; for a list entry the record field has no
    // text offset, so the resolver's field span is used.
    const span = resolved.matchedDocumentName?.span ?? { start: 0, end: record.primaryName.length };
    const findingMetadata = record.findingMetadata;
    const proceduralStage =
      isPublication && findingMetadata !== null && findingMetadata !== undefined
        ? findingMetadata.proceduralStage
        : 'DESIGNATION_SANCTION';
    const partyRole =
      isPublication && findingMetadata !== null && findingMetadata !== undefined
        ? findingMetadata.partyRole
        : 'CONVICTED_SANCTIONED_PARTY';
    const stageSpan = findEvidenceSpan(
      record.searchableText ?? '',
      findingMetadata?.stageEvidence ?? null,
    );

    return {
      findingId: randomUUID(),
      tenantId: input.tenantId,
      searchId: input.searchId,
      band,
      axes: {
        identity: identity.grade,
        attribution: 'DIRECT_PERSONAL',
        stage: proceduralStage,
        partyRole,
        authorityTier: version.authorityTier,
        independenceCount: 1,
      },
      rationale: [
        ...resolved.rationale,
        ...identity.rationale,
        isPublication
          ? `${publisher} published this official item; the feed excerpt is a candidate and ` +
            'does not by itself establish that the named subject is the adverse party.'
          : `${publisher} is the primary authority for this designation record.`,
        isPublication
          ? 'Party role and identity require review, so the publication remains AMBIGUOUS.'
          : entityTypeUnresolved
            ? `The publisher classifies the record as ${record.recordType}; the subject schema does ` +
              'not declare person/entity type, so the candidate remains AMBIGUOUS.'
            : 'The publisher record names an individual directly.',
      ],
      // A publication carries the category its parser assigned; a listing carries the kind of
      // list it came from, defaulting to a sanctions designation for the parsers that predate
      // `listingCategory`. Both are values in the closed `FINDING_CATEGORIES` enum — until
      // 2026-09-21 this line emitted `'SANCTIONS_DESIGNATION'` as a free string that appeared in
      // no schema.
      category: isPublication
        ? (findingMetadata?.category ?? null)
        : (record.listingCategory ?? 'SANCTIONS_DESIGNATION'),
      proceduralStage,
      partyRole,
      namingAuthority: publisher,
      attribution: {
        grade: 'DIRECT_PERSONAL',
        isInference: false,
        statement: null,
        companyRef: null,
        companyName: null,
        tenureLabel: null,
      },
      document: {
        documentId: `indexed:${record.sourceId}:${record.sourceRecordId}`,
        documentVersion: 1,
        url: record.sourceDocumentUrl,
        title: isPublication
          ? record.primaryName
          : `${record.primaryName} - ${record.sanctionTypes.join(', ') || 'official listing'}`,
        publisher,
        sourceId: record.sourceId,
        authorityTier: version.authorityTier,
        language: version.languages[0] ?? null,
        eventDate,
        publicationDate: eventDate,
        updateDate: { value: null, precision: 'UNKNOWN' },
        retrievalDate: { value: day, precision: 'DAY' },
        cascadeRung: 0,
        mode: 'LIVE',
        sourceRecordId: record.sourceRecordId,
        sourceSnapshotVersion: record.sourceSnapshotVersion,
        parserVersion: record.parserVersion,
        rawEvidenceHash: record.rawEvidenceHash,
      },
      subjectMentionSpans: [span],
      conductSpan: isPublication ? stageSpan : span,
      stageSpan: isPublication ? stageSpan : span,
      textNormalisation: {
        normaliserVersion: 'structured-source-record-1',
        charset: 'structured',
        charsetSource: 'PUBLISHER_FIELD',
        markupRemoved: false,
      },
      originalSpans: {
        subjectMentions: [span],
        conduct: isPublication ? stageSpan : span,
        stage: isPublication ? stageSpan : span,
      },
      identityFactors: factors,
      queryId: `indexed:${record.sourceId}`,
      queryFamily: 'INDEXED_SOURCE',
      extractorVersion: record.parserVersion,
      modelId: null,
      promptVersion: null,
      createdAt: input.now,
    };
  }
}

/**
 * The subject side of the comparison, projected from the FR-01 subject version.
 *
 * `identifiers` is empty because `subjectVersionSchema` carries none — a tenant cannot supply a
 * passport or national id today. The resolver supports them so that the day the schema does, the
 * factor is already graded correctly; until then no identifier factor can be asserted on this
 * path, which is the honest outcome.
 */
function subjectIdentityEvidence(subject: SubjectVersion): SubjectIdentityEvidence {
  return {
    names: [
      { text: subject.fullName, role: 'PRIMARY' },
      ...subject.aliases.map((alias): IdentityName => ({
        text: alias.name,
        role: 'ALIAS',
        origin: alias.origin,
      })),
    ],
    datesOfBirth: subject.dateOfBirth === null ? [] : [subject.dateOfBirth],
    countries: subject.countryContext,
    companyNames: subject.knownCompanies
      .map((company) => company.name ?? '')
      .filter((name) => name.length > 0),
    identifiers: [],
  };
}

/**
 * The document side, projected from the stored publisher record.
 *
 * Two record kinds, two ways of reading a name out of them:
 *
 *  - an `AUTHORITY_LIST_ENTRY` is structured. Its names are fields — primary, aliases, original
 *    script — and they are passed through as written.
 *  - an `OFFICIAL_PUBLICATION` is a feed item with a title and summary. Its "names" are the
 *    word-bounded occurrences of a subject name form **in that text**, and what is passed to the
 *    resolver is the slice of the document at that offset, not the form used to find it. That
 *    distinction is not pedantry: the slice is what the publisher wrote, it carries the
 *    publisher's own casing and spacing, and it is what a reviewer is shown.
 *
 * Word boundaries are enforced. A bare `indexOf` puts "Ana" inside "Santana" and attributes a
 * stranger's enforcement action to the subject; the discovery extractor has always bounded its
 * matches and this path now does too.
 */
function documentIdentityEvidence(
  record: StoredIndexedSourceRecord,
  subject: SubjectIdentityEvidence,
): DocumentIdentityEvidence {
  const isPublication = record.recordKind === 'OFFICIAL_PUBLICATION';
  const text = record.searchableText ?? '';

  const names: IdentityName[] = isPublication
    ? boundedOccurrences(
        text,
        subject.names.map((name) => name.text),
      )
    : [
        { text: record.primaryName, role: 'PRIMARY' },
        ...record.aliases.map((alias): IdentityName => ({ text: alias, role: 'ALIAS' })),
        ...record.originalScriptNames.map((name): IdentityName => ({
          text: name,
          role: 'ORIGINAL_SCRIPT',
        })),
      ];

  // A publication's prose is not parsed for a date of birth or a nationality: a four-digit
  // number near a name is not a birth year, and guessing one is exactly the fabrication this
  // work removed. Structured publisher fields are read; prose is not mined.
  const structured = !isPublication;

  return {
    names,
    datesOfBirth: structured ? record.datesOfBirth.map(toIdentityDate) : [],
    countries: structured
      ? [...record.countries, ...record.nationalities, ...record.citizenships]
      : [],
    // A company the subject is associated with, named in the publisher's text. The value passed
    // is the document's own slice, for the same reason the names are.
    companyNames: boundedOccurrences(
      isPublication ? text : `${record.primaryName} ${record.aliases.join(' ')}`,
      subject.companyNames,
    ).map((occurrence) => occurrence.text),
    identifiers: structured
      ? record.identifiers.map((identifier) => ({
          type: identifier.type,
          value: identifier.value,
        }))
      : [],
    // A sanctions list does not publish namesake disclaimers, and a feed excerpt is not read for
    // one. FR-09's NAMESAKE_DISTINGUISHED reaches Axis A through the extraction path only.
    distinguishesNamesake: false,
    fieldSpan: isPublication ? null : { start: 0, end: record.primaryName.length },
  };
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * Every word-bounded occurrence of any needle, returned as the **document's** own text at that
 * offset. Deduplicated by start offset, in document order.
 */
function boundedOccurrences(
  text: string,
  needles: readonly string[],
): { readonly text: string; readonly role: 'PRIMARY'; readonly span: EvidenceSpan }[] {
  const haystack = text.toLocaleLowerCase('en');
  const seen = new Set<number>();
  const found: { text: string; role: 'PRIMARY'; span: EvidenceSpan }[] = [];

  for (const needle of needles) {
    const target = needle.trim().toLocaleLowerCase('en');
    if (target.length === 0) {
      continue;
    }
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(target, from);
      if (at === -1) {
        break;
      }
      const end = at + target.length;
      const before = at === 0 ? '' : (text[at - 1] ?? '');
      const after = text[end] ?? '';
      if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after) && !seen.has(at)) {
        seen.add(at);
        // The slice, not the needle: what the publisher actually wrote at this offset.
        found.push({ text: text.slice(at, end), role: 'PRIMARY', span: { start: at, end } });
      }
      from = end;
    }
  }

  return found.toSorted((a, b) => a.span.start - b.span.start);
}

function findEvidenceSpan(
  text: string,
  evidence: string | null,
): { readonly start: number; readonly end: number } | null {
  if (evidence === null) {
    return null;
  }
  const start = text.toLocaleLowerCase('en').indexOf(evidence.toLocaleLowerCase('en'));
  return start < 0 ? null : { start, end: start + evidence.length };
}

/**
 * A publisher date in the resolver's shape.
 *
 * `RANGE` passes through unchanged and the resolver treats it as incomparable. A range is "some
 * time between these dates", and narrowing it to its start would turn an approximation into a
 * date of birth the publisher never stated — which, compared against a subject, would
 * manufacture either a corroboration or a contradiction out of nothing.
 */
function toIdentityDate(date: IndexedSourceDate): IdentityDate {
  return { value: date.value, precision: date.precision };
}

function toPreciseDate(date: IndexedSourceDate | null): {
  readonly value: string | null;
  readonly precision: 'DAY' | 'MONTH' | 'YEAR' | 'UNKNOWN';
} {
  if (
    date === null ||
    date.value === null ||
    date.precision === 'UNKNOWN' ||
    date.precision === 'RANGE'
  ) {
    return { value: null, precision: 'UNKNOWN' };
  }
  return { value: date.value, precision: date.precision };
}
