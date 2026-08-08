import { describe, expect, it } from 'vitest';

import { detectDeterministic } from '@local-pii/detectors';
import { parseSha256Digest, unicodeCodePointLength } from '@local-pii/domain';
import { resolveEvidence } from '@local-pii/span-resolution';

import { applyTypedLabelPlan, compileTypedLabelPlan } from '../src/index.js';

const revision = parseSha256Digest(`sha256:${'c'.repeat(64)}`);

describe('typed-label redaction', () => {
  it('replaces from the end without damaging Unicode or adjacent text', () => {
    const text = '😀 Contact alpha@example.test or beta@example.test.';
    const resolution = resolveEvidence(detectDeterministic(text, revision), revision, unicodeCodePointLength(text));
    const plan = compileTypedLabelPlan(resolution);
    const output = applyTypedLabelPlan(text, plan);
    expect(output).toBe('😀 Contact [EMAIL_1] or [EMAIL_2].');
    expect(plan.actions).toHaveLength(2);
    expect(plan.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
