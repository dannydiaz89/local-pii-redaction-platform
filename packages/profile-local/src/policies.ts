import { bundledPolicies, compilePolicy } from '@local-pii/policy';

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
