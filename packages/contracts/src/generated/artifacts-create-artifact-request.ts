// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Initiates one bounded process-local input artifact without accepting a filename or locator.
 */
export interface CreateLocalArtifactRequest {
  schemaVersion: '1.0.0';
  mediaType: 'text/plain' | 'text/markdown';
  byteLength: number;
  digest: string;
}
