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

/** Returns only pinned operational metadata; policy rules and presentation copy remain separate. */
export function createLocalPolicyCatalog(): LocalPolicyCatalog {
  const policies = Object.keys(bundledPolicies).sort().map((id) => {
    const policy = compilePolicy(bundledPolicies[id as keyof typeof bundledPolicies]);
    return Object.freeze({
      id: policy.id,
      version: policy.version,
      digest: policy.digest,
      riskTier: policy.riskTier,
      example: true as const
    });
  });
  const [first, ...remaining] = policies;
  if (first === undefined || !policies.some(({ id }) => id === 'development-labels')) {
    throw new Error('The default local policy is unavailable.');
  }
  const frozenPolicies: readonly [LocalPolicySummary, ...LocalPolicySummary[]] = Object.freeze([
    first,
    ...remaining
  ]);
  return Object.freeze({
    schemaVersion: '1.0.0',
    defaultPolicyId: 'development-labels',
    policies: frozenPolicies
  });
}

/** Resolves only an exact digest-pinned bundled policy; presentation metadata is not accepted. */
export function resolveLocalPolicy(reference: LocalPolicyReference): EffectivePolicy | undefined {
  const sources: Partial<Record<string, (typeof bundledPolicies)[keyof typeof bundledPolicies]>> = bundledPolicies;
  const source = sources[reference.id];
  if (source === undefined) return undefined;
  const policy = compilePolicy(source);
  return policy.version === reference.version && policy.digest === reference.digest ? policy : undefined;
}
