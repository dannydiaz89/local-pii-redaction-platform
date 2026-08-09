import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { repositoryRoot } from './schema-utils.js';

type WorkspacePackage =
  | 'adapter-text'
  | 'contracts'
  | 'detectors'
  | 'domain'
  | 'policy'
  | 'provider-ollama'
  | 'redaction'
  | 'span-resolution'
  | 'verification'
  | 'core';

interface PackageManifest {
  readonly name?: unknown;
  readonly exports?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly optionalDependencies?: unknown;
  readonly peerDependencies?: unknown;
}

type DependencyField = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';

export interface BoundaryViolation {
  readonly path: string;
  readonly message: string;
}

const workspacePackages: readonly WorkspacePackage[] = [
  'adapter-text',
  'contracts',
  'detectors',
  'domain',
  'policy',
  'provider-ollama',
  'redaction',
  'span-resolution',
  'verification',
  'core'
];

/**
 * The only production package directions in the local, ephemeral profile.
 * Adding a durable service requires a deliberate change here instead of an
 * accidental import from the CLI or a lower layer.
 */
const allowedRuntimeWorkspaceDependencies: Readonly<Record<WorkspacePackage, readonly WorkspacePackage[]>> = {
  'adapter-text': ['contracts', 'domain', 'redaction'],
  contracts: [],
  detectors: ['domain'],
  domain: [],
  policy: ['contracts', 'domain'],
  'provider-ollama': ['domain'],
  redaction: ['domain', 'span-resolution'],
  'span-resolution': ['domain'],
  verification: ['contracts', 'detectors', 'domain', 'span-resolution'],
  core: ['contracts', 'domain', 'policy', 'redaction', 'span-resolution']
};

const allowedDevelopmentWorkspaceDependencies: Readonly<Record<WorkspacePackage, readonly WorkspacePackage[]>> = {
  'adapter-text': [],
  contracts: [],
  detectors: [],
  domain: [],
  policy: [],
  'provider-ollama': [],
  redaction: ['detectors'],
  'span-resolution': ['detectors'],
  verification: [],
  core: []
};

const allowedCliWorkspaceDependencies: readonly WorkspacePackage[] = [
  'adapter-text',
  'contracts',
  'core',
  'detectors',
  'domain',
  'policy',
  'provider-ollama',
  'redaction',
  'verification'
];
const allowedCliRuntimeModules = new Set(['node:fs/promises', 'node:path']);
const allowedApiWorkspaceDependencies: readonly WorkspacePackage[] = ['contracts', 'core', 'domain'];
const allowedApiRuntimeModules = new Set(['fastify', 'node:crypto']);
const workspaceApplications = ['api', 'cli'] as const;

/** Modules that would add an HTTP server, durable store, artifact repository, or queue. */
const forbiddenInfrastructureModulePrefixes = [
  '@aws-sdk/client-s3',
  '@azure/storage-blob',
  '@google-cloud/storage',
  '@hono/node-server',
  '@nestjs/',
  '@prisma/',
  '@temporalio/',
  'agenda',
  'bee-queue',
  'better-sqlite3',
  'bull',
  'bullmq',
  'drizzle-orm',
  'express',
  'fastify',
  'hono',
  'ioredis',
  'koa',
  'kysely',
  'minio',
  'mongodb',
  'mysql2',
  'pg',
  'pg-boss',
  'postgres',
  'prisma',
  'redis',
  'sqlite3',
  'typeorm'
] as const;

const forbiddenCliServerModulePrefixes = [
  'node:cluster',
  'node:dgram',
  'node:http',
  'node:http2',
  'node:https',
  'node:net',
  'node:tls'
] as const;

const forbiddenDomainModulePrefixes = [
  'node:child_process',
  'node:fs',
  'node:http',
  'node:https',
  'node:net'
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function moduleNameFromExpression(expression: ts.Expression): string | undefined {
  return ts.isStringLiteralLike(expression) ? expression.text : undefined;
}

/**
 * Parses module specifiers from executable TypeScript syntax. Comments and
 * string literals that are not import/load expressions are intentionally ignored.
 */
export function moduleSpecifiersInSource(source: string, fileName = 'source.ts'): readonly string[] {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = new Set<string>();
  const add = (expression: ts.Expression): void => {
    const specifier = moduleNameFromExpression(expression);
    if (specifier !== undefined) specifiers.add(specifier);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined) {
        add(node.arguments[0]);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments[0] !== undefined) {
        add(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return [...specifiers];
}

function isModuleOrSubpath(specifier: string, prefix: string): boolean {
  return specifier === prefix || specifier.startsWith(`${prefix}/`);
}

function workspacePackageFromSpecifier(specifier: string): WorkspacePackage | undefined {
  const match = /^@local-pii\/([a-z0-9-]+)(?:\/|$)/u.exec(specifier);
  const packageName = match?.[1];
  return packageName !== undefined && workspacePackages.includes(packageName as WorkspacePackage)
    ? packageName as WorkspacePackage
    : undefined;
}

function dependencyNames(manifest: PackageManifest, field: DependencyField): readonly string[] {
  const value = manifest[field];
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value);
}

function workspaceDependencies(manifest: PackageManifest, field: DependencyField): readonly WorkspacePackage[] {
  return dependencyNames(manifest, field).flatMap((name) => workspacePackageFromSpecifier(name) ?? []);
}

function unknownWorkspaceDependencies(manifest: PackageManifest): readonly string[] {
  return (['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const)
    .flatMap((field) => dependencyNames(manifest, field))
    .filter((name) => name.startsWith('@local-pii/') && workspacePackageFromSpecifier(name) === undefined);
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && actual.every((value) => expected.includes(value))
    && expected.every((value) => actual.includes(value));
}

function violation(path: string, message: string): BoundaryViolation {
  return { path, message };
}

export function checkSourceDependencyDirection(
  path: string,
  source: string,
  allowedWorkspaceDependencies: readonly WorkspacePackage[],
  options: { readonly apiRuntime?: boolean; readonly cliRuntime?: boolean; readonly domain?: boolean } = {}
): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const specifier of moduleSpecifiersInSource(source, path)) {
    const workspacePackage = workspacePackageFromSpecifier(specifier);
    if (specifier.startsWith('@local-pii/') && workspacePackage === undefined) {
      violations.push(violation(path, `imports an unknown workspace package ${specifier}`));
      continue;
    }
    if (workspacePackage !== undefined) {
      if (specifier !== `@local-pii/${workspacePackage}`) {
        violations.push(violation(path, `imports non-public workspace path ${specifier}`));
      } else if (!allowedWorkspaceDependencies.includes(workspacePackage)) {
        violations.push(violation(path, `imports ${specifier}, outside its allow-listed dependency direction`));
      }
      continue;
    }
    if (options.apiRuntime === true && allowedApiRuntimeModules.has(specifier)) continue;
    if (forbiddenInfrastructureModulePrefixes.some((prefix) => isModuleOrSubpath(specifier, prefix))) {
      violations.push(violation(path, `imports or loads forbidden durable/server infrastructure ${specifier}`));
      continue;
    }
    if (options.domain === true && forbiddenDomainModulePrefixes.some((prefix) => isModuleOrSubpath(specifier, prefix))) {
      violations.push(violation(path, `imports forbidden domain module ${specifier}`));
      continue;
    }
    if (options.cliRuntime === true && forbiddenCliServerModulePrefixes.some((prefix) => isModuleOrSubpath(specifier, prefix))) {
      violations.push(violation(path, `imports or loads forbidden default-CLI server infrastructure ${specifier}`));
      continue;
    }
    if (options.cliRuntime === true && !specifier.startsWith('.') && !allowedCliRuntimeModules.has(specifier)) {
      violations.push(violation(path, `imports ${specifier}, which is not allow-listed for the default CLI runtime`));
      continue;
    }
    if (options.apiRuntime === true && !specifier.startsWith('.') && !allowedApiRuntimeModules.has(specifier)) {
      violations.push(violation(path, `imports ${specifier}, which is not allow-listed for the API runtime`));
    }
  }
  return violations;
}

function workspaceDependenciesFromOtherFields(manifest: PackageManifest): readonly WorkspacePackage[] {
  return (['optionalDependencies', 'peerDependencies'] as const).flatMap((field) => {
    return workspaceDependencies(manifest, field);
  });
}

export function checkPackageManifest(
  path: string,
  packageName: WorkspacePackage,
  manifest: PackageManifest
): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  if (manifest.name !== `@local-pii/${packageName}`) {
    violations.push(violation(path, 'has an unexpected package name'));
  }
  if (manifest.exports === null || typeof manifest.exports !== 'object' || Array.isArray(manifest.exports)
    || JSON.stringify(manifest.exports) !== JSON.stringify({ '.': './dist/index.js' })) {
    violations.push(violation(path, 'must expose only the public package root'));
  }
  const runtime = workspaceDependencies(manifest, 'dependencies');
  if (!sameMembers(runtime, allowedRuntimeWorkspaceDependencies[packageName])) {
    violations.push(violation(path, `workspace runtime dependencies must be exactly: ${allowedRuntimeWorkspaceDependencies[packageName].join(', ') || '(none)'}`));
  }
  const development = workspaceDependencies(manifest, 'devDependencies');
  if (!sameMembers(development, allowedDevelopmentWorkspaceDependencies[packageName])) {
    violations.push(violation(path, `workspace development dependencies must be exactly: ${allowedDevelopmentWorkspaceDependencies[packageName].join(', ') || '(none)'}`));
  }
  const otherWorkspaceDependencies = workspaceDependenciesFromOtherFields(manifest);
  if (otherWorkspaceDependencies.length > 0) {
    violations.push(violation(path, 'must not declare workspace packages as optional or peer dependencies'));
  }
  const unknownWorkspace = unknownWorkspaceDependencies(manifest);
  if (unknownWorkspace.length > 0) {
    violations.push(violation(path, `must not declare unknown workspace dependencies: ${unknownWorkspace.join(', ')}`));
  }
  return violations;
}

function checkCliManifest(path: string, manifest: PackageManifest): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const runtime = workspaceDependencies(manifest, 'dependencies');
  if (!sameMembers(runtime, allowedCliWorkspaceDependencies)) {
    violations.push(violation(path, `CLI workspace runtime dependencies must be exactly: ${allowedCliWorkspaceDependencies.join(', ')}`));
  }
  const declaredRuntime = manifest.dependencies;
  if (declaredRuntime !== undefined && declaredRuntime !== null && typeof declaredRuntime === 'object' && !Array.isArray(declaredRuntime)) {
    const externalDependencies = Object.keys(declaredRuntime).filter((name) => !name.startsWith('@local-pii/'));
    if (externalDependencies.length > 0) {
      violations.push(violation(path, `default CLI must not declare external runtime dependencies: ${externalDependencies.join(', ')}`));
    }
  }
  const unknownWorkspace = unknownWorkspaceDependencies(manifest);
  if (unknownWorkspace.length > 0) {
    violations.push(violation(path, `must not declare unknown workspace dependencies: ${unknownWorkspace.join(', ')}`));
  }
  return violations;
}

export function checkApiManifest(path: string, manifest: PackageManifest): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  if (manifest.name !== '@local-pii/api') {
    violations.push(violation(path, 'has an unexpected package name'));
  }
  if (manifest.exports === null || typeof manifest.exports !== 'object' || Array.isArray(manifest.exports)
    || JSON.stringify(manifest.exports) !== JSON.stringify({ '.': './dist/index.js' })) {
    violations.push(violation(path, 'must expose only the public package root'));
  }
  const runtime = workspaceDependencies(manifest, 'dependencies');
  if (!sameMembers(runtime, allowedApiWorkspaceDependencies)) {
    violations.push(violation(path, `API workspace runtime dependencies must be exactly: ${allowedApiWorkspaceDependencies.join(', ')}`));
  }
  const declaredRuntime = manifest.dependencies;
  if (declaredRuntime !== undefined && declaredRuntime !== null && typeof declaredRuntime === 'object' && !Array.isArray(declaredRuntime)) {
    const externalDependencies = Object.keys(declaredRuntime).filter((name) => !name.startsWith('@local-pii/'));
    if (!sameMembers(externalDependencies, ['fastify'])) {
      violations.push(violation(path, 'API external runtime dependencies must be exactly: fastify'));
    }
  } else {
    violations.push(violation(path, 'API external runtime dependencies must be exactly: fastify'));
  }
  const development = workspaceDependencies(manifest, 'devDependencies');
  if (development.length > 0) {
    violations.push(violation(path, 'API must not declare workspace development dependencies'));
  }
  const otherWorkspaceDependencies = workspaceDependenciesFromOtherFields(manifest);
  if (otherWorkspaceDependencies.length > 0) {
    violations.push(violation(path, 'API must not declare workspace packages as optional or peer dependencies'));
  }
  const unknownWorkspace = unknownWorkspaceDependencies(manifest);
  if (unknownWorkspace.length > 0) {
    violations.push(violation(path, `must not declare unknown workspace dependencies: ${unknownWorkspace.join(', ')}`));
  }
  return violations;
}

export function checkApplicationDirectoryNames(names: readonly string[]): readonly BoundaryViolation[] {
  return names
    .filter((name) => !(workspaceApplications as readonly string[]).includes(name))
    .map((name) => violation(`apps/${name}`, 'is not in the workspace application allow-list'));
}

function relativePath(path: string): string {
  return relative(repositoryRoot, path);
}

export function boundaryViolations(root = repositoryRoot): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const packageRoot = resolve(root, 'packages');

  for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageName = entry.name as WorkspacePackage;
    if (!workspacePackages.includes(packageName)) {
      violations.push(violation(relativePath(resolve(packageRoot, entry.name)), 'is not in the workspace package allow-list'));
      continue;
    }
    const directory = resolve(packageRoot, entry.name);
    const manifestPath = resolve(directory, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
    violations.push(...checkPackageManifest(relativePath(manifestPath), packageName, manifest));
    for (const sourcePath of sourceFiles(resolve(directory, 'src'))) {
      violations.push(...checkSourceDependencyDirection(
        relativePath(sourcePath),
        readFileSync(sourcePath, 'utf8'),
        allowedRuntimeWorkspaceDependencies[packageName],
        { domain: packageName === 'domain' }
      ));
    }
  }

  const cliDirectory = resolve(root, 'apps/cli');
  const cliManifestPath = resolve(cliDirectory, 'package.json');
  const cliManifest = JSON.parse(readFileSync(cliManifestPath, 'utf8')) as PackageManifest;
  violations.push(...checkCliManifest(relativePath(cliManifestPath), cliManifest));
  for (const sourcePath of sourceFiles(resolve(cliDirectory, 'src'))) {
    violations.push(...checkSourceDependencyDirection(
      relativePath(sourcePath),
      readFileSync(sourcePath, 'utf8'),
      allowedCliWorkspaceDependencies,
      { cliRuntime: true }
    ));
  }

  const applicationRoot = resolve(root, 'apps');
  const applicationNames = readdirSync(applicationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name);
  violations.push(...checkApplicationDirectoryNames(applicationNames));

  const apiDirectory = resolve(applicationRoot, 'api');
  const apiManifestPath = resolve(apiDirectory, 'package.json');
  const apiManifest = JSON.parse(readFileSync(apiManifestPath, 'utf8')) as PackageManifest;
  violations.push(...checkApiManifest(relativePath(apiManifestPath), apiManifest));
  for (const sourcePath of sourceFiles(resolve(apiDirectory, 'src'))) {
    violations.push(...checkSourceDependencyDirection(
      relativePath(sourcePath),
      readFileSync(sourcePath, 'utf8'),
      allowedApiWorkspaceDependencies,
      { apiRuntime: true }
    ));
  }
  return violations;
}

export function assertBoundaryViolations(root = repositoryRoot): void {
  const violations = boundaryViolations(root);
  if (violations.length > 0) {
    throw new Error(`Dependency boundary violations:\n${violations.map(({ path, message }) => `${path} ${message}`).join('\n')}`);
  }
}

function isDirectExecution(): boolean {
  const invokedPath = process.argv[1];
  return invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  assertBoundaryViolations();
  console.log('Dependency boundaries are valid.');
}
