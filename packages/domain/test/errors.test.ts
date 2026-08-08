import { describe, expect, it } from 'vitest';

import {
  errorCodes,
  safeErrorDetailKeys,
  SafeError,
  type SafeErrorDetails,
  type SafeErrorOptions
} from '../src/index.js';

const validOptions: SafeErrorOptions = {
  code: 'FORMAT_CORRUPT',
  message: 'The input is not valid UTF-8 text.',
  retryable: false,
  correlationId: 'cor_01J4M8Z7QK2C5B6TFXDA9R4M3V',
  details: { format: 'TEXT', stage: 'VALIDATING', attempt: 1, recovered: false, reason: null }
};

describe('SafeError', () => {
  it('retains every registered code as a stable, unique value', () => {
    expect(new Set(errorCodes).size).toBe(errorCodes.length);
    for (const code of errorCodes) {
      expect(new SafeError({ ...validOptions, code }).code).toBe(code);
    }
  });

  it('constructs a contract-safe error without retaining a mutable details reference', () => {
    const source = { format: 'TEXT' };
    const error = new SafeError({ ...validOptions, details: source });
    source.format = 'PDF';

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SafeError');
    expect(error.details).toEqual({ format: 'TEXT' });
    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it.each([
    { name: 'unknown code', patch: { code: 'NOT_REGISTERED' } },
    { name: 'empty message', patch: { message: '' } },
    { name: 'overlong message', patch: { message: 'x'.repeat(501) } },
    { name: 'non-boolean retryable', patch: { retryable: 'false' } },
    { name: 'short correlation ID', patch: { correlationId: 'short' } },
    { name: 'overlong correlation ID', patch: { correlationId: 'x'.repeat(129) } }
  ])('rejects an invalid $name', ({ patch }) => {
    expect(() => new SafeError({ ...validOptions, ...patch } as SafeErrorOptions)).toThrow(TypeError);
  });

  it('enforces the error-envelope detail property limit', () => {
    const sixteen = Object.fromEntries(safeErrorDetailKeys.slice(0, 16).map((key, index) => [key, index]));
    expect(() => new SafeError({ ...validOptions, details: sixteen })).not.toThrow();

    const seventeen = Object.fromEntries(safeErrorDetailKeys.slice(0, 17).map((key, index) => [key, index]));
    expect(() => new SafeError({ ...validOptions, details: seventeen })).toThrow(TypeError);
  });

  it.each([
    ['array', []],
    ['nested object', { nested: true }],
    ['undefined', undefined],
    ['non-finite number', Number.POSITIVE_INFINITY]
  ])('rejects a non-JSON-scalar %s detail value', (_name, invalid) => {
    const details = { invalid } as unknown as SafeErrorDetails;
    expect(() => new SafeError({ ...validOptions, details })).toThrow(TypeError);
  });

  it('rejects detail keys that can expose source context', () => {
    const details = { path: '/private/synthetic.txt' } as unknown as SafeErrorDetails;
    expect(() => new SafeError({ ...validOptions, details })).toThrow(TypeError);
  });

  it('measures message, correlation, and detail-string limits in Unicode code points', () => {
    expect(() => new SafeError({ ...validOptions, message: '😀'.repeat(500) })).not.toThrow();
    expect(() => new SafeError({ ...validOptions, message: '😀'.repeat(501) })).toThrow(TypeError);
    expect(() => new SafeError({ ...validOptions, correlationId: '😀'.repeat(128) })).not.toThrow();
    expect(() => new SafeError({ ...validOptions, correlationId: '😀'.repeat(129) })).toThrow(TypeError);
    expect(() => new SafeError({ ...validOptions, details: { reason: '😀'.repeat(128) } })).not.toThrow();
    expect(() => new SafeError({ ...validOptions, details: { reason: '😀'.repeat(129) } })).toThrow(TypeError);
  });
});
