import type {
  CapabilitiesCapabilityManifestContract,
  PolicyPolicyCatalogContract
} from '@local-pii/contracts';
import type { ApplicationContext } from '@local-pii/core';

import type { JobControlPort } from './job-control.js';
import type { ProcessingControlPort } from './processing.js';
import type { PreviewScanPort } from './preview-scan.js';
import type { LocalWebShellOptions } from './web-shell.js';

export type CapabilityManifest = CapabilitiesCapabilityManifestContract.CapabilityManifest;
type GeneratedPolicyCatalog = PolicyPolicyCatalogContract.PolicyCatalog;
type PolicyReference = Readonly<GeneratedPolicyCatalog['policies'][number]>;
export type PolicyCatalog = Readonly<Omit<GeneratedPolicyCatalog, 'policies'>> & {
  readonly policies: readonly [PolicyReference, ...PolicyReference[]];
};

export interface CapabilityApplicationPort {
  getCapabilities(context: ApplicationContext, signal?: AbortSignal): Promise<CapabilityManifest>;
}

export interface ApiReadinessPort {
  check(signal?: AbortSignal): Promise<void>;
}

export interface PolicyCatalogPort {
  get(signal?: AbortSignal): Promise<PolicyCatalog>;
}

export interface ApiDependencies {
  readonly application: CapabilityApplicationPort;
  readonly jobs: JobControlPort;
  readonly policies: PolicyCatalogPort;
  readonly preview: PreviewScanPort;
  readonly processing?: ProcessingControlPort;
  readonly readiness: ApiReadinessPort;
}

export interface LocalSessionPolicy {
  /** An opaque, per-launch secret. It is never logged or included in an error response. */
  readonly bearerToken: string;
  /** Exact numeric-loopback browser origins authorized to read API responses. */
  readonly allowedOrigins?: readonly string[];
}

export interface BuildApiOptions {
  readonly session: LocalSessionPolicy;
  readonly handlerTimeoutMs?: number;
  readonly browserShell?: LocalWebShellOptions;
}
