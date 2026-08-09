import {
  createTextProcessingApplication,
  type CapabilityOperation,
  type CapabilityRequirement
} from '@local-pii/core';
import {
  createCompositeTextDetector,
  detectDeterministic,
  deterministicDetectorBundleVersion,
  deterministicDetectorCapabilities
} from '@local-pii/detectors';
import { defaultMaximumInputBytes } from '@local-pii/adapter-text';
import {
  createOllamaTextDetectionProvider,
  ollamaExperimentalDefaultLimits,
  ollamaLocalDetectorId
} from '@local-pii/provider-ollama';
import { verifyCanonicalText } from '@local-pii/verification';

import {
  createCurrentCapabilityManifest,
  createOllamaHybridCapabilityManifest
} from './capabilities.js';

const detectorIds = deterministicDetectorCapabilities.map(({ id }) => id);
const detectorKinds = [...new Set(deterministicDetectorCapabilities.flatMap(({ kinds }) => kinds))];

export type LocalEngine = 'rules' | 'ollama';

export function textCapabilityRequirement(
  operation: CapabilityOperation,
  engine: LocalEngine = 'rules'
): CapabilityRequirement {
  const needsDetection = operation !== 'INSPECT';
  const hybrid = engine === 'ollama';
  return {
    contractVersion: '1.0.0',
    engineModes: ['RULES_ONLY', 'LOCAL_HYBRID'],
    formatId: 'text',
    operation,
    detectorIds: needsDetection ? [...detectorIds, ...(hybrid ? [ollamaLocalDetectorId] : [])] : [],
    detectorKinds: needsDetection ? [...detectorKinds, ...(hybrid ? ['MODEL' as const] : [])] : [],
    transformationActions: operation === 'REDACT' ? ['TYPED_LABEL'] : [],
    verificationProfile: 'text-rescan-v1',
    maximumInputBytes: hybrid ? ollamaExperimentalDefaultLimits.maximumInputBytes : defaultMaximumInputBytes,
    minimumQualification: hybrid ? 'EXPERIMENTAL' : 'DEVELOPMENT'
  };
}

const rulesDetector = {
  detectorBundleVersion: deterministicDetectorBundleVersion,
  detect(text: string, extractionRevision: Parameters<typeof detectDeterministic>[1], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const evidence = detectDeterministic(text, extractionRevision);
    signal?.throwIfAborted();
    return Promise.resolve(evidence);
  }
};

const verifier = {
  verify(text: string, extractionRevision: Parameters<typeof verifyCanonicalText>[1], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const report = verifyCanonicalText(text, extractionRevision);
    signal?.throwIfAborted();
    return Promise.resolve(report);
  }
};

function application(
  manifest: ReturnType<typeof createCurrentCapabilityManifest>,
  detector: typeof rulesDetector
) {
  return createTextProcessingApplication({
    capabilityProvider: {
      getCapabilities(signal) {
        signal?.throwIfAborted();
        return Promise.resolve(manifest);
      }
    },
    detector,
    verifier
  });
}

export const localTextApplication = application(createCurrentCapabilityManifest(), rulesDetector);

export interface ExperimentalOllamaApplicationOptions {
  readonly model: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export async function createExperimentalOllamaTextApplication(
  options: ExperimentalOllamaApplicationOptions
) {
  const contextual = createOllamaTextDetectionProvider({
    model: options.model,
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  });
  await contextual.prepare(options.signal);
  const detector = createCompositeTextDetector({
    contextual,
    limits: {
      maximumCodePoints: ollamaExperimentalDefaultLimits.maximumInputCodePoints,
      maximumDetections: ollamaExperimentalDefaultLimits.maximumDetections,
      maximumCandidateLength: 256
    },
    correlationId: 'cor_cli_hybrid_detection'
  });
  return application(createOllamaHybridCapabilityManifest(contextual.detectorBundleVersion), detector);
}
