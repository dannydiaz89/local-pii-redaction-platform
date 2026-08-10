// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Creates a session-only redaction job bound to an immutable input, pinned policy, completed scan, and exact append-only review-set revision.
 */
export interface CreateReviewedLocalRedactionJobRequest {
  schemaVersion: '4.0.0';
  operation: 'REDACT';
  inputArtifactId: string;
  policy: {
    id: string;
    version: string;
    digest: string;
  };
  review: {
    sourceJobId: string;
    expectedJobRevision: number;
    expectedExtractionRevision: string;
    expectedReviewRevision: number;
    expectedReviewDigest: string;
  };
}
