import type { CapabilitiesCapabilityManifestContract } from './generated/index.js';

type CapabilityManifest = CapabilitiesCapabilityManifestContract.CapabilityManifest;

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * Semantic invariants that are stricter than the structural JSON Schema.
 * Public consumers share this function so capability preflight and policy
 * explanation cannot disagree about whether a manifest is internally valid.
 */
export function isCapabilityManifestSemanticallyValid(manifest: CapabilityManifest): boolean {
  if (
    hasDuplicate(manifest.formats.map(({ id }) => id))
    || hasDuplicate(manifest.detectors.map(({ id }) => id))
    || hasDuplicate(manifest.transformations.map(({ id }) => id))
    || hasDuplicate(manifest.verificationProfiles.map(({ id }) => id))
  ) return false;

  const profileById = new Map(manifest.verificationProfiles.map((profile) => [profile.id, profile]));
  for (const format of manifest.formats) {
    if (format.limits.maximumInputBytes > manifest.limits.maximumInputBytes) return false;
    if (hasDuplicate(format.features.map(({ id }) => id))) return false;
    for (const profileId of format.verificationProfiles) {
      const profile = profileById.get(profileId);
      if (profile === undefined || !profile.formats.includes(format.id)) return false;
    }
  }
  for (const profile of manifest.verificationProfiles) {
    for (const formatId of profile.formats) {
      const format = manifest.formats.find(({ id }) => id === formatId);
      if (format === undefined || !format.verificationProfiles.includes(profile.id)) return false;
    }
  }
  return manifest.engineMode !== 'RULES_ONLY'
    || !manifest.detectors.some((detector) =>
      detector.availability === 'AVAILABLE' && detector.kinds.includes('MODEL')
    );
}
