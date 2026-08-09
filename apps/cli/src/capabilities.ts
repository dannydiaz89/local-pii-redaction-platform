import {
  defaultMaximumInputBytes,
  textAdapterCapabilityDescriptor
} from '@local-pii/adapter-text';
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

  const format = {
    ...textAdapterCapabilityDescriptor,
    mediaTypes: [...textAdapterCapabilityDescriptor.mediaTypes],
    extensions: [...textAdapterCapabilityDescriptor.extensions],
    operations: [...textAdapterCapabilityDescriptor.operations],
    features: textAdapterCapabilityDescriptor.features.map((feature) => ({ ...feature })),
    verificationProfiles: [...textAdapterCapabilityDescriptor.verificationProfiles],
    qualification: 'DEVELOPMENT'
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
    id: 'local-rules-text',
    version: '0.1.0',
    engineMode: 'RULES_ONLY',
    supportedContractVersions: ['1.0.0'],
    formats: [format],
    detectors,
    transformations: [{
      ...typedLabelTransformationCapabilityDescriptor,
      availability: 'AVAILABLE',
      qualification: 'DEVELOPMENT'
    }],
    verificationProfiles: [verifier],
    limits: {
      maximumInputBytes: defaultMaximumInputBytes,
      maximumCanonicalCodePoints: defaultDetectorLimits.maximumCodePoints,
      maximumDetections: defaultDetectorLimits.maximumDetections
    }
  };
  assertCapabilityManifest(manifest, 'cor_cli_capabilities');
  return manifest;
}

export function createOllamaHybridCapabilityManifest(
  detectorVersion: string = ollamaLocalCapabilityDescriptor.detector.version
): CapabilityManifest {
  const rules = createCurrentCapabilityManifest();
  const maximumInputBytes = ollamaExperimentalDefaultLimits.maximumInputBytes;
  const manifest: CapabilityManifest = {
    ...rules,
    id: 'local-hybrid-text',
    engineMode: 'LOCAL_HYBRID',
    formats: rules.formats.map((format) => ({
      ...format,
      limits: { maximumInputBytes }
    })) as CapabilityManifest['formats'],
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
