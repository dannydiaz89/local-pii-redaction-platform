// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Privacy-minimized counts from an authenticated process-local browser preview scan.
 */
export interface EphemeralPreviewScanReport {
  schemaVersion: '1.0.0';
  operation: 'SCAN';
  outcome: 'SUCCEEDED' | 'NEEDS_REVIEW';
  counts: {
    detections: number;
    conflicts: number;
    byEntity: {
      [k: string]: number;
    };
  };
}
