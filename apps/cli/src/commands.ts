import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  cleanupStaleTextStages,
  createLocalTextArtifactSession,
  inventoryTextStages
} from '@local-pii/adapter-text';
import { assertContract } from '@local-pii/contracts';
import { SafeError, unicodeCodePointLength, type EntityType } from '@local-pii/domain';
import {
  bundledPolicies,
  compilePolicy,
  evaluateCapabilities,
  type EffectivePolicy
} from '@local-pii/policy';

import {
  assertOllamaLoopbackEndpoint,
  ollamaExperimentalDefaultLimits
} from '@local-pii/provider-ollama';

import {
  createExperimentalOllamaTextApplication,
  localTextApplication,
  textCapabilityRequirement
} from './application.js';
import { createCurrentCapabilityManifest } from './capabilities.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface ExecuteCliOptions {
  /** Cooperatively stops artifact, detector, and verification work. */
  readonly signal?: AbortSignal;
  /** Lets a signal source preserve a signal-specific process status. */
  readonly getCancellationExitCode?: () => number | undefined;
}

interface ParsedArguments {
  readonly command: string | undefined;
  readonly input: string | undefined;
  readonly policyName: string | undefined;
  readonly selectedPolicy: keyof typeof bundledPolicies | undefined;
  readonly output: string | undefined;
  readonly engine: 'rules' | 'ollama';
  readonly engineSpecified: boolean;
  readonly model: string | undefined;
  readonly ollamaUrl: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly allowExperimental: boolean;
  readonly apply: boolean;
  readonly json: boolean;
  readonly help: boolean;
  readonly license: boolean;
}

const usage = `Usage:
  pii-redact policies list [--json]
  pii-redact policies explain <development-labels|high-risk-disclosure> [--json]
  pii-redact capabilities [--engine rules|ollama] [--model <local-model>] [--json]
  pii-redact scan <file.txt|file.md> [--engine rules|ollama] [--model <local-model>] [--json]
  pii-redact redact <file.txt|file.md> --output <path> [--policy <development-labels|high-risk-disclosure>] [--json]
  pii-redact verify <file.txt|file.md> [--json]
  pii-redact inspect <file.txt|file.md> [--json]
  pii-redact cleanup-stages --output <path> [--apply] [--json]
  pii-redact --version
  pii-redact --license

Experimental Ollama options:
  --engine ollama --model <local-model> --allow-experimental
  [--ollama-url http://127.0.0.1:11434] [--timeout-ms <1000-300000>]
`;

const cliReportSchemaId = 'https://local-pii.dev/schemas/cli/cli-report/1.0.0';
const cliRedactReportV2SchemaId = 'https://local-pii.dev/schemas/cli/redact-report/2.0.0';
const policyReportSchemaId = 'https://local-pii.dev/schemas/cli/policy-report/1.0.0';
const stageRecoveryReportSchemaId = 'https://local-pii.dev/schemas/cli/stage-recovery-report/1.0.0';
const errorEnvelopeSchemaId = 'https://local-pii.dev/schemas/common/errors/1.0.0';
const errorEnvelopeV2SchemaId = 'https://local-pii.dev/schemas/common/errors/2.0.0';
const errorEnvelopeV3SchemaId = 'https://local-pii.dev/schemas/common/errors/3.0.0';

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positional: string[] = [];
  let output: string | undefined;
  let selectedPolicy: keyof typeof bundledPolicies | undefined;
  let engine: 'rules' | 'ollama' = 'rules';
  let engineSpecified = false;
  let model: string | undefined;
  let ollamaUrl: string | undefined;
  let timeoutMs: number | undefined;
  let allowExperimental = false;
  let apply = false;
  let json = false;
  let help = false;
  let license = false;
  const valueAfter = (index: number, option: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) throw new Error(`${option} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--') continue;
    if (value === '--version') positional.push(value);
    else if (value === '--json') json = true;
    else if (value === '--help' || value === '-h') help = true;
    else if (value === '--license') license = true;
    else if (value === '--allow-experimental') allowExperimental = true;
    else if (value === '--apply') apply = true;
    else if (value === '--policy') {
      if (selectedPolicy !== undefined) throw new Error('duplicate policy');
      const selected = valueAfter(index, '--policy');
      if (selected !== 'development-labels' && selected !== 'high-risk-disclosure') {
        throw new Error('unknown policy');
      }
      selectedPolicy = selected;
      index += 1;
    }
    else if (value === '--output' || value === '-o') {
      if (output !== undefined) throw new Error('duplicate output');
      output = valueAfter(index, '--output');
      index += 1;
    } else if (value === '--engine') {
      engineSpecified = true;
      const selected = valueAfter(index, '--engine');
      if (selected !== 'rules' && selected !== 'ollama') throw new Error('unknown engine');
      engine = selected;
      index += 1;
    } else if (value === '--model') {
      model = valueAfter(index, '--model');
      if (model.length > 200) throw new Error('model name is too long');
      index += 1;
    } else if (value === '--ollama-url') {
      ollamaUrl = valueAfter(index, '--ollama-url');
      index += 1;
    } else if (value === '--timeout-ms') {
      const parsed = Number(valueAfter(index, '--timeout-ms'));
      if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 300_000) throw new Error('invalid timeout');
      timeoutMs = parsed;
      index += 1;
    } else if (value?.startsWith('-') === true) {
      throw new Error('unknown option');
    } else if (value !== undefined) positional.push(value);
  }
  if (positional.length > 3) throw new Error('too many positional arguments');
  return {
    command: positional[0],
    input: positional[1],
    policyName: positional[2],
    selectedPolicy,
    output,
    engine,
    engineSpecified,
    model,
    ollamaUrl,
    timeoutMs,
    allowExperimental,
    apply,
    json,
    help,
    license
  };
}

function writeResult(io: CliIo, json: boolean, value: object, human: string): void {
  const operation = (value as Readonly<{ readonly operation?: unknown }>).operation;
  assertContract(operation === 'REDACT'
    ? cliRedactReportV2SchemaId
    : operation === 'STAGE_RECOVERY'
      ? stageRecoveryReportSchemaId
      : cliReportSchemaId, value);
  io.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`);
}

function entityCounts(entityTypes: readonly EntityType[]): Readonly<Partial<Record<EntityType, number>>> {
  const counts: Partial<Record<EntityType, number>> = {};
  for (const entityType of entityTypes) counts[entityType] = (counts[entityType] ?? 0) + 1;
  return counts;
}

function policySummary(policy: EffectivePolicy) {
  return {
    id: policy.id,
    version: policy.version,
    digest: policy.digest,
    riskTier: policy.riskTier,
    example: true as const
  };
}

function compiledBundledPolicies(): readonly EffectivePolicy[] {
  return Object.keys(bundledPolicies).sort().map((name) =>
    compilePolicy(bundledPolicies[name as keyof typeof bundledPolicies])
  );
}

function runPolicyList(json: boolean, io: CliIo): number {
  const policies = compiledBundledPolicies().map(policySummary);
  const report = { schemaVersion: '1.0.0', operation: 'POLICY_LIST', policies };
  assertContract(policyReportSchemaId, report);
  io.stdout(json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${policies.map((policy) => `${policy.id} ${policy.version} (${policy.riskTier}, example)`).join('\n')}\n`);
  return 0;
}

function runPolicyExplain(policyName: keyof typeof bundledPolicies, json: boolean, io: CliIo): number {
  const policy = compilePolicy(bundledPolicies[policyName]);
  const manifest = createCurrentCapabilityManifest();
  const evaluation = evaluateCapabilities(policy, manifest, {
    contractVersion: '1.0.0',
    engineModes: ['RULES_ONLY'],
    formatId: 'text',
    operation: 'REDACT',
    minimumQualification: policy.riskTier === 'HIGH' ? 'QUALIFIED' : 'DEVELOPMENT'
  });
  const report = {
    schemaVersion: '1.0.0',
    operation: 'POLICY_EXPLAIN',
    policy: policySummary(policy),
    capability: { id: manifest.id, version: manifest.version, engineMode: manifest.engineMode },
    satisfiable: evaluation.available,
    decisions: evaluation.decisions
  };
  assertContract(policyReportSchemaId, report);
  io.stdout(json
    ? `${JSON.stringify(report, null, 2)}\n`
    : [
        `Policy: ${policy.id} ${policy.version} (${policy.riskTier}, example)`,
        `Capability: ${manifest.id} ${manifest.version} (${manifest.engineMode})`,
        `Satisfiable: ${evaluation.available ? 'yes' : 'no'}`,
        ...evaluation.decisions.map(({ code, available }) => `${code}: ${available ? 'available' : 'unavailable'}`)
      ].join('\n') + '\n');
  return 0;
}

async function runCapabilities(parsed: ParsedArguments, io: CliIo, signal?: AbortSignal): Promise<number> {
  const selected = await selectedApplication(parsed, signal);
  const manifest = await selected.getCapabilities({ correlationId: 'cor_cli_capabilities' }, signal);
  if (parsed.engine === 'ollama') experimentalWarning(io);
  if (parsed.json) {
    io.stdout(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    const availableDetectors = manifest.detectors.filter(({ availability }) => availability === 'AVAILABLE');
    io.stdout([
      `Engine mode: ${manifest.engineMode}`,
      `Format qualification: ${manifest.formats[0].qualification}`,
      `Detector qualifications: ${[...new Set(availableDetectors.map(({ qualification }) => qualification))].join(', ')}`,
      `Formats: ${manifest.formats.map(({ id }) => id).join(', ')}`,
      `Detectors: ${String(availableDetectors.length)}`,
      `Verification profiles: ${manifest.verificationProfiles.map(({ id }) => id).join(', ')}`
    ].join('\n') + '\n');
  }
  return 0;
}

function experimentalWarning(io: CliIo): void {
  io.stderr('EXPERIMENTAL: Ollama hybrid detection is unqualified; results, spans, and confidence values may be wrong.\n');
}

async function selectedApplication(parsed: ParsedArguments, signal?: AbortSignal) {
  if (parsed.engine === 'rules') return localTextApplication;
  return createExperimentalOllamaTextApplication({
    model: parsed.model ?? '',
    ...(parsed.ollamaUrl === undefined ? {} : { endpoint: parsed.ollamaUrl }),
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
    ...(signal === undefined ? {} : { signal })
  });
}

async function runScan(input: string, parsed: ParsedArguments, io: CliIo, signal?: AbortSignal): Promise<number> {
  const selected = await selectedApplication(parsed, signal);
  const maximumInputBytes = parsed.engine === 'ollama'
    ? ollamaExperimentalDefaultLimits.maximumInputBytes
    : undefined;
  const result = await selected.scan({
    session: createLocalTextArtifactSession(input, undefined, maximumInputBytes),
    requirement: textCapabilityRequirement('SCAN', parsed.engine),
    ...(signal === undefined ? {} : { signal })
  }, { correlationId: 'cor_cli_scan' });
  const { artifact, resolution } = result;
  const report = {
    schemaVersion: '1.0.0',
    operation: 'SCAN',
    outcome: result.outcome,
    input: { displayName: artifact.displayName, mediaType: artifact.mediaType, byteLength: artifact.byteLength, digest: artifact.digest },
    detectorBundleVersion: result.detectorBundleVersion,
    counts: { detections: resolution.spans.length, conflicts: resolution.conflicts.length, byEntity: entityCounts(resolution.spans.map((span) => span.entityType)) },
    detections: resolution.spans.map((span) => ({ id: span.id, entityType: span.entityType, start: span.start, end: span.end, confidence: span.confidence, evidenceIds: span.evidenceIds })),
    conflicts: resolution.conflicts
  };
  if (parsed.engine === 'ollama') experimentalWarning(io);
  writeResult(io, parsed.json, report, `Found ${String(resolution.spans.length)} resolved detection(s) and ${String(resolution.conflicts.length)} conflict(s).`);
  return resolution.conflicts.length === 0 ? 0 : 5;
}

function validEngineSelection(parsed: ParsedArguments): boolean {
  const modelOptionsSelected = parsed.model !== undefined
    || parsed.ollamaUrl !== undefined
    || parsed.timeoutMs !== undefined
    || parsed.allowExperimental;
  if (parsed.engine === 'rules') return !modelOptionsSelected;
  const modelIsValid = parsed.model !== undefined
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(parsed.model);
  let endpointIsValid = true;
  if (parsed.ollamaUrl !== undefined) {
    try {
      assertOllamaLoopbackEndpoint(parsed.ollamaUrl);
    } catch {
      endpointIsValid = false;
    }
  }
  return parsed.allowExperimental
    && modelIsValid
    && endpointIsValid
    && (parsed.command === 'scan' || parsed.command === 'capabilities');
}

function validCommandOptions(parsed: ParsedArguments): boolean {
  if (parsed.command === 'policies') {
    const commonOptionsValid = !parsed.engineSpecified
      && parsed.output === undefined
      && parsed.selectedPolicy === undefined
      && parsed.model === undefined
      && parsed.ollamaUrl === undefined
      && parsed.timeoutMs === undefined
      && !parsed.allowExperimental
      && !parsed.apply
      && !parsed.help
      && !parsed.license;
    if (!commonOptionsValid) return false;
    if (parsed.input === 'list') return parsed.policyName === undefined;
    return parsed.input === 'explain'
      && (parsed.policyName === 'development-labels' || parsed.policyName === 'high-risk-disclosure');
  }
  if (parsed.command === 'cleanup-stages') {
    return parsed.input === undefined
      && parsed.policyName === undefined
      && parsed.output !== undefined
      && parsed.selectedPolicy === undefined
      && !parsed.engineSpecified
      && parsed.model === undefined
      && parsed.ollamaUrl === undefined
      && parsed.timeoutMs === undefined
      && !parsed.allowExperimental
      && !parsed.help
      && !parsed.license;
  }
  if (!validEngineSelection(parsed)) return false;
  if (parsed.apply) return false;
  if (parsed.command === 'redact' && parsed.output === undefined) return false;
  if (parsed.output !== undefined && parsed.command !== 'redact') return false;
  if (parsed.selectedPolicy !== undefined && parsed.command !== 'redact') return false;
  if (parsed.policyName !== undefined) return false;
  return true;
}

const stageRecoveryMinimumAgeMs = 24 * 60 * 60 * 1000;

async function runStageRecovery(
  outputPath: string,
  apply: boolean,
  json: boolean,
  io: CliIo,
  signal?: AbortSignal
): Promise<number> {
  const options = {
    outputPath,
    minimumAgeMs: stageRecoveryMinimumAgeMs,
    ...(signal === undefined ? {} : { signal })
  };
  const inventory = apply
    ? await cleanupStaleTextStages(options)
    : { ...(await inventoryTextStages(options)), deletedStageFileCount: 0, deletionFailureCount: 0 };
  const report = {
    schemaVersion: '1.0.0',
    operation: 'STAGE_RECOVERY',
    mode: apply ? 'APPLY' : 'DRY_RUN',
    minimumAgeMs: stageRecoveryMinimumAgeMs,
    ...inventory
  };
  writeResult(io, json, report, [
    `Mode: ${apply ? 'apply' : 'dry-run'}`,
    `Stale stages: ${String(inventory.staleStageFileCount)}`,
    `Deleted stages: ${String(inventory.deletedStageFileCount)}`,
    `Deletion failures: ${String(inventory.deletionFailureCount)}`,
    `Bounded scan: ${inventory.capped ? 'incomplete' : 'complete'}`
  ].join('\n'));
  return inventory.capped || inventory.deletionFailureCount > 0 ? 3 : 0;
}

async function runRedact(
  input: string,
  output: string | undefined,
  policyName: keyof typeof bundledPolicies | undefined,
  json: boolean,
  io: CliIo,
  signal?: AbortSignal
): Promise<number> {
  const policy = compilePolicy(bundledPolicies[policyName ?? 'development-labels']);
  const result = await localTextApplication.redact({
    session: createLocalTextArtifactSession(input, output, policy.limits.maximumInputBytes),
    requirement: textCapabilityRequirement('REDACT'),
    policy,
    ...(signal === undefined ? {} : { signal })
  }, { correlationId: 'cor_cli_redact' });
  const report = {
    schemaVersion: '2.0.0', operation: 'REDACT', outcome: 'VERIFIED',
    policy: policySummary(policy),
    input: { digest: result.input.digest, byteLength: result.input.byteLength },
    output: { digest: result.published.digest, byteLength: result.published.byteLength },
    plan: {
      id: result.plan.id,
      digest: result.plan.digest,
      inputDigest: result.plan.inputDigest,
      extractionRevision: result.plan.extractionRevision,
      resolutionDigest: result.plan.resolutionDigest,
      capabilityDigest: result.plan.capabilityDigest,
      policyDigest: result.policy.digest,
      detectorBundleVersion: result.plan.detectorBundleVersion,
      writer: result.plan.writer,
      strategy: result.plan.strategy,
      strategyVersion: result.plan.strategyVersion,
      actionCount: result.plan.actions.length,
      byEntity: entityCounts(result.plan.actions.map((action) => action.entityType))
    },
    writerReceipt: {
      receiptDigest: result.writerReceipt.receiptDigest,
      planDigest: result.writerReceipt.planDigest,
      outputDigest: result.writerReceipt.stagedDigest,
      writer: result.writerReceipt.writer,
      expectedActionCount: result.writerReceipt.expectedActionCount,
      appliedActionCount: result.writerReceipt.appliedActionCount
    },
    verification: result.verification
  };
  writeResult(io, json, report, `Wrote attested output under ${policy.id} ${policy.version} with ${String(result.plan.actions.length)} replacement(s).`);
  return 0;
}

async function runVerify(input: string, json: boolean, io: CliIo, signal?: AbortSignal): Promise<number> {
  const result = await localTextApplication.verify({
    session: createLocalTextArtifactSession(input),
    requirement: textCapabilityRequirement('VERIFY'),
    ...(signal === undefined ? {} : { signal })
  }, { correlationId: 'cor_cli_verify' });
  const { artifact, verification } = result;
  const report = {
    schemaVersion: '1.0.0', operation: 'VERIFY', outcome: verification.outcome,
    artifact: { digest: artifact.digest, byteLength: artifact.byteLength },
    verification
  };
  writeResult(io, json, report, verification.outcome === 'PASS'
    ? 'Residual scan passed: no deterministic residuals were found in the supplied artifact.'
    : `Residual scan failed with ${String(verification.findings.length)} blocking finding(s).`);
  return verification.outcome === 'PASS' ? 0 : 4;
}

async function runInspect(input: string, json: boolean, io: CliIo, signal?: AbortSignal): Promise<number> {
  const { artifact } = await localTextApplication.inspect({
    session: createLocalTextArtifactSession(input),
    requirement: textCapabilityRequirement('INSPECT'),
    ...(signal === undefined ? {} : { signal })
  }, { correlationId: 'cor_cli_inspect' });
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

function writeSafeError(error: SafeError, json: boolean, io: CliIo, exitCode?: number): number {
  const usesV2Envelope = error.code === 'ARTIFACT_DIGEST_MISMATCH';
  const usesV3Envelope = error.code === 'OPERATION_CANCELLED';
  const envelope = {
    schemaVersion: usesV3Envelope ? '3.0.0' : usesV2Envelope ? '2.0.0' : '1.0.0',
    error: { code: error.code, message: error.message, retryable: error.retryable, correlationId: error.correlationId, ...(error.details === undefined ? {} : { details: error.details }) }
  };
  assertContract(usesV3Envelope ? errorEnvelopeV3SchemaId : usesV2Envelope ? errorEnvelopeV2SchemaId : errorEnvelopeSchemaId, envelope);
  io.stderr(json ? `${JSON.stringify(envelope, null, 2)}\n` : `${error.code}: ${error.message}\n`);
  return exitCode ?? (error.code === 'OUTPUT_COLLISION'
    ? 6
    : error.code === 'POLICY_REVIEW_REQUIRED' || error.code === 'POLICY_BLOCKED'
      ? 5
      : error.code.startsWith('VERIFICATION_')
        || error.code === 'REDACTION_COUNT_MISMATCH'
        || error.code === 'ARTIFACT_DIGEST_MISMATCH'
        ? 4
        : error.code === 'OPERATION_CANCELLED'
          ? 130
        : 3);
}

function writeUsageError(json: boolean, io: CliIo): number {
  const error = new SafeError({
    code: 'SCHEMA_INVALID',
    message: 'The command arguments are invalid.',
    retryable: false,
    correlationId: 'cor_cli_usage'
  });
  if (json) return writeSafeError(error, true, io, 2);
  io.stderr(`${error.code}: ${error.message}\n${usage}`);
  return 2;
}

function writeCancellationError(json: boolean, io: CliIo, exitCode?: number): number {
  return writeSafeError(new SafeError({
    code: 'OPERATION_CANCELLED',
    message: 'The operation was cancelled.',
    retryable: false,
    correlationId: 'cor_cli_cancelled'
  }), json, io, exitCode);
}

function isCancellation(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function executeCli(
  argv: readonly string[],
  io: CliIo,
  options: ExecuteCliOptions = {}
): Promise<number> {
  const { signal, getCancellationExitCode } = options;
  const cancellationExitCode = (): number => getCancellationExitCode?.() ?? 130;
  const requestedJson = argv.includes('--json');
  let parsed: ParsedArguments;
  try {
    signal?.throwIfAborted();
    parsed = parseArguments(argv);
  } catch {
    if (isCancellation(signal)) return writeCancellationError(requestedJson, io, cancellationExitCode());
    return writeUsageError(requestedJson, io);
  }

  try {
    signal?.throwIfAborted();
    if (parsed.command === 'policies' && !validCommandOptions(parsed)) {
      return writeUsageError(parsed.json, io);
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
    if (parsed.help) {
      io.stdout(usage);
      return 0;
    }
    if (parsed.command === undefined) return writeUsageError(parsed.json, io);
    if (!validCommandOptions(parsed)) return writeUsageError(parsed.json, io);
    if (parsed.command === 'policies') {
      if (parsed.input === 'list') return runPolicyList(parsed.json, io);
      return runPolicyExplain(parsed.policyName as keyof typeof bundledPolicies, parsed.json, io);
    }
    if (parsed.command === 'capabilities') {
      if (parsed.input !== undefined || parsed.policyName !== undefined || parsed.output !== undefined) return writeUsageError(parsed.json, io);
      return await runCapabilities(parsed, io, signal);
    }
    if (parsed.command === 'cleanup-stages') {
      return await runStageRecovery(parsed.output as string, parsed.apply, parsed.json, io, signal);
    }
    if (parsed.input === undefined || !['scan', 'redact', 'verify', 'inspect'].includes(parsed.command)) {
      return writeUsageError(parsed.json, io);
    }
    if (parsed.command === 'scan') return await runScan(parsed.input, parsed, io, signal);
    if (parsed.command === 'redact') {
      return await runRedact(parsed.input, parsed.output, parsed.selectedPolicy, parsed.json, io, signal);
    }
    if (parsed.command === 'verify') return await runVerify(parsed.input, parsed.json, io, signal);
    return await runInspect(parsed.input, parsed.json, io, signal);
  } catch (error: unknown) {
    if (isCancellation(signal)) return writeCancellationError(parsed.json, io, cancellationExitCode());
    if (error instanceof SafeError) return writeSafeError(error, parsed.json, io);
    return writeSafeError(new SafeError({
      code: 'INTERNAL_ERROR',
      message: 'The operation failed unexpectedly.',
      retryable: false,
      correlationId: 'cor_cli_internal'
    }), parsed.json, io);
  }
}
