export type LocalStartupEngine = 'rules' | 'ollama';

export interface LocalStartupOptions {
  readonly engine: LocalStartupEngine;
  readonly model?: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

export const localStartupUsage = `Usage: node apps/api/dist/main.js [--engine rules|ollama --model <local-model> --allow-experimental]
  [--ollama-url http://127.0.0.1:11434] [--timeout-ms <1000-300000>]`;

/**
 * Parses the trusted local launcher's arguments. Engine selection is a server-lifecycle
 * decision: the model is prepared and digest-pinned once at startup and every job in the
 * session uses it. The experimental engine requires the same explicit consent as the CLI
 * and never applies by default.
 */
export function parseLocalStartupOptions(argv: readonly string[]): LocalStartupOptions {
  let engine: LocalStartupEngine = 'rules';
  let model: string | undefined;
  let endpoint: string | undefined;
  let timeoutMs: number | undefined;
  let allowExperimental = false;
  const valueAfter = (index: number, option: string): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) throw new TypeError(`${option} requires a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--allow-experimental') {
      allowExperimental = true;
    } else if (value === '--engine') {
      const selected = valueAfter(index, value);
      if (selected !== 'rules' && selected !== 'ollama') throw new TypeError('--engine must be rules or ollama.');
      engine = selected;
      index += 1;
    } else if (value === '--model') {
      if (model !== undefined) throw new TypeError('--model was supplied more than once.');
      model = valueAfter(index, value);
      index += 1;
    } else if (value === '--ollama-url') {
      if (endpoint !== undefined) throw new TypeError('--ollama-url was supplied more than once.');
      endpoint = valueAfter(index, value);
      index += 1;
    } else if (value === '--timeout-ms') {
      const parsed = Number(valueAfter(index, value));
      if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 300_000) {
        throw new TypeError('--timeout-ms must be an integer between 1000 and 300000.');
      }
      timeoutMs = parsed;
      index += 1;
    } else {
      throw new TypeError(`Unknown option: ${value ?? ''}`);
    }
  }
  if (engine === 'rules') {
    if (model !== undefined || endpoint !== undefined || timeoutMs !== undefined || allowExperimental) {
      throw new TypeError('Model options require --engine ollama.');
    }
    return { engine };
  }
  if (model === undefined) throw new TypeError('--engine ollama requires --model.');
  if (!allowExperimental) throw new TypeError('--engine ollama requires --allow-experimental.');
  return {
    engine,
    model,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  };
}
