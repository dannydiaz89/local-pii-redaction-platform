// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Metadata-only request for a pinned local job. Document bytes and locators are not accepted.
 */
export interface CreateJobRequest {
  schemaVersion: '1.0.0';
  operation: 'SCAN' | 'REDACT' | 'VERIFY' | 'INSPECT';
  policy: {
    id: string;
    version: string;
    digest: string;
  };
}
