import { describe, expect, it } from 'vitest';

import { detectDeterministic } from '@local-pii/detectors';
import { parseSha256Digest, unicodeCodePointLength } from '@local-pii/domain';
import { resolveEvidence } from '@local-pii/span-resolution';

import { applyTypedLabelPlan, compileTypedLabelPlan } from '../src/index.js';

const revision = parseSha256Digest(`sha256:${'c'.repeat(64)}`);
const developmentPolicy = {
  id: 'development-labels',
  version: '0.1.0',
  digest: parseSha256Digest(`sha256:${'d'.repeat(64)}`)
} as const;

describe('typed-label redaction', () => {
  it('replaces from the end without damaging Unicode or adjacent text', () => {
    const text = '😀 Contact alpha@example.test or beta@example.test.';
    const resolution = resolveEvidence(detectDeterministic(text, revision), revision, unicodeCodePointLength(text));
    const plan = compileTypedLabelPlan(resolution, developmentPolicy);
    const output = applyTypedLabelPlan(text, plan);
    expect(output).toBe('😀 Contact [EMAIL_1] or [EMAIL_2].');
    expect(plan.actions).toHaveLength(2);
    expect(plan.policy).toEqual(developmentPolicy);
    expect(plan.actions.map(({ sourceSpanId }) => sourceSpanId)).toEqual(resolution.spans.map(({ id }) => id));
    expect(plan.actions.map(({ evidenceIds }) => evidenceIds)).toEqual(resolution.spans.map(({ evidenceIds }) => evidenceIds));
    expect(plan.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.policy)).toBe(true);
    expect(Object.isFrozen(plan.actions)).toBe(true);
    expect(plan.actions.every((action) => Object.isFrozen(action) && Object.isFrozen(action.evidenceIds))).toBe(true);
  });

  it('binds the policy and supporting evidence into the plan digest', () => {
    const text = 'Contact alpha@example.test.';
    const resolution = resolveEvidence(detectDeterministic(text, revision), revision, unicodeCodePointLength(text));
    const original = compileTypedLabelPlan(resolution, developmentPolicy);
    const changedPolicy = compileTypedLabelPlan(resolution, {
      ...developmentPolicy,
      version: '0.2.0',
      digest: parseSha256Digest(`sha256:${'e'.repeat(64)}`)
    });
    const span = resolution.spans[0];
    if (span === undefined) throw new Error('Expected an approved span.');
    const changedEvidence = compileTypedLabelPlan({
      ...resolution,
      spans: [{
        ...span,
        evidenceIds: ['123e4567-e89b-42d3-a456-426614174000']
      }]
    }, developmentPolicy);

    expect(changedPolicy.digest).not.toBe(original.digest);
    expect(changedEvidence.digest).not.toBe(original.digest);
    expect(changedEvidence.actions[0]?.sourceSpanId).toBe(span.id);
    expect(changedEvidence.actions[0]?.evidenceIds).toEqual(['123e4567-e89b-42d3-a456-426614174000']);
  });

  it('rejects unbound, conflicted, or provenance-free approved inputs', () => {
    const text = 'Contact alpha@example.test.';
    const resolution = resolveEvidence(detectDeterministic(text, revision), revision, unicodeCodePointLength(text));
    const span = resolution.spans[0];
    if (span === undefined) throw new Error('Expected an approved span.');

    expect(() => compileTypedLabelPlan(resolution, {
      ...developmentPolicy,
      digest: 'not-a-digest' as typeof developmentPolicy.digest
    })).toThrow(TypeError);
    expect(() => compileTypedLabelPlan({
      ...resolution,
      conflicts: [{ code: 'INCOMPATIBLE_OVERLAP', evidenceIds: [span.evidenceIds[0] ?? '', '123e4567-e89b-42d3-a456-426614174000'], start: span.start, end: span.end }]
    }, developmentPolicy)).toThrow('unresolved span conflicts');
    expect(() => compileTypedLabelPlan({
      ...resolution,
      spans: [{ ...span, evidenceIds: [] }]
    }, developmentPolicy)).toThrow('supporting evidence');
  });
});
