import {
  computeVerificationAttestationDigest,
  computeWriterReceiptDigest,
  isRfc3339DateTime,
  type RedactionWriterReceiptContract,
  type VerificationVerificationReportV2Contract
} from '@local-pii/contracts';
import { detectDeterministic, deterministicDetectorBundleVersion } from '@local-pii/detectors';
import type { EntityType, Sha256Digest } from '@local-pii/domain';
import { entityTypes, parseSha256Digest, unicodeCodePointLength } from '@local-pii/domain';
import { resolveEvidence } from '@local-pii/span-resolution';

export const textVerificationCapabilityDescriptor = {
  id: 'text-rescan-v1',
  version: '0.1.0',
  formats: ['text'],
  checks: ['UTF8_REOPEN', 'DETERMINISTIC_RESCAN', 'SPAN_RESOLUTION']
} as const;

/** The versioned text profile implemented by this package. */
export const textVerificationProfile = Object.freeze({
  id: 'text-rescan-v1',
  version: '0.1.0',
  digest: parseSha256Digest('sha256:01cc3ad157021e3b9ebd1d0fde63bbbc58327bc18ca87ce83ce3584491bf38f7')
});

/** The verifier implementation identity bound into every v2 attestation. */
export const textVerificationVerifier = Object.freeze({
  id: 'text-verifier',
  version: '0.1.0',
  digest: parseSha256Digest('sha256:f02b299c5ca5599bf36ae91c48afd6fcedabc0152f0967171397b9036f56992a')
});

export const textVerificationDetectorBundle = Object.freeze({
  id: 'deterministic-text',
  version: deterministicDetectorBundleVersion,
  digest: parseSha256Digest('sha256:afc4a7a4e0e81af7244cb023b9b16575127998858f35270aab36a934419b0480')
});

export interface VerificationFinding {
  readonly code: 'RESIDUAL_DETECTION' | 'SPAN_CONFLICT';
  readonly severity: 'ERROR';
  readonly blocking: true;
  readonly entityType?: EntityType;
  readonly start?: number;
  readonly end?: number;
}

export interface TextVerificationReport {
  readonly schemaVersion: '1.0.0';
  readonly profile: 'text-rescan-v1';
  readonly outcome: 'PASS' | 'FAIL';
  readonly detectorBundleVersion: string;
  readonly checks: readonly ['UTF8_REOPEN', 'DETERMINISTIC_RESCAN', 'SPAN_RESOLUTION'];
  readonly findings: readonly VerificationFinding[];
}

export function verifyCanonicalText(text: string, extractionRevision: Sha256Digest): TextVerificationReport {
  const evidence = detectDeterministic(text, extractionRevision);
  const resolution = resolveEvidence(evidence, extractionRevision, unicodeCodePointLength(text));
  const findings: VerificationFinding[] = [
    ...resolution.spans.map((span) => ({
      code: 'RESIDUAL_DETECTION' as const,
      severity: 'ERROR' as const,
      blocking: true as const,
      entityType: span.entityType,
      start: span.start,
      end: span.end
    })),
    ...resolution.conflicts.map((conflict) => ({
      code: 'SPAN_CONFLICT' as const,
      severity: 'ERROR' as const,
      blocking: true as const,
      start: conflict.start,
      end: conflict.end
    }))
  ];
  return {
    schemaVersion: '1.0.0',
    profile: 'text-rescan-v1',
    outcome: findings.length === 0 ? 'PASS' : 'FAIL',
    detectorBundleVersion: deterministicDetectorBundleVersion,
    checks: ['UTF8_REOPEN', 'DETERMINISTIC_RESCAN', 'SPAN_RESOLUTION'],
    findings
  };
}

type VerificationAttestation = VerificationVerificationReportV2Contract.VerificationAttestationV2;
type VerificationAttestationFinding = VerificationAttestation['findings'][number];
type VerificationCheck = VerificationAttestation['checks'][number];

export type WriterReceipt = RedactionWriterReceiptContract.WriterReceipt;

/**
 * The plan fields needed for verification are deliberately structural.  This
 * permits the verifier to remain independent of the writer and redaction
 * implementation while retaining every security-relevant binding.
 */
export interface VerificationPlanBinding {
  readonly id: string;
  readonly digest: Sha256Digest;
  readonly inputDigest: Sha256Digest;
  readonly extractionRevision: Sha256Digest;
  readonly capabilityDigest: Sha256Digest;
  readonly policy: {
    readonly id: string;
    readonly version: string;
    readonly digest: Sha256Digest;
    readonly riskTier: 'LOW' | 'MODERATE' | 'HIGH';
  };
  readonly writer: { readonly id: string; readonly version: string };
  readonly expectedActionCount: number;
  readonly actions: readonly {
    readonly id: string;
    readonly sourceSpanId?: string;
    readonly entityType?: EntityType;
    readonly start?: number;
    readonly end?: number;
    readonly replacement?: string;
  }[];
  readonly review?: {
    readonly extractionRevision: Sha256Digest;
    readonly revision: number;
    readonly decisionCount: number;
    readonly digest: Sha256Digest;
    readonly decisions: readonly (
      | {
        readonly sourceSpanId: string;
        readonly action: 'ACCEPT' | 'REJECT';
        readonly entityType: EntityType;
        readonly start: number;
        readonly end: number;
      }
      | {
        readonly sourceSpanId: string;
        readonly action: 'RETYPE';
        readonly entityType: EntityType;
        readonly reviewedEntityType: EntityType;
        readonly start: number;
        readonly end: number;
      }
    )[];
  };
}

export interface VerificationPolicyBinding {
  readonly id: string;
  readonly version: string;
  readonly digest: Sha256Digest;
  readonly riskTier: 'LOW' | 'MODERATE' | 'HIGH';
}

export interface VerificationComponentBinding {
  readonly id: string;
  readonly version: string;
  readonly digest: Sha256Digest;
}

/** Inputs supplied by the independent reopen path; no writer or publisher is exposed here. */
export interface BoundTextVerificationRequest {
  /** Canonical text independently reopened from the exact derived output. */
  readonly reopenedText: string;
  readonly input: { readonly digest: Sha256Digest; readonly byteLength: number };
  readonly output: {
    readonly digest: Sha256Digest;
    readonly byteLength: number;
    readonly mediaType: string;
    readonly extractionRevision: Sha256Digest;
  };
  readonly capabilityDigest: Sha256Digest;
  readonly plan: VerificationPlanBinding;
  readonly policy: VerificationPolicyBinding;
  readonly writerReceipt: WriterReceipt;
  readonly writer: VerificationComponentBinding;
  readonly application: VerificationComponentBinding;
  /** Caller-provided clock values keep attestation generation deterministic and testable. */
  readonly startedAt: string;
  readonly completedAt: string;
}

export type UnsignedVerificationAttestation = Omit<VerificationAttestation, 'reportDigest'>;

const v2Checks = [
  'UTF8_REOPEN',
  'DETERMINISTIC_RESCAN',
  'SPAN_RESOLUTION',
  'ACTION_RECONCILIATION'
] as unknown as VerificationAttestation['checks'];
const fallbackDigest = `sha256:${'0'.repeat(64)}`;
const fallbackPlanId = 'plan_00000000000000000000000000';
const fallbackCompletedAt = '1970-01-01T00:00:00Z';
const actionIdPattern = /^act_[0-9A-HJKMNP-TV-Z]{26}$/u;
const planIdPattern = /^plan_[0-9A-HJKMNP-TV-Z]{26}$/u;
const policyIdPattern = /^[a-z][a-z0-9-]{2,63}$/u;
const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const textMediaTypes = new Set(['text/plain', 'text/markdown']);
const resolvedSpanIdPattern = /^rsp_[a-f0-9]{32}$/u;

function isDigest(value: unknown): value is Sha256Digest {
  try {
    parseSha256Digest(value as string);
    return true;
  } catch {
    return false;
  }
}

function safeDigest(value: unknown): string {
  return isDigest(value) ? value : fallbackDigest;
}

function safeByteLength(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1073741824 ? value : 0;
}

function validByteLength(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1073741824;
}

function safeActionCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : 0;
}

function validActionCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100000;
}

function isRiskTier(value: unknown): value is VerificationPolicyBinding['riskTier'] {
  return value === 'LOW' || value === 'MODERATE' || value === 'HIGH';
}

function validVersionedIdentity(value: Readonly<{ readonly id: unknown; readonly version: unknown }>): boolean {
  return typeof value.id === 'string' && policyIdPattern.test(value.id)
    && typeof value.version === 'string' && semverPattern.test(value.version);
}

function validComponent(value: Readonly<{
  readonly id: unknown;
  readonly version: unknown;
  readonly digest: unknown;
}>): boolean {
  return validVersionedIdentity(value) && isDigest(value.digest);
}

function safePolicy(policy: VerificationPolicyBinding): VerificationAttestation['policy'] {
  if (
    typeof policy.id === 'string' && policyIdPattern.test(policy.id)
    && typeof policy.version === 'string' && semverPattern.test(policy.version)
    && isDigest(policy.digest)
    && isRiskTier(policy.riskTier)
  ) {
    return { id: policy.id, version: policy.version, digest: policy.digest, riskTier: policy.riskTier };
  }
  return { id: 'invalid-binding', version: '0.0.0', digest: fallbackDigest, riskTier: 'LOW' };
}

function safeTime(value: unknown): string {
  return typeof value === 'string' && isRfc3339DateTime(value) ? value : fallbackCompletedAt;
}

function finding(
  code: VerificationAttestationFinding['code'],
  check: VerificationCheck,
  count?: number,
  entityType?: EntityType
): VerificationAttestationFinding {
  return {
    code,
    severity: 'ERROR',
    blocking: true,
    check,
    ...(entityType === undefined ? {} : { entityType }),
    ...(count === undefined ? {} : { count })
  };
}

interface Reconciliation {
  readonly expectedActionCount: number;
  readonly appliedActionCount: number;
  readonly missingActionCount: number;
  readonly unexpectedActionCount: number;
  readonly duplicateActionCount: number;
}

function emptyReconciliation(plan: VerificationPlanBinding): Reconciliation {
  return {
    expectedActionCount: safeActionCount(plan.expectedActionCount),
    appliedActionCount: 0,
    missingActionCount: 0,
    unexpectedActionCount: 0,
    duplicateActionCount: 0
  };
}

function reconcileActions(plan: VerificationPlanBinding, receipt: WriterReceipt): Reconciliation {
  const expected = plan.actions.map(({ id }) => id);
  const applied = receipt.appliedActionIds;
  const expectedSet = new Set(expected);
  const appliedSet = new Set(applied);
  const missingActionCount = expected.filter((id) => !appliedSet.has(id)).length;
  const unexpectedActionCount = applied.filter((id) => !expectedSet.has(id)).length;
  const duplicateActionCount = applied.length - appliedSet.size;
  const expectedCountMismatch = Math.abs(receipt.expectedActionCount - plan.expectedActionCount);
  return {
    expectedActionCount: plan.expectedActionCount,
    appliedActionCount: receipt.appliedActionCount,
    missingActionCount: Math.max(missingActionCount, expectedCountMismatch),
    unexpectedActionCount,
    duplicateActionCount
  };
}

function actionFindings(reconciliation: Reconciliation): VerificationAttestationFinding[] {
  const findings: VerificationAttestationFinding[] = [];
  if (reconciliation.missingActionCount > 0) {
    findings.push(finding('ACTION_NOT_APPLIED', 'ACTION_RECONCILIATION', reconciliation.missingActionCount));
  }
  if (reconciliation.unexpectedActionCount > 0) {
    findings.push(finding('UNEXPECTED_ACTION', 'ACTION_RECONCILIATION', reconciliation.unexpectedActionCount));
  }
  if (reconciliation.duplicateActionCount > 0) {
    findings.push(finding('DUPLICATE_ACTION', 'ACTION_RECONCILIATION', reconciliation.duplicateActionCount));
  }
  return findings;
}

function hasValidReceiptShape(receipt: WriterReceipt): boolean {
  const schemaVersion: string = receipt.schemaVersion;
  if (
    schemaVersion !== '1.0.0'
    || !isDigest(receipt.planDigest)
    || !isDigest(receipt.stagedDigest)
    || !isDigest(receipt.receiptDigest)
    || !validVersionedIdentity(receipt.writer)
    || !validByteLength(receipt.stagedByteLength)
    || !validActionCount(receipt.expectedActionCount)
    || !validActionCount(receipt.appliedActionCount)
    || !Array.isArray(receipt.appliedActionIds)
    || receipt.appliedActionCount !== receipt.appliedActionIds.length
    || !receipt.appliedActionIds.every((id) => typeof id === 'string' && actionIdPattern.test(id))
  ) {
    return false;
  }
  try {
    const { receiptDigest, ...unsigned } = receipt;
    return computeWriterReceiptDigest(unsigned) === receiptDigest;
  } catch {
    return false;
  }
}

function hasValidPlanShape(plan: VerificationPlanBinding): boolean {
  const baseIsValid = planIdPattern.test(plan.id)
    && isDigest(plan.digest)
    && isDigest(plan.inputDigest)
    && isDigest(plan.extractionRevision)
    && isDigest(plan.capabilityDigest)
    && validVersionedIdentity(plan.writer)
    && typeof plan.policy.id === 'string' && policyIdPattern.test(plan.policy.id)
    && typeof plan.policy.version === 'string' && semverPattern.test(plan.policy.version)
    && isDigest(plan.policy.digest)
    && isRiskTier(plan.policy.riskTier)
    && validActionCount(plan.expectedActionCount)
    && plan.expectedActionCount === plan.actions.length
    && plan.actions.every(({ id }) => typeof id === 'string' && actionIdPattern.test(id))
    && new Set(plan.actions.map(({ id }) => id)).size === plan.actions.length;
  if (!baseIsValid || plan.review === undefined) return baseIsValid;
  const review = plan.review;
  const actionSpans = new Map<string, {
    readonly entityType: EntityType;
    readonly start: number;
    readonly end: number;
  }>();
  let priorActionEnd = -1;
  for (const action of [...plan.actions].sort((left, right) => (left.start ?? -1) - (right.start ?? -1))) {
    if (typeof action.sourceSpanId !== 'string'
      || !resolvedSpanIdPattern.test(action.sourceSpanId)
      || actionSpans.has(action.sourceSpanId)
      || !entityTypes.includes(action.entityType as EntityType)
      || typeof action.start !== 'number'
      || !Number.isSafeInteger(action.start)
      || typeof action.end !== 'number'
      || !Number.isSafeInteger(action.end)
      || action.start < 0
      || action.end <= action.start
      || action.start < priorActionEnd
      || typeof action.replacement !== 'string') return false;
    actionSpans.set(action.sourceSpanId, {
      entityType: action.entityType as EntityType,
      start: action.start,
      end: action.end
    });
    priorActionEnd = action.end;
  }
  if (!isDigest(review.extractionRevision)
    || review.extractionRevision !== plan.extractionRevision
    || !isDigest(review.digest)
    || !Number.isSafeInteger(review.revision)
    || review.revision < 0
    || review.revision > 1000
    || review.decisionCount !== review.revision
    || review.decisions.length > review.decisionCount) return false;
  const reviewSpanIds = new Set<string>();
  let priorEnd = -1;
  for (const decision of review.decisions) {
    if (!resolvedSpanIdPattern.test(decision.sourceSpanId)
      || reviewSpanIds.has(decision.sourceSpanId)
      || !Number.isSafeInteger(decision.start)
      || !Number.isSafeInteger(decision.end)
      || decision.start < 0
      || decision.end <= decision.start
      || decision.start < priorEnd
      || !entityTypes.includes(decision.entityType)) return false;
    const actionSpan = actionSpans.get(decision.sourceSpanId);
    if (decision.action === 'REJECT') {
      if (actionSpan !== undefined) return false;
    } else if (actionSpan === undefined
      || actionSpan.start !== decision.start
      || actionSpan.end !== decision.end
      || actionSpan.entityType !== (decision.action === 'RETYPE'
        ? decision.reviewedEntityType
        : decision.entityType)) return false;
    if (decision.action === 'RETYPE' && !entityTypes.includes(decision.reviewedEntityType)) return false;
    reviewSpanIds.add(decision.sourceSpanId);
    priorEnd = decision.end;
  }
  return true;
}

function permittedReviewedResiduals(plan: VerificationPlanBinding): ReadonlySet<string> {
  if (plan.review === undefined) return new Set();
  const actions = plan.actions
    .map((action) => ({
      start: action.start as number,
      end: action.end as number,
      replacementLength: unicodeCodePointLength(action.replacement as string)
    }))
    .sort((left, right) => left.start - right.start);
  const allowed = new Set<string>();
  for (const decision of plan.review.decisions) {
    if (decision.action !== 'REJECT') continue;
    let delta = 0;
    for (const action of actions) {
      if (action.end > decision.start) break;
      delta += action.replacementLength - (action.end - action.start);
    }
    const start = decision.start + delta;
    const end = start + (decision.end - decision.start);
    allowed.add(`${decision.entityType}:${String(start)}:${String(end)}`);
  }
  return allowed;
}

/**
 * Independently verifies an exact reopened text output and emits a bound,
 * canonical v2 attestation. This function intentionally has no publish side
 * effects and never returns clear values, paths, spans, or action IDs.
 */
export function verifyBoundCanonicalText(request: BoundTextVerificationRequest): VerificationAttestation {
  const reportInput: VerificationAttestation['input'] = {
    digest: safeDigest(request.input.digest),
    byteLength: safeByteLength(request.input.byteLength)
  };
  const reportOutput: VerificationAttestation['output'] = {
    digest: safeDigest(request.output.digest),
    byteLength: safeByteLength(request.output.byteLength),
    mediaType: textMediaTypes.has(request.output.mediaType) ? request.output.mediaType : 'text/plain',
    extractionRevision: safeDigest(request.output.extractionRevision)
  };
  const reportPlan: VerificationAttestation['plan'] = {
    id: typeof request.plan.id === 'string' && planIdPattern.test(request.plan.id) ? request.plan.id : fallbackPlanId,
    digest: safeDigest(request.plan.digest)
  };
  const reportPolicy = safePolicy(request.policy);
  const base = {
    schemaVersion: '2.0.0' as const,
    input: reportInput,
    output: reportOutput,
    plan: reportPlan,
    policy: reportPolicy,
    capabilityDigest: safeDigest(request.capabilityDigest),
    writerReceiptDigest: safeDigest(request.writerReceipt.receiptDigest),
    profile: { ...textVerificationProfile },
    verifier: { ...textVerificationVerifier },
    detectorBundle: { ...textVerificationDetectorBundle },
    writer: {
      id: request.writer.id,
      version: request.writer.version,
      digest: safeDigest(request.writer.digest)
    },
    application: {
      id: request.application.id,
      version: request.application.version,
      digest: safeDigest(request.application.digest)
    },
    checks: v2Checks,
    startedAt: safeTime(request.startedAt),
    completedAt: safeTime(request.completedAt)
  };

  const malformed = !hasValidPlanShape(request.plan)
    || !hasValidReceiptShape(request.writerReceipt)
    || !isDigest(request.input.digest)
    || !validByteLength(request.input.byteLength)
    || !isDigest(request.output.digest)
    || !validByteLength(request.output.byteLength)
    || !isDigest(request.output.extractionRevision)
    || !textMediaTypes.has(request.output.mediaType)
    || !isDigest(request.capabilityDigest)
    || !isRfc3339DateTime(request.startedAt)
    || !isRfc3339DateTime(request.completedAt)
    || Date.parse(request.completedAt) < Date.parse(request.startedAt)
    || !validVersionedIdentity(request.policy)
    || !validComponent(request.writer)
    || !validComponent(request.application);
  const bindingMismatch = !malformed && (
    request.plan.inputDigest !== request.input.digest
    || request.plan.capabilityDigest !== request.capabilityDigest
    || request.plan.policy.id !== request.policy.id
    || request.plan.policy.version !== request.policy.version
    || request.plan.policy.digest !== request.policy.digest
    || request.plan.policy.riskTier !== request.policy.riskTier
    || request.writerReceipt.planDigest !== request.plan.digest
    || request.writerReceipt.stagedDigest !== request.output.digest
    || request.writerReceipt.stagedByteLength !== request.output.byteLength
    || request.writerReceipt.writer.id !== request.plan.writer.id
    || request.writerReceipt.writer.version !== request.plan.writer.version
    || request.writer.id !== request.plan.writer.id
    || request.writer.version !== request.plan.writer.version
  );
  const outputDigestMismatch = !malformed && request.writerReceipt.stagedDigest !== request.output.digest;

  if (malformed || bindingMismatch) {
    const findings = [
      ...(outputDigestMismatch ? [finding('OUTPUT_DIGEST_MISMATCH', 'UTF8_REOPEN')] : []),
      finding('VERIFIER_INCOMPLETE', malformed ? 'STRUCTURE' : 'ACTION_RECONCILIATION')
    ];
    const unsigned: UnsignedVerificationAttestation = {
      ...base,
      outcome: 'INCOMPLETE',
      reconciliation: emptyReconciliation(request.plan),
      findings
    };
    return { ...unsigned, reportDigest: computeVerificationAttestationDigest(unsigned) };
  }

  try {
    const reconciliation = reconcileActions(request.plan, request.writerReceipt);
    const findings = actionFindings(reconciliation);
    const evidence = detectDeterministic(request.reopenedText, request.output.extractionRevision);
    const resolution = resolveEvidence(evidence, request.output.extractionRevision, unicodeCodePointLength(request.reopenedText));
    if (resolution.conflicts.length > 0) {
      const unsigned: UnsignedVerificationAttestation = {
        ...base,
        outcome: 'INCOMPLETE',
        reconciliation,
        findings: [finding('VERIFIER_INCOMPLETE', 'SPAN_RESOLUTION')]
      };
      return { ...unsigned, reportDigest: computeVerificationAttestationDigest(unsigned) };
    }
    const permittedResiduals = permittedReviewedResiduals(request.plan);
    const residualCounts = new Map<EntityType, number>();
    for (const span of resolution.spans) {
      if (permittedResiduals.has(`${span.entityType}:${String(span.start)}:${String(span.end)}`)) continue;
      residualCounts.set(span.entityType, (residualCounts.get(span.entityType) ?? 0) + 1);
    }
    for (const [entityType, count] of residualCounts) {
      findings.push(finding('RESIDUAL_ENTITY', 'DETERMINISTIC_RESCAN', count, entityType));
    }
    const unsigned: UnsignedVerificationAttestation = {
      ...base,
      outcome: findings.length === 0 ? 'PASS' : 'FAIL',
      reconciliation,
      findings
    };
    return { ...unsigned, reportDigest: computeVerificationAttestationDigest(unsigned) };
  } catch {
    const unsigned: UnsignedVerificationAttestation = {
      ...base,
      outcome: 'INCOMPLETE',
      reconciliation: emptyReconciliation(request.plan),
      findings: [finding('VERIFIER_INCOMPLETE', 'DETERMINISTIC_RESCAN')]
    };
    return { ...unsigned, reportDigest: computeVerificationAttestationDigest(unsigned) };
  }
}
