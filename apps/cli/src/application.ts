import {
  createTextProcessingApplication,
  type CapabilityOperation,
  type CapabilityRequirement
} from '@local-pii/core';
import {
  detectDeterministic,
  deterministicDetectorBundleVersion,
  deterministicDetectorCapabilities
} from '@local-pii/detectors';
import { defaultMaximumInputBytes } from '@local-pii/adapter-text';
import { verifyCanonicalText } from '@local-pii/verification';

import { createCurrentCapabilityManifest } from './capabilities.js';

const detectorIds = deterministicDetectorCapabilities.map(({ id }) => id);
const detectorKinds = [...new Set(deterministicDetectorCapabilities.flatMap(({ kinds }) => kinds))];

export function textCapabilityRequirement(operation: CapabilityOperation): CapabilityRequirement {
  const needsDetection = operation !== 'INSPECT';
  return {
    contractVersion: '1.0.0',
    engineModes: ['RULES_ONLY', 'LOCAL_HYBRID'],
    formatId: 'text',
    operation,
    detectorIds: needsDetection ? detectorIds : [],
    detectorKinds: needsDetection ? detectorKinds : [],
    transformationActions: operation === 'REDACT' ? ['TYPED_LABEL'] : [],
    verificationProfile: 'text-rescan-v1',
    maximumInputBytes: defaultMaximumInputBytes,
    minimumQualification: 'DEVELOPMENT'
  };
}

export const localTextApplication = createTextProcessingApplication({
  capabilityProvider: {
    getCapabilities(signal) {
      signal?.throwIfAborted();
      return Promise.resolve(createCurrentCapabilityManifest());
    }
  },
  detector: {
    detectorBundleVersion: deterministicDetectorBundleVersion,
    detect(text, extractionRevision, signal) {
      signal?.throwIfAborted();
      const evidence = detectDeterministic(text, extractionRevision);
      signal?.throwIfAborted();
      return Promise.resolve(evidence);
    }
  },
  verifier: {
    verify(text, extractionRevision, signal) {
      signal?.throwIfAborted();
      const report = verifyCanonicalText(text, extractionRevision);
      signal?.throwIfAborted();
      return Promise.resolve(report);
    }
  }
});
