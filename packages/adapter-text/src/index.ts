import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';

import { SafeError, parseSha256Digest, type Sha256Digest } from '@local-pii/domain';
import {
  computeWriterReceiptDigest,
  type RedactionWriterReceiptContract
} from '@local-pii/contracts';
import { assertTypedLabelPlanIntegrity, type TypedLabelPlan } from '@local-pii/redaction';

const utf8Bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
export const textAdapterVersion = '0.1.0';
export const textWriterDescriptor = Object.freeze({ id: 'text-adapter', version: textAdapterVersion });
export const defaultMaximumInputBytes = 100 * 1024 * 1024;
export const textAdapterCapabilityDescriptor = {
  id: 'text',
  adapter: 'text-adapter',
  version: textAdapterVersion,
  mediaTypes: ['text/plain', 'text/markdown'],
  extensions: ['.txt', '.md', '.markdown'],
  operations: ['PROBE', 'INSPECT', 'EXTRACT', 'SCAN', 'REDACT', 'VERIFY'],
  assurance: 'NATIVE_REDACTION',
  features: [
    { id: 'utf-8', status: 'SUPPORTED' },
    { id: 'utf-8-bom', status: 'SUPPORTED' },
    { id: 'line-ending-preservation', status: 'SUPPORTED' },
    { id: 'atomic-publication', status: 'SUPPORTED' },
    { id: 'symbolic-links', status: 'BLOCKED' },
    { id: 'nul-bytes', status: 'BLOCKED' }
  ],
  verificationProfiles: ['text-rescan-v1'],
  limits: { maximumInputBytes: defaultMaximumInputBytes }
} as const;

export interface TextArtifact {
  /** Opaque application-level handle; the local implementation uses `path`. */
  readonly reference: string;
  readonly path: string;
  readonly displayName: string;
  readonly mediaType: 'text/plain' | 'text/markdown';
  readonly byteLength: number;
  readonly digest: Sha256Digest;
  readonly extractionRevision: Sha256Digest;
  readonly text: string;
  readonly hasUtf8Bom: boolean;
}

export interface WrittenTextArtifact {
  readonly path: string;
  readonly byteLength: number;
  readonly digest: Sha256Digest;
}

/** A storage-neutral handle to a successfully published artifact. */
export interface TextArtifactPublication {
  readonly reference: string;
  readonly byteLength: number;
  readonly digest: Sha256Digest;
}

export interface StagedTextArtifact extends WrittenTextArtifact {
  /** Opaque application-level handle; the local implementation uses `path`. */
  readonly reference: string;
  readonly targetPath: string;
  /**
   * Privacy-safe evidence of the exact immutable plan actions applied to this
   * staged artifact.  It deliberately contains neither paths nor source text.
   */
  readonly receipt: TextWriterReceipt;
}

/**
 * A deterministic, privacy-safe writer attestation for action reconciliation.
 * The verifier compares this receipt with the full immutable plan; neither
 * source text, replacement text, nor storage locations are reported here.
 */
export type TextWriterReceipt = RedactionWriterReceiptContract.WriterReceipt;

/**
 * The read side of a text-artifact exchange.  This is deliberately structural:
 * the application layer can depend on this shape without depending on the
 * local filesystem adapter.  A future API or durable artifact store can
 * implement the same operations without changing the processing pipeline.
 */
export interface TextInputSession {
  input(signal?: AbortSignal): Promise<TextArtifact>;
}

/**
 * A short-lived artifact exchange used by the local CLI.  `stage` creates a
 * private candidate only when redaction needs one; scan and verify use `input`
 * alone and therefore create no files.  `publish` returns a neutral reference
 * whose local implementation is the absolute output path.
 */
export interface TextArtifactSession extends TextInputSession {
  readonly writer: Readonly<{ readonly id: string; readonly version: string }>;
  stage(plan: TypedLabelPlan, signal?: AbortSignal): Promise<StagedTextArtifact>;
  reopen(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifact>;
  publish(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifactPublication>;
  discard(staged: StagedTextArtifact, signal?: AbortSignal): Promise<void>;
}

function digestBytes(bytes: Uint8Array): Sha256Digest {
  return parseSha256Digest(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

function actionIdIsSafe(id: string): boolean {
  return /^act_[0-9A-HJKMNP-TV-Z]{26}$/u.test(id);
}

function assertWriterPlanCanApply(plan: TypedLabelPlan, source: TextArtifact): void {
  try {
    assertTypedLabelPlanIntegrity(plan);
  } catch {
    throw new SafeError({
      code: 'REDACTION_PLAN_CONFLICT',
      message: 'The redaction plan provenance is invalid.',
      retryable: false,
      correlationId: 'cor_text_adapter'
    });
  }
  if (
    plan.inputDigest !== source.digest
    || plan.extractionRevision !== source.extractionRevision
  ) {
    throw new SafeError({
      code: 'REDACTION_PLAN_CONFLICT',
      message: 'The redaction plan does not match this input.',
      retryable: false,
      correlationId: 'cor_text_adapter'
    });
  }
  if (plan.writer.id !== textWriterDescriptor.id || plan.writer.version !== textWriterDescriptor.version) {
    throw new SafeError({
      code: 'REDACTION_PLAN_CONFLICT',
      message: 'The redaction plan targets a different writer.',
      retryable: false,
      correlationId: 'cor_text_adapter'
    });
  }
  if (
    !Number.isSafeInteger(plan.expectedActionCount)
    || plan.expectedActionCount < 0
    || plan.expectedActionCount > 100_000
    || plan.expectedActionCount !== plan.actions.length
  ) {
    throw new SafeError({
      code: 'REDACTION_COUNT_MISMATCH',
      message: 'The redaction plan action count is invalid.',
      retryable: false,
      correlationId: 'cor_text_adapter'
    });
  }
  const sourceLength = Array.from(source.text).length;
  const actionIds = new Set<string>();
  const intervals: Array<readonly [number, number]> = [];
  for (const action of plan.actions) {
    if (
      !actionIdIsSafe(action.id)
      || actionIds.has(action.id)
      || !Number.isSafeInteger(action.start)
      || !Number.isSafeInteger(action.end)
      || action.start < 0
      || action.start >= action.end
      || action.end > sourceLength
      || typeof action.replacement !== 'string'
      || Array.from(action.replacement).length > 500
    ) {
      throw new SafeError({
        code: 'REDACTION_PLAN_CONFLICT',
        message: 'The redaction plan actions are invalid.',
        retryable: false,
        correlationId: 'cor_text_adapter'
      });
    }
    actionIds.add(action.id);
    intervals.push([action.start, action.end]);
  }
  intervals.sort(([leftStart, leftEnd], [rightStart, rightEnd]) => leftStart - rightStart || leftEnd - rightEnd);
  for (let index = 1; index < intervals.length; index += 1) {
    if ((intervals[index - 1]?.[1] ?? 0) > (intervals[index]?.[0] ?? 0)) {
      throw new SafeError({
        code: 'REDACTION_PLAN_CONFLICT',
        message: 'The redaction plan contains overlapping actions.',
        retryable: false,
        correlationId: 'cor_text_adapter'
      });
    }
  }
}

function applyWriterPlan(text: string, plan: TypedLabelPlan): string {
  const codePoints = Array.from(text);
  let output = codePoints;
  for (const action of [...plan.actions].sort((left, right) => right.start - left.start || right.end - left.end)) {
    output = [...output.slice(0, action.start), action.replacement, ...output.slice(action.end)];
  }
  return output.join('');
}

function receiptWithoutDigest(
  plan: TypedLabelPlan,
  staged: Pick<WrittenTextArtifact, 'digest' | 'byteLength'>
): Omit<TextWriterReceipt, 'receiptDigest'> {
  return {
    schemaVersion: '1.0.0',
    planDigest: parseSha256Digest(plan.digest),
    writer: Object.freeze({ id: textWriterDescriptor.id, version: textWriterDescriptor.version }),
    stagedDigest: staged.digest,
    stagedByteLength: staged.byteLength,
    expectedActionCount: plan.expectedActionCount,
    appliedActionCount: plan.actions.length,
    appliedActionIds: Object.freeze(plan.actions.map(({ id }) => id)) as string[]
  };
}

export function createTextWriterReceipt(
  plan: TypedLabelPlan,
  staged: Pick<WrittenTextArtifact, 'digest' | 'byteLength'>
): TextWriterReceipt {
  const unsigned = receiptWithoutDigest(plan, staged);
  return Object.freeze({
    ...unsigned,
    receiptDigest: parseSha256Digest(computeWriterReceiptDigest(unsigned))
  });
}

/** Rejects a receipt whose action coverage or staged-byte binding was altered. */
export function assertTextWriterReceiptIntegrity(receipt: TextWriterReceipt): void {
  parseSha256Digest(receipt.planDigest);
  parseSha256Digest(receipt.stagedDigest);
  const schemaVersion = receipt.schemaVersion as string;
  if (
    schemaVersion !== '1.0.0'
    || receipt.writer.id !== textWriterDescriptor.id
    || receipt.writer.version !== textWriterDescriptor.version
    || !Number.isSafeInteger(receipt.appliedActionCount)
    || receipt.appliedActionCount < 0
    || receipt.appliedActionCount !== receipt.appliedActionIds.length
    || !Number.isSafeInteger(receipt.expectedActionCount)
    || receipt.expectedActionCount < 0
    || receipt.expectedActionCount !== receipt.appliedActionCount
    || !Number.isSafeInteger(receipt.stagedByteLength)
    || receipt.stagedByteLength < 0
    || new Set(receipt.appliedActionIds).size !== receipt.appliedActionIds.length
    || !receipt.appliedActionIds.every(actionIdIsSafe)
  ) {
    throw new TypeError('The text writer receipt is invalid.');
  }
  const { receiptDigest, ...unsigned } = receipt;
  if (parseSha256Digest(receiptDigest) !== computeWriterReceiptDigest(unsigned)) {
    throw new TypeError('The text writer receipt digest is invalid.');
  }
}

function extractionDigest(text: string): Sha256Digest {
  const hash = createHash('sha256').update('local-pii:canonical-text:v1\u0000', 'utf8').update(text, 'utf8').digest('hex');
  return parseSha256Digest(`sha256:${hash}`);
}

function supportedMediaType(path: string): 'text/plain' | 'text/markdown' {
  const extension = extname(path).toLowerCase();
  if (extension === '.txt') return 'text/plain';
  if (extension === '.md' || extension === '.markdown') return 'text/markdown';
  throw new SafeError({
    code: 'FORMAT_UNSUPPORTED',
    message: 'Only UTF-8 TXT and Markdown files are supported by this release.',
    retryable: false,
    correlationId: 'cor_text_adapter'
  });
}

export async function readTextArtifact(inputPath: string, maximumBytes = defaultMaximumInputBytes): Promise<TextArtifact> {
  const requestedMetadata = await lstat(inputPath);
  if (requestedMetadata.isSymbolicLink()) {
    throw new SafeError({ code: 'FORMAT_UNSUPPORTED', message: 'Symbolic-link inputs are not supported.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  const path = await realpath(inputPath);
  const metadata = await lstat(path);
  if (!metadata.isFile()) {
    throw new SafeError({ code: 'FORMAT_UNSUPPORTED', message: 'The input must be a regular file.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  if (metadata.size > maximumBytes) {
    throw new SafeError({ code: 'INPUT_TOO_LARGE', message: 'The input exceeds the configured byte limit.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > maximumBytes) {
    throw new SafeError({ code: 'INPUT_TOO_LARGE', message: 'The input exceeds the configured byte limit.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  const hasUtf8Bom = bytes.length >= 3 && bytes[0] === utf8Bom[0] && bytes[1] === utf8Bom[1] && bytes[2] === utf8Bom[2];
  const content = hasUtf8Bom ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new SafeError({ code: 'FORMAT_CORRUPT', message: 'The input is not valid UTF-8 text.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  if (text.includes('\u0000')) {
    throw new SafeError({ code: 'FORMAT_CORRUPT', message: 'The text input contains unsupported NUL bytes.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  return {
    reference: path,
    path,
    displayName: basename(path),
    mediaType: supportedMediaType(path),
    byteLength: bytes.byteLength,
    digest: digestBytes(bytes),
    extractionRevision: extractionDigest(text),
    text,
    hasUtf8Bom
  };
}

export function deriveRedactedOutputPath(inputPath: string): string {
  const extension = extname(inputPath);
  return resolve(dirname(inputPath), `${basename(inputPath, extension)}.redacted${extension}`);
}

export async function stageTextArtifact(
  source: TextArtifact,
  outputPath: string,
  text: string
): Promise<Omit<StagedTextArtifact, 'receipt'>> {
  const target = resolve(outputPath);
  if (target === source.path) {
    throw new SafeError({ code: 'OUTPUT_COLLISION', message: 'The output path must be different from the input path.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  try {
    await stat(target);
    throw new SafeError({ code: 'OUTPUT_COLLISION', message: 'The output path already exists.', retryable: false, correlationId: 'cor_text_adapter' });
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const content = new TextEncoder().encode(text);
  const bytes = source.hasUtf8Bom
    ? Buffer.concat([Buffer.from(utf8Bom), Buffer.from(content)])
    : Buffer.from(content);
  const extension = extname(target);
  const temporary = resolve(
    dirname(target),
    `.${basename(target, extension)}.${randomUUID()}.staged${extension}`
  );

  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SafeError({ code: 'OUTPUT_COLLISION', message: 'The output path already exists.', retryable: false, correlationId: 'cor_text_adapter' });
    }
    throw error;
  }

  const written = await readFile(temporary);
  const digest = digestBytes(written);
  if (!written.equals(bytes)) {
    await unlink(temporary).catch(() => undefined);
    throw new SafeError({ code: 'STORAGE_UNAVAILABLE', message: 'The derived artifact failed digest verification.', retryable: true, correlationId: 'cor_text_adapter' });
  }

  return { reference: temporary, path: temporary, targetPath: target, byteLength: written.byteLength, digest };
}

export async function publishStagedTextArtifact(
  source: TextArtifact,
  staged: Pick<StagedTextArtifact, 'path' | 'targetPath' | 'byteLength' | 'digest'>
): Promise<WrittenTextArtifact> {
  const stagedBytes = await readFile(staged.path);
  if (digestBytes(stagedBytes) !== staged.digest) {
    throw new SafeError({ code: 'STORAGE_UNAVAILABLE', message: 'The staged artifact changed before publication.', retryable: true, correlationId: 'cor_text_adapter' });
  }
  const inputBeforePublish = await readFile(source.path);
  if (digestBytes(inputBeforePublish) !== source.digest) {
    throw new SafeError({ code: 'JOB_CONFLICT', message: 'The input changed while it was being processed.', retryable: true, correlationId: 'cor_text_adapter' });
  }
  try {
    await link(staged.path, staged.targetPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SafeError({ code: 'OUTPUT_COLLISION', message: 'The output path already exists.', retryable: false, correlationId: 'cor_text_adapter' });
    }
    throw error;
  }

  try {
    const currentInput = await readFile(source.path);
    if (digestBytes(currentInput) !== source.digest) {
      throw new SafeError({ code: 'JOB_CONFLICT', message: 'The input changed while it was being processed.', retryable: true, correlationId: 'cor_text_adapter' });
    }
    await unlink(staged.path);
    return { path: staged.targetPath, byteLength: staged.byteLength, digest: staged.digest };
  } catch (error: unknown) {
    await unlink(staged.targetPath).catch(() => undefined);
    throw error;
  }
}

export async function discardStagedTextArtifact(staged: Pick<StagedTextArtifact, 'path'>): Promise<void> {
  try {
    await unlink(staged.path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new SafeError({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The staged artifact could not be removed.',
      retryable: true,
      correlationId: 'cor_text_adapter'
    });
  }
}

/**
 * Creates a filesystem-backed session for one local input and, optionally, a
 * caller-selected output.  Input bytes are cached after the first read so that
 * staging and publication are bound to the exact source the caller processed.
 * The default redacted path is intentionally calculated only by `stage`.
 */
export function createLocalTextArtifactSession(
  inputPath: string,
  outputPath?: string,
  maximumInputBytes = defaultMaximumInputBytes
): TextArtifactSession {
  let sourcePromise: Promise<TextArtifact> | undefined;

  const input = async (signal?: AbortSignal): Promise<TextArtifact> => {
    signal?.throwIfAborted();
    sourcePromise ??= readTextArtifact(inputPath, maximumInputBytes);
    const source = await sourcePromise;
    signal?.throwIfAborted();
    return source;
  };

  return {
    writer: textWriterDescriptor,
    input,
    async stage(plan: TypedLabelPlan, signal?: AbortSignal): Promise<StagedTextArtifact> {
      signal?.throwIfAborted();
      const source = await input(signal);
      signal?.throwIfAborted();
      assertWriterPlanCanApply(plan, source);
      const text = applyWriterPlan(source.text, plan);
      const target = outputPath === undefined ? deriveRedactedOutputPath(source.path) : resolve(outputPath);
      const stagedArtifact = await stageTextArtifact(source, target, text);
      const staged = Object.freeze({
        ...stagedArtifact,
        receipt: createTextWriterReceipt(plan, stagedArtifact)
      });
      try {
        signal?.throwIfAborted();
      } catch (error: unknown) {
        await discardStagedTextArtifact(staged);
        throw error;
      }
      return staged;
    },
    async reopen(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifact> {
      signal?.throwIfAborted();
      const reopened = await readTextArtifact(staged.path);
      signal?.throwIfAborted();
      if (reopened.digest !== staged.digest || reopened.byteLength !== staged.byteLength) {
        throw new SafeError({
          code: 'STORAGE_UNAVAILABLE',
          message: 'The staged artifact changed before it could be reopened.',
          retryable: true,
          correlationId: 'cor_text_adapter'
        });
      }
      return reopened;
    },
    async publish(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifactPublication> {
      signal?.throwIfAborted();
      const published = await publishStagedTextArtifact(await input(signal), staged);
      return { reference: published.path, byteLength: published.byteLength, digest: published.digest };
    },
    async discard(staged: StagedTextArtifact, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      await discardStagedTextArtifact(staged);
    }
  };
}

export async function writeTextArtifact(
  source: TextArtifact,
  outputPath: string,
  text: string
): Promise<WrittenTextArtifact> {
  const staged = await stageTextArtifact(source, outputPath, text);
  try {
    return await publishStagedTextArtifact(source, staged);
  } catch (error: unknown) {
    await discardStagedTextArtifact(staged);
    throw error;
  }
}
