import { describe, expect, it } from 'vitest';

import {
  anchorOllamaModelOutput,
  createOllamaExtractionResponseSchema,
  ollamaExperimentalFixedSeed,
  ollamaExtractionSystemPrompt
} from '@local-pii/provider-ollama';

import {
  assertLoopbackBaseUrl,
  parseOllamaDetections,
  parseOllamaEvaluationArguments,
  runOllamaEvaluation,
  scoreExactDocuments,
  type EvaluationDocumentResult
} from './evaluate-ollama.js';

describe('Ollama evaluation safety boundary', () => {
  it('accepts the package-manager separator and explicit JSON output flag', () => {
    expect(parseOllamaEvaluationArguments(['--', '--json', '--model', 'synthetic-local-model'])).toEqual({
      model: 'synthetic-local-model',
      repeat: 1,
      baseUrl: new URL('http://127.0.0.1:11434'),
      timeoutMs: 60_000
    });
  });

  it('applies the provider model-name boundary to evaluator arguments', () => {
    expect(() => parseOllamaEvaluationArguments(['--model', 'model name with spaces'])).toThrow(TypeError);
    expect(() => parseOllamaEvaluationArguments(['--model', '../model'])).toThrow(TypeError);
  });

  it.each([
    'https://127.0.0.1:11434',
    'http://localhost:11434',
    'http://192.0.2.1:11434',
    'http://example.test:11434',
    'http://user:secret@127.0.0.1:11434',
    'http://127.0.0.1:11434/proxy'
  ])('rejects a noncanonical loopback base URL: %s', (value) => {
    expect(() => assertLoopbackBaseUrl(value)).toThrow(TypeError);
  });

  it.each(['http://127.0.0.1:11434', 'http://127.12.34.56:11434', 'http://[::1]:11434'])(
    'accepts an HTTP IP loopback origin: %s',
    (value) => {
      expect(assertLoopbackBaseUrl(value).origin).toBe(new URL(value).origin);
    }
  );

  it('uses only local metadata and chat APIs and omits document content from the report', async () => {
    const requestedPaths: string[] = [];
    const requestInitializers: RequestInit[] = [];
    const chatBodies: Record<string, unknown>[] = [];
    const fetchImplementation = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      requestedPaths.push(url.pathname);
      requestInitializers.push(init ?? {});
      if (url.pathname === '/api/show') return Promise.resolve(new Response('', { status: 500 }));
      if (url.pathname === '/api/tags') {
        return Promise.resolve(Response.json({ models: [{ name: 'synthetic-local-model:latest', digest: 'a'.repeat(64) }] }));
      }
      if (url.pathname === '/api/chat') {
        if (typeof init?.body !== 'string') throw new TypeError('Expected a serialized chat body.');
        chatBodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return Promise.resolve(Response.json({
          model: 'synthetic-local-model:latest',
          message: { role: 'assistant', content: '{"detections":[]}' },
          done: true,
          total_duration: 1_000_000
        }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    };

    const report = await runOllamaEvaluation({
      model: 'synthetic-local-model',
      repeat: 1,
      baseUrl: new URL('http://127.0.0.1:11434'),
      timeoutMs: 60_000
    }, fetchImplementation);
    const serialized = JSON.stringify(report);

    expect(requestedPaths).not.toContain('/api/pull');
    expect(requestInitializers).not.toHaveLength(0);
    expect(requestInitializers.every(({ redirect }) => redirect === 'error')).toBe(true);
    expect(chatBodies[0]).toMatchObject({
      model: 'synthetic-local-model',
      stream: false,
      options: { temperature: 0, seed: ollamaExperimentalFixedSeed },
      format: createOllamaExtractionResponseSchema(),
      messages: [
        { role: 'system', content: ollamaExtractionSystemPrompt },
        expect.objectContaining({ role: 'user' })
      ]
    });
    expect(report).toMatchObject({
      evaluator: { id: 'local-ollama-verbatim-anchor', version: '2.0.0' },
      model: { reportedName: 'synthetic-local-model:latest', localMetadata: { digest: `sha256:${'a'.repeat(64)}` } },
      resourceUse: { externalProcessRssBytes: { status: 'UNAVAILABLE' } }
    });
    expect(serialized).not.toContain('Mara Vellum');
    expect(serialized).not.toContain('Ivo Quill');
  });
});

describe('Ollama detection parsing', () => {
  it('uses the provider anchor exactly and counts safely deduplicated entries', () => {
    const text = 'A😀éZ';
    const result = parseOllamaDetections(JSON.stringify({
      detections: [
        { entityType: 'PERSON', verbatim: '😀é' },
        { entityType: 'PERSON', verbatim: '😀é' }
      ]
    }), text);

    expect(result).toEqual({
      detections: [{ entityType: 'PERSON', start: 1, end: 4 }],
      invalidSpans: 0,
      duplicateSpans: 1,
      invalidResponse: false
    });
    expect(result.detections).toEqual(anchorOllamaModelOutput(JSON.stringify({
      detections: [{ entityType: 'PERSON', verbatim: '😀é' }]
    }), text).detections);
  });

  it.each(['not-json', '[]', '{"detections":"none"}', '{"detections":[],"text":"prohibited"}'])(
    'marks a malformed response invalid without echoing it: %s',
    (content) => {
      expect(parseOllamaDetections(content, 'plain text')).toEqual({
        detections: [], invalidSpans: 0, duplicateSpans: 0, invalidResponse: true
      });
    }
  );

  it('reports anchor failures without retaining the offending value', () => {
    const canary = 'sensitive-evaluator-canary';
    const result = parseOllamaDetections(JSON.stringify({
      detections: [{ entityType: 'PERSON', verbatim: canary }]
    }), 'plain text');
    expect(result).toEqual({ detections: [], invalidSpans: 1, duplicateSpans: 0, invalidResponse: false });
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});

describe('exact span scorer', () => {
  it('scores exact entity and boundary matches per document', () => {
    const documents: EvaluationDocumentResult[] = [
      {
        expected: [
          { entityType: 'PERSON', start: 0, end: 2 },
          { entityType: 'EMAIL', start: 5, end: 10 }
        ],
        predicted: [
          { entityType: 'PERSON', start: 0, end: 2 },
          { entityType: 'EMAIL', start: 5, end: 9 },
          { entityType: 'PHONE', start: 12, end: 15 }
        ],
        invalidSpans: 2,
        duplicateSpans: 1,
        invalidResponse: false
      },
      {
        expected: [{ entityType: 'PERSON', start: 0, end: 2 }],
        predicted: [],
        invalidSpans: 0,
        duplicateSpans: 0,
        invalidResponse: true
      }
    ];

    expect(scoreExactDocuments(documents)).toEqual({
      perEntity: [
        { entityType: 'EMAIL', truePositives: 0, falsePositives: 1, falseNegatives: 1, precision: 0, recall: 0, f1: 0 },
        { entityType: 'PERSON', truePositives: 1, falsePositives: 0, falseNegatives: 1, precision: 1, recall: 0.5, f1: 0.666667 },
        { entityType: 'PHONE', truePositives: 0, falsePositives: 1, falseNegatives: 0, precision: 0, recall: 0, f1: 0 }
      ],
      invalidSpans: 2,
      duplicateSpans: 1,
      invalidResponses: 1
    });
  });

  it('keeps equal offsets in different documents independent', () => {
    expect(scoreExactDocuments([
      {
        expected: [{ entityType: 'PERSON', start: 0, end: 1 }],
        predicted: [{ entityType: 'PERSON', start: 0, end: 1 }],
        invalidSpans: 0,
        duplicateSpans: 0,
        invalidResponse: false
      },
      {
        expected: [],
        predicted: [{ entityType: 'PERSON', start: 0, end: 1 }],
        invalidSpans: 0,
        duplicateSpans: 0,
        invalidResponse: false
      }
    ]).perEntity).toEqual([
      { entityType: 'PERSON', truePositives: 1, falsePositives: 1, falseNegatives: 0, precision: 0.5, recall: 1, f1: 0.666667 }
    ]);
  });
});
