import { SafeError } from '@local-pii/domain';

import type { CapabilityRequirement, CapabilitySnapshot } from './ports.js';

export function assertCapabilities(
  requirement: CapabilityRequirement,
  available: CapabilitySnapshot,
  correlationId: string
): void {
  const missingDetectors = requirement.detectorIds.filter((id) => !available.detectorIds.includes(id));
  const hasVerifier = available.verificationProfiles.includes(requirement.verificationProfile);
  if (missingDetectors.length === 0 && hasVerifier) return;

  throw new SafeError({
    code: 'POLICY_UNSATISFIABLE',
    message: 'The selected policy cannot be satisfied by the available local capabilities.',
    retryable: false,
    correlationId,
    details: {
      missingDetectorCount: missingDetectors.length,
      verificationProfileAvailable: hasVerifier
    }
  });
}
