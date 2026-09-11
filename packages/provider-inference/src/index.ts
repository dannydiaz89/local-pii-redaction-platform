import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { assertContract, validateContract } from '@local-pii/contracts';
import {
  SafeError,
  parseCorrelationId,
  parseDetectionId,
  type DetectionEvidence,
  type EntityType,
  type Sha256Digest
} from '@local-pii/domain';

/** Opt-in until the service and a model bundle pass qualification. */
export const inferenceLocalDetectorBundleVersion = '0.1.0-inference-experimental.1';
export const inferenceLocalDetectorId = 'local-inference-model';
export const inferenceDefaultModuleName = 'local_pii_inference';
export const inferenceProtocolVersion = '1.0.0';
export const inferenceExperimentalDefaultLimits = {
  maximumInputBytes: 80_000,
  maximumInputCodePoints: 20_000,
  maximumDetections: 1_000,
  maximumFrameBytes: 8 * 1024 * 1024,
  timeoutMs: 60_000
} as const;

const modelManifestSchemaId = 'https://local-pii.dev/schemas/models/model-manifest/1.0.0';
const detectResponseSchemaId = 'https://local-pii.dev/schemas/detection/detect-response/1.0.0';
const providerCorrelationId = 'cor_inference_provider';
const chunkCodePoints = 20_000;
const frameHeaderBytes = 4;

export interface TextDetectionPortShape {
  readonly detectorBundleVersion: string;
  detect(text: string, extractionRevision: Sha256Digest, signal?: AbortSignal): Promise<readonly DetectionEvidence[]>;
}

export interface InferenceModelIdentity {
  readonly id: string;
  readonly version: string;
  readonly digest: Sha256Digest;
  readonly runtime: string;
}

export interface InferenceCapabilities {
  readonly model: InferenceModelIdentity;
  readonly detector: { readonly id: string; readonly version: string };
  readonly entityTypes: readonly EntityType[];
  readonly languages: readonly string[];
  readonly qualification: 'SYNTHETIC' | 'EXPERIMENTAL';
}

export type SpawnImplementation = (
  executable: string,
  args: readonly string[]
) => ChildProcessWithoutNullStreams;

export interface InferenceTextDetectionProviderOptions {
  /** Operator-supplied directory holding manifest.json, model.json, and tokenizer.json. */
  readonly bundleDirectory: string;
  /** Interpreter with the inference package importable; never resolved from document content. */
  readonly pythonExecutable?: string;
  readonly moduleName?: string;
  readonly maximumInputBytes?: number;
  readonly maximumInputCodePoints?: number;
  readonly maximumDetections?: number;
  readonly timeoutMs?: number;
  readonly correlationId?: string;
  /** Test seam. */
  readonly spawnImplementation?: SpawnImplementation;
}

interface ValidatedOptions {
  readonly bundleDirectory: string;
  readonly pythonExecutable: string;
  readonly moduleName: string;
  readonly maximumInputBytes: number;
  readonly maximumInputCodePoints: number;
  readonly maximumDetections: number;
  readonly timeoutMs: number;
  readonly correlationId: string;
  readonly spawnImplementation: SpawnImplementation;
}

const executablePattern = /^[A-Za-z0-9._/-]{1,512}$/u;
const modulePattern = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/u;

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

function createOptions(input: InferenceTextDetectionProviderOptions): ValidatedOptions {
  if (typeof input.bundleDirectory !== 'string' || input.bundleDirectory.length === 0 || input.bundleDirectory.length > 4096) {
    throw new TypeError('A bundle directory is required.');
  }
  const pythonExecutable = input.pythonExecutable ?? 'python3';
  if (!executablePattern.test(pythonExecutable)) throw new TypeError('The Python executable path is invalid.');
  const moduleName = input.moduleName ?? inferenceDefaultModuleName;
  if (!modulePattern.test(moduleName)) throw new TypeError('The inference module name is invalid.');
  const limits = inferenceExperimentalDefaultLimits;
  return {
    bundleDirectory: resolve(input.bundleDirectory),
    pythonExecutable,
    moduleName,
    maximumInputBytes: positiveInteger(input.maximumInputBytes, limits.maximumInputBytes, limits.maximumInputBytes, 'maximumInputBytes'),
    maximumInputCodePoints: positiveInteger(input.maximumInputCodePoints, limits.maximumInputCodePoints, limits.maximumInputCodePoints, 'maximumInputCodePoints'),
    maximumDetections: positiveInteger(input.maximumDetections, limits.maximumDetections, limits.maximumDetections, 'maximumDetections'),
    timeoutMs: positiveInteger(input.timeoutMs, limits.timeoutMs, 300_000, 'timeoutMs'),
    correlationId: parseCorrelationId(input.correlationId ?? providerCorrelationId),
    spawnImplementation: input.spawnImplementation ?? ((executable, args) => spawn(executable, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }), PYTHONDONTWRITEBYTECODE: '1' }
    }))
  };
}

function safeError(
  code: 'INPUT_TOO_LARGE' | 'MODEL_UNAVAILABLE' | 'DETECTOR_TIMEOUT' | 'MODEL_OUTPUT_INVALID' | 'SUPPLY_CHAIN_INVALID',
  message: string,
  retryable: boolean,
  options: ValidatedOptions
): SafeError {
  return new SafeError({
    code,
    message,
    retryable,
    correlationId: options.correlationId,
    details: { detectorId: inferenceLocalDetectorId }
  });
}

function stableDetectionId(parts: readonly (string | number)[]): DetectionEvidence['id'] {
  const bytes = createHash('sha256').update(parts.join('\u001f'), 'utf8').digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return parseDetectionId(`${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`);
}

function modelRuleId(model: InferenceModelIdentity): string {
  return `model-${createHash('sha256').update(`${model.id}@${model.version}`, 'utf8').digest('hex').slice(0, 24)}`;
}

function encodeFrame(message: unknown, maximumFrameBytes: number): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.byteLength > maximumFrameBytes) throw new RangeError('frame');
  const header = Buffer.alloc(frameHeaderBytes);
  header.writeUInt32BE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

/** Incremental length-prefixed frame decoder shared by tests and the provider. */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  readonly #maximumFrameBytes: number;

  constructor(maximumFrameBytes: number = inferenceExperimentalDefaultLimits.maximumFrameBytes) {
    this.#maximumFrameBytes = maximumFrameBytes;
  }

  /** Returns decoded frames; throws on an oversized or malformed frame, after which the stream is unusable. */
  push(chunk: Buffer): unknown[] {
    this.#buffer = this.#buffer.byteLength === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: unknown[] = [];
    while (this.#buffer.byteLength >= frameHeaderBytes) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > this.#maximumFrameBytes) throw new RangeError('frame');
      if (this.#buffer.byteLength < frameHeaderBytes + length) break;
      const payload = this.#buffer.subarray(frameHeaderBytes, frameHeaderBytes + length);
      this.#buffer = this.#buffer.subarray(frameHeaderBytes + length);
      frames.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)));
    }
    return frames;
  }
}

function isModelIdentity(value: unknown): value is InferenceModelIdentity {
  return isRecord(value)
    && typeof value.id === 'string' && value.id.length > 0
    && typeof value.version === 'string'
    && typeof value.digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.digest)
    && typeof value.runtime === 'string' && value.runtime.length > 0;
}

function codePointLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) index += 1;
    length += 1;
  }
  return length;
}

/** Contiguous, non-overlapping chunks by Unicode code point; absoluteStart is a code-point offset. */
export function chunkCanonicalText(
  text: string,
  maximumCodePoints: number = chunkCodePoints
): readonly { readonly id: string; readonly text: string; readonly absoluteStart: number }[] {
  const characters = Array.from(text);
  const chunks: { id: string; text: string; absoluteStart: number }[] = [];
  for (let start = 0; start < characters.length; start += maximumCodePoints) {
    chunks.push({
      id: `chunk-${String(chunks.length + 1)}`,
      text: characters.slice(start, start + maximumCodePoints).join(''),
      absoluteStart: start
    });
  }
  return chunks;
}

interface Pending {
  readonly resolve: (frame: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

interface BundleManifest {
  readonly id: string;
  readonly version: string;
  readonly modelDigest: string;
  readonly runtime: string;
  readonly entityTypes: readonly EntityType[];
}

export class InferenceTextDetectionProvider implements TextDetectionPortShape {
  readonly #options: ValidatedOptions;
  #process: ChildProcessWithoutNullStreams | undefined;
  readonly #decoder = new FrameDecoder(inferenceExperimentalDefaultLimits.maximumFrameBytes);
  #pending: Pending | undefined;
  #exited = false;
  #preparing: Promise<void> | undefined;
  #model: InferenceModelIdentity | undefined;
  #capabilities: InferenceCapabilities | undefined;
  #entityTypes = new Set<EntityType>();

  constructor(options: InferenceTextDetectionProviderOptions) {
    this.#options = createOptions(options);
  }

  get detectorBundleVersion(): string {
    return this.#model === undefined
      ? inferenceLocalDetectorBundleVersion
      : `${inferenceLocalDetectorBundleVersion}.${this.#model.digest.replace(':', '-')}`;
  }

  /** Available after `prepare`; drives the capability descriptor of the composition. */
  get capabilities(): InferenceCapabilities | undefined {
    return this.#capabilities;
  }

  public async prepare(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.#preparing ??= this.#start(signal);
    await this.#preparing;
  }

  public close(): void {
    const child = this.#process;
    this.#process = undefined;
    if (child !== undefined && !this.#exited) child.kill();
  }

  async #start(signal?: AbortSignal): Promise<void> {
    const options = this.#options;
    const manifest = await this.#readManifest();
    const child = options.spawnImplementation(options.pythonExecutable, ['-m', options.moduleName, '--bundle', options.bundleDirectory]);
    this.#process = child;
    // Never surfaced: stderr could carry interpreter diagnostics.
    child.stderr.on('data', () => undefined);
    child.stdout.on('data', (chunk: Buffer) => { this.#receive(chunk); });
    child.once('exit', () => {
      this.#exited = true;
      this.#pending?.reject(new Error('exit'));
      this.#pending = undefined;
    });
    child.once('error', () => {
      this.#exited = true;
      this.#pending?.reject(new Error('spawn'));
      this.#pending = undefined;
    });
    const ready = await this.#exchange({ type: 'ready' }, signal);
    if (ready.ok !== true || !isModelIdentity(ready.model)) {
      this.close();
      const code = isRecord(ready.error) && ready.error.code === 'SUPPLY_CHAIN_INVALID' ? 'SUPPLY_CHAIN_INVALID' : 'MODEL_UNAVAILABLE';
      throw safeError(code, 'The local inference bundle could not be verified.', false, options);
    }
    if (
      ready.model.id !== manifest.id
      || ready.model.version !== manifest.version
      || ready.model.digest !== manifest.modelDigest
      || ready.model.runtime !== manifest.runtime
    ) {
      this.close();
      throw safeError('SUPPLY_CHAIN_INVALID', 'The inference service reported a model that differs from the bundle manifest.', false, options);
    }
    const capabilities = await this.#exchange({ type: 'capabilities' }, signal);
    const reported = capabilities.capabilities;
    if (
      capabilities.ok !== true
      || !isRecord(reported)
      || !Array.isArray(reported.entityTypes)
      || !reported.entityTypes.every((item) => typeof item === 'string' && manifest.entityTypes.includes(item as EntityType))
      || !Array.isArray(reported.languages)
      || !isRecord(reported.detector)
      || typeof reported.detector.id !== 'string'
      || typeof reported.detector.version !== 'string'
      || (reported.qualification !== 'SYNTHETIC' && reported.qualification !== 'EXPERIMENTAL')
      || !Array.isArray(reported.protocolVersions)
      || !reported.protocolVersions.includes(inferenceProtocolVersion)
    ) {
      this.close();
      throw safeError('MODEL_UNAVAILABLE', 'The inference service capabilities are invalid.', false, options);
    }
    this.#model = ready.model;
    this.#entityTypes = new Set(reported.entityTypes as EntityType[]);
    this.#capabilities = Object.freeze({
      model: ready.model,
      detector: { id: reported.detector.id, version: reported.detector.version },
      entityTypes: Object.freeze([...this.#entityTypes]),
      languages: Object.freeze(reported.languages.filter((item): item is string => typeof item === 'string')),
      qualification: reported.qualification
    });
  }

  async #readManifest(): Promise<BundleManifest> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(resolve(this.#options.bundleDirectory, 'manifest.json'), 'utf8')) as unknown;
    } catch {
      throw safeError('SUPPLY_CHAIN_INVALID', 'The local inference bundle manifest is unreadable.', false, this.#options);
    }
    if (!validateContract(modelManifestSchemaId, parsed).valid || !isRecord(parsed)) {
      throw safeError('SUPPLY_CHAIN_INVALID', 'The local inference bundle manifest is invalid.', false, this.#options);
    }
    return parsed as unknown as BundleManifest;
  }

  #receive(chunk: Buffer): void {
    let frames: unknown[];
    try {
      frames = this.#decoder.push(chunk);
    } catch {
      this.#pending?.reject(new Error('frame'));
      this.#pending = undefined;
      this.close();
      return;
    }
    for (const frame of frames) {
      const pending = this.#pending;
      this.#pending = undefined;
      if (pending === undefined) continue;
      if (isRecord(frame)) pending.resolve(frame);
      else pending.reject(new Error('shape'));
    }
  }

  async #exchange(message: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const options = this.#options;
    const child = this.#process;
    if (child === undefined || this.#exited) throw safeError('MODEL_UNAVAILABLE', 'The local inference service is not running.', true, options);
    if (this.#pending !== undefined) throw safeError('MODEL_UNAVAILABLE', 'The local inference service is busy.', true, options);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Mutated from the timer closure, so it lives in an object rather than a narrowed local.
    const state = { timedOut: false };
    const abort = (): void => {
      this.#pending?.reject(new Error('abort'));
      this.#pending = undefined;
    };
    try {
      const reply = new Promise<Record<string, unknown>>((resolvePending, rejectPending) => {
        this.#pending = { resolve: resolvePending, reject: rejectPending };
      });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { state.timedOut = true; abort(); }, options.timeoutMs);
      child.stdin.write(encodeFrame(message, inferenceExperimentalDefaultLimits.maximumFrameBytes));
      return await reply;
    } catch (error: unknown) {
      if (error instanceof SafeError) throw error;
      if (state.timedOut) {
        this.close();
        throw safeError('DETECTOR_TIMEOUT', 'Local inference timed out.', true, options);
      }
      if (signal?.aborted === true) {
        throw safeError('DETECTOR_TIMEOUT', 'Local inference was cancelled.', true, options);
      }
      throw safeError('MODEL_UNAVAILABLE', 'The local inference service is unavailable.', true, options);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  public async detect(text: string, extractionRevision: Sha256Digest, signal?: AbortSignal): Promise<readonly DetectionEvidence[]> {
    const options = this.#options;
    await this.prepare(signal);
    const model = this.#model;
    if (model === undefined) throw safeError('MODEL_UNAVAILABLE', 'The local inference service is not prepared.', true, options);
    if (Buffer.byteLength(text, 'utf8') > options.maximumInputBytes) {
      throw safeError('INPUT_TOO_LARGE', 'The input exceeds the experimental inference byte limit.', false, options);
    }
    const totalCodePoints = codePointLength(text);
    if (totalCodePoints > options.maximumInputCodePoints) {
      throw safeError('INPUT_TOO_LARGE', 'The input exceeds the experimental inference code-point limit.', false, options);
    }
    if (totalCodePoints === 0) return [];
    const chunks = chunkCanonicalText(text, chunkCodePoints);
    const request = {
      schemaVersion: inferenceProtocolVersion,
      requestId: randomUUID(),
      chunks,
      entityTypes: [...this.#entityTypes],
      minimumConfidence: 0,
      options: { maxDetectionsPerChunk: options.maximumDetections }
    };
    const reply = await this.#exchange({ type: 'detect', correlationId: options.correlationId, request }, signal);
    if (reply.ok !== true) {
      const code = isRecord(reply.error) && typeof reply.error.code === 'string' ? reply.error.code : 'MODEL_OUTPUT_INVALID';
      if (code === 'INPUT_TOO_LARGE' || code === 'DETECTION_LIMIT_EXCEEDED') {
        throw safeError('INPUT_TOO_LARGE', 'The input exceeds the inference service limits.', false, options);
      }
      throw safeError('MODEL_OUTPUT_INVALID', 'The local inference service rejected the request.', false, options);
    }
    const response = reply.response;
    try {
      assertContract(detectResponseSchemaId, response);
    } catch {
      throw safeError('MODEL_OUTPUT_INVALID', 'The local inference response is invalid.', false, options);
    }
    const typed = response as {
      requestId: string;
      detections: readonly { chunkId: string; entityType: EntityType; start: number; end: number; confidence: number }[];
      model: InferenceModelIdentity;
    };
    if (typed.requestId !== request.requestId) throw safeError('MODEL_OUTPUT_INVALID', 'The local inference response is invalid.', false, options);
    if (typed.model.digest !== model.digest || typed.model.id !== model.id || typed.model.version !== model.version) {
      this.close();
      throw safeError('MODEL_UNAVAILABLE', 'The local inference model changed during detection.', true, options);
    }
    if (typed.detections.length > options.maximumDetections) {
      throw safeError('INPUT_TOO_LARGE', 'The input exceeds the experimental detection limit.', false, options);
    }
    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk] as const));
    const seen = new Set<string>();
    const evidence: DetectionEvidence[] = [];
    for (const detection of typed.detections) {
      const chunk = chunksById.get(detection.chunkId);
      if (chunk === undefined || !this.#entityTypes.has(detection.entityType)) {
        throw safeError('MODEL_OUTPUT_INVALID', 'The local inference response is invalid.', false, options);
      }
      const chunkLength = codePointLength(chunk.text);
      if (detection.start < 0 || detection.end > chunkLength || detection.start >= detection.end) {
        throw safeError('MODEL_OUTPUT_INVALID', 'The local inference response is invalid.', false, options);
      }
      const start = chunk.absoluteStart + detection.start;
      const end = chunk.absoluteStart + detection.end;
      const key = `${detection.entityType}\u001f${String(start)}\u001f${String(end)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push({
        id: stableDetectionId([extractionRevision, inferenceLocalDetectorId, this.detectorBundleVersion, model.id, model.digest, detection.entityType, start, end]),
        entityType: detection.entityType,
        span: { start, end, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision },
        confidence: detection.confidence,
        source: 'MODEL',
        detector: { id: inferenceLocalDetectorId, version: this.detectorBundleVersion, ruleId: modelRuleId(model) }
      });
    }
    return evidence.sort((left, right) => left.span.start - right.span.start || left.span.end - right.span.end || left.entityType.localeCompare(right.entityType));
  }
}

export function createInferenceTextDetectionProvider(options: InferenceTextDetectionProviderOptions): InferenceTextDetectionProvider {
  return new InferenceTextDetectionProvider(options);
}
