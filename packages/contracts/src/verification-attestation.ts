import { createHash } from 'node:crypto';

import type { VerificationVerificationReportV2Contract } from './generated/index.js';

export type VerificationAttestation = VerificationVerificationReportV2Contract.VerificationAttestationV2;
export type UnsignedVerificationAttestation = Omit<VerificationAttestation, 'reportDigest'>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Readonly<Record<string, unknown>>)[key])}`
  ).join(',')}}`;
}

/** Canonical semantic digest shared by verification producers and independent publication gates. */
export function computeVerificationAttestationDigest(report: UnsignedVerificationAttestation): string {
  return `sha256:${createHash('sha256').update(canonicalJson(report), 'utf8').digest('hex')}`;
}
