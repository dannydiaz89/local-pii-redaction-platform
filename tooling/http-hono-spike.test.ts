import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { validateContract } from '../packages/contracts/src/index.js';
import { SafeError } from '../packages/domain/src/index.js';
import {
  createHonoHttpSpike,
  defaultHonoSpikeMaximumBodyBytes,
  honoSpikeListenOptions,
  startHonoHttpSpikeServer,
  type HonoCapabilityApplicationPort,
  type HonoDetectionApplicationPort
} from './http-hono-spike.js';

const capabilitySchemaId = 'https://local-pii.dev/schemas/capabilities/capability-manifest/1.0.0';
const detectResponseSchemaId = 'https://local-pii.dev/schemas/detection/detect-response/1.0.0';
const errorSchemaId = 'https://local-pii.dev/schemas/common/errors/1.0.0';
const clientCorrelationId = 'cor_client_must_not_be_trusted';

function validCapabilities(): object {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/contracts/valid/capability-rules-only-text.json'), 'utf8')) as object;
}

function validRequest(): object {
  return {
    schemaVersion: '1.0.0',
    requestId: 'd9b8a330-8d9a-4f6f-8f11-5b2f10e53967',
    chunks: [{ id: 'chunk-0001', text: 'Synthetic Person', absoluteStart: 0, language: 'en' }],
    entityTypes: ['PERSON'],
    minimumConfidence: 0.55,
    options: { maxDetectionsPerChunk: 20 }
  };
}

function validResponse(): object {
  return {
    schemaVersion: '1.0.0',
    requestId: 'd9b8a330-8d9a-4f6f-8f11-5b2f10e53967',
    detections: [{
      chunkId: 'chunk-0001',
      entityType: 'PERSON',
      start: 0,
      end: 16,
      confidence: 0.97,
      detector: { id: 'synthetic-contextual', version: '0.1.0' }
    }],
    model: {
      id: 'synthetic-contextual',
      version: '0.1.0',
      digest: `sha256:${'a'.repeat(64)}`,
      runtime: 'test-double'
    },
    warnings: []
  };
}

function ports(overrides: {
  readonly capabilities?: HonoCapabilityApplicationPort['getCapabilities'];
  readonly detect?: HonoDetectionApplicationPort['detect'];
} = {}): {
  readonly capabilities: HonoCapabilityApplicationPort;
  readonly detection: HonoDetectionApplicationPort;
} {
  return {
    capabilities: { getCapabilities: overrides.capabilities ?? (() => Promise.resolve(validCapabilities())) },
    detection: { detect: overrides.detect ?? (() => Promise.resolve(validResponse())) }
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function request(body: string | object, headers: Readonly<Record<string, string>> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': clientCorrelationId, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  };
}

function expectServerCorrelation(value: Record<string, unknown>): void {
  const error = value.error as Record<string, unknown> | undefined;
  expect(error?.correlationId).toMatch(/^cor_http_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  expect(error?.correlationId).not.toBe(clientCorrelationId);
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('Hono HTTP framework spike', () => {
  it('provides liveness and delegates capabilities through the injected application port', async () => {
    const getCapabilities = vi.fn((context: { readonly correlationId: string }) => {
      void context;
      return Promise.resolve(validCapabilities());
    });
    const app = createHonoHttpSpike(ports({ capabilities: getCapabilities }));

    expect((await app.request('/health/live')).status).toBe(204);
    const response = await app.request('/v1/capabilities', { headers: { 'x-correlation-id': clientCorrelationId } });
    expect(response.status).toBe(200);
    const value = await json(response);
    expect(validateContract(capabilitySchemaId, value).valid).toBe(true);
    const applicationCorrelationId = getCapabilities.mock.calls[0]?.[0].correlationId;
    expect(applicationCorrelationId).toMatch(/^cor_http_/u);
    expect(applicationCorrelationId).not.toBe(clientCorrelationId);
  });

  it('round-trips canonical capabilities without coercion or unknown-field removal', async () => {
    const app = createHonoHttpSpike(ports());
    const canonical = validCapabilities();
    const accepted = await app.request('/_spike/contracts/capabilities', request(canonical));
    expect(accepted.status).toBe(200);
    expect(await json(accepted)).toEqual(canonical);

    const coercible = structuredClone(canonical) as { limits: { maximumInputBytes: unknown } };
    coercible.limits.maximumInputBytes = '104857600';
    const rejectedCoercion = await app.request('/_spike/contracts/capabilities', request(coercible));
    expect(rejectedCoercion.status).toBe(400);
    const coercionError = await json(rejectedCoercion);
    expect(validateContract(errorSchemaId, coercionError).valid).toBe(true);
    expectServerCorrelation(coercionError);

    const rejectedValue = 'must-not-be-reflected';
    const rejectedUnknown = await app.request('/_spike/contracts/capabilities', request({ ...canonical, unexpected: rejectedValue }));
    expect(rejectedUnknown.status).toBe(400);
    const unknownSerialized = JSON.stringify(await json(rejectedUnknown));
    expect(unknownSerialized).not.toContain(rejectedValue);
  });

  it('validates a bounded canonical detect request and response', async () => {
    const detect = vi.fn((detectedRequest: unknown, context: { readonly correlationId: string }) => {
      void detectedRequest;
      void context;
      return Promise.resolve(validResponse());
    });
    const app = createHonoHttpSpike(ports({ detect }));
    const response = await app.request('/v1/detect', request(validRequest()));

    expect(response.status).toBe(200);
    const value = await json(response);
    expect(validateContract(detectResponseSchemaId, value).valid).toBe(true);
    expect(detect.mock.calls[0]?.[0]).toEqual(validRequest());
    expect(detect.mock.calls[0]?.[1].correlationId).toMatch(/^cor_http_/u);
    expect(detect.mock.calls[0]?.[1].correlationId).not.toBe(clientCorrelationId);
  });

  it.each([
    ['coerced confidence', { ...validRequest(), minimumConfidence: '0.55' }],
    ['extra top-level field', { ...validRequest(), planted: true }],
    ['extra nested field', { ...validRequest(), options: { maxDetectionsPerChunk: 20, planted: true } }]
  ])('rejects a contract-invalid request without coercion: %s', async (_name, body) => {
    const detect = vi.fn(() => Promise.resolve(validResponse()));
    const app = createHonoHttpSpike(ports({ detect }));
    const response = await app.request('/v1/detect', request(body));

    expect(response.status).toBe(400);
    expect(detect).not.toHaveBeenCalled();
    expect(validateContract(errorSchemaId, await json(response)).valid).toBe(true);
  });

  it('rejects prototype-pollution fields without mutating object prototypes', async () => {
    const app = createHonoHttpSpike(ports());
    const canonical = JSON.stringify(validCapabilities());
    const payloads = [
      canonical.replace('{', '{"__proto__":{"polluted":true},'),
      canonical.replace('"limits":{', '"limits":{"__proto__":{"polluted":true},'),
      canonical.replace('{', '{"constructor":{"prototype":{"polluted":true}},')
    ];
    for (const body of payloads) {
      const response = await app.request('/_spike/contracts/capabilities', request(body));
      expect(response.status).toBe(400);
      const envelope = await json(response);
      expect(JSON.stringify(envelope)).not.toContain('polluted');
      expect(validateContract(errorSchemaId, envelope).valid).toBe(true);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('returns safe typed errors for malformed and oversized bodies', async () => {
    const app = createHonoHttpSpike({ ...ports(), maximumBodyBytes: 512 });
    const malformed = await app.request('/v1/detect', request('{"schemaVersion":'));
    expect(malformed.status).toBe(400);
    const malformedEnvelope = await json(malformed);
    expect(malformedEnvelope).toMatchObject({ error: { code: 'SCHEMA_INVALID' } });
    expectServerCorrelation(malformedEnvelope);

    const oversized = await app.request('/v1/detect', request(`{"padding":"${'x'.repeat(600)}"}`));
    expect(oversized.status).toBe(413);
    const envelope = await json(oversized);
    expect(envelope).toMatchObject({ error: { code: 'INPUT_TOO_LARGE' } });
    expectServerCorrelation(envelope);
    expect(validateContract(errorSchemaId, envelope).valid).toBe(true);
  });

  it('stops an oversized streamed body without relying on Content-Length', async () => {
    const app = createHonoHttpSpike({ ...ports(), maximumBodyBytes: 512 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"padding":"'));
        controller.enqueue(new TextEncoder().encode('x'.repeat(600)));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      }
    });
    const streamedRequest = new Request('http://localhost/v1/detect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': clientCorrelationId },
      body: stream,
      duplex: 'half'
    } as RequestInit & { duplex: 'half' });
    expect(streamedRequest.headers.has('content-length')).toBe(false);

    const response = await app.request(streamedRequest);
    const envelope = await json(response);
    expect(response.status).toBe(413);
    expect(envelope).toMatchObject({ error: { code: 'INPUT_TOO_LARGE' } });
    expectServerCorrelation(envelope);
    expect(validateContract(errorSchemaId, envelope).valid).toBe(true);
  });

  it('preserves safe application errors and maps unexpected failures without leaking their messages', async () => {
    const unavailable = createHonoHttpSpike(ports({ detect: () => Promise.reject(new SafeError({
        code: 'MODEL_UNAVAILABLE',
        message: 'The local contextual model is unavailable.',
        retryable: true,
        correlationId: 'cor_application_model_unavailable'
      })) }));
    const unavailableResponse = await unavailable.request('/v1/detect', request(validRequest()));
    expect(unavailableResponse.status).toBe(503);
    expect(await json(unavailableResponse)).toMatchObject({ error: { code: 'MODEL_UNAVAILABLE', retryable: true } });

    const unexpected = createHonoHttpSpike(ports({
      detect: () => Promise.reject(new Error('private/synthetic/path and planted document excerpt'))
    }));
    const unexpectedResponse = await unexpected.request('/v1/detect', request(validRequest()));
    const serialized = JSON.stringify(await json(unexpectedResponse));
    expect(unexpectedResponse.status).toBe(500);
    expect(serialized).toContain('INTERNAL_ERROR');
    expect(serialized).not.toContain('private/synthetic/path');
    expect(serialized).not.toContain('planted document excerpt');
  });

  it('blocks contract-invalid application responses instead of serializing planted fields', async () => {
    const invalidCapabilities = createHonoHttpSpike(ports({
      capabilities: () => Promise.resolve({ ...validCapabilities(), planted: true })
    }));
    const capabilityResponse = await invalidCapabilities.request('/v1/capabilities', { headers: { 'x-correlation-id': clientCorrelationId } });
    expect(capabilityResponse.status).toBe(500);
    expect(JSON.stringify(await json(capabilityResponse))).not.toContain('planted');

    const invalidDetection = createHonoHttpSpike(ports({
      detect: () => Promise.resolve({ ...validResponse(), planted: true })
    }));
    const detectionResponse = await invalidDetection.request('/v1/detect', request(validRequest()));
    expect(detectionResponse.status).toBe(500);
    expect(JSON.stringify(await json(detectionResponse))).not.toContain('planted');
  });

  it.each([
    ['missing', undefined],
    ['wrong', 'text/plain']
  ])('maps %s content type to a canonical non-reflecting 415', async (_name, contentType) => {
    const rejectedValue = 'alpha@example.test';
    const headers: Record<string, string> = { 'x-correlation-id': clientCorrelationId };
    if (contentType !== undefined) headers['content-type'] = contentType;
    const response = await createHonoHttpSpike(ports()).request('/_spike/contracts/capabilities', {
      method: 'POST',
      headers,
      body: new TextEncoder().encode(rejectedValue)
    });
    const envelope = await json(response);
    expect(response.status).toBe(415);
    expect(envelope).toMatchObject({ error: { code: 'FORMAT_UNSUPPORTED', retryable: false } });
    expect(JSON.stringify(envelope)).not.toContain(rejectedValue);
    expectServerCorrelation(envelope);
    expect(validateContract(errorSchemaId, envelope).valid).toBe(true);
  });

  it('returns a canonical non-reflecting not-found response', async () => {
    const plantedPath = '/missing/alpha@example.test';
    const response = await createHonoHttpSpike(ports()).request(plantedPath, {
      headers: { 'x-correlation-id': clientCorrelationId }
    });
    const envelope = await json(response);
    expect(response.status).toBe(404);
    expect(JSON.stringify(envelope)).not.toContain(plantedPath);
    expect(JSON.stringify(envelope)).not.toContain('alpha@example.test');
    expectServerCorrelation(envelope);
    expect(validateContract(errorSchemaId, envelope).valid).toBe(true);
  });

  it('binds only to loopback with the exported startup helper and closes cleanly', async () => {
    expect(defaultHonoSpikeMaximumBodyBytes).toBe(16_384);
    expect(honoSpikeListenOptions).toEqual({ hostname: '127.0.0.1', port: 0 });
    const running = await startHonoHttpSpikeServer(ports());
    try {
      expect(running.hostname).toBe('127.0.0.1');
      expect(running.port).toBeGreaterThan(0);
      const response = await fetch(`${running.url}/health/live`);
      expect(response.status).toBe(204);
      expect(running.server.listening).toBe(true);
    } finally {
      await running.close();
    }
    expect(running.server.listening).toBe(false);
  });

  it('keeps all Hono framework imports outside workspace packages', () => {
    const packages = resolve(import.meta.dirname, '../packages');
    const violations = sourceFiles(packages).filter((path) => /from\s+['"](?:hono|@hono\/)/u.test(readFileSync(path, 'utf8')));
    expect(violations).toEqual([]);
  });
});
