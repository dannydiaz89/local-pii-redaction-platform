import type { CapabilitiesCapabilityManifestContract } from '@local-pii/contracts';

export type EngineMode = CapabilitiesCapabilityManifestContract.CapabilityManifest['engineMode'];
export type LocalEngineMode = Exclude<EngineMode, 'REMOTE'>;

export interface SupportedFileFormat {
  readonly extension: string;
  readonly maximumInputBytes: number;
}

export interface CapabilitySummary {
  readonly engineMode: LocalEngineMode;
  readonly formatCount: number;
  readonly availableDetectorCount: number;
  readonly maximumInputBytes: number;
  readonly supportedFiles: readonly SupportedFileFormat[];
}

export interface CapabilityClient {
  load(signal: AbortSignal): Promise<CapabilitySummary>;
}

export interface LocalApiSession {
  readonly apiOrigin: string;
  readonly bearerToken: string;
}

const maximumCapabilityResponseBytes = 128 * 1024;
export const capabilityRequestTimeoutMs = 5_000;
const tokenPattern = /^[A-Za-z0-9_-]{43,128}$/u;
const localEngineModes = new Set<LocalEngineMode>(['RULES_ONLY', 'LOCAL_HYBRID']);

export function assertLocalApiSession(session: LocalApiSession): URL {
  let origin: URL;
  try {
    origin = new URL(session.apiOrigin);
  } catch {
    throw new TypeError('The local API session configuration is invalid.');
  }
  if (
    origin.protocol !== 'http:'
    || origin.hostname !== '127.0.0.1'
    || origin.username !== ''
    || origin.password !== ''
    || origin.pathname !== '/'
    || origin.search !== ''
    || origin.hash !== ''
    || origin.origin !== session.apiOrigin
    || !tokenPattern.test(session.bearerToken)
  ) {
    throw new TypeError('The local API session configuration is invalid.');
  }
  return origin;
}

export async function readBoundedJsonResponse(
  response: Response,
  maximumResponseBytes: number,
  invalidResponseCode: string
): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > maximumResponseBytes) {
    throw new Error(invalidResponseCode);
  }
  if (response.body === null) throw new Error(invalidResponseCode);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumResponseBytes) throw new Error(invalidResponseCode);
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new Error(invalidResponseCode);
  }
}

export async function runBoundedLocalRequest<Result>(
  signal: AbortSignal,
  timeoutMs: number,
  cancellationCode: string,
  operation: (signal: AbortSignal) => Promise<Result>
): Promise<Result> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError('The local API request deadline is invalid.');
  }
  const controller = new AbortController();
  const relayAbort = (): void => { controller.abort(); };
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  let rejectCancellation: ((reason: Error) => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const rejectOnAbort = (): void => {
    rejectCancellation?.(new Error(cancellationCode));
  };
  controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
  if (controller.signal.aborted) rejectOnAbort();
  try {
    return await Promise.race([operation(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', relayAbort);
    controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0 && value <= maximum;
}

function supportedFiles(
  formats: readonly unknown[],
  globalMaximumInputBytes: number
): readonly SupportedFileFormat[] {
  const limits = new Map<string, number>();
  for (const format of formats) {
    if (
      !isRecord(format)
      || !Array.isArray(format.extensions)
      || format.extensions.length < 1
      || format.extensions.length > 32
      || !Array.isArray(format.operations)
      || format.operations.length < 1
      || format.operations.length > 32
      || !isRecord(format.limits)
      || !boundedInteger(format.limits.maximumInputBytes, globalMaximumInputBytes)
      || format.limits.maximumInputBytes < 1
    ) throw new Error('CAPABILITY_RESPONSE_INVALID');
    if (!format.operations.includes('SCAN')) continue;
    for (const extension of format.extensions) {
      if (typeof extension !== 'string' || !/^\.[a-z0-9]{1,16}$/u.test(extension)) {
        throw new Error('CAPABILITY_RESPONSE_INVALID');
      }
      const current = limits.get(extension);
      limits.set(extension, Math.min(current ?? globalMaximumInputBytes, format.limits.maximumInputBytes));
    }
  }
  if (limits.size < 1 || limits.size > 64) throw new Error('CAPABILITY_RESPONSE_INVALID');
  return Object.freeze([...limits.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([extension, maximumInputBytes]) => Object.freeze({ extension, maximumInputBytes })));
}

export function projectCapabilitySummary(value: unknown): CapabilitySummary {
  if (!isRecord(value) || !localEngineModes.has(value.engineMode as LocalEngineMode)) {
    throw new Error('CAPABILITY_RESPONSE_INVALID');
  }
  if (!Array.isArray(value.formats) || value.formats.length < 1 || value.formats.length > 32) {
    throw new Error('CAPABILITY_RESPONSE_INVALID');
  }
  if (!Array.isArray(value.detectors) || value.detectors.length < 1 || value.detectors.length > 128) {
    throw new Error('CAPABILITY_RESPONSE_INVALID');
  }
  if (!isRecord(value.limits) || !boundedInteger(value.limits.maximumInputBytes, 1024 * 1024 * 1024)) {
    throw new Error('CAPABILITY_RESPONSE_INVALID');
  }
  const maximumInputBytes = value.limits.maximumInputBytes;
  const availableDetectorCount = value.detectors.filter((detector) => {
    return isRecord(detector) && detector.availability === 'AVAILABLE';
  }).length;
  return {
    engineMode: value.engineMode as LocalEngineMode,
    formatCount: value.formats.length,
    availableDetectorCount,
    maximumInputBytes,
    supportedFiles: supportedFiles(value.formats, maximumInputBytes)
  };
}

export function createCapabilityClient(
  session: LocalApiSession,
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = capabilityRequestTimeoutMs
): CapabilityClient {
  const origin = assertLocalApiSession(session);
  return {
    async load(signal) {
      return runBoundedLocalRequest(signal, timeoutMs, 'CAPABILITY_REQUEST_CANCELLED', async (operationSignal) => {
        const response = await fetchImplementation(new URL('/v1/capabilities', origin), {
          method: 'GET',
          headers: { authorization: `Bearer ${session.bearerToken}`, accept: 'application/json' },
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: operationSignal
        });
        if (!response.ok) throw new Error('CAPABILITY_REQUEST_FAILED');
        const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
        if (mediaType !== 'application/json') throw new Error('CAPABILITY_RESPONSE_INVALID');
        return projectCapabilitySummary(await readBoundedJsonResponse(
          response,
          maximumCapabilityResponseBytes,
          'CAPABILITY_RESPONSE_INVALID'
        ));
      });
    }
  };
}

export function createDisconnectedCapabilityClient(): CapabilityClient {
  return { load: () => Promise.reject(new Error('LOCAL_SESSION_MISSING')) };
}
