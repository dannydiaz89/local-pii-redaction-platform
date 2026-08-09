import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { entityTypes } from '../packages/domain/src/index.js';
import { contextualEntityTypes, createContextualCorpus } from './contextual-corpus.js';

const defaultBaseUrl = 'http://127.0.0.1:11434';
const fixedSeed = 20260808;
const defaultTimeoutMs = 60_000;
const maximumResponseBytes = 1_000_000;
const systemPrompt = 'Identify sensitive entities in the supplied text. Return exact half-open Unicode code-point offsets only. Never return matched values, excerpts, explanations, or additional fields.';

export interface EvaluationSpan {
  readonly entityType: string;
  readonly start: number;
  readonly end: number;
}

export interface ParsedDetections {
  readonly detections: readonly EvaluationSpan[];
  readonly invalidSpans: number;
  readonly duplicateSpans: number;
  readonly invalidResponse: boolean;
}

export interface EntityMetrics {
  readonly entityType: string;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface EvaluationDocumentResult {
  readonly expected: readonly EvaluationSpan[];
  readonly predicted: readonly EvaluationSpan[];
  readonly invalidSpans: number;
  readonly duplicateSpans: number;
  readonly invalidResponse: boolean;
}

export interface ExactScore {
  readonly perEntity: readonly EntityMetrics[];
  readonly invalidSpans: number;
  readonly duplicateSpans: number;
  readonly invalidResponses: number;
}

export interface OllamaChatApiResponse {
  readonly model: string | undefined;
  readonly content: string;
  readonly apiDurationMs: number | undefined;
}

export interface ModelMetadata {
  readonly name: string;
  readonly digest: string | undefined;
  readonly modifiedAt: string | undefined;
  readonly size: number | undefined;
  readonly format: string | undefined;
  readonly family: string | undefined;
  readonly parameterSize: string | undefined;
  readonly quantizationLevel: string | undefined;
}

interface DurationSummary {
  readonly count: number;
  readonly minimumMs: number;
  readonly maximumMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface OllamaEvaluationOptions {
  readonly model: string;
  readonly repeat: number;
  readonly baseUrl: URL;
  readonly timeoutMs: number;
}

interface ChatResult {
  readonly parsed: ParsedDetections;
  readonly model: string | undefined;
  readonly latencyMs: number;
  readonly apiDurationMs: number | undefined;
}

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, maximumLength = 200): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength ? value : undefined;
}

function safeDigest(value: unknown): string | undefined {
  const digest = safeString(value);
  if (digest === undefined) return undefined;
  return /^[a-f0-9]{64}$/.test(digest) ? `sha256:${digest}` : digest;
}

function optionalNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function spanKey(span: EvaluationSpan): string {
  return `${span.entityType}\u001f${String(span.start)}\u001f${String(span.end)}`;
}

function compareSpans(left: EvaluationSpan, right: EvaluationSpan): number {
  return left.start - right.start || left.end - right.end || left.entityType.localeCompare(right.entityType);
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

export function assertLoopbackBaseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError('The Ollama base URL is invalid.');
  }
  const hostname = url.hostname.toLowerCase();
  const ipv4Parts = hostname.split('.').map((part) => Number(part));
  const ipv4Loopback = ipv4Parts.length === 4
    && ipv4Parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && ipv4Parts[0] === 127;
  const ipv6Loopback = hostname === '[::1]' || hostname === '::1';
  if (
    url.protocol !== 'http:'
    || url.username.length > 0
    || url.password.length > 0
    || (!ipv4Loopback && !ipv6Loopback)
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    throw new TypeError('The Ollama base URL must be an uncredentialed HTTP loopback origin.');
  }
  return url;
}

export function parseOllamaDetections(
  content: string,
  textCodePointLength: number,
  allowedEntityTypes: readonly string[] = entityTypes
): ParsedDetections {
  if (!Number.isSafeInteger(textCodePointLength) || textCodePointLength < 0 || content.length > maximumResponseBytes) {
    return { detections: [], invalidSpans: 0, duplicateSpans: 0, invalidResponse: true };
  }
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    return { detections: [], invalidSpans: 0, duplicateSpans: 0, invalidResponse: true };
  }
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'detections') || !Array.isArray(value.detections)) {
    return { detections: [], invalidSpans: 0, duplicateSpans: 0, invalidResponse: true };
  }

  const allowed = new Set(allowedEntityTypes);
  const seen = new Set<string>();
  const detections: EvaluationSpan[] = [];
  let invalidSpans = 0;
  let duplicateSpans = 0;
  for (const candidate of value.detections) {
    if (
      !isRecord(candidate)
      || Object.keys(candidate).some((key) => !['entityType', 'start', 'end'].includes(key))
      || typeof candidate.entityType !== 'string'
      || !allowed.has(candidate.entityType)
      || !Number.isSafeInteger(candidate.start)
      || !Number.isSafeInteger(candidate.end)
      || (candidate.start as number) < 0
      || (candidate.start as number) >= (candidate.end as number)
      || (candidate.end as number) > textCodePointLength
    ) {
      invalidSpans += 1;
      continue;
    }
    const span: EvaluationSpan = {
      entityType: candidate.entityType,
      start: candidate.start as number,
      end: candidate.end as number
    };
    const key = spanKey(span);
    if (seen.has(key)) {
      duplicateSpans += 1;
      continue;
    }
    seen.add(key);
    detections.push(span);
  }
  detections.sort(compareSpans);
  return { detections, invalidSpans, duplicateSpans, invalidResponse: false };
}

export function parseOllamaChatApiResponse(value: unknown): OllamaChatApiResponse {
  if (!isRecord(value) || !isRecord(value.message) || typeof value.message.content !== 'string') {
    throw new TypeError('Ollama returned an invalid chat response.');
  }
  if (value.message.content.length > maximumResponseBytes) {
    throw new TypeError('Ollama returned an oversized chat response.');
  }
  const totalDuration = optionalNonnegativeNumber(value.total_duration);
  return {
    model: safeString(value.model),
    content: value.message.content,
    apiDurationMs: totalDuration === undefined ? undefined : totalDuration / 1_000_000
  };
}

export function scoreExactDocuments(documents: readonly EvaluationDocumentResult[]): ExactScore {
  const counts = new Map<string, { truePositives: number; falsePositives: number; falseNegatives: number }>();
  let invalidSpans = 0;
  let duplicateSpans = 0;
  let invalidResponses = 0;

  const entityCounts = (entityType: string): { truePositives: number; falsePositives: number; falseNegatives: number } => {
    const existing = counts.get(entityType);
    if (existing !== undefined) return existing;
    const created = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
    counts.set(entityType, created);
    return created;
  };

  for (const document of documents) {
    invalidSpans += document.invalidSpans;
    duplicateSpans += document.duplicateSpans;
    if (document.invalidResponse) invalidResponses += 1;
    const expected = new Set(document.expected.map(spanKey));
    const predicted = new Set(document.predicted.map(spanKey));
    for (const span of document.expected) {
      const values = entityCounts(span.entityType);
      if (predicted.has(spanKey(span))) values.truePositives += 1;
      else values.falseNegatives += 1;
    }
    for (const span of document.predicted) {
      if (!expected.has(spanKey(span))) entityCounts(span.entityType).falsePositives += 1;
    }
  }

  const perEntity = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([entityType, values]) => {
    const precisionDenominator = values.truePositives + values.falsePositives;
    const recallDenominator = values.truePositives + values.falseNegatives;
    const precision = precisionDenominator === 0 ? 0 : values.truePositives / precisionDenominator;
    const recall = recallDenominator === 0 ? 0 : values.truePositives / recallDenominator;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return {
      entityType,
      truePositives: values.truePositives,
      falsePositives: values.falsePositives,
      falseNegatives: values.falseNegatives,
      precision: round(precision),
      recall: round(recall),
      f1: round(f1)
    };
  });
  return { perEntity, invalidSpans, duplicateSpans, invalidResponses };
}

function durationSummary(values: readonly number[]): DurationSummary {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return { count: 0, minimumMs: 0, maximumMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0 };
  const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    minimumMs: round(sorted[0] ?? 0),
    maximumMs: round(sorted.at(-1) ?? 0),
    meanMs: round(total / sorted.length),
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95))
  };
}

function modelMatches(requested: string, available: string): boolean {
  return available === requested || (!requested.includes(':') && available === `${requested}:latest`);
}

function parseTagsMetadata(value: unknown, requestedModel: string): ModelMetadata | undefined {
  if (!isRecord(value) || !Array.isArray(value.models)) return undefined;
  for (const candidate of value.models) {
    if (!isRecord(candidate)) continue;
    const name = safeString(candidate.name) ?? safeString(candidate.model);
    if (name === undefined || !modelMatches(requestedModel, name)) continue;
    const details = isRecord(candidate.details) ? candidate.details : {};
    return {
      name,
      digest: safeDigest(candidate.digest),
      modifiedAt: safeString(candidate.modified_at),
      size: optionalNonnegativeNumber(candidate.size),
      format: safeString(details.format),
      family: safeString(details.family),
      parameterSize: safeString(details.parameter_size),
      quantizationLevel: safeString(details.quantization_level)
    };
  }
  return undefined;
}

function parseShowMetadata(value: unknown, requestedModel: string): ModelMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const details = isRecord(value.details) ? value.details : {};
  const name = safeString(value.name) ?? safeString(value.model) ?? requestedModel;
  return {
    name,
    digest: safeDigest(value.digest),
    modifiedAt: safeString(value.modified_at),
    size: optionalNonnegativeNumber(value.size),
    format: safeString(details.format),
    family: safeString(details.family),
    parameterSize: safeString(details.parameter_size),
    quantizationLevel: safeString(details.quantization_level)
  };
}

function mergeModelMetadata(
  primary: ModelMetadata | undefined,
  secondary: ModelMetadata | undefined
): ModelMetadata | undefined {
  if (primary === undefined) return secondary;
  if (secondary === undefined) return primary;
  return {
    name: primary.name,
    digest: primary.digest ?? secondary.digest,
    modifiedAt: primary.modifiedAt ?? secondary.modifiedAt,
    size: primary.size ?? secondary.size,
    format: primary.format ?? secondary.format,
    family: primary.family ?? secondary.family,
    parameterSize: primary.parameterSize ?? secondary.parameterSize,
    quantizationLevel: primary.quantizationLevel ?? secondary.quantizationLevel
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (body.length > maximumResponseBytes) throw new TypeError('Ollama returned an oversized API response.');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new TypeError('Ollama returned invalid JSON.');
  }
}

async function readModelMetadataBestEffort(
  fetchImplementation: FetchImplementation,
  baseUrl: URL,
  model: string
): Promise<ModelMetadata | undefined> {
  const safeRequest = async (request: Promise<Response>): Promise<unknown> => {
    try {
      const response = await request;
      return response.ok ? await readJsonResponse(response) : undefined;
    } catch {
      return undefined;
    }
  };
  const [showValue, tagsValue] = await Promise.all([
    safeRequest(fetchImplementation(new URL('/api/show', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, verbose: false })
      })),
    safeRequest(fetchImplementation(new URL('/api/tags', baseUrl), { method: 'GET' }))
  ]);
  return mergeModelMetadata(
    parseShowMetadata(showValue, model),
    parseTagsMetadata(tagsValue, model)
  );
}

function responseSchema(): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['detections'],
    properties: {
      detections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['entityType', 'start', 'end'],
          properties: {
            entityType: { type: 'string', enum: [...contextualEntityTypes] },
            start: { type: 'integer', minimum: 0 },
            end: { type: 'integer', minimum: 1 }
          }
        }
      }
    }
  };
}

async function chat(
  fetchImplementation: FetchImplementation,
  baseUrl: URL,
  model: string,
  text: string,
  timeoutMs: number
): Promise<ChatResult> {
  const started = performance.now();
  const response = await fetchImplementation(new URL('/api/chat', baseUrl), {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: responseSchema(),
      options: { temperature: 0, seed: fixedSeed },
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        { role: 'user', content: text }
      ]
    })
  });
  const latencyMs = performance.now() - started;
  if (!response.ok) throw new Error(`Ollama chat failed with HTTP ${String(response.status)}.`);
  const api = parseOllamaChatApiResponse(await readJsonResponse(response));
  return {
    parsed: parseOllamaDetections(api.content, Array.from(text).length, contextualEntityTypes),
    model: api.model,
    latencyMs,
    apiDurationMs: api.apiDurationMs
  };
}

export function parseOllamaEvaluationArguments(argv: readonly string[]): OllamaEvaluationOptions | 'HELP' {
  let model: string | undefined;
  let repeat = 1;
  let baseUrl = defaultBaseUrl;
  let timeoutMs = defaultTimeoutMs;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--help' || argument === '-h') return 'HELP';
    if (argument === '--json') continue;
    if (argument === '--model') {
      model = argv[index + 1];
      index += 1;
    } else if (argument === '--repeat') {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 20) throw new TypeError('--repeat must be an integer from 1 through 20.');
      repeat = value;
      index += 1;
    } else if (argument === '--base-url') {
      baseUrl = argv[index + 1] ?? '';
      index += 1;
    } else if (argument === '--timeout-ms') {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
        throw new TypeError('--timeout-ms must be an integer from 1000 through 300000.');
      }
      timeoutMs = value;
      index += 1;
    } else {
      throw new TypeError('Unknown evaluation argument.');
    }
  }
  if (model === undefined || model.length === 0 || model.length > 200 || model.startsWith('-')) {
    throw new TypeError('--model is required.');
  }
  return { model, repeat, baseUrl: assertLoopbackBaseUrl(baseUrl), timeoutMs };
}

const usage = `Usage: pnpm eval:ollama -- --model <local-model> [--json] [--repeat <1-20>] [--timeout-ms <1000-300000>] [--base-url http://127.0.0.1:11434]\n`;

export async function runOllamaEvaluation(
  options: OllamaEvaluationOptions,
  fetchImplementation: FetchImplementation = fetch
): Promise<object> {
  const metadata = await readModelMetadataBestEffort(fetchImplementation, options.baseUrl, options.model);
  const corpus = createContextualCorpus();
  const documents = corpus.docs;
  const results: EvaluationDocumentResult[] = [];
  const latencies: number[] = [];
  const apiDurations: number[] = [];
  const runDigests: string[] = [];
  let reportedModel: string | undefined;

  for (let repetition = 0; repetition < options.repeat; repetition += 1) {
    const repeatPredictions: {
      readonly documentId: string;
      readonly detections: readonly EvaluationSpan[];
      readonly invalidSpans: number;
      readonly duplicateSpans: number;
      readonly invalidResponse: boolean;
    }[] = [];
    for (const document of documents) {
      const result = await chat(fetchImplementation, options.baseUrl, options.model, document.text, options.timeoutMs);
      reportedModel ??= result.model;
      latencies.push(result.latencyMs);
      if (result.apiDurationMs !== undefined) apiDurations.push(result.apiDurationMs);
      const expected = document.entities.map(({ entityType, start, end }) => ({ entityType, start, end }));
      results.push({
        expected,
        predicted: result.parsed.detections,
        invalidSpans: result.parsed.invalidSpans,
        duplicateSpans: result.parsed.duplicateSpans,
        invalidResponse: result.parsed.invalidResponse
      });
      repeatPredictions.push({
        documentId: document.id,
        detections: result.parsed.detections,
        invalidSpans: result.parsed.invalidSpans,
        duplicateSpans: result.parsed.duplicateSpans,
        invalidResponse: result.parsed.invalidResponse
      });
    }
    runDigests.push(sha256Json(repeatPredictions));
  }

  const uniqueRunDigests = [...new Set(runDigests)].sort();
  return {
    schemaVersion: '1.0.0',
    evaluator: {
      id: 'local-ollama-exact-span',
      version: '1.0.0',
      offsetUnit: 'UNICODE_CODE_POINT',
      promptDigest: sha256Json(systemPrompt),
      responseSchemaDigest: sha256Json(responseSchema()),
      temperature: 0,
      seed: fixedSeed
    },
    model: {
      requestedName: options.model,
      reportedName: reportedModel,
      localMetadata: metadata
    },
    corpus: {
      id: corpus.manifest.corpusId,
      digest: corpus.manifest.corpusDigest,
      qualification: corpus.manifest.qualification,
      documentCount: documents.length,
      splits: [...new Set(documents.map(({ split }) => split))].sort(),
      repeats: options.repeat,
      requestTimeoutMs: options.timeoutMs,
      evaluatedDocumentRuns: results.length
    },
    metrics: scoreExactDocuments(results),
    timing: {
      latency: durationSummary(latencies),
      apiDuration: durationSummary(apiDurations)
    },
    resourceUse: {
      externalProcessRssBytes: { status: 'UNAVAILABLE' }
    },
    repeatability: {
      repeatable: uniqueRunDigests.length === 1,
      uniqueOutputs: uniqueRunDigests.length,
      digest: sha256Json(uniqueRunDigests)
    }
  };
}

async function main(): Promise<void> {
  try {
    const options = parseOllamaEvaluationArguments(process.argv.slice(2));
    if (options === 'HELP') {
      process.stdout.write(usage);
      return;
    }
    const report = await runOllamaEvaluation(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    process.stderr.write('Ollama evaluation failed safely; no document content was emitted.\n');
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) await main();
