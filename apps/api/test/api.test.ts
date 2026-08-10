import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  localPreviewMaximumConflictDetails,
  localPreviewMaximumDetectionDetails,
  localPreviewMaximumInputBytes,
  validateContract
} from '@local-pii/contracts';
import { SafeError } from '@local-pii/domain';
import { createLocalPolicyCatalog, localTextApplication } from '@local-pii/profile-local';

import {
  apiDefaultHandlerTimeoutMs,
  apiMaximumBodyBytes,
  buildApi,
  createLocalPreviewScan,
  createVolatileProcessingControl,
  createVolatileJobControl,
  generateLocalSessionToken,
  localApiHostname,
  startLocalApi,
  type ApiDependencies,
  type CapabilityManifest,
  type PolicyCatalog
} from '../src/index.js';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const errorSchemaId = 'https://local-pii.dev/schemas/common/errors/1.0.0';
const sessionToken = 'A'.repeat(43);
const allowedOrigin = 'http://127.0.0.1:4173';
const loopbackHost = '127.0.0.1';
const idempotencyKey = '123e4567-e89b-12d3-a456-426614174000';
const jobSchemaId = 'https://local-pii.dev/schemas/jobs/job/1.0.0';
const jobEventPageSchemaId = 'https://local-pii.dev/schemas/jobs/job-event-page/1.0.0';
const policyCatalogSchemaId = 'https://local-pii.dev/schemas/policy/policy-catalog/1.0.0';
const artifactSchemaId = 'https://local-pii.dev/schemas/artifacts/artifact/1.0.0';
const detectionPageSchemaId = 'https://local-pii.dev/schemas/jobs/detection-page/1.0.0';
const reviewSetSchemaId = 'https://local-pii.dev/schemas/jobs/review-set/1.0.0';
const servers: ReturnType<typeof buildApi>[] = [];

function capabilityManifest(): CapabilityManifest {
  return JSON.parse(readFileSync(
    resolve(repositoryRoot, 'fixtures/contracts/valid/capability-rules-only-text.json'),
    'utf8'
  )) as CapabilityManifest;
}

function policyCatalog(): PolicyCatalog {
  return {
    schemaVersion: '1.0.0',
    defaultPolicyId: 'development-labels',
    policies: [{
      id: 'development-labels',
      version: '0.1.0',
      digest: `sha256:${'b'.repeat(64)}`,
      riskTier: 'LOW',
      example: true
    }]
  };
}

function dependencies(overrides: Partial<ApiDependencies> = {}): ApiDependencies {
  return {
    application: { getCapabilities: () => Promise.resolve(capabilityManifest()) },
    jobs: createVolatileJobControl(),
    policies: { get: () => Promise.resolve(policyCatalog()) },
    preview: {
      scan: () => Promise.resolve({
        schemaVersion: '2.0.0', operation: 'SCAN', outcome: 'SUCCEEDED',
        counts: { detections: 0, conflicts: 0, byEntity: {} },
        detections: [], detailsLimited: false, conflicts: [], conflictDetailsLimited: false
      })
    },
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

function createJobPayload(operation: 'SCAN' | 'REDACT' = 'SCAN'): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    operation,
    policy: {
      id: 'development-labels',
      version: '0.1.0',
      digest: `sha256:${'b'.repeat(64)}`
    }
  };
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

  it('returns only canonical pinned policy metadata without presentation copy', async () => {
    const response = await server().inject({
      method: 'GET', url: '/v1/policies', headers: authorization()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(policyCatalog());
    expect(validateContract(policyCatalogSchemaId, response.json()).valid).toBe(true);
    expect(response.body).not.toContain('displayName');
    expect(response.body).not.toContain('description');
  });

  it('scans bounded preview bytes through the real core without returning source values', async () => {
    const plantedValue = 'preview-canary@example.test';
    const response = await server(dependencies({
      preview: createLocalPreviewScan(localTextApplication)
    })).inject({
      method: 'POST',
      url: '/v1/preview/scan?format=text',
      headers: { ...authorization(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from(`Synthetic contact: ${plantedValue}`, 'utf8')
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: '1.0.0', operation: 'SCAN', outcome: 'SUCCEEDED',
      counts: { detections: 1, conflicts: 0, byEntity: { EMAIL: 1 } }
    });
    expect(response.body).not.toContain(plantedValue);
    expect(response.body).not.toMatch(/displayName|digest|offset|path|reference|text/iu);
  });

  it('returns bounded value-free detection locations for ephemeral browser review', async () => {
    const plantedValue = 'preview-canary@example.test';
    const response = await server(dependencies({
      preview: createLocalPreviewScan(localTextApplication)
    })).inject({
      method: 'POST',
      url: '/v1/preview/review?format=text',
      headers: { ...authorization(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from(`Synthetic contact: ${plantedValue}`, 'utf8')
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schemaVersion: '2.0.0', operation: 'SCAN', outcome: 'SUCCEEDED',
      counts: { detections: 1, conflicts: 0, byEntity: { EMAIL: 1 } },
      detections: [{
        entityType: 'EMAIL', start: 19, end: 46, offsetUnit: 'UNICODE_CODE_POINT',
        confidence: 0.99, sources: ['REGEX']
      }],
      detailsLimited: false,
      conflicts: [],
      conflictDetailsLimited: false
    });
    expect(response.body).not.toContain(plantedValue);
    expect(response.body).not.toMatch(/displayName|digest|path|reference|matchedValue|text/iu);
  });

  it('returns bounded value-free conflict evidence from the real resolver', async () => {
    const plantedValue = '+378282246310005';
    const response = await server(dependencies({
      preview: createLocalPreviewScan(localTextApplication)
    })).inject({
      method: 'POST',
      url: '/v1/preview/review?format=text',
      headers: { ...authorization(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from(`Synthetic card-like contact: ${plantedValue}`, 'utf8')
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schemaVersion: '2.0.0', operation: 'SCAN', outcome: 'NEEDS_REVIEW',
      counts: { detections: 1, conflicts: 1, byEntity: { CREDIT_CARD: 1 } },
      conflicts: [{
        code: 'INCOMPATIBLE_OVERLAP', offsetUnit: 'UNICODE_CODE_POINT',
        entityTypes: ['CREDIT_CARD', 'PHONE'], sources: ['CHECKSUM', 'REGEX']
      }],
      conflictDetailsLimited: false
    });
    expect(response.body).not.toContain(plantedValue);
    expect(response.body).not.toMatch(/evidenceIds|matchedValue|displayName|digest|path|reference|text/iu);
  });

  it('limits ephemeral detection detail rows without changing aggregate counts', async () => {
    const plantedValues = Array.from(
      { length: localPreviewMaximumDetectionDetails + 1 },
      (_, index) => `synthetic${String(index).padStart(3, '0')}@example.test`
    );
    const response = await server(dependencies({
      preview: createLocalPreviewScan(localTextApplication)
    })).inject({
      method: 'POST',
      url: '/v1/preview/review?format=text',
      headers: { ...authorization(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from(plantedValues.join('\n'), 'utf8')
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      readonly counts: { readonly detections: number };
      readonly detections: readonly unknown[];
      readonly detailsLimited: boolean;
    }>();
    expect(body.counts.detections).toBe(localPreviewMaximumDetectionDetails + 1);
    expect(body.detections).toHaveLength(localPreviewMaximumDetectionDetails);
    expect(body.detailsLimited).toBe(true);
    expect(plantedValues.every((value) => !response.body.includes(value))).toBe(true);
  });

  it('limits conflict detail rows without changing resolver aggregate counts', async () => {
    const repeated = Array.from(
      { length: localPreviewMaximumConflictDetails + 1 },
      (_, index) => `Entry ${String(index)}: +378282246310005`
    ).join('\n');
    const response = await server(dependencies({
      preview: createLocalPreviewScan(localTextApplication)
    })).inject({
      method: 'POST',
      url: '/v1/preview/review?format=text',
      headers: { ...authorization(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from(repeated, 'utf8')
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      readonly counts: { readonly conflicts: number };
      readonly conflicts: readonly unknown[];
      readonly conflictDetailsLimited: boolean;
    }>();
    expect(body.counts.conflicts).toBe(localPreviewMaximumConflictDetails + 1);
    expect(body.conflicts).toHaveLength(localPreviewMaximumConflictDetails);
    expect(body.conflictDetailsLimited).toBe(true);
    expect(response.body).not.toContain('+378282246310005');
  });

  it('rejects malformed and over-limit preview bodies with canonical safe errors', async () => {
    const instance = server(dependencies({ preview: createLocalPreviewScan(localTextApplication) }));
    const corrupt = await instance.inject({
      method: 'POST', url: '/v1/preview/scan?format=markdown',
      headers: { ...authorization(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from([0xc3, 0x28])
    });
    expect(corrupt.statusCode).toBe(422);
    expectCanonicalError(corrupt);
    expect(corrupt.body).not.toMatch(/c3|0x|buffer/iu);

    const oversized = await instance.inject({
      method: 'POST', url: '/v1/preview/scan?format=text',
      headers: { ...authorization(), 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(localPreviewMaximumInputBytes + 1, 0x61)
    });
    expect(oversized.statusCode).toBe(413);
    expectCanonicalError(oversized);
  });

  it('admits only one preview body at a time', async () => {
    let markStarted: (() => void) | undefined;
    let finishScan: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const preview: ApiDependencies['preview'] = {
      scan: () => new Promise((resolve) => {
        markStarted?.();
        finishScan = () => {
          resolve({
            schemaVersion: '2.0.0', operation: 'SCAN', outcome: 'SUCCEEDED',
            counts: { detections: 0, conflicts: 0, byEntity: {} },
            detections: [], detailsLimited: false, conflicts: [], conflictDetailsLimited: false
          });
        };
      })
    };
    const instance = server(dependencies({ preview }));
    const request = {
      method: 'POST' as const,
      url: '/v1/preview/scan?format=text',
      headers: { ...authorization(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('synthetic', 'utf8')
    };

    const first = instance.inject(request);
    await started;
    const competing = await instance.inject(request);
    expect(competing.statusCode).toBe(429);
    expect(competing.json()).toMatchObject({ error: { code: 'RATE_LIMITED', retryable: true } });
    finishScan?.();
    expect((await first).statusCode).toBe(200);
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
      url: '/v1/jobs',
      headers: {
        host: loopbackHost,
        origin: allowedOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, idempotency-key'
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
    expect(accepted.headers['access-control-allow-methods']).toBe('GET, POST, PUT, OPTIONS');
    expect(accepted.headers['access-control-allow-headers']).toBe('authorization, content-type, idempotency-key');
    expect(accepted.body).not.toContain(sessionToken);
    expect(rejected.statusCode).toBe(403);
    expect(rejected.body).not.toContain('x-alpha-canary');
    expectCanonicalError(rejected);
  });

  it('runs a bounded artifact through a real asynchronous scan job and paginated value-free results', async () => {
    const bytes = Buffer.from('Synthetic contacts: first@example.test and second@example.test', 'utf8');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const catalog = createLocalPolicyCatalog();
    const processing = createVolatileProcessingControl(localTextApplication, catalog.policies);
    const instance = server(dependencies({
      jobs: processing,
      processing,
      policies: { get: () => Promise.resolve(catalog) }
    }));

    const initiated = await instance.inject({
      method: 'POST',
      url: '/v1/artifacts',
      headers: authorization(),
      payload: { schemaVersion: '1.0.0', mediaType: 'text/plain', byteLength: bytes.length, digest }
    });
    expect(initiated.statusCode).toBe(201);
    expect(validateContract(artifactSchemaId, initiated.json()).valid).toBe(true);
    expect(initiated.json()).toMatchObject({ publicationState: 'STAGED', displayName: 'document.txt' });
    const artifactId = initiated.json<{ readonly id: string }>().id;

    const uploaded = await instance.inject({
      method: 'PUT',
      url: `/v1/artifacts/${artifactId}/content`,
      headers: { ...authorization(), 'content-type': 'application/octet-stream' },
      payload: bytes
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({ id: artifactId, publicationState: 'IMMUTABLE', digest });

    const created = await instance.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...authorization(), 'idempotency-key': idempotencyKey },
      payload: {
        schemaVersion: '2.0.0',
        operation: 'SCAN',
        inputArtifactId: artifactId,
        policy: {
          id: catalog.policies[0].id,
          version: catalog.policies[0].version,
          digest: catalog.policies[0].digest
        }
      }
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json<{ readonly id: string }>().id;
    let current = created.json<{ readonly state: string; readonly revision: number }>();
    for (let attempt = 0; attempt < 20 && current.state !== 'SUCCEEDED'; attempt += 1) {
      const response = await instance.inject({
        method: 'GET', url: `/v1/jobs/${jobId}`, headers: authorization()
      });
      expect(response.statusCode).toBe(200);
      current = response.json<typeof current>();
    }
    expect(current).toMatchObject({ state: 'SUCCEEDED', revision: 6 });

    const events = await instance.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/events`, headers: authorization()
    });
    expect(events.statusCode).toBe(200);
    expect(events.json<{ readonly events: readonly unknown[] }>().events).toHaveLength(6);

    const firstPage = await instance.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/detections?cursor=0&limit=1`, headers: authorization()
    });
    expect(firstPage.statusCode).toBe(200);
    expect(validateContract(detectionPageSchemaId, firstPage.json()).valid).toBe(true);
    expect(firstPage.json()).toMatchObject({ jobId, jobRevision: 6, total: 2, cursor: 0, nextCursor: 1 });
    const secondPage = await instance.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/detections?cursor=1&limit=1`, headers: authorization()
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json()).toMatchObject({ jobId, total: 2, cursor: 1, nextCursor: null });
    const initialReview = await instance.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/review-decisions`, headers: authorization()
    });
    expect(initialReview.statusCode).toBe(200);
    expect(validateContract(reviewSetSchemaId, initialReview.json()).valid).toBe(true);
    expect(initialReview.json()).toMatchObject({ jobId, jobRevision: 6, reviewRevision: 0, decisions: [] });
    const extractionRevision = initialReview.json<{ readonly extractionRevision: string }>().extractionRevision;
    const targetDetectionId = firstPage.json<{
      readonly detections: readonly { readonly id: string }[];
    }>().detections[0]?.id;
    expect(targetDetectionId).toBeDefined();
    const decision = {
      clientDecisionId: '71a818d3-828c-4cc8-8536-19f05e61c88d',
      targetDetectionId,
      action: 'REJECT',
      reasonCode: 'FALSE_POSITIVE'
    };
    const appended = await instance.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/review-decisions`, headers: authorization(),
      payload: {
        schemaVersion: '1.0.0', expectedJobRevision: 6, expectedExtractionRevision: extractionRevision,
        expectedReviewRevision: 0, decisions: [decision]
      }
    });
    expect(appended.statusCode).toBe(200);
    expect(validateContract(reviewSetSchemaId, appended.json()).valid).toBe(true);
    expect(appended.json()).toMatchObject({
      jobId, jobRevision: 6, reviewRevision: 1,
      decisions: [{ revision: 1, ...decision, principal: 'LOCAL_SESSION' }]
    });
    const replay = await instance.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/review-decisions`, headers: authorization(),
      payload: {
        schemaVersion: '1.0.0', expectedJobRevision: 6, expectedExtractionRevision: extractionRevision,
        expectedReviewRevision: 0, decisions: [decision]
      }
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(appended.json());
    const stale = await instance.inject({
      method: 'POST', url: `/v1/jobs/${jobId}/review-decisions`, headers: authorization(),
      payload: {
        schemaVersion: '1.0.0', expectedJobRevision: 6, expectedExtractionRevision: extractionRevision,
        expectedReviewRevision: 0,
        decisions: [{
          clientDecisionId: '9430b33d-9ff1-4f27-8202-10fb4259c7ca', targetDetectionId,
          action: 'ACCEPT', reasonCode: 'CONFIRMED_BY_REVIEWER'
        }]
      }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'JOB_CONFLICT' } });
    const serialized = `${initiated.body}${uploaded.body}${created.body}${events.body}${firstPage.body}${secondPage.body}${initialReview.body}${appended.body}${stale.body}`;
    expect(serialized).not.toContain('first@example.test');
    expect(serialized).not.toContain('second@example.test');
  });

  it('runs real verified redaction and authorizes only the session output for download', async () => {
    const sourceValue = 'browser-redaction@example.test';
    const bytes = Buffer.from(`Synthetic contact: ${sourceValue}`, 'utf8');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const catalog = createLocalPolicyCatalog();
    const processing = createVolatileProcessingControl(localTextApplication, catalog.policies);
    const instance = server(dependencies({
      jobs: processing,
      processing,
      policies: { get: () => Promise.resolve(catalog) }
    }));
    const initiated = await instance.inject({
      method: 'POST',
      url: '/v1/artifacts',
      headers: authorization(),
      payload: { schemaVersion: '1.0.0', mediaType: 'text/plain', byteLength: bytes.length, digest }
    });
    const inputArtifactId = initiated.json<{ readonly id: string }>().id;
    const uploaded = await instance.inject({
      method: 'PUT',
      url: `/v1/artifacts/${inputArtifactId}/content`,
      headers: { ...authorization(), 'content-type': 'application/octet-stream' },
      payload: bytes
    });
    expect(uploaded.statusCode).toBe(200);
    const inputDownload = await instance.inject({
      method: 'GET', url: `/v1/artifacts/${inputArtifactId}/content`, headers: authorization()
    });
    expect(inputDownload.statusCode).toBe(404);
    expect(inputDownload.body).not.toContain(sourceValue);

    const created = await instance.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...authorization(), 'idempotency-key': idempotencyKey },
      payload: {
        schemaVersion: '3.0.0',
        operation: 'REDACT',
        inputArtifactId,
        policy: {
          id: catalog.defaultPolicyId,
          version: catalog.policies[0].version,
          digest: catalog.policies[0].digest
        }
      }
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json<{ readonly id: string }>().id;
    let current = created.json<{ readonly state: string; readonly revision: number }>();
    for (let attempt = 0; attempt < 20 && current.state !== 'VERIFIED'; attempt += 1) {
      const response = await instance.inject({ method: 'GET', url: `/v1/jobs/${jobId}`, headers: authorization() });
      current = response.json<typeof current>();
    }
    expect(current).toMatchObject({ state: 'VERIFIED', revision: 8 });

    const outputResponse = await instance.inject({
      method: 'GET', url: `/v1/jobs/${jobId}/output`, headers: authorization()
    });
    expect(outputResponse.statusCode).toBe(200);
    expect(validateContract(artifactSchemaId, outputResponse.json()).valid).toBe(true);
    expect(outputResponse.json()).toMatchObject({
      kind: 'SANITIZED_OUTPUT',
      publicationState: 'PUBLISHABLE',
      displayName: 'document.redacted.txt'
    });
    const outputArtifactId = outputResponse.json<{ readonly id: string }>().id;
    const downloaded = await instance.inject({
      method: 'GET', url: `/v1/artifacts/${outputArtifactId}/content`, headers: authorization()
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers['content-type']).toMatch(/^text\/plain/u);
    expect(downloaded.headers['content-disposition']).toBe('attachment; filename="document.redacted.txt"');
    expect(downloaded.body).toBe('Synthetic contact: [EMAIL_1]');
    expect(downloaded.body).not.toContain(sourceValue);
    expect(outputResponse.body).not.toContain(sourceValue);

    const unauthorized = await instance.inject({
      method: 'GET', url: `/v1/artifacts/${outputArtifactId}/content`, headers: { host: loopbackHost }
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.body).not.toContain(outputArtifactId);
  });

  it('redacts from the exact saved review set and preserves an explicitly rejected match', async () => {
    const sourceValue = 'reviewed-false-positive@example.test';
    const bytes = Buffer.from(`Synthetic identifier: ${sourceValue}`, 'utf8');
    const catalog = createLocalPolicyCatalog();
    const processing = createVolatileProcessingControl(localTextApplication, catalog.policies);
    const instance = server(dependencies({
      jobs: processing,
      processing,
      policies: { get: () => Promise.resolve(catalog) }
    }));
    const upload = async (content: Buffer = bytes) => {
      const contentDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
      const initiated = await instance.inject({
        method: 'POST', url: '/v1/artifacts', headers: authorization(),
        payload: {
          schemaVersion: '1.0.0', mediaType: 'text/plain', byteLength: content.length, digest: contentDigest
        }
      });
      const artifactId = initiated.json<{ readonly id: string }>().id;
      expect((await instance.inject({
        method: 'PUT', url: `/v1/artifacts/${artifactId}/content`,
        headers: { ...authorization(), 'content-type': 'application/octet-stream' }, payload: content
      })).statusCode).toBe(200);
      return artifactId;
    };
    const policyBinding = {
      id: catalog.defaultPolicyId,
      version: catalog.policies[0].version,
      digest: catalog.policies[0].digest
    };
    const scan = await instance.inject({
      method: 'POST', url: '/v1/jobs',
      headers: { ...authorization(), 'idempotency-key': '723e4567-e89b-42d3-a456-426614174001' },
      payload: { schemaVersion: '2.0.0', operation: 'SCAN', inputArtifactId: await upload(), policy: policyBinding }
    });
    const scanJobId = scan.json<{ readonly id: string }>().id;
    let scanJob = scan.json<{ readonly state: string; readonly revision: number }>();
    for (let attempt = 0; attempt < 20 && scanJob.state !== 'SUCCEEDED'; attempt += 1) {
      scanJob = (await instance.inject({
        method: 'GET', url: `/v1/jobs/${scanJobId}`, headers: authorization()
      })).json<typeof scanJob>();
    }
    expect(scanJob.state).toBe('SUCCEEDED');
    const detections = (await instance.inject({
      method: 'GET', url: `/v1/jobs/${scanJobId}/detections`, headers: authorization()
    })).json<{ readonly detections: readonly { readonly id: string }[] }>();
    const initialReview = (await instance.inject({
      method: 'GET', url: `/v1/jobs/${scanJobId}/review-decisions`, headers: authorization()
    })).json<{ readonly extractionRevision: string; readonly digest: string }>();
    const reviewed = await instance.inject({
      method: 'POST', url: `/v1/jobs/${scanJobId}/review-decisions`, headers: authorization(),
      payload: {
        schemaVersion: '1.0.0', expectedJobRevision: scanJob.revision,
        expectedExtractionRevision: initialReview.extractionRevision, expectedReviewRevision: 0,
        decisions: [{
          clientDecisionId: '723e4567-e89b-42d3-a456-426614174002',
          targetDetectionId: detections.detections[0]?.id,
          action: 'REJECT', reasonCode: 'FALSE_POSITIVE'
        }]
      }
    });
    expect(reviewed.statusCode).toBe(200);
    const reviewSet = reviewed.json<{
      readonly jobRevision: number;
      readonly extractionRevision: string;
      readonly reviewRevision: number;
      readonly digest: string;
    }>();
    const reviewBinding = {
      sourceJobId: scanJobId,
      expectedJobRevision: reviewSet.jobRevision,
      expectedExtractionRevision: reviewSet.extractionRevision,
      expectedReviewRevision: reviewSet.reviewRevision,
      expectedReviewDigest: reviewSet.digest
    };
    const mismatched = await instance.inject({
      method: 'POST', url: '/v1/jobs',
      headers: { ...authorization(), 'idempotency-key': '723e4567-e89b-42d3-a456-426614174004' },
      payload: {
        schemaVersion: '4.0.0', operation: 'REDACT',
        inputArtifactId: await upload(Buffer.from(`${bytes.toString('utf8')} changed`, 'utf8')),
        policy: policyBinding, review: reviewBinding
      }
    });
    expect(mismatched.statusCode).toBe(409);
    expect(mismatched.json()).toMatchObject({ error: { code: 'JOB_CONFLICT' } });
    expect(mismatched.body).not.toContain(sourceValue);
    const redaction = await instance.inject({
      method: 'POST', url: '/v1/jobs',
      headers: { ...authorization(), 'idempotency-key': '723e4567-e89b-42d3-a456-426614174003' },
      payload: {
        schemaVersion: '4.0.0', operation: 'REDACT', inputArtifactId: await upload(), policy: policyBinding,
        review: reviewBinding
      }
    });
    expect(redaction.statusCode).toBe(201);
    const redactionJobId = redaction.json<{ readonly id: string }>().id;
    let redactionJob = redaction.json<{ readonly state: string }>();
    for (let attempt = 0; attempt < 20 && redactionJob.state !== 'VERIFIED'; attempt += 1) {
      redactionJob = (await instance.inject({
        method: 'GET', url: `/v1/jobs/${redactionJobId}`, headers: authorization()
      })).json<typeof redactionJob>();
    }
    expect(redactionJob.state).toBe('VERIFIED');
    const output = (await instance.inject({
      method: 'GET', url: `/v1/jobs/${redactionJobId}/output`, headers: authorization()
    })).json<{ readonly id: string }>();
    const downloaded = await instance.inject({
      method: 'GET', url: `/v1/artifacts/${output.id}/content`, headers: authorization()
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe(`Synthetic identifier: ${sourceValue}`);
    expect(redaction.body).not.toContain(sourceValue);
    expect(reviewed.body).not.toContain(sourceValue);
  });

  it('rejects mismatched artifact bytes without creating a scanable artifact', async () => {
    const catalog = policyCatalog();
    const processing = createVolatileProcessingControl(localTextApplication, catalog.policies);
    const instance = server(dependencies({ jobs: processing, processing }));
    const initiated = await instance.inject({
      method: 'POST',
      url: '/v1/artifacts',
      headers: authorization(),
      payload: {
        schemaVersion: '1.0.0', mediaType: 'text/plain', byteLength: 9,
        digest: `sha256:${'a'.repeat(64)}`
      }
    });
    const artifactId = initiated.json<{ readonly id: string }>().id;
    const rejected = await instance.inject({
      method: 'PUT',
      url: `/v1/artifacts/${artifactId}/content`,
      headers: { ...authorization(), 'content-type': 'application/octet-stream' },
      payload: Buffer.from('synthetic', 'utf8')
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json()).toMatchObject({ schemaVersion: '2.0.0', error: { code: 'ARTIFACT_DIGEST_MISMATCH' } });
    expect(rejected.body).not.toContain(artifactId);
  });

  it('creates and exactly replays a canonical metadata-only job', async () => {
    const instance = server();
    const first = await instance.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...authorization(), 'idempotency-key': idempotencyKey },
      payload: createJobPayload()
    });
    const replay = await instance.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...authorization(), 'idempotency-key': idempotencyKey },
      payload: createJobPayload()
    });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(validateContract(jobSchemaId, first.json()).valid).toBe(true);
    expect(first.json()).toMatchObject({ operation: 'SCAN', state: 'QUEUED', revision: 1 });
    expect(first.json<{ readonly id: string }>().id).toMatch(/^job_[0-9A-HJKMNP-TV-Z]{26}$/u);
    for (const prohibited of ['filename', 'path', 'content', 'excerpt', 'sourceValue']) {
      expect(first.body).not.toContain(prohibited);
    }
  });

  it('rejects conflicting idempotency reuse without exposing request metadata', async () => {
    const instance = server();
    await instance.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...authorization(), 'idempotency-key': idempotencyKey },
      payload: createJobPayload('SCAN')
    });
    const conflict = await instance.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...authorization(), 'idempotency-key': idempotencyKey },
      payload: createJobPayload('REDACT')
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(conflict.body).not.toContain(idempotencyKey);
    expectCanonicalError(conflict);
  });

  it('reads status, paginates minimized events, and accepts revision-bound cancellation', async () => {
    const instance = server();
    const created = await instance.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...authorization(), 'idempotency-key': idempotencyKey },
      payload: createJobPayload()
    });
    const job = created.json<{ readonly id: string; readonly revision: number }>();
    const status = await instance.inject({
      method: 'GET', url: `/v1/jobs/${job.id}`, headers: authorization()
    });
    const initialEvents = await instance.inject({
      method: 'GET', url: `/v1/jobs/${job.id}/events?after=0&limit=1`, headers: authorization()
    });
    const cancellation = await instance.inject({
      method: 'POST',
      url: `/v1/jobs/${job.id}/cancellation`,
      headers: authorization(),
      payload: { schemaVersion: '1.0.0', expectedRevision: job.revision }
    });
    const staleCancellation = await instance.inject({
      method: 'POST',
      url: `/v1/jobs/${job.id}/cancellation`,
      headers: authorization(),
      payload: { schemaVersion: '1.0.0', expectedRevision: job.revision }
    });
    const laterEvents = await instance.inject({
      method: 'GET', url: `/v1/jobs/${job.id}/events?after=1&limit=1`, headers: authorization()
    });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual(created.json());
    expect(initialEvents.json()).toMatchObject({ nextCursor: 1, events: [{ type: 'JOB_CREATED' }] });
    expect(cancellation.json()).toMatchObject({ state: 'CANCELLING', revision: 2 });
    expect(staleCancellation.statusCode).toBe(409);
    expect(staleCancellation.json()).toMatchObject({ error: { code: 'JOB_CONFLICT', retryable: true } });
    expect(laterEvents.json()).toMatchObject({ nextCursor: 2, events: [{ type: 'CANCELLATION_REQUESTED' }] });
    expect(validateContract(jobEventPageSchemaId, initialEvents.json()).valid).toBe(true);
    expect(validateContract(jobEventPageSchemaId, laterEvents.json()).valid).toBe(true);
  });

  it('fails closed on malformed job bodies, keys, queries, and unavailable identifiers', async () => {
    const instance = server();
    const plantedValue = 'alpha@example.test';
    const malformed = await instance.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...authorization(), 'idempotency-key': 'not-a-key' },
      payload: { ...createJobPayload(), content: plantedValue }
    });
    const unavailable = await instance.inject({
      method: 'GET',
      url: '/v1/jobs/job_01J4M91NJK8WAPJ7J95K73CB2Z',
      headers: authorization()
    });
    const invalidQuery = await instance.inject({
      method: 'GET',
      url: '/v1/jobs/job_01J4M91NJK8WAPJ7J95K73CB2Z/events?limit=101',
      headers: authorization()
    });
    const unavailableCancellation = await instance.inject({
      method: 'POST',
      url: '/v1/jobs/job_01J4M91NJK8WAPJ7J95K73CB2Z/cancellation',
      headers: authorization(),
      payload: { schemaVersion: '1.0.0', expectedRevision: 1 }
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain(plantedValue);
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json()).toMatchObject({ error: { code: 'AUTHORIZATION_DENIED' } });
    expect(invalidQuery.statusCode).toBe(400);
    expect(unavailableCancellation.statusCode).toBe(404);
    for (const response of [malformed, unavailable, invalidQuery, unavailableCancellation]) expectCanonicalError(response);
  });

  it('aborts noncooperative job control work at the shared handler deadline', async () => {
    let observedSignal: AbortSignal | undefined;
    const base = createVolatileJobControl();
    const jobs: ApiDependencies['jobs'] = {
      ...base,
      create(_request, _key, _scope, _correlationId, signal) {
        observedSignal = signal;
        return new Promise(() => undefined);
      }
    };
    const instance = server(dependencies({ jobs }), {
      session: { bearerToken: sessionToken },
      handlerTimeoutMs: 100
    });
    const response = await instance.inject({
      method: 'POST',
      url: '/v1/jobs',
      headers: { ...authorization(), 'idempotency-key': idempotencyKey },
      payload: createJobPayload()
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR', details: { deadlineExceeded: true } }
    });
    expect(observedSignal?.aborted).toBe(true);
    expectCanonicalError(response);
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
