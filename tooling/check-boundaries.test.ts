import { describe, expect, it } from 'vitest';

import {
  checkApiManifest,
  checkApplicationDirectoryNames,
  checkPackageManifest,
  checkSourceDependencyDirection,
  moduleSpecifiersInSource
} from './check-boundaries.js';

describe('boundary checker', () => {
  it('parses import syntax without treating comments or ordinary strings as dependencies', () => {
    const source = [
      "// import fastify from 'fastify'",
      "const documentation = \"from 'fastify'\";",
      "import type { EntityType } from '@local-pii/domain';",
      "export { run } from '@local-pii/core';",
      "void import('hono');",
      "const server = require('fastify');"
    ].join('\n');

    expect(moduleSpecifiersInSource(source)).toEqual([
      '@local-pii/domain',
      '@local-pii/core',
      'hono',
      'fastify'
    ]);
  });

  it('rejects server, durable infrastructure, and non-public workspace imports from the CLI', () => {
    const violations = checkSourceDependencyDirection(
      'apps/cli/src/example.ts',
      [
        "import Fastify from 'fastify';",
        "import { createClient } from 'redis';",
        "import { helper } from '@local-pii/core/internal';",
        "import { detectDeterministic } from '@local-pii/detectors';"
      ].join('\n'),
      ['detectors'],
      { cliRuntime: true }
    );

    expect(violations.map(({ message }) => message)).toEqual([
      'imports or loads forbidden durable/server infrastructure fastify',
      'imports or loads forbidden durable/server infrastructure redis',
      'imports non-public workspace path @local-pii/core/internal'
    ]);
  });

  it('rejects an unapproved workspace direction even when the dependency is public', () => {
    const violations = checkSourceDependencyDirection(
      'packages/domain/src/example.ts',
      "import { assertCapabilityManifest } from '@local-pii/contracts';",
      [],
      { domain: true }
    );

    expect(violations.map(({ message }) => message)).toEqual([
      'imports @local-pii/contracts, outside its allow-listed dependency direction'
    ]);
  });

  it('allows only the explicit Fastify API surface and rejects other server/runtime imports', () => {
    const violations = checkSourceDependencyDirection(
      'apps/api/src/example.ts',
      [
        "import { timingSafeEqual } from 'node:crypto';",
        "import Fastify from 'fastify';",
        "import { createClient } from 'redis';",
        "import { serve } from '@hono/node-server';",
        "import { request } from 'node:http';",
        "import { helper } from '@local-pii/core/internal';",
        "import { detect } from '@local-pii/detectors';"
      ].join('\n'),
      ['contracts', 'core', 'domain'],
      { apiRuntime: true }
    );

    expect(violations.map(({ message }) => message)).toEqual([
      'imports or loads forbidden durable/server infrastructure redis',
      'imports or loads forbidden durable/server infrastructure @hono/node-server',
      'imports node:http, which is not allow-listed for the API runtime',
      'imports non-public workspace path @local-pii/core/internal',
      'imports @local-pii/detectors, outside its allow-listed dependency direction'
    ]);
  });

  it('requires the API manifest to declare only its approved workspace and Fastify runtime', () => {
    const violations = checkApiManifest('apps/api/package.json', {
      name: '@local-pii/api',
      exports: { '.': './dist/index.js' },
      dependencies: {
        '@local-pii/contracts': 'workspace:*',
        '@local-pii/core': 'workspace:*',
        '@local-pii/domain': 'workspace:*',
        '@local-pii/detectors': 'workspace:*',
        fastify: '^5.11.3',
        redis: '^5.0.0'
      }
    });

    expect(violations.map(({ message }) => message)).toEqual([
      'API workspace runtime dependencies must be exactly: contracts, core, domain',
      'API external runtime dependencies must be exactly: fastify'
    ]);
  });

  it('rejects unknown application roots until their boundary policy is explicit', () => {
    expect(checkApplicationDirectoryNames(['api', 'cli', 'worker', 'web'])).toEqual([
      { path: 'apps/worker', message: 'is not in the workspace application allow-list' },
      { path: 'apps/web', message: 'is not in the workspace application allow-list' }
    ]);
  });

  it('requires a package manifest to match the explicit runtime dependency direction', () => {
    const violations = checkPackageManifest('packages/core/package.json', 'core', {
      name: '@local-pii/core',
      exports: { '.': './dist/index.js' },
      dependencies: {
        '@local-pii/contracts': 'workspace:*',
        '@local-pii/domain': 'workspace:*',
        '@local-pii/redaction': 'workspace:*',
        '@local-pii/durable-store': 'workspace:*'
      }
    });

    expect(violations.map(({ message }) => message)).toContain(
      'workspace runtime dependencies must be exactly: contracts, domain, policy, redaction, span-resolution'
    );
    expect(violations.map(({ message }) => message)).toContain(
      'must not declare unknown workspace dependencies: @local-pii/durable-store'
    );
  });
});
