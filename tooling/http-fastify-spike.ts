import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifySchemaValidationError
} from 'fastify';

import {
  validateContract,
  type CapabilitiesCapabilityManifestContract,
  type CommonErrorsContract
} from '../packages/contracts/src/index.js';
import { SafeError } from '../packages/domain/src/index.js';
import type { ApplicationContext } from '../packages/core/src/index.js';

import { loadSchemas, type JsonObject } from './schema-utils.js';

export type CapabilityManifest = CapabilitiesCapabilityManifestContract.CapabilityManifest;
type ErrorEnvelope = CommonErrorsContract.TypedErrorEnvelope;

export interface CapabilityApplicationPort {
  getCapabilities(context: ApplicationContext): Promise<CapabilityManifest>;
}

export const fastifySpikeBodyLimit = 16 * 1024;
export const fastifySpikeListenOptions = Object.freeze({ host: '127.0.0.1', port: 0 });

const capabilitySchemaId = 'https://local-pii.dev/schemas/capabilities/capability-manifest/1.0.0';
const errorSchemaId = 'https://local-pii.dev/schemas/common/errors/1.0.0';
const capabilitySchema = loadSchemas()
  .find(({ schema }) => schema.$id === capabilitySchemaId)?.schema;

if (capabilitySchema === undefined) throw new Error('Capability schema is unavailable');

function requestCorrelationId(request: FastifyRequest): string {
  return `cor_http_${request.id}`.slice(0, 128);
}

function validationErrors(schemaId: string, value: unknown): readonly FastifySchemaValidationError[] {
  const result = validateContract(schemaId, value);
  return result.errors.map((error) => ({
    keyword: error.keyword,
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    params: { ...error.params },
    ...(error.message === undefined ? {} : { message: error.message })
  }));
}

function sendCanonical(reply: FastifyReply, schemaId: string, value: unknown): FastifyReply {
  if (!validateContract(schemaId, value).valid) {
    throw new SafeError({
      code: 'INTERNAL_ERROR',
      message: 'The application produced an invalid response.',
      retryable: false,
      correlationId: requestCorrelationId(reply.request)
    });
  }
  return reply.send(value);
}

function safeError(error: unknown, correlationId: string): SafeError {
  if (error instanceof SafeError) return error;
  const statusCode = error instanceof Error && 'statusCode' in error
    ? (error as Error & { statusCode?: unknown }).statusCode
    : undefined;
  if (statusCode === 413) {
    return new SafeError({
      code: 'INPUT_TOO_LARGE',
      message: 'The request exceeds the configured byte limit.',
      retryable: false,
      correlationId
    });
  }
  if (statusCode === 415) {
    return new SafeError({
      code: 'FORMAT_UNSUPPORTED',
      message: 'The request content type is unsupported.',
      retryable: false,
      correlationId
    });
  }
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return new SafeError({
      code: 'SCHEMA_INVALID',
      message: 'The request is malformed or does not match its contract.',
      retryable: false,
      correlationId
    });
  }
  return new SafeError({
    code: 'INTERNAL_ERROR',
    message: 'The HTTP operation failed unexpectedly.',
    retryable: false,
    correlationId
  });
}

function statusFor(error: SafeError): number {
  if (error.code === 'INPUT_TOO_LARGE') return 413;
  if (error.code === 'FORMAT_UNSUPPORTED') return 415;
  if (error.code === 'POLICY_UNSATISFIABLE') return 422;
  if (error.code === 'AUTHORIZATION_DENIED') return 403;
  if (error.code === 'RATE_LIMITED') return 429;
  if (error.code === 'MODEL_UNAVAILABLE' || error.code === 'STORAGE_UNAVAILABLE') return 503;
  if (error.code === 'SCHEMA_INVALID' || error.code === 'CONTRACT_UNSUPPORTED') return 400;
  return 500;
}

function errorEnvelope(error: SafeError): ErrorEnvelope {
  return {
    schemaVersion: '1.0.0',
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      correlationId: error.correlationId,
      ...(error.details === undefined ? {} : { details: error.details })
    }
  };
}

function sendError(reply: FastifyReply, statusCode: number, error: SafeError): void {
  const envelope = errorEnvelope(error);
  if (!validateContract(errorSchemaId, envelope).valid) {
    reply.status(500).send({
      schemaVersion: '1.0.0',
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The HTTP error boundary failed.',
        retryable: false,
        correlationId: 'cor_http_error_boundary'
      }
    } satisfies ErrorEnvelope);
    return;
  }
  reply.status(statusCode).send(envelope);
}

function schemaId(schema: unknown): string {
  if (schema === null || typeof schema !== 'object' || !(('$id') in schema)) {
    throw new Error('The spike only accepts canonical schemas with an immutable $id');
  }
  const id = (schema as JsonObject).$id;
  if (typeof id !== 'string') throw new Error('Canonical schema $id must be a string');
  return id;
}

export function buildFastifySpike(application: CapabilityApplicationPort): FastifyInstance {
  const server = Fastify({
    logger: false,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false,
    bodyLimit: fastifySpikeBodyLimit,
    connectionTimeout: 5_000,
    requestTimeout: 5_000,
    keepAliveTimeout: 5_000,
    maxRequestsPerSocket: 100,
    requestIdHeader: false,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error'
  });

  server.setValidatorCompiler(({ schema }) => {
    const id = schemaId(schema);
    return (value: unknown) => {
      const errors = validationErrors(id, value);
      return errors.length === 0 ? { value } : { error: [...errors] };
    };
  });

  server.setErrorHandler((error, request, reply) => {
    const mapped = safeError(error, requestCorrelationId(request));
    sendError(reply, statusFor(mapped), mapped);
  });

  server.setNotFoundHandler((request, reply) => {
    sendError(reply, 404, new SafeError({
      code: 'SCHEMA_INVALID',
      message: 'The requested resource is unavailable.',
      retryable: false,
      correlationId: requestCorrelationId(request)
    }));
  });

  server.get('/health/live', (_request, reply) => reply.status(204).send());

  server.get('/v1/capabilities', async (request, reply) => {
    const manifest = await application.getCapabilities({
      correlationId: requestCorrelationId(request)
    });
    return sendCanonical(reply, capabilitySchemaId, manifest);
  });

  server.post<{ Body: CapabilityManifest }>(
    '/_spike/contracts/capabilities',
    {
      schema: { body: capabilitySchema },
      preValidation: (request, _reply, done) => {
        const mediaType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
        if (mediaType !== 'application/json') {
          done(new SafeError({
            code: 'FORMAT_UNSUPPORTED',
            message: 'The request content type is unsupported.',
            retryable: false,
            correlationId: requestCorrelationId(request)
          }));
          return;
        }
        done();
      }
    },
    (request, reply) => sendCanonical(reply, capabilitySchemaId, request.body)
  );

  return server;
}
