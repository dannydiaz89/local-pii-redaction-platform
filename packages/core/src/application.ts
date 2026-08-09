import {
  SafeError,
  parseCorrelationId,
  type CorrelationId
} from '@local-pii/domain';

import { assertCapabilityManifest, assertCapabilities } from './preflight.js';
import type {
  ApplicationContext,
  CapabilityManifest,
  ExecuteRulesOnlyTextCommand,
  JobApplication,
  JobApplicationDependencies
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

export function createJobApplication<Request, Result>(
  dependencies: JobApplicationDependencies<Request, Result>
): JobApplication<Request, Result> {
  return Object.freeze({
    async getCapabilities(context: ApplicationContext): Promise<CapabilityManifest> {
      const requestCorrelationId = correlationId(context);
      return invoke(requestCorrelationId, async () => {
        const manifest = await dependencies.capabilityProvider.getCapabilities();
        assertCapabilityManifest(manifest, requestCorrelationId);
        return manifest;
      });
    },

    async executeRulesOnlyText(
      command: ExecuteRulesOnlyTextCommand<Request>,
      context: ApplicationContext
    ): Promise<Result> {
      const requestCorrelationId = correlationId(context);
      return invoke(requestCorrelationId, async () => {
        const manifest = await dependencies.capabilityProvider.getCapabilities();
        assertCapabilities(command.requirement, manifest, requestCorrelationId);
        return dependencies.rulesOnlyTextPipeline.execute(command.request, requestCorrelationId);
      });
    }
  });
}
