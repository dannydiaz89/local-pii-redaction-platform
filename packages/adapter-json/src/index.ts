import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';

import {
  defaultTextArtifactFileSystem,
  deriveRedactedOutputPath,
  discardStagedTextArtifact,
  publishStagedTextArtifact,
  readLocalUtf8Artifact,
  stageTextArtifact,
  type LocalUtf8Artifact,
  type StagedTextArtifact,
  type TextArtifactFileSystem,
  type TextArtifactPublication
} from '@local-pii/adapter-text';
import { computeWriterReceiptDigest, type RedactionWriterReceiptContract } from '@local-pii/contracts';
import { SafeError, parseSha256Digest, unicodeCodePointLength, type Sha256Digest } from '@local-pii/domain';
import { assertTypedLabelPlanIntegrity, type TypedLabelAction, type TypedLabelPlan } from '@local-pii/redaction';

export const jsonAdapterVersion = '0.1.0';
export const defaultMaximumJsonInputBytes = 100 * 1024 * 1024;
export const jsonWriterDescriptor = Object.freeze({
  id: 'json-adapter',
  version: jsonAdapterVersion,
  digest: parseSha256Digest('sha256:469df80596fd58c8a5deeddb708efa67b988445a400e984b98e0a8b61c6a38c8')
});
export const jsonAdapterCapabilityDescriptor = {
  id: 'json',
  adapter: jsonWriterDescriptor.id,
  version: jsonAdapterVersion,
  mediaTypes: ['application/json'],
  extensions: ['.json'],
  operations: ['PROBE', 'INSPECT', 'EXTRACT', 'SCAN', 'REDACT', 'VERIFY'],
  assurance: 'NATIVE_REDACTION',
  features: [
    { id: 'utf-8', status: 'SUPPORTED' },
    { id: 'value-only-transformation', status: 'SUPPORTED' },
    { id: 'json-pointer-source-map', status: 'SUPPORTED' },
    { id: 'byte-preserving-untouched-tokens', status: 'SUPPORTED' },
    { id: 'duplicate-object-keys', status: 'BLOCKED' },
    { id: 'key-transformation', status: 'BLOCKED' },
    { id: 'streaming', status: 'BLOCKED' },
    { id: 'symbolic-links', status: 'BLOCKED' }
  ],
  verificationProfiles: ['text-rescan-v1'],
  limits: { maximumInputBytes: defaultMaximumJsonInputBytes }
} as const;

type WriterReceipt = RedactionWriterReceiptContract.WriterReceipt;

interface JsonValueRegion {
  readonly pointer: string;
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly value: string;
}

export interface JsonArtifact extends LocalUtf8Artifact {
  readonly mediaType: 'application/json';
  readonly extractionRevision: Sha256Digest;
  readonly canonicalText: string;
  /** Alias consumed by the storage-neutral text-processing application. */
  readonly text: string;
}

interface JsonArtifactState {
  readonly regions: readonly JsonValueRegion[];
  readonly rawText: string;
}

const jsonArtifactStates = new WeakMap<JsonArtifact, JsonArtifactState>();

const jsonBoundary = '\n\u0000\n';
const maximumJsonDepth = 128;
const maximumJsonNodes = 100_000;
const maximumJsonStringValues = 50_000;
const maximumCanonicalCodePoints = 10_000_000;
const maximumPlanActions = 100_000;
const actionIdPattern = /^act_[0-9A-HJKMNP-TV-Z]{26}$/u;

function formatCorrupt(): never {
  throw new SafeError({
    code: 'FORMAT_CORRUPT',
    message: 'The JSON input is malformed or exceeds the supported structural limits.',
    retryable: false,
    correlationId: 'cor_json_adapter'
  });
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function escapedPointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

class JsonScanner {
  private index = 0;
  private nodes = 0;
  private canonicalLength = 0;
  private readonly canonicalParts: string[] = [];
  private readonly values: JsonValueRegion[] = [];

  constructor(private readonly source: string) {}

  parse(): { readonly canonicalText: string; readonly regions: readonly JsonValueRegion[]; readonly extractionRevision: Sha256Digest } {
    this.skipWhitespace();
    this.parseValue('', 0, true);
    this.skipWhitespace();
    if (this.index !== this.source.length) formatCorrupt();
    const canonicalText = this.canonicalParts.join('');
    const hash = createHash('sha256').update('local-pii:json-extraction:v1\u0000', 'utf8');
    for (const region of this.values) {
      hash
        .update(String(Buffer.byteLength(region.pointer, 'utf8')), 'utf8')
        .update(':', 'utf8')
        .update(region.pointer, 'utf8')
        .update(String(Buffer.byteLength(region.value, 'utf8')), 'utf8')
        .update(':', 'utf8')
        .update(region.value, 'utf8');
    }
    return {
      canonicalText,
      regions: Object.freeze(this.values.map((region) => Object.freeze(region))),
      extractionRevision: parseSha256Digest(`sha256:${hash.digest('hex')}`)
    };
  }

  private bumpNode(depth: number): void {
    this.nodes += 1;
    if (depth > maximumJsonDepth || this.nodes > maximumJsonNodes) formatCorrupt();
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) return;
      this.index += 1;
    }
  }

  private consume(expected: string): void {
    if (this.source[this.index] !== expected) formatCorrupt();
    this.index += 1;
  }

  private parseString(): { readonly value: string; readonly rawStart: number; readonly rawEnd: number } {
    const rawStart = this.index;
    this.consume('"');
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === '"') {
        this.index += 1;
        const rawEnd = this.index;
        let value: unknown;
        try {
          value = JSON.parse(this.source.slice(rawStart, rawEnd));
        } catch {
          formatCorrupt();
        }
        if (typeof value !== 'string' || !isWellFormedUnicode(value)) formatCorrupt();
        return { value, rawStart, rawEnd };
      }
      if (character === '\\') {
        this.index += 1;
        const escaped = this.source[this.index];
        if (escaped === 'u') {
          const hex = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) formatCorrupt();
          this.index += 5;
          continue;
        }
        if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) formatCorrupt();
        this.index += 1;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) formatCorrupt();
      this.index += 1;
    }
    return formatCorrupt();
  }

  private recordString(pointer: string, token: ReturnType<JsonScanner['parseString']>): void {
    if (this.values.length >= maximumJsonStringValues) formatCorrupt();
    if (this.values.length > 0) {
      this.canonicalParts.push(jsonBoundary);
      this.canonicalLength += unicodeCodePointLength(jsonBoundary);
    }
    const length = unicodeCodePointLength(token.value);
    const canonicalStart = this.canonicalLength;
    this.canonicalLength += length;
    if (this.canonicalLength > maximumCanonicalCodePoints) formatCorrupt();
    this.canonicalParts.push(token.value);
    this.values.push({
      pointer,
      rawStart: token.rawStart,
      rawEnd: token.rawEnd,
      canonicalStart,
      canonicalEnd: this.canonicalLength,
      value: token.value
    });
  }

  private parseValue(pointer: string, depth: number, collectString: boolean): void {
    this.bumpNode(depth);
    this.skipWhitespace();
    const character = this.source[this.index];
    if (character === '"') {
      const token = this.parseString();
      if (collectString) this.recordString(pointer, token);
      return;
    }
    if (character === '{') {
      this.parseObject(pointer, depth + 1);
      return;
    }
    if (character === '[') {
      this.parseArray(pointer, depth + 1);
      return;
    }
    for (const literal of ['true', 'false', 'null'] as const) {
      if (this.source.startsWith(literal, this.index)) {
        this.index += literal.length;
        return;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.source.slice(this.index));
    if (number !== null) {
      this.index += number[0].length;
      return;
    }
    formatCorrupt();
  }

  private parseObject(pointer: string, depth: number): void {
    this.consume('{');
    this.skipWhitespace();
    if (this.source[this.index] === '}') {
      this.index += 1;
      return;
    }
    const keys = new Set<string>();
    for (;;) {
      this.skipWhitespace();
      if (this.source[this.index] !== '"') formatCorrupt();
      const key = this.parseString().value;
      if (keys.has(key)) formatCorrupt();
      keys.add(key);
      this.skipWhitespace();
      this.consume(':');
      this.parseValue(`${pointer}/${escapedPointerSegment(key)}`, depth, true);
      this.skipWhitespace();
      if (this.source[this.index] === '}') {
        this.index += 1;
        return;
      }
      this.consume(',');
    }
  }

  private parseArray(pointer: string, depth: number): void {
    this.consume('[');
    this.skipWhitespace();
    if (this.source[this.index] === ']') {
      this.index += 1;
      return;
    }
    let item = 0;
    for (;;) {
      this.parseValue(`${pointer}/${String(item)}`, depth, true);
      item += 1;
      this.skipWhitespace();
      if (this.source[this.index] === ']') {
        this.index += 1;
        return;
      }
      this.consume(',');
    }
  }
}

function parseJson(source: string): ReturnType<JsonScanner['parse']> {
  try {
    return new JsonScanner(source).parse();
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    return formatCorrupt();
  }
}

export async function readJsonArtifact(
  inputPath: string,
  maximumBytes = defaultMaximumJsonInputBytes,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
): Promise<JsonArtifact> {
  if (extname(inputPath).toLowerCase() !== '.json') {
    throw new SafeError({ code: 'FORMAT_UNSUPPORTED', message: 'This adapter supports JSON files only.', retryable: false, correlationId: 'cor_json_adapter' });
  }
  const source = await readLocalUtf8Artifact(inputPath, maximumBytes, fileSystem);
  const parsed = parseJson(source.text);
  const artifact: JsonArtifact = Object.freeze({
    ...source,
    mediaType: 'application/json',
    extractionRevision: parsed.extractionRevision,
    canonicalText: parsed.canonicalText,
    text: parsed.canonicalText
  });
  jsonArtifactStates.set(artifact, { regions: parsed.regions, rawText: source.text });
  return artifact;
}

function transformValue(value: string, actions: readonly TypedLabelAction[], regionStart: number): string {
  let codePointCursor = 0;
  let utf16Cursor = 0;
  let unchangedStart = 0;
  const parts: string[] = [];
  const advanceTo = (target: number): void => {
    while (utf16Cursor < value.length && codePointCursor < target) {
      const code = value.codePointAt(utf16Cursor);
      utf16Cursor += code !== undefined && code > 0xffff ? 2 : 1;
      codePointCursor += 1;
    }
    if (codePointCursor !== target) formatCorrupt();
  };
  for (const action of actions) {
    advanceTo(action.start - regionStart);
    parts.push(value.slice(unchangedStart, utf16Cursor), action.replacement);
    advanceTo(action.end - regionStart);
    unchangedStart = utf16Cursor;
  }
  parts.push(value.slice(unchangedStart));
  return parts.join('');
}

function assertPlan(
  plan: TypedLabelPlan,
  source: JsonArtifact,
  regions: readonly JsonValueRegion[]
): Map<JsonValueRegion, TypedLabelAction[]> {
  try {
    assertTypedLabelPlanIntegrity(plan);
  } catch {
    throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan provenance is invalid.', retryable: false, correlationId: 'cor_json_adapter' });
  }
  if (
    plan.inputDigest !== source.digest
    || plan.extractionRevision !== source.extractionRevision
    || plan.writer.id !== jsonWriterDescriptor.id
    || plan.writer.version !== jsonWriterDescriptor.version
  ) {
    throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan does not match this JSON input.', retryable: false, correlationId: 'cor_json_adapter' });
  }
  if (
    !Number.isSafeInteger(plan.expectedActionCount)
    || plan.expectedActionCount < 0
    || plan.expectedActionCount > maximumPlanActions
    || plan.expectedActionCount !== plan.actions.length
  ) {
    throw new SafeError({ code: 'REDACTION_COUNT_MISMATCH', message: 'The redaction plan action count is invalid.', retryable: false, correlationId: 'cor_json_adapter' });
  }
  const sourceLength = unicodeCodePointLength(source.text);
  const actionIds = new Set<string>();
  const sortedActions = [...plan.actions].sort((left, right) => left.start - right.start || left.end - right.end);
  for (const action of sortedActions) {
    if (
      !actionIdPattern.test(action.id)
      || actionIds.has(action.id)
      || !Number.isSafeInteger(action.start)
      || !Number.isSafeInteger(action.end)
      || action.start < 0
      || action.start >= action.end
      || action.end > sourceLength
      || typeof action.replacement !== 'string'
      || unicodeCodePointLength(action.replacement) > 500
    ) {
      throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan actions are invalid.', retryable: false, correlationId: 'cor_json_adapter' });
    }
    actionIds.add(action.id);
  }
  for (let index = 1; index < sortedActions.length; index += 1) {
    if ((sortedActions[index - 1]?.end ?? 0) > (sortedActions[index]?.start ?? 0)) {
      throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The redaction plan contains overlapping actions.', retryable: false, correlationId: 'cor_json_adapter' });
    }
  }
  const assigned = new Map<JsonValueRegion, TypedLabelAction[]>();
  let regionIndex = 0;
  for (const action of sortedActions) {
    let region = regions[regionIndex];
    while (region !== undefined && action.start >= region.canonicalEnd) {
      regionIndex += 1;
      region = regions[regionIndex];
    }
    if (
      region === undefined
      || action.start < region.canonicalStart
      || action.end > region.canonicalEnd
    ) {
      throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'A redaction action crosses a JSON value boundary.', retryable: false, correlationId: 'cor_json_adapter' });
    }
    const actions = assigned.get(region) ?? [];
    actions.push(action);
    assigned.set(region, actions);
  }
  for (const actions of assigned.values()) actions.sort((left, right) => left.start - right.start || left.end - right.end);
  return assigned;
}

function applyJsonPlan(source: JsonArtifact, plan: TypedLabelPlan): string {
  const state = jsonArtifactStates.get(source);
  if (state === undefined) {
    throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'The JSON extraction state is unavailable.', retryable: false, correlationId: 'cor_json_adapter' });
  }
  const assigned = assertPlan(plan, source, state.regions);
  const changed = [...assigned.entries()].sort(([left], [right]) => left.rawStart - right.rawStart);
  const output: string[] = [];
  let rawCursor = 0;
  for (const [region, actions] of changed) {
    const replacement = JSON.stringify(transformValue(region.value, actions, region.canonicalStart));
    output.push(state.rawText.slice(rawCursor, region.rawStart), replacement);
    rawCursor = region.rawEnd;
  }
  output.push(state.rawText.slice(rawCursor));
  return output.join('');
}

function createReceipt(plan: TypedLabelPlan, staged: Pick<StagedTextArtifact, 'digest' | 'byteLength'>): WriterReceipt {
  const unsigned: Omit<WriterReceipt, 'receiptDigest'> = {
    schemaVersion: '1.0.0',
    planDigest: parseSha256Digest(plan.digest),
    writer: { id: jsonWriterDescriptor.id, version: jsonWriterDescriptor.version },
    stagedDigest: staged.digest,
    stagedByteLength: staged.byteLength,
    expectedActionCount: plan.expectedActionCount,
    appliedActionCount: plan.actions.length,
    appliedActionIds: plan.actions.map(({ id }) => id)
  };
  return Object.freeze({ ...unsigned, receiptDigest: parseSha256Digest(computeWriterReceiptDigest(unsigned)) });
}

export function createLocalJsonArtifactSession(
  inputPath: string,
  outputPath?: string,
  maximumInputBytes = defaultMaximumJsonInputBytes,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
) {
  if (!Number.isSafeInteger(maximumInputBytes) || maximumInputBytes < 0 || maximumInputBytes > defaultMaximumJsonInputBytes) {
    throw new TypeError('Maximum JSON input bytes must be within the adapter limit.');
  }
  let sourcePromise: Promise<JsonArtifact> | undefined;
  const input = async (signal?: AbortSignal): Promise<JsonArtifact> => {
    signal?.throwIfAborted();
    sourcePromise ??= readJsonArtifact(inputPath, maximumInputBytes, fileSystem);
    const source = await sourcePromise;
    signal?.throwIfAborted();
    return source;
  };
  return {
    writer: jsonWriterDescriptor,
    input,
    async stage(plan: TypedLabelPlan, signal?: AbortSignal): Promise<StagedTextArtifact> {
      signal?.throwIfAborted();
      const source = await input(signal);
      const transformed = applyJsonPlan(source, plan);
      const target = outputPath === undefined ? deriveRedactedOutputPath(source.path) : resolve(outputPath);
      if (extname(target).toLowerCase() !== '.json') {
        throw new SafeError({ code: 'FORMAT_UNSUPPORTED', message: 'A JSON output path must use the .json extension.', retryable: false, correlationId: 'cor_json_adapter' });
      }
      const base = await stageTextArtifact(source, target, transformed, fileSystem);
      const staged = Object.freeze({ ...base, receipt: createReceipt(plan, base) });
      try {
        signal?.throwIfAborted();
      } catch (error: unknown) {
        await discardStagedTextArtifact(staged, fileSystem);
        throw error;
      }
      return staged;
    },
    async reopen(staged: StagedTextArtifact, signal?: AbortSignal): Promise<JsonArtifact> {
      signal?.throwIfAborted();
      const reopened = await readJsonArtifact(staged.path, defaultMaximumJsonInputBytes, fileSystem);
      signal?.throwIfAborted();
      if (reopened.digest !== staged.digest || reopened.byteLength !== staged.byteLength) {
        throw new SafeError({ code: 'ARTIFACT_DIGEST_MISMATCH', message: 'The staged JSON artifact changed before it could be reopened.', retryable: false, correlationId: 'cor_json_adapter' });
      }
      return reopened;
    },
    async publish(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifactPublication> {
      const source = await input(signal);
      const published = await publishStagedTextArtifact(source, staged, signal, fileSystem);
      return { reference: published.path, byteLength: published.byteLength, digest: published.digest };
    },
    async discard(staged: StagedTextArtifact, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      await discardStagedTextArtifact(staged, fileSystem);
    }
  };
}
