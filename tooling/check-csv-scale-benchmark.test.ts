import { describe, expect, it } from 'vitest';

import {
  classifyRun,
  formatCurvePoint,
  formatObservation,
  parsePeakRssKiB,
  readPathVerdict,
  resourceArgs,
  selectResourceProbe
} from './check-csv-scale-benchmark.js';
import { csvScaleCeilings, csvScaleRow, projectCsvScale, type CsvScaleSpec } from './csv-scale-corpus.js';

const bsdReport = [
  '        0.29 real         0.27 user         0.06 sys',
  '           273661952  maximum resident set size',
  '                   0  average shared memory size'
].join('\n');

const wide: CsvScaleSpec = { label: 'wide', rows: 20_000, columns: 5, piiEveryRows: 4 };
const narrow: CsvScaleSpec = { label: 'narrow', rows: 100_000, columns: 1, piiEveryRows: 16 };

describe('CSV scale resource probing', () => {
  it('reads GNU kibibytes and BSD bytes into one kibibyte unit', () => {
    expect(parsePeakRssKiB('GNU', '273156\n')).toBe(273156);
    expect(parsePeakRssKiB('BSD', bsdReport)).toBe(267248);
    for (const invalid of ['', 'maximum resident set size', '  x  maximum resident set size']) {
      expect(() => parsePeakRssKiB('BSD', invalid)).toThrow(TypeError);
    }
  });

  it('selects an accounting flavor per platform and degrades honestly without one', () => {
    expect(selectResourceProbe('linux', true)).toEqual({ kind: 'GNU', path: '/usr/bin/time' });
    expect(selectResourceProbe('darwin', true)).toEqual({ kind: 'BSD', path: '/usr/bin/time' });
    expect(selectResourceProbe('darwin', false).kind).toBe('UNAVAILABLE');
    expect(selectResourceProbe('win32', true).kind).toBe('UNAVAILABLE');
    expect(resourceArgs(selectResourceProbe('linux', true), '/m')).toEqual(['/usr/bin/time', '-q', '-f', '%M', '-o', '/m']);
    expect(resourceArgs(selectResourceProbe('darwin', true), '/m')).toEqual(['/usr/bin/time', '-l', '-o', '/m']);
    expect(resourceArgs(selectResourceProbe('win32', true), '/m')).toEqual([]);
  });
});

describe('CSV scale run classification', () => {
  const succeeded = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });

  it('reads detection counts from scan and action counts from redact', () => {
    expect(classifyRun('scan', succeeded(JSON.stringify({ operation: 'SCAN', outcome: 'SUCCEEDED', counts: { detections: 5000 } }))))
      .toEqual({ kind: 'SUCCEEDED', detections: 5000, outputByteLength: undefined });
    expect(classifyRun('redact', succeeded(JSON.stringify({
      operation: 'REDACT', outcome: 'VERIFIED', plan: { actionCount: 5000 }, output: { byteLength: 998893 }
    })))).toEqual({ kind: 'SUCCEEDED', detections: 5000, outputByteLength: 998893 });
  });

  it('reads the safe-error code from a processing failure', () => {
    expect(classifyRun('scan', {
      exitCode: 3,
      stdout: '',
      stderr: JSON.stringify({ schemaVersion: '1.0.0', error: { code: 'FORMAT_CORRUPT' } })
    })).toEqual({ kind: 'REJECTED', code: 'FORMAT_CORRUPT' });
  });

  it('rejects incoherent, mislabeled, or unexpectedly failing runs', () => {
    expect(() => classifyRun('scan', succeeded('not json'))).toThrow();
    expect(() => classifyRun('scan', succeeded(JSON.stringify({ operation: 'REDACT', outcome: 'VERIFIED' })))).toThrow();
    expect(() => classifyRun('scan', { exitCode: 0, stdout: '{}', stderr: 'warning' })).toThrow();
    expect(() => classifyRun('scan', { exitCode: 1, stdout: '', stderr: '{}' })).toThrow();
    expect(() => classifyRun('scan', { exitCode: 3, stdout: '', stderr: JSON.stringify({ error: {} }) })).toThrow();
  });
});

describe('CSV scale corpus projection', () => {
  it('generates seeded rows that are byte-identical across calls and prefix-stable across sizes', () => {
    expect(csvScaleRow(wide, 0)).toBe(csvScaleRow(wide, 0));
    expect(csvScaleRow(wide, 7)).toBe(csvScaleRow({ ...wide, rows: 1_000_000 }, 7));
    expect(csvScaleRow(wide, 0).split(',')).toHaveLength(5);
    expect(csvScaleRow(wide, 0)).toContain('case0@example.test');
    expect(csvScaleRow(wide, 1)).not.toContain('@');
    expect(csvScaleRow(narrow, 0)).toBe('case0@example.test\n');
    expect(csvScaleRow(narrow, 16)).toBe('case16@example.test\n');
  });

  it('predicts the first ceiling each shape reaches', () => {
    expect(projectCsvScale(wide)).toEqual({ cells: 100_000, detections: 5_000, expectation: { kind: 'SUCCEEDED' } });
    expect(projectCsvScale(narrow)).toEqual({ cells: 100_000, detections: 6_250, expectation: { kind: 'SUCCEEDED' } });
    expect(projectCsvScale({ ...wide, rows: 1_000_000 }).expectation).toEqual({ kind: 'REJECTED', code: 'INPUT_TOO_LARGE' });
    expect(projectCsvScale({ ...wide, piiEveryRows: 1 }).expectation).toEqual({ kind: 'REJECTED', code: 'DETECTION_LIMIT_EXCEEDED' });
    expect(csvScaleCeilings.maximumCells).toBe(100_000);
    for (const invalid of [{ ...wide, rows: 0 }, { ...wide, piiEveryRows: 0 }, { ...wide, label: '' }]) {
      expect(() => projectCsvScale(invalid)).toThrow(TypeError);
    }
  });
});

describe('CSV scale reporting', () => {
  it('reports wall time and states plainly when peak RSS was not measured', () => {
    const facts = { rows: 20_000, columns: 5, cells: 100_000, byteLength: 1_047_222, outcome: 'SUCCEEDED detections=5000' };
    const wall = { minimum: 440, median: 460, maximum: 470 };
    expect(formatObservation('wide-20k', 'scan', facts, wall, { minimum: 1, median: 2, maximum: 3 }))
      .toContain('RSS KiB min=1 median=2 max=3');
    expect(formatObservation('wide-20k', 'scan', facts, wall, undefined)).toContain('RSS KiB unavailable');
    expect(formatObservation('wide-20k', 'scan', facts, wall, undefined)).toContain('wall ms min=440 median=460 max=470');
  });

  it('charges peak-RSS growth between two equal-parse runs to the whole-file read', () => {
    const small = { label: 'a', operation: 'scan' as const, rows: 100_000, byteLength: 5 * 1024 * 1024, detections: 0, medianRssKiB: 177_248 };
    const large = { label: 'b', operation: 'scan' as const, rows: 1_000_000, byteLength: 50 * 1024 * 1024, detections: 0, medianRssKiB: 267_248 };
    expect(readPathVerdict(small, large)).toEqual({ bounded: false, kiBPerInputMiB: 2000 });
    expect(readPathVerdict(small, { ...large, medianRssKiB: 178_248 })).toEqual({ bounded: true, kiBPerInputMiB: 22 });
    expect(() => readPathVerdict(large, small)).toThrow(TypeError);
    expect(formatCurvePoint(large, 74_512)).toContain('RSS KiB above baseline=192736');
    expect(formatCurvePoint(large, 74_512)).toContain('KiB per detection=n/a');
    expect(formatCurvePoint({ ...large, detections: 5_000 }, 74_512)).toContain('KiB per detection=39');
  });
});
