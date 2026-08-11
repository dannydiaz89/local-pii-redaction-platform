// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Privacy-safe aggregate manifest for one bounded recursive rules-only scan attempt, including the explicit completion policy. Paths, names, content digests, values, native locations, and patterns are excluded.
 */
export type BoundedBatchScanReportWithCompletionPolicy = {
  [k: string]: unknown;
} & {
  schemaVersion: '2.0.0';
  operation: 'BATCH_SCAN';
  outcome: 'SUCCEEDED' | 'NEEDS_REVIEW' | 'PARTIAL' | 'FAILED';
  completionPolicy: 'REQUIRE_COMPLETE' | 'ALLOW_PARTIAL';
  detectorBundleVersion: string;
  manifest: {
    complete: boolean;
    selectedFileCount: number;
    processedFileCount: number;
    failedFileCount: number;
    directoryCount: number;
    entryCount: number;
    totalInputBytes: number;
    processedInputBytes: number;
    detectionCount: number;
    conflictCount: number;
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
