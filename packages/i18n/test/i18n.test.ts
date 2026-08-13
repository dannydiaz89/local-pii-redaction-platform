import { describe, expect, it } from 'vitest';

import {
  formatInteger,
  formatList,
  formatPercent,
  isAppLocale,
  localeDirection,
  message,
  supportedLocales
} from '../src/index.js';
import { englishCatalog } from '../src/catalogs/en.js';

describe('localization foundation', () => {
  it('exposes an English source catalog and two layout stress locales', () => {
    expect(englishCatalog['preflight.ready']).toBe('Local engine is ready');
    expect(supportedLocales).toEqual(['en', 'en-XA', 'ar-XB']);
    expect(message('en', 'preflight.ready')).toBe('Local engine is ready');
    expect(message('en-XA', 'preflight.ready')).toMatch(/^［.+］$/u);
    expect(localeDirection('ar-XB')).toBe('rtl');
  });

  it('interpolates typed parameters after pseudolocalizing the message template', () => {
    expect(message('en', 'units.mebibytes', { count: '100' })).toBe('100 MiB');
    expect(message('en-XA', 'units.mebibytes', { count: '100' })).toContain('100');
    expect(message('en', 'intake.ready', { format: 'TXT', size: '1 KiB' }))
      .toBe('TXT · 1 KiB · Ready to scan');
  });

  it('formats numbers with the active presentation locale without changing canonical values', () => {
    expect(formatInteger('en', 12_345)).toBe('12,345');
    expect(formatInteger('ar-XB', 12_345)).not.toBe('12,345');
    expect(formatPercent('en', 0.99)).toBe('99%');
    expect(formatList('en', ['pattern rule', 'checksum'])).toBe('pattern rule and checksum');
    expect(isAppLocale('fr')).toBe(false);
  });
});
