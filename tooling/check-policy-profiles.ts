import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundledPolicies } from '@local-pii/policy';
import {
  createCurrentCapabilityManifest,
  createOllamaHybridCapabilityManifest,
  createProcessLocalApiCapabilityManifest,
  createTextOnlyCapabilityManifest
} from '@local-pii/profile-local';

/**
 * Verification profiles a bundled policy names on purpose although no capability declares them.
 *
 * A policy that cannot be satisfied is legitimate and deliberate here: `high-risk-v1` describes
 * verification the platform has not built, and the policy engine refusing it is the behaviour
 * under test. What is not legitimate is being unable to tell that apart from a typo, because a
 * misspelled profile produces exactly the same unavailable decision. Anything named and unbuilt
 * belongs in this list with its reason; anything else fails this gate.
 */
const plannedProfiles: Readonly<Record<string, string>> = {
  'high-risk-v1': 'High-risk disclosure verification is unimplemented. It needs a profile stronger than text-rescan-v1, alongside the QUALIFIED components, the MODEL detector kind, and the irreversible REDACT transformation the same policy requires.'
};

export interface PolicyProfileReference {
  readonly policy: string;
  readonly profile: string;
}

function declaredProfileIds(): ReadonlySet<string> {
  const manifests = [
    createCurrentCapabilityManifest(),
    createTextOnlyCapabilityManifest(),
    createProcessLocalApiCapabilityManifest(),
    createOllamaHybridCapabilityManifest()
  ];
  return new Set(manifests.flatMap((manifest) => manifest.verificationProfiles.map(({ id }) => id)));
}

/** Every profile a bundled policy names, whether as its default or for one format. */
export function referencedProfiles(policies: typeof bundledPolicies): readonly PolicyProfileReference[] {
  return Object.values(policies).flatMap((policy) => {
    // Only some policies declare per-format profiles, so the union needs narrowing rather than
    // an optional read.
    const verification = policy.verification;
    const formatProfiles: readonly string[] = 'formatProfiles' in verification
      ? Object.values(verification.formatProfiles)
      : [];
    return [verification.profile, ...formatProfiles].map((profile) => ({ policy: policy.id, profile }));
  });
}

export function policyProfileViolations(
  references: readonly PolicyProfileReference[],
  declared: ReadonlySet<string>,
  planned: Readonly<Record<string, string>>
): readonly string[] {
  const violations: string[] = [];
  const referenced = new Set(references.map(({ profile }) => profile));
  for (const profile of Object.keys(planned)) {
    if (declared.has(profile)) {
      violations.push(`${profile} is now declared by a capability; remove it from the planned list`);
    }
    if (!referenced.has(profile)) {
      violations.push(`${profile} is listed as planned but no bundled policy names it`);
    }
  }
  for (const { policy, profile } of references) {
    if (declared.has(profile) || profile in planned) continue;
    violations.push(`${policy} names verification profile ${profile}, which no capability declares and which is not listed as planned`);
  }
  return violations;
}

export function assertPolicyProfiles(): void {
  const references = referencedProfiles(bundledPolicies);
  const violations = policyProfileViolations(references, declaredProfileIds(), plannedProfiles);
  if (violations.length > 0) {
    throw new Error(`Policy verification-profile violations:\n${violations.join('\n')}`);
  }
  console.log(
    `Policy verification profiles resolve: ${String(references.length)} references, `
    + `${String(Object.keys(plannedProfiles).length)} deliberately unbuilt.`
  );
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  assertPolicyProfiles();
}
