import {
  createCapabilityClient,
  type CapabilityClient,
  type CapabilitySummary,
  type LocalApiSession
} from './api.js';
import {
  createLocalJobClient,
  type LocalJobClient,
  type PolicyReference,
  type ProcessingRedactionSummary,
  type ProcessingScanSummary,
  type ReviewSetSummary,
  type ScanProgressState
} from './job-api.js';

export interface LocalSessionClient {
  readonly capabilities: CapabilityClient;
  readonly jobs: LocalJobClient;
}

function extensionFor(file: File): string {
  const separator = file.name.lastIndexOf('.');
  return separator < 1 ? '' : file.name.slice(separator).toLowerCase();
}

function assertNegotiatedFile(
  capabilities: CapabilitySummary | undefined,
  file: File,
  operation: 'SCAN' | 'REDACT'
): void {
  if (capabilities === undefined) throw new Error('CAPABILITY_NEGOTIATION_REQUIRED');
  const support = capabilities.supportedFiles.find(({ extension }) => extension === extensionFor(file));
  if (support === undefined
    || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > support.maximumInputBytes
    || (operation === 'REDACT' && !support.supportsRedaction)) {
    throw new TypeError('The processing file is not supported by the negotiated local capability.');
  }
}

export function createLocalSessionClient(
  session: LocalApiSession,
  fetchImplementation: typeof fetch = fetch
): LocalSessionClient {
  const capabilityTransport = createCapabilityClient(session, fetchImplementation);
  const jobTransport = createLocalJobClient(session, fetchImplementation);
  let negotiated: CapabilitySummary | undefined;
  const capabilities: CapabilityClient = Object.freeze({
    async load(signal: AbortSignal): Promise<CapabilitySummary> {
      const summary = await capabilityTransport.load(signal);
      negotiated = summary;
      return summary;
    }
  });
  const jobs: LocalJobClient = Object.freeze({
    ...jobTransport,
    async scan(
      file: File,
      policy: PolicyReference,
      onProgress: (state: ScanProgressState) => void,
      signal: AbortSignal
    ): Promise<ProcessingScanSummary> {
      assertNegotiatedFile(negotiated, file, 'SCAN');
      return jobTransport.scan(file, policy, onProgress, signal);
    },
    async redact(
      file: File,
      policy: PolicyReference,
      review: ReviewSetSummary,
      onProgress: (state: ScanProgressState) => void,
      signal: AbortSignal
    ): Promise<ProcessingRedactionSummary> {
      assertNegotiatedFile(negotiated, file, 'REDACT');
      return jobTransport.redact(file, policy, review, onProgress, signal);
    },
    async scanPreview(file: File, signal: AbortSignal) {
      assertNegotiatedFile(negotiated, file, 'SCAN');
      return jobTransport.scanPreview(file, signal);
    }
  });
  return Object.freeze({ capabilities, jobs });
}

export function createDisconnectedLocalSessionClient(): LocalSessionClient {
  const unavailable = (): Promise<never> => Promise.reject(new Error('LOCAL_SESSION_MISSING'));
  return Object.freeze({
    capabilities: Object.freeze({ load: unavailable }),
    jobs: Object.freeze({
      loadPolicies: unavailable,
      scan: unavailable,
      redact: unavailable,
      listDetections: unavailable,
      getReviewSet: unavailable,
      appendReviewDecisions: unavailable,
      scanPreview: unavailable,
      create: unavailable,
      get: unavailable,
      listEvents: unavailable,
      cancel: unavailable,
      expire: unavailable
    })
  });
}
