import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SafeError } from '@local-pii/domain';

import {
  assertCapabilities,
  assertCapabilityManifest,
  type CapabilityManifest,
  type CapabilityRequirement
} from '../src/index.js';

function capabilityManifest(): CapabilityManifest {
  const path = resolve(import.meta.dirname, '../../../fixtures/contracts/valid/capability-rules-only-text.json');
  return JSON.parse(readFileSync(path, 'utf8')) as CapabilityManifest;
}

const developmentTextRequirement: CapabilityRequirement = {
  contractVersion: '1.0.0',
  engineModes: ['RULES_ONLY', 'LOCAL_HYBRID'],
  formatId: 'text',
  operation: 'REDACT',
  detectorIds: ['email-pattern'],
  detectorKinds: ['REGEX'],
  transformationActions: ['TYPED_LABEL'],
  verificationProfile: 'text-rescan-v1',
  maximumInputBytes: 1_048_576,
  minimumQualification: 'DEVELOPMENT'
};

describe('capability manifest and preflight', () => {
  it('accepts a valid, internally consistent manifest', () => {
    expect(() => {
      assertCapabilityManifest(capabilityManifest(), 'cor_synthetic_manifest_001');
    }).not.toThrow();
  });

  it('accepts a fully satisfiable capability requirement', () => {
    expect(() => {
      assertCapabilities(developmentTextRequirement, capabilityManifest(), 'cor_synthetic_001');
    }).not.toThrow();
  });

  it('fails closed when a required detector is unavailable', () => {
    expect(() => {
      assertCapabilities(
        { ...developmentTextRequirement, detectorIds: ['email-pattern', 'pii-small'] },
        capabilityManifest(),
        'cor_synthetic_002'
      );
    }).toThrow(SafeError);
  });

  it('does not let development capabilities satisfy a qualified requirement', () => {
    expect(() => {
      assertCapabilities(
        { ...developmentTextRequirement, minimumQualification: 'QUALIFIED' },
        capabilityManifest(),
        'cor_synthetic_003'
      );
    }).toThrow(SafeError);
  });

  it('rejects internally inconsistent capability references', () => {
    const manifest = capabilityManifest();
    manifest.formats[0].verificationProfiles[0] = 'missing-profile';
    expect(() => {
      assertCapabilityManifest(manifest, 'cor_synthetic_manifest_002');
    }).toThrow(SafeError);
  });
});
