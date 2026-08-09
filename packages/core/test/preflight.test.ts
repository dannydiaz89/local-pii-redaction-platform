import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SafeError } from '@local-pii/domain';

import {
  assertCapabilities,
  assertCapabilityManifest,
  createJobApplication,
  type ApplicationContext,
  type CapabilityManifest,
  type CapabilityRequirement,
  type JobApplicationDependencies
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

const applicationContext: ApplicationContext = { correlationId: 'cor_synthetic_application_001' };

interface SyntheticTextRequest {
  readonly artifactId: string;
}

interface SyntheticTextResult {
  readonly outcome: 'SUCCEEDED';
}

function applicationDependencies(overrides: Partial<JobApplicationDependencies<SyntheticTextRequest, SyntheticTextResult>> = {}): JobApplicationDependencies<SyntheticTextRequest, SyntheticTextResult> {
  return {
    capabilityProvider: { getCapabilities: () => Promise.resolve(capabilityManifest()) },
    rulesOnlyTextPipeline: { execute: () => Promise.resolve({ outcome: 'SUCCEEDED' }) },
    ...overrides
  };
}

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

describe('framework-independent job application composition', () => {
  it('routes capabilities through an explicit injected port', async () => {
    const application = createJobApplication(applicationDependencies());

    expect((await application.getCapabilities(applicationContext)).engineMode).toBe('RULES_ONLY');
    expect(Object.isFrozen(application)).toBe(true);
  });

  it('preflights the active manifest before invoking the injected text pipeline', async () => {
    const requests: SyntheticTextRequest[] = [];
    const correlations: string[] = [];
    const application = createJobApplication(applicationDependencies({
      rulesOnlyTextPipeline: {
        execute: (request, correlationId) => {
          requests.push(request);
          correlations.push(correlationId);
          return Promise.resolve({ outcome: 'SUCCEEDED' });
        }
      }
    }));
    const request = { artifactId: 'art_01J4M8Z7QK2C5B6TFXDA9R4M3V' };

    await expect(application.executeRulesOnlyText(
      { request, requirement: developmentTextRequirement },
      applicationContext
    )).resolves.toEqual({ outcome: 'SUCCEEDED' });
    expect(requests).toEqual([request]);
    expect(correlations).toEqual([applicationContext.correlationId]);
  });

  it('fails closed before execution when rules-only capabilities cannot satisfy the request', async () => {
    let executed = false;
    const application = createJobApplication(applicationDependencies({
      rulesOnlyTextPipeline: {
        execute: () => {
          executed = true;
          return Promise.resolve({ outcome: 'SUCCEEDED' });
        }
      }
    }));

    await expect(application.executeRulesOnlyText({
      request: { artifactId: 'art_01J4M8Z7QK2C5B6TFXDA9R4M3V' },
      requirement: { ...developmentTextRequirement, detectorKinds: ['MODEL'] }
    }, applicationContext)).rejects.toMatchObject({
      code: 'POLICY_UNSATISFIABLE',
      correlationId: applicationContext.correlationId
    });
    expect(executed).toBe(false);
  });

  it('maps unexpected dependency failures without disclosing their messages', async () => {
    const application = createJobApplication(applicationDependencies({
      capabilityProvider: {
        getCapabilities: () => Promise.reject(new Error('private path /synthetic/input and alpha@example.test'))
      }
    }));

    const failure = await application.getCapabilities(applicationContext).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SafeError);
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR', correlationId: applicationContext.correlationId });
    expect(JSON.stringify(failure)).not.toContain('alpha@example.test');
    expect((failure as Error).message).not.toContain('/synthetic/input');
  });

  it('preserves typed dependency failures for transport adapters to map canonically', async () => {
    const expected = new SafeError({
      code: 'MODEL_UNAVAILABLE',
      message: 'The required local model is unavailable.',
      retryable: true,
      correlationId: applicationContext.correlationId
    });
    const application = createJobApplication(applicationDependencies({
      rulesOnlyTextPipeline: { execute: () => Promise.reject(expected) }
    }));

    await expect(application.executeRulesOnlyText({
      request: { artifactId: 'art_01J4M8Z7QK2C5B6TFXDA9R4M3V' },
      requirement: developmentTextRequirement
    }, applicationContext)).rejects.toBe(expected);
  });

});
