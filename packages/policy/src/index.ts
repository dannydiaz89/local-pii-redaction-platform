import { createHash } from 'node:crypto';

import {
  isCapabilityManifestSemanticallyValid,
  validateContract,
  type CapabilitiesCapabilityManifestContract,
  type PolicyRedactionPolicyContract
} from '@local-pii/contracts';
import {
  detectorSources,
  entityTypes,
  parseSha256Digest,
  type DetectorSource,
  type EntityType,
  type Sha256Digest
} from '@local-pii/domain';

const policySchemaId = 'https://local-pii.dev/schemas/policy/redaction-policy/1.0.0';
const capabilitySchemaId = 'https://local-pii.dev/schemas/capabilities/capability-manifest/1.0.0';

export type RedactionPolicy = PolicyRedactionPolicyContract.RedactionPolicy;
export type PolicyAction = PolicyRedactionPolicyContract.EntityRule['action'];
export type DetectorKind = NonNullable<PolicyRedactionPolicyContract.EntityRule['requiredDetectorKinds']>[number];
export type TransformationAction = CapabilitiesCapabilityManifestContract.TransformationCapability['action'];
export type EngineMode = CapabilitiesCapabilityManifestContract.CapabilityManifest['engineMode'];
export type Qualification = CapabilitiesCapabilityManifestContract.Qualification;
export type PolicyOperation = CapabilitiesCapabilityManifestContract.FormatCapability['operations'][number];
export type CapabilityManifest = CapabilitiesCapabilityManifestContract.CapabilityManifest;

export type PolicyValidationCode = 'POLICY_SCHEMA_INVALID' | 'POLICY_SEMANTIC_INVALID';

export class PolicyValidationError extends Error {
  public readonly code: PolicyValidationCode;

  public constructor(code: PolicyValidationCode) {
    super(code === 'POLICY_SCHEMA_INVALID'
      ? 'The policy does not conform to the supported closed schema.'
      : 'The policy contains incompatible threshold or assurance settings.');
    this.name = 'PolicyValidationError';
    this.code = code;
  }
}

/** All optional policy values are resolved; no caller-owned object is retained. */
export interface EffectiveEntityRule {
  readonly entityType: EntityType;
  readonly action: PolicyAction;
  readonly minimumConfidence: number;
  readonly reviewBelow: number;
  readonly uncertainBehavior: 'REQUIRE_REVIEW' | 'BLOCK' | 'KEEP';
  readonly residualBehavior: 'BLOCK' | 'WARN';
  readonly requiredDetectors: readonly string[];
  readonly requiredDetectorKinds: readonly DetectorKind[];
}

export interface EffectivePolicyRequirements {
  readonly detectorIds: readonly string[];
  readonly detectorKinds: readonly DetectorKind[];
  readonly transformationActions: readonly TransformationAction[];
  readonly verificationProfile: string;
  readonly maximumInputBytes: number;
}

export interface EffectivePolicy {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly version: string;
  readonly digest: Sha256Digest;
  readonly riskTier: 'LOW' | 'MODERATE' | 'HIGH';
  readonly entities: readonly EffectiveEntityRule[];
  readonly requirements: EffectivePolicyRequirements;
  readonly verification: Readonly<{ profile: string; blockOnWarnings: boolean }>;
  readonly limits: Readonly<{ maximumInputBytes: number }>;
}

/** Structurally compatible with the core capability requirement without importing core. */
export interface CompiledCapabilityRequirement extends EffectivePolicyRequirements {
  readonly contractVersion: string;
  readonly engineModes: readonly EngineMode[];
  readonly formatId: string;
  readonly operation: PolicyOperation;
  readonly minimumQualification: Qualification;
}

export interface CapabilityRequirementContext {
  readonly contractVersion: string;
  readonly engineModes: readonly EngineMode[];
  readonly formatId: string;
  readonly operation: PolicyOperation;
  readonly minimumQualification: Qualification;
}

export interface PolicyDecision {
  readonly entityType: EntityType;
  readonly action: PolicyAction;
  readonly explanationCode:
    | 'POLICY_ACTION'
    | 'POLICY_REVIEW_BAND'
    | 'POLICY_BELOW_THRESHOLD'
    | 'POLICY_REQUIRED_EVIDENCE_MISSING';
}

/** Structural input compatible with a resolved span after binding its extraction revision. */
export interface AcceptedSpanInput {
  readonly entityType: EntityType;
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
  readonly extractionRevision: Sha256Digest;
}

/** Structural subset of detection evidence; matched values and source text are intentionally absent. */
export interface SupportingEvidenceInput {
  readonly id: string;
  readonly entityType: EntityType;
  readonly span: Readonly<{
    start: number;
    end: number;
    offsetUnit: 'UNICODE_CODE_POINT';
    extractionRevision: Sha256Digest;
  }>;
  readonly confidence: number;
  readonly source: DetectorSource;
  readonly detector: Readonly<{ id: string }>;
}

export type CapabilityDecisionCode =
  | 'CAPABILITY_MANIFEST_VALID'
  | 'CONTRACT_VERSION_SUPPORTED'
  | 'ENGINE_MODE_SUPPORTED'
  | 'FORMAT_AVAILABLE'
  | 'OPERATION_SUPPORTED'
  | 'FORMAT_QUALIFICATION_SUFFICIENT'
  | 'ENTITY_DETECTOR_REQUIREMENTS_SATISFIED'
  | 'TRANSFORMATION_REQUIREMENTS_SATISFIED'
  | 'VERIFICATION_PROFILE_AVAILABLE'
  | 'INPUT_LIMIT_SUFFICIENT';

export interface CapabilityDecision {
  readonly code: CapabilityDecisionCode;
  readonly available: boolean;
}

export interface CapabilityEvaluation {
  readonly available: boolean;
  readonly decisions: readonly CapabilityDecision[];
}

const transformationActions = new Set<PolicyAction>([
  'REDACT', 'TYPED_LABEL', 'MASK', 'PSEUDONYM', 'HASHED_LABEL'
]);
const qualificationRank: Readonly<Record<Qualification, number>> = {
  EXPERIMENTAL: 0,
  DEVELOPMENT: 1,
  QUALIFIED: 2
};

function deepFreeze<Value>(value: Value): Readonly<Value> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertPlainJson(value: unknown, depth = 0): void {
  if (depth > 8) throw new PolicyValidationError('POLICY_SCHEMA_INVALID');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PolicyValidationError('POLICY_SCHEMA_INVALID');
    return;
  }
  if (typeof value !== 'object') throw new PolicyValidationError('POLICY_SCHEMA_INVALID');
  if (Object.getOwnPropertySymbols(value).length > 0) throw new PolicyValidationError('POLICY_SCHEMA_INVALID');
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    throw new PolicyValidationError('POLICY_SCHEMA_INVALID');
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new PolicyValidationError('POLICY_SCHEMA_INVALID');
    for (const child of value) assertPlainJson(child, depth + 1);
    return;
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new PolicyValidationError('POLICY_SCHEMA_INVALID');
    }
    assertPlainJson(descriptor.value, depth + 1);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function digest(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}` as Sha256Digest;
}

function sortedUnique<Value extends string>(values: readonly Value[]): readonly Value[] {
  return Object.freeze([...new Set(values)].sort());
}

function copyRule(rule: PolicyRedactionPolicyContract.EntityRule): PolicyRedactionPolicyContract.EntityRule {
  return {
    action: rule.action,
    minimumConfidence: rule.minimumConfidence,
    ...(rule.reviewBelow === undefined ? {} : { reviewBelow: rule.reviewBelow }),
    uncertainBehavior: rule.uncertainBehavior,
    ...(rule.residualBehavior === undefined ? {} : { residualBehavior: rule.residualBehavior }),
    ...(rule.requiredDetectors === undefined ? {} : { requiredDetectors: [...rule.requiredDetectors] }),
    ...(rule.requiredDetectorKinds === undefined ? {} : { requiredDetectorKinds: [...rule.requiredDetectorKinds] })
  };
}

/** Validates a closed-schema policy and returns a detached immutable value. */
export function validatePolicy(value: unknown): Readonly<RedactionPolicy> {
  assertPlainJson(value);
  if (!validateContract(policySchemaId, value).valid) {
    throw new PolicyValidationError('POLICY_SCHEMA_INVALID');
  }
  const source = value as RedactionPolicy;
  for (const rule of [source.defaults, ...Object.values(source.entities)]) {
    if (rule.reviewBelow !== undefined && rule.reviewBelow < rule.minimumConfidence) {
      throw new PolicyValidationError('POLICY_SEMANTIC_INVALID');
    }
    if (source.riskTier === 'HIGH' && rule.uncertainBehavior === 'KEEP') {
      throw new PolicyValidationError('POLICY_SEMANTIC_INVALID');
    }
    if (source.riskTier === 'HIGH' && rule.residualBehavior === 'WARN') {
      throw new PolicyValidationError('POLICY_SEMANTIC_INVALID');
    }
  }
  const entities = Object.fromEntries(
    Object.entries(source.entities).sort(([left], [right]) => left.localeCompare(right))
      .map(([entityType, rule]) => [entityType, copyRule(rule)])
  );
  return deepFreeze({
    schemaVersion: source.schemaVersion,
    id: source.id,
    version: source.version,
    riskTier: source.riskTier,
    defaults: copyRule(source.defaults),
    entities,
    verification: { ...source.verification },
    limits: { ...source.limits }
  });
}

function effectiveRule(
  entityType: EntityType,
  source: PolicyRedactionPolicyContract.EntityRule,
  riskTier: RedactionPolicy['riskTier']
): EffectiveEntityRule {
  if (source.reviewBelow !== undefined && source.reviewBelow < source.minimumConfidence) {
    throw new PolicyValidationError('POLICY_SEMANTIC_INVALID');
  }
  return deepFreeze({
    entityType,
    action: source.action,
    minimumConfidence: source.minimumConfidence,
    reviewBelow: source.reviewBelow ?? source.minimumConfidence,
    uncertainBehavior: source.uncertainBehavior,
    residualBehavior: source.residualBehavior ?? (riskTier === 'HIGH' ? 'BLOCK' : 'WARN'),
    requiredDetectors: sortedUnique(source.requiredDetectors ?? []),
    requiredDetectorKinds: sortedUnique(source.requiredDetectorKinds ?? [])
  });
}

/** Compiles every entity to a deterministic immutable rule and binds the exact source digest. */
export function compilePolicy(value: unknown): EffectivePolicy {
  const policy = validatePolicy(value);
  const entities = Object.freeze(entityTypes.map((entityType) => {
    const override = policy.entities[entityType];
    const merged = override === undefined ? policy.defaults : { ...policy.defaults, ...override };
    return effectiveRule(entityType, merged, policy.riskTier);
  }));
  const detectorIds = sortedUnique(entities.flatMap((rule) => rule.requiredDetectors));
  const detectorKinds = sortedUnique(entities.flatMap((rule) => rule.requiredDetectorKinds));
  const requiredTransformations = sortedUnique(
    entities.map((rule) => rule.action)
      .filter((action): action is TransformationAction => transformationActions.has(action))
  );
  const requirements = deepFreeze({
    detectorIds,
    detectorKinds,
    transformationActions: requiredTransformations,
    verificationProfile: policy.verification.profile,
    maximumInputBytes: policy.limits.maximumInputBytes
  });
  return deepFreeze({
    schemaVersion: policy.schemaVersion,
    id: policy.id,
    version: policy.version,
    digest: digest(policy),
    riskTier: policy.riskTier,
    entities,
    requirements,
    verification: { ...policy.verification },
    limits: { ...policy.limits }
  });
}

export function compileCapabilityRequirement(
  policy: EffectivePolicy,
  context: CapabilityRequirementContext
): CompiledCapabilityRequirement {
  if (context.engineModes.length === 0 || new Set(context.engineModes).size !== context.engineModes.length) {
    throw new TypeError('Capability engine modes must be non-empty and unique.');
  }
  if (context.contractVersion.length === 0 || context.formatId.length === 0) {
    throw new TypeError('Capability context identifiers must be non-empty.');
  }
  const minimumQualification = policy.riskTier === 'HIGH'
    && !qualified(context.minimumQualification, 'QUALIFIED')
    ? 'QUALIFIED'
    : context.minimumQualification;
  return deepFreeze({
    contractVersion: context.contractVersion,
    engineModes: Object.freeze([...context.engineModes]),
    formatId: context.formatId,
    operation: context.operation,
    detectorIds: Object.freeze([...policy.requirements.detectorIds]),
    detectorKinds: Object.freeze([...policy.requirements.detectorKinds]),
    transformationActions: Object.freeze([...policy.requirements.transformationActions]),
    verificationProfile: policy.requirements.verificationProfile,
    maximumInputBytes: policy.requirements.maximumInputBytes,
    minimumQualification
  });
}

function qualified(actual: Qualification, required: Qualification): boolean {
  return qualificationRank[actual] >= qualificationRank[required];
}

/** Produces a bounded, source-content-free preflight explanation in a fixed decision order. */
export function evaluateCapabilities(
  policy: EffectivePolicy,
  manifestValue: unknown,
  context: CapabilityRequirementContext
): CapabilityEvaluation {
  let manifestValid = false;
  try {
    assertPlainJson(manifestValue);
    manifestValid = validateContract(capabilitySchemaId, manifestValue).valid
      && isCapabilityManifestSemanticallyValid(manifestValue as CapabilityManifest);
  } catch {
    manifestValid = false;
  }
  if (!manifestValid) {
    const decisions = deepFreeze([
      { code: 'CAPABILITY_MANIFEST_VALID', available: false }
    ] satisfies CapabilityDecision[]);
    return deepFreeze({ available: false, decisions });
  }

  const manifest = manifestValue as CapabilityManifest;
  const minimumQualification = policy.riskTier === 'HIGH'
    && !qualified(context.minimumQualification, 'QUALIFIED')
    ? 'QUALIFIED'
    : context.minimumQualification;
  const format = manifest.formats.find(({ id }) => id === context.formatId);
  const eligibleDetectors = manifest.detectors.filter((detector) =>
    detector.availability === 'AVAILABLE'
    && qualified(detector.qualification, minimumQualification)
  );
  const entityDetectorsAvailable = policy.entities.every((rule) =>
    rule.requiredDetectors.every((id) => eligibleDetectors.some((detector) =>
      detector.id === id && detector.entityTypes.includes(rule.entityType)
    ))
    && rule.requiredDetectorKinds.every((kind) => eligibleDetectors.some((detector) =>
      detector.kinds.includes(kind) && detector.entityTypes.includes(rule.entityType)
    ))
  );
  const transformationsAvailable = policy.requirements.transformationActions.every((action) =>
    manifest.transformations.some((transformation) =>
      transformation.action === action
      && transformation.availability === 'AVAILABLE'
      && qualified(transformation.qualification, minimumQualification)
    )
  );
  const verifier = manifest.verificationProfiles.find(({ id }) => id === policy.requirements.verificationProfile);
  const verifierAvailable = verifier !== undefined
    && verifier.availability === 'AVAILABLE'
    && qualified(verifier.qualification, minimumQualification)
    && verifier.formats.includes(context.formatId)
    && format?.verificationProfiles.includes(verifier.id) === true;

  const decisions = deepFreeze([
    { code: 'CAPABILITY_MANIFEST_VALID', available: true },
    { code: 'CONTRACT_VERSION_SUPPORTED', available: manifest.supportedContractVersions.includes(context.contractVersion) },
    { code: 'ENGINE_MODE_SUPPORTED', available: context.engineModes.includes(manifest.engineMode) },
    { code: 'FORMAT_AVAILABLE', available: format !== undefined },
    { code: 'OPERATION_SUPPORTED', available: format?.operations.includes(context.operation) === true },
    {
      code: 'FORMAT_QUALIFICATION_SUFFICIENT',
      available: format !== undefined && qualified(format.qualification, minimumQualification)
    },
    { code: 'ENTITY_DETECTOR_REQUIREMENTS_SATISFIED', available: entityDetectorsAvailable },
    { code: 'TRANSFORMATION_REQUIREMENTS_SATISFIED', available: transformationsAvailable },
    { code: 'VERIFICATION_PROFILE_AVAILABLE', available: verifierAvailable },
    {
      code: 'INPUT_LIMIT_SUFFICIENT',
      available: manifest.limits.maximumInputBytes >= policy.requirements.maximumInputBytes
        && format !== undefined
        && format.limits.maximumInputBytes >= policy.requirements.maximumInputBytes
    }
  ] satisfies CapabilityDecision[]);
  return deepFreeze({ available: decisions.every((decision) => decision.available), decisions });
}

export function evaluatePolicy(policy: EffectivePolicy, entityType: EntityType, confidence: number): PolicyDecision {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError('Confidence must be between zero and one.');
  }
  const rule = policy.entities.find((candidate) => candidate.entityType === entityType);
  if (rule === undefined) throw new TypeError('Entity type is not present in the effective policy.');
  if (confidence < rule.minimumConfidence) {
    return deepFreeze({ entityType, action: rule.uncertainBehavior, explanationCode: 'POLICY_BELOW_THRESHOLD' });
  }
  if (confidence < rule.reviewBelow) {
    return deepFreeze({ entityType, action: 'REQUIRE_REVIEW', explanationCode: 'POLICY_REVIEW_BAND' });
  }
  return deepFreeze({ entityType, action: rule.action, explanationCode: 'POLICY_ACTION' });
}

function assertAcceptedSpanShape(span: AcceptedSpanInput): void {
  parseSha256Digest(span.extractionRevision);
  if (!entityTypes.includes(span.entityType)) throw new TypeError('Invalid accepted span entity type.');
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.start >= span.end) {
    throw new TypeError('Invalid accepted span offsets.');
  }
  if (!Number.isFinite(span.confidence) || span.confidence < 0 || span.confidence > 1) {
    throw new TypeError('Invalid accepted span confidence.');
  }
  if (!Array.isArray(span.evidenceIds) || span.evidenceIds.length === 0) {
    throw new TypeError('An accepted span must reference evidence.');
  }
  const ids = new Set<string>();
  for (const id of span.evidenceIds) {
    if (typeof id !== 'string' || id.length === 0 || ids.has(id)) {
      throw new TypeError('Accepted span evidence references must be non-empty and unique.');
    }
    ids.add(id);
  }
}

function referencedEvidence(
  span: AcceptedSpanInput,
  evidence: readonly SupportingEvidenceInput[]
): readonly SupportingEvidenceInput[] {
  if (!Array.isArray(evidence)) throw new TypeError('Evidence must be an array.');
  const referencedIds = new Set(span.evidenceIds);
  const byId = new Map<string, Readonly<Record<string, unknown>>>();
  for (const value of evidence as readonly unknown[]) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = value as Readonly<Record<string, unknown>>;
    const id = candidate.id;
    if (typeof id !== 'string' || !referencedIds.has(id)) continue;
    if (byId.has(id)) throw new TypeError('Referenced evidence IDs must be unique.');
    byId.set(id, candidate);
  }

  return span.evidenceIds.map((id) => {
    const candidate = byId.get(id);
    if (candidate === undefined) throw new TypeError('Accepted span references unknown evidence.');
    const candidateSpan = candidate.span;
    const detector = candidate.detector;
    if (
      candidateSpan === null
      || typeof candidateSpan !== 'object'
      || Array.isArray(candidateSpan)
      || detector === null
      || typeof detector !== 'object'
      || Array.isArray(detector)
    ) {
      throw new TypeError('Referenced evidence is malformed.');
    }
    const structuralSpan = candidateSpan as Readonly<Record<string, unknown>>;
    const structuralDetector = detector as Readonly<Record<string, unknown>>;
    if (
      candidate.entityType !== span.entityType
      || structuralSpan.start !== span.start
      || structuralSpan.end !== span.end
      || structuralSpan.offsetUnit !== 'UNICODE_CODE_POINT'
      || structuralSpan.extractionRevision !== span.extractionRevision
    ) {
      throw new TypeError('Referenced evidence does not match the accepted span.');
    }
    parseSha256Digest(structuralSpan.extractionRevision as string);
    const confidence = candidate.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new TypeError('Invalid referenced evidence confidence.');
    }
    const source = candidate.source;
    if (typeof source !== 'string' || !detectorSources.includes(source as DetectorSource)) {
      throw new TypeError('Invalid referenced evidence source.');
    }
    const detectorId = structuralDetector.id;
    if (typeof detectorId !== 'string' || detectorId.length === 0) {
      throw new TypeError('Invalid referenced detector ID.');
    }
    return {
      id,
      entityType: span.entityType,
      span: {
        start: span.start,
        end: span.end,
        offsetUnit: 'UNICODE_CODE_POINT',
        extractionRevision: span.extractionRevision
      },
      confidence,
      source: source as DetectorSource,
      detector: { id: detectorId }
    };
  });
}

/**
 * Evaluates one accepted span only after proving that its exact supporting evidence is intact.
 * The returned decision contains no offsets, evidence IDs, detector IDs, or source content.
 */
export function evaluateAcceptedSpan(
  policy: EffectivePolicy,
  span: AcceptedSpanInput,
  evidence: readonly SupportingEvidenceInput[]
): PolicyDecision {
  assertAcceptedSpanShape(span);
  const supporting = referencedEvidence(span, evidence);
  const strongestConfidence = Math.max(...supporting.map(({ confidence }) => confidence));
  if (strongestConfidence !== span.confidence) {
    throw new TypeError('Accepted span confidence does not match its supporting evidence.');
  }
  const rule = policy.entities.find(({ entityType }) => entityType === span.entityType);
  if (rule === undefined) throw new TypeError('Entity type is not present in the effective policy.');

  const requiredEvidencePresent = rule.requiredDetectors.every((detectorId) =>
    supporting.some(({ detector }) => detector.id === detectorId)
  ) && rule.requiredDetectorKinds.every((kind) =>
    supporting.some(({ source }) => source === kind)
  );
  if (!requiredEvidencePresent) {
    return deepFreeze({
      entityType: span.entityType,
      action: rule.uncertainBehavior,
      explanationCode: 'POLICY_REQUIRED_EVIDENCE_MISSING'
    });
  }
  return evaluatePolicy(policy, span.entityType, span.confidence);
}

export const developmentLabelsPolicy = deepFreeze({
  schemaVersion: '1.0.0',
  id: 'development-labels',
  version: '0.1.0',
  riskTier: 'LOW',
  defaults: {
    action: 'TYPED_LABEL',
    minimumConfidence: 0.8,
    uncertainBehavior: 'REQUIRE_REVIEW'
  },
  entities: {
    EMAIL: {
      action: 'TYPED_LABEL',
      minimumConfidence: 0.95,
      uncertainBehavior: 'REQUIRE_REVIEW',
      requiredDetectors: ['email-pattern']
    }
  },
  verification: { profile: 'text-rescan-v1', blockOnWarnings: true },
  limits: { maximumInputBytes: 104_857_600 }
} satisfies RedactionPolicy);

export const highRiskDisclosurePolicy = deepFreeze({
  schemaVersion: '1.0.0',
  id: 'high-risk-disclosure',
  version: '3.1.0',
  riskTier: 'HIGH',
  defaults: {
    action: 'TYPED_LABEL',
    minimumConfidence: 0.8,
    uncertainBehavior: 'REQUIRE_REVIEW',
    residualBehavior: 'BLOCK'
  },
  entities: {
    SSN: {
      action: 'REDACT',
      requiredDetectors: ['ssn-pattern-checksum'],
      minimumConfidence: 1,
      uncertainBehavior: 'BLOCK',
      residualBehavior: 'BLOCK'
    },
    PERSON: {
      action: 'TYPED_LABEL',
      requiredDetectorKinds: ['MODEL'],
      minimumConfidence: 0.82,
      reviewBelow: 0.93,
      uncertainBehavior: 'REQUIRE_REVIEW',
      residualBehavior: 'BLOCK'
    }
  },
  verification: { profile: 'high-risk-v1', blockOnWarnings: true },
  limits: { maximumInputBytes: 104_857_600 }
} satisfies RedactionPolicy);

export const bundledPolicies = deepFreeze({
  'development-labels': developmentLabelsPolicy,
  'high-risk-disclosure': highRiskDisclosurePolicy
});
