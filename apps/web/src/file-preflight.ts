import type { CapabilitySummary, SupportedFileFormat } from './api.js';

export type FilePreflightResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'ready'; readonly byteLength: number; readonly extension: string }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'too-large'; readonly maximumInputBytes: number };

function selectedExtension(name: string): string | undefined {
  if (name.length < 1 || name.length > 255) return undefined;
  const separator = name.lastIndexOf('.');
  if (separator < 1) return undefined;
  const extension = name.slice(separator).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/u.test(extension) ? extension : undefined;
}

function formatForExtension(
  formats: readonly SupportedFileFormat[],
  extension: string
): SupportedFileFormat | undefined {
  return formats.find((format) => format.extension === extension);
}

export function preflightSelectedFile(
  file: Pick<File, 'name' | 'size'> | undefined,
  capabilities: Pick<CapabilitySummary, 'supportedFiles'>
): FilePreflightResult {
  if (file === undefined) return { kind: 'none' };
  if (!Number.isSafeInteger(file.size) || file.size < 0) return { kind: 'unsupported' };
  const extension = selectedExtension(file.name);
  if (extension === undefined) return { kind: 'unsupported' };
  const format = formatForExtension(capabilities.supportedFiles, extension);
  if (format === undefined) return { kind: 'unsupported' };
  if (file.size > format.maximumInputBytes) {
    return { kind: 'too-large', maximumInputBytes: format.maximumInputBytes };
  }
  return { kind: 'ready', byteLength: file.size, extension };
}
