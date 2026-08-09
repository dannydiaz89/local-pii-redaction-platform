import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateContract } from '../packages/contracts/src/index.js';
import { SafeError } from '../packages/domain/src/index.js';

import {
  buildFastifySpike,
  fastifySpikeBodyLimit,
  fastifySpikeListenOptions,
  type CapabilityApplicationPort,
  type CapabilityManifest
} from './http-fastify-spike.js';
import { repositoryRoot } from './schema-utils.js';

const errorSchemaId = 'https://local-pii.dev/schemas/common/errors/1.0.0';
const servers: ReturnType<typeof buildFastifySpike>[] = [];

function capabilityManifest(): CapabilityManifest {
  const path = resolve(repositoryRoot, 'fixtures/contracts/valid/capability-rules-only-text.json');
  return JSON.parse(readFileSync(path, 'utf8')) as CapabilityManifest;
}

function application(value: unknown = capabilityManifest()): CapabilityApplicationPort {
  return {
    getCapabilities: () => Promise.resolve(value as CapabilityManifest)
  };
}

function server(port: CapabilityApplicationPort = application()): ReturnType<typeof buildFastifySpike> {
  const instance = buildFastifySpike(port);
  servers.push(instance);
  return instance;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

function expectCanonicalError(response: { readonly body: string }): void {
  const value: unknown = JSON.parse(response.body);
  expect(validateContract(errorSchemaId, value).valid).toBe(true);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (instance) => instance.close()));
});

describe('Fastify HTTP framework spike', () => {
  it('builds an unlistened app with bounded loopback startup settings', async () => {
    const instance = server();
    expect(instance.server.listening).toBe(false);
    expect(fastifySpikeListenOptions).toEqual({ host: '127.0.0.1', port: 0 });
    expect(instance.initialConfig).toMatchObject({
      bodyLimit: fastifySpikeBodyLimit,
      connectionTimeout: 5_000,
      requestTimeout: 5_000,
      keepAliveTimeout: 5_000,
      maxRequestsPerSocket: 100,
      onProtoPoisoning: 'error',
      onConstructorPoisoning: 'error'
    });

    const response = await instance.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('routes capabilities through the explicitly injected application port', async () => {
    const correlations: string[] = [];
    const instance = server({
      getCapabilities: (context) => {
        correlations.push(context.correlationId);
        return Promise.resolve(capabilityManifest());
      }
    });
    const response = await instance.inject({ method: 'GET', url: '/v1/capabilities' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(capabilityManifest());
    expect(correlations).toHaveLength(1);
    expect(correlations[0]).toMatch(/^cor_http_/u);
  });

  it('returns canonical non-reflective 404 envelopes for unknown routes and methods', async () => {
    const instance = server();
    const routeCanary = 'alpha%40example.test';
    const unknownRoute = await instance.inject({
      method: 'GET',
      url: `/not-found/${routeCanary}`
    });
    const unknownMethod = await instance.inject({
      method: 'DELETE',
      url: '/v1/capabilities'
    });

    for (const response of [unknownRoute, unknownMethod]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        error: {
          code: 'SCHEMA_INVALID',
          message: 'The requested resource is unavailable.',
          retryable: false
        }
      });
      expect(response.body).not.toContain(routeCanary);
      expect(response.body).not.toContain('DELETE');
      expect(response.body).not.toContain('/v1/capabilities');
      expectCanonicalError(response);
    }
  });

  it('ignores client correlation and forwarding canaries at the error boundary', async () => {
    const instance = server();
    const correlationCanary = 'client-correlation-alpha@example.test';
    const forwardingCanary = 'forwarded-for-alpha@example.test';
    const response = await instance.inject({
      method: 'GET',
      url: '/not-found',
      headers: {
        'x-request-id': correlationCanary,
        'x-correlation-id': correlationCanary,
        'x-forwarded-for': forwardingCanary,
        forwarded: `for=${forwardingCanary};host=attacker.invalid`,
        host: 'attacker.invalid'
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(correlationCanary);
    expect(response.body).not.toContain(forwardingCanary);
    expect(response.body).not.toContain('attacker.invalid');
    const envelope = JSON.parse(response.body) as { readonly error?: { readonly correlationId?: unknown } };
    const serverCorrelationId = envelope.error?.correlationId;
    if (typeof serverCorrelationId !== 'string') throw new Error('Expected a server correlation ID');
    expect(serverCorrelationId).toMatch(/^cor_http_req-/u);
    expectCanonicalError(response);
  });

  it('uses strict non-mutating canonical validation without coercion or field removal', async () => {
    const instance = server();
    const valid = capabilityManifest();
    const accepted = await instance.inject({
      method: 'POST',
      url: '/_spike/contracts/capabilities',
      headers: { 'content-type': 'application/json' },
      payload: valid
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual(valid);

    const coercible = structuredClone(valid);
    coercible.limits.maximumInputBytes = '104857600' as unknown as number;
    const rejectedCoercion = await instance.inject({
      method: 'POST',
      url: '/_spike/contracts/capabilities',
      headers: { 'content-type': 'application/json' },
      payload: coercible
    });
    expect(rejectedCoercion.statusCode).toBe(400);
    expectCanonicalError(rejectedCoercion);

    const unknownField = { ...valid, unexpected: 'must-not-be-removed' };
    const rejectedUnknown = await instance.inject({
      method: 'POST',
      url: '/_spike/contracts/capabilities',
      headers: { 'content-type': 'application/json' },
      payload: unknownField
    });
    expect(rejectedUnknown.statusCode).toBe(400);
    expect(rejectedUnknown.body).not.toContain('must-not-be-removed');
    expectCanonicalError(rejectedUnknown);
  });

  it('validates responses canonically and blocks extra fields without disclosing them', async () => {
    const leaked = 'alpha@example.test';
    const invalid = { ...capabilityManifest(), detectedValue: leaked };
    const response = await server(application(invalid)).inject({ method: 'GET', url: '/v1/capabilities' });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(leaked);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expectCanonicalError(response);
  });

  it('maps typed application failures to canonical privacy-safe error envelopes', async () => {
    const failure = new SafeError({
      code: 'MODEL_UNAVAILABLE',
      message: 'The required local model is unavailable.',
      retryable: true,
      correlationId: 'cor_fastify_spike_model'
    });
    const response = await server({ getCapabilities: () => Promise.reject(failure) })
      .inject({ method: 'GET', url: '/v1/capabilities' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: {
        code: 'MODEL_UNAVAILABLE',
        retryable: true,
        correlationId: 'cor_fastify_spike_model'
      }
    });
    expectCanonicalError(response);
  });

  it('returns canonical errors for malformed and oversized JSON bodies', async () => {
    const instance = server();
    const malformed = await instance.inject({
      method: 'POST',
      url: '/_spike/contracts/capabilities',
      headers: { 'content-type': 'application/json' },
      payload: '{'
    });
    expect(malformed.statusCode).toBe(400);
    expectCanonicalError(malformed);

    const oversized = await instance.inject({
      method: 'POST',
      url: '/_spike/contracts/capabilities',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(fastifySpikeBodyLimit + 1) })
    });
    expect(oversized.statusCode).toBe(413);
    expectCanonicalError(oversized);
  });

  it('maps unsupported content types to HTTP 415 without reflecting rejected values', async () => {
    const rejectedValue = 'alpha@example.test';
    const response = await server().inject({
      method: 'POST',
      url: '/_spike/contracts/capabilities',
      headers: { 'content-type': 'text/plain' },
      payload: rejectedValue
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({
      error: { code: 'FORMAT_UNSUPPORTED', retryable: false }
    });
    expect(response.body).not.toContain(rejectedValue);
    expectCanonicalError(response);
  });

  it('rejects prototype-pollution fields before canonical handling', async () => {
    const instance = server();
    const canonical = JSON.stringify(capabilityManifest());
    const payloads = [
      canonical.replace('{', '{"__proto__":{"polluted":true},'),
      canonical.replace('"limits":{', '"limits":{"__proto__":{"polluted":true},'),
      canonical.replace('{', '{"constructor":{"prototype":{"polluted":true}},')
    ];
    for (const payload of payloads) {
      const response = await instance.inject({
        method: 'POST',
        url: '/_spike/contracts/capabilities',
        headers: { 'content-type': 'application/json' },
        payload
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('polluted');
      expectCanonicalError(response);
    }
    expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('does not import Fastify anywhere under packages', () => {
    const imports = sourceFiles(resolve(repositoryRoot, 'packages')).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return /(?:from\s+|import\s*)['"]fastify(?:\/[^'"]*)?['"]/u.test(source) ? [path] : [];
    });
    expect(imports).toEqual([]);
  });

  it('binds to loopback on an ephemeral port and refuses new intake after clean close', async () => {
    const instance = server();
    await instance.listen({ ...fastifySpikeListenOptions });
    const address = instance.server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener address');
    expect(address.address).toBe('127.0.0.1');
    expect(address.port).toBeGreaterThan(0);

    const correlationCanary = 'live-client-correlation-alpha@example.test';
    const forwardingCanary = 'live-forwarded-alpha@example.test';
    const url = `http://127.0.0.1:${String(address.port)}`;
    const response = await fetch(`${url}/not-found`, {
      headers: {
        connection: 'close',
        'x-request-id': correlationCanary,
        'x-forwarded-for': forwardingCanary,
        forwarded: `for=${forwardingCanary};host=attacker.invalid`
      }
    });
    const body = await response.text();
    expect(response.status).toBe(404);
    expect(body).not.toContain(correlationCanary);
    expect(body).not.toContain(forwardingCanary);
    expect(body).not.toContain('attacker.invalid');

    await instance.close();
    expect(instance.server.listening).toBe(false);
    await expect(fetch(`${url}/health/live`, { headers: { connection: 'close' } })).rejects.toThrow();
  });
});
