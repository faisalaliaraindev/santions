import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  gradeIdentity,
  matchNameForms,
  normaliseName,
  type IdentityFactor,
  type NameMatch,
  type SourceCoverageOutcome,
} from '@erly/adverse-domain';
import type { SubjectVersion } from '@erly/adverse-contracts';

import type { FindingRecord } from '../../pipeline/findings.service.js';
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

  async search(input: {
    readonly tenantId: string;
    readonly searchId: string;
    readonly subject: SubjectVersion;
    readonly now: Date;
  }): Promise<IndexedSearchResult> {
    const states = await this.repository.listStates(
      this.configuredSourceIds.length === 0 ? undefined : this.configuredSourceIds,
    );
    const usable = states.filter((state) => state.activeSnapshotVersion !== null);
    const nameForms = [input.subject.fullName, ...input.subject.aliases.map((alias) => alias.name)];
    const candidates = await this.repository.search({
      nameForms,
      sourceIds: usable.map((state) => state.sourceId),
    });

    const versions = new Map(
      await Promise.all(
        states.map(async (state) => [state.sourceId, await this.versions.loadActive(state.sourceId)] as const),
      ),
    );
    const findings = candidates
      .map((record) => this.toFinding(record, versions.get(record.sourceId) ?? null, input))
      .filter((finding): finding is FindingRecord => finding !== null);
    const counts = new Map<string, number>();
    for (const finding of findings) {
      counts.set(finding.document.sourceId, (counts.get(finding.document.sourceId) ?? 0) + 1);
    }

    return {
      findings,
      sourceOutcomes: states.map((state): SourceCoverageOutcome => {
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
        };
      }),
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
    const subjectForms = [input.subject.fullName, ...input.subject.aliases.map((alias) => alias.name)];
    const recordForms = [record.primaryName, ...record.aliases, ...record.originalScriptNames];
    const publicationMatch =
      record.recordKind === 'OFFICIAL_PUBLICATION'
        ? matchPublication(subjectForms, record.searchableText ?? '')
        : null;
    const match = publicationMatch?.match ?? strongestMatch(subjectForms, recordForms);
    if (match.form === 'NO_MATCH') {
      return null;
    }
    const factors = identityFactors(input.subject, record, match);
    const identity = gradeIdentity({
      nameMatch: match.form,
      factors,
      frequencyPrior: input.subject.nameFrequencyPrior,
      documentDistinguishesNamesake: false,
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
    const span = publicationMatch?.span ?? { start: 0, end: record.primaryName.length };
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
      category: isPublication ? (findingMetadata?.category ?? null) : 'SANCTIONS_DESIGNATION',
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

function matchPublication(
  subjectForms: readonly string[],
  searchableText: string,
): { readonly match: NameMatch; readonly span: { readonly start: number; readonly end: number } } | null {
  for (const form of subjectForms) {
    const directAt = searchableText.toLocaleLowerCase('en').indexOf(form.toLocaleLowerCase('en'));
    if (directAt >= 0) {
      return {
        match: { form: 'EXACT', matchedForm: form, matchedScripts: [] },
        span: { start: directAt, end: directAt + form.length },
      };
    }
  }
  return null;
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

function strongestMatch(subjectForms: readonly string[], recordForms: readonly string[]): NameMatch {
  const rank = ['NO_MATCH', 'PHONETIC', 'SUBSET_PATRONYMIC', 'INITIAL_EXPANSION', 'PARTICLE_VARIANT', 'EXACT_WORD_ORDER_VARIANT', 'EXACT'];
  let strongest: NameMatch = { form: 'NO_MATCH', matchedForm: '', matchedScripts: [] };
  for (const subject of subjectForms) {
    for (const candidate of recordForms) {
      const match = matchNameForms(normaliseName(subject), normaliseName(candidate));
      if (rank.indexOf(match.form) > rank.indexOf(strongest.form)) {
        strongest = match;
      }
    }
  }
  return strongest;
}

function identityFactors(
  subject: SubjectVersion,
  record: StoredIndexedSourceRecord,
  match: NameMatch,
): IdentityFactor[] {
  const factors: IdentityFactor[] = [
    {
      kind: 'EXACT_COMMON_NAME',
      strength: 'WEAK',
      direction: 'CORROBORATING',
      span: { start: 0, end: match.matchedForm.length },
      detail: `Publisher name matched as ${match.form}: ${match.matchedForm}.`,
    },
  ];
  const subjectDob = subject.dateOfBirth;
  if (subjectDob !== null && subjectDob.value !== null && record.datesOfBirth.length > 0) {
    const same = record.datesOfBirth.some((date) => datesAgree(subjectDob.value as string, date));
    factors.push({
      kind: same ? 'FULL_DOB' : 'DOB_DIFFERS_BEYOND_PRECISION',
      strength: 'STRONG',
      direction: same ? 'CORROBORATING' : 'CONTRADICTING',
      span: { start: 0, end: record.primaryName.length },
      detail: same
        ? 'Subject date of birth agrees with the publisher record.'
        : 'Subject date of birth conflicts with every date of birth in the publisher record.',
    });
  }
  const subjectCountries = new Set(subject.countryContext.map((country) => country.toUpperCase()));
  const recordCountries = [...record.countries, ...record.nationalities, ...record.citizenships];
  if (recordCountries.some((country) => subjectCountries.has(country.toUpperCase()))) {
    factors.push({
      kind: 'COUNTRY_ONLY',
      strength: 'WEAK',
      direction: 'CORROBORATING',
      span: { start: 0, end: record.primaryName.length },
      detail: 'Subject country context overlaps publisher nationality/address data.',
    });
  }
  return factors;
}

function datesAgree(subjectDate: string, sourceDate: IndexedSourceDate): boolean {
  if (sourceDate.value === null) {
    return false;
  }
  return sourceDate.precision === 'YEAR'
    ? subjectDate.slice(0, 4) === sourceDate.value.slice(0, 4)
    : subjectDate === sourceDate.value;
}

function toPreciseDate(
  date: IndexedSourceDate | null,
): { readonly value: string | null; readonly precision: 'DAY' | 'MONTH' | 'YEAR' | 'UNKNOWN' } {
  if (date === null || date.value === null || date.precision === 'UNKNOWN' || date.precision === 'RANGE') {
    return { value: null, precision: 'UNKNOWN' };
  }
  return { value: date.value, precision: date.precision };
}
