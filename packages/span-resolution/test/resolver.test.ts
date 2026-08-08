import { describe, expect, it } from 'vitest';

import { detectDeterministic } from '@local-pii/detectors';
import {
  parseDetectionId,
  parseSha256Digest,
  unicodeCodePointLength,
  type DetectionEvidence
} from '@local-pii/domain';

import { resolveEvidence } from '../src/index.js';

const revision = parseSha256Digest(`sha256:${'b'.repeat(64)}`);

describe('span resolution', () => {
  it('uses declared containment precedence for parsed IPs over phone-shaped evidence', () => {
    const text = '192.0.2.10';
    const result = resolveEvidence(detectDeterministic(text, revision), revision, unicodeCodePointLength(text));
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.entityType).toBe('IP_ADDRESS');
    expect(result.conflicts).toHaveLength(0);
    expect(result.suppressedEvidenceIds).toHaveLength(1);
  });

  it('is independent of detector completion order', () => {
    const text = 'alpha@example.test and 192.0.2.10';
    const evidence = detectDeterministic(text, revision);
    const forward = resolveEvidence(evidence, revision, unicodeCodePointLength(text));
    const reverse = resolveEvidence([...evidence].reverse(), revision, unicodeCodePointLength(text));
    expect(reverse).toEqual(forward);
  });

  it('surfaces incompatible partial overlaps', () => {
    const base = {
      span: { offsetUnit: 'UNICODE_CODE_POINT' as const, extractionRevision: revision },
      confidence: 0.9,
      source: 'REGEX' as const,
      detector: { id: 'synthetic', version: '0.1.0' }
    };
    const evidence: DetectionEvidence[] = [
      {
        ...base,
        id: parseDetectionId('11111111-1111-4111-8111-111111111111'),
        entityType: 'EMAIL',
        span: { ...base.span, start: 0, end: 8 }
      },
      {
        ...base,
        id: parseDetectionId('22222222-2222-4222-8222-222222222222'),
        entityType: 'PHONE',
        span: { ...base.span, start: 5, end: 12 }
      }
    ];
    const result = resolveEvidence(evidence, revision, 20);
    expect(result.conflicts).toHaveLength(1);
  });
});
