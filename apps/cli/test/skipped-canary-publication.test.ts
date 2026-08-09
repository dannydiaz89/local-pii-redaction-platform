import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLocalTextArtifactSession } from '@local-pii/adapter-text';
import { createTextProcessingApplication, type BoundTextVerificationRequest } from '@local-pii/core';
import { detectDeterministic, deterministicDetectorBundleVersion } from '@local-pii/detectors';
import { parseSha256Digest } from '@local-pii/domain';
import { compilePolicy, developmentLabelsPolicy } from '@local-pii/policy';
import {
  textVerificationDetectorBundle,
  textVerificationProfile,
  textVerificationVerifier,
  verifyBoundCanonicalText,
  verifyCanonicalText
} from '@local-pii/verification';

import { textCapabilityRequirement } from '../src/application.js';
import { createCurrentCapabilityManifest } from '../src/capabilities.js';

const directories: string[] = [];
const applicationIdentity = {
  id: 'local-pii-cli',
  version: '0.1.0',
  digest: parseSha256Digest('sha256:0fd4cd6f99992ecf8862956817e3e72d0548fb7cbf1ff7765601f51b67530cf0')
} as const;

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe('seeded residual publication gate', () => {
  it('discards a real stage and publishes nothing when primary detection skips a planted canary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-skipped-canary-'));
    directories.push(root);
    const input = join(root, 'synthetic-input.txt');
    const output = join(root, 'synthetic-output.txt');
    const detected = 'detected@example.test';
    const skipped = 'skipped@example.test';
    const sourceBytes = Buffer.from(`Detected ${detected}. Skipped ${skipped}.`, 'utf8');
    await writeFile(input, sourceBytes, { mode: 0o600 });
    const before = await stat(input, { bigint: true });
    const manifest = createCurrentCapabilityManifest();
    const verifier = {
      attestation: {
        profile: textVerificationProfile,
        verifier: textVerificationVerifier,
        detectorBundle: textVerificationDetectorBundle,
        application: applicationIdentity
      },
      verify(text: string, extractionRevision: Parameters<typeof verifyCanonicalText>[1]) {
        return Promise.resolve(verifyCanonicalText(text, extractionRevision));
      },
      attest(request: BoundTextVerificationRequest) {
        const startedAt = new Date().toISOString();
        return Promise.resolve(verifyBoundCanonicalText({
          ...request,
          application: applicationIdentity,
          startedAt,
          completedAt: new Date().toISOString()
        }));
      }
    };
    const application = createTextProcessingApplication({
      capabilityProvider: { getCapabilities: () => Promise.resolve(manifest) },
      detector: {
        detectorBundleVersion: deterministicDetectorBundleVersion,
        detect(text, extractionRevision) {
          const evidence = detectDeterministic(text, extractionRevision);
          return Promise.resolve(evidence.filter((item) => item.span.start === text.indexOf(detected)));
        }
      },
      verifier
    });

    let failure: unknown;
    try {
      await application.redact({
        session: createLocalTextArtifactSession(input, output),
        requirement: textCapabilityRequirement('REDACT'),
        policy: compilePolicy(developmentLabelsPolicy)
      }, { correlationId: 'cor_skipped_canary_publication' });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'VERIFICATION_RESIDUAL',
      message: 'Residual sensitive content blocked publication of the derived artifact.',
      retryable: false
    });
    const serializedFailure = JSON.stringify(failure);
    expect(serializedFailure).not.toContain(detected);
    expect(serializedFailure).not.toContain(skipped);
    expect(serializedFailure).not.toContain(root);
    expect(await readFile(input)).toEqual(sourceBytes);
    const after = await stat(input, { bigint: true });
    expect({
      mode: after.mode,
      uid: after.uid,
      gid: after.gid,
      size: after.size,
      modifiedNs: after.mtimeNs,
      changedNs: after.ctimeNs
    }).toEqual({
      mode: before.mode,
      uid: before.uid,
      gid: before.gid,
      size: before.size,
      modifiedNs: before.mtimeNs,
      changedNs: before.ctimeNs
    });
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual(['synthetic-input.txt']);
  });
});
