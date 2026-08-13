import { localPreviewMaximumInputBytes } from '@local-pii/contracts';
import { bundledPolicies, compilePolicy, type EffectivePolicy } from '@local-pii/policy';

export interface LocalPolicySummary {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly riskTier: 'LOW' | 'MODERATE' | 'HIGH';
  readonly example: true;
}

export interface LocalPolicyCatalog {
  readonly schemaVersion: '1.0.0';
  readonly defaultPolicyId: string;
  readonly policies: readonly [LocalPolicySummary, ...LocalPolicySummary[]];
}

export interface LocalPolicyReference {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
}

const processLocalApiDevelopmentPolicy = Object.freeze({
  ...bundledPolicies['development-labels'],
  version: '0.2.0',
  limits: Object.freeze({ maximumInputBytes: localPreviewMaximumInputBytes })
});

function catalogFor(
  sources: readonly [(typeof bundledPolicies)[keyof typeof bundledPolicies], ...((typeof bundledPolicies)[keyof typeof bundledPolicies])[]]
): LocalPolicyCatalog {
  const policies = sources.map((source) => {
    const policy = compilePolicy(source);
    return Object.freeze({
      id: policy.id,
      version: policy.version,
      digest: policy.digest,
      riskTier: policy.riskTier,
      example: true as const
    });
  });
  const [first, ...remaining] = policies;
  if (first === undefined) throw new Error('The default local policy is unavailable.');
  const frozenPolicies: readonly [LocalPolicySummary, ...LocalPolicySummary[]] = Object.freeze([
    first,
    ...remaining
  ]);
  return Object.freeze({
    schemaVersion: '1.0.0',
    defaultPolicyId: first.id,
    policies: frozenPolicies
  });
}

/** Returns only pinned operational metadata; policy rules and presentation copy remain separate. */
export function createLocalPolicyCatalog(): LocalPolicyCatalog {
  const sources = Object.keys(bundledPolicies).sort()
    .map((id) => bundledPolicies[id as keyof typeof bundledPolicies]);
  if (!sources.some(({ id }) => id === 'development-labels')) {
    throw new Error('The default local policy is unavailable.');
  }
  return catalogFor(sources as [typeof sources[number], ...typeof sources]);
}

/** Policy catalog whose admission bound exactly matches the process-local API transport. */
export function createProcessLocalApiPolicyCatalog(): LocalPolicyCatalog {
  return catalogFor([processLocalApiDevelopmentPolicy]);
}

/** Resolves only an exact digest-pinned bundled policy; presentation metadata is not accepted. */
export function resolveLocalPolicy(reference: LocalPolicyReference): EffectivePolicy | undefined {
  const sources = [
    ...Object.values(bundledPolicies),
    processLocalApiDevelopmentPolicy
  ];
  for (const source of sources) {
    if (source.id !== reference.id) continue;
    const policy = compilePolicy(source);
    if (policy.version === reference.version && policy.digest === reference.digest) return policy;
  }
  return undefined;
}
