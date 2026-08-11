import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCurrentCapabilityManifest,
  createLocalPolicyCatalog,
  localTextApplication
} from '@local-pii/profile-local';

import {
  buildApi,
  createVolatileJobControl,
  createVolatileProcessingControl,
  startLocalApi,
  type ApiDependencies,
  type CapabilityManifest,
  type PolicyCatalog,
  type ProcessingControlPort,
  type RunningLocalApi
} from '../src/index.js';

const token = 'A'.repeat(43);
const host = '127.0.0.1';
const canary = 'private-path-alpha@example.test';
const runningServers: RunningLocalApi[] = [];
const unlistenedServers: ReturnType<typeof buildApi>[] = [];

function capabilityManifest(): CapabilityManifest {
  return createCurrentCapabilityManifest();
}

function policyCatalog(): PolicyCatalog {
  const catalog = createLocalPolicyCatalog();
  return { schemaVersion: '1.0.0', defaultPolicyId: catalog.defaultPolicyId, policies: catalog.policies };
}

function dependencies(processing?: ProcessingControlPort): ApiDependencies {
  return {
    application: { getCapabilities: () => Promise.resolve(capabilityManifest()) },
    jobs: processing ?? createVolatileJobControl(),
    policies: { get: () => Promise.resolve(policyCatalog()) },
    preview: {
      scan: () => Promise.resolve({
        schemaVersion: '2.0.0', operation: 'SCAN', outcome: 'SUCCEEDED',
        counts: { detections: 0, conflicts: 0, byEntity: {} },
        detections: [], detailsLimited: false, conflicts: [], conflictDetailsLimited: false
      })
    },
    readiness: { check: () => Promise.resolve() },
    ...(processing === undefined ? {} : { processing })
  };
}

function authorization(): Readonly<Record<string, string>> {
  return { host, authorization: `Bearer ${token}` };
}

async function start(deps: ApiDependencies = dependencies()): Promise<RunningLocalApi> {
  const running = await startLocalApi(deps);
  runningServers.push(running);
  return running;
}

async function rawExchange(port: number, requestBytes: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host, port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('RAW_REQUEST_TIMEOUT'));
    }, 2_000);
    socket.on('connect', () => { socket.end(requestBytes); });
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map(async (running) => running.close()));
  await Promise.all(unlistenedServers.splice(0).map(async (server) => server.close()));
});

describe('local API abuse and disconnect evidence', () => {
  it('rejects hostile authentication, authority, origin, and request metadata without reflection', async () => {
    const server = buildApi(dependencies(), {
      session: { bearerToken: token, allowedOrigins: ['http://127.0.0.1:4173'] }
    });
    unlistenedServers.push(server);
    const responses = await Promise.all([
      server.inject({ method: 'GET', url: '/v1/capabilities', headers: { host } }),
      server.inject({
        method: 'GET', url: '/v1/capabilities',
        headers: { host, authorization: `Bearer ${'B'.repeat(4_096)}` }
      }),
      server.inject({
        method: 'GET', url: '/v1/capabilities',
        headers: { host, authorization: `Bearer ${token},Bearer ${token}` }
      }),
      server.inject({
        method: 'GET', url: `/v1/jobs/${encodeURIComponent(canary)}`,
        headers: {
          host: `${canary}:80`, authorization: `Bearer ${token}`, origin: `http://${canary}`,
          forwarded: `for=${canary}`, 'x-forwarded-host': canary, 'x-request-id': canary
        }
      })
    ]);

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([401, 401, 401, 403]);
    for (const response of responses) {
      expect(response.body).not.toContain(canary);
      expect(response.body).not.toContain('BBBB');
      expect(response.body).not.toMatch(/x-forwarded|x-request-id|private-path/u);
    }
  });

  it('rejects path-like artifact metadata and makes unavailable output references indistinguishable', async () => {
    const catalog = createLocalPolicyCatalog();
    const processing = createVolatileProcessingControl(localTextApplication, catalog.policies);
    const server = buildApi(dependencies(processing), { session: { bearerToken: token } });
    unlistenedServers.push(server);
    const bytes = Buffer.from('synthetic', 'utf8');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const malformed = await server.inject({
      method: 'POST', url: '/v1/artifacts', headers: authorization(),
      payload: {
        schemaVersion: '1.0.0', mediaType: 'text/plain', byteLength: bytes.length, digest,
        sourcePath: canary
      }
    });
    const initiated = await server.inject({
      method: 'POST', url: '/v1/artifacts', headers: authorization(),
      payload: { schemaVersion: '1.0.0', mediaType: 'text/plain', byteLength: bytes.length, digest }
    });
    const stagedId = initiated.json<{ readonly id: string }>().id;
    const unavailable = await Promise.all([
      server.inject({ method: 'GET', url: `/v1/artifacts/${stagedId}/content`, headers: authorization() }),
      server.inject({
        method: 'GET', url: '/v1/artifacts/art_01J4M91NJK8WAPJ7J95K73CB2Z/content', headers: authorization()
      })
    ]);

    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain(canary);
    expect(unavailable.map(({ statusCode }) => statusCode)).toEqual([404, 404]);
    expect(unavailable.map((response) => response.json<{ readonly error: unknown }>().error)).toEqual([
      expect.objectContaining({ code: 'AUTHORIZATION_DENIED', message: 'The requested job is unavailable.' }),
      expect.objectContaining({ code: 'AUTHORIZATION_DENIED', message: 'The requested job is unavailable.' })
    ]);
  });

  it.each([
    ['PDF', Buffer.from('%PDF-1.4\n', 'ascii')],
    ['ZIP', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])],
    ['GZIP', Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0])]
  ])('rejects %s container bytes before retaining an artifact', async (_label, bytes) => {
    const catalog = createLocalPolicyCatalog();
    const processing = createVolatileProcessingControl(localTextApplication, catalog.policies);
    const server = buildApi(dependencies(processing), { session: { bearerToken: token } });
    unlistenedServers.push(server);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const initiated = await server.inject({
      method: 'POST', url: '/v1/artifacts', headers: authorization(),
      payload: { schemaVersion: '1.0.0', mediaType: 'text/plain', byteLength: bytes.length, digest }
    });
    const artifactId = initiated.json<{ readonly id: string }>().id;
    const rejected = await server.inject({
      method: 'PUT', url: `/v1/artifacts/${artifactId}/content`,
      headers: { ...authorization(), 'content-type': 'application/octet-stream' }, payload: bytes
    });
    const retry = await server.inject({
      method: 'PUT', url: `/v1/artifacts/${artifactId}/content`,
      headers: { ...authorization(), 'content-type': 'application/octet-stream' }, payload: bytes
    });

    expect(rejected.statusCode).toBe(415);
    expect(rejected.json()).toMatchObject({ error: { code: 'FORMAT_UNSUPPORTED' } });
    expect(retry.statusCode).toBe(403);
    expect(`${rejected.body}${retry.body}`).not.toContain(bytes.toString('hex'));
  });

  it('rejects conflicting framing and chunked oversized JSON at the real socket boundary', async () => {
    const running = await start();
    const conflicting = await rawExchange(running.port, [
      'POST /v1/artifacts HTTP/1.1',
      `Host: ${host}:${String(running.port)}`,
      `Authorization: Bearer ${running.sessionToken}`,
      'Content-Type: application/json',
      'Content-Length: 2',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      '2',
      '{}',
      '0',
      '',
      ''
    ].join('\r\n'));
    const oversized = 'x'.repeat(17 * 1024);
    const oversizedResponse = await rawExchange(running.port, [
      'POST /v1/artifacts HTTP/1.1',
      `Host: ${host}:${String(running.port)}`,
      `Authorization: Bearer ${running.sessionToken}`,
      'Content-Type: application/json',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      oversized.length.toString(16),
      oversized,
      '0',
      '',
      ''
    ].join('\r\n'));

    expect(conflicting).toMatch(/^HTTP\/1\.1 400 /u);
    expect(oversizedResponse).toMatch(/^HTTP\/1\.1 413 /u);
    expect(`${conflicting}${oversizedResponse}`).not.toContain(running.sessionToken);
    expect(`${conflicting}${oversizedResponse}`).not.toContain(canary);
  });

  it('aborts noncooperative response work when the real client disconnects', async () => {
    const catalog = createLocalPolicyCatalog();
    const base = createVolatileProcessingControl(localTextApplication, catalog.policies);
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => { started = resolve; });
    const processing: ProcessingControlPort = {
      ...base,
      downloadOutput(_artifactId, _correlationId, signal) {
        observedSignal = signal;
        started();
        return new Promise(() => undefined);
      }
    };
    const running = await start(dependencies(processing));
    const request = httpRequest({
      host, port: running.port, method: 'GET', path: '/v1/artifacts/art_01J4M91NJK8WAPJ7J95K73CB2M/content',
      headers: { authorization: `Bearer ${running.sessionToken}` }
    });
    request.on('error', () => undefined);
    request.end();
    await operationStarted;
    request.destroy();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('DISCONNECT_ABORT_TIMEOUT')); }, 2_000);
      const poll = (): void => {
        if (observedSignal?.aborted === true) {
          clearTimeout(timer);
          resolve();
        } else setTimeout(poll, 5);
      };
      poll();
    });

    expect(observedSignal?.aborted).toBe(true);
  });
});
