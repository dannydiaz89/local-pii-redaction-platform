// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Privacy-safe bounded counts from an explicit text staging inventory or cleanup.
 */
export interface CLIStageRecoveryReport {
  schemaVersion: '1.0.0';
  operation: 'STAGE_RECOVERY';
  mode: 'DRY_RUN' | 'APPLY';
  minimumAgeMs: number;
  scannedEntryCount: number;
  matchingStageFileCount: number;
  staleStageFileCount: number;
  freshStageFileCount: number;
  protectedEntryCount: number;
  skippedUnsafeEntryCount: number;
  capped: boolean;
  deletedStageFileCount: number;
  deletionFailureCount: number;
}
