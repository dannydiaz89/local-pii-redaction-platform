import { lstat, mkdir, realpath, rmdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { SafeError } from '@local-pii/domain';

import type { BatchFile } from './batch.js';

export interface BatchRedactionTarget {
  readonly input: BatchFile;
  readonly outputPath: string;
  readonly parentPath: string;
  readonly parentDevice: number;
  readonly parentInode: number;
}

export interface PreparedBatchRedaction {
  readonly outputRoot: string;
  readonly targets: readonly BatchRedactionTarget[];
  readonly createdDirectories: readonly string[];
}

const indeterminatePublicationReasons = new Set([
  'stage_cleanup_failed_after_publication',
  'publication_state_unknown'
]);

/**
 * Per-file continuation is safe only before publication has returned and while publication is
 * known not to have happened. These reasons cross the commit barrier even though they are carried
 * by the ordinary privacy-safe error envelope.
 */
export function mustAbortBatchRedaction(error: unknown, publicationReturned: boolean): boolean {
  return publicationReturned || (
    error instanceof SafeError
    && typeof error.details?.reason === 'string'
    && indeterminatePublicationReasons.has(error.details.reason)
  );
}

function unsupported(): never {
  throw new SafeError({
    code: 'FORMAT_UNSUPPORTED',
    message: 'The batch input and output trees must be separate, contained, non-symbolic directories.',
    retryable: false,
    correlationId: 'cor_cli_batch_redact'
  });
}

function collision(): never {
  throw new SafeError({
    code: 'OUTPUT_COLLISION',
    message: 'The batch output mapping collides with an existing or duplicate target.',
    retryable: false,
    correlationId: 'cor_cli_batch_redact'
  });
}

function changed(): never {
  throw new SafeError({
    code: 'JOB_CONFLICT',
    message: 'The batch output tree changed during processing.',
    retryable: true,
    correlationId: 'cor_cli_batch_redact'
  });
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function sameIdentity(left: Stats, right: Readonly<{ readonly parentDevice: number; readonly parentInode: number }>): boolean {
  return left.dev === right.parentDevice && left.ino === right.parentInode;
}

async function canonicalDirectory(requested: string): Promise<{ readonly path: string; readonly metadata: Stats }> {
  try {
    const absolute = resolve(requested);
    const link = await lstat(absolute);
    if (link.isSymbolicLink() || !link.isDirectory()) unsupported();
    const path = await realpath(absolute);
    const metadata = await stat(path);
    if (!metadata.isDirectory() || link.dev !== metadata.dev || link.ino !== metadata.ino) unsupported();
    return { path, metadata };
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    unsupported();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (missing(error)) return false;
    changed();
  }
}

async function assertSafeDirectory(root: string, path: string): Promise<Stats> {
  try {
    const link = await lstat(path);
    if (link.isSymbolicLink() || !link.isDirectory()) unsupported();
    const canonical = await realpath(path);
    const metadata = await stat(canonical);
    if (canonical !== path || !contained(root, canonical) || !metadata.isDirectory()
      || link.dev !== metadata.dev || link.ino !== metadata.ino) unsupported();
    return metadata;
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    changed();
  }
}

/**
 * Performs the complete no-clobber mapping check before creating directories or reading file
 * contents, then creates only the bounded parent directories needed by the verified sessions.
 */
export async function prepareBatchRedaction(
  requestedInputRoot: string,
  requestedOutputRoot: string,
  files: readonly BatchFile[],
  signal?: AbortSignal
): Promise<PreparedBatchRedaction> {
  signal?.throwIfAborted();
  const [input, output] = await Promise.all([
    canonicalDirectory(requestedInputRoot),
    canonicalDirectory(requestedOutputRoot)
  ]);
  if (contained(input.path, output.path) || contained(output.path, input.path)) unsupported();

  const targetPaths = files.map((file) => resolve(output.path, ...file.relativePath.split('/')));
  const collisionKeys = new Set<string>();
  for (const targetPath of targetPaths) {
    signal?.throwIfAborted();
    if (!contained(output.path, targetPath)) unsupported();
    const key = relative(output.path, targetPath).normalize('NFC').toLowerCase();
    if (collisionKeys.has(key)) collision();
    collisionKeys.add(key);
    if (await pathExists(targetPath)) collision();

    let current = dirname(targetPath);
    const parents: string[] = [];
    while (current !== output.path) {
      if (!contained(output.path, current)) unsupported();
      parents.push(current);
      current = dirname(current);
    }
    for (const parent of parents.reverse()) {
      signal?.throwIfAborted();
      if (await pathExists(parent)) await assertSafeDirectory(output.path, parent);
    }
  }

  const createdDirectories: string[] = [];
  try {
    const uniqueParents = [...new Set(targetPaths.map(dirname))]
      .sort((left, right) => left.split(sep).length - right.split(sep).length || (left < right ? -1 : left > right ? 1 : 0));
    for (const parent of uniqueParents) {
      signal?.throwIfAborted();
      const segments = relative(output.path, parent).split(sep).filter(Boolean);
      let current = output.path;
      for (const segment of segments) {
        signal?.throwIfAborted();
        current = join(current, segment);
        if (!await pathExists(current)) {
          await mkdir(current, { mode: 0o700 });
          createdDirectories.push(current);
        }
        await assertSafeDirectory(output.path, current);
      }
    }
    const targets: BatchRedactionTarget[] = [];
    for (let index = 0; index < files.length; index += 1) {
      signal?.throwIfAborted();
      const outputPath = targetPaths[index];
      const inputFile = files[index];
      if (outputPath === undefined || inputFile === undefined) changed();
      if (await pathExists(outputPath)) collision();
      const parentPath = dirname(outputPath);
      const metadata = await assertSafeDirectory(output.path, parentPath);
      targets.push(Object.freeze({
        input: inputFile,
        outputPath,
        parentPath,
        parentDevice: metadata.dev,
        parentInode: metadata.ino
      }));
    }
    return Object.freeze({
      outputRoot: output.path,
      targets: Object.freeze(targets),
      createdDirectories: Object.freeze(createdDirectories)
    });
  } catch (error: unknown) {
    await cleanupBatchDirectories(createdDirectories);
    throw error;
  }
}

export async function assertBatchRedactionTarget(target: BatchRedactionTarget, outputRoot: string): Promise<void> {
  if (await pathExists(target.outputPath)) collision();
  const parent = await assertSafeDirectory(outputRoot, target.parentPath);
  if (!sameIdentity(parent, target)) changed();
}

export async function assertPublishedBatchTarget(target: BatchRedactionTarget, outputRoot: string): Promise<void> {
  const parent = await assertSafeDirectory(outputRoot, target.parentPath);
  if (!sameIdentity(parent, target)) changed();
  try {
    const link = await lstat(target.outputPath);
    const canonical = await realpath(target.outputPath);
    const metadata = await stat(canonical);
    if (link.isSymbolicLink() || !link.isFile() || canonical !== target.outputPath
      || !contained(outputRoot, canonical) || metadata.dev !== link.dev || metadata.ino !== link.ino) changed();
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    changed();
  }
}

/** Removes only empty directories created by this attempt, deepest first. */
export async function cleanupBatchDirectories(createdDirectories: readonly string[]): Promise<void> {
  for (const path of [...createdDirectories].reverse()) {
    try {
      await rmdir(path);
    } catch {
      // Published files or a concurrent entry make the directory intentionally non-empty.
    }
  }
}
