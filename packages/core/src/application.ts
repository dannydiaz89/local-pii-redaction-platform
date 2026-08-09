import {
  SafeError,
  parseCorrelationId,
  unicodeCodePointLength,
  type CorrelationId
} from '@local-pii/domain';
import { applyTypedLabelPlan, compileTypedLabelPlan } from '@local-pii/redaction';
import { resolveEvidence } from '@local-pii/span-resolution';

import { assertCapabilityManifest, assertCapabilities } from './preflight.js';
import type {
  ApplicationContext,
  CapabilityManifest,
  RedactTextCommand,
  TextCommand,
  TextProcessingApplication,
  TextProcessingApplicationDependencies,
  TextScanResult
} from './ports.js';

const fallbackCorrelationId = 'cor_core_application';

function correlationId(context: ApplicationContext): CorrelationId {
  try {
    return parseCorrelationId(context.correlationId);
  } catch {
    throw new SafeError({
      code: 'SCHEMA_INVALID',
      message: 'The application request context is invalid.',
      retryable: false,
      correlationId: fallbackCorrelationId
    });
  }
}

function internalFailure(requestCorrelationId: CorrelationId): SafeError {
  return new SafeError({
    code: 'INTERNAL_ERROR',
    message: 'The application operation failed unexpectedly.',
    retryable: false,
    correlationId: requestCorrelationId
  });
}

async function invoke<Result>(
  requestCorrelationId: CorrelationId,
  operation: () => Promise<Result>
): Promise<Result> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    throw internalFailure(requestCorrelationId);
  }
}

async function preflight(
  dependencies: TextProcessingApplicationDependencies,
  requirement: TextCommand['requirement'],
  requestCorrelationId: CorrelationId,
  signal: AbortSignal | undefined
): Promise<void> {
  const manifest = await dependencies.capabilityProvider.getCapabilities(signal);
  assertCapabilities(requirement, manifest, requestCorrelationId);
}

async function readAndScan(
  dependencies: TextProcessingApplicationDependencies,
  command: TextCommand,
  requestCorrelationId: CorrelationId
): Promise<TextScanResult> {
  await preflight(dependencies, command.requirement, requestCorrelationId, command.signal);
  const artifact = await command.session.input(command.signal);
  const evidence = await dependencies.detector.detect(
    artifact.text,
    artifact.extractionRevision,
    command.signal
  );
  const resolution = resolveEvidence(
    evidence,
    artifact.extractionRevision,
    unicodeCodePointLength(artifact.text)
  );
  return {
    artifact,
    detectorBundleVersion: dependencies.detector.detectorBundleVersion,
    evidence,
    resolution,
    outcome: resolution.conflicts.length === 0 ? 'SUCCEEDED' : 'NEEDS_REVIEW'
  };
}

function unresolvedConflict(correlationId: CorrelationId, conflictCount: number): SafeError {
  return new SafeError({
    code: 'REDACTION_PLAN_CONFLICT',
    message: 'Overlapping detections require review before redaction.',
    retryable: false,
    correlationId,
    details: { conflictCount }
  });
}

function residualsBlocked(correlationId: CorrelationId, findingCount: number): SafeError {
  return new SafeError({
    code: 'VERIFICATION_RESIDUAL',
    message: 'Residual sensitive content blocked publication of the derived artifact.',
    retryable: false,
    correlationId,
    details: { findingCount }
  });
}

function stagedBytesChanged(correlationId: CorrelationId): SafeError {
  return new SafeError({
    code: 'STORAGE_UNAVAILABLE',
    message: 'The staged artifact changed before verification.',
    retryable: true,
    correlationId
  });
}

async function discardAfterFailure(
  command: RedactTextCommand,
  staged: Awaited<ReturnType<RedactTextCommand['session']['stage']>>,
  processingError: unknown,
  correlationId: CorrelationId
): Promise<void> {
  try {
    // Cleanup must remain possible after a caller has cancelled the work itself.
    await command.session.discard(staged);
  } catch {
    throw new SafeError({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The derived artifact could not be safely discarded after processing failed.',
      retryable: true,
      correlationId,
      details: {
        reason: `cleanup_failed_after_${processingError instanceof SafeError ? processingError.code : 'INTERNAL_ERROR'}`
      }
    });
  }
}

export function createTextProcessingApplication(
  dependencies: TextProcessingApplicationDependencies
): TextProcessingApplication {
  return Object.freeze({
    async getCapabilities(context: ApplicationContext, signal?: AbortSignal): Promise<CapabilityManifest> {
      const requestCorrelationId = correlationId(context);
      return invoke(requestCorrelationId, async () => {
        const manifest = await dependencies.capabilityProvider.getCapabilities(signal);
        assertCapabilityManifest(manifest, requestCorrelationId);
        return manifest;
      });
    },

    async inspect(command: TextCommand, context: ApplicationContext) {
      const requestCorrelationId = correlationId(context);
      return invoke(requestCorrelationId, async () => {
        await preflight(dependencies, command.requirement, requestCorrelationId, command.signal);
        return { artifact: await command.session.input(command.signal) };
      });
    },

    async scan(command: TextCommand, context: ApplicationContext) {
      const requestCorrelationId = correlationId(context);
      return invoke(requestCorrelationId, () => readAndScan(dependencies, command, requestCorrelationId));
    },

    async verify(command: TextCommand, context: ApplicationContext) {
      const requestCorrelationId = correlationId(context);
      return invoke(requestCorrelationId, async () => {
        await preflight(dependencies, command.requirement, requestCorrelationId, command.signal);
        const artifact = await command.session.input(command.signal);
        return {
          artifact,
          verification: await dependencies.verifier.verify(
            artifact.text,
            artifact.extractionRevision,
            command.signal
          )
        };
      });
    },

    async redact(command: RedactTextCommand, context: ApplicationContext) {
      const requestCorrelationId = correlationId(context);
      return invoke(requestCorrelationId, async () => {
        const scanned = await readAndScan(dependencies, command, requestCorrelationId);
        if (scanned.resolution.conflicts.length > 0) {
          throw unresolvedConflict(requestCorrelationId, scanned.resolution.conflicts.length);
        }

        const plan = compileTypedLabelPlan(scanned.resolution);
        const redactedText = applyTypedLabelPlan(scanned.artifact.text, plan);
        let staged: Awaited<ReturnType<RedactTextCommand['session']['stage']>> | undefined;
        try {
          staged = await command.session.stage(redactedText, command.signal);
          const reopened = await command.session.reopen(staged, command.signal);
          if (reopened.digest !== staged.digest || reopened.byteLength !== staged.byteLength) {
            throw stagedBytesChanged(requestCorrelationId);
          }
          const verification = await dependencies.verifier.verify(
            reopened.text,
            reopened.extractionRevision,
            command.signal
          );
          if (verification.outcome !== 'PASS') {
            throw residualsBlocked(requestCorrelationId, verification.findings.length);
          }
          const published = await command.session.publish(staged, command.signal);
          return {
            input: scanned.artifact,
            detectorBundleVersion: scanned.detectorBundleVersion,
            evidence: scanned.evidence,
            resolution: scanned.resolution,
            plan,
            verification,
            published
          };
        } catch (error: unknown) {
          if (staged !== undefined) {
            await discardAfterFailure(command, staged, error, requestCorrelationId);
          }
          throw error;
        }
      });
    }
  });
}
