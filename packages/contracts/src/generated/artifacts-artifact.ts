// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Immutable input or derived artifact metadata without a storage locator.
 */
export interface Artifact {
  schemaVersion: '1.0.0';
  id: string;
  kind: 'INPUT' | 'SANITIZED_OUTPUT' | 'REPORT' | 'PREVIEW' | 'QUARANTINED';
  mediaType: string;
  byteLength: number;
  digest: string;
  displayName: string;
  publicationState: 'STAGED' | 'IMMUTABLE' | 'QUARANTINED' | 'PUBLISHABLE' | 'EXPIRED' | 'DELETING' | 'DELETED';
  createdAt: string;
  expiresAt?: string;
}
