import { createHash } from 'node:crypto';

import {
  localPreviewMaximumConflictDetails,
  localPreviewMaximumDetectionDetails,
  localPreviewMaximumInputBytes,
  type JobsPreviewReviewReportV2Contract,
  type JobsPreviewScanReportContract
} from '@local-pii/contracts';
import type {
  ApplicationContext,
  TextArtifact,
  TextProcessingApplication,
  TextScanResult
} from '@local-pii/core';
import { parseSha256Digest, SafeError, type EntityType } from '@local-pii/domain';
import { textCapabilityRequirement } from '@local-pii/profile-local';

export type PreviewFormat = 'text' | 'markdown';
export type PreviewScanReport = Readonly<JobsPreviewScanReportContract.EphemeralPreviewScanReport>;
export type PreviewReviewReport = Readonly<JobsPreviewReviewReportV2Contract.EphemeralPreviewReviewReportV2>;
export interface DecodedLocalTextArtifact extends TextArtifact {
  readonly mediaType: 'text/plain' | 'text/markdown';
}

export interface PreviewScanPort {
  scan(
    bytes: Uint8Array,
    format: PreviewFormat,
    context: ApplicationContext,
    signal?: AbortSignal
  ): Promise<PreviewReviewReport>;
}

const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf]);

function digestBytes(bytes: Uint8Array) {
  return parseSha256Digest(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

function extractionDigest(text: string) {
  const digest = createHash('sha256')
    .update('local-pii:canonical-text:v1\u0000', 'utf8')
    .update(text, 'utf8')
    .digest('hex');
  return parseSha256Digest(`sha256:${digest}`);
}

export function decodeLocalTextArtifact(
  bytes: Uint8Array,
  format: PreviewFormat,
  correlationId: string
): DecodedLocalTextArtifact {
  const hasUtf8Bom = bytes.length >= 3
    && bytes[0] === utf8Bom[0]
    && bytes[1] === utf8Bom[1]
    && bytes[2] === utf8Bom[2];
  const content = hasUtf8Bom ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new SafeError({
      code: 'FORMAT_CORRUPT',
      message: 'The preview input is not valid UTF-8 text.',
      retryable: false,
      correlationId
    });
  }
  if (text.includes('\u0000')) {
    throw new SafeError({
      code: 'FORMAT_CORRUPT',
      message: 'The preview input contains unsupported NUL bytes.',
      retryable: false,
      correlationId
    });
  }
  return Object.freeze({
    reference: 'ephemeral:browser-preview',
    displayName: format === 'markdown' ? 'browser-preview.md' : 'browser-preview.txt',
    mediaType: format === 'markdown' ? 'text/markdown' : 'text/plain',
    byteLength: bytes.byteLength,
    digest: digestBytes(bytes),
    extractionRevision: extractionDigest(text),
    text,
    hasUtf8Bom
  });
}

/** Executes the real shared rules pipeline over one bounded process-local byte sequence. */
export function scanLocalTextBytes(
  application: TextProcessingApplication,
  bytes: Uint8Array,
  format: PreviewFormat,
  context: ApplicationContext,
  signal?: AbortSignal
): Promise<TextScanResult> {
  signal?.throwIfAborted();
  const artifact = decodeLocalTextArtifact(bytes, format, context.correlationId);
  const requirement = {
    ...textCapabilityRequirement('SCAN'),
    maximumInputBytes: localPreviewMaximumInputBytes
  };
  return application.scan({
    session: { input: () => Promise.resolve(artifact) },
    requirement,
    ...(signal === undefined ? {} : { signal })
  }, context);
}

function entityCounts(entityTypes: readonly EntityType[]): Readonly<Partial<Record<EntityType, number>>> {
  const counts: Partial<Record<EntityType, number>> = {};
  for (const entityType of entityTypes) counts[entityType] = (counts[entityType] ?? 0) + 1;
  return Object.freeze(counts);
}

/**
 * Synchronous process-local preview composition. It creates no artifact or job record and returns
 * only bounded aggregate counts; request bytes become unreachable when the operation completes.
 */
export function createLocalPreviewScan(application: TextProcessingApplication): PreviewScanPort {
  const port: PreviewScanPort = {
    async scan(bytes, format, context, signal) {
      signal?.throwIfAborted();
      const result = await scanLocalTextBytes(application, bytes, format, context, signal);
      signal?.throwIfAborted();
      const evidenceById = new Map<string, (typeof result.evidence)[number]>(
        result.evidence.map((item) => [item.id, item])
      );
      const detections = result.resolution.spans
        .slice(0, localPreviewMaximumDetectionDetails)
        .map((span) => {
          const sources = [...new Set(span.evidenceIds.map((id) => evidenceById.get(id)?.source)
            .filter((source) => source !== undefined))].sort();
          if (sources.length === 0) {
            throw new SafeError({
              code: 'INTERNAL_ERROR',
              message: 'The preview detection evidence could not be reconciled.',
              retryable: false,
              correlationId: context.correlationId
            });
          }
          return Object.freeze({
            entityType: span.entityType,
            start: span.start,
            end: span.end,
            offsetUnit: 'UNICODE_CODE_POINT' as const,
            confidence: span.confidence,
            sources: Object.freeze(sources) as JobsPreviewReviewReportV2Contract.EphemeralPreviewReviewReportV2['detections'][number]['sources']
          });
        });
      const conflicts = result.resolution.conflicts
        .slice(0, localPreviewMaximumConflictDetails)
        .map((conflict) => {
          const evidence = conflict.evidenceIds.map((id) => evidenceById.get(id));
          if (evidence.some((item) => item === undefined)) {
            throw new SafeError({
              code: 'INTERNAL_ERROR',
              message: 'The preview conflict evidence could not be reconciled.',
              retryable: false,
              correlationId: context.correlationId
            });
          }
          const reconciled = evidence.filter((item) => item !== undefined);
          const entityTypes = [...new Set(reconciled.map(({ entityType }) => entityType))].sort();
          const sources = [...new Set(reconciled.map(({ source }) => source))].sort();
          if (entityTypes.length === 0 || sources.length === 0) {
            throw new SafeError({
              code: 'INTERNAL_ERROR',
              message: 'The preview conflict evidence could not be reconciled.',
              retryable: false,
              correlationId: context.correlationId
            });
          }
          return Object.freeze({
            code: conflict.code,
            start: conflict.start,
            end: conflict.end,
            offsetUnit: 'UNICODE_CODE_POINT' as const,
            entityTypes: Object.freeze(entityTypes) as JobsPreviewReviewReportV2Contract.EphemeralPreviewReviewReportV2['conflicts'][number]['entityTypes'],
            sources: Object.freeze(sources) as JobsPreviewReviewReportV2Contract.EphemeralPreviewReviewReportV2['conflicts'][number]['sources']
          });
        });
      return Object.freeze({
        schemaVersion: '2.0.0',
        operation: 'SCAN',
        outcome: result.outcome,
        counts: Object.freeze({
          detections: result.resolution.spans.length,
          conflicts: result.resolution.conflicts.length,
          byEntity: entityCounts(result.resolution.spans.map(({ entityType }) => entityType))
        }),
        detections,
        detailsLimited: result.resolution.spans.length > localPreviewMaximumDetectionDetails,
        conflicts,
        conflictDetailsLimited: result.resolution.conflicts.length > localPreviewMaximumConflictDetails
      });
    }
  };
  return Object.freeze(port);
}
