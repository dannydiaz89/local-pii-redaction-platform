// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Creates a scan job bound to one immutable server-owned input artifact and pinned policy.
 */
export interface CreateProcessingJobRequest {
  schemaVersion: '2.0.0';
  operation: 'SCAN';
  inputArtifactId: string;
  policy: {
    id: string;
    version: string;
    digest: string;
  };
}
