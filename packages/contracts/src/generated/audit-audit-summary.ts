// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Privacy-minimized processing provenance and bounded aggregate counts.
 */
export interface AuditSummary {
  schemaVersion: '1.0.0';
  jobId: string;
  operation: 'SCAN' | 'REDACT' | 'VERIFY' | 'INSPECT';
  outcome: 'VERIFIED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  policy: {
    id: string;
    version: string;
    digest: string;
  };
  componentVersions: {
    [k: string]: string;
  };
  counts: {
    [k: string]: number;
  };
  createdAt: string;
  completedAt: string;
}
