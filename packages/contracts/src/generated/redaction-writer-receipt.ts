// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Privacy-safe record of a writer's bounded application of one immutable redaction plan to a staged artifact. Applied action IDs retain canonical redaction-plan order; paths and clear values are excluded.
 */
export interface WriterReceipt {
  schemaVersion: '1.0.0';
  planDigest: string;
  writer: {
    id: string;
    version: string;
  };
  stagedDigest: string;
  stagedByteLength: number;
  expectedActionCount: number;
  appliedActionCount: number;
  /**
   * Exact action IDs in canonical immutable redaction-plan order; a writer may traverse native targets in a different safe mutation order.
   *
   * @maxItems 100000
   */
  appliedActionIds: string[];
  receiptDigest: string;
}
