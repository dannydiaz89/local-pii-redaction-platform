import { describe, expect, it } from 'vitest';

import * as sdk from '@local-pii/sdk';
import type {
  CapabilityClient,
  CapabilitySummary,
  DetectionPageSummary,
  EngineMode,
  JobDetectionSummary,
  JobEventPageSummary,
  JobEventSummary,
  JobEventType,
  JobOperation,
  JobState,
  JobStatusSummary,
  LocalApiSession,
  LocalEngineMode,
  LocalJobClient,
  LocalSessionClient,
  PolicyCatalogSummary,
  PolicyReference,
  PreviewConflictSummary,
  PreviewDetectionSource,
  PreviewDetectionSummary,
  PreviewEntityType,
  PreviewOutcome,
  PreviewScanSummary,
  ProcessingRedactionSummary,
  ProcessingScanSummary,
  RedactedOutputSummary,
  ReviewDecisionInput,
  ReviewDecisionSummary,
  ReviewSetSummary,
  ScanProgressState,
  SupportedFileFormat
} from '@local-pii/sdk';

// @ts-expect-error SDK internals are intentionally unavailable to package-root consumers.
import type { CapabilityClient as InternalCapabilityClient } from '@local-pii/sdk/api';

type PublicTypeSurface = readonly [
  CapabilityClient,
  CapabilitySummary,
  DetectionPageSummary,
  EngineMode,
  JobDetectionSummary,
  JobEventPageSummary,
  JobEventSummary,
  JobEventType,
  JobOperation,
  JobState,
  JobStatusSummary,
  LocalApiSession,
  LocalEngineMode,
  LocalJobClient,
  LocalSessionClient,
  PolicyCatalogSummary,
  PolicyReference,
  PreviewConflictSummary,
  PreviewDetectionSource,
  PreviewDetectionSummary,
  PreviewEntityType,
  PreviewOutcome,
  PreviewScanSummary,
  ProcessingRedactionSummary,
  ProcessingScanSummary,
  RedactedOutputSummary,
  ReviewDecisionInput,
  ReviewDecisionSummary,
  ReviewSetSummary,
  ScanProgressState,
  SupportedFileFormat
];

function acceptsPublicTypeSurface(surface: PublicTypeSurface): void { void surface; }
function rejectsInternalSubpath(client: InternalCapabilityClient): void { void client; }
void acceptsPublicTypeSurface;
void rejectsInternalSubpath;

describe('SDK package-root consumer compatibility', () => {
  it('resolves the reviewed runtime root without exposing an internal subpath', () => {
    expect(Object.keys(sdk).sort()).toEqual([
      'assertLocalApiSession',
      'capabilityRequestTimeoutMs',
      'createCapabilityClient',
      'createDisconnectedCapabilityClient',
      'createDisconnectedLocalSessionClient',
      'createLocalSessionClient',
      'jobRequestTimeoutMs',
      'localClientMaximumConflictDetails',
      'localClientMaximumDetectionDetails',
      'localClientMaximumInputBytes',
      'localClientMaximumOutputBytes',
      'projectCapabilitySummary',
      'projectDetectionPage',
      'projectPolicyCatalog',
      'projectPreviewScan',
      'projectReviewSet',
      'scanWorkflowTimeoutMs'
    ]);
  });
});
