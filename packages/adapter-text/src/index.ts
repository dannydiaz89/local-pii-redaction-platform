import { createHash, randomUUID } from 'node:crypto';
import { constants, type Dir, type Stats } from 'node:fs';
import { link, lstat, open, opendir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';

import { SafeError, parseSha256Digest, unicodeCodePointLength, type Sha256Digest } from '@local-pii/domain';
import {
  computeWriterReceiptDigest,
  type RedactionWriterReceiptContract
} from '@local-pii/contracts';
import { applyTypedLabelPlan, assertTypedLabelPlanIntegrity, type TypedLabelPlan } from '@local-pii/redaction';

const utf8Bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
export const textAdapterVersion = '0.1.0';
export const textWriterDescriptor = Object.freeze({
  id: 'text-adapter',
  version: textAdapterVersion,
  digest: parseSha256Digest('sha256:319fc7160f3540f36258b3853abcb4130516bdf4e1ea4242f7f89ef69ac7a70f')
});
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

/**
 * Format-neutral result of the hardened local UTF-8 reader. Structured local
 * adapters reuse this boundary before performing their own native parsing.
 */
export interface LocalUtf8Artifact {
  readonly reference: string;
  readonly path: string;
  readonly displayName: string;
  readonly byteLength: number;
  readonly digest: Sha256Digest;
  readonly text: string;
  readonly hasUtf8Bom: boolean;
}

export interface WrittenTextArtifact {
  readonly path: string;
  readonly byteLength: number;
  readonly digest: Sha256Digest;
}

/** The narrow local-filesystem surface used by text artifact read/write operations. */
export interface TextArtifactFileHandle {
  writeFile(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface TextArtifactReadHandle {
  stat(): Promise<Stats>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

/**
 * Injectable filesystem boundary for deterministic fault and recovery tests. Production
 * callers use {@link defaultTextArtifactFileSystem}; no injection is required.
 */
export interface TextArtifactFileSystem {
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Stats>;
  open(path: string, flags: number, mode: number): Promise<TextArtifactFileHandle>;
  openRead(path: string): Promise<TextArtifactReadHandle>;
  opendir(path: string): Promise<Dir>;
  readFile(path: string): Promise<Buffer>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** The real local filesystem implementation used unless a deterministic test seam is supplied. */
export const defaultTextArtifactFileSystem: TextArtifactFileSystem = Object.freeze({
  lstat,
  realpath,
  stat,
  open,
  async openRead(path: string): Promise<TextArtifactReadHandle> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return {
      stat: () => handle.stat(),
      read: async (buffer, offset, length, position) => await handle.read(buffer, offset, length, position),
      close: () => handle.close()
    };
  },
  opendir,
  readFile,
  link,
  unlink
});

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
 * Bounded, privacy-safe counts from an explicit staging-directory inventory.
 * Candidate paths and filenames are deliberately never returned.
 */
export interface TextStageInventory {
  readonly scannedEntryCount: number;
  readonly matchingStageFileCount: number;
  readonly staleStageFileCount: number;
  readonly freshStageFileCount: number;
  readonly protectedEntryCount: number;
  readonly skippedUnsafeEntryCount: number;
  readonly capped: boolean;
}

/** Options for explicitly inventorying or cleaning a selected staging parent. */
export interface TextStageReconciliationOptions {
  /** Exact intended output whose convention-matching stage candidates may be considered. */
  readonly outputPath: string;
  /** Files must be at least this old to be considered stale; defaults to one day. */
  readonly minimumAgeMs?: number;
  /** Maximum direct directory entries inspected; defaults to 1,000 and is capped at 10,000. */
  readonly maximumEntries?: number;
  /** Maximum stale files an explicit cleanup may remove; defaults to 100 and is capped at 1,000. */
  readonly maximumDeletes?: number;
  /** Explicit input/output paths in the selected directory that must never be removed. */
  readonly protectedPaths?: readonly string[];
  /** Injectable wall clock for deterministic callers and tests. */
  readonly now?: number;
  /** Cooperatively stops inventory or further deletions. */
  readonly signal?: AbortSignal;
  /** Injectable filesystem used by deterministic fault tests. */
  readonly fileSystem?: TextArtifactFileSystem;
}

/** Privacy-safe outcome of an explicit stale-stage cleanup. */
export interface TextStageCleanupResult extends TextStageInventory {
  readonly deletedStageFileCount: number;
  readonly deletionFailureCount: number;
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
  readonly writer: Readonly<{ readonly id: string; readonly version: string; readonly digest: Sha256Digest }>;
  stage(plan: TypedLabelPlan, signal?: AbortSignal): Promise<StagedTextArtifact>;
  reopen(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifact>;
  publish(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifactPublication>;
  discard(staged: StagedTextArtifact, signal?: AbortSignal): Promise<void>;
}

export type EphemeralTextArtifactSource = Readonly<Omit<TextArtifact, 'path'>>;

/**
 * Owns a process-local staged/published byte sequence for non-filesystem composition roots.
 * Returned bytes are detached copies; `dispose` overwrites buffers still owned by this handle.
 */
export interface EphemeralTextArtifactSessionHandle {
  readonly session: TextArtifactSession;
  publishedBytes(): Uint8Array | undefined;
  dispose(): void;
}

/** Format-neutral artifact shape accepted by the process-local native session mechanics. */
export interface EphemeralNativeArtifact extends LocalUtf8Artifact {
  readonly mediaType: string;
  readonly extractionRevision: Sha256Digest;
  readonly text: string;
}

/** Adapter-owned callbacks for a native in-memory writer and native reopen boundary. */
export interface EphemeralNativeArtifactSessionOptions<Artifact extends EphemeralNativeArtifact> {
  readonly source: Artifact;
  readonly writer: Readonly<{ readonly id: string; readonly version: string; readonly digest: Sha256Digest }>;
  readonly maximumOutputBytes: number;
  encodePlan(source: Artifact, plan: TypedLabelPlan): Uint8Array;
  createReceipt(
    plan: TypedLabelPlan,
    staged: Readonly<{ readonly digest: Sha256Digest; readonly byteLength: number }>
  ): TextWriterReceipt;
  reopen(
    bytes: Uint8Array,
    staged: StagedTextArtifact,
    signal?: AbortSignal
  ): Promise<Artifact> | Artifact;
}

/** Owns the only mutable staged and published buffers for one native in-memory session. */
export interface EphemeralNativeArtifactSessionHandle<Artifact extends EphemeralNativeArtifact> {
  readonly session: Readonly<{
    readonly writer: EphemeralNativeArtifactSessionOptions<Artifact>['writer'];
    input(signal?: AbortSignal): Promise<Artifact>;
    stage(plan: TypedLabelPlan, signal?: AbortSignal): Promise<StagedTextArtifact>;
    reopen(staged: StagedTextArtifact, signal?: AbortSignal): Promise<Artifact>;
    publish(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifactPublication>;
    discard(staged: StagedTextArtifact, signal?: AbortSignal): Promise<void>;
  }>;
  publishedBytes(): Uint8Array | undefined;
  dispose(): void;
}

function digestBytes(bytes: Uint8Array): Sha256Digest {
  return parseSha256Digest(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

const defaultStageMinimumAgeMs = 24 * 60 * 60 * 1000;
const defaultStageMaximumEntries = 1_000;
const defaultStageMaximumDeletes = 100;
const absoluteStageMaximumEntries = 10_000;
const absoluteStageMaximumDeletes = 1_000;
const randomUuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface StaleTextStageCandidate {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly linkCount: number;
}

interface TextStageInventoryInternal {
  readonly report: TextStageInventory;
  readonly staleCandidates: readonly StaleTextStageCandidate[];
}

function boundedStageOption(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError(`${name} must be a bounded positive integer.`);
  }
  return resolved;
}

function stageReconciliationConfiguration(options: TextStageReconciliationOptions): Readonly<{
  minimumAgeMs: number;
  maximumEntries: number;
  maximumDeletes: number;
  now: number;
}> {
  const minimumAgeMs = options.minimumAgeMs ?? defaultStageMinimumAgeMs;
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 1 || minimumAgeMs > 31 * defaultStageMinimumAgeMs) {
    throw new TypeError('minimumAgeMs must be a bounded positive integer.');
  }
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('now must be a non-negative integer timestamp.');
  return {
    minimumAgeMs,
    maximumEntries: boundedStageOption(options.maximumEntries, defaultStageMaximumEntries, absoluteStageMaximumEntries, 'maximumEntries'),
    maximumDeletes: boundedStageOption(options.maximumDeletes, defaultStageMaximumDeletes, absoluteStageMaximumDeletes, 'maximumDeletes'),
    now
  };
}

async function selectedStageParent(parentDirectory: string, fileSystem: TextArtifactFileSystem): Promise<string> {
  let selected;
  try {
    selected = await fileSystem.lstat(parentDirectory);
  } catch {
    throw new SafeError({ code: 'STORAGE_UNAVAILABLE', message: 'The selected staging directory is unavailable.', retryable: true, correlationId: 'cor_text_adapter' });
  }
  if (selected.isSymbolicLink() || !selected.isDirectory()) {
    throw new SafeError({ code: 'STORAGE_UNAVAILABLE', message: 'The selected staging directory is unavailable.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  let canonical: string;
  let canonicalMetadata;
  try {
    canonical = await fileSystem.realpath(parentDirectory);
    canonicalMetadata = await fileSystem.lstat(canonical);
  } catch {
    throw new SafeError({ code: 'STORAGE_UNAVAILABLE', message: 'The selected staging directory is unavailable.', retryable: true, correlationId: 'cor_text_adapter' });
  }
  if (
    canonicalMetadata.isSymbolicLink()
    || !canonicalMetadata.isDirectory()
    || canonicalMetadata.dev !== selected.dev
    || canonicalMetadata.ino !== selected.ino
  ) {
    throw new SafeError({ code: 'STORAGE_UNAVAILABLE', message: 'The selected staging directory is unavailable.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  return canonical;
}

async function protectedStageNames(
  parentDirectory: string,
  protectedPaths: readonly string[] | undefined,
  fileSystem: TextArtifactFileSystem
): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  for (const protectedPath of protectedPaths ?? []) {
    const resolved = resolve(parentDirectory, protectedPath);
    try {
      if (await fileSystem.realpath(dirname(resolved)) === parentDirectory) names.add(basename(resolved));
    } catch {
      // A missing parent cannot contain a candidate in the selected existing directory.
    }
  }
  return names;
}

function isStageForOutput(name: string, outputPath: string): boolean {
  const extension = extname(outputPath);
  const prefix = `.${basename(outputPath, extension)}.`;
  const suffix = `.staged${extension}`;
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
  const uuid = name.slice(prefix.length, name.length - suffix.length);
  return randomUuidV4Pattern.test(uuid);
}

async function hasSafeStageLinkage(
  metadata: Stats,
  outputPath: string,
  fileSystem: TextArtifactFileSystem
): Promise<boolean> {
  if (metadata.nlink === 1) return true;
  if (metadata.nlink !== 2) return false;
  try {
    const outputMetadata = await fileSystem.lstat(outputPath);
    return outputMetadata.isFile()
      && outputMetadata.dev === metadata.dev
      && outputMetadata.ino === metadata.ino;
  } catch {
    return false;
  }
}

async function inventoryTextStagesInternal(options: TextStageReconciliationOptions): Promise<TextStageInventoryInternal> {
  options.signal?.throwIfAborted();
  const fileSystem = options.fileSystem ?? defaultTextArtifactFileSystem;
  const configuration = stageReconciliationConfiguration(options);
  const outputPath = resolve(options.outputPath);
  const parentDirectory = await selectedStageParent(dirname(outputPath), fileSystem);
  const protectedNames = await protectedStageNames(parentDirectory, [outputPath, ...(options.protectedPaths ?? [])], fileSystem);
  const names: string[] = [];
  let capped = false;
  try {
    const directory = await fileSystem.opendir(parentDirectory);
    for await (const entry of directory) {
      options.signal?.throwIfAborted();
      if (names.length >= configuration.maximumEntries) {
        capped = true;
        break;
      }
      names.push(entry.name);
    }
    names.sort();
  } catch {
    options.signal?.throwIfAborted();
    throw new SafeError({ code: 'STORAGE_UNAVAILABLE', message: 'The selected staging directory is unavailable.', retryable: true, correlationId: 'cor_text_adapter' });
  }

  let matchingStageFileCount = 0;
  let freshStageFileCount = 0;
  let protectedEntryCount = 0;
  let skippedUnsafeEntryCount = 0;
  const staleCandidates: StaleTextStageCandidate[] = [];
  const staleBefore = configuration.now - configuration.minimumAgeMs;

  for (const name of names) {
    options.signal?.throwIfAborted();
    if (!isStageForOutput(name, outputPath)) continue;
    const candidatePath = resolve(parentDirectory, name);
    let metadata;
    try {
      metadata = await fileSystem.lstat(candidatePath);
    } catch {
      skippedUnsafeEntryCount += 1;
      continue;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      skippedUnsafeEntryCount += 1;
      continue;
    }
    matchingStageFileCount += 1;
    if (protectedNames.has(name)) {
      protectedEntryCount += 1;
      continue;
    }
    if (metadata.mtimeMs > staleBefore) {
      freshStageFileCount += 1;
      continue;
    }
    if (!await hasSafeStageLinkage(metadata, outputPath, fileSystem)) {
      skippedUnsafeEntryCount += 1;
      continue;
    }
    staleCandidates.push({
      path: candidatePath,
      device: metadata.dev,
      inode: metadata.ino,
      size: metadata.size,
      modifiedAtMs: metadata.mtimeMs,
      linkCount: metadata.nlink
    });
  }

  options.signal?.throwIfAborted();
  return {
    report: Object.freeze({
      scannedEntryCount: names.length,
      matchingStageFileCount,
      staleStageFileCount: staleCandidates.length,
      freshStageFileCount,
      protectedEntryCount,
      skippedUnsafeEntryCount,
      capped
    }),
    staleCandidates: Object.freeze(staleCandidates)
  };
}

/**
 * Lists bounded counts for convention-matching stale stage candidates without deleting anything.
 * The selected parent must be explicit and non-symbolic; candidate names are never returned.
 */
export async function inventoryTextStages(options: TextStageReconciliationOptions): Promise<TextStageInventory> {
  return (await inventoryTextStagesInternal(options)).report;
}

/**
 * Explicitly removes only stale, regular files bearing the exact project stage convention.
 * Inputs and requested outputs supplied through `protectedPaths` are excluded; this never recurses.
 */
export async function cleanupStaleTextStages(options: TextStageReconciliationOptions): Promise<TextStageCleanupResult> {
  const fileSystem = options.fileSystem ?? defaultTextArtifactFileSystem;
  const configuration = stageReconciliationConfiguration(options);
  const inventory = await inventoryTextStagesInternal(options);
  let deletedStageFileCount = 0;
  let deletionFailureCount = 0;
  const exceedsDeleteLimit = inventory.staleCandidates.length > configuration.maximumDeletes;
  const candidates = inventory.report.capped || exceedsDeleteLimit
    ? []
    : inventory.staleCandidates;

  for (const candidate of candidates) {
    options.signal?.throwIfAborted();
    try {
      const metadata = await fileSystem.lstat(candidate.path);
      if (
        metadata.isSymbolicLink()
        || !metadata.isFile()
        || metadata.dev !== candidate.device
        || metadata.ino !== candidate.inode
        || metadata.size !== candidate.size
        || metadata.mtimeMs !== candidate.modifiedAtMs
        || metadata.nlink !== candidate.linkCount
        || !await hasSafeStageLinkage(metadata, resolve(options.outputPath), fileSystem)
      ) {
        deletionFailureCount += 1;
        continue;
      }
      options.signal?.throwIfAborted();
      await fileSystem.unlink(candidate.path);
      deletedStageFileCount += 1;
    } catch (error: unknown) {
      options.signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') deletionFailureCount += 1;
    }
  }

  return Object.freeze({
    ...inventory.report,
    capped: inventory.report.capped || exceedsDeleteLimit,
    deletedStageFileCount,
    deletionFailureCount
  });
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
  const sourceLength = unicodeCodePointLength(source.text);
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
      || unicodeCodePointLength(action.replacement) > 500
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

function storageUnavailable(message: string, reason?: string, retryable = true): SafeError {
  const options = {
    code: 'STORAGE_UNAVAILABLE' as const,
    message,
    retryable,
    correlationId: 'cor_text_adapter'
  };
  if (reason === undefined) return new SafeError(options);
  return new SafeError({
    ...options,
    details: { reason }
  });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

interface BoundedFileRead {
  readonly bytes: Buffer;
  readonly metadata: Stats;
  readonly exceeded: boolean;
}

const boundedReadChunkBytes = 64 * 1024;

async function readBoundedFile(
  path: string,
  maximumBytes: number,
  fileSystem: TextArtifactFileSystem
): Promise<BoundedFileRead> {
  const handle = await fileSystem.openRead(path);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      return { bytes: Buffer.alloc(0), metadata, exceeded: false };
    }
    if (metadata.size > maximumBytes) {
      return { bytes: Buffer.alloc(0), metadata, exceeded: true };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maximumBytes) {
      const remaining = maximumBytes + 1 - total;
      if (remaining === 0) break;
      const buffer = Buffer.allocUnsafe(Math.min(boundedReadChunkBytes, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength) {
        throw new Error('Invalid bounded filesystem read result.');
      }
      if (bytesRead === 0) break;
      chunks.push(bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    return { bytes: Buffer.concat(chunks, total), metadata, exceeded: total > maximumBytes };
  } finally {
    await handle.close();
  }
}

type PublicationIdentity = 'SAME_FILE' | 'TARGET_MISSING' | 'DIFFERENT_FILE' | 'UNKNOWN';

async function publicationIdentity(
  fileSystem: TextArtifactFileSystem,
  stagedPath: string,
  targetPath: string
): Promise<PublicationIdentity> {
  const [targetResult, stageResult] = await Promise.allSettled([
    fileSystem.lstat(targetPath),
    fileSystem.lstat(stagedPath)
  ]);
  if (targetResult.status === 'rejected') {
    return isMissing(targetResult.reason) && stageResult.status === 'fulfilled'
      ? 'TARGET_MISSING'
      : 'UNKNOWN';
  }
  if (stageResult.status === 'rejected') return 'UNKNOWN';
  const target = targetResult.value;
  const stage = stageResult.value;
  if (
    target.isFile()
    && stage.isFile()
    && target.dev === stage.dev
    && target.ino === stage.ino
  ) return 'SAME_FILE';
  return 'DIFFERENT_FILE';
}

async function removeStageAfterFailure(
  fileSystem: TextArtifactFileSystem,
  temporary: string
): Promise<void> {
  try {
    await fileSystem.unlink(temporary);
  } catch (error: unknown) {
    if (!isMissing(error)) {
      throw storageUnavailable('The staged artifact cleanup could not be confirmed.', 'stage_cleanup_failed');
    }
  }
}

/**
 * Applies the adapter's bounded UTF-8 admission rules to caller-owned bytes without
 * selecting or opening a filesystem path. The returned text is immutable application
 * state; callers continue to own and clear the original byte buffer.
 */
export function decodeLocalUtf8ArtifactBytes(
  bytes: Uint8Array,
  descriptor: Readonly<{ readonly reference: string; readonly displayName: string }>,
  maximumBytes = defaultMaximumInputBytes
): LocalUtf8Artifact {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > defaultMaximumInputBytes) {
    throw new TypeError('Maximum input bytes must be a nonnegative safe integer within the adapter limit.');
  }
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
  return Object.freeze({
    reference: descriptor.reference,
    path: descriptor.reference,
    displayName: descriptor.displayName,
    byteLength: bytes.byteLength,
    digest: digestBytes(bytes),
    text,
    hasUtf8Bom
  });
}

/** Encodes derived UTF-8 text while preserving the admitted source BOM policy. */
export function encodeLocalUtf8ArtifactText(
  source: Pick<LocalUtf8Artifact, 'hasUtf8Bom'>,
  text: string
): Uint8Array {
  const encoded = Buffer.from(text, 'utf8');
  if (!source.hasUtf8Bom) return encoded;
  try {
    return Buffer.concat([Buffer.from(utf8Bom), encoded]);
  } finally {
    encoded.fill(0);
  }
}

export async function readLocalUtf8Artifact(
  inputPath: string,
  maximumBytes = defaultMaximumInputBytes,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
): Promise<LocalUtf8Artifact> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > defaultMaximumInputBytes) {
    throw new TypeError('Maximum input bytes must be a nonnegative safe integer within the adapter limit.');
  }
  let requestedMetadata: Stats;
  try {
    requestedMetadata = await fileSystem.lstat(inputPath);
  } catch {
    throw storageUnavailable('The input could not be read.');
  }
  if (requestedMetadata.isSymbolicLink()) {
    throw new SafeError({ code: 'FORMAT_UNSUPPORTED', message: 'Symbolic-link inputs are not supported.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  if (!requestedMetadata.isFile()) {
    throw new SafeError({ code: 'FORMAT_UNSUPPORTED', message: 'The input must be a regular file.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  let path: string;
  try {
    path = await fileSystem.realpath(inputPath);
  } catch {
    throw storageUnavailable('The input could not be read.');
  }
  let bounded: BoundedFileRead;
  try {
    bounded = await readBoundedFile(path, maximumBytes, fileSystem);
  } catch {
    throw storageUnavailable('The input could not be read.');
  }
  if (!bounded.metadata.isFile()) {
    throw new SafeError({ code: 'FORMAT_UNSUPPORTED', message: 'The input must be a regular file.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  if (bounded.exceeded) {
    throw new SafeError({ code: 'INPUT_TOO_LARGE', message: 'The input exceeds the configured byte limit.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  return decodeLocalUtf8ArtifactBytes(
    bounded.bytes,
    { reference: path, displayName: basename(path) },
    maximumBytes
  );
}

export async function readTextArtifact(
  inputPath: string,
  maximumBytes = defaultMaximumInputBytes,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
): Promise<TextArtifact> {
  const artifact = await readLocalUtf8Artifact(inputPath, maximumBytes, fileSystem);
  return {
    ...artifact,
    mediaType: supportedMediaType(artifact.path),
    extractionRevision: extractionDigest(artifact.text)
  };
}

/** Decodes one bounded process-local TXT or Markdown byte sequence. */
export function decodeTextArtifactBytes(
  bytes: Uint8Array,
  mediaType: TextArtifact['mediaType'],
  maximumBytes = defaultMaximumInputBytes
): EphemeralTextArtifactSource {
  const source = decodeLocalUtf8ArtifactBytes(
    bytes,
    {
      reference: 'ephemeral:input',
      displayName: mediaType === 'text/markdown' ? 'document.md' : 'document.txt'
    },
    maximumBytes
  );
  return Object.freeze({
    reference: source.reference,
    displayName: source.displayName,
    mediaType,
    byteLength: source.byteLength,
    digest: source.digest,
    extractionRevision: extractionDigest(source.text),
    text: source.text,
    hasUtf8Bom: source.hasUtf8Bom
  });
}

export function deriveRedactedOutputPath(inputPath: string): string {
  const extension = extname(inputPath);
  return resolve(dirname(inputPath), `${basename(inputPath, extension)}.redacted${extension}`);
}

export async function stageTextArtifact(
  source: Pick<LocalUtf8Artifact, 'path' | 'hasUtf8Bom' | 'digest' | 'byteLength'>,
  outputPath: string,
  text: string,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
): Promise<Omit<StagedTextArtifact, 'receipt'>> {
  const target = resolve(outputPath);
  if (target === source.path) {
    throw new SafeError({ code: 'OUTPUT_COLLISION', message: 'The output path must be different from the input path.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  try {
    await fileSystem.stat(target);
    throw new SafeError({ code: 'OUTPUT_COLLISION', message: 'The output path already exists.', retryable: false, correlationId: 'cor_text_adapter' });
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    if (!isMissing(error)) throw storageUnavailable('The output location could not be checked.');
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

  let handle: TextArtifactFileHandle;
  try {
    handle = await fileSystem.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch {
    // A rejected open does not prove ownership of this pathname. Never unlink
    // a file that may have been created concurrently by another process.
    throw storageUnavailable('The staged artifact could not be created.');
  }
  let writeFailed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch {
    writeFailed = true;
  }
  try {
    await handle.close();
  } catch {
    writeFailed = true;
  }
  if (writeFailed) {
    await removeStageAfterFailure(fileSystem, temporary);
    throw storageUnavailable('The staged artifact could not be written.');
  }

  let written: Buffer;
  try {
    written = await fileSystem.readFile(temporary);
  } catch {
    await removeStageAfterFailure(fileSystem, temporary);
    throw storageUnavailable('The staged artifact could not be verified.');
  }
  const digest = digestBytes(written);
  if (!written.equals(bytes)) {
    await removeStageAfterFailure(fileSystem, temporary);
    throw new SafeError({ code: 'STORAGE_UNAVAILABLE', message: 'The derived artifact failed digest verification.', retryable: true, correlationId: 'cor_text_adapter' });
  }

  return { reference: temporary, path: temporary, targetPath: target, byteLength: written.byteLength, digest };
}

export async function publishStagedTextArtifact(
  source: Pick<LocalUtf8Artifact, 'path' | 'digest' | 'byteLength'>,
  staged: Pick<StagedTextArtifact, 'path' | 'targetPath' | 'byteLength' | 'digest'>,
  signal?: AbortSignal,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
): Promise<WrittenTextArtifact> {
  signal?.throwIfAborted();
  let stagedBytes: Buffer;
  let stagedMetadata: Stats;
  try {
    [stagedBytes, stagedMetadata] = await Promise.all([
      fileSystem.readFile(staged.path),
      fileSystem.lstat(staged.path)
    ]);
  } catch {
    throw storageUnavailable('The staged artifact could not be read before publication.');
  }
  if (
    !stagedMetadata.isFile()
    || stagedMetadata.size !== staged.byteLength
    || stagedBytes.byteLength !== staged.byteLength
    || digestBytes(stagedBytes) !== staged.digest
  ) {
    throw new SafeError({ code: 'ARTIFACT_DIGEST_MISMATCH', message: 'The staged artifact changed before publication.', retryable: false, correlationId: 'cor_text_adapter' });
  }
  let inputBeforePublish: Buffer;
  try {
    const bounded = await readBoundedFile(source.path, source.byteLength, fileSystem);
    if (bounded.exceeded || !bounded.metadata.isFile()) {
      throw new SafeError({ code: 'JOB_CONFLICT', message: 'The input changed while it was being processed.', retryable: true, correlationId: 'cor_text_adapter' });
    }
    inputBeforePublish = bounded.bytes;
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    throw storageUnavailable('The input could not be read before publication.');
  }
  if (digestBytes(inputBeforePublish) !== source.digest) {
    throw new SafeError({ code: 'JOB_CONFLICT', message: 'The input changed while it was being processed.', retryable: true, correlationId: 'cor_text_adapter' });
  }
  // This is the final cancellation checkpoint. Linking is the irreversible publication commit.
  signal?.throwIfAborted();
  try {
    await fileSystem.link(staged.path, staged.targetPath);
    if (await publicationIdentity(fileSystem, staged.path, staged.targetPath) !== 'SAME_FILE') {
      throw storageUnavailable('The publication state could not be confirmed.', 'publication_state_unknown', false);
    }
  } catch (error: unknown) {
    if (error instanceof SafeError && error.details?.reason === 'publication_state_unknown') throw error;
    const identity = await publicationIdentity(fileSystem, staged.path, staged.targetPath);
    if (identity === 'UNKNOWN') {
      throw storageUnavailable('The publication state could not be confirmed.', 'publication_state_unknown', false);
    }
    if (identity === 'DIFFERENT_FILE' || (identity === 'TARGET_MISSING' && (error as NodeJS.ErrnoException).code === 'EEXIST')) {
      throw new SafeError({ code: 'OUTPUT_COLLISION', message: 'The output path already exists.', retryable: false, correlationId: 'cor_text_adapter' });
    }
    if (identity === 'TARGET_MISSING') throw storageUnavailable('The staged artifact could not be published.');
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fileSystem.unlink(staged.path);
    } catch {
      // Reconcile below: unlink may have completed before reporting an error.
    }
    try {
      const remaining = await fileSystem.lstat(staged.path);
      if (remaining.dev !== stagedMetadata.dev || remaining.ino !== stagedMetadata.ino) break;
    } catch (error: unknown) {
      if (isMissing(error)) {
        return { path: staged.targetPath, byteLength: staged.byteLength, digest: staged.digest };
      }
      break;
    }
  }
  throw storageUnavailable(
    'A verified output was published, but staged artifact cleanup could not be confirmed.',
    'stage_cleanup_failed_after_publication',
    false
  );
}

export async function discardStagedTextArtifact(
  staged: Pick<StagedTextArtifact, 'path'>,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
): Promise<void> {
  try {
    await fileSystem.unlink(staged.path);
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
  maximumInputBytes = defaultMaximumInputBytes,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
): TextArtifactSession {
  let sourcePromise: Promise<TextArtifact> | undefined;

  const input = async (signal?: AbortSignal): Promise<TextArtifact> => {
    signal?.throwIfAborted();
    sourcePromise ??= readTextArtifact(inputPath, maximumInputBytes, fileSystem);
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
      const text = applyTypedLabelPlan(source.text, plan);
      const target = outputPath === undefined ? deriveRedactedOutputPath(source.path) : resolve(outputPath);
      const stagedArtifact = await stageTextArtifact(source, target, text, fileSystem);
      const staged = Object.freeze({
        ...stagedArtifact,
        receipt: createTextWriterReceipt(plan, stagedArtifact)
      });
      try {
        signal?.throwIfAborted();
      } catch (error: unknown) {
        await discardStagedTextArtifact(staged, fileSystem);
        throw error;
      }
      return staged;
    },
    async reopen(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifact> {
      signal?.throwIfAborted();
      const reopened = await readTextArtifact(staged.path, defaultMaximumInputBytes, fileSystem);
      signal?.throwIfAborted();
      if (reopened.digest !== staged.digest || reopened.byteLength !== staged.byteLength) {
        throw new SafeError({
          code: 'ARTIFACT_DIGEST_MISMATCH',
          message: 'The staged artifact changed before it could be reopened.',
          retryable: false,
          correlationId: 'cor_text_adapter'
        });
      }
      return reopened;
    },
    async publish(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifactPublication> {
      signal?.throwIfAborted();
      const published = await publishStagedTextArtifact(await input(signal), staged, signal, fileSystem);
      return { reference: published.path, byteLength: published.byteLength, digest: published.digest };
    },
    async discard(staged: StagedTextArtifact, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();
      await discardStagedTextArtifact(staged, fileSystem);
    }
  };
}

function sameWriterReceipt(left: TextWriterReceipt, right: TextWriterReceipt): boolean {
  return left.planDigest === right.planDigest
    && left.writer.id === right.writer.id
    && left.writer.version === right.writer.version
    && left.stagedDigest === right.stagedDigest
    && left.stagedByteLength === right.stagedByteLength
    && left.expectedActionCount === right.expectedActionCount
    && left.appliedActionCount === right.appliedActionCount
    && left.receiptDigest === right.receiptDigest
    && left.appliedActionIds.length === right.appliedActionIds.length
    && left.appliedActionIds.every((id, index) => id === right.appliedActionIds[index]);
}

/**
 * Process-local staging mechanics shared by native structured adapters. Parsing,
 * plan application, receipt construction, and reopen all remain adapter-owned.
 */
export function createEphemeralNativeArtifactSession<Artifact extends EphemeralNativeArtifact>(
  options: EphemeralNativeArtifactSessionOptions<Artifact>
): EphemeralNativeArtifactSessionHandle<Artifact> {
  if (!Number.isSafeInteger(options.maximumOutputBytes)
    || options.maximumOutputBytes < 1
    || options.maximumOutputBytes > defaultMaximumInputBytes) {
    throw new TypeError('The ephemeral native output limit is invalid.');
  }
  let stagedState: { readonly descriptor: StagedTextArtifact; readonly bytes: Buffer } | undefined;
  let published: Buffer | undefined;
  let disposed = false;

  const requireActive = (): void => {
    if (disposed) {
      throw new SafeError({
        code: 'STORAGE_UNAVAILABLE',
        message: 'The ephemeral artifact session is unavailable.',
        retryable: false,
        correlationId: 'cor_text_adapter'
      });
    }
  };
  const clearStage = (): void => {
    stagedState?.bytes.fill(0);
    stagedState = undefined;
  };
  const matchingStage = (candidate: StagedTextArtifact): boolean => {
    const current = stagedState?.descriptor;
    return current !== undefined
      && candidate.reference === current.reference
      && candidate.path === current.path
      && candidate.targetPath === current.targetPath
      && candidate.digest === current.digest
      && candidate.byteLength === current.byteLength
      && sameWriterReceipt(candidate.receipt, current.receipt)
      && stagedState !== undefined
      && digestBytes(stagedState.bytes) === current.digest;
  };
  const mismatch = (message: string): never => {
    throw new SafeError({
      code: 'ARTIFACT_DIGEST_MISMATCH',
      message,
      retryable: false,
      correlationId: 'cor_text_adapter'
    });
  };

  const session = Object.freeze({
    writer: options.writer,
    input(signal?: AbortSignal): Promise<Artifact> {
      signal?.throwIfAborted();
      requireActive();
      return Promise.resolve(options.source);
    },
    async stage(plan: TypedLabelPlan, signal?: AbortSignal): Promise<StagedTextArtifact> {
      await Promise.resolve();
      signal?.throwIfAborted();
      requireActive();
      if (stagedState !== undefined || published !== undefined) {
        throw new SafeError({
          code: 'JOB_CONFLICT',
          message: 'The ephemeral artifact session already contains an output.',
          retryable: false,
          correlationId: 'cor_text_adapter'
        });
      }
      const encoded = options.encodePlan(options.source, plan);
      const bytes = Buffer.from(encoded);
      encoded.fill(0);
      let descriptor: StagedTextArtifact;
      try {
        if (bytes.byteLength > options.maximumOutputBytes) {
          throw new SafeError({
            code: 'INPUT_TOO_LARGE',
            message: 'The derived artifact exceeds the configured byte limit.',
            retryable: false,
            correlationId: 'cor_text_adapter'
          });
        }
        const base = Object.freeze({
          reference: 'ephemeral:stage',
          path: 'ephemeral:stage',
          targetPath: 'ephemeral:published',
          byteLength: bytes.byteLength,
          digest: digestBytes(bytes)
        });
        descriptor = Object.freeze({ ...base, receipt: options.createReceipt(plan, base) });
        stagedState = { descriptor, bytes };
      } catch (error: unknown) {
        bytes.fill(0);
        throw error;
      }
      try {
        signal?.throwIfAborted();
      } catch (error: unknown) {
        clearStage();
        throw error;
      }
      return descriptor;
    },
    async reopen(staged: StagedTextArtifact, signal?: AbortSignal): Promise<Artifact> {
      signal?.throwIfAborted();
      requireActive();
      if (!matchingStage(staged) || stagedState === undefined) {
        return mismatch('The staged artifact changed before it could be reopened.');
      }
      const reopenBytes = Uint8Array.from(stagedState.bytes);
      try {
        const reopened = await options.reopen(reopenBytes, staged, signal);
        signal?.throwIfAborted();
        if (reopened.digest !== staged.digest || reopened.byteLength !== staged.byteLength) {
          return mismatch('The staged artifact changed before it could be reopened.');
        }
        return reopened;
      } catch (error: unknown) {
        clearStage();
        throw error;
      } finally {
        reopenBytes.fill(0);
      }
    },
    async publish(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifactPublication> {
      await Promise.resolve();
      signal?.throwIfAborted();
      requireActive();
      if (!matchingStage(staged) || stagedState === undefined) {
        return mismatch('The staged artifact changed before publication.');
      }
      published = stagedState.bytes;
      stagedState = undefined;
      return Object.freeze({
        reference: 'ephemeral:published',
        byteLength: published.byteLength,
        digest: digestBytes(published)
      });
    },
    async discard(staged: StagedTextArtifact, signal?: AbortSignal): Promise<void> {
      await Promise.resolve();
      signal?.throwIfAborted();
      requireActive();
      if (matchingStage(staged)) clearStage();
    }
  });

  return Object.freeze({
    session,
    publishedBytes: () => published === undefined ? undefined : Uint8Array.from(published),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearStage();
      published?.fill(0);
      published = undefined;
    }
  });
}

/**
 * Creates the same typed-label writer boundary as the filesystem adapter without selecting a path.
 * This is intended for bounded session-only API work; publication commits only to this handle.
 */
export function createEphemeralTextArtifactSession(
  sourceInput: EphemeralTextArtifactSource,
  maximumOutputBytes = defaultMaximumInputBytes
): EphemeralTextArtifactSessionHandle {
  if (!Number.isSafeInteger(maximumOutputBytes) || maximumOutputBytes < 1) {
    throw new TypeError('The ephemeral text output limit is invalid.');
  }
  const source: TextArtifact = Object.freeze({ ...sourceInput, path: 'ephemeral:input' });
  let stagedState: { readonly descriptor: StagedTextArtifact; readonly bytes: Buffer } | undefined;
  let published: Buffer | undefined;
  let disposed = false;

  const requireActive = (): void => {
    if (disposed) {
      throw new SafeError({
        code: 'STORAGE_UNAVAILABLE',
        message: 'The ephemeral artifact session is unavailable.',
        retryable: false,
        correlationId: 'cor_text_adapter'
      });
    }
  };
  const matchingStage = (staged: StagedTextArtifact) => stagedState !== undefined
    && staged.reference === stagedState.descriptor.reference
    && staged.digest === stagedState.descriptor.digest
    && staged.byteLength === stagedState.descriptor.byteLength;
  const clearStage = (): void => {
    stagedState?.bytes.fill(0);
    stagedState = undefined;
  };

  const session: TextArtifactSession = {
    writer: textWriterDescriptor,
    input(signal) {
      signal?.throwIfAborted();
      requireActive();
      return Promise.resolve(source);
    },
    stage(plan, signal) {
      signal?.throwIfAborted();
      requireActive();
      if (stagedState !== undefined || published !== undefined) {
        throw new SafeError({
          code: 'JOB_CONFLICT',
          message: 'The ephemeral artifact session already contains an output.',
          retryable: false,
          correlationId: 'cor_text_adapter'
        });
      }
      assertWriterPlanCanApply(plan, source);
      const encoded = Buffer.from(new TextEncoder().encode(applyTypedLabelPlan(source.text, plan)));
      const bytes = source.hasUtf8Bom
        ? Buffer.concat([Buffer.from(utf8Bom), encoded])
        : encoded;
      if (bytes.byteLength > maximumOutputBytes) {
        bytes.fill(0);
        throw new SafeError({
          code: 'INPUT_TOO_LARGE',
          message: 'The derived artifact exceeds the configured byte limit.',
          retryable: false,
          correlationId: 'cor_text_adapter'
        });
      }
      const descriptorWithoutReceipt = {
        reference: 'ephemeral:stage',
        path: 'ephemeral:stage',
        targetPath: 'ephemeral:published',
        byteLength: bytes.byteLength,
        digest: digestBytes(bytes)
      };
      const descriptor = Object.freeze({
        ...descriptorWithoutReceipt,
        receipt: createTextWriterReceipt(plan, descriptorWithoutReceipt)
      });
      stagedState = { descriptor, bytes };
      try {
        signal?.throwIfAborted();
      } catch (error: unknown) {
        clearStage();
        throw error;
      }
      return Promise.resolve(descriptor);
    },
    reopen(staged, signal) {
      signal?.throwIfAborted();
      requireActive();
      if (!matchingStage(staged) || stagedState === undefined) {
        throw new SafeError({
          code: 'ARTIFACT_DIGEST_MISMATCH',
          message: 'The staged artifact changed before it could be reopened.',
          retryable: false,
          correlationId: 'cor_text_adapter'
        });
      }
      const bytes = stagedState.bytes;
      const content = source.hasUtf8Bom ? bytes.subarray(utf8Bom.byteLength) : bytes;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      signal?.throwIfAborted();
      return Promise.resolve(Object.freeze({
        reference: staged.reference,
        path: staged.path,
        displayName: source.displayName,
        mediaType: source.mediaType,
        byteLength: bytes.byteLength,
        digest: digestBytes(bytes),
        extractionRevision: extractionDigest(text),
        text,
        hasUtf8Bom: source.hasUtf8Bom
      }));
    },
    publish(staged, signal) {
      signal?.throwIfAborted();
      requireActive();
      if (!matchingStage(staged) || stagedState === undefined) {
        throw new SafeError({
          code: 'ARTIFACT_DIGEST_MISMATCH',
          message: 'The staged artifact changed before publication.',
          retryable: false,
          correlationId: 'cor_text_adapter'
        });
      }
      published = stagedState.bytes;
      stagedState = undefined;
      return Promise.resolve(Object.freeze({
        reference: 'ephemeral:published',
        byteLength: published.byteLength,
        digest: digestBytes(published)
      }));
    },
    discard(staged, signal) {
      signal?.throwIfAborted();
      requireActive();
      if (matchingStage(staged)) clearStage();
      return Promise.resolve();
    }
  };

  return Object.freeze({
    session: Object.freeze(session),
    publishedBytes: () => published === undefined ? undefined : Uint8Array.from(published),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearStage();
      published?.fill(0);
      published = undefined;
    }
  });
}

export async function writeTextArtifact(
  source: TextArtifact,
  outputPath: string,
  text: string,
  fileSystem: TextArtifactFileSystem = defaultTextArtifactFileSystem
): Promise<WrittenTextArtifact> {
  const staged = await stageTextArtifact(source, outputPath, text, fileSystem);
  try {
    return await publishStagedTextArtifact(source, staged, undefined, fileSystem);
  } catch (error: unknown) {
    if (
      error instanceof SafeError
      && error.details?.reason === 'stage_cleanup_failed_after_publication'
    ) {
      throw error;
    }
    await discardStagedTextArtifact(staged, fileSystem);
    throw error;
  }
}
