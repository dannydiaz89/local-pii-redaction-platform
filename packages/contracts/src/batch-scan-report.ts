import type { CliBatchScanReportContract } from './generated/index.js';

export const batchScanReportSchemaId =
  'https://local-pii.dev/schemas/cli/batch-scan-report/1.0.0';

type BatchScanReport = CliBatchScanReportContract.BoundedBatchScanReport;

function sumCounts(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

/**
 * Returns value-free semantic violations that JSON Schema cannot express.
 * Callers should run the canonical JSON Schema first.
 */
export function batchScanReportSemanticErrors(report: BatchScanReport): readonly string[] {
  const { manifest } = report;
  const errors: string[] = [];
  if (manifest.selectedFileCount !== manifest.processedFileCount + manifest.failedFileCount) {
    errors.push('selected file count does not reconcile');
  }
  if (manifest.processedInputBytes > manifest.totalInputBytes) {
    errors.push('processed bytes exceed selected bytes');
  }
  if (sumCounts(manifest.byEntity) !== manifest.detectionCount) {
    errors.push('entity counts do not reconcile');
  }
  if (sumCounts(manifest.failuresByCode) !== manifest.failedFileCount) {
    errors.push('failure counts do not reconcile');
  }
  if (manifest.complete !== (manifest.failedFileCount === 0)) {
    errors.push('completion state does not reconcile');
  }
  if (manifest.selectedFileCount === 0 && manifest.totalInputBytes !== 0) {
    errors.push('empty selection reports selected bytes');
  }
  if (manifest.processedFileCount === 0 && manifest.processedInputBytes !== 0) {
    errors.push('empty processing reports processed bytes');
  }
  if (manifest.processedFileCount === 0 && manifest.detectionCount !== 0) {
    errors.push('empty processing reports detections');
  }
  if (manifest.processedFileCount === 0 && manifest.conflictCount !== 0) {
    errors.push('empty processing reports conflicts');
  }
  return Object.freeze(errors);
}
