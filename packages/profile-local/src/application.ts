import {
  createTextProcessingApplication,
  type BoundTextVerificationRequest,
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
import { defaultMaximumCsvInputBytes } from '@local-pii/adapter-csv';
import { defaultMaximumDocxInputBytes } from '@local-pii/adapter-docx';
import { defaultMaximumJsonInputBytes } from '@local-pii/adapter-json';
import { parseSha256Digest } from '@local-pii/domain';
import {
  createOllamaTextDetectionProvider,
  ollamaExperimentalDefaultLimits,
  ollamaLocalDetectorId
} from '@local-pii/provider-ollama';
import {
  textVerificationProfile,
  textVerificationDetectorBundle,
  textVerificationVerifier,
  verifyBoundCanonicalText,
  verifyCanonicalText
} from '@local-pii/verification';

import {
  createCurrentCapabilityManifest,
  createOllamaHybridCapabilityManifest,
  createTextOnlyCapabilityManifest
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

export function jsonCapabilityRequirement(operation: CapabilityOperation): CapabilityRequirement {
  const needsDetection = operation !== 'INSPECT';
  return {
    contractVersion: '1.0.0',
    engineModes: ['RULES_ONLY'],
    formatId: 'json',
    operation,
    detectorIds: needsDetection ? [...detectorIds] : [],
    detectorKinds: needsDetection ? [...detectorKinds] : [],
    transformationActions: operation === 'REDACT' ? ['TYPED_LABEL'] : [],
    verificationProfile: 'text-rescan-v1',
    maximumInputBytes: defaultMaximumJsonInputBytes,
    minimumQualification: 'DEVELOPMENT'
  };
}

export function csvCapabilityRequirement(operation: CapabilityOperation): CapabilityRequirement {
  const needsDetection = operation !== 'INSPECT';
  return {
    contractVersion: '1.0.0',
    engineModes: ['RULES_ONLY'],
    formatId: 'csv',
    operation,
    detectorIds: needsDetection ? [...detectorIds] : [],
    detectorKinds: needsDetection ? [...detectorKinds] : [],
    transformationActions: operation === 'REDACT' ? ['TYPED_LABEL'] : [],
    verificationProfile: 'text-rescan-v1',
    maximumInputBytes: defaultMaximumCsvInputBytes,
    minimumQualification: 'DEVELOPMENT'
  };
}

export function docxCapabilityRequirement(operation: CapabilityOperation): CapabilityRequirement {
  const needsDetection = operation !== 'INSPECT';
  return {
    contractVersion: '1.0.0',
    engineModes: ['RULES_ONLY'],
    formatId: 'docx',
    operation,
    detectorIds: needsDetection ? [...detectorIds] : [],
    detectorKinds: needsDetection ? [...detectorKinds] : [],
    transformationActions: [],
    verificationProfile: 'docx-extract-v1',
    maximumInputBytes: defaultMaximumDocxInputBytes,
    minimumQualification: 'EXPERIMENTAL'
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
  attestation: {
    profile: textVerificationProfile,
    verifier: textVerificationVerifier,
    detectorBundle: textVerificationDetectorBundle,
    application: {
      id: 'local-pii-cli',
      version: '0.1.0',
      digest: parseSha256Digest('sha256:0fd4cd6f99992ecf8862956817e3e72d0548fb7cbf1ff7765601f51b67530cf0')
    }
  },
  verify(text: string, extractionRevision: Parameters<typeof verifyCanonicalText>[1], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const report = verifyCanonicalText(text, extractionRevision);
    signal?.throwIfAborted();
    return Promise.resolve(report);
  },
  attest(request: BoundTextVerificationRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const startedAt = new Date().toISOString();
    const report = verifyBoundCanonicalText({
      ...request,
      application: verifier.attestation.application,
      startedAt,
      completedAt: new Date().toISOString()
    });
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

export const localTextApplication = application(createTextOnlyCapabilityManifest(), rulesDetector);
export const localFileApplication = application(createCurrentCapabilityManifest(), rulesDetector);

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
