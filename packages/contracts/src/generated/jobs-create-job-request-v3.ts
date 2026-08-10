// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Creates a session-only scan or redaction job bound to one immutable server-owned input artifact and pinned policy.
 */
export interface CreateLocalProcessingJobRequest {
  schemaVersion: '3.0.0';
  operation: 'SCAN' | 'REDACT';
  inputArtifactId: string;
  policy: {
    id: string;
    version: string;
    digest: string;
  };
}
