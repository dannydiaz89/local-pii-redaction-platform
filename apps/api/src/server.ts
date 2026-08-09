import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { buildApi, type ApiDependencies } from './application.js';

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

export const localApiHostname = '127.0.0.1' as const;

export function generateLocalSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function startLocalApi(
  dependencies: ApiDependencies,
  options: StartLocalApiOptions = {}
): Promise<RunningLocalApi> {
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('The local API port is invalid.');
  }
  const sessionToken = generateLocalSessionToken();
  const server = buildApi(dependencies, {
    session: {
      bearerToken: sessionToken,
      ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins })
    },
    ...(options.handlerTimeoutMs === undefined ? {} : { handlerTimeoutMs: options.handlerTimeoutMs })
  });
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
  let closed = false;
  return Object.freeze({
    server,
    hostname: localApiHostname,
    port: address.port,
    url: `http://${localApiHostname}:${String(address.port)}`,
    sessionToken,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await server.close();
    }
  });
}
