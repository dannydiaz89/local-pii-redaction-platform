// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Initiates one bounded process-local text or structured artifact without accepting a filename or locator.
 */
export interface CreateLocalArtifactRequestV2 {
  schemaVersion: '2.0.0';
  mediaType: 'text/plain' | 'text/markdown' | 'application/json' | 'text/csv';
  byteLength: number;
  digest: string;
}
