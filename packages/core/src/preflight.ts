import { validateContract } from '@local-pii/contracts';
import { SafeError } from '@local-pii/domain';

import type { CapabilityManifest, CapabilityQualification, CapabilityRequirement } from './ports.js';

const capabilityManifestSchemaId = 'https://local-pii.dev/schemas/capabilities/capability-manifest/1.0.0';
const qualificationRank: Readonly<Record<CapabilityQualification, number>> = {
  EXPERIMENTAL: 0,
  DEVELOPMENT: 1,
  QUALIFIED: 2
};

function isQualified(actual: CapabilityQualification, required: CapabilityQualification): boolean {
  return qualificationRank[actual] >= qualificationRank[required];
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function invalidManifest(correlationId: string): never {
  throw new SafeError({
    code: 'SCHEMA_INVALID',
    message: 'The capability manifest is invalid or internally inconsistent.',
    retryable: false,
    correlationId
  });
}

export function assertCapabilityManifest(manifest: CapabilityManifest, correlationId: string): void {
  if (!validateContract(capabilityManifestSchemaId, manifest).valid) invalidManifest(correlationId);

  if (
    hasDuplicate(manifest.formats.map(({ id }) => id))
    || hasDuplicate(manifest.detectors.map(({ id }) => id))
    || hasDuplicate(manifest.transformations.map(({ id }) => id))
    || hasDuplicate(manifest.verificationProfiles.map(({ id }) => id))
  ) invalidManifest(correlationId);

  const profileById = new Map(manifest.verificationProfiles.map((profile) => [profile.id, profile]));
  for (const format of manifest.formats) {
    if (format.limits.maximumInputBytes > manifest.limits.maximumInputBytes) invalidManifest(correlationId);
    if (hasDuplicate(format.features.map(({ id }) => id))) invalidManifest(correlationId);
    for (const profileId of format.verificationProfiles) {
      const profile = profileById.get(profileId);
      if (profile === undefined || !profile.formats.includes(format.id)) invalidManifest(correlationId);
    }
  }
  for (const profile of manifest.verificationProfiles) {
    for (const formatId of profile.formats) {
      const format = manifest.formats.find(({ id }) => id === formatId);
      if (format === undefined || !format.verificationProfiles.includes(profile.id)) invalidManifest(correlationId);
    }
  }
  if (
    manifest.engineMode === 'RULES_ONLY'
    && manifest.detectors.some((detector) => detector.availability === 'AVAILABLE' && detector.kinds.includes('MODEL'))
  ) invalidManifest(correlationId);
}

export function assertCapabilities(
  requirement: CapabilityRequirement,
  available: CapabilityManifest,
  correlationId: string
): void {
  assertCapabilityManifest(available, correlationId);

  const hasContract = available.supportedContractVersions.includes(requirement.contractVersion);
  const hasEngineMode = requirement.engineModes.includes(available.engineMode);
  const format = available.formats.find(({ id }) => id === requirement.formatId);
  const hasOperation = format?.operations.includes(requirement.operation) === true;
  const formatQualified = format !== undefined && isQualified(format.qualification, requirement.minimumQualification);

  const eligibleDetectors = available.detectors.filter((detector) =>
    detector.availability === 'AVAILABLE'
    && isQualified(detector.qualification, requirement.minimumQualification)
  );
  const missingDetectors = requirement.detectorIds.filter((id) => !eligibleDetectors.some((detector) => detector.id === id));
  const missingDetectorKinds = requirement.detectorKinds.filter((kind) =>
    !eligibleDetectors.some((detector) => detector.kinds.includes(kind))
  );

  const missingTransformations = requirement.transformationActions.filter((action) =>
    !available.transformations.some((transformation) =>
      transformation.action === action
      && transformation.availability === 'AVAILABLE'
      && isQualified(transformation.qualification, requirement.minimumQualification)
    )
  );

  const verifier = available.verificationProfiles.find(({ id }) => id === requirement.verificationProfile);
  const hasVerifier = verifier !== undefined
    && verifier.availability === 'AVAILABLE'
    && verifier.formats.includes(requirement.formatId)
    && format?.verificationProfiles.includes(verifier.id) === true
    && isQualified(verifier.qualification, requirement.minimumQualification);
  const hasInputLimit = available.limits.maximumInputBytes >= requirement.maximumInputBytes
    && format !== undefined
    && format.limits.maximumInputBytes >= requirement.maximumInputBytes;

  if (
    hasContract
    && hasEngineMode
    && format !== undefined
    && hasOperation
    && formatQualified
    && missingDetectors.length === 0
    && missingDetectorKinds.length === 0
    && missingTransformations.length === 0
    && hasVerifier
    && hasInputLimit
  ) return;

  throw new SafeError({
    code: 'POLICY_UNSATISFIABLE',
    message: 'The selected policy cannot be satisfied by the available local capabilities.',
    retryable: false,
    correlationId,
    details: {
      contractVersionAvailable: hasContract,
      engineModeAvailable: hasEngineMode,
      formatAvailable: format !== undefined,
      operationAvailable: hasOperation,
      qualificationSufficient: formatQualified,
      missingDetectorCount: missingDetectors.length,
      missingDetectorKindCount: missingDetectorKinds.length,
      missingTransformationCount: missingTransformations.length,
      verificationProfileAvailable: hasVerifier,
      inputLimitSufficient: hasInputLimit
    }
  });
}
