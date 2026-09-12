import {
  defaultMaximumInputBytes,
  textAdapterCapabilityDescriptor
} from '@local-pii/adapter-text';
import {
  csvAdapterCapabilityDescriptor,
  defaultMaximumCsvInputBytes
} from '@local-pii/adapter-csv';
import {
  defaultMaximumDocxInputBytes,
  docxAdapterCapabilityDescriptor,
  docxExtractionVerificationCapabilityDescriptor
} from '@local-pii/adapter-docx';
import {
  defaultMaximumPdfInputBytes,
  pdfAdapterCapabilityDescriptor,
  pdfExtractionVerificationCapabilityDescriptor
} from '@local-pii/adapter-pdf';
import {
  defaultMaximumJsonInputBytes,
  jsonAdapterCapabilityDescriptor
} from '@local-pii/adapter-json';
import { deterministicDetectorCapabilities, defaultDetectorLimits } from '@local-pii/detectors';
import { assertCapabilityManifest, type CapabilityManifest } from '@local-pii/core';
import { localPreviewMaximumInputBytes } from '@local-pii/contracts';
import {
  inferenceExperimentalDefaultLimits,
  inferenceLocalDetectorId
} from '@local-pii/provider-inference';
import {
  ollamaExperimentalDefaultLimits,
  ollamaLocalCapabilityDescriptor
} from '@local-pii/provider-ollama';
import { typedLabelTransformationCapabilityDescriptor } from '@local-pii/redaction';
import {
  docxRedactionVerificationCapabilityDescriptor,
  textHybridVerificationCapabilityDescriptor,
  textVerificationCapabilityDescriptor
} from '@local-pii/verification';

export function createCurrentCapabilityManifest(): CapabilityManifest {
  const detectors = deterministicDetectorCapabilities.map((detector) => ({
    ...detector,
    kinds: [...detector.kinds],
    entityTypes: [...detector.entityTypes],
    languages: [...detector.languages],
    availability: 'AVAILABLE' as const,
    qualification: 'DEVELOPMENT' as const
  })) as unknown as CapabilityManifest['detectors'];

  const textFormat = {
    ...textAdapterCapabilityDescriptor,
    mediaTypes: [...textAdapterCapabilityDescriptor.mediaTypes],
    extensions: [...textAdapterCapabilityDescriptor.extensions],
    operations: [...textAdapterCapabilityDescriptor.operations],
    features: textAdapterCapabilityDescriptor.features.map((feature) => ({ ...feature })),
    verificationProfiles: [...textAdapterCapabilityDescriptor.verificationProfiles],
    qualification: 'DEVELOPMENT'
  } as unknown as CapabilityManifest['formats'][number];
  const jsonFormat = {
    ...jsonAdapterCapabilityDescriptor,
    mediaTypes: [...jsonAdapterCapabilityDescriptor.mediaTypes],
    extensions: [...jsonAdapterCapabilityDescriptor.extensions],
    operations: [...jsonAdapterCapabilityDescriptor.operations],
    features: jsonAdapterCapabilityDescriptor.features.map((feature) => ({ ...feature })),
    verificationProfiles: [...jsonAdapterCapabilityDescriptor.verificationProfiles],
    qualification: 'DEVELOPMENT'
  } as unknown as CapabilityManifest['formats'][number];
  const csvFormat = {
    ...csvAdapterCapabilityDescriptor,
    mediaTypes: [...csvAdapterCapabilityDescriptor.mediaTypes],
    extensions: [...csvAdapterCapabilityDescriptor.extensions],
    operations: [...csvAdapterCapabilityDescriptor.operations],
    features: csvAdapterCapabilityDescriptor.features.map((feature) => ({ ...feature })),
    verificationProfiles: [...csvAdapterCapabilityDescriptor.verificationProfiles],
    qualification: 'DEVELOPMENT'
  } as unknown as CapabilityManifest['formats'][number];
  const docxFormat = {
    ...docxAdapterCapabilityDescriptor,
    mediaTypes: [...docxAdapterCapabilityDescriptor.mediaTypes],
    extensions: [...docxAdapterCapabilityDescriptor.extensions],
    operations: [...docxAdapterCapabilityDescriptor.operations],
    features: docxAdapterCapabilityDescriptor.features.map((feature) => ({ ...feature })),
    verificationProfiles: [...docxAdapterCapabilityDescriptor.verificationProfiles],
    qualification: 'EXPERIMENTAL'
  } as unknown as CapabilityManifest['formats'][number];
  const pdfFormat = {
    ...pdfAdapterCapabilityDescriptor,
    mediaTypes: [...pdfAdapterCapabilityDescriptor.mediaTypes],
    extensions: [...pdfAdapterCapabilityDescriptor.extensions],
    operations: [...pdfAdapterCapabilityDescriptor.operations],
    features: pdfAdapterCapabilityDescriptor.features.map((feature) => ({ ...feature })),
    verificationProfiles: [...pdfAdapterCapabilityDescriptor.verificationProfiles],
    qualification: 'EXPERIMENTAL'
  } as unknown as CapabilityManifest['formats'][number];

  const verifier = {
    ...textVerificationCapabilityDescriptor,
    formats: [...textVerificationCapabilityDescriptor.formats],
    checks: [...textVerificationCapabilityDescriptor.checks],
    availability: 'AVAILABLE',
    qualification: 'DEVELOPMENT'
  } as unknown as CapabilityManifest['verificationProfiles'][number];

  const manifest: CapabilityManifest = {
    schemaVersion: '1.0.0',
    id: 'local-rules-files',
    version: '1.0.0',
    engineMode: 'RULES_ONLY',
    supportedContractVersions: ['1.0.0'],
    formats: [textFormat, jsonFormat, csvFormat, docxFormat, pdfFormat],
    detectors,
    transformations: [{
      ...typedLabelTransformationCapabilityDescriptor,
      availability: 'AVAILABLE',
      qualification: 'DEVELOPMENT'
    }],
    verificationProfiles: [
      verifier,
      {
        ...docxExtractionVerificationCapabilityDescriptor,
        formats: [...docxExtractionVerificationCapabilityDescriptor.formats],
        checks: [...docxExtractionVerificationCapabilityDescriptor.checks],
        availability: 'AVAILABLE',
        qualification: 'EXPERIMENTAL'
      } as unknown as CapabilityManifest['verificationProfiles'][number],
      {
        ...docxRedactionVerificationCapabilityDescriptor,
        formats: [...docxRedactionVerificationCapabilityDescriptor.formats],
        checks: [...docxRedactionVerificationCapabilityDescriptor.checks],
        availability: 'AVAILABLE',
        qualification: 'EXPERIMENTAL'
      } as unknown as CapabilityManifest['verificationProfiles'][number],
      {
        ...pdfExtractionVerificationCapabilityDescriptor,
        formats: [...pdfExtractionVerificationCapabilityDescriptor.formats],
        checks: [...pdfExtractionVerificationCapabilityDescriptor.checks],
        availability: 'AVAILABLE',
        qualification: 'EXPERIMENTAL'
      } as unknown as CapabilityManifest['verificationProfiles'][number]
    ],
    limits: {
      maximumInputBytes: Math.max(
        defaultMaximumInputBytes,
        defaultMaximumJsonInputBytes,
        defaultMaximumCsvInputBytes,
        defaultMaximumDocxInputBytes,
        defaultMaximumPdfInputBytes
      ),
      maximumCanonicalCodePoints: defaultDetectorLimits.maximumCodePoints,
      maximumDetections: defaultDetectorLimits.maximumDetections
    }
  };
  assertCapabilityManifest(manifest, 'cor_cli_capabilities');
  return manifest;
}

/** Capability snapshot retained by the current TXT/Markdown-only browser composition. */
export function createTextOnlyCapabilityManifest(): CapabilityManifest {
  const files = createCurrentCapabilityManifest();
  const manifest: CapabilityManifest = {
    ...files,
    id: 'local-rules-text',
    version: '0.1.0',
    formats: files.formats.filter(({ id }) => id === 'text') as CapabilityManifest['formats'],
    verificationProfiles: files.verificationProfiles.filter((profile) => profile.formats.includes('text')).map((profile) => ({
      ...profile,
      formats: profile.formats.filter((format) => format === 'text')
    })) as CapabilityManifest['verificationProfiles']
  };
  assertCapabilityManifest(manifest, 'cor_text_capabilities');
  return manifest;
}

/** Capability snapshot for the bounded process-local API artifact transport. */
export function createProcessLocalApiCapabilityManifest(): CapabilityManifest {
  const files = createCurrentCapabilityManifest();
  const formatIds = new Set(['text', 'json', 'csv']);
  const manifest: CapabilityManifest = {
    ...files,
    id: 'local-rules-api-files',
    version: '0.1.0',
    formats: files.formats.filter(({ id }) => formatIds.has(id)).map((format) => ({
      ...format,
      limits: { ...format.limits, maximumInputBytes: localPreviewMaximumInputBytes }
    })) as CapabilityManifest['formats'],
    verificationProfiles: files.verificationProfiles
      .map((profile) => ({
        ...profile,
        formats: profile.formats.filter((format) => formatIds.has(format))
      }))
      .filter(({ formats }) => formats.length > 0) as CapabilityManifest['verificationProfiles'],
    limits: {
      ...files.limits,
      maximumInputBytes: localPreviewMaximumInputBytes
    }
  };
  assertCapabilityManifest(manifest, 'cor_api_capabilities');
  return manifest;
}

export interface HybridCapabilityManifestOptions {
  readonly id: string;
  readonly detector: CapabilityManifest['detectors'][number];
  readonly maximumInputBytes: number;
  readonly maximumCanonicalCodePoints: number;
  readonly maximumDetections: number;
}

/** Text-only manifest for any experimental contextual provider composed beside the rules. */
export function createHybridCapabilityManifest(options: HybridCapabilityManifestOptions): CapabilityManifest {
  const rules = createTextOnlyCapabilityManifest();
  const { maximumInputBytes } = options;
  const manifest: CapabilityManifest = {
    ...rules,
    id: options.id,
    engineMode: 'LOCAL_HYBRID',
    formats: rules.formats.filter(({ id }) => id === 'text').map((format) => ({
      ...format,
      limits: { maximumInputBytes }
    })) as CapabilityManifest['formats'],
    verificationProfiles: [{
      ...textHybridVerificationCapabilityDescriptor,
      formats: [...textHybridVerificationCapabilityDescriptor.formats],
      checks: [...textHybridVerificationCapabilityDescriptor.checks],
      availability: 'AVAILABLE',
      qualification: 'EXPERIMENTAL'
    } as unknown as CapabilityManifest['verificationProfiles'][number]],
    detectors: [...rules.detectors, options.detector],
    limits: {
      maximumInputBytes,
      maximumCanonicalCodePoints: options.maximumCanonicalCodePoints,
      maximumDetections: options.maximumDetections
    }
  };
  assertCapabilityManifest(manifest, 'cor_hybrid_capabilities');
  return manifest;
}

export function createOllamaHybridCapabilityManifest(
  detectorVersion: string = ollamaLocalCapabilityDescriptor.detector.version
): CapabilityManifest {
  return createHybridCapabilityManifest({
    id: 'local-hybrid-text',
    detector: {
      ...ollamaLocalCapabilityDescriptor.detector,
      version: detectorVersion,
      kinds: [...ollamaLocalCapabilityDescriptor.detector.kinds],
      entityTypes: [...ollamaLocalCapabilityDescriptor.detector.entityTypes],
      languages: [...ollamaLocalCapabilityDescriptor.detector.languages]
    } as unknown as CapabilityManifest['detectors'][number],
    maximumInputBytes: ollamaExperimentalDefaultLimits.maximumInputBytes,
    maximumCanonicalCodePoints: ollamaExperimentalDefaultLimits.maximumInputCodePoints,
    maximumDetections: ollamaExperimentalDefaultLimits.maximumDetections
  });
}

/**
 * Text-only hybrid manifest for the process-local API transport. The admission bound is the
 * smaller of the browser preview limit and the experimental provider limit, so nothing the API
 * accepts can exceed what the provider is declared to handle.
 */
export function createOllamaHybridApiCapabilityManifest(
  detectorVersion: string = ollamaLocalCapabilityDescriptor.detector.version
): CapabilityManifest {
  const hybrid = createOllamaHybridCapabilityManifest(detectorVersion);
  const maximumInputBytes = Math.min(localPreviewMaximumInputBytes, ollamaExperimentalDefaultLimits.maximumInputBytes);
  const manifest: CapabilityManifest = {
    ...hybrid,
    id: 'local-hybrid-api-text',
    version: '0.1.0',
    formats: hybrid.formats.map((format) => ({
      ...format,
      limits: { ...format.limits, maximumInputBytes }
    })) as CapabilityManifest['formats'],
    limits: { ...hybrid.limits, maximumInputBytes }
  };
  assertCapabilityManifest(manifest, 'cor_api_hybrid_capabilities');
  return manifest;
}

export interface InferenceHybridManifestOptions {
  readonly detectorVersion: string;
  readonly entityTypes: readonly string[];
  readonly languages: readonly string[];
  readonly profile: 'cli' | 'process-local-api';
}

/** Manifest for the local inference service provider; entity types come from its verified bundle. */
export function createInferenceHybridCapabilityManifest(options: InferenceHybridManifestOptions): CapabilityManifest {
  const api = options.profile === 'process-local-api';
  const maximumInputBytes = api
    ? Math.min(localPreviewMaximumInputBytes, inferenceExperimentalDefaultLimits.maximumInputBytes)
    : inferenceExperimentalDefaultLimits.maximumInputBytes;
  return createHybridCapabilityManifest({
    id: api ? 'local-hybrid-api-inference-text' : 'local-hybrid-inference-text',
    detector: {
      id: inferenceLocalDetectorId,
      version: options.detectorVersion,
      kinds: ['MODEL'],
      entityTypes: [...options.entityTypes],
      languages: [...options.languages],
      availability: 'AVAILABLE',
      qualification: 'EXPERIMENTAL'
    } as unknown as CapabilityManifest['detectors'][number],
    maximumInputBytes,
    maximumCanonicalCodePoints: inferenceExperimentalDefaultLimits.maximumInputCodePoints,
    maximumDetections: inferenceExperimentalDefaultLimits.maximumDetections
  });
}
