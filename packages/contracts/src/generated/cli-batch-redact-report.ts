// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Privacy-safe aggregate manifest for one strict bounded recursive rules-only redaction attempt. Paths, names, values, source text, patterns, and per-file digests are excluded.
 */
export type BoundedBatchRedactionReport = {
  [k: string]: unknown;
} & {
  schemaVersion: '1.0.0';
  operation: 'BATCH_REDACT';
  outcome: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  completionPolicy: 'REQUIRE_COMPLETE';
  detectorBundleVersion: string;
  policy: PolicySummary;
  manifest: {
    complete: boolean;
    selectedFileCount: number;
    publishedFileCount: number;
    failedFileCount: number;
    directoryCount: number;
    entryCount: number;
    totalInputBytes: number;
    processedInputBytes: number;
    publishedOutputBytes: number;
    replacementCount: number;
    byEntity: {
      [k: string]: number;
    };
    failuresByCode: {
      [k: string]: number;
    };
  };
  selection: {
    includePatternCount: number;
    excludePatternCount: number;
  };
  limits: {
    maximumFiles: 1000;
    maximumDirectories: 1000;
    maximumEntries: 10000;
    maximumTotalInputBytes: 268435456;
    maximumRelativePathCodeUnits: 8192;
    maximumPatternMatchSteps: 100000000;
    timeoutMs: number;
  };
};

export interface PolicySummary {
  id: string;
  version: string;
  digest: string;
  riskTier: 'LOW' | 'MODERATE' | 'HIGH';
  example: true;
}
