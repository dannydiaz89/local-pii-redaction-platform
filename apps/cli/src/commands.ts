import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  deriveRedactedOutputPath,
  discardStagedTextArtifact,
  publishStagedTextArtifact,
  readTextArtifact,
  stageTextArtifact,
  type TextArtifact
} from '@local-pii/adapter-text';
import { assertContract } from '@local-pii/contracts';
import { detectDeterministic, deterministicDetectorBundleVersion } from '@local-pii/detectors';
import { SafeError, unicodeCodePointLength, type EntityType } from '@local-pii/domain';
import { applyTypedLabelPlan, compileTypedLabelPlan } from '@local-pii/redaction';
import { resolveEvidence, type ResolutionSet } from '@local-pii/span-resolution';
import { verifyCanonicalText } from '@local-pii/verification';

import { createCurrentCapabilityManifest } from './capabilities.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface ParsedArguments {
  readonly command: string | undefined;
  readonly input: string | undefined;
  readonly output: string | undefined;
  readonly json: boolean;
  readonly help: boolean;
  readonly license: boolean;
}

const usage = `Usage:
  pii-redact capabilities [--json]
  pii-redact scan <file.txt|file.md> [--json]
  pii-redact redact <file.txt|file.md> [--output <path>] [--json]
  pii-redact verify <file.txt|file.md> [--json]
  pii-redact inspect <file.txt|file.md> [--json]
  pii-redact --version
  pii-redact --license
`;

const cliReportSchemaId = 'https://local-pii.dev/schemas/cli/cli-report/1.0.0';

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positional: string[] = [];
  let output: string | undefined;
  let json = false;
  let help = false;
  let license = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') json = true;
    else if (value === '--help' || value === '-h') help = true;
    else if (value === '--license') license = true;
    else if (value === '--output' || value === '-o') {
      output = argv[index + 1];
      if (output === undefined) throw new Error('--output requires a path');
      index += 1;
    } else if (value !== undefined) positional.push(value);
  }
  return { command: positional[0], input: positional[1], output, json, help, license };
}

function writeResult(io: CliIo, json: boolean, value: object, human: string): void {
  assertContract(cliReportSchemaId, value);
  io.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`);
}

function entityCounts(entityTypes: readonly EntityType[]): Readonly<Partial<Record<EntityType, number>>> {
  const counts: Partial<Record<EntityType, number>> = {};
  for (const entityType of entityTypes) counts[entityType] = (counts[entityType] ?? 0) + 1;
  return counts;
}

function runCapabilities(json: boolean, io: CliIo): number {
  const manifest = createCurrentCapabilityManifest();
  if (json) {
    io.stdout(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    const availableDetectors = manifest.detectors.filter(({ availability }) => availability === 'AVAILABLE');
    io.stdout([
      `Engine mode: ${manifest.engineMode}`,
      `Qualification: ${manifest.formats[0].qualification}`,
      `Formats: ${manifest.formats.map(({ id }) => id).join(', ')}`,
      `Detectors: ${String(availableDetectors.length)}`,
      `Verification profiles: ${manifest.verificationProfiles.map(({ id }) => id).join(', ')}`
    ].join('\n') + '\n');
  }
  return 0;
}

function scanArtifact(artifact: TextArtifact): ResolutionSet {
  const evidence = detectDeterministic(artifact.text, artifact.extractionRevision);
  return resolveEvidence(evidence, artifact.extractionRevision, unicodeCodePointLength(artifact.text));
}

async function runScan(input: string, json: boolean, io: CliIo): Promise<number> {
  const artifact = await readTextArtifact(input);
  const evidence = detectDeterministic(artifact.text, artifact.extractionRevision);
  const resolution = resolveEvidence(evidence, artifact.extractionRevision, unicodeCodePointLength(artifact.text));
  const report = {
    schemaVersion: '1.0.0',
    operation: 'SCAN',
    outcome: resolution.conflicts.length === 0 ? 'SUCCEEDED' : 'NEEDS_REVIEW',
    input: { displayName: artifact.displayName, mediaType: artifact.mediaType, byteLength: artifact.byteLength, digest: artifact.digest },
    detectorBundleVersion: deterministicDetectorBundleVersion,
    counts: { detections: resolution.spans.length, conflicts: resolution.conflicts.length, byEntity: entityCounts(resolution.spans.map((span) => span.entityType)) },
    detections: resolution.spans.map((span) => ({ id: span.id, entityType: span.entityType, start: span.start, end: span.end, confidence: span.confidence, evidenceIds: span.evidenceIds })),
    conflicts: resolution.conflicts
  };
  writeResult(io, json, report, `Found ${String(resolution.spans.length)} resolved detection(s) and ${String(resolution.conflicts.length)} conflict(s).`);
  return resolution.conflicts.length === 0 ? 0 : 5;
}

async function runRedact(input: string, output: string | undefined, json: boolean, io: CliIo): Promise<number> {
  const artifact = await readTextArtifact(input);
  const resolution = scanArtifact(artifact);
  if (resolution.conflicts.length > 0) {
    throw new SafeError({ code: 'REDACTION_PLAN_CONFLICT', message: 'Overlapping detections require review before redaction.', retryable: false, correlationId: 'cor_cli_redact', details: { conflictCount: resolution.conflicts.length } });
  }
  const plan = compileTypedLabelPlan(resolution);
  const redacted = applyTypedLabelPlan(artifact.text, plan);
  const outputPath = output === undefined ? deriveRedactedOutputPath(artifact.path) : resolve(output);
  const staged = await stageTextArtifact(artifact, outputPath, redacted);
  try {
    const reopened = await readTextArtifact(staged.path);
    const verification = verifyCanonicalText(reopened.text, reopened.extractionRevision);
    if (verification.outcome !== 'PASS') {
      throw new SafeError({ code: 'VERIFICATION_RESIDUAL', message: 'Residual sensitive content blocked publication of the derived artifact.', retryable: false, correlationId: 'cor_cli_redact', details: { findingCount: verification.findings.length } });
    }
    const published = await publishStagedTextArtifact(artifact, staged);
    const report = {
      schemaVersion: '1.0.0', operation: 'REDACT', outcome: 'VERIFIED',
      input: { digest: artifact.digest, byteLength: artifact.byteLength },
      output: { path: published.path, digest: published.digest, byteLength: published.byteLength },
      plan: { digest: plan.digest, strategy: plan.strategy, actionCount: plan.actions.length, byEntity: entityCounts(plan.actions.map((action) => action.entityType)) },
      verification
    };
    writeResult(io, json, report, `Wrote verified output to ${published.path} with ${String(plan.actions.length)} replacement(s).`);
    return 0;
  } catch (error: unknown) {
    await discardStagedTextArtifact(staged);
    throw error;
  }
}

async function runVerify(input: string, json: boolean, io: CliIo): Promise<number> {
  const artifact = await readTextArtifact(input);
  const verification = verifyCanonicalText(artifact.text, artifact.extractionRevision);
  const report = {
    schemaVersion: '1.0.0', operation: 'VERIFY', outcome: verification.outcome,
    artifact: { displayName: artifact.displayName, digest: artifact.digest, byteLength: artifact.byteLength },
    verification
  };
  writeResult(io, json, report, verification.outcome === 'PASS'
    ? 'Verification passed: no deterministic residuals were found.'
    : `Verification failed with ${String(verification.findings.length)} blocking finding(s).`);
  return verification.outcome === 'PASS' ? 0 : 4;
}

async function runInspect(input: string, json: boolean, io: CliIo): Promise<number> {
  const artifact = await readTextArtifact(input);
  const report = {
    schemaVersion: '1.0.0', operation: 'INSPECT', outcome: 'SUCCEEDED',
    artifact: {
      displayName: artifact.displayName,
      mediaType: artifact.mediaType,
      byteLength: artifact.byteLength,
      digest: artifact.digest,
      extractionRevision: artifact.extractionRevision,
      unicodeCodePoints: unicodeCodePointLength(artifact.text),
      hasUtf8Bom: artifact.hasUtf8Bom
    },
    capability: { adapter: 'text', version: '0.1.0', operations: ['SCAN', 'REDACT', 'VERIFY', 'INSPECT'] }
  };
  writeResult(io, json, report, `${artifact.displayName}: ${String(artifact.byteLength)} bytes, ${String(unicodeCodePointLength(artifact.text))} Unicode code points.`);
  return 0;
}

function writeSafeError(error: SafeError, json: boolean, io: CliIo): number {
  const envelope = {
    schemaVersion: '1.0.0',
    error: { code: error.code, message: error.message, retryable: error.retryable, correlationId: error.correlationId, ...(error.details === undefined ? {} : { details: error.details }) }
  };
  io.stderr(json ? `${JSON.stringify(envelope, null, 2)}\n` : `${error.code}: ${error.message}\n`);
  return error.code === 'OUTPUT_COLLISION' ? 6 : error.code.startsWith('VERIFICATION_') ? 4 : 3;
}

export async function executeCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error: unknown) {
    io.stderr(`${error instanceof Error ? error.message : 'Invalid arguments'}\n${usage}`);
    return 2;
  }

  if (parsed.license) {
    const licensePath = resolve(import.meta.dirname, '../../../LICENSE');
    io.stdout(await readFile(licensePath, 'utf8'));
    return 0;
  }
  if (parsed.command === '--version' || parsed.command === 'version') {
    io.stdout('pii-redact 0.1.0-dev\n');
    return 0;
  }
  if (parsed.help || parsed.command === undefined) {
    io.stdout(usage);
    return parsed.help ? 0 : 2;
  }
  if (parsed.command === 'capabilities') {
    if (parsed.input !== undefined || parsed.output !== undefined) {
      io.stderr(usage);
      return 2;
    }
    return runCapabilities(parsed.json, io);
  }
  if (parsed.input === undefined || !['scan', 'redact', 'verify', 'inspect'].includes(parsed.command)) {
    io.stderr(usage);
    return 2;
  }

  try {
    if (parsed.command === 'scan') return await runScan(parsed.input, parsed.json, io);
    if (parsed.command === 'redact') return await runRedact(parsed.input, parsed.output, parsed.json, io);
    if (parsed.command === 'verify') return await runVerify(parsed.input, parsed.json, io);
    return await runInspect(parsed.input, parsed.json, io);
  } catch (error: unknown) {
    if (error instanceof SafeError) return writeSafeError(error, parsed.json, io);
    io.stderr(parsed.json
      ? `${JSON.stringify({ schemaVersion: '1.0.0', error: { code: 'INTERNAL_ERROR', message: 'The operation failed unexpectedly.', retryable: false, correlationId: 'cor_cli_internal' } }, null, 2)}\n`
      : 'INTERNAL_ERROR: The operation failed unexpectedly.\n');
    return 3;
  }
}
