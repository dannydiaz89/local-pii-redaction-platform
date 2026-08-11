import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { repositoryRoot } from './schema-utils.js';

export interface SdkPublicApiExport {
  readonly name: string;
  readonly kind: 'type' | 'value';
  readonly declaration: string;
  readonly resolvedType: string;
}

export interface SdkPublicApiSnapshot {
  readonly schemaVersion: '1.0.0';
  readonly package: '@local-pii/sdk';
  readonly exports: readonly SdkPublicApiExport[];
}

export interface SdkPublicApiSnapshotOptions {
  readonly configPath?: string;
  readonly entryPath?: string;
}

const typeFormatFlags = ts.TypeFormatFlags.NoTruncation
  | ts.TypeFormatFlags.InTypeAlias
  | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

function declarationName(statement: ts.Statement): string | undefined {
  if ((ts.isFunctionDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isEnumDeclaration(statement))
    && statement.name !== undefined) return statement.name.text;
  if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    const declaration = statement.declarationList.declarations[0];
    if (declaration !== undefined && ts.isIdentifier(declaration.name)) return declaration.name.text;
  }
  return undefined;
}

function diagnosticsMessage(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (path) => path,
    getCurrentDirectory: () => repositoryRoot,
    getNewLine: () => '\n'
  });
}

function declarationOutput(
  sourcePath: string,
  emittedDeclarations: ReadonlyMap<string, string>
): string {
  const expectedName = `${basename(sourcePath).replace(/\.[cm]?tsx?$/u, '')}.d.ts`;
  const matches = [...emittedDeclarations].filter(([path]) => basename(path) === expectedName);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error('The SDK declaration emit did not produce one unambiguous public module.');
  }
  return matches[0][1];
}

function sourceDeclaration(symbol: ts.Symbol): ts.Declaration {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration === undefined) throw new Error('An SDK public export has no declaration.');
  return declaration;
}

function resolvedType(checker: ts.TypeChecker, symbol: ts.Symbol, declaration: ts.Declaration): string {
  if (ts.isTypeAliasDeclaration(declaration)) {
    return checker.typeToString(checker.getTypeFromTypeNode(declaration.type), declaration, typeFormatFlags);
  }
  if ((symbol.flags & ts.SymbolFlags.Value) !== 0) {
    return checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, declaration), declaration, typeFormatFlags);
  }
  return checker.typeToString(checker.getDeclaredTypeOfSymbol(symbol), declaration, typeFormatFlags);
}

export function createSdkPublicApiSnapshot(
  options: SdkPublicApiSnapshotOptions = {}
): SdkPublicApiSnapshot {
  const configPath = resolve(options.configPath ?? resolve(repositoryRoot, 'packages/sdk/tsconfig.json'));
  const entryPath = resolve(options.entryPath ?? resolve(repositoryRoot, 'packages/sdk/src/index.ts'));
  const configFile = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (configFile.error !== undefined) throw new Error(diagnosticsMessage([configFile.error]));
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, resolve(configPath, '..'));
  if (parsed.errors.length > 0) throw new Error(diagnosticsMessage(parsed.errors));

  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    noEmit: false,
    noEmitOnError: true
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) throw new Error(diagnosticsMessage(diagnostics));
  const emittedDeclarations = new Map<string, string>();
  const emitResult = program.emit(undefined, (path, contents) => {
    if (path.endsWith('.d.ts')) emittedDeclarations.set(resolve(path), contents);
  }, undefined, true);
  if (emitResult.emitSkipped || emitResult.diagnostics.length > 0) {
    throw new Error(diagnosticsMessage(emitResult.diagnostics));
  }

  const entry = program.getSourceFile(entryPath);
  const moduleSymbol = entry === undefined ? undefined : program.getTypeChecker().getSymbolAtLocation(entry);
  if (entry === undefined || moduleSymbol === undefined) throw new Error('The SDK public entry point is unavailable.');
  const checker = program.getTypeChecker();
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
  const exports = checker.getExportsOfModule(moduleSymbol).map((rootSymbol): SdkPublicApiExport => {
    const target = (rootSymbol.flags & ts.SymbolFlags.Alias) === 0
      ? rootSymbol
      : checker.getAliasedSymbol(rootSymbol);
    const declaration = sourceDeclaration(target);
    const declarationText = declarationOutput(declaration.getSourceFile().fileName, emittedDeclarations);
    const declarationFile = ts.createSourceFile(
      'public-module.d.ts', declarationText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS
    );
    const emittedDeclaration = declarationFile.statements.find((statement) => declarationName(statement) === target.name);
    if (emittedDeclaration === undefined) throw new Error('An SDK public declaration could not be canonicalized.');
    return Object.freeze({
      name: rootSymbol.name,
      kind: (target.flags & ts.SymbolFlags.Value) === 0 ? 'type' : 'value',
      declaration: printer.printNode(ts.EmitHint.Unspecified, emittedDeclaration, declarationFile).trim(),
      resolvedType: resolvedType(checker, target, declaration)
    });
  }).sort((left, right) => left.name.localeCompare(right.name));

  return Object.freeze({
    schemaVersion: '1.0.0',
    package: '@local-pii/sdk',
    exports: Object.freeze(exports)
  });
}

export function canonicalSdkPublicApiSnapshot(snapshot: SdkPublicApiSnapshot): string {
  return `${JSON.stringify(snapshot, undefined, 2)}\n`;
}

function assertSdkManifest(): void {
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, 'packages/sdk/package.json'), 'utf8')) as unknown;
  const expected = {
    types: './dist/index.d.ts',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } }
  };
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('The SDK package manifest is invalid.');
  }
  const record = manifest as Readonly<Record<string, unknown>>;
  if (record.types !== expected.types || JSON.stringify(record.exports) !== JSON.stringify(expected.exports)) {
    throw new Error('The SDK package must expose only its typed public root.');
  }
}

function main(): void {
  assertSdkManifest();
  const actual = canonicalSdkPublicApiSnapshot(createSdkPublicApiSnapshot());
  if (process.argv.includes('--print')) {
    process.stdout.write(actual);
    return;
  }
  const baselinePath = resolve(repositoryRoot, 'tooling/sdk-public-api-baseline.json');
  const expected = readFileSync(baselinePath, 'utf8');
  if (actual !== expected) {
    throw new Error('The SDK public API changed. Review compatibility and update the baseline deliberately.');
  }
  console.log('SDK public package-root declarations match the reviewed baseline.');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
