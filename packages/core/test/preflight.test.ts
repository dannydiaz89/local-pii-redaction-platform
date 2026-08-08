import { describe, expect, it } from 'vitest';

import { SafeError } from '@local-pii/domain';

import { assertCapabilities } from '../src/index.js';

describe('capability preflight', () => {
  it('fails closed when a required detector is unavailable', () => {
    expect(() => {
      assertCapabilities(
        { detectorIds: ['email-pattern', 'pii-small'], verificationProfile: 'text-rescan-v1' },
        { detectorIds: ['email-pattern'], verificationProfiles: ['text-rescan-v1'] },
        'cor_synthetic_001'
      );
    }).toThrow(SafeError);
  });

  it('accepts a fully satisfiable capability set', () => {
    expect(() => {
      assertCapabilities(
        { detectorIds: ['email-pattern'], verificationProfile: 'text-rescan-v1' },
        { detectorIds: ['email-pattern'], verificationProfiles: ['text-rescan-v1'] },
        'cor_synthetic_002'
      );
    }).not.toThrow();
  });
});
