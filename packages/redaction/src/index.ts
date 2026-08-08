import { createHash } from 'node:crypto';

import type { EntityType, Sha256Digest } from '@local-pii/domain';
import type { ResolutionSet } from '@local-pii/span-resolution';

export interface TypedLabelAction {
  readonly id: string;
  readonly entityType: EntityType;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

export interface TypedLabelPlan {
  readonly strategy: 'TYPED_LABEL';
  readonly strategyVersion: '0.1.0';
  readonly extractionRevision: Sha256Digest;
  readonly actions: readonly TypedLabelAction[];
  readonly digest: Sha256Digest;
}

function digestPlan(extractionRevision: Sha256Digest, actions: readonly TypedLabelAction[]): Sha256Digest {
  const canonical = JSON.stringify({ extractionRevision, strategy: 'TYPED_LABEL', version: '0.1.0', actions });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}` as Sha256Digest;
}

export function compileTypedLabelPlan(resolution: ResolutionSet): TypedLabelPlan {
  if (resolution.conflicts.length > 0) throw new Error('Cannot compile a redaction plan with unresolved span conflicts');
  const counters = new Map<EntityType, number>();
  const actions = resolution.spans.map((span) => {
    const sequence = (counters.get(span.entityType) ?? 0) + 1;
    counters.set(span.entityType, sequence);
    return {
      id: `act_${span.id.slice(4)}`,
      entityType: span.entityType,
      start: span.start,
      end: span.end,
      replacement: `[${span.entityType}_${String(sequence)}]`
    } satisfies TypedLabelAction;
  });
  return {
    strategy: 'TYPED_LABEL',
    strategyVersion: '0.1.0',
    extractionRevision: resolution.extractionRevision,
    actions,
    digest: digestPlan(resolution.extractionRevision, actions)
  };
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
