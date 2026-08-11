import type { CliBatchRedactReportContract } from './generated/index.js';

export const batchRedactReportSchemaId =
  'https://local-pii.dev/schemas/cli/batch-redact-report/1.0.0';

function sumCounts(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

/** Returns value-free semantic violations that JSON Schema cannot express. */
export function batchRedactReportSemanticErrors(
  report: CliBatchRedactReportContract.BoundedBatchRedactionReport
): readonly string[] {
  const { manifest } = report;
  const errors: string[] = [];
  if (manifest.selectedFileCount !== manifest.publishedFileCount + manifest.failedFileCount) {
    errors.push('selected file count does not reconcile');
  }
  if (manifest.processedInputBytes > manifest.totalInputBytes) {
    errors.push('processed bytes exceed selected bytes');
  }
  if (sumCounts(manifest.byEntity) !== manifest.replacementCount) {
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
  if (manifest.publishedFileCount === 0 && (
    manifest.processedInputBytes !== 0
    || manifest.publishedOutputBytes !== 0
    || manifest.replacementCount !== 0
  )) errors.push('empty publication reports processed output evidence');
  return Object.freeze(errors);
}
