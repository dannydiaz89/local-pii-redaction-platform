import { createHash } from 'node:crypto';

import { entityTypes, parseDetectionId, parseSha256Digest, type EntityType, type Sha256Digest } from '@local-pii/domain';
import type { ResolutionSet } from '@local-pii/span-resolution';

export const typedLabelTransformationCapabilityDescriptor = {
  id: 'typed-label',
  version: '0.1.0',
  action: 'TYPED_LABEL',
  reversible: false
} as const;

export interface TypedLabelAction {
  readonly id: string;
  readonly action: 'TYPED_LABEL';
  readonly sourceSpanId: string;
  readonly evidenceIds: readonly string[];
  readonly entityType: EntityType;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface TypedLabelPolicyBinding {
  readonly id: string;
  readonly version: string;
  readonly digest: Sha256Digest;
  readonly riskTier: 'LOW' | 'MODERATE' | 'HIGH';
}

export interface TypedLabelWriterBinding {
  readonly id: string;
  readonly version: string;
}

export interface TypedLabelPlanBinding {
  readonly inputDigest: Sha256Digest;
  readonly capabilityDigest: Sha256Digest;
  readonly detectorBundleVersion: string;
  readonly policy: TypedLabelPolicyBinding;
  readonly writer: TypedLabelWriterBinding;
  readonly review?: TypedLabelReviewBinding;
}

export interface TypedLabelReviewProvenance {
  readonly extractionRevision: Sha256Digest;
  readonly revision: number;
  readonly decisionCount: number;
  readonly digest: Sha256Digest;
}

export type TypedLabelReviewDecision =
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
  };

export interface TypedLabelReviewBinding extends TypedLabelReviewProvenance {
  readonly decisions: readonly TypedLabelReviewDecision[];
}

interface TypedLabelPlanBase {
  readonly id: string;
  readonly strategy: 'TYPED_LABEL';
  readonly inputDigest: Sha256Digest;
  readonly extractionRevision: Sha256Digest;
  readonly resolutionDigest: Sha256Digest;
  readonly capabilityDigest: Sha256Digest;
  readonly detectorBundleVersion: string;
  readonly policy: TypedLabelPolicyBinding;
  readonly writer: TypedLabelWriterBinding;
  readonly expectedActionCount: number;
  readonly actions: readonly TypedLabelAction[];
  readonly digest: Sha256Digest;
}

export interface TypedLabelPlanV1 extends TypedLabelPlanBase {
  readonly schemaVersion: '1.0.0';
  readonly strategyVersion: '0.1.0';
}

export interface TypedLabelPlanV2 extends TypedLabelPlanBase {
  readonly schemaVersion: '2.0.0';
  readonly strategyVersion: '0.2.0';
  readonly review: TypedLabelReviewBinding;
}

export type TypedLabelPlan = TypedLabelPlanV1 | TypedLabelPlanV2;

const policyIdPattern = /^[a-z][a-z0-9-]{2,63}$/u;
const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/u;
const resolvedSpanIdPattern = /^rsp_[a-f0-9]{32}$/u;
const componentIdPattern = /^[a-z][a-z0-9-]{2,63}$/u;
const crockfordAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Readonly<Record<string, unknown>>)[key])}`
  ).join(',')}}`;
}

function sha256(value: unknown): Sha256Digest {
  return parseSha256Digest(
    `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
  );
}

function stableIdentifier(prefix: 'plan' | 'act', value: unknown): string {
  const bytes = createHash('sha256').update(canonicalJson(value), 'utf8').digest().subarray(0, 16);
  let numeric = BigInt(`0x${bytes.toString('hex')}`);
  let encoded = '';
  for (let index = 0; index < 26; index += 1) {
    encoded = `${crockfordAlphabet.charAt(Number(numeric & 31n))}${encoded}`;
    numeric >>= 5n;
  }
  return `${prefix}_${encoded}`;
}

function validatedPolicyBinding(policy: TypedLabelPolicyBinding): TypedLabelPolicyBinding {
  if (
    !policyIdPattern.test(policy.id)
    || !semverPattern.test(policy.version)
    || !['LOW', 'MODERATE', 'HIGH'].includes(policy.riskTier)
  ) {
    throw new TypeError('The typed-label plan policy binding is invalid.');
  }
  return Object.freeze({
    id: policy.id,
    version: policy.version,
    digest: parseSha256Digest(policy.digest),
    riskTier: policy.riskTier
  });
}

function validatedWriterBinding(writer: TypedLabelWriterBinding): TypedLabelWriterBinding {
  if (!componentIdPattern.test(writer.id) || !semverPattern.test(writer.version)) {
    throw new TypeError('The typed-label writer binding is invalid.');
  }
  return Object.freeze({ id: writer.id, version: writer.version });
}

function validatedReviewBinding(review: TypedLabelReviewBinding): TypedLabelReviewBinding {
  if (!Number.isSafeInteger(review.revision)
    || review.revision < 0
    || review.revision > 1000
    || !Number.isSafeInteger(review.decisionCount)
    || review.decisionCount !== review.revision
    || review.decisions.length > review.decisionCount) {
    throw new TypeError('The typed-label review binding is invalid.');
  }
  const sourceSpanIds = new Set<string>();
  let previousEnd = -1;
  const decisions = review.decisions.map((decision) => {
    if (!resolvedSpanIdPattern.test(decision.sourceSpanId)
      || sourceSpanIds.has(decision.sourceSpanId)
      || !['ACCEPT', 'REJECT', 'RETYPE'].includes(decision.action)
      || !entityTypes.includes(decision.entityType)
      || !Number.isSafeInteger(decision.start)
      || !Number.isSafeInteger(decision.end)
      || decision.start < 0
      || decision.end <= decision.start
      || decision.start < previousEnd) {
      throw new TypeError('The typed-label review decision is invalid.');
    }
    sourceSpanIds.add(decision.sourceSpanId);
    previousEnd = decision.end;
    const entityType = decision.entityType;
    if (decision.action === 'RETYPE') {
      if (!entityTypes.includes(decision.reviewedEntityType)) {
        throw new TypeError('The typed-label review decision is invalid.');
      }
      return Object.freeze({
        sourceSpanId: decision.sourceSpanId,
        action: decision.action,
        entityType,
        reviewedEntityType: decision.reviewedEntityType,
        start: decision.start,
        end: decision.end
      });
    }
    return Object.freeze({
      sourceSpanId: decision.sourceSpanId,
      action: decision.action,
      entityType,
      start: decision.start,
      end: decision.end
    });
  });
  return Object.freeze({
    extractionRevision: parseSha256Digest(review.extractionRevision),
    revision: review.revision,
    decisionCount: review.decisionCount,
    digest: parseSha256Digest(review.digest),
    decisions: Object.freeze(decisions)
  });
}

function validatedPlanBinding(binding: TypedLabelPlanBinding): TypedLabelPlanBinding {
  if (
    typeof binding.detectorBundleVersion !== 'string'
    || binding.detectorBundleVersion.length < 1
    || binding.detectorBundleVersion.length > 100
  ) {
    throw new TypeError('The detector bundle binding is invalid.');
  }
  return Object.freeze({
    inputDigest: parseSha256Digest(binding.inputDigest),
    capabilityDigest: parseSha256Digest(binding.capabilityDigest),
    detectorBundleVersion: binding.detectorBundleVersion,
    policy: validatedPolicyBinding(binding.policy),
    writer: validatedWriterBinding(binding.writer),
    ...(binding.review === undefined ? {} : { review: validatedReviewBinding(binding.review) })
  });
}

/** Compiles only the caller's explicit policy-approved resolution subset. */
export function compileTypedLabelPlan(
  approvedResolution: ResolutionSet,
  planBinding: TypedLabelPlanBinding
): TypedLabelPlan {
  if (approvedResolution.conflicts.length > 0) {
    throw new Error('Cannot compile a redaction plan with unresolved span conflicts');
  }
  const binding = validatedPlanBinding(planBinding);
  const resolutionDigest = parseSha256Digest(approvedResolution.digest);
  if (binding.review !== undefined
    && binding.review.extractionRevision !== approvedResolution.extractionRevision) {
    throw new TypeError('The review set targets a different extraction revision.');
  }
  const counters = new Map<EntityType, number>();
  const sourceSpanIds = new Set<string>();
  const actions = approvedResolution.spans.map((span) => {
    if (!resolvedSpanIdPattern.test(span.id) || sourceSpanIds.has(span.id)) {
      throw new TypeError('The approved resolution contains an invalid or duplicate span identifier.');
    }
    sourceSpanIds.add(span.id);
    if (span.evidenceIds.length === 0 || new Set(span.evidenceIds).size !== span.evidenceIds.length) {
      throw new TypeError('An approved span must retain unique supporting evidence identifiers.');
    }
    const evidenceIds = Object.freeze([...span.evidenceIds].map((id) => parseDetectionId(id)).sort());
    const sequence = (counters.get(span.entityType) ?? 0) + 1;
    counters.set(span.entityType, sequence);
    const actionWithoutId = {
      action: 'TYPED_LABEL' as const,
      sourceSpanId: span.id,
      evidenceIds,
      entityType: span.entityType,
      start: span.start,
      end: span.end,
      replacement: `[${span.entityType}_${String(sequence)}]`
    };
    return Object.freeze({
      id: stableIdentifier('act', {
        resolutionDigest,
        policyDigest: binding.policy.digest,
        ...(binding.review === undefined ? {} : { reviewDigest: binding.review.digest }),
        action: actionWithoutId
      }),
      ...actionWithoutId
    } satisfies TypedLabelAction);
  });
  const frozenActions = Object.freeze(actions);
  const commonPlan = {
    strategy: 'TYPED_LABEL' as const,
    inputDigest: binding.inputDigest,
    extractionRevision: approvedResolution.extractionRevision,
    resolutionDigest,
    capabilityDigest: binding.capabilityDigest,
    detectorBundleVersion: binding.detectorBundleVersion,
    policy: binding.policy,
    writer: binding.writer,
    expectedActionCount: frozenActions.length,
    actions: frozenActions
  };
  const planWithoutIdentity = binding.review === undefined
    ? {
      schemaVersion: '1.0.0' as const,
      strategyVersion: '0.1.0' as const,
      ...commonPlan
    }
    : {
      schemaVersion: '2.0.0' as const,
      strategyVersion: '0.2.0' as const,
      ...commonPlan,
      review: binding.review
    };
  const id = stableIdentifier('plan', planWithoutIdentity);
  return Object.freeze({
    id,
    ...planWithoutIdentity,
    digest: sha256({ id, ...planWithoutIdentity })
  });
}

/** Rejects any plan whose provenance, actions, identity, or digest were altered after compilation. */
export function assertTypedLabelPlanIntegrity(plan: TypedLabelPlan): void {
  parseSha256Digest(plan.inputDigest);
  parseSha256Digest(plan.extractionRevision);
  parseSha256Digest(plan.resolutionDigest);
  parseSha256Digest(plan.capabilityDigest);
  validatedPolicyBinding(plan.policy);
  validatedWriterBinding(plan.writer);
  const strategyVersion: string = plan.strategyVersion;
  if ((plan.schemaVersion === '1.0.0' && strategyVersion !== '0.1.0')
    || (plan.schemaVersion === '2.0.0' && strategyVersion !== '0.2.0')) {
    throw new TypeError('The typed-label plan version is invalid.');
  }
  const review = plan.schemaVersion === '2.0.0' ? validatedReviewBinding(plan.review) : undefined;
  if (review !== undefined && review.extractionRevision !== plan.extractionRevision) {
    throw new TypeError('The typed-label plan review binding is invalid.');
  }
  if (plan.expectedActionCount !== plan.actions.length) {
    throw new TypeError('The typed-label plan action count is invalid.');
  }
  const sourceSpanIds = new Set<string>();
  for (const action of plan.actions) {
    if (
      !resolvedSpanIdPattern.test(action.sourceSpanId)
      || sourceSpanIds.has(action.sourceSpanId)
      || action.evidenceIds.length === 0
      || new Set(action.evidenceIds).size !== action.evidenceIds.length
    ) {
      throw new TypeError('The typed-label plan action provenance is invalid.');
    }
    sourceSpanIds.add(action.sourceSpanId);
    for (const evidenceId of action.evidenceIds) parseDetectionId(evidenceId);
    const { id, ...actionWithoutId } = action;
    if (id !== stableIdentifier('act', {
      resolutionDigest: plan.resolutionDigest,
      policyDigest: plan.policy.digest,
      ...(review === undefined ? {} : { reviewDigest: review.digest }),
      action: actionWithoutId
    })) {
      throw new TypeError('The typed-label plan action identity is invalid.');
    }
  }
  const { digest, id, ...planWithoutIdentity } = plan;
  if (id !== stableIdentifier('plan', planWithoutIdentity)) {
    throw new TypeError('The typed-label plan identity is invalid.');
  }
  if (parseSha256Digest(digest) !== sha256({ id, ...planWithoutIdentity })) {
    throw new TypeError('The typed-label plan digest is invalid.');
  }
}

export function applyTypedLabelPlan(text: string, plan: TypedLabelPlan): string {
  assertTypedLabelPlanIntegrity(plan);
  const output: string[] = [];
  const actionsByStart = new Map<number, TypedLabelAction>();
  for (const action of plan.actions) {
    if (actionsByStart.has(action.start) || action.start < 0 || action.start >= action.end) {
      throw new RangeError('Redaction action is outside canonical text bounds');
    }
    actionsByStart.set(action.start, action);
  }
  let codePointIndex = 0;
  let utf16Index = 0;
  let unchangedStart = 0;
  let appliedActionCount = 0;
  while (utf16Index < text.length) {
    const action = actionsByStart.get(codePointIndex);
    if (action === undefined) {
      const value = text.codePointAt(utf16Index);
      utf16Index += value !== undefined && value > 0xffff ? 2 : 1;
      codePointIndex += 1;
      continue;
    }
    output.push(text.slice(unchangedStart, utf16Index), action.replacement);
    while (codePointIndex < action.end && utf16Index < text.length) {
      const value = text.codePointAt(utf16Index);
      utf16Index += value !== undefined && value > 0xffff ? 2 : 1;
      codePointIndex += 1;
    }
    if (codePointIndex !== action.end) {
      throw new RangeError('Redaction action is outside canonical text bounds');
    }
    unchangedStart = utf16Index;
    appliedActionCount += 1;
  }
  if (appliedActionCount !== plan.actions.length) {
    throw new RangeError('Redaction action is outside canonical text bounds');
  }
  output.push(text.slice(unchangedStart));
  return output.join('');
}
