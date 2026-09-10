/**
 * FR-01 — subject snapshots.
 *
 * The subject is stored as written, with derived comparison forms alongside it. Nothing here
 * splits a name into given/family, and nothing invents a date of birth or a nationality:
 * sparse identity is searched and left unresolved, which is a very different outcome from
 * sparse identity that has been quietly filled in.
 */

import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Collection, Db } from 'mongodb';

import type { CreateSubjectInput, SubjectVersion } from '@erly/adverse-contracts';
import { normaliseName, phoneticKeys } from '@erly/adverse-domain';

import { ApiException } from '../common/api-exception.js';
import { NameFrequencyService } from './name-frequency.service.js';

interface SubjectVersionRecord extends Omit<SubjectVersion, 'createdAt' | 'supersededAt'> {
  readonly createdAt: Date;
  readonly supersededAt: Date | null;
}

@Injectable()
export class SubjectsService {
  private readonly subjects: Collection<SubjectVersionRecord>;

  constructor(
    db: Db,
    private readonly nameFrequency: NameFrequencyService,
  ) {
    this.subjects = db.collection<SubjectVersionRecord>('subjectVersions');
  }

  async ensureIndexes(): Promise<void> {
    // Tenant context leads every key (section 6.3).
    await this.subjects.createIndex({ tenantId: 1, subjectId: 1, version: -1 }, { unique: true });
    await this.subjects.createIndex({ tenantId: 1, subjectVersionId: 1 }, { unique: true });
    // External references are recorded for correlation. Deliberately NOT unique: two tenants
    // may legitimately use the same external ref, and one must never see the other's (T04).
    await this.subjects.createIndex({ tenantId: 1, externalSubjectRef: 1 });
  }

  async create(input: {
    readonly tenantId: string;
    readonly data: CreateSubjectInput;
    readonly now: Date;
  }): Promise<SubjectVersion> {
    const { tenantId, data, now } = input;

    // Derived forms. The original is preserved untouched alongside them.
    const normalised = normaliseName(data.fullName);

    const prior = await this.nameFrequency.lookup({
      fullName: data.fullName,
      normalised,
      countryContext: data.countryContext,
    });

    const record: SubjectVersionRecord = {
      subjectId: randomUUID(),
      subjectVersionId: randomUUID(),
      version: 1,
      tenantId,

      fullName: data.fullName,
      normalised: {
        folded: normalised.folded,
        sortedCoreKey: normalised.sortedCoreKey,
        phoneticKeys: [...phoneticKeys(normalised)],
        scripts: [...normalised.scripts],
      },

      aliases: data.aliases,
      dateOfBirth: data.dateOfBirth ?? null,
      countryContext: data.countryContext,
      // A client-supplied company is a candidate association until independently verified.
      knownCompanies: data.knownCompanies.map((c) => ({
        ...c,
        verificationStatus: 'SUPPLIED_UNVERIFIED' as const,
      })),

      externalSubjectRef: data.externalSubjectRef ?? null,
      externalCaseRef: data.externalCaseRef ?? null,
      purpose: data.purpose,

      nameFrequencyPrior: prior,

      createdAt: now,
      supersededAt: null,
    };

    await this.subjects.insertOne(record);
    return toWire(record);
  }

  /**
   * Load a specific subject version, scoped to the tenant.
   *
   * The tenant filter is part of the query, not a check afterwards. A post-hoc check is a
   * check somebody eventually forgets; a filtered query cannot return the wrong tenant's row
   * in the first place (SEC-01).
   */
  async findVersion(input: {
    readonly tenantId: string;
    readonly subjectId: string;
    readonly version: number;
  }): Promise<SubjectVersion> {
    const record = await this.subjects.findOne({
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      version: input.version,
    });

    if (record === null) {
      // Non-enumerating: another tenant's subject and a genuinely missing one look identical.
      throw ApiException.notFound(
        'Subject',
        `tenant=${input.tenantId} subject=${input.subjectId} v${String(input.version)}`,
      );
    }
    return toWire(record);
  }

  async findLatest(tenantId: string, subjectId: string): Promise<SubjectVersion> {
    const record = await this.subjects.findOne({ tenantId, subjectId }, { sort: { version: -1 } });
    if (record === null) {
      throw ApiException.notFound('Subject', `tenant=${tenantId} subject=${subjectId}`);
    }
    return toWire(record);
  }

  /**
   * Data updates create a revision. The previous version is retained, so a historical search
   * keeps explaining itself against the subject it actually ran on (section 4.1).
   */
  async revise(input: {
    readonly tenantId: string;
    readonly subjectId: string;
    readonly data: CreateSubjectInput;
    readonly now: Date;
  }): Promise<SubjectVersion> {
    const current = await this.findLatest(input.tenantId, input.subjectId);
    const normalised = normaliseName(input.data.fullName);
    const prior = await this.nameFrequency.lookup({
      fullName: input.data.fullName,
      normalised,
      countryContext: input.data.countryContext,
    });

    const record: SubjectVersionRecord = {
      subjectId: current.subjectId,
      subjectVersionId: randomUUID(),
      version: current.version + 1,
      tenantId: input.tenantId,
      fullName: input.data.fullName,
      normalised: {
        folded: normalised.folded,
        sortedCoreKey: normalised.sortedCoreKey,
        phoneticKeys: [...phoneticKeys(normalised)],
        scripts: [...normalised.scripts],
      },
      aliases: input.data.aliases,
      dateOfBirth: input.data.dateOfBirth ?? null,
      countryContext: input.data.countryContext,
      knownCompanies: input.data.knownCompanies.map((c) => ({
        ...c,
        verificationStatus: 'SUPPLIED_UNVERIFIED' as const,
      })),
      externalSubjectRef: input.data.externalSubjectRef ?? null,
      externalCaseRef: input.data.externalCaseRef ?? null,
      purpose: input.data.purpose,
      nameFrequencyPrior: prior,
      createdAt: input.now,
      supersededAt: null,
    };

    await this.subjects.insertOne(record);
    await this.subjects.updateOne(
      { tenantId: input.tenantId, subjectId: input.subjectId, version: current.version },
      { $set: { supersededAt: input.now } },
    );

    return toWire(record);
  }
}

function toWire(record: SubjectVersionRecord): SubjectVersion {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    supersededAt: record.supersededAt?.toISOString() ?? null,
  };
}
