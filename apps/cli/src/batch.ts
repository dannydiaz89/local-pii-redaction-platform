import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

import { SafeError } from '@local-pii/domain';

export const batchTraversalLimits = Object.freeze({
  maximumFiles: 1_000,
  maximumDirectories: 1_000,
  maximumEntries: 10_000,
  maximumTotalInputBytes: 256 * 1024 * 1024,
  maximumPatterns: 32,
  maximumPatternCodeUnits: 256,
  maximumRelativePathCodeUnits: 8 * 1024,
  maximumPatternMatchSteps: 100_000_000,
  defaultTimeoutMs: 60_000,
  minimumTimeoutMs: 1_000,
  maximumTimeoutMs: 300_000
});

export const defaultBatchIncludes = Object.freeze([
  '**/*.txt',
  '**/*.md',
  '**/*.markdown',
  '**/*.json',
  '**/*.csv'
]);

export interface BatchTraversalLimits {
  readonly maximumFiles: number;
  readonly maximumDirectories: number;
  readonly maximumEntries: number;
  readonly maximumTotalInputBytes: number;
  readonly maximumPatternMatchSteps?: number;
}

export interface BatchFile {
  readonly path: string;
  /** Root-relative POSIX-style path retained only in process for deterministic output mapping. */
  readonly relativePath: string;
  readonly byteLength: number;
  readonly device: number;
  readonly inode: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
}

export interface BatchTraversalResult {
  readonly files: readonly BatchFile[];
  readonly directoryCount: number;
  readonly entryCount: number;
  readonly totalInputBytes: number;
}

interface DiscoverBatchOptions {
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
  readonly signal?: AbortSignal;
  readonly limits?: BatchTraversalLimits;
  /** Deterministic race-injection seam used only by containment tests. */
  readonly beforeDirectoryRead?: (directoryPath: string, relativePath: string) => Promise<void>;
}

const supportedExtensions = new Set(['.txt', '.md', '.markdown', '.json', '.csv']);

function batchInputUnsupported(): never {
  throw new SafeError({
    code: 'FORMAT_UNSUPPORTED',
    message: 'The batch input contains an unsupported filesystem entry or leaves the selected root.',
    retryable: false,
    correlationId: 'cor_cli_batch'
  });
}

function batchInputChanged(): never {
  throw new SafeError({
    code: 'JOB_CONFLICT',
    message: 'The batch input changed during bounded traversal.',
    retryable: true,
    correlationId: 'cor_cli_batch'
  });
}

function batchLimitExceeded(): never {
  throw new SafeError({
    code: 'INPUT_TOO_LARGE',
    message: 'The batch input exceeds the bounded traversal or byte limits.',
    retryable: false,
    correlationId: 'cor_cli_batch'
  });
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertBatchPattern(pattern: string): void {
  if (
    pattern.length === 0
    || pattern.length > batchTraversalLimits.maximumPatternCodeUnits
    || pattern.includes('\u0000')
    || pattern.includes('\\')
    || pattern.startsWith('/')
    || pattern.split('/').some((segment) => segment === '.' || segment === '..')
    || /[{}[\]]/u.test(pattern)
  ) throw new TypeError('Invalid bounded batch pattern.');
}

type GlobToken =
  | { readonly kind: 'LITERAL'; readonly value: string }
  | { readonly kind: 'ANY_CHARACTER' }
  | { readonly kind: 'SEGMENT_STAR' }
  | { readonly kind: 'GLOB_STAR' }
  | { readonly kind: 'GLOB_STAR_DIRECTORY' };

function globTokens(pattern: string): readonly GlobToken[] {
  assertBatchPattern(pattern);
  const tokens: GlobToken[] = [];
  const symbols = Array.from(pattern);
  for (let index = 0; index < symbols.length; index += 1) {
    const character = symbols[index] as string;
    if (character === '*') {
      if (symbols[index + 1] === '*') {
        index += 1;
        if (symbols[index + 1] === '/') {
          index += 1;
          tokens.push({ kind: 'GLOB_STAR_DIRECTORY' });
        } else tokens.push({ kind: 'GLOB_STAR' });
      } else tokens.push({ kind: 'SEGMENT_STAR' });
    } else if (character === '?') tokens.push({ kind: 'ANY_CHARACTER' });
    else tokens.push({ kind: 'LITERAL', value: character });
  }
  return Object.freeze(tokens);
}

function matchesGlob(
  tokens: readonly GlobToken[],
  relativePath: string,
  budget: { remaining: number }
): boolean {
  if (relativePath.length > batchTraversalLimits.maximumRelativePathCodeUnits) batchLimitExceeded();
  const symbols = Array.from(relativePath);
  const requiredSteps = (tokens.length + 1) * (symbols.length + 1);
  if (!Number.isSafeInteger(requiredSteps) || requiredSteps > budget.remaining) batchLimitExceeded();
  budget.remaining -= requiredSteps;

  const nextSlash = new Int32Array(symbols.length + 1);
  nextSlash.fill(-1);
  let nearestSlash = -1;
  for (let pathIndex = symbols.length - 1; pathIndex >= 0; pathIndex -= 1) {
    if (symbols[pathIndex] === '/') nearestSlash = pathIndex;
    nextSlash[pathIndex] = nearestSlash;
  }

  const rows = Array.from({ length: tokens.length + 1 }, () => new Uint8Array(symbols.length + 1));
  const terminalRow = rows[tokens.length];
  if (terminalRow === undefined) return false;
  terminalRow[symbols.length] = 1;
  for (let tokenIndex = tokens.length - 1; tokenIndex >= 0; tokenIndex -= 1) {
    const token = tokens[tokenIndex] as GlobToken;
    const row = rows[tokenIndex] as Uint8Array;
    const nextRow = rows[tokenIndex + 1] as Uint8Array;
    for (let pathIndex = symbols.length; pathIndex >= 0; pathIndex -= 1) {
      const character = symbols[pathIndex];
      if (token.kind === 'LITERAL') {
        if (character === token.value && nextRow[pathIndex + 1] === 1) row[pathIndex] = 1;
      } else if (token.kind === 'ANY_CHARACTER') {
        if (character !== undefined && character !== '/' && nextRow[pathIndex + 1] === 1) row[pathIndex] = 1;
      } else if (token.kind === 'SEGMENT_STAR') {
        if (nextRow[pathIndex] === 1
          || (character !== undefined && character !== '/' && row[pathIndex + 1] === 1)) row[pathIndex] = 1;
      } else if (token.kind === 'GLOB_STAR') {
        if (nextRow[pathIndex] === 1 || (character !== undefined && row[pathIndex + 1] === 1)) row[pathIndex] = 1;
      } else {
        const slashIndex = nextSlash[pathIndex] ?? -1;
        if (nextRow[pathIndex] === 1
          || (slashIndex > pathIndex && row[slashIndex + 1] === 1)) row[pathIndex] = 1;
      }
    }
  }
  return rows[0]?.[0] === 1;
}

/** Pure bounded matcher exported for adversarial pattern tests. */
export function matchesBatchPattern(pattern: string, relativePath: string): boolean {
  return matchesGlob(globTokens(pattern), relativePath, {
    remaining: batchTraversalLimits.maximumPatternMatchSteps
  });
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function safeMetadataMatch(
  left: Readonly<{ readonly dev: number | bigint; readonly ino: number | bigint }>,
  right: Readonly<{ readonly dev: number | bigint; readonly ino: number | bigint }>
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeDirectorySnapshotMatch(left: Stats, right: Stats): boolean {
  return safeMetadataMatch(left, right)
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function safeFileSnapshotMatch(file: BatchFile, metadata: Stats): boolean {
  return metadata.isFile()
    && metadata.dev === file.device
    && metadata.ino === file.inode
    && metadata.size === file.byteLength
    && metadata.mtimeMs === file.modifiedAtMs
    && metadata.ctimeMs === file.changedAtMs;
}

export async function assertBatchFileUnchanged(file: BatchFile): Promise<void> {
  try {
    const linkMetadata = await lstat(file.path);
    if (linkMetadata.isSymbolicLink()) batchInputUnsupported();
    const resolvedPath = await realpath(file.path);
    if (resolvedPath !== file.path) batchInputChanged();
    const metadata = await stat(resolvedPath);
    if (!safeMetadataMatch(linkMetadata, metadata) || !safeFileSnapshotMatch(file, metadata)) batchInputChanged();
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    batchInputChanged();
  }
}

export async function discoverBatchFiles(
  requestedRoot: string,
  options: DiscoverBatchOptions
): Promise<BatchTraversalResult> {
  const limits = options.limits ?? batchTraversalLimits;
  if (options.includes.length === 0
    || options.includes.length > batchTraversalLimits.maximumPatterns
    || options.excludes.length > batchTraversalLimits.maximumPatterns
  ) throw new TypeError('Invalid bounded batch pattern count.');
  const includes = options.includes.map(globTokens);
  const excludes = options.excludes.map(globTokens);
  const matchBudget = {
    remaining: limits.maximumPatternMatchSteps ?? batchTraversalLimits.maximumPatternMatchSteps
  };
  if (!Number.isSafeInteger(matchBudget.remaining) || matchBudget.remaining < 1) {
    throw new TypeError('Invalid bounded batch pattern-work limit.');
  }
  const excluded = (relativePath: string): boolean => excludes.some((pattern) =>
    matchesGlob(pattern, relativePath, matchBudget));
  const excludedDirectory = (relativePath: string): boolean => excludes.some((pattern) =>
    matchesGlob(pattern, relativePath, matchBudget)
    || matchesGlob(pattern, `${relativePath}/`, matchBudget)
    || matchesGlob(pattern, `${relativePath}/__batch_probe__`, matchBudget));

  options.signal?.throwIfAborted();
  const requested = resolve(requestedRoot);
  let root: string;
  let rootMetadata: Stats;
  try {
    const linkMetadata = await lstat(requested);
    if (linkMetadata.isSymbolicLink() || !linkMetadata.isDirectory()) batchInputUnsupported();
    root = await realpath(requested);
    rootMetadata = await stat(root);
    if (!rootMetadata.isDirectory() || !safeMetadataMatch(linkMetadata, rootMetadata)) batchInputChanged();
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    batchInputUnsupported();
  }

  const queue: Array<{
    readonly path: string;
    readonly segments: readonly string[];
    readonly device: number;
    readonly inode: number;
  }> = [{ path: root, segments: [], device: rootMetadata.dev, inode: rootMetadata.ino }];
  const files: BatchFile[] = [];
  let directoryCount = 0;
  let entryCount = 0;
  let totalInputBytes = 0;
  while (queue.length > 0) {
    options.signal?.throwIfAborted();
    const directory = queue.shift();
    if (directory === undefined) break;
    directoryCount += 1;
    if (directoryCount > limits.maximumDirectories) batchLimitExceeded();
    let entries;
    try {
      await options.beforeDirectoryRead?.(directory.path, directory.segments.join('/'));
      options.signal?.throwIfAborted();
      const linkMetadata = await lstat(directory.path);
      if (linkMetadata.isSymbolicLink() || !linkMetadata.isDirectory()) batchInputUnsupported();
      const resolvedDirectory = await realpath(directory.path);
      if (resolvedDirectory !== directory.path || !contained(root, resolvedDirectory)) batchInputUnsupported();
      const before = await stat(resolvedDirectory);
      if (!before.isDirectory()
        || !safeMetadataMatch(linkMetadata, before)
        || before.dev !== directory.device
        || before.ino !== directory.inode
      ) batchInputChanged();
      entries = await readdir(resolvedDirectory, { withFileTypes: true });
      const afterLink = await lstat(directory.path);
      const after = await stat(resolvedDirectory);
      if (afterLink.isSymbolicLink()
        || !after.isDirectory()
        || !safeMetadataMatch(afterLink, after)
        || !safeDirectorySnapshotMatch(before, after)
      ) batchInputChanged();
    } catch (error: unknown) {
      if (error instanceof SafeError) throw error;
      batchInputChanged();
    }
    entries.sort((left, right) => lexical(left.name, right.name));
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      entryCount += 1;
      if (entryCount > limits.maximumEntries) batchLimitExceeded();
      const segments = [...directory.segments, entry.name];
      const relativePath = segments.join('/');
      if (relativePath.length > batchTraversalLimits.maximumRelativePathCodeUnits) batchLimitExceeded();
      const candidate = resolve(directory.path, entry.name);
      let linkMetadata;
      let resolvedPath: string;
      let metadata;
      try {
        linkMetadata = await lstat(candidate);
        if (linkMetadata.isSymbolicLink()) batchInputUnsupported();
        resolvedPath = await realpath(candidate);
        if (!contained(root, resolvedPath)) batchInputUnsupported();
        metadata = await stat(resolvedPath);
        if (!safeMetadataMatch(linkMetadata, metadata)) batchInputChanged();
      } catch (error: unknown) {
        if (error instanceof SafeError) throw error;
        batchInputChanged();
      }
      if (metadata.isDirectory()) {
        if (!excludedDirectory(relativePath)) {
          queue.push({ path: resolvedPath, segments, device: metadata.dev, inode: metadata.ino });
        }
        continue;
      }
      if (!metadata.isFile()) batchInputUnsupported();
      if (!supportedExtensions.has(extname(entry.name).toLowerCase())) continue;
      if (excluded(relativePath) || !includes.some((pattern) => matchesGlob(pattern, relativePath, matchBudget))) continue;
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) batchInputChanged();
      totalInputBytes += metadata.size;
      files.push(Object.freeze({
        path: resolvedPath,
        relativePath,
        byteLength: metadata.size,
        device: metadata.dev,
        inode: metadata.ino,
        modifiedAtMs: metadata.mtimeMs,
        changedAtMs: metadata.ctimeMs
      }));
      if (files.length > limits.maximumFiles || totalInputBytes > limits.maximumTotalInputBytes) {
        batchLimitExceeded();
      }
    }
  }
  files.sort((left, right) => lexical(left.path, right.path));
  return Object.freeze({
    files: Object.freeze(files),
    directoryCount,
    entryCount,
    totalInputBytes
  });
}
