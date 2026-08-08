import { describe, expect, it } from 'vitest';

import { parseSha256Digest } from '@local-pii/domain';

import { verifyCanonicalText } from '../src/index.js';

const revision = parseSha256Digest(`sha256:${'d'.repeat(64)}`);

describe('text verification', () => {
  it('blocks deterministic residuals without returning their values', () => {
    const text = 'Residual alpha@example.test';
    const report = verifyCanonicalText(text, revision);
    expect(report.outcome).toBe('FAIL');
    expect(report.findings[0]?.entityType).toBe('EMAIL');
    expect(JSON.stringify(report)).not.toContain('alpha@example.test');
  });

  it('passes a typed-label output', () => {
    expect(verifyCanonicalText('Contact [EMAIL_1]', revision).outcome).toBe('PASS');
  });
});
