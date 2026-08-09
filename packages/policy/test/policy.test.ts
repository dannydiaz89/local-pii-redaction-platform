import { describe, expect, it } from 'vitest';

import {
  PolicyValidationError,
  bundledPolicies,
  compileCapabilityRequirement,
  compilePolicy,
  developmentLabelsPolicy,
  evaluateCapabilities,
  evaluatePolicy,
  highRiskDisclosurePolicy,
  validatePolicy
} from '../src/index.js';
import type { CapabilityManifest } from '../src/index.js';

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

describe('policy validation and compilation', () => {
  it('validates and freezes both exact bundled examples', () => {
    expect(validatePolicy(developmentLabelsPolicy)).toEqual(developmentLabelsPolicy);
    expect(validatePolicy(highRiskDisclosurePolicy)).toEqual(highRiskDisclosurePolicy);
    expect(Object.isFrozen(developmentLabelsPolicy)).toBe(true);
    expect(Object.isFrozen(highRiskDisclosurePolicy.entities.PERSON)).toBe(true);
    expect(Object.keys(bundledPolicies)).toEqual(['development-labels', 'high-risk-disclosure']);
  });

  it('rejects unknown fields and unsupported schema versions', () => {
    for (const value of [
      { ...developmentLabelsPolicy, execute: 'process.env.SECRET' },
      { ...developmentLabelsPolicy, schemaVersion: '2.0.0' }
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
