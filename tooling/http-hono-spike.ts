import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import { serve, type ServerType } from '@hono/node-server';
import { SafeError, type CorrelationId } from '../packages/domain/src/index.js';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import {
  validateContract,
  type CapabilitiesCapabilityManifestContract,
  type DetectionDetectRequestContract,
  type DetectionDetectResponseContract
} from '../packages/contracts/src/index.js';

const capabilityManifestSchemaId = 'https://local-pii.dev/schemas/capabilities/capability-manifest/1.0.0';
const detectRequestSchemaId = 'https://local-pii.dev/schemas/detection/detect-request/1.0.0';
const detectResponseSchemaId = 'https://local-pii.dev/schemas/detection/detect-response/1.0.0';
const errorEnvelopeSchemaId = 'https://local-pii.dev/schemas/common/errors/1.0.0';
const errorEnvelopeV2SchemaId = 'https://local-pii.dev/schemas/common/errors/2.0.0';
const errorEnvelopeV3SchemaId = 'https://local-pii.dev/schemas/common/errors/3.0.0';
const fallbackCorrelationId = 'cor_http_error_boundary';

export const defaultHonoSpikeMaximumBodyBytes = 16_384;
export const honoSpikeListenOptions = Object.freeze({ hostname: '127.0.0.1' as const, port: 0 });

type CapabilityManifest = CapabilitiesCapabilityManifestContract.CapabilityManifest;
type DetectRequest = DetectionDetectRequestContract.InferenceDetectRequest;
type DetectResponse = DetectionDetectResponseContract.InferenceDetectResponse;

export interface HonoCapabilityApplicationPort {
  getCapabilities(context: { readonly correlationId: CorrelationId }): Promise<unknown>;
}

export interface HonoDetectionApplicationPort {
  detect(request: DetectRequest, context: { readonly correlationId: CorrelationId }): Promise<unknown>;
}

export interface HonoHttpSpikeDependencies {
  readonly capabilities: HonoCapabilityApplicationPort;
  readonly detection?: HonoDetectionApplicationPort;
  readonly maximumBodyBytes?: number;
}

export interface HonoSpikeServerOptions {
  readonly hostname?: '127.0.0.1';
  readonly port?: number;
}

export interface RunningHonoSpikeServer {
  readonly server: ServerType;
  readonly hostname: '127.0.0.1';
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

interface HonoSpikeVariables {
  correlationId: CorrelationId;
}

type HonoSpikeEnvironment = { Variables: HonoSpikeVariables };

function serverCorrelationId(): CorrelationId {
  return `cor_http_${randomUUID()}` as CorrelationId;
}

function internalError(correlationId: string): SafeError {
  return new SafeError({
    code: 'INTERNAL_ERROR',
    message: 'The HTTP operation failed unexpectedly.',
    retryable: false,
    correlationId
  });
}

function schemaError(correlationId: string): SafeError {
  return new SafeError({
    code: 'SCHEMA_INVALID',
    message: 'The request does not match the required contract.',
    retryable: false,
    correlationId
  });
}

function formatError(correlationId: string): SafeError {
  return new SafeError({
    code: 'FORMAT_UNSUPPORTED',
    message: 'The request content type is unsupported.',
    retryable: false,
    correlationId
  });
}

function assertResponseContract(schemaId: string, value: unknown, correlationId: string): void {
  if (!validateContract(schemaId, value).valid) throw internalError(correlationId);
}

function statusForError(error: SafeError): ContentfulStatusCode {
  if (error.code === 'OPERATION_CANCELLED') return 408;
  if (error.code === 'SCHEMA_INVALID') return 400;
  if (error.code === 'INPUT_TOO_LARGE') return 413;
  if (error.code === 'FORMAT_UNSUPPORTED') return 415;
  if (error.code === 'CONTRACT_UNSUPPORTED') return 400;
  if (error.code === 'MODEL_UNAVAILABLE' || error.code === 'STORAGE_UNAVAILABLE') return 503;
  if (error.code === 'INTERNAL_ERROR') return 500;
  return 422;
}

function safeErrorEnvelope(error: SafeError): object {
  const schemaVersion = error.code === 'OPERATION_CANCELLED'
    ? '3.0.0'
    : error.code === 'ARTIFACT_DIGEST_MISMATCH'
      ? '2.0.0'
      : '1.0.0';
  const schemaId = schemaVersion === '3.0.0'
    ? errorEnvelopeV3SchemaId
    : schemaVersion === '2.0.0'
      ? errorEnvelopeV2SchemaId
      : errorEnvelopeSchemaId;
  const envelope = {
    schemaVersion,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      correlationId: error.correlationId,
      ...(error.details === undefined ? {} : { details: error.details })
    }
  };
  if (validateContract(schemaId, envelope).valid) return envelope;
  return {
    schemaVersion: '1.0.0',
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The HTTP operation failed unexpectedly.',
      retryable: false,
      correlationId: fallbackCorrelationId
    }
  };
}

function maximumBodyBytes(value: number | undefined): number {
  const resolved = value ?? defaultHonoSpikeMaximumBodyBytes;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 1_048_576) {
    throw new TypeError('The Hono spike body limit must be an integer from 1 through 1048576 bytes.');
  }
  return resolved;
}

async function readBoundedJson(request: Request, limit: number, correlationId: string): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw formatError(correlationId);

  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) throw schemaError(correlationId);
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length)) throw schemaError(correlationId);
    if (length > limit) {
      throw new SafeError({
        code: 'INPUT_TOO_LARGE',
        message: 'The request body exceeds the HTTP spike byte limit.',
        retryable: false,
        correlationId,
        details: { maximumInputBytes: limit, actualInputBytes: length }
      });
    }
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) {
    throw new SafeError({
      code: 'INPUT_TOO_LARGE',
      message: 'The request body exceeds the HTTP spike byte limit.',
      retryable: false,
      correlationId,
      details: { maximumInputBytes: limit, actualInputBytes: bytes.byteLength }
    });
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw schemaError(correlationId);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw schemaError(correlationId);
  }
}

export function createHonoHttpSpike(dependencies: HonoHttpSpikeDependencies): Hono<HonoSpikeEnvironment> {
  const bodyByteLimit = maximumBodyBytes(dependencies.maximumBodyBytes);
  const app = new Hono<HonoSpikeEnvironment>();

  app.use('*', async (context, next) => {
    // Client-supplied request identifiers are deliberately ignored at this trust boundary.
    context.set('correlationId', serverCorrelationId());
    await next();
  });

  app.onError((error, context) => {
    const safeError = error instanceof SafeError
      ? error
      : internalError(context.get('correlationId'));
    return context.json(safeErrorEnvelope(safeError), statusForError(safeError), {
      'cache-control': 'no-store'
    });
  });

  app.get('/health/live', (context) => context.body(null, 204));

  app.get('/v1/capabilities', async (context) => {
    const correlationId = context.get('correlationId');
    const response = await dependencies.capabilities.getCapabilities({ correlationId });
    assertResponseContract(capabilityManifestSchemaId, response, correlationId);
    return context.json(response as CapabilityManifest, 200, { 'cache-control': 'no-store' });
  });

  const boundedBody = bodyLimit({
    maxSize: bodyByteLimit,
    onError: (context): Response => {
      const correlationId = (context as Context<HonoSpikeEnvironment>).get('correlationId');
      throw new SafeError({
        code: 'INPUT_TOO_LARGE',
        message: 'The request body exceeds the HTTP spike byte limit.',
        retryable: false,
        correlationId,
        details: { maximumInputBytes: bodyByteLimit }
      });
    }
  });

  app.post('/_spike/contracts/capabilities', boundedBody, async (context) => {
    const correlationId = context.get('correlationId');
    const value = await readBoundedJson(context.req.raw, bodyByteLimit, correlationId);
    if (!validateContract(capabilityManifestSchemaId, value).valid) throw schemaError(correlationId);
    assertResponseContract(capabilityManifestSchemaId, value, correlationId);
    return context.json(value as CapabilityManifest, 200, { 'cache-control': 'no-store' });
  });

  const detection = dependencies.detection;
  if (detection !== undefined) {
    app.post(
      '/v1/detect',
      boundedBody,
      async (context) => {
        const correlationId = context.get('correlationId');
        const value = await readBoundedJson(context.req.raw, bodyByteLimit, correlationId);
        if (!validateContract(detectRequestSchemaId, value).valid) throw schemaError(correlationId);
        const request = value as DetectRequest;
        const response = await detection.detect(request, { correlationId });
        assertResponseContract(detectResponseSchemaId, response, correlationId);
        return context.json(response as DetectResponse, 200, { 'cache-control': 'no-store' });
      }
    );
  }

  app.notFound((context) => {
    const error = new SafeError({
      code: 'SCHEMA_INVALID',
      message: 'The requested route is unavailable.',
      retryable: false,
      correlationId: context.get('correlationId')
    });
    return context.json(safeErrorEnvelope(error), 404, { 'cache-control': 'no-store' });
  });

  return app;
}

function resolvedServerOptions(options: HonoSpikeServerOptions): Required<HonoSpikeServerOptions> {
  const candidateHostname: unknown = options.hostname ?? honoSpikeListenOptions.hostname;
  const port = options.port ?? honoSpikeListenOptions.port;
  if (candidateHostname !== '127.0.0.1') throw new TypeError('The Hono spike may listen only on IPv4 loopback.');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('The Hono spike port must be an integer from 0 through 65535.');
  }
  return { hostname: candidateHostname, port };
}

export async function startHonoHttpSpikeServer(
  dependencies: HonoHttpSpikeDependencies,
  options: HonoSpikeServerOptions = {}
): Promise<RunningHonoSpikeServer> {
  const { hostname, port } = resolvedServerOptions(options);
  const app = createHonoHttpSpike(dependencies);
  const server = serve({ fetch: app.fetch, hostname, port });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
    });
    throw new Error('The Hono spike did not bind to an IP socket.');
  }
  const bound = address;
  return {
    server,
    hostname,
    port: bound.port,
    url: `http://${hostname}:${String(bound.port)}`,
    close: async () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error); });
    })
  };
}
