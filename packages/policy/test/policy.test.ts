import { describe, expect, it } from 'vitest';
import { parseSha256Digest } from '@local-pii/domain';

import {
  PolicyValidationError,
  bundledPolicies,
  compileCapabilityRequirement,
  compilePolicy,
  developmentLabelsPolicy,
  evaluateAcceptedSpan,
  evaluateCapabilities,
  evaluatePolicy,
  highRiskDisclosurePolicy,
  validatePolicy
} from '../src/index.js';
import type { CapabilityManifest } from '../src/index.js';
import type { AcceptedSpanInput, SupportingEvidenceInput } from '../src/index.js';

function expectPolicyError(operation: () => unknown, code: PolicyValidationError['code']): void {
  try {
    operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(PolicyValidationError);
    expect((error as PolicyValidationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

const developmentManifest: CapabilityManifest = {
  schemaVersion: '1.0.0',
  id: 'local-rules-text',
  version: '0.1.0',
  engineMode: 'RULES_ONLY',
  supportedContractVersions: ['1.0.0'],
  formats: [{
    id: 'text', adapter: 'text-adapter', version: '0.1.0',
    mediaTypes: ['text/plain'], extensions: ['.txt'], operations: ['SCAN', 'REDACT'],
    assurance: 'NATIVE_REDACTION', qualification: 'DEVELOPMENT',
    features: [{ id: 'utf-8', status: 'SUPPORTED' }],
    verificationProfiles: ['text-rescan-v1'], limits: { maximumInputBytes: 104_857_600 }
  }],
  detectors: [{
    id: 'email-pattern', version: '0.1.0', kinds: ['REGEX'], entityTypes: ['EMAIL'],
    languages: ['und'], availability: 'AVAILABLE', qualification: 'DEVELOPMENT'
  }],
  transformations: [{
    id: 'typed-label', version: '0.1.0', action: 'TYPED_LABEL', reversible: false,
    availability: 'AVAILABLE', qualification: 'DEVELOPMENT'
  }],
  verificationProfiles: [{
    id: 'text-rescan-v1', version: '0.1.0', formats: ['text'], checks: ['UTF8_REOPEN'],
    availability: 'AVAILABLE', qualification: 'DEVELOPMENT'
  }],
  limits: { maximumInputBytes: 104_857_600, maximumCanonicalCodePoints: 10_000_000, maximumDetections: 10_000 }
};

const extractionRevision = parseSha256Digest(`sha256:${'a'.repeat(64)}`);

function acceptedEmail(overrides: Partial<AcceptedSpanInput> = {}): AcceptedSpanInput {
  return {
    entityType: 'EMAIL',
    start: 7,
    end: 29,
    confidence: 0.97,
    evidenceIds: ['11111111-1111-5111-8111-111111111111'],
    extractionRevision,
    ...overrides
  };
}

function emailEvidence(overrides: Partial<SupportingEvidenceInput> = {}): SupportingEvidenceInput {
  return {
    id: '11111111-1111-5111-8111-111111111111',
    entityType: 'EMAIL',
    span: { start: 7, end: 29, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision },
    confidence: 0.97,
    source: 'REGEX',
    detector: { id: 'email-pattern' },
    ...overrides
  };
}

describe('policy validation and compilation', () => {
  it('validates and freezes both exact bundled examples', () => {
    expect(validatePolicy(developmentLabelsPolicy)).toEqual(developmentLabelsPolicy);
    expect(validatePolicy(highRiskDisclosurePolicy)).toEqual(highRiskDisclosurePolicy);
    expect(Object.isFrozen(developmentLabelsPolicy)).toBe(true);
    expect(Object.isFrozen(highRiskDisclosurePolicy.entities.PERSON)).toBe(true);
    expect(Object.keys(bundledPolicies)).toEqual(['development-labels', 'high-risk-disclosure']);
  });

  it('retains the v1 digest while normalizing an absent structured policy to free text', () => {
    const effective = compilePolicy(developmentLabelsPolicy);
    expect(effective.digest).toBe('sha256:83bc5a796eab8185caed15cc23e29ee5995a842292f2973a086ae73f2b893af8');
    expect(effective.structure).toEqual({
      json: { defaultMode: 'FREE_TEXT', rules: [] },
      csv: { delimiter: 'AUTO', header: 'NONE', defaultMode: 'FREE_TEXT', columns: [] }
    });
  });

  it('validates and compiles exact structured JSON and CSV selectors', () => {
    const effective = compilePolicy({
      ...developmentLabelsPolicy,
      schemaVersion: '2.0.0',
      id: 'structured-development',
      structure: {
        json: {
          defaultMode: 'FREE_TEXT',
          rules: [{ id: 'json-email', pointer: '/contact/email', mode: 'STRUCTURED', entityType: 'EMAIL' }]
        },
        csv: {
          delimiter: 'SEMICOLON',
          header: 'PRESENT',
          defaultMode: 'FREE_TEXT',
          columns: [
            { id: 'csv-email', selector: { header: 'email' }, mode: 'STRUCTURED', entityType: 'EMAIL' },
            { id: 'csv-ssn', selector: { index: 3 }, mode: 'STRUCTURED', entityType: 'SSN' }
          ]
        }
      }
    });

    expect(effective.schemaVersion).toBe('2.0.0');
    expect(effective.structure.csv).toMatchObject({ delimiter: 'SEMICOLON', header: 'PRESENT' });
    expect(effective.structure.json.rules[0]).toMatchObject({ pointer: '/contact/email', entityType: 'EMAIL' });
    expect(effective.requirements.detectorKinds).toContain('STRUCTURED');
    expect(Object.isFrozen(effective.structure.csv.columns)).toBe(true);
  });

  it('rejects duplicate selectors, duplicate rule IDs, and header selectors without a declared header', () => {
    const base = {
      ...developmentLabelsPolicy,
      schemaVersion: '2.0.0' as const,
      id: 'structured-development'
    };
    for (const structure of [
      {
        json: { defaultMode: 'FREE_TEXT', rules: [
          { id: 'same-id', pointer: '/first', mode: 'STRUCTURED', entityType: 'EMAIL' },
          { id: 'same-id', pointer: '/second', mode: 'STRUCTURED', entityType: 'PHONE' }
        ] }
      },
      {
        csv: { delimiter: 'AUTO', header: 'NONE', defaultMode: 'FREE_TEXT', columns: [
          { id: 'header-rule', selector: { header: 'email' }, mode: 'STRUCTURED', entityType: 'EMAIL' }
        ] }
      },
      {
        csv: { delimiter: 'AUTO', header: 'PRESENT', defaultMode: 'FREE_TEXT', columns: [
          { id: 'first-rule', selector: { index: 2 }, mode: 'STRUCTURED', entityType: 'EMAIL' },
          { id: 'second-rule', selector: { index: 2 }, mode: 'STRUCTURED', entityType: 'PHONE' }
        ] }
      }
    ]) expectPolicyError(() => compilePolicy({ ...base, structure }), 'POLICY_SEMANTIC_INVALID');
  });

  it('rejects unknown fields and unsupported schema versions', () => {
    for (const value of [
      { ...developmentLabelsPolicy, execute: 'process.env.SECRET' },
      { ...developmentLabelsPolicy, schemaVersion: '3.0.0' }
    ]) {
      expectPolicyError(() => validatePolicy(value), 'POLICY_SCHEMA_INVALID');
    }
  });

  it('rejects accessors, exotic objects, and invalid threshold ordering', () => {
    const accessor = { ...developmentLabelsPolicy } as Record<string, unknown>;
    Object.defineProperty(accessor, 'hidden', { enumerable: true, get: () => 'secret' });
    expect(() => validatePolicy(accessor)).toThrowError(PolicyValidationError);
    expect(() => validatePolicy(new Date(0))).toThrowError(PolicyValidationError);
    const reversed = {
      ...developmentLabelsPolicy,
      defaults: { ...developmentLabelsPolicy.defaults, minimumConfidence: 0.9, reviewBelow: 0.8 }
    };
    expectPolicyError(() => validatePolicy(reversed), 'POLICY_SEMANTIC_INVALID');
  });

  it('rejects permissive high-risk uncertain and residual behavior', () => {
    const uncertainKeep = {
      ...highRiskDisclosurePolicy,
      defaults: { ...highRiskDisclosurePolicy.defaults, uncertainBehavior: 'KEEP' }
    };
    const warningResidual = {
      ...highRiskDisclosurePolicy,
      defaults: { ...highRiskDisclosurePolicy.defaults, residualBehavior: 'WARN' }
    };
    expectPolicyError(() => validatePolicy(uncertainKeep), 'POLICY_SEMANTIC_INVALID');
    expectPolicyError(() => validatePolicy(warningResidual), 'POLICY_SEMANTIC_INVALID');
  });

  it('compiles all domain entities, effective defaults, and deterministic requirements', () => {
    const first = compilePolicy(highRiskDisclosurePolicy);
    const reordered = {
      ...highRiskDisclosurePolicy,
      entities: {
        PERSON: highRiskDisclosurePolicy.entities.PERSON,
        SSN: highRiskDisclosurePolicy.entities.SSN
      }
    };
    const second = compilePolicy(reordered);
    expect(first.digest).toBe(second.digest);
    expect(first.entities).toHaveLength(24);
    expect(first.requirements).toEqual({
      detectorIds: ['ssn-pattern-checksum'],
      detectorKinds: ['MODEL'],
      transformationActions: ['REDACT', 'TYPED_LABEL'],
      verificationProfile: 'high-risk-v1',
      maximumInputBytes: 104_857_600
    });
    expect(first.entities.find(({ entityType }) => entityType === 'EMAIL')).toMatchObject({
      action: 'TYPED_LABEL', residualBehavior: 'BLOCK'
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entities)).toBe(true);
    expect(Object.isFrozen(first.requirements.detectorIds)).toBe(true);
  });

  it('shallow-merges optional defaults into entity overrides', () => {
    const effective = compilePolicy({
      ...developmentLabelsPolicy,
      defaults: {
        ...developmentLabelsPolicy.defaults,
        residualBehavior: 'BLOCK',
        requiredDetectorKinds: ['REGEX']
      }
    });
    expect(effective.entities.find(({ entityType }) => entityType === 'EMAIL')).toMatchObject({
      residualBehavior: 'BLOCK',
      requiredDetectors: ['email-pattern'],
      requiredDetectorKinds: ['REGEX']
    });
  });

  it('rejects invalid threshold ordering introduced by merged defaults', () => {
    expectPolicyError(() => compilePolicy({
      ...developmentLabelsPolicy,
      defaults: {
        ...developmentLabelsPolicy.defaults,
        reviewBelow: 0.9
      }
    }), 'POLICY_SEMANTIC_INVALID');
  });

  it('binds effective requirements to immutable invocation capability context', () => {
    const effective = compilePolicy(developmentLabelsPolicy);
    const requirement = compileCapabilityRequirement(effective, {
      contractVersion: '1.0.0',
      engineModes: ['RULES_ONLY'],
      formatId: 'text',
      operation: 'REDACT',
      minimumQualification: 'DEVELOPMENT'
    });
    expect(requirement).toEqual({
      contractVersion: '1.0.0',
      engineModes: ['RULES_ONLY'],
      formatId: 'text',
      operation: 'REDACT',
      detectorIds: ['email-pattern'],
      detectorKinds: [],
      transformationActions: ['TYPED_LABEL'],
      verificationProfile: 'text-rescan-v1',
      maximumInputBytes: 104_857_600,
      minimumQualification: 'DEVELOPMENT'
    });
    expect(Object.isFrozen(requirement)).toBe(true);
    expect(() => compileCapabilityRequirement(effective, {
      contractVersion: '1.0.0', engineModes: [], formatId: 'text', operation: 'SCAN', minimumQualification: 'DEVELOPMENT'
    })).toThrow(TypeError);

    const highRiskRequirement = compileCapabilityRequirement(compilePolicy(highRiskDisclosurePolicy), {
      contractVersion: '1.0.0', engineModes: ['LOCAL_HYBRID'], formatId: 'text',
      operation: 'REDACT', minimumQualification: 'EXPERIMENTAL'
    });
    expect(highRiskRequirement.minimumQualification).toBe('QUALIFIED');
  });

  it('evaluates action, review, and uncertain confidence bands deterministically', () => {
    const effective = compilePolicy(highRiskDisclosurePolicy);
    expect(evaluatePolicy(effective, 'PERSON', 0.95)).toEqual({
      entityType: 'PERSON', action: 'TYPED_LABEL', explanationCode: 'POLICY_ACTION'
    });
    expect(evaluatePolicy(effective, 'PERSON', 0.9)).toEqual({
      entityType: 'PERSON', action: 'REQUIRE_REVIEW', explanationCode: 'POLICY_REVIEW_BAND'
    });
    expect(evaluatePolicy(effective, 'SSN', 0.99)).toEqual({
      entityType: 'SSN', action: 'BLOCK', explanationCode: 'POLICY_BELOW_THRESHOLD'
    });
    expect(() => evaluatePolicy(effective, 'PERSON', Number.NaN)).toThrow(RangeError);
  });

  it('evaluates accepted spans only when required supporting evidence is present', () => {
    const effective = compilePolicy({
      ...developmentLabelsPolicy,
      entities: {
        EMAIL: {
          ...developmentLabelsPolicy.entities.EMAIL,
          requiredDetectorKinds: ['REGEX']
        }
      }
    });
    const span = acceptedEmail();
    const support = emailEvidence();
    expect(evaluateAcceptedSpan(effective, span, [support])).toEqual({
      entityType: 'EMAIL', action: 'TYPED_LABEL', explanationCode: 'POLICY_ACTION'
    });

    expect(evaluateAcceptedSpan(effective, span, [{ ...support, detector: { id: 'other-pattern' } }])).toEqual({
      entityType: 'EMAIL', action: 'REQUIRE_REVIEW', explanationCode: 'POLICY_REQUIRED_EVIDENCE_MISSING'
    });
    expect(evaluateAcceptedSpan(effective, span, [{ ...support, source: 'MODEL' }])).toEqual({
      entityType: 'EMAIL', action: 'REQUIRE_REVIEW', explanationCode: 'POLICY_REQUIRED_EVIDENCE_MISSING'
    });
  });

  it('rejects broken accepted-span evidence integrity and ignores unreferenced evidence', () => {
    const effective = compilePolicy(developmentLabelsPolicy);
    const span = acceptedEmail();
    const support = emailEvidence();
    const unrelated = emailEvidence({
      id: '22222222-2222-5222-8222-222222222222',
      entityType: 'PERSON',
      span: { start: 40, end: 45, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision },
      detector: { id: 'person-model' },
      source: 'MODEL'
    });
    const forward = evaluateAcceptedSpan(effective, span, [support, unrelated]);
    const reverse = evaluateAcceptedSpan(effective, span, [unrelated, support]);
    expect(forward).toEqual(reverse);
    expect(Object.keys(forward).sort()).toEqual(['action', 'entityType', 'explanationCode']);
    expect(JSON.stringify(forward)).not.toMatch(/11111111|email-pattern|sha256|start|end/u);

    const invalidInputs: readonly [AcceptedSpanInput, readonly SupportingEvidenceInput[]][] = [
      [{ ...span, evidenceIds: ['unknown-id'] }, [support]],
      [{ ...span, evidenceIds: [support.id, support.id] }, [support]],
      [span, [support, { ...support }]],
      [span, [{ ...support, entityType: 'PERSON' }]],
      [span, [{ ...support, span: { ...support.span, start: 8 } }]],
      [span, [{ ...support, span: { ...support.span, extractionRevision: parseSha256Digest(`sha256:${'b'.repeat(64)}`) } }]],
      [{ ...span, confidence: 0.96 }, [support]]
    ];
    for (const [candidate, evidence] of invalidInputs) {
      expect(() => evaluateAcceptedSpan(effective, candidate, evidence)).toThrow(TypeError);
    }
  });

  it('explains capability satisfaction without policy or artifact values', () => {
    const policy = compilePolicy(developmentLabelsPolicy);
    const context = {
      contractVersion: '1.0.0', engineModes: ['RULES_ONLY'] as const, formatId: 'text',
      operation: 'REDACT' as const, minimumQualification: 'DEVELOPMENT' as const
    };
    const satisfied = evaluateCapabilities(policy, developmentManifest, context);
    expect(satisfied.available).toBe(true);
    expect(satisfied.decisions).toHaveLength(10);
    expect(satisfied.decisions.every(({ available }) => available)).toBe(true);
    expect(Object.isFrozen(satisfied.decisions)).toBe(true);

    const unavailable = evaluateCapabilities(policy, {
      ...developmentManifest,
      detectors: [{ ...developmentManifest.detectors[0], entityTypes: ['PERSON'] }]
    }, context);
    expect(unavailable.available).toBe(false);
    expect(unavailable.decisions).toContainEqual({
      code: 'ENTITY_DETECTOR_REQUIREMENTS_SATISFIED', available: false
    });
    expect(evaluateCapabilities(policy, { sourceText: 'synthetic@example.test' }, context)).toEqual({
      available: false,
      decisions: [{ code: 'CAPABILITY_MANIFEST_VALID', available: false }]
    });

    const rulesWithModel = {
      ...developmentManifest,
      detectors: [{ ...developmentManifest.detectors[0], kinds: ['MODEL'] as const }]
    };
    expect(evaluateCapabilities(policy, rulesWithModel, context)).toEqual({
      available: false,
      decisions: [{ code: 'CAPABILITY_MANIFEST_VALID', available: false }]
    });

    const highRiskAtExperimental = evaluateCapabilities(
      compilePolicy(highRiskDisclosurePolicy),
      developmentManifest,
      { ...context, minimumQualification: 'EXPERIMENTAL' }
    );
    expect(highRiskAtExperimental.available).toBe(false);
    expect(highRiskAtExperimental.decisions).toContainEqual({
      code: 'FORMAT_QUALIFICATION_SUFFICIENT', available: false
    });
  });

  it('does not retain mutable caller input', () => {
    const source = JSON.parse(JSON.stringify(developmentLabelsPolicy)) as {
      defaults: { minimumConfidence: number };
    };
    const effective = compilePolicy(source);
    source.defaults.minimumConfidence = 0;
    expect(effective.entities.find(({ entityType }) => entityType === 'PERSON')?.minimumConfidence).toBe(0.8);
  });
});
