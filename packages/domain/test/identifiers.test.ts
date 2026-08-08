import { describe, expect, it } from 'vitest';

import {
  parseArtifactId,
  parseCorrelationId,
  parseDetectionId,
  parseEventId,
  parseJobId,
  parseSha256Digest
} from '../src/index.js';

const ulid = '01J4M8Z7QK2C5B6TFXDA9R4M3V';

describe('opaque identifiers', () => {
  it('accepts canonical artifact and job identifiers', () => {
    expect(parseArtifactId(`art_${ulid}`)).toBe(`art_${ulid}`);
    expect(parseJobId(`job_${ulid}`)).toBe(`job_${ulid}`);
  });

  it.each([
    '',
    `ART_${ulid}`,
    `art_${ulid.toLowerCase()}`,
    `art_${ulid.slice(1)}`,
    `art_${ulid}0`,
    `art_${ulid.replace('M', 'I')}`,
    `job_${ulid}`
  ])('rejects an invalid artifact identifier: %s', (value) => {
    expect(() => parseArtifactId(value)).toThrow(TypeError);
  });

  it.each([
    '',
    `JOB_${ulid}`,
    `job_${ulid.toLowerCase()}`,
    `job_${ulid.slice(1)}`,
    `job_${ulid}0`,
    `job_${ulid.replace('M', 'O')}`,
    `art_${ulid}`
  ])('rejects an invalid job identifier: %s', (value) => {
    expect(() => parseJobId(value)).toThrow(TypeError);
  });

  it('does not coerce non-string values at the runtime boundary', () => {
    expect(() => parseArtifactId(123 as unknown as string)).toThrow(TypeError);
    expect(() => parseJobId({ toString: () => `job_${ulid}` } as unknown as string)).toThrow(TypeError);
  });
});

describe('SHA-256 digests', () => {
  it('accepts the canonical algorithm prefix and 64 lowercase hexadecimal digits', () => {
    const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;
    expect(parseSha256Digest(digest)).toBe(digest);
  });

  it.each([
    '',
    'sha256:',
    `sha256:${'a'.repeat(63)}`,
    `sha256:${'a'.repeat(65)}`,
    `SHA256:${'a'.repeat(64)}`,
    `sha256:${'A'.repeat(64)}`,
    `sha256:${'g'.repeat(64)}`,
    'a'.repeat(64)
  ])('rejects a non-canonical digest: %s', (value) => {
    expect(() => parseSha256Digest(value)).toThrow(TypeError);
  });

  it('does not coerce a non-string digest', () => {
    expect(() => parseSha256Digest({ toString: () => `sha256:${'a'.repeat(64)}` } as unknown as string)).toThrow(TypeError);
  });
});

describe('UUID and correlation identifiers', () => {
  it('accepts canonical versioned detection and event UUIDs', () => {
    const uuid = 'd9b8a330-8d9a-4f6f-8f11-5b2f10e53967';
    expect(parseDetectionId(uuid)).toBe(uuid);
    expect(parseEventId(uuid)).toBe(uuid);
  });

  it.each([
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
    'd9b8a330-8d9a-0f6f-8f11-5b2f10e53967',
    'd9b8a330-8d9a-4f6f-7f11-5b2f10e53967',
    'not-a-uuid'
  ])('rejects a noncanonical UUID: %s', (value) => {
    expect(() => parseDetectionId(value)).toThrow(TypeError);
    expect(() => parseEventId(value)).toThrow(TypeError);
  });

  it('measures correlation IDs in Unicode code points', () => {
    expect(parseCorrelationId('😀'.repeat(8))).toBe('😀'.repeat(8));
    expect(parseCorrelationId('😀'.repeat(128))).toBe('😀'.repeat(128));
    expect(() => parseCorrelationId('😀'.repeat(7))).toThrow(TypeError);
    expect(() => parseCorrelationId('😀'.repeat(129))).toThrow(TypeError);
  });
});
