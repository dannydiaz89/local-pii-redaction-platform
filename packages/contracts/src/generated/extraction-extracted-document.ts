// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * References to canonical text and source-map blobs for one immutable extraction revision.
 */
export interface ExtractedDocument {
  schemaVersion: '1.0.0';
  artifactId: string;
  adapter: {
    id: string;
    version: string;
  };
  canonicalTextRef: string;
  sourceMapRef: string;
  textLength: number;
  revisionDigest: string;
  /**
   * @maxItems 100
   */
  warnings: string[];
}
