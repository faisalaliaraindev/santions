import { describe, expect, it } from 'vitest';

import {
  clearancePermitsActivation,
  clearForActivation,
  decideRights,
  RIGHTS_OPERATIONS,
  type ApprovalEvidence,
  type RightsPolicy,
  type RightsRequest,
} from '../../src/rights/rights.js';

const NOW = new Date('2026-09-11T12:00:00.000Z');

/** A permissive-but-explicit policy. Tests narrow it; nothing here is permitted by default. */
function policy(overrides: Partial<RightsPolicy> = {}): RightsPolicy {
  return {
    policyId: 'policy-test-v1',
    jurisdiction: 'CR',
    permittedOperations: ['COLLECT', 'PROCESS', 'STORE', 'DISPLAY'],
    permittedClassifications: ['PUBLIC_RECORD', 'PUBLISHED_CONTENT', 'PERSONAL_DATA'],
    permittedIntendedUses: ['ADVERSE_SCREENING'],
    permittedCollectionMethods: ['PUBLISHED_API', 'PUBLISHED_FEED', 'HTML_FETCH'],
    permittedRegions: ['us-east-1'],
    maxRetentionDays: 30,
    rawPersonalDataRetentionPermitted: true,
    approvalRequiredFor: [],
    ...overrides,
  };
}

function request(overrides: Partial<RightsRequest> = {}): RightsRequest {
  return {
    jurisdiction: 'CR',
    sourceId: 'src-test',
    intendedUse: 'ADVERSE_SCREENING',
    operation: 'COLLECT',
    classification: 'PUBLISHED_CONTENT',
    collectionMethod: 'PUBLISHED_API',
    requestedRetentionDays: 30,
    retainsRawPersonalData: false,
    processingRegion: 'us-east-1',
    approval: null,
    ...overrides,
  };
}

function codes(decision: ReturnType<typeof decideRights>): string[] {
  return decision.reasons.map((r) => r.code);
}

describe('decideRights — SEC-05 as an enforcement function', () => {
  it('allows a permitted operation and says which policy permitted it', () => {
    const decision = decideRights(request(), policy(), NOW);
    expect(decision.verdict).toBe('ALLOW');
    expect(codes(decision)).toEqual(['PERMITTED_BY_POLICY']);
  });

  describe('default deny', () => {
    it('denies an operation the policy does not name', () => {
      const decision = decideRights(request({ operation: 'EXPORT' }), policy(), NOW);
      expect(decision.verdict).toBe('DENY');
      expect(codes(decision)).toContain('OPERATION_NOT_PERMITTED');
    });

    it('denies every operation under an empty policy', () => {
      const empty = policy({
        permittedOperations: [],
        permittedClassifications: [],
        permittedIntendedUses: [],
        permittedCollectionMethods: [],
        permittedRegions: [],
      });
      for (const operation of RIGHTS_OPERATIONS) {
        expect(decideRights(request({ operation }), empty, NOW).verdict, operation).toBe('DENY');
      }
    });

    it('denies a processing region that is not permitted', () => {
      const decision = decideRights(request({ processingRegion: 'eu-west-1' }), policy(), NOW);
      expect(codes(decision)).toContain('REGION_NOT_PERMITTED');
    });

    it('denies an intended use the policy does not cover', () => {
      const decision = decideRights(request({ intendedUse: 'MODEL_EVALUATION' }), policy(), NOW);
      expect(codes(decision)).toContain('INTENDED_USE_NOT_PERMITTED');
    });
  });

  describe('access controls', () => {
    it('refuses a CAPTCHA-gated source', () => {
      const decision = decideRights(request({ collectionMethod: 'CAPTCHA_GATED' }), policy(), NOW);
      expect(decision.verdict).toBe('DENY');
      expect(codes(decision)).toContain('COLLECTION_METHOD_PROHIBITED');
    });

    it('cannot be talked into a CAPTCHA by attaching an approval', () => {
      const approval: ApprovalEvidence = {
        approvalRef: 'LEGAL-2026-001',
        approvedBy: 'someone',
        approvedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        coversOperations: [...RIGHTS_OPERATIONS],
        coversJurisdictions: ['CR'],
      };
      const decision = decideRights(
        request({ collectionMethod: 'CAPTCHA_GATED', approval }),
        policy({ approvalRequiredFor: ['COLLECT'] }),
        NOW,
      );
      expect(decision.verdict).toBe('DENY');
      expect(codes(decision)).toContain('COLLECTION_METHOD_PROHIBITED');
    });

    it('distinguishes a credential issued to us from a login wall', () => {
      const withCredential = policy({ permittedCollectionMethods: ['CREDENTIALED_API'] });
      expect(
        decideRights(request({ collectionMethod: 'CREDENTIALED_API' }), withCredential, NOW)
          .verdict,
      ).toBe('ALLOW');
      expect(
        decideRights(request({ collectionMethod: 'LOGIN_GATED' }), withCredential, NOW).verdict,
      ).toBe('DENY');
    });
  });

  describe('classification', () => {
    it('refuses special-category data regardless of what the policy says', () => {
      const permissive = policy({
        permittedClassifications: ['PUBLIC_RECORD', 'SPECIAL_CATEGORY'],
      });
      const decision = decideRights(
        request({ classification: 'SPECIAL_CATEGORY' }),
        permissive,
        NOW,
      );
      expect(decision.verdict).toBe('DENY');
      expect(codes(decision)).toContain('SPECIAL_CATEGORY_PROHIBITED');
    });

    it('denies a classification the policy does not cover', () => {
      const decision = decideRights(request({ classification: 'OFFENCE_DATA' }), policy(), NOW);
      expect(codes(decision)).toContain('CLASSIFICATION_NOT_PERMITTED');
    });
  });

  describe('retention and raw personal data', () => {
    it('denies retention longer than the maximum, and says both numbers', () => {
      const decision = decideRights(request({ requestedRetentionDays: 365 }), policy(), NOW);
      expect(decision.verdict).toBe('DENY');
      const retention = decision.reasons.find((r) => r.code === 'RETENTION_EXCEEDS_MAXIMUM');
      expect(retention?.detail).toContain('365');
      expect(retention?.detail).toContain('30');
    });

    it('denies any retention when the policy permits none', () => {
      const decision = decideRights(
        request({ requestedRetentionDays: 1 }),
        policy({ maxRetentionDays: null }),
        NOW,
      );
      expect(codes(decision)).toContain('RETENTION_NOT_PERMITTED');
    });

    it('returns the cap as a machine-actionable restriction when within it', () => {
      const decision = decideRights(request({ requestedRetentionDays: 7 }), policy(), NOW);
      expect(decision.verdict).toBe('ALLOW');
      const cap = decision.restrictions.find((r) => r.code === 'MAX_RETENTION_DAYS');
      expect(cap?.days).toBe(30);
    });

    it('refuses to keep raw personal records when the source forbids it', () => {
      const decision = decideRights(
        request({ retainsRawPersonalData: true, classification: 'BULK_PERSONAL_DATA' }),
        policy({
          rawPersonalDataRetentionPermitted: false,
          permittedClassifications: ['BULK_PERSONAL_DATA'],
        }),
        NOW,
      );
      expect(decision.verdict).toBe('DENY');
      expect(codes(decision)).toContain('RAW_PERSONAL_DATA_RETENTION_PROHIBITED');
    });

    it('permits deriving an aggregate from bulk personal data, under restrictions', () => {
      const decision = decideRights(
        request({
          classification: 'BULK_PERSONAL_DATA',
          intendedUse: 'AGGREGATE_STATISTICS',
          collectionMethod: 'BULK_DOWNLOAD',
          retainsRawPersonalData: false,
          requestedRetentionDays: null,
        }),
        policy({
          permittedClassifications: ['BULK_PERSONAL_DATA'],
          permittedIntendedUses: ['AGGREGATE_STATISTICS'],
          permittedCollectionMethods: ['BULK_DOWNLOAD'],
          rawPersonalDataRetentionPermitted: false,
          maxRetentionDays: null,
        }),
        NOW,
      );
      expect(decision.verdict).toBe('ALLOW');
      const restrictionCodes = decision.restrictions.map((r) => r.code);
      expect(restrictionCodes).toContain('AGGREGATE_ONLY');
      expect(restrictionCodes).toContain('NO_RAW_RECORD_RETENTION');
    });
  });

  describe('approval', () => {
    const needsApproval = policy({
      permittedOperations: ['COLLECT', 'MODEL_DISCLOSURE'],
      approvalRequiredFor: ['MODEL_DISCLOSURE'],
    });

    it('requires approval when none is supplied', () => {
      const decision = decideRights(request({ operation: 'MODEL_DISCLOSURE' }), needsApproval, NOW);
      expect(decision.verdict).toBe('REQUIRES_APPROVAL');
      expect(codes(decision)).toEqual(['APPROVAL_REQUIRED']);
    });

    it('allows once a valid approval covers the operation and jurisdiction', () => {
      const approval: ApprovalEvidence = {
        approvalRef: 'DPIA-2026-014',
        approvedBy: 'compliance',
        approvedAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2027-06-01T00:00:00.000Z',
        coversOperations: ['MODEL_DISCLOSURE'],
        coversJurisdictions: ['CR'],
      };
      const decision = decideRights(
        request({ operation: 'MODEL_DISCLOSURE', approval }),
        needsApproval,
        NOW,
      );
      expect(decision.verdict).toBe('ALLOW');
    });

    it('treats an expired approval exactly like none', () => {
      const approval: ApprovalEvidence = {
        approvalRef: 'DPIA-2025-001',
        approvedBy: 'compliance',
        approvedAt: '2025-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T00:00:00.000Z',
        coversOperations: ['MODEL_DISCLOSURE'],
        coversJurisdictions: ['CR'],
      };
      const decision = decideRights(
        request({ operation: 'MODEL_DISCLOSURE', approval }),
        needsApproval,
        NOW,
      );
      expect(decision.verdict).toBe('REQUIRES_APPROVAL');
      expect(codes(decision)).toEqual(['APPROVAL_EXPIRED']);
    });

    it('does not let an approval for one jurisdiction cover another', () => {
      const approval: ApprovalEvidence = {
        approvalRef: 'DPIA-2026-014',
        approvedBy: 'compliance',
        approvedAt: '2026-06-01T00:00:00.000Z',
        expiresAt: null,
        coversOperations: ['MODEL_DISCLOSURE'],
        coversJurisdictions: ['GB'],
      };
      const decision = decideRights(
        request({ operation: 'MODEL_DISCLOSURE', approval }),
        needsApproval,
        NOW,
      );
      expect(decision.verdict).toBe('REQUIRES_APPROVAL');
      expect(codes(decision)).toEqual(['APPROVAL_SCOPE_MISMATCH']);
    });

    it('reports a prohibition as a prohibition, not as something approval could fix', () => {
      const decision = decideRights(
        request({ operation: 'MODEL_DISCLOSURE', processingRegion: 'eu-west-1' }),
        needsApproval,
        NOW,
      );
      expect(decision.verdict).toBe('DENY');
      expect(codes(decision)).not.toContain('APPROVAL_REQUIRED');
    });
  });

  it('reports every denial at once rather than one per round trip', () => {
    const decision = decideRights(
      request({
        operation: 'EXPORT',
        processingRegion: 'eu-west-1',
        intendedUse: 'MODEL_EVALUATION',
        requestedRetentionDays: 400,
      }),
      policy(),
      NOW,
    );
    expect(decision.verdict).toBe('DENY');
    expect(codes(decision).length).toBeGreaterThanOrEqual(4);
  });
});

describe('clearForActivation — the gate a version must pass to go live', () => {
  const operations = ['COLLECT', 'PROCESS', 'STORE'] as const;
  const base = {
    jurisdiction: 'CR',
    sourceId: 'src-test',
    intendedUse: 'ADVERSE_SCREENING',
    classification: 'PUBLISHED_CONTENT',
    collectionMethod: 'PUBLISHED_API',
    requestedRetentionDays: 30,
    retainsRawPersonalData: false,
    processingRegion: 'us-east-1',
    approval: null,
  } as const;

  it('clears a source whose every operation is permitted', () => {
    const clearance = clearForActivation({
      request: base,
      operations,
      policy: policy(),
      asOf: NOW,
    });
    expect(clearance.verdict).toBe('ALLOW');
    expect(clearancePermitsActivation(clearance)).toBe(true);
    expect(clearance.perOperation).toHaveLength(3);
  });

  it('refuses activation when one operation among many is denied', () => {
    const clearance = clearForActivation({
      request: base,
      operations: [...operations, 'EXPORT'],
      policy: policy(),
      asOf: NOW,
    });
    expect(clearance.verdict).toBe('DENY');
    expect(clearancePermitsActivation(clearance)).toBe(false);
  });

  it('blocks activation on an outstanding approval, without calling it a denial', () => {
    const clearance = clearForActivation({
      request: base,
      operations: ['COLLECT', 'MODEL_DISCLOSURE'],
      policy: policy({
        permittedOperations: ['COLLECT', 'MODEL_DISCLOSURE'],
        approvalRequiredFor: ['MODEL_DISCLOSURE'],
      }),
      asOf: NOW,
    });
    expect(clearance.verdict).toBe('REQUIRES_APPROVAL');
    expect(clearancePermitsActivation(clearance)).toBe(false);
  });

  it('lets a denial outrank an outstanding approval', () => {
    const clearance = clearForActivation({
      request: { ...base, collectionMethod: 'LOGIN_GATED' },
      operations: ['COLLECT', 'MODEL_DISCLOSURE'],
      policy: policy({
        permittedOperations: ['COLLECT', 'MODEL_DISCLOSURE'],
        approvalRequiredFor: ['MODEL_DISCLOSURE'],
      }),
      asOf: NOW,
    });
    expect(clearance.verdict).toBe('DENY');
  });

  it('de-duplicates restrictions raised by more than one operation', () => {
    const clearance = clearForActivation({
      request: base,
      operations,
      policy: policy(),
      asOf: NOW,
    });
    const caps = clearance.restrictions.filter((r) => r.code === 'MAX_RETENTION_DAYS');
    expect(caps).toHaveLength(1);
  });
});
