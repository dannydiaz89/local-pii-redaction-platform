import { createHash } from 'node:crypto';

import { parseDetectionId, parseSha256Digest, type EntityType, type Sha256Digest } from '@local-pii/domain';
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
}

export interface TypedLabelPlan {
  readonly schemaVersion: '1.0.0';
  readonly id: string;
  readonly strategy: 'TYPED_LABEL';
  readonly strategyVersion: '0.1.0';
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
    writer: validatedWriterBinding(binding.writer)
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
        action: actionWithoutId
      }),
      ...actionWithoutId
    } satisfies TypedLabelAction);
  });
  const frozenActions = Object.freeze(actions);
  const planWithoutIdentity = {
    schemaVersion: '1.0.0' as const,
    strategy: 'TYPED_LABEL' as const,
    strategyVersion: '0.1.0' as const,
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
  const codePoints = Array.from(text);
  let output = codePoints;
  for (const action of [...plan.actions].sort((left, right) => right.start - left.start || right.end - left.end)) {
    if (action.start < 0 || action.start >= action.end || action.end > codePoints.length) {
      throw new RangeError('Redaction action is outside canonical text bounds');
    }
    output = [...output.slice(0, action.start), action.replacement, ...output.slice(action.end)];
  }
  return output.join('');
}
