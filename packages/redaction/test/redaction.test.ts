import { describe, expect, it } from 'vitest';

import { detectDeterministic } from '@local-pii/detectors';
import { parseSha256Digest, unicodeCodePointLength } from '@local-pii/domain';
import { resolveEvidence } from '@local-pii/span-resolution';

import { applyTypedLabelPlan, compileTypedLabelPlan } from '../src/index.js';

const revision = parseSha256Digest(`sha256:${'c'.repeat(64)}`);
const developmentPolicy = {
  id: 'development-labels',
  version: '0.1.0',
  digest: parseSha256Digest(`sha256:${'d'.repeat(64)}`),
  riskTier: 'LOW'
} as const;
const planBinding = {
  inputDigest: parseSha256Digest(`sha256:${'a'.repeat(64)}`),
  capabilityDigest: parseSha256Digest(`sha256:${'b'.repeat(64)}`),
  detectorBundleVersion: '0.1.0',
  policy: developmentPolicy,
  writer: { id: 'text-adapter', version: '0.1.0' }
} as const;

describe('typed-label redaction', () => {
  it('replaces from the end without damaging Unicode or adjacent text', () => {
    const text = '😀 Contact alpha@example.test or beta@example.test.';
    const resolution = resolveEvidence(detectDeterministic(text, revision), revision, unicodeCodePointLength(text));
    const plan = compileTypedLabelPlan(resolution, planBinding);
    const output = applyTypedLabelPlan(text, plan);
    expect(output).toBe('😀 Contact [EMAIL_1] or [EMAIL_2].');
    expect(plan.actions).toHaveLength(2);
    expect(plan.policy).toEqual(developmentPolicy);
    expect(plan.inputDigest).toBe(planBinding.inputDigest);
    expect(plan.resolutionDigest).toBe(resolution.digest);
    expect(plan.capabilityDigest).toBe(planBinding.capabilityDigest);
    expect(plan.writer).toEqual(planBinding.writer);
    expect(plan.expectedActionCount).toBe(2);
    expect(plan.id).toMatch(/^plan_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(plan.actions.every(({ id }) => /^act_[0-9A-HJKMNP-TV-Z]{26}$/u.test(id))).toBe(true);
    expect(plan.actions.map(({ action }) => action)).toEqual(['TYPED_LABEL', 'TYPED_LABEL']);
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
    const original = compileTypedLabelPlan(resolution, planBinding);
    const changedPolicy = compileTypedLabelPlan(resolution, {
      ...planBinding,
      policy: {
        ...developmentPolicy,
        version: '0.2.0',
        digest: parseSha256Digest(`sha256:${'e'.repeat(64)}`)
      }
    });
    const span = resolution.spans[0];
    if (span === undefined) throw new Error('Expected an approved span.');
    const changedEvidence = compileTypedLabelPlan({
      ...resolution,
      spans: [{
        ...span,
        evidenceIds: ['123e4567-e89b-42d3-a456-426614174000']
      }]
    }, planBinding);

    expect(changedPolicy.digest).not.toBe(original.digest);
    expect(changedEvidence.digest).not.toBe(original.digest);
    expect(changedEvidence.actions[0]?.sourceSpanId).toBe(span.id);
    expect(changedEvidence.actions[0]?.evidenceIds).toEqual(['123e4567-e89b-42d3-a456-426614174000']);
    for (const changedBinding of [
      { ...planBinding, inputDigest: parseSha256Digest(`sha256:${'1'.repeat(64)}`) },
      { ...planBinding, capabilityDigest: parseSha256Digest(`sha256:${'2'.repeat(64)}`) },
      { ...planBinding, detectorBundleVersion: '0.2.0' },
      { ...planBinding, writer: { ...planBinding.writer, version: '0.2.0' } }
    ]) {
      expect(compileTypedLabelPlan(resolution, changedBinding).digest).not.toBe(original.digest);
    }
    expect(() => applyTypedLabelPlan(text, {
      ...original,
      inputDigest: parseSha256Digest(`sha256:${'9'.repeat(64)}`)
    })).toThrow('identity');
  });

  it('rejects unbound, conflicted, or provenance-free approved inputs', () => {
    const text = 'Contact alpha@example.test.';
    const resolution = resolveEvidence(detectDeterministic(text, revision), revision, unicodeCodePointLength(text));
    const span = resolution.spans[0];
    if (span === undefined) throw new Error('Expected an approved span.');

    expect(() => compileTypedLabelPlan(resolution, {
      ...planBinding,
      policy: {
        ...developmentPolicy,
        digest: 'not-a-digest' as typeof developmentPolicy.digest
      }
    })).toThrow(TypeError);
    expect(() => compileTypedLabelPlan({
      ...resolution,
      conflicts: [{ code: 'INCOMPATIBLE_OVERLAP', evidenceIds: [span.evidenceIds[0] ?? '', '123e4567-e89b-42d3-a456-426614174000'], start: span.start, end: span.end }]
    }, planBinding)).toThrow('unresolved span conflicts');
    expect(() => compileTypedLabelPlan({
      ...resolution,
      spans: [{ ...span, evidenceIds: [] }]
    }, planBinding)).toThrow('supporting evidence');
  });
});
