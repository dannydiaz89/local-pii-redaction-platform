import { describe, expect, it } from 'vitest';

import { parseLocalStartupOptions } from '../src/startup-options.js';

describe('local startup options', () => {
  it('defaults to the rules engine with no arguments', () => {
    expect(parseLocalStartupOptions([])).toEqual({ engine: 'rules' });
  });

  it('requires explicit experimental consent and a model for the hybrid engine', () => {
    expect(parseLocalStartupOptions(['--engine', 'ollama', '--model', 'phi4-mini:3.8b', '--allow-experimental']))
      .toEqual({ engine: 'ollama', model: 'phi4-mini:3.8b' });
    expect(parseLocalStartupOptions([
      '--engine', 'ollama', '--model', 'phi4-mini:3.8b', '--allow-experimental',
      '--ollama-url', 'http://127.0.0.1:11434', '--timeout-ms', '5000'
    ])).toEqual({ engine: 'ollama', model: 'phi4-mini:3.8b', endpoint: 'http://127.0.0.1:11434', timeoutMs: 5000 });
    expect(() => parseLocalStartupOptions(['--engine', 'ollama', '--model', 'phi4-mini:3.8b'])).toThrow(TypeError);
    expect(() => parseLocalStartupOptions(['--engine', 'ollama', '--allow-experimental'])).toThrow(TypeError);
  });

  it('rejects model options, unknown options, and out-of-range timeouts for the rules engine', () => {
    for (const argv of [
      ['--model', 'phi4-mini:3.8b'],
      ['--allow-experimental'],
      ['--ollama-url', 'http://127.0.0.1:11434'],
      ['--engine', 'gpu'],
      ['--engine'],
      ['--unknown'],
      ['--engine', 'ollama', '--model', 'm', '--allow-experimental', '--timeout-ms', '10'],
      ['--engine', 'ollama', '--model', 'm', '--model', 'n', '--allow-experimental']
    ]) {
      expect(() => parseLocalStartupOptions(argv), argv.join(' ')).toThrow(TypeError);
    }
  });
});
