import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';

import { SafeError, parseSha256Digest, type Sha256Digest } from '@local-pii/domain';

const utf8Bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
export const textAdapterVersion = '0.1.0';
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

export interface StagedTextArtifact extends WrittenTextArtifact {
  readonly targetPath: string;
}

function digestBytes(bytes: Uint8Array): Sha256Digest {
  return parseSha256Digest(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
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
): Promise<StagedTextArtifact> {
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

  return { path: temporary, targetPath: target, byteLength: written.byteLength, digest };
}

export async function publishStagedTextArtifact(
  source: TextArtifact,
  staged: StagedTextArtifact
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

export async function discardStagedTextArtifact(staged: StagedTextArtifact): Promise<void> {
  await unlink(staged.path).catch(() => undefined);
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
