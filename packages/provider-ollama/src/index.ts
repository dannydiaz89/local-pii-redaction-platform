import { createHash } from 'node:crypto';

import {
  SafeError,
  parseCorrelationId,
  parseDetectionId,
  type DetectionEvidence,
  type EntityType,
  type Sha256Digest
} from '@local-pii/domain';

/** This provider is intentionally opt-in until it has passed qualification. */
export const ollamaLocalDetectorBundleVersion = '0.1.0-ollama-experimental.1';
export const ollamaLocalDetectorId = 'ollama-local-model';
export const ollamaContextualEntityTypes = [
  'PERSON',
  'ADDRESS',
  'LOCATION',
  'ORGANIZATION',
  'DATE_OF_BIRTH',
  'ACCOUNT_ID'
] as const satisfies readonly EntityType[];
export const ollamaLocalCapabilityDescriptor = {
  engineMode: 'LOCAL_HYBRID',
  qualification: 'EXPERIMENTAL',
  detector: {
    id: ollamaLocalDetectorId,
    version: ollamaLocalDetectorBundleVersion,
    kinds: ['MODEL'],
    entityTypes: [...ollamaContextualEntityTypes],
    languages: ['und'],
    availability: 'AVAILABLE',
    qualification: 'EXPERIMENTAL'
  }
} as const;

const defaultEndpoint = 'http://127.0.0.1:11434';
export const ollamaExperimentalDefaultLimits = {
  maximumInputBytes: 80_000,
  maximumInputCodePoints: 20_000,
  maximumResponseBytes: 256_000,
  maximumDetections: 1_000,
  timeoutMs: 60_000
} as const;
const fixedSeed = 20260808;
const providerCorrelationId = 'cor_ollama_provider';
const systemPrompt = 'Identify sensitive entities in the supplied text. Return JSON only, using exact half-open Unicode code-point offsets. Each detection must contain entityType, start, end, and confidence. Do not return matched values, snippets, excerpts, explanations, or extra fields.';

export interface TextDetectionPortShape {
  readonly detectorBundleVersion: string;
  detect(text: string, extractionRevision: Sha256Digest, signal?: AbortSignal): Promise<readonly DetectionEvidence[]>;
}

export type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OllamaTextDetectionProviderOptions {
  /** Required: this package never selects or downloads a model. */
  readonly model: string;
  readonly endpoint?: string | URL;
  readonly maximumInputBytes?: number;
  readonly maximumInputCodePoints?: number;
  readonly maximumResponseBytes?: number;
  readonly maximumDetections?: number;
  readonly timeoutMs?: number;
  readonly correlationId?: string;
  /** Test seam; production defaults to the platform fetch implementation. */
  readonly fetchImplementation?: FetchImplementation;
}

interface ValidatedOptions {
  readonly model: string;
  readonly endpoint: URL;
  readonly maximumInputBytes: number;
  readonly maximumInputCodePoints: number;
  readonly maximumResponseBytes: number;
  readonly maximumDetections: number;
  readonly timeoutMs: number;
  readonly correlationId: string;
  readonly fetchImplementation: FetchImplementation;
}

interface ModelSpan {
  readonly entityType: EntityType;
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new TypeError(`${label} must be a positive safe integer within the experimental limit.`);
  }
  return selected;
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

/** Prevent a misconfigured local-model setting from becoming a network egress path. */
export function assertOllamaLoopbackEndpoint(value: string | URL): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError('The Ollama endpoint is invalid.');
  }
  const hostname = endpoint.hostname.toLowerCase();
  const ipv4Parts = hostname.split('.').map((part) => Number(part));
  const ipv4Loopback = ipv4Parts.length === 4
    && ipv4Parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && ipv4Parts[0] === 127;
  const ipv6Loopback = hostname === '[::1]' || hostname === '::1';
  if (
    endpoint.protocol !== 'http:'
    || (!ipv4Loopback && !ipv6Loopback)
    || endpoint.username.length > 0
    || endpoint.password.length > 0
    || (endpoint.pathname !== '' && endpoint.pathname !== '/')
    || endpoint.search.length > 0
    || endpoint.hash.length > 0
  ) {
    throw new TypeError('The Ollama endpoint must be an uncredentialed HTTP numeric-loopback origin.');
  }
  return endpoint;
}

function assertModelName(model: string): string {
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model)) {
    throw new TypeError('An explicit, safe Ollama model name is required.');
  }
  return model;
}

function stableDetectionId(parts: readonly (string | number)[]): ReturnType<typeof parseDetectionId> {
  const bytes = createHash('sha256').update(parts.join('\u001f'), 'utf8').digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return parseDetectionId(`${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`);
}

function safeError(
  code: 'INPUT_TOO_LARGE' | 'MODEL_UNAVAILABLE' | 'DETECTOR_TIMEOUT' | 'MODEL_OUTPUT_INVALID',
  message: string,
  retryable: boolean,
  options: ValidatedOptions,
  details?: Readonly<Record<'deadlineExceeded', boolean>>
): SafeError {
  return new SafeError({
    code,
    message,
    retryable,
    correlationId: options.correlationId,
    details: {
      detectorId: ollamaLocalDetectorId,
      modelId: modelRuleId(options.model),
      ...details
    }
  });
}

function invalidOutput(options: ValidatedOptions): SafeError {
  return safeError('MODEL_OUTPUT_INVALID', 'The local model returned an invalid detection response.', false, options);
}

async function readLimitedUtf8(response: Response, maximumBytes: number, failure: () => SafeError): Promise<string> {
  const advertisedLength = response.headers.get('content-length');
  if (advertisedLength !== null && (!/^\d+$/u.test(advertisedLength) || Number(advertisedLength) > maximumBytes)) {
    throw failure();
  }

  const reader = response.body?.getReader();
  if (reader === undefined) throw failure();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = next.value;
    received += chunk.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw failure();
    }
    chunks.push(chunk);
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw failure();
  }
}

function installedModelDigest(body: string, model: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) return undefined;
  for (const candidate of parsed.models) {
    if (!isRecord(candidate)) continue;
    const name = typeof candidate.name === 'string' ? candidate.name : candidate.model;
    const digest = candidate.digest;
    const requestedMatches = modelNamesMatch(name, model);
    if (requestedMatches && typeof digest === 'string' && /^[a-f0-9]{64}$/u.test(digest)) return digest;
  }
  return undefined;
}

function modelNamesMatch(actual: unknown, requested: string): boolean {
  return typeof actual === 'string'
    && (actual === requested || (!requested.includes(':') && actual === `${requested}:latest`));
}

function modelBoundBundleVersion(digest: string): string {
  return `${ollamaLocalDetectorBundleVersion}.sha256-${digest}`;
}

function modelRuleId(model: string): string {
  return `model-${createHash('sha256').update(model, 'utf8').digest('hex').slice(0, 24)}`;
}

function parseModelSpans(content: string, textLength: number, options: ValidatedOptions): readonly ModelSpan[] {
  if (byteLength(content) > options.maximumResponseBytes) throw invalidOutput(options);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw invalidOutput(options);
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.detections)) throw invalidOutput(options);
  if (parsed.detections.length > options.maximumDetections) throw invalidOutput(options);

  const allowedTypes = new Set<string>(ollamaContextualEntityTypes);
  const seen = new Set<string>();
  const spans: ModelSpan[] = [];
  for (const candidate of parsed.detections) {
    if (!isRecord(candidate)) throw invalidOutput(options);
    const keys = Object.keys(candidate);
    const entityType = candidate.entityType;
    const start = candidate.start;
    const end = candidate.end;
    const confidence = candidate.confidence;
    if (
      !keys.includes('entityType') || !keys.includes('start') || !keys.includes('end') || !keys.includes('confidence')
      || keys.some((key) => !['entityType', 'start', 'end', 'confidence'].includes(key))
      || typeof entityType !== 'string'
      || !allowedTypes.has(entityType)
      || typeof start !== 'number'
      || !Number.isSafeInteger(start)
      || typeof end !== 'number'
      || !Number.isSafeInteger(end)
      || typeof confidence !== 'number'
      || !Number.isFinite(confidence)
      || confidence < 0
      || confidence > 1
      || start < 0
      || start >= end
      || end > textLength
    ) {
      throw invalidOutput(options);
    }
    const key = `${String(start)}\u001f${String(end)}`;
    if (seen.has(key)) throw invalidOutput(options);
    seen.add(key);
    spans.push({
      entityType: entityType as EntityType,
      start,
      end,
      confidence
    });
  }
  return spans.sort((left, right) => left.start - right.start || left.end - right.end || left.entityType.localeCompare(right.entityType));
}

function parseChatEnvelope(body: string, options: ValidatedOptions): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw invalidOutput(options);
  }
  if (
    !isRecord(parsed)
    || parsed.done !== true
    || !modelNamesMatch(parsed.model, options.model)
    || !isRecord(parsed.message)
    || parsed.message.role !== 'assistant'
    || typeof parsed.message.content !== 'string'
  ) throw invalidOutput(options);
  return parsed.message.content;
}

function createOptions(input: OllamaTextDetectionProviderOptions): ValidatedOptions {
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') throw new TypeError('A fetch implementation is required.');
  return {
    model: assertModelName(input.model),
    endpoint: assertOllamaLoopbackEndpoint(input.endpoint ?? defaultEndpoint),
    maximumInputBytes: positiveInteger(input.maximumInputBytes, ollamaExperimentalDefaultLimits.maximumInputBytes, ollamaExperimentalDefaultLimits.maximumInputBytes, 'maximumInputBytes'),
    maximumInputCodePoints: positiveInteger(input.maximumInputCodePoints, ollamaExperimentalDefaultLimits.maximumInputCodePoints, ollamaExperimentalDefaultLimits.maximumInputCodePoints, 'maximumInputCodePoints'),
    maximumResponseBytes: positiveInteger(input.maximumResponseBytes, ollamaExperimentalDefaultLimits.maximumResponseBytes, ollamaExperimentalDefaultLimits.maximumResponseBytes, 'maximumResponseBytes'),
    maximumDetections: positiveInteger(input.maximumDetections, ollamaExperimentalDefaultLimits.maximumDetections, ollamaExperimentalDefaultLimits.maximumDetections, 'maximumDetections'),
    timeoutMs: positiveInteger(input.timeoutMs, ollamaExperimentalDefaultLimits.timeoutMs, 300_000, 'timeoutMs'),
    correlationId: parseCorrelationId(input.correlationId ?? providerCorrelationId),
    fetchImplementation
  };
}

export class OllamaTextDetectionProvider implements TextDetectionPortShape {
  public detectorBundleVersion = ollamaLocalDetectorBundleVersion;
  readonly #options: ValidatedOptions;
  #preparedDigest: string | undefined;
  #preparing: Promise<string> | undefined;

  public constructor(options: OllamaTextDetectionProviderOptions) {
    this.#options = createOptions(options);
  }

  /**
   * Verifies the explicitly configured model is already present locally. This
   * does not pull, select a fallback, or retain the tags response.
   */
  public async prepare(signal?: AbortSignal): Promise<void> {
    const options = this.#options;
    if (isAborted(signal)) {
      throw safeError('DETECTOR_TIMEOUT', 'Local model preparation was cancelled.', true, options, { deadlineExceeded: false });
    }
    if (this.#preparedDigest !== undefined) return;
    this.#preparing ??= this.#loadInstalledDigest(signal);
    const preparing = this.#preparing;
    try {
      const digest = await preparing;
      this.#preparedDigest = digest;
      this.detectorBundleVersion = modelBoundBundleVersion(digest);
    } finally {
      if (this.#preparing === preparing) this.#preparing = undefined;
    }
  }

  async #loadInstalledDigest(signal?: AbortSignal): Promise<string> {
    const options = this.#options;
    const controller = new AbortController();
    const abortState = { deadlineExceeded: false, callerCancelled: false };
    const deadline = setTimeout(() => {
      abortState.deadlineExceeded = true;
      controller.abort();
    }, options.timeoutMs);
    const cancel = (): void => {
      abortState.callerCancelled = true;
      controller.abort();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await options.fetchImplementation(new URL('/api/tags', options.endpoint), {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'application/json' },
        redirect: 'error'
      });
      if (!response.ok) throw safeError('MODEL_UNAVAILABLE', 'The requested local model is unavailable.', true, options);
      const digest = installedModelDigest(
        await readLimitedUtf8(response, options.maximumResponseBytes, () => safeError('MODEL_UNAVAILABLE', 'The requested local model is unavailable.', true, options)),
        options.model
      );
      if (digest === undefined) throw safeError('MODEL_UNAVAILABLE', 'The requested local model is unavailable.', true, options);
      return digest;
    } catch (error: unknown) {
      if (error instanceof SafeError) throw error;
      if (abortState.deadlineExceeded || abortState.callerCancelled) {
        throw safeError('DETECTOR_TIMEOUT', abortState.deadlineExceeded ? 'Local model preparation timed out.' : 'Local model preparation was cancelled.', true, options, { deadlineExceeded: abortState.deadlineExceeded });
      }
      throw safeError('MODEL_UNAVAILABLE', 'The requested local model is unavailable.', true, options);
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', cancel);
    }
  }

  public async detect(text: string, extractionRevision: Sha256Digest, signal?: AbortSignal): Promise<readonly DetectionEvidence[]> {
    const options = this.#options;
    const inputCodePoints = codePointLength(text);
    const inputBytes = byteLength(text);
    if (inputCodePoints > options.maximumInputCodePoints || inputBytes > options.maximumInputBytes) {
      throw safeError('INPUT_TOO_LARGE', 'Canonical text exceeds the local model input limit.', false, options);
    }
    if (isAborted(signal)) {
      throw safeError('DETECTOR_TIMEOUT', 'Local model detection was cancelled.', true, options, { deadlineExceeded: false });
    }
    await this.prepare(signal);
    if (isAborted(signal)) {
      throw safeError('DETECTOR_TIMEOUT', 'Local model detection was cancelled.', true, options, { deadlineExceeded: false });
    }
    const digest = this.#preparedDigest;
    if (digest === undefined) throw safeError('MODEL_UNAVAILABLE', 'The requested local model is unavailable.', true, options);

    const controller = new AbortController();
    const abortState = { deadlineExceeded: false, callerCancelled: false };
    const deadline = setTimeout(() => {
      abortState.deadlineExceeded = true;
      controller.abort();
    }, options.timeoutMs);
    const cancel = (): void => {
      abortState.callerCancelled = true;
      controller.abort();
    };
    signal?.addEventListener('abort', cancel, { once: true });

    try {
      const response = await options.fetchImplementation(new URL('/api/chat', options.endpoint), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        redirect: 'error',
        body: JSON.stringify({
          model: options.model,
          stream: false,
          format: {
            type: 'object',
            additionalProperties: false,
            required: ['detections'],
            properties: {
              detections: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['entityType', 'start', 'end', 'confidence'],
                  properties: {
                    entityType: { type: 'string', enum: [...ollamaContextualEntityTypes] },
                    start: { type: 'integer', minimum: 0 },
                    end: { type: 'integer', minimum: 1 },
                    confidence: { type: 'number', minimum: 0, maximum: 1 }
                  }
                }
              }
            }
          },
          options: { temperature: 0, seed: fixedSeed },
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }]
        })
      });
      if (!response.ok) throw safeError('MODEL_UNAVAILABLE', 'The local model is unavailable.', true, options);
      const content = parseChatEnvelope(await readLimitedUtf8(response, options.maximumResponseBytes, () => invalidOutput(options)), options);
      const spans = parseModelSpans(content, inputCodePoints, options);
      const currentDigest = await this.#loadInstalledDigest(signal);
      if (currentDigest !== digest) {
        throw safeError('MODEL_UNAVAILABLE', 'The requested local model changed during detection.', true, options);
      }
      return spans.map((span) => ({
        id: stableDetectionId([extractionRevision, ollamaLocalDetectorId, this.detectorBundleVersion, options.model, digest, span.entityType, span.start, span.end]),
        entityType: span.entityType,
        span: { start: span.start, end: span.end, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision },
        confidence: span.confidence,
        source: 'MODEL',
        detector: { id: ollamaLocalDetectorId, version: this.detectorBundleVersion, ruleId: modelRuleId(options.model) }
      }));
    } catch (error: unknown) {
      if (error instanceof SafeError) throw error;
      if (abortState.deadlineExceeded || abortState.callerCancelled) {
        throw safeError('DETECTOR_TIMEOUT', abortState.deadlineExceeded ? 'Local model detection timed out.' : 'Local model detection was cancelled.', true, options, { deadlineExceeded: abortState.deadlineExceeded });
      }
      throw safeError('MODEL_UNAVAILABLE', 'The local model is unavailable.', true, options);
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', cancel);
    }
  }
}

export function createOllamaTextDetectionProvider(options: OllamaTextDetectionProviderOptions): OllamaTextDetectionProvider {
  return new OllamaTextDetectionProvider(options);
}
