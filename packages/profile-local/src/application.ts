import {
  createTextProcessingApplication,
  type BoundTextVerificationRequest,
  type CapabilityOperation,
  type CapabilityRequirement,
  type TextDetectionPort,
  type TextVerificationPort
} from '@local-pii/core';
import {
  createCompositeTextDetector,
  detectDeterministic,
  detectDeterministicWithStructure,
  deterministicDetectorBundleVersion,
  deterministicDetectorCapabilities
} from '@local-pii/detectors';
import { defaultMaximumInputBytes } from '@local-pii/adapter-text';
import { defaultMaximumCsvInputBytes } from '@local-pii/adapter-csv';
import { defaultMaximumDocxInputBytes } from '@local-pii/adapter-docx';
import { defaultMaximumPdfInputBytes } from '@local-pii/adapter-pdf';
import { defaultMaximumJsonInputBytes } from '@local-pii/adapter-json';
import { parseSha256Digest } from '@local-pii/domain';
import {
  createInferenceTextDetectionProvider,
  inferenceExperimentalDefaultLimits,
  inferenceLocalDetectorId
} from '@local-pii/provider-inference';
import {
  createOllamaTextDetectionProvider,
  ollamaExperimentalDefaultLimits,
  ollamaLocalDetectorId
} from '@local-pii/provider-ollama';
import {
  createHybridTextVerificationDetectorBundle,
  docxRedactionVerificationProfile,
  docxVerificationDetectorBundle,
  docxVerificationVerifier,
  textHybridVerificationProfile,
  textVerificationProfile,
  textVerificationDetectorBundle,
  textVerificationVerifier,
  verifyBoundCanonicalText,
  verifyBoundDocxRedaction,
  verifyBoundHybridText,
  verifyCanonicalText
} from '@local-pii/verification';

import {
  createCurrentCapabilityManifest,
  createInferenceHybridCapabilityManifest,
  createOllamaHybridApiCapabilityManifest,
  createOllamaHybridCapabilityManifest,
  createProcessLocalApiCapabilityManifest,
  createTextOnlyCapabilityManifest
} from './capabilities.js';

export { inferenceExperimentalDefaultLimits } from '@local-pii/provider-inference';
export { ollamaExperimentalDefaultLimits } from '@local-pii/provider-ollama';

const detectorIds = deterministicDetectorCapabilities.map(({ id }) => id);
const detectorKinds = [...new Set(deterministicDetectorCapabilities.flatMap(({ kinds }) => kinds))];

export type LocalEngine = 'rules' | 'ollama' | 'inference';

export function textCapabilityRequirement(
  operation: CapabilityOperation,
  engine: LocalEngine = 'rules'
): CapabilityRequirement {
  const needsDetection = operation !== 'INSPECT';
  const hybrid = engine !== 'rules';
  const contextualDetectorId = engine === 'ollama' ? ollamaLocalDetectorId : inferenceLocalDetectorId;
  const hybridMaximumInputBytes = engine === 'ollama'
    ? ollamaExperimentalDefaultLimits.maximumInputBytes
    : inferenceExperimentalDefaultLimits.maximumInputBytes;
  return {
    contractVersion: '1.0.0',
    engineModes: ['RULES_ONLY', 'LOCAL_HYBRID'],
    formatId: 'text',
    operation,
    detectorIds: needsDetection ? [...detectorIds, ...(hybrid ? [contextualDetectorId] : [])] : [],
    detectorKinds: needsDetection ? [...detectorKinds, ...(hybrid ? ['MODEL' as const] : [])] : [],
    transformationActions: operation === 'REDACT' ? ['TYPED_LABEL'] : [],
    verificationProfile: 'text-rescan-v1',
    maximumInputBytes: hybrid ? hybridMaximumInputBytes : defaultMaximumInputBytes,
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
    transformationActions: operation === 'REDACT' ? ['TYPED_LABEL'] : [],
    // Extraction assurance is not redaction assurance. A redaction is admitted only against the
    // profile that reopens the staged package and reconciles it; `docx-extract-v1` attests that
    // an input could be read and must never stand behind a published derived artifact.
    verificationProfile: operation === 'REDACT' ? 'docx-redact-v1' : 'docx-extract-v1',
    maximumInputBytes: defaultMaximumDocxInputBytes,
    minimumQualification: 'EXPERIMENTAL'
  };
}

export function pdfCapabilityRequirement(operation: CapabilityOperation): CapabilityRequirement {
  return {
    contractVersion: '1.0.0',
    engineModes: ['RULES_ONLY'],
    formatId: 'pdf',
    operation,
    detectorIds: [],
    detectorKinds: [],
    transformationActions: [],
    verificationProfile: 'pdf-literal-extract-v5',
    maximumInputBytes: defaultMaximumPdfInputBytes,
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
  },
  detectStructured(
    request: Parameters<NonNullable<TextDetectionPort['detectStructured']>>[0],
    signal?: AbortSignal
  ) {
    signal?.throwIfAborted();
    const evidence = detectDeterministicWithStructure(
      request.text,
      request.extractionRevision,
      request.regions,
      request.structure
    );
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

/**
 * The DOCX redaction verification port. It is a separate port from the text one because it
 * implements a separate profile: a DOCX output is a package whose canonical text is an
 * extraction, so rescanning that text would leave every part the extraction does not carry
 * unexamined. `verifyBoundDocxRedaction` reparses both packages instead, and a request that
 * does not carry the exact bytes and source map it needs yields INCOMPLETE rather than a PASS.
 */
const docxVerifier: TextVerificationPort = {
  attestation: {
    profile: docxRedactionVerificationProfile,
    verifier: docxVerificationVerifier,
    detectorBundle: docxVerificationDetectorBundle,
    application: verifier.attestation.application
  },
  verify: (text, extractionRevision, signal) => verifier.verify(text, extractionRevision, signal),
  attest(request: BoundTextVerificationRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const startedAt = new Date().toISOString();
    const report = verifyBoundDocxRedaction({
      ...(request.input.nativeBytes === undefined ? {} : { inputBytes: request.input.nativeBytes }),
      ...(request.output.nativeBytes === undefined ? {} : { outputBytes: request.output.nativeBytes }),
      ...(request.sourceText === undefined ? {} : { sourceText: request.sourceText }),
      ...(request.sourceRegions === undefined ? {} : { sourceRegions: request.sourceRegions }),
      reopenedText: request.reopenedText,
      input: { digest: request.input.digest, byteLength: request.input.byteLength },
      output: {
        digest: request.output.digest,
        byteLength: request.output.byteLength,
        mediaType: request.output.mediaType,
        extractionRevision: request.output.extractionRevision
      },
      capabilityDigest: request.capabilityDigest,
      plan: {
        id: request.plan.id,
        digest: request.plan.digest,
        inputDigest: request.plan.inputDigest,
        extractionRevision: request.plan.extractionRevision,
        capabilityDigest: request.plan.capabilityDigest,
        policy: request.plan.policy,
        writer: request.plan.writer,
        expectedActionCount: request.plan.expectedActionCount,
        actions: request.plan.actions.map((action) => ({
          id: action.id,
          sourceSpanId: action.sourceSpanId,
          entityType: action.entityType,
          start: action.start,
          end: action.end,
          replacement: action.replacement
        })),
        ...(request.plan.schemaVersion === '2.0.0' ? { review: request.plan.review } : {})
      },
      policy: request.policy,
      writerReceipt: request.writerReceipt,
      writer: request.writer,
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
  detector: TextDetectionPort,
  verificationPort: TextVerificationPort = verifier
) {
  return createTextProcessingApplication({
    capabilityProvider: {
      getCapabilities(signal) {
        signal?.throwIfAborted();
        return Promise.resolve(manifest);
      }
    },
    detector,
    verifier: verificationPort
  });
}

export const localTextApplication = application(createTextOnlyCapabilityManifest(), rulesDetector);
export const localFileApplication = application(createCurrentCapabilityManifest(), rulesDetector);
/**
 * The same capability snapshot and detectors as the file application, composed with the DOCX
 * redaction verifier. One application can only carry one verification port, and the profile a
 * policy names for DOCX is not the profile it names for text, so the composition root selects
 * this one for a DOCX redaction and the text one for everything else.
 */
export const localDocxApplication = application(createCurrentCapabilityManifest(), rulesDetector, docxVerifier);
export const localApiApplication = application(createProcessLocalApiCapabilityManifest(), rulesDetector);

export interface ExperimentalOllamaApplicationOptions {
  readonly model: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Which transport's capability manifest to publish; defaults to the command-line profile. */
  readonly profile?: 'cli' | 'process-local-api';
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
  const manifest = options.profile === 'process-local-api'
    ? createOllamaHybridApiCapabilityManifest(contextual.detectorBundleVersion)
    : createOllamaHybridCapabilityManifest(contextual.detectorBundleVersion);
  return disposable(application(manifest, detector, hybridVerifier(detector, contextual.detectorBundleVersion)), () => undefined);
}

export type DisposableTextProcessingApplication = ReturnType<typeof application> & {
  /** Releases any subprocess or connection the composition holds; idempotent. */
  dispose(): void;
};

function disposable(
  composed: ReturnType<typeof application>,
  release: () => void
): DisposableTextProcessingApplication {
  let released = false;
  return Object.freeze({
    ...composed,
    dispose(): void {
      if (released) return;
      released = true;
      release();
    }
  });
}

/**
 * Verification rescans the reopened output with the same digest-pinned provider instance that
 * produced the plan. The provider re-checks the model identity after every inference, and the
 * composite detector validates the returned evidence, so the rescan sees exactly the trust
 * boundary the redaction scan saw. A provider failure during the rescan makes the attestation
 * INCOMPLETE; nothing is published on an unverified hybrid output.
 */
function hybridVerifier(
  detector: ReturnType<typeof createCompositeTextDetector>,
  contextualDetectorBundleVersion: string
): TextVerificationPort {
  const detectorBundle = createHybridTextVerificationDetectorBundle(contextualDetectorBundleVersion);
  return {
    attestation: {
      profile: textHybridVerificationProfile,
      verifier: textVerificationVerifier,
      detectorBundle,
      application: verifier.attestation.application
    },
    verify: (text, extractionRevision, signal) => verifier.verify(text, extractionRevision, signal),
    attest(request: BoundTextVerificationRequest, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const startedAt = new Date().toISOString();
      return verifyBoundHybridText(
        { ...request, application: verifier.attestation.application, startedAt, completedAt: startedAt },
        {
          contextualRescan: async (text, extractionRevision, rescanSignal) =>
            (await detector.detectWithResult(text, extractionRevision, rescanSignal)).evidence
              .filter(({ source }) => source === 'MODEL'),
          detectorBundle,
          ...(signal === undefined ? {} : { signal }),
          completedAt: () => new Date().toISOString()
        }
      );
    }
  };
}

export interface ExperimentalInferenceApplicationOptions {
  /** Operator-supplied, digest-pinned bundle directory; never derived from document content. */
  readonly bundleDirectory: string;
  readonly pythonExecutable?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly profile?: 'cli' | 'process-local-api';
}

/** Composes the rules with the local inference service over its subprocess profile. */
export async function createExperimentalInferenceTextApplication(
  options: ExperimentalInferenceApplicationOptions
) {
  const contextual = createInferenceTextDetectionProvider({
    bundleDirectory: options.bundleDirectory,
    ...(options.pythonExecutable === undefined ? {} : { pythonExecutable: options.pythonExecutable }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  });
  await contextual.prepare(options.signal);
  const capabilities = contextual.capabilities;
  if (capabilities === undefined) throw new TypeError('The inference provider did not publish capabilities.');
  const detector = createCompositeTextDetector({
    contextual,
    limits: {
      maximumCodePoints: inferenceExperimentalDefaultLimits.maximumInputCodePoints,
      maximumDetections: inferenceExperimentalDefaultLimits.maximumDetections,
      maximumCandidateLength: 256
    },
    correlationId: 'cor_cli_hybrid_detection'
  });
  const manifest = createInferenceHybridCapabilityManifest({
    detectorVersion: contextual.detectorBundleVersion,
    entityTypes: capabilities.entityTypes,
    languages: capabilities.languages,
    profile: options.profile ?? 'cli'
  });
  return disposable(
    application(manifest, detector, hybridVerifier(detector, contextual.detectorBundleVersion)),
    () => { contextual.close(); }
  );
}
