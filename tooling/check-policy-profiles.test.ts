import { describe, expect, it } from 'vitest';

import { policyProfileViolations, referencedProfiles } from './check-policy-profiles.js';

const declared = new Set(['text-rescan-v1', 'docx-redact-v1']);
const planned = { 'high-risk-v1': 'unbuilt' };
const references = [
  { policy: 'development-labels', profile: 'text-rescan-v1' },
  { policy: 'development-labels', profile: 'docx-redact-v1' },
  { policy: 'high-risk-disclosure', profile: 'high-risk-v1' }
];

describe('policy verification-profile references', () => {
  it('accepts declared profiles and deliberately unbuilt ones', () => {
    expect(policyProfileViolations(references, declared, planned)).toEqual([]);
  });

  it('reports a profile that no capability declares and no list plans', () => {
    // A misspelling produces the same unavailable decision as a deliberate gap, which is the
    // whole reason this gate exists.
    const violations = policyProfileViolations(
      [...references, { policy: 'development-labels', profile: 'text-rescan-v9' }],
      declared,
      planned
    );
    expect(violations).toEqual([
      'development-labels names verification profile text-rescan-v9, which no capability declares and which is not listed as planned'
    ]);
  });

  it('reports a planned profile that has since been built, or that nothing names', () => {
    expect(policyProfileViolations(references, new Set([...declared, 'high-risk-v1']), planned))
      .toContain('high-risk-v1 is now declared by a capability; remove it from the planned list');
    expect(policyProfileViolations([], declared, planned))
      .toContain('high-risk-v1 is listed as planned but no bundled policy names it');
  });

  it('collects both the default profile and any per-format profile a policy names', () => {
    const collected = referencedProfiles({
      example: {
        id: 'example',
        verification: { profile: 'text-rescan-v1', formatProfiles: { docx: 'docx-redact-v1' } }
      }
    } as unknown as Parameters<typeof referencedProfiles>[0]);
    expect(collected).toEqual([
      { policy: 'example', profile: 'text-rescan-v1' },
      { policy: 'example', profile: 'docx-redact-v1' }
    ]);
  });
});
