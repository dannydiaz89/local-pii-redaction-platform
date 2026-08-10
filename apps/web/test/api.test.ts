import { describe, expect, it, vi } from 'vitest';

import { localPreviewMaximumInputBytes } from '@local-pii/contracts';

import { createCapabilityClient, projectCapabilitySummary } from '../src/api.js';
import { createLocalJobClient, projectPolicyCatalog } from '../src/job-api.js';
import { webPreviewMaximumInputBytes } from '../src/preview-limit.js';

const session = {
  apiOrigin: 'http://127.0.0.1:4174',
  bearerToken: 'A'.repeat(43)
} as const;

function capabilityResponse(): Readonly<Record<string, unknown>> {
  return {
    engineMode: 'RULES_ONLY',
    formats: [
      {
        id: 'text', extensions: ['.txt'], operations: ['SCAN'],
        limits: { maximumInputBytes: 104_857_600 }
      },
      {
        id: 'markdown', extensions: ['.md', '.markdown'], operations: ['SCAN'],
        limits: { maximumInputBytes: 52_428_800 }
      }
    ],
    detectors: [
      { id: 'rules', availability: 'AVAILABLE' },
      { id: 'model', availability: 'DISABLED' }
    ],
    limits: { maximumInputBytes: 104_857_600 }
  };
}

const jobId = 'job_01J4M91NJK8WAPJ7J95K73CB2M';
const policy = {
  id: 'development-labels', version: '0.1.0', digest: `sha256:${'a'.repeat(64)}`,
  riskTier: 'LOW', example: true
} as const;

function policyResponse(): Readonly<Record<string, unknown>> {
  return { schemaVersion: '1.0.0', defaultPolicyId: policy.id, policies: [policy] };
}

function jobResponse(state = 'QUEUED', revision = 1): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: '1.0.0', id: jobId, operation: 'SCAN', state, revision,
    policy: { id: policy.id, version: policy.version, digest: policy.digest },
    createdAt: '2026-08-09T18:00:00Z', updatedAt: '2026-08-09T18:00:00Z'
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function requestUrl(input: URL | RequestInfo): URL {
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input);
  return new URL(input.url);
}

describe('browser capability client', () => {
  it('projects only bounded display-safe capability aggregates', () => {
    expect(projectCapabilitySummary(capabilityResponse())).toEqual({
      engineMode: 'RULES_ONLY',
      formatCount: 2,
      availableDetectorCount: 1,
      maximumInputBytes: 104_857_600,
      supportedFiles: [
        { extension: '.markdown', maximumInputBytes: 52_428_800 },
        { extension: '.md', maximumInputBytes: 52_428_800 },
        { extension: '.txt', maximumInputBytes: 104_857_600 }
      ]
    });
    expect(() => projectCapabilitySummary({ ...capabilityResponse(), engineMode: 'SURPRISE' })).toThrow(
      'CAPABILITY_RESPONSE_INVALID'
    );
    expect(() => projectCapabilitySummary({ ...capabilityResponse(), engineMode: 'REMOTE' })).toThrow(
      'CAPABILITY_RESPONSE_INVALID'
    );
    expect(() => projectCapabilitySummary({
      ...capabilityResponse(),
      formats: [{ id: 'unsafe', extensions: ['../../txt'], operations: ['SCAN'], limits: { maximumInputBytes: 1 } }]
    })).toThrow('CAPABILITY_RESPONSE_INVALID');
  });

  it('uses the exact numeric-loopback session with no redirects, referrer, credentials, or cache', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify(capabilityResponse()),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ));
    const client = createCapabilityClient(session, fetchImplementation);
    await expect(client.load(new AbortController().signal)).resolves.toMatchObject({ engineMode: 'RULES_ONLY' });

    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    if (!(url instanceof URL)) throw new TypeError('The capability request URL was not normalized.');
    expect(url.href).toBe('http://127.0.0.1:4174/v1/capabilities');
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer'
    });
    expect(init?.headers).toEqual({
      authorization: `Bearer ${session.bearerToken}`,
      accept: 'application/json'
    });
  });

  it('rejects non-loopback sessions and oversized or malformed responses', async () => {
    expect(() => createCapabilityClient({ ...session, apiOrigin: 'http://localhost:4174' })).toThrow(TypeError);
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '200000' }
    }));
    await expect(createCapabilityClient(session, oversized).load(new AbortController().signal)).rejects.toThrow(
      'CAPABILITY_RESPONSE_INVALID'
    );
  });

  it('bounds a non-cooperative capability request and aborts its transport signal', async () => {
    let transportSignal: AbortSignal | undefined;
    const hanging = vi.fn<typeof fetch>((_input, init) => {
      transportSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const client = createCapabilityClient(session, hanging, 10);
    await expect(client.load(new AbortController().signal)).rejects.toThrow('CAPABILITY_REQUEST_CANCELLED');
    expect(transportSignal?.aborted).toBe(true);
  });
});

describe('browser policy and job client', () => {
  it('keeps the browser preview ceiling aligned with the canonical API contract', () => {
    expect(webPreviewMaximumInputBytes).toBe(localPreviewMaximumInputBytes);
  });

  it('projects a closed policy catalog without presentation copy', () => {
    expect(projectPolicyCatalog(policyResponse())).toEqual({ defaultPolicy: policy, policies: [policy] });
    expect(() => projectPolicyCatalog({ ...policyResponse(), displayName: 'not canonical' })).toThrow(
      'POLICY_RESPONSE_INVALID'
    );
    expect(() => projectPolicyCatalog({ ...policyResponse(), defaultPolicyId: 'missing-policy' })).toThrow(
      'POLICY_RESPONSE_INVALID'
    );
    expect(() => projectPolicyCatalog({ ...policyResponse(), policies: [policy, policy] })).toThrow(
      'POLICY_RESPONSE_INVALID'
    );
  });

  it('uses a bounded metadata-only request matrix for jobs and events', async () => {
    const fetchImplementation = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.pathname === '/v1/policies') return Promise.resolve(jsonResponse(policyResponse()));
      if (url.pathname === '/v1/preview/scan') {
        return Promise.resolve(jsonResponse({
          schemaVersion: '1.0.0', operation: 'SCAN', outcome: 'SUCCEEDED',
          counts: { detections: 1, conflicts: 0, byEntity: { EMAIL: 1 } }
        }));
      }
      if (url.pathname.endsWith('/events')) {
        return Promise.resolve(jsonResponse({
          schemaVersion: '1.0.0', jobId, nextCursor: 1,
          events: [{
            schemaVersion: '1.0.0', id: '603df129-c778-4b13-8b2a-0fe745593c8f', jobId,
            cursor: 1, revision: 1, type: 'JOB_CREATED', occurredAt: '2026-08-09T18:00:00Z',
            counts: { detections: 0 }
          }]
        }));
      }
      return Promise.resolve(jsonResponse(
        jobResponse(url.pathname.endsWith('/cancellation') ? 'CANCELLING' : 'QUEUED')
      ));
    });
    const client = createLocalJobClient(session, fetchImplementation);
    const signal = new AbortController().signal;

    await expect(client.loadPolicies(signal)).resolves.toMatchObject({ defaultPolicy: { id: policy.id } });
    const previewFile = new File(['synthetic'], 'private-input.txt', { type: 'text/plain' });
    await expect(client.scanPreview(previewFile, signal)).resolves.toEqual({
      outcome: 'SUCCEEDED', detections: 1, conflicts: 0, byEntity: { EMAIL: 1 }
    });
    await expect(client.create('SCAN', policy, '603df129-c778-4b13-8b2a-0fe745593c8f', signal)).resolves.toMatchObject({
      id: jobId, state: 'QUEUED'
    });
    await expect(client.get(jobId, signal)).resolves.toMatchObject({ id: jobId });
    await expect(client.listEvents(jobId, 0, 25, signal)).resolves.toMatchObject({ nextCursor: 1 });
    await expect(client.cancel(jobId, 1, signal)).resolves.toMatchObject({ state: 'CANCELLING' });

    const normalizedCalls = fetchImplementation.mock.calls.map(([input, init]) => ({
      url: requestUrl(input).href,
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      credentials: init?.credentials,
      cache: init?.cache,
      redirect: init?.redirect,
      referrerPolicy: init?.referrerPolicy
    }));
    expect(normalizedCalls.map(({ url }) => url)).toEqual([
      'http://127.0.0.1:4174/v1/policies',
      'http://127.0.0.1:4174/v1/preview/scan?format=text',
      'http://127.0.0.1:4174/v1/jobs',
      `http://127.0.0.1:4174/v1/jobs/${jobId}`,
      `http://127.0.0.1:4174/v1/jobs/${jobId}/events?after=0&limit=25`,
      `http://127.0.0.1:4174/v1/jobs/${jobId}/cancellation`
    ]);
    expect(normalizedCalls.every(({ credentials, cache, redirect, referrerPolicy }) =>
      credentials === 'omit' && cache === 'no-store' && redirect === 'error' && referrerPolicy === 'no-referrer'
    )).toBe(true);
    expect(normalizedCalls[2]?.headers).toMatchObject({
      authorization: `Bearer ${session.bearerToken}`,
      'idempotency-key': '603df129-c778-4b13-8b2a-0fe745593c8f'
    });
    expect(normalizedCalls[1]?.body).toBe(previewFile);
    expect(normalizedCalls[1]?.headers).toMatchObject({ 'content-type': 'application/octet-stream' });
    expect(normalizedCalls[1]?.url).not.toContain(previewFile.name);
    const createBody = normalizedCalls[2]?.body;
    if (typeof createBody !== 'string') throw new TypeError('The job request body was not serialized.');
    expect(JSON.parse(createBody) as unknown).toEqual({
      schemaVersion: '1.0.0', operation: 'SCAN',
      policy: { id: policy.id, version: policy.version, digest: policy.digest }
    });
    expect(createBody).not.toMatch(/file|content|path|name/iu);
  });

  it('fails closed on invalid requests, invalid responses, and a non-cooperative transport', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...jobResponse(), summary: { detections: 0, sensitiveLabel: 1 }
    }));
    const client = createLocalJobClient(session, fetchImplementation);
    const signal = new AbortController().signal;
    await expect(client.get(jobId, signal)).rejects.toThrow('JOB_RESPONSE_INVALID');
    await expect(client.get('job_invalid', signal)).rejects.toThrow(TypeError);
    expect(() => client.listEvents(jobId, 0, 101, signal)).toThrow(TypeError);
    expect(() => client.create('SCAN', { ...policy, id: '../policy' },
      '603df129-c778-4b13-8b2a-0fe745593c8f', signal)).toThrow('POLICY_RESPONSE_INVALID');
    expect(() => client.scanPreview(new File(['x'], 'synthetic.pdf'), signal)).toThrow(TypeError);

    let transportSignal: AbortSignal | undefined;
    const hanging = vi.fn<typeof fetch>((_input, init) => {
      transportSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    await expect(createLocalJobClient(session, hanging, 10).loadPolicies(signal)).rejects.toThrow(
      'JOB_REQUEST_CANCELLED'
    );
    expect(transportSignal?.aborted).toBe(true);
  });
});
