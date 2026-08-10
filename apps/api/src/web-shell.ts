import { constants } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { FastifyInstance, FastifyReply } from 'fastify';

export interface LocalWebAsset {
  readonly name: string;
  readonly mediaType: 'text/css' | 'text/javascript';
  readonly bytes: Buffer;
}

export interface LocalWebAssets {
  readonly indexHtml: string;
  readonly assets: readonly LocalWebAsset[];
}

export interface LocalWebShellOptions {
  readonly assets: LocalWebAssets;
  readonly launchNonce: string;
}

const bootstrapMarker = '<meta name="local-pii-bootstrap" content="pending" />';
const secretPattern = /^[A-Za-z0-9_-]{43}$/u;
const assetNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.(?:css|js)$/u;
const maximumIndexBytes = 64 * 1024;
const maximumAssetBytes = 1024 * 1024;
const maximumTotalAssetBytes = 4 * 1024 * 1024;
const maximumAssetCount = 64;

export const localWebContentSecurityPolicy = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'"
].join('; ');

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function validateWebAssets(indexHtml: string, assets: readonly LocalWebAsset[]): void {
  if (Buffer.byteLength(indexHtml, 'utf8') > maximumIndexBytes || countOccurrences(indexHtml, bootstrapMarker) !== 1) {
    throw new TypeError('The local web index is invalid.');
  }
  if (assets.length < 1 || assets.length > maximumAssetCount) {
    throw new TypeError('The local web asset set is invalid.');
  }
  let total = 0;
  const names = new Set<string>();
  for (const asset of assets) {
    if (!assetNamePattern.test(asset.name) || names.has(asset.name) || asset.bytes.byteLength > maximumAssetBytes) {
      throw new TypeError('The local web asset set is invalid.');
    }
    const expectedMediaType = asset.name.endsWith('.css') ? 'text/css' : 'text/javascript';
    if (asset.mediaType !== expectedMediaType) throw new TypeError('The local web asset set is invalid.');
    names.add(asset.name);
    total += asset.bytes.byteLength;
  }
  if (total > maximumTotalAssetBytes) throw new TypeError('The local web asset set is invalid.');
  for (const match of indexHtml.matchAll(/\/assets\/([A-Za-z0-9][A-Za-z0-9._-]{0,126}\.(?:css|js))/gu)) {
    const name = match[1];
    if (name === undefined || !names.has(name)) throw new TypeError('The local web index references an unavailable asset.');
  }
}

export function createLocalWebAssets(indexHtml: string, assets: readonly LocalWebAsset[]): LocalWebAssets {
  validateWebAssets(indexHtml, assets);
  return Object.freeze({ indexHtml, assets: Object.freeze([...assets]) });
}

async function readBoundedRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) throw new TypeError('A local web asset is invalid.');
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) throw new TypeError('A local web asset is invalid.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

export async function loadLocalWebAssets(webRoot: string): Promise<LocalWebAssets> {
  const rootMetadata = await lstat(webRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new TypeError('The local web build directory is invalid.');
  }
  const canonicalRoot = await realpath(webRoot);
  const assetDirectory = resolve(canonicalRoot, 'assets');
  const assetDirectoryMetadata = await lstat(assetDirectory);
  if (!assetDirectoryMetadata.isDirectory() || assetDirectoryMetadata.isSymbolicLink()) {
    throw new TypeError('The local web asset directory is invalid.');
  }
  const entries = await readdir(assetDirectory, { withFileTypes: true });
  if (entries.length < 1 || entries.length > maximumAssetCount || entries.some((entry) => !entry.isFile())) {
    throw new TypeError('The local web asset directory is invalid.');
  }
  const assets: LocalWebAsset[] = [];
  let total = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (!assetNamePattern.test(entry.name)) throw new TypeError('A local web asset is invalid.');
    const remaining = maximumTotalAssetBytes - total;
    if (remaining < 1) throw new TypeError('The local web asset set is invalid.');
    const bytes = await readBoundedRegularFile(
      resolve(assetDirectory, entry.name),
      Math.min(maximumAssetBytes, remaining)
    );
    total += bytes.byteLength;
    assets.push({
      name: entry.name,
      mediaType: entry.name.endsWith('.css') ? 'text/css' : 'text/javascript',
      bytes
    });
  }
  const index = await readBoundedRegularFile(resolve(canonicalRoot, 'index.html'), maximumIndexBytes);
  return createLocalWebAssets(index.toString('utf8'), assets);
}

export function isLocalWebShellRoute(routeUrl: string | undefined): boolean {
  return routeUrl === '/'
    || routeUrl === '/.local-pii/launch'
    || routeUrl === '/.local-pii/bootstrap/:nonce.js'
    || routeUrl === '/assets/:asset';
}

function applyBrowserHeaders(reply: FastifyReply, mediaType: string): void {
  reply.type(mediaType);
  reply.header('content-security-policy', localWebContentSecurityPolicy);
  reply.header('cross-origin-opener-policy', 'same-origin');
  reply.header('cross-origin-resource-policy', 'same-origin');
  reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-frame-options', 'DENY');
}

function launchHtml(indexHtml: string, nonce: string): string {
  return indexHtml.replace(
    bootstrapMarker,
    `<script data-local-pii-bootstrap src="/.local-pii/bootstrap/${nonce}.js"></script>`
  );
}

function disconnectedHtml(indexHtml: string): string {
  return indexHtml.replace(bootstrapMarker, '');
}

function secretMatches(actual: string, expected: string): boolean {
  if (!secretPattern.test(actual) || !secretPattern.test(expected)) return false;
  const actualBytes = Buffer.from(actual, 'ascii');
  const expectedBytes = Buffer.from(expected, 'ascii');
  return timingSafeEqual(actualBytes, expectedBytes);
}

function bootstrapSource(bearerToken: string): string {
  return `(()=>{const value=Object.freeze({apiOrigin:window.location.origin,bearerToken:${JSON.stringify(bearerToken)}});Object.defineProperty(window,"__LOCAL_PII_BOOTSTRAP__",{value,configurable:true,writable:false});history.replaceState(null,"","/");})();`;
}

export function registerLocalWebShell(
  server: FastifyInstance,
  sessionToken: string,
  options: LocalWebShellOptions
): void {
  if (!secretPattern.test(sessionToken) || !secretPattern.test(options.launchNonce)) {
    throw new TypeError('The local web launch secrets are invalid.');
  }
  validateWebAssets(options.assets.indexHtml, options.assets.assets);
  const assets = new Map(options.assets.assets.map((asset) => [asset.name, {
    ...asset,
    bytes: Buffer.from(asset.bytes)
  }]));
  let launchPageIssued = false;
  let bootstrapIssued = false;

  server.get('/', (_request, reply) => {
    applyBrowserHeaders(reply, 'text/html; charset=utf-8');
    return reply.send(disconnectedHtml(options.assets.indexHtml));
  });
  server.get('/.local-pii/launch', (_request, reply) => {
    if (launchPageIssued) {
      reply.callNotFound();
      return;
    }
    launchPageIssued = true;
    applyBrowserHeaders(reply, 'text/html; charset=utf-8');
    return reply.send(launchHtml(options.assets.indexHtml, options.launchNonce));
  });
  server.get<{ Params: { nonce: string } }>('/.local-pii/bootstrap/:nonce.js', (request, reply) => {
    if (!launchPageIssued || bootstrapIssued || !secretMatches(request.params.nonce, options.launchNonce)) {
      reply.callNotFound();
      return;
    }
    bootstrapIssued = true;
    applyBrowserHeaders(reply, 'text/javascript; charset=utf-8');
    return reply.send(bootstrapSource(sessionToken));
  });
  server.get<{ Params: { asset: string } }>('/assets/:asset', (request, reply) => {
    const asset = assets.get(request.params.asset);
    if (asset === undefined) {
      reply.callNotFound();
      return;
    }
    applyBrowserHeaders(reply, `${asset.mediaType}; charset=utf-8`);
    return reply.send(asset.bytes);
  });
}
