// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Independent verification outcome bound to the exact output digest.
 */
export interface VerificationReport {
  schemaVersion: '1.0.0';
  artifactId: string;
  artifactDigest: string;
  profile: string;
  outcome: 'PASS' | 'FAIL' | 'INCOMPLETE';
  /**
   * @minItems 1
   * @maxItems 100
   */
  checks: [string, ...string[]];
  /**
   * @maxItems 10000
   */
  findings: {
    code: string;
    severity: 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
    blocking: boolean;
    locationRef?: string;
  }[];
  completedAt: string;
  reportDigest: string;
}
