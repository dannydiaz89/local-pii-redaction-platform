import { createHash } from 'node:crypto';

import type { RedactionWriterReceiptContract } from './generated/index.js';

export type WriterReceipt = RedactionWriterReceiptContract.WriterReceipt;
export type UnsignedWriterReceipt = Omit<WriterReceipt, 'receiptDigest'>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Readonly<Record<string, unknown>>)[key])}`
  ).join(',')}}`;
}

/** Canonical semantic digest shared by writers and independent receipt consumers. */
export function computeWriterReceiptDigest(receipt: UnsignedWriterReceipt): string {
  return `sha256:${createHash('sha256').update(canonicalJson(receipt), 'utf8').digest('hex')}`;
}
