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
}

export interface TypedLabelPlan {
  readonly strategy: 'TYPED_LABEL';
  readonly strategyVersion: '0.1.0';
  readonly extractionRevision: Sha256Digest;
  readonly policy: TypedLabelPolicyBinding;
  readonly actions: readonly TypedLabelAction[];
  readonly digest: Sha256Digest;
}

const policyIdPattern = /^[a-z][a-z0-9-]{2,63}$/u;
const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?$/u;
const resolvedSpanIdPattern = /^rsp_[a-f0-9]{32}$/u;

function validatedPolicyBinding(policy: TypedLabelPolicyBinding): TypedLabelPolicyBinding {
  if (!policyIdPattern.test(policy.id) || !semverPattern.test(policy.version)) {
    throw new TypeError('The typed-label plan policy binding is invalid.');
  }
  return Object.freeze({
    id: policy.id,
    version: policy.version,
    digest: parseSha256Digest(policy.digest)
  });
}

function digestPlan(
  extractionRevision: Sha256Digest,
  policy: TypedLabelPolicyBinding,
  actions: readonly TypedLabelAction[]
): Sha256Digest {
  const canonical = JSON.stringify({
    extractionRevision,
    policy,
    strategy: 'TYPED_LABEL',
    version: '0.1.0',
    actions
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}` as Sha256Digest;
}

/** Compiles only the caller's explicit policy-approved resolution subset. */
export function compileTypedLabelPlan(
  approvedResolution: ResolutionSet,
  policyBinding: TypedLabelPolicyBinding
): TypedLabelPlan {
  if (approvedResolution.conflicts.length > 0) {
    throw new Error('Cannot compile a redaction plan with unresolved span conflicts');
  }
  const policy = validatedPolicyBinding(policyBinding);
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
    return Object.freeze({
      id: `act_${span.id.slice(4)}`,
      sourceSpanId: span.id,
      evidenceIds,
      entityType: span.entityType,
      start: span.start,
      end: span.end,
      replacement: `[${span.entityType}_${String(sequence)}]`
    } satisfies TypedLabelAction);
  });
  const frozenActions = Object.freeze(actions);
  return Object.freeze({
    strategy: 'TYPED_LABEL',
    strategyVersion: '0.1.0',
    extractionRevision: approvedResolution.extractionRevision,
    policy,
    actions: frozenActions,
    digest: digestPlan(approvedResolution.extractionRevision, policy, frozenActions)
  });
}

export function applyTypedLabelPlan(text: string, plan: TypedLabelPlan): string {
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
