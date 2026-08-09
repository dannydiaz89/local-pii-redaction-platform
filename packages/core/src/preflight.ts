import { createHash } from 'node:crypto';

import {
  isCapabilityManifestSemanticallyValid,
  validateContract
} from '@local-pii/contracts';
import { SafeError, parseSha256Digest, type Sha256Digest } from '@local-pii/domain';

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

function invalidManifest(correlationId: string): never {
  throw new SafeError({
    code: 'SCHEMA_INVALID',
    message: 'The capability manifest is invalid or internally inconsistent.',
    retryable: false,
    correlationId
  });
}

export function assertCapabilityManifest(manifest: CapabilityManifest, correlationId: string): void {
  if (
    !validateContract(capabilityManifestSchemaId, manifest).valid
    || !isCapabilityManifestSemanticallyValid(manifest)
  ) invalidManifest(correlationId);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Readonly<Record<string, unknown>>)[key])}`
  ).join(',')}}`;
}

/** Digests the exact validated capability snapshot used for preflight. */
export function digestCapabilityManifest(
  manifest: CapabilityManifest,
  correlationId: string
): Sha256Digest {
  assertCapabilityManifest(manifest, correlationId);
  return parseSha256Digest(
    `sha256:${createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex')}`
  );
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
