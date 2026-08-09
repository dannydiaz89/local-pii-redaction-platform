import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

import { SafeError, parseSha256Digest } from '@local-pii/domain';
import { describe, expect, it } from 'vitest';

import {
  assertOllamaLoopbackEndpoint,
  createOllamaTextDetectionProvider,
  ollamaLocalDetectorBundleVersion
} from '../src/index.js';

const model = 'phi4-mini';
const digest = 'a'.repeat(64);
const revision = parseSha256Digest(`sha256:${'b'.repeat(64)}`);

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

async function localServer(handler: Handler): Promise<{ readonly endpoint: string; readonly close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => { void handler(request, response); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address.');
  return {
    endpoint: `http://127.0.0.1:${String(address.port)}`,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  };
}

function installed(response: ServerResponse): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ models: [{ name: `${model}:latest`, digest }] }));
}

function envelope(content: unknown): string {
  return JSON.stringify({ model: `${model}:latest`, message: { role: 'assistant', content: JSON.stringify(content) }, done: true });
}

function safeCode(error: unknown): string | undefined {
  return error instanceof SafeError ? error.code : undefined;
}

describe('OllamaTextDetectionProvider', () => {
  it('uses an installed pinned local model and returns DOB evidence with Unicode code-point spans', async () => {
    const text = '😀 Ada was born 1980-01-02.';
    const start = Array.from(text).indexOf('1');
    const end = start + Array.from('1980-01-02').length;
    let requestBody: unknown;
    let tagRequests = 0;
    const server = await localServer(async (request, response) => {
      if (request.url === '/api/tags') {
        tagRequests += 1;
        installed(response);
        return;
      }
      let requestText = '';
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new TypeError('Expected a Buffer request chunk.');
        requestText += chunk.toString('utf8');
      }
      requestBody = JSON.parse(requestText) as unknown;
      response.setHeader('content-type', 'application/json');
      response.end(envelope({ detections: [{ entityType: 'DATE_OF_BIRTH', start, end, confidence: 0.93 }] }));
    });
    try {
      const provider = createOllamaTextDetectionProvider({ model, endpoint: server.endpoint });
      await provider.prepare();
      await provider.prepare();
      expect(tagRequests).toBe(1);
      const evidence = await provider.detect(text, revision);
      expect(evidence).toHaveLength(1);
      const first = evidence[0];
      if (first === undefined) throw new Error('Expected one detection.');
      expect(first.entityType).toBe('DATE_OF_BIRTH');
      expect(first.confidence).toBe(0.93);
      expect(first.source).toBe('MODEL');
      expect(first.span).toEqual({ start, end, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision: revision });
      expect(first.detector.id).toBe('ollama-local-model');
      expect(first.detector.version).toBe(`${ollamaLocalDetectorBundleVersion}.sha256-${digest}`);
      expect(first.detector.ruleId).toMatch(/^model-[a-f0-9]{24}$/u);
      expect(provider.detectorBundleVersion).toBe(`${ollamaLocalDetectorBundleVersion}.sha256-${digest}`);
      expect(requestBody).toEqual(expect.objectContaining({ model, stream: false }));
      expect(JSON.stringify(evidence)).not.toContain(model);

      const again = await provider.detect(text, revision);
      expect(again[0]?.id).toBe(evidence[0]?.id);
    } finally {
      await server.close();
    }
  });

  it('rejects any malformed, duplicate, or value-bearing model candidate without leaking it', async () => {
    const secret = 'super-secret@example.test';
    let chatRequests = 0;
    const server = await localServer((request, response) => {
      if (request.url === '/api/tags') {
        installed(response);
        return;
      }
      chatRequests += 1;
      response.setHeader('content-type', 'application/json');
      response.end(envelope(chatRequests === 1
        ? { detections: [{ entityType: 'EMAIL', start: 0, end: 2, confidence: 0.9 }] }
        : { detections: [{ entityType: 'PERSON', start: 0, end: 2, confidence: 0.9, value: secret }] }));
    });
    try {
      const provider = createOllamaTextDetectionProvider({ model, endpoint: server.endpoint });
      const failure = await provider.detect('ab', revision).catch((error: unknown) => error);
      expect(safeCode(failure)).toBe('MODEL_OUTPUT_INVALID');
      const valueBearingFailure = await provider.detect('ab', revision).catch((error: unknown) => error);
      expect(safeCode(valueBearingFailure)).toBe('MODEL_OUTPUT_INVALID');
      expect(failure).toBeInstanceOf(SafeError);
      expect((valueBearingFailure as Error).message).not.toContain(secret);
      expect(JSON.stringify(valueBearingFailure)).not.toContain(secret);
      expect(JSON.stringify(valueBearingFailure)).not.toContain(model);
    } finally {
      await server.close();
    }
  });

  it('rejects duplicate spans and a requested model that lacks a pinned local digest', async () => {
    let tagCall = 0;
    const server = await localServer((request, response) => {
      if (request.url === '/api/tags') {
        tagCall += 1;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ models: tagCall === 1 ? [{ name: `${model}:latest`, digest }] : [{ name: `${model}:latest`, digest: 'not-a-digest' }] }));
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(envelope({ detections: [
        { entityType: 'EMAIL', start: 0, end: 2, confidence: 0.9 },
        { entityType: 'PHONE', start: 0, end: 2, confidence: 0.8 }
      ] }));
    });
    try {
      const duplicateProvider = createOllamaTextDetectionProvider({ model, endpoint: server.endpoint });
      const duplicateFailure = await duplicateProvider.detect('ab', revision).catch((error: unknown) => error);
      expect(safeCode(duplicateFailure)).toBe('MODEL_OUTPUT_INVALID');

      const unavailableProvider = createOllamaTextDetectionProvider({ model, endpoint: server.endpoint });
      const unavailableFailure = await unavailableProvider.prepare().catch((error: unknown) => error);
      expect(safeCode(unavailableFailure)).toBe('MODEL_UNAVAILABLE');
    } finally {
      await server.close();
    }
  });

  it('rejects incomplete responses, non-assistant messages, and model identity changes', async () => {
    let chatRequests = 0;
    const server = await localServer((request, response) => {
      if (request.url === '/api/tags') {
        installed(response);
        return;
      }
      chatRequests += 1;
      response.setHeader('content-type', 'application/json');
      const base = JSON.parse(envelope({ detections: [] })) as Record<string, unknown>;
      if (chatRequests === 1) base.done = false;
      if (chatRequests === 2) base.message = { role: 'user', content: JSON.stringify({ detections: [] }) };
      if (chatRequests === 3) base.model = 'different:latest';
      response.end(JSON.stringify(base));
    });
    try {
      const provider = createOllamaTextDetectionProvider({ model, endpoint: server.endpoint });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const failure = await provider.detect('ab', revision).catch((error: unknown) => error);
        expect(safeCode(failure)).toBe('MODEL_OUTPUT_INVALID');
      }
    } finally {
      await server.close();
    }
  });

  it('fails closed when a mutable model tag changes during detection', async () => {
    let tagRequests = 0;
    const server = await localServer((request, response) => {
      if (request.url === '/api/tags') {
        tagRequests += 1;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          models: [{ name: `${model}:latest`, digest: (tagRequests === 1 ? 'a' : 'c').repeat(64) }]
        }));
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(envelope({ detections: [] }));
    });
    try {
      const provider = createOllamaTextDetectionProvider({ model, endpoint: server.endpoint });
      const failure = await provider.detect('ab', revision).catch((error: unknown) => error);
      expect(safeCode(failure)).toBe('MODEL_UNAVAILABLE');
      expect(tagRequests).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('maps timeout and caller cancellation to privacy-safe timeout errors', async () => {
    const server = await localServer((request, response) => {
      if (request.url === '/api/tags') {
        installed(response);
        return;
      }
      setTimeout(() => response.end(envelope({ detections: [] })), 500);
    });
    try {
      const timedOut = createOllamaTextDetectionProvider({ model, endpoint: server.endpoint, timeoutMs: 10 });
      const timeoutFailure = await timedOut.detect('ab', revision).catch((error: unknown) => error);
      expect(safeCode(timeoutFailure)).toBe('DETECTOR_TIMEOUT');
      expect((timeoutFailure as SafeError).details).toMatchObject({ deadlineExceeded: true });

      const controller = new AbortController();
      const cancelled = createOllamaTextDetectionProvider({ model, endpoint: server.endpoint, timeoutMs: 1_000 });
      const pending = cancelled.detect('ab', revision, controller.signal).catch((error: unknown) => error);
      setTimeout(() => { controller.abort(); }, 10);
      const cancellationFailure = await pending;
      expect(safeCode(cancellationFailure)).toBe('DETECTOR_TIMEOUT');
      expect((cancellationFailure as SafeError).details).toMatchObject({ deadlineExceeded: false });
    } finally {
      await server.close();
    }
  });

  it('enforces response and input bounds before model output can enter the pipeline', async () => {
    const server = await localServer((request, response) => {
      if (request.url === '/api/tags') {
        installed(response);
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(envelope({ detections: [], padding: 'x'.repeat(10_000) }));
    });
    try {
      const limited = createOllamaTextDetectionProvider({ model, endpoint: server.endpoint, maximumResponseBytes: 500 });
      const responseFailure = await limited.detect('ab', revision).catch((error: unknown) => error);
      expect(safeCode(responseFailure)).toBe('MODEL_OUTPUT_INVALID');

      const inputLimited = createOllamaTextDetectionProvider({ model, endpoint: server.endpoint, maximumInputCodePoints: 1, maximumInputBytes: 10 });
      const inputFailure = await inputLimited.detect('😀😀', revision).catch((error: unknown) => error);
      expect(safeCode(inputFailure)).toBe('INPUT_TOO_LARGE');
    } finally {
      await server.close();
    }
  });

  it('allows only numeric loopback origins and never accepts credentials or a query', () => {
    expect(assertOllamaLoopbackEndpoint('http://127.0.0.1:11434')).toBeInstanceOf(URL);
    expect(assertOllamaLoopbackEndpoint('http://127.0.0.42:11434')).toBeInstanceOf(URL);
    expect(assertOllamaLoopbackEndpoint('http://[::1]:11434')).toBeInstanceOf(URL);
    for (const endpoint of [
      'http://localhost:11434', 'http://0.0.0.0:11434', 'https://127.0.0.1:11434',
      'http://user:pass@127.0.0.1:11434', 'http://127.0.0.1:11434?remote=true'
    ]) {
      expect(() => assertOllamaLoopbackEndpoint(endpoint)).toThrow(TypeError);
    }
  });
});
