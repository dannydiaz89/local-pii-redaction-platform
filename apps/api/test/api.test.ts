import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateContract } from '@local-pii/contracts';
import { SafeError } from '@local-pii/domain';

import {
  apiDefaultHandlerTimeoutMs,
  apiMaximumBodyBytes,
  buildApi,
  generateLocalSessionToken,
  localApiHostname,
  startLocalApi,
  type ApiDependencies,
  type CapabilityManifest
} from '../src/index.js';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const errorSchemaId = 'https://local-pii.dev/schemas/common/errors/1.0.0';
const sessionToken = 'A'.repeat(43);
const allowedOrigin = 'http://127.0.0.1:4173';
const loopbackHost = '127.0.0.1';
const servers: ReturnType<typeof buildApi>[] = [];

function capabilityManifest(): CapabilityManifest {
  return JSON.parse(readFileSync(
    resolve(repositoryRoot, 'fixtures/contracts/valid/capability-rules-only-text.json'),
    'utf8'
  )) as CapabilityManifest;
}

function dependencies(overrides: Partial<ApiDependencies> = {}): ApiDependencies {
  return {
    application: { getCapabilities: () => Promise.resolve(capabilityManifest()) },
    readiness: { check: () => Promise.resolve() },
    ...overrides
  };
}

function server(
  deps: ApiDependencies = dependencies(),
  options: Parameters<typeof buildApi>[1] = {
    session: { bearerToken: sessionToken, allowedOrigins: [allowedOrigin] }
  }
): ReturnType<typeof buildApi> {
  const instance = buildApi(deps, options);
  servers.push(instance);
  return instance;
}

function authorization(token = sessionToken): Readonly<Record<string, string>> {
  return { host: loopbackHost, authorization: `Bearer ${token}` };
}

function expectCanonicalError(response: { readonly body: string }): void {
  expect(validateContract(errorSchemaId, JSON.parse(response.body) as unknown).valid).toBe(true);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (instance) => instance.close()));
});

describe('local API composition', () => {
  it('builds unlistened with bounded parser, connection, request, and shutdown settings', async () => {
    const instance = server();

    expect(instance.server.listening).toBe(false);
    expect(apiMaximumBodyBytes).toBe(16_384);
    expect(apiDefaultHandlerTimeoutMs).toBe(5_000);
    expect(instance.initialConfig).toMatchObject({
      bodyLimit: apiMaximumBodyBytes,
      connectionTimeout: 5_000,
      requestTimeout: 5_000,
      keepAliveTimeout: 5_000,
      maxRequestsPerSocket: 100,
      onProtoPoisoning: 'error',
      onConstructorPoisoning: 'error',
      forceCloseConnections: true
    });

    const liveness = await instance.inject({
      method: 'GET', url: '/health/live', headers: { host: loopbackHost }
    });
    expect(liveness.statusCode).toBe(204);
    expect(liveness.body).toBe('');
    expect(liveness.headers['cache-control']).toBe('no-store');
    expect(liveness.headers['x-content-type-options']).toBe('nosniff');
  });

  it('creates independent 256-bit per-launch session tokens', () => {
    const first = generateLocalSessionToken();
    const second = generateLocalSessionToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toBe(second);
  });

  it('rejects weak tokens and non-numeric or non-exact browser origins at composition', () => {
    expect(() => buildApi(dependencies(), { session: { bearerToken: 'weak' } })).toThrow(TypeError);
    for (const origin of [
      'http://localhost:4173',
      'https://127.0.0.1:4173',
      'http://127.0.0.1:4173/path',
      'http://user@127.0.0.1:4173'
    ]) {
      expect(() => buildApi(dependencies(), {
        session: { bearerToken: sessionToken, allowedOrigins: [origin] }
      })).toThrow(TypeError);
    }
  });

  it('requires the exact bearer secret without reflecting missing or rejected credentials', async () => {
    const instance = server();
    const rejectedToken = 'B'.repeat(43);
    const responses = await Promise.all([
      instance.inject({
        method: 'GET', url: '/v1/capabilities', headers: { host: loopbackHost }
      }),
      instance.inject({
        method: 'GET',
        url: '/v1/capabilities',
        headers: authorization(rejectedToken)
      }),
      instance.inject({
        method: 'GET',
        url: '/v1/capabilities',
        headers: { host: loopbackHost, authorization: `Basic ${rejectedToken}` }
      })
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'AUTHORIZATION_DENIED' } });
      expect(response.body).not.toContain(rejectedToken);
      expectCanonicalError(response);
    }
  });

  it('routes readiness and capabilities through bounded explicitly injected ports', async () => {
    const correlations: string[] = [];
    const signals: AbortSignal[] = [];
    const instance = server(dependencies({
      application: {
        getCapabilities(context, signal) {
          correlations.push(context.correlationId);
          if (signal !== undefined) signals.push(signal);
          return Promise.resolve(capabilityManifest());
        }
      },
      readiness: {
        check(signal) {
          if (signal !== undefined) signals.push(signal);
          return Promise.resolve();
        }
      }
    }));

    const ready = await instance.inject({
      method: 'GET',
      url: '/health/ready',
      headers: { host: loopbackHost }
    });
    const capabilities = await instance.inject({
      method: 'GET',
      url: '/v1/capabilities',
      headers: authorization()
    });

    expect(ready.statusCode).toBe(204);
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toEqual(capabilityManifest());
    expect(correlations).toHaveLength(1);
    expect(correlations[0]).toMatch(/^cor_http_/u);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });

  it('maps readiness failures to a canonical 503 without exposing exceptions', async () => {
    const plantedPath = '/private/tmp/alpha@example.test';
    const instance = server(dependencies({
      readiness: { check: () => Promise.reject(new Error(plantedPath)) }
    }));
    const response = await instance.inject({
      method: 'GET',
      url: '/health/ready',
      headers: authorization()
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR', retryable: true } });
    expect(response.body).not.toContain(plantedPath);
    expect(response.body).not.toContain('alpha@example.test');
    expectCanonicalError(response);
  });

  it('validates capability responses canonically and blocks unexpected fields', async () => {
    const plantedValue = 'alpha@example.test';
    const invalid = { ...capabilityManifest(), unexpected: plantedValue };
    const instance = server(dependencies({
      application: { getCapabilities: () => Promise.resolve(invalid as CapabilityManifest) }
    }));
    const response = await instance.inject({
      method: 'GET',
      url: '/v1/capabilities',
      headers: authorization()
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(response.body).not.toContain(plantedValue);
    expectCanonicalError(response);
  });

  it('preserves canonical application failures while suppressing raw exceptions', async () => {
    const expected = new SafeError({
      code: 'MODEL_UNAVAILABLE',
      message: 'The required local model is unavailable.',
      retryable: true,
      correlationId: 'cor_api_model'
    });
    const canonical = server(dependencies({
      application: { getCapabilities: () => Promise.reject(expected) }
    }));
    const unexpected = server(dependencies({
      application: { getCapabilities: () => Promise.reject(new Error('/private/tmp/alpha@example.test')) }
    }));

    const canonicalResponse = await canonical.inject({
      method: 'GET', url: '/v1/capabilities', headers: authorization()
    });
    const unexpectedResponse = await unexpected.inject({
      method: 'GET', url: '/v1/capabilities', headers: authorization()
    });

    expect(canonicalResponse.statusCode).toBe(503);
    expect(canonicalResponse.json()).toMatchObject({
      error: { code: 'MODEL_UNAVAILABLE', correlationId: 'cor_api_model' }
    });
    expect(unexpectedResponse.statusCode).toBe(500);
    expect(unexpectedResponse.body).not.toContain('/private/tmp');
    expect(unexpectedResponse.body).not.toContain('alpha@example.test');
    expectCanonicalError(canonicalResponse);
    expectCanonicalError(unexpectedResponse);
  });

  it('enforces exact browser origins and emits narrowly scoped CORS headers', async () => {
    const instance = server();
    const allowed = await instance.inject({
      method: 'GET',
      url: '/v1/capabilities',
      headers: { ...authorization(), origin: allowedOrigin }
    });
    const rejectedOrigin = 'http://127.0.0.1:5173';
    const rejected = await instance.inject({
      method: 'GET',
      url: '/v1/capabilities',
      headers: { ...authorization(), origin: rejectedOrigin }
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(allowed.headers['access-control-allow-origin']).not.toBe('*');
    expect(allowed.headers.vary).toBe('Origin');
    expect(rejected.statusCode).toBe(403);
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
    expect(rejected.body).not.toContain(rejectedOrigin);
    expectCanonicalError(rejected);
  });

  it('allows only bounded authorized browser preflights without exposing the bearer token', async () => {
    const instance = server();
    const accepted = await instance.inject({
      method: 'OPTIONS',
      url: '/v1/capabilities',
      headers: {
        host: loopbackHost,
        origin: allowedOrigin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, content-type'
      }
    });
    const rejected = await instance.inject({
      method: 'OPTIONS',
      url: '/v1/capabilities',
      headers: {
        host: loopbackHost,
        origin: allowedOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-alpha-canary'
      }
    });

    expect(accepted.statusCode).toBe(204);
    expect(accepted.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(accepted.headers['access-control-allow-methods']).toBe('GET, OPTIONS');
    expect(accepted.headers['access-control-allow-headers']).toBe('authorization, content-type');
    expect(accepted.body).not.toContain(sessionToken);
    expect(rejected.statusCode).toBe(403);
    expect(rejected.body).not.toContain('x-alpha-canary');
    expectCanonicalError(rejected);
  });

  it('aborts a capability port and fails canonically when the handler deadline expires', async () => {
    let observedSignal: AbortSignal | undefined;
    const instance = server(dependencies({
      application: {
        getCapabilities(_context, signal) {
          observedSignal = signal;
          return new Promise<CapabilityManifest>(() => undefined);
        }
      }
    }), {
      session: { bearerToken: sessionToken },
      handlerTimeoutMs: 100
    });
    const response = await instance.inject({
      method: 'GET', url: '/v1/capabilities', headers: authorization()
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR', details: { deadlineExceeded: true } }
    });
    expect(observedSignal?.aborted).toBe(true);
    expectCanonicalError(response);
  });

  it('rejects hostile Host authority before routing without reflecting authority or credentials', async () => {
    const canary = 'client-alpha@example.test';
    const tokenCanary = 'B'.repeat(43);
    const response = await server().inject({
      method: 'GET',
      url: '/health/live',
      headers: {
        authorization: `Bearer ${tokenCanary}`,
        'x-request-id': canary,
        host: 'attacker.invalid'
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(canary);
    expect(response.body).not.toContain('attacker.invalid');
    expect(response.body).not.toContain(tokenCanary);
    expectCanonicalError(response);
  });

  it('does not trust client correlation or forwarding metadata at authenticated errors', async () => {
    const canary = 'client-alpha@example.test';
    const response = await server().inject({
      method: 'GET',
      url: '/not-found',
      headers: {
        ...authorization(),
        'x-request-id': canary,
        'x-correlation-id': canary,
        'x-forwarded-for': canary,
        forwarded: `for=${canary};host=attacker.invalid`
      }
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(canary);
    expect(response.body).not.toContain('attacker.invalid');
    const envelope = response.json<{ readonly error: { readonly correlationId: string } }>();
    expect(envelope.error.correlationId).toMatch(/^cor_http_req-/u);
    expectCanonicalError(response);
  });

  it('starts only on numeric IPv4 loopback and closes real intake idempotently', async () => {
    const running = await startLocalApi(dependencies());
    try {
      expect(running.hostname).toBe(localApiHostname);
      expect(running.url).toBe(`http://127.0.0.1:${String(running.port)}`);
      expect(running.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      const unauthorized = await fetch(`${running.url}/v1/capabilities`, {
        headers: { connection: 'close' }
      });
      const authorized = await fetch(`${running.url}/v1/capabilities`, {
        headers: {
          connection: 'close',
          authorization: `Bearer ${running.sessionToken}`
        }
      });
      expect(unauthorized.status).toBe(401);
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toEqual(capabilityManifest());
    } finally {
      await running.close();
      await running.close();
    }
    expect(running.server.server.listening).toBe(false);
    await expect(fetch(`${running.url}/health/live`, { headers: { connection: 'close' } })).rejects.toThrow();
  });

  it('aborts active application work before reporting shutdown complete', async () => {
    let observedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolveResult) => {
      markStarted = resolveResult;
    });
    const running = await startLocalApi(dependencies({
      application: {
        getCapabilities(_context, signal) {
          observedSignal = signal;
          markStarted();
          return new Promise<CapabilityManifest>(() => undefined);
        }
      }
    }), { handlerTimeoutMs: 60_000 });
    const request = fetch(`${running.url}/v1/capabilities`, {
      headers: {
        connection: 'close',
        authorization: `Bearer ${running.sessionToken}`
      }
    }).catch(() => undefined);
    await started;

    await expect(Promise.race([
      running.close(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('The local API exceeded its shutdown bound.'));
        }, 1_000);
      })
    ])).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    await request;
  });
});
