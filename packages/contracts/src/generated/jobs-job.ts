// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Durable job aggregate summary with optimistic revision and minimized metadata.
 */
export interface Job {
  schemaVersion: '1.0.0';
  id: string;
  operation: 'SCAN' | 'REDACT' | 'VERIFY' | 'INSPECT';
  state:
    | 'QUEUED'
    | 'VALIDATING'
    | 'EXTRACTING'
    | 'DETECTING'
    | 'RESOLVING'
    | 'NEEDS_REVIEW'
    | 'REDACTING'
    | 'VERIFYING'
    | 'CANCELLING'
    | 'VERIFIED'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'CANCELLED'
    | 'EXPIRED';
  revision: number;
  policy: {
    id: string;
    version: string;
    digest: string;
  };
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  summary?: {
    detections?: number;
    conflicts?: number;
    findings?: number;
  };
}
