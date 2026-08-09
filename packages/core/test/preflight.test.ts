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

  it('does not let rules-only capabilities satisfy a contextual-model requirement', () => {
    expect(() => {
      assertCapabilities(
        { ...developmentTextRequirement, detectorKinds: ['MODEL'] },
        capabilityManifest(),
        'cor_synthetic_contextual_001'
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

  it('rejects verifier-to-format references that are not declared by the format', () => {
    const manifest = capabilityManifest();
    manifest.formats[0].verificationProfiles[0] = 'alternate-profile';
    manifest.verificationProfiles.push({
      ...manifest.verificationProfiles[0],
      id: 'alternate-profile'
    });
    expect(() => {
      assertCapabilityManifest(manifest, 'cor_synthetic_manifest_003');
    }).toThrow(SafeError);
  });

  it('rejects duplicate capability identifiers', () => {
    const manifest = capabilityManifest();
    manifest.detectors.push({ ...manifest.detectors[0] });
    expect(() => {
      assertCapabilityManifest(manifest, 'cor_synthetic_manifest_004');
    }).toThrow(SafeError);
  });

  it('rejects a per-format byte limit above the deployment limit', () => {
    const manifest = capabilityManifest();
    manifest.formats[0].limits.maximumInputBytes = manifest.limits.maximumInputBytes + 1;
    expect(() => {
      assertCapabilityManifest(manifest, 'cor_synthetic_manifest_005');
    }).toThrow(SafeError);
  });

  it('rejects an available model detector in rules-only mode', () => {
    const manifest = capabilityManifest();
    manifest.detectors[0].kinds = ['MODEL'];
    expect(() => {
      assertCapabilityManifest(manifest, 'cor_synthetic_manifest_006');
    }).toThrow(SafeError);
  });
});
