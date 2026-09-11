import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SafeError, parseSha256Digest } from '@local-pii/domain';

import {
  FrameDecoder,
  chunkCanonicalText,
  createInferenceTextDetectionProvider,
  inferenceLocalDetectorId,
  type InferenceTextDetectionProvider,
  type SpawnImplementation
} from '../src/index.js';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const pythonExecutable = resolve(repositoryRoot, '.venv/bin/python');
const bundleDirectory = resolve(repositoryRoot, 'fixtures/models/synthetic-lexicon-v1');
const revision = parseSha256Digest(`sha256:${'d'.repeat(64)}`);
const providers: InferenceTextDetectionProvider[] = [];
const directories: string[] = [];

interface FakeBehaviour {
  readonly model: { id: string; version: string; digest: string; runtime: string };
  readonly entityTypes: readonly string[];
  readonly detections?: readonly { entityType: string; start: number; end: number; confidence: number }[];
  readonly responseModel?: { id: string; version: string; digest: string; runtime: string };
  readonly exitOnReady?: boolean;
  readonly silent?: boolean;
}

/** A scripted stand-in for the Python service, driven over the same frame protocol. */
function fakeService(behaviour: FakeBehaviour): SpawnImplementation {
  const script = `
    const behaviour = ${JSON.stringify(behaviour)};
    let buffer = Buffer.alloc(0);
    const write = (message) => {
      const payload = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4); header.writeUInt32BE(payload.length, 0);
      process.stdout.write(Buffer.concat([header, payload]));
    };
    const handle = (message) => {
      if (message.type === 'ready') {
        if (behaviour.exitOnReady) process.exit(0);
        write({ type: 'ready', ok: true, model: behaviour.model });
      } else if (message.type === 'capabilities') {
        write({ type: 'capabilities', ok: true, capabilities: {
          protocolVersions: ['1.0.0'], model: behaviour.model, detector: { id: 'fake', version: '0.0.1' },
          entityTypes: behaviour.entityTypes, languages: ['en'], limits: {}, qualification: 'SYNTHETIC' } });
      } else if (message.type === 'detect') {
        if (behaviour.silent) return;
        const request = message.request;
        const detections = (behaviour.detections ?? []).map((d) => ({ ...d, chunkId: request.chunks[0].id, detector: { id: 'fake', version: '0.0.1' } }));
        write({ type: 'detect', ok: true, response: { schemaVersion: '1.0.0', requestId: request.requestId, detections, model: behaviour.responseModel ?? behaviour.model, warnings: [] } });
      }
    };
    process.stdin.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) break;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
        buffer = buffer.subarray(4 + length);
        handle(message);
      }
    });
  `;
  return () => spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
}

async function manifest(): Promise<{ model: FakeBehaviour['model']; entityTypes: string[] }> {
  const parsed = JSON.parse(await readFile(join(bundleDirectory, 'manifest.json'), 'utf8')) as {
    id: string; version: string; modelDigest: string; runtime: string; entityTypes: string[];
  };
  // Keep the identity free of extra fields: the response contract closes the model object.
  return {
    model: { id: parsed.id, version: parsed.version, digest: parsed.modelDigest, runtime: parsed.runtime },
    entityTypes: parsed.entityTypes
  };
}

function track(provider: InferenceTextDetectionProvider): InferenceTextDetectionProvider {
  providers.push(provider);
  return provider;
}

async function failure(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
    return 'RESOLVED';
  } catch (error: unknown) {
    return error instanceof SafeError ? error.code : 'NOT_SAFE_ERROR';
  }
}

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('frame protocol helpers', () => {
  it('decodes frames split across chunks and rejects oversized frames', () => {
    const decoder = new FrameDecoder(64);
    const payload = Buffer.from(JSON.stringify({ type: 'ready' }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    const frame = Buffer.concat([header, payload]);
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3, 9))).toEqual([]);
    expect(decoder.push(Buffer.concat([frame.subarray(9), frame]))).toEqual([{ type: 'ready' }, { type: 'ready' }]);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(65, 0);
    expect(() => decoder.push(oversized)).toThrow(RangeError);
  });

  it('chunks by Unicode code point with absolute code-point starts', () => {
    expect(chunkCanonicalText('😀ab', 2)).toEqual([
      { id: 'chunk-1', text: '😀a', absoluteStart: 0 },
      { id: 'chunk-2', text: 'b', absoluteStart: 2 }
    ]);
  });
});

describe('InferenceTextDetectionProvider', () => {
  it('runs the real subprocess profile against the synthetic bundle and returns anchored evidence', async () => {
    const provider = track(createInferenceTextDetectionProvider({ bundleDirectory, pythonExecutable, timeoutMs: 30_000 }));
    await provider.prepare();
    expect(provider.capabilities).toMatchObject({ qualification: 'SYNTHETIC', model: { id: 'synthetic-lexicon' } });
    expect(provider.capabilities?.entityTypes).toHaveLength(6);
    expect(provider.detectorBundleVersion).toMatch(/^0\.1\.0-inference-experimental\.1\.sha256-[a-f0-9]{64}$/u);

    const text = '😀 Mara Vellum was born 1988-02-29.';
    const evidence = await provider.detect(text, revision);
    const person = evidence.find((item) => item.entityType === 'PERSON');
    const dob = evidence.find((item) => item.entityType === 'DATE_OF_BIRTH');
    expect(person?.span).toEqual({ start: 2, end: 13, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision: revision });
    expect(dob?.span).toMatchObject({ start: 23, end: 33 });
    expect(person?.source).toBe('MODEL');
    expect(person?.confidence).toBe(0.93);
    expect(person?.detector).toMatchObject({ id: inferenceLocalDetectorId, version: provider.detectorBundleVersion });
    expect(JSON.stringify(evidence)).not.toContain('Mara');
    const again = await provider.detect(text, revision);
    expect(again.map(({ id }) => id)).toEqual(evidence.map(({ id }) => id));
  });

  it('fails closed with a supply-chain error for a tampered bundle without exposing paths', async () => {
    const tampered = await mkdtemp(join(tmpdir(), 'local-pii-bundle-'));
    directories.push(tampered);
    await cp(bundleDirectory, tampered, { recursive: true });
    await writeFile(join(tampered, 'model.json'), '{}');
    const provider = track(createInferenceTextDetectionProvider({ bundleDirectory: tampered, pythonExecutable, timeoutMs: 30_000 }));
    const error = await provider.prepare().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SafeError);
    expect((error as SafeError).code).toBe('SUPPLY_CHAIN_INVALID');
    expect(JSON.stringify(error)).not.toContain(tampered);
  });

  it('rejects a service whose reported model differs from the on-disk manifest', async () => {
    const { model, entityTypes } = await manifest();
    const provider = track(createInferenceTextDetectionProvider({
      bundleDirectory,
      spawnImplementation: fakeService({ model: { ...model, digest: `sha256:${'b'.repeat(64)}` }, entityTypes })
    }));
    expect(await failure(provider.prepare())).toBe('SUPPLY_CHAIN_INVALID');
  });

  it('rejects out-of-range spans and a model that changes between readiness and detection', async () => {
    const { model, entityTypes } = await manifest();
    const outOfRange = track(createInferenceTextDetectionProvider({
      bundleDirectory,
      spawnImplementation: fakeService({ model, entityTypes, detections: [{ entityType: 'PERSON', start: 0, end: 999, confidence: 0.5 }] })
    }));
    expect(await failure(outOfRange.detect('short text', revision))).toBe('MODEL_OUTPUT_INVALID');

    const changed = track(createInferenceTextDetectionProvider({
      bundleDirectory,
      spawnImplementation: fakeService({
        model, entityTypes,
        detections: [{ entityType: 'PERSON', start: 0, end: 2, confidence: 0.5 }],
        responseModel: { ...model, digest: `sha256:${'c'.repeat(64)}` }
      })
    }));
    expect(await failure(changed.detect('ab', revision))).toBe('MODEL_UNAVAILABLE');
  });

  it('treats an exiting or silent service as unavailable or timed out, never as a clean result', async () => {
    const { model, entityTypes } = await manifest();
    const exiting = track(createInferenceTextDetectionProvider({
      bundleDirectory, spawnImplementation: fakeService({ model, entityTypes, exitOnReady: true })
    }));
    expect(await failure(exiting.prepare())).toBe('MODEL_UNAVAILABLE');

    const silent = track(createInferenceTextDetectionProvider({
      bundleDirectory, timeoutMs: 1_000, spawnImplementation: fakeService({ model, entityTypes, silent: true })
    }));
    expect(await failure(silent.detect('ab', revision))).toBe('DETECTOR_TIMEOUT');
  });

  it('refuses oversized input before contacting the service', async () => {
    const { model, entityTypes } = await manifest();
    let spawned = 0;
    const provider = track(createInferenceTextDetectionProvider({
      bundleDirectory,
      spawnImplementation: (executable, args) => { spawned += 1; return fakeService({ model, entityTypes })(executable, args); }
    }));
    await provider.prepare();
    expect(await failure(provider.detect('x'.repeat(20_001), revision))).toBe('INPUT_TOO_LARGE');
    expect(spawned).toBe(1);
  });
});
