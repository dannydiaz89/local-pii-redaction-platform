import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { buildApi, type ApiDependencies } from './application.js';
import { loadLocalWebAssets, type LocalWebAssets } from './web-shell.js';

export interface StartLocalApiOptions {
  readonly port?: number;
  readonly allowedOrigins?: readonly string[];
  readonly handlerTimeoutMs?: number;
}

export interface RunningLocalApi {
  readonly server: FastifyInstance;
  readonly hostname: '127.0.0.1';
  readonly port: number;
  readonly url: string;
  /** Hand this secret directly to the trusted launcher/client; never log or persist it. */
  readonly sessionToken: string;
  close(): Promise<void>;
}

export interface StartLocalWebApplicationOptions {
  readonly port?: number;
  readonly handlerTimeoutMs?: number;
  readonly webRoot?: string;
  readonly webAssets?: LocalWebAssets;
}

export interface RunningLocalWebApplication {
  readonly server: FastifyInstance;
  readonly hostname: '127.0.0.1';
  readonly port: number;
  readonly url: string;
  /** Non-secret, single-use loopback entry point for the development browser launcher. */
  readonly launchUrl: string;
  close(): Promise<void>;
}

export const localApiHostname = '127.0.0.1' as const;

export function generateLocalSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function generateLocalLaunchNonce(): string {
  return randomBytes(32).toString('base64url');
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('The local API port is invalid.');
  }
}

async function listenOnLoopback(server: FastifyInstance, port: number): Promise<{ readonly port: number; readonly url: string }> {
  try {
    await server.listen({ host: localApiHostname, port });
  } catch (error: unknown) {
    await server.close();
    throw error;
  }
  const address = server.server.address();
  if (address === null || typeof address === 'string' || address.address !== localApiHostname) {
    await server.close();
    throw new Error('The local API did not bind to the required numeric-loopback address.');
  }
  return { port: address.port, url: `http://${localApiHostname}:${String(address.port)}` };
}

export async function startLocalApi(
  dependencies: ApiDependencies,
  options: StartLocalApiOptions = {}
): Promise<RunningLocalApi> {
  const port = options.port ?? 0;
  validatePort(port);
  const sessionToken = generateLocalSessionToken();
  const server = buildApi(dependencies, {
    session: {
      bearerToken: sessionToken,
      ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins })
    },
    ...(options.handlerTimeoutMs === undefined ? {} : { handlerTimeoutMs: options.handlerTimeoutMs })
  });
  const listening = await listenOnLoopback(server, port);
  let closed = false;
  return Object.freeze({
    server,
    hostname: localApiHostname,
    port: listening.port,
    url: listening.url,
    sessionToken,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await server.close();
    }
  });
}

export async function startLocalWebApplication(
  dependencies: ApiDependencies,
  options: StartLocalWebApplicationOptions
): Promise<RunningLocalWebApplication> {
  const port = options.port ?? 0;
  validatePort(port);
  if ((options.webRoot === undefined) === (options.webAssets === undefined)) {
    throw new TypeError('Exactly one local web asset source is required.');
  }
  const assets = options.webAssets ?? await loadLocalWebAssets(options.webRoot as string);
  const sessionToken = generateLocalSessionToken();
  const launchNonce = generateLocalLaunchNonce();
  const server = buildApi(dependencies, {
    session: { bearerToken: sessionToken },
    browserShell: { assets, launchNonce },
    ...(options.handlerTimeoutMs === undefined ? {} : { handlerTimeoutMs: options.handlerTimeoutMs })
  });
  const listening = await listenOnLoopback(server, port);
  let closed = false;
  return Object.freeze({
    server,
    hostname: localApiHostname,
    port: listening.port,
    url: listening.url,
    launchUrl: `${listening.url}/.local-pii/launch`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await server.close();
    }
  });
}
