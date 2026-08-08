import { describe, expect, it } from 'vitest';

import { parseSha256Digest, sliceByCodePoint } from '@local-pii/domain';

import { detectDeterministic } from '../src/index.js';

const revision = parseSha256Digest(`sha256:${'a'.repeat(64)}`);

describe('deterministic detectors', () => {
  it('finds the approved initial entity set with Unicode code-point offsets', () => {
    const text = [
      '😀 Email alpha@example.test',
      'Phone +1 (202) 555-0147',
      'SSN 123-45-6789',
      'Card 4242 4242 4242 4242',
      'IPv4 192.0.2.10',
      'IPv6 2001:db8::1',
      'api_key=synthetic_value_12345'
    ].join('\n');
    const evidence = detectDeterministic(text, revision);
    const values = evidence.map((item) => ({ type: item.entityType, value: sliceByCodePoint(text, item.span) }));

    expect(values).toContainEqual({ type: 'EMAIL', value: 'alpha@example.test' });
    expect(values).toContainEqual({ type: 'PHONE', value: '+1 (202) 555-0147' });
    expect(values).toContainEqual({ type: 'SSN', value: '123-45-6789' });
    expect(values).toContainEqual({ type: 'CREDIT_CARD', value: '4242 4242 4242 4242' });
    expect(values).toContainEqual({ type: 'IP_ADDRESS', value: '192.0.2.10' });
    expect(values).toContainEqual({ type: 'IP_ADDRESS', value: '2001:db8::1' });
    expect(values).toContainEqual({ type: 'API_KEY', value: 'synthetic_value_12345' });
    expect(evidence[0]?.span.start).toBe(8);
  });

  it('rejects structurally impossible SSNs and invalid Luhn candidates', () => {
    const text = 'SSN 000-12-3456 and card 4242 4242 4242 4241';
    const evidence = detectDeterministic(text, revision);
    expect(evidence.some((item) => item.entityType === 'SSN')).toBe(false);
    expect(evidence.some((item) => item.entityType === 'CREDIT_CARD')).toBe(false);
  });

  it('produces stable value-free evidence identifiers', () => {
    const text = 'alpha@example.test';
    expect(detectDeterministic(text, revision)).toEqual(detectDeterministic(text, revision));
    expect(JSON.stringify(detectDeterministic(text, revision))).not.toContain(text);
  });
});
