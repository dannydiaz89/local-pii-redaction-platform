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
import {
  ollamaExperimentalDefaultLimits,
  ollamaLocalCapabilityDescriptor
} from '@local-pii/provider-ollama';
import { typedLabelTransformationCapabilityDescriptor } from '@local-pii/redaction';
import { textVerificationCapabilityDescriptor } from '@local-pii/verification';

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
    version: '0.7.0',
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

export function createOllamaHybridCapabilityManifest(
  detectorVersion: string = ollamaLocalCapabilityDescriptor.detector.version
): CapabilityManifest {
  const rules = createTextOnlyCapabilityManifest();
  const maximumInputBytes = ollamaExperimentalDefaultLimits.maximumInputBytes;
  const manifest: CapabilityManifest = {
    ...rules,
    id: 'local-hybrid-text',
    engineMode: 'LOCAL_HYBRID',
    formats: rules.formats.filter(({ id }) => id === 'text').map((format) => ({
      ...format,
      limits: { maximumInputBytes }
    })) as CapabilityManifest['formats'],
    verificationProfiles: rules.verificationProfiles.map((profile) => ({
      ...profile,
      formats: profile.formats.filter((format) => format === 'text')
    })) as CapabilityManifest['verificationProfiles'],
    detectors: [
      ...rules.detectors,
      {
        ...ollamaLocalCapabilityDescriptor.detector,
        version: detectorVersion,
        kinds: [...ollamaLocalCapabilityDescriptor.detector.kinds],
        entityTypes: [...ollamaLocalCapabilityDescriptor.detector.entityTypes],
        languages: [...ollamaLocalCapabilityDescriptor.detector.languages]
      }
    ],
    limits: {
      maximumInputBytes,
      maximumCanonicalCodePoints: ollamaExperimentalDefaultLimits.maximumInputCodePoints,
      maximumDetections: ollamaExperimentalDefaultLimits.maximumDetections
    }
  };
  assertCapabilityManifest(manifest, 'cor_cli_hybrid_capabilities');
  return manifest;
}
