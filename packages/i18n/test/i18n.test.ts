import { describe, expect, it } from 'vitest';

import {
  formatInteger,
  isAppLocale,
  localeDirection,
  message,
  supportedLocales
} from '../src/index.js';

describe('localization foundation', () => {
  it('exposes an English source catalog and two layout stress locales', () => {
    expect(supportedLocales).toEqual(['en', 'en-XA', 'ar-XB']);
    expect(message('en', 'preflight.ready')).toBe('Local engine is ready');
    expect(message('en-XA', 'preflight.ready')).toMatch(/^［.+］$/u);
    expect(localeDirection('ar-XB')).toBe('rtl');
  });

  it('interpolates typed parameters after pseudolocalizing the message template', () => {
    expect(message('en', 'units.mebibytes', { count: '100' })).toBe('100 MiB');
    expect(message('en-XA', 'units.mebibytes', { count: '100' })).toContain('100');
  });

  it('formats numbers with the active presentation locale without changing canonical values', () => {
    expect(formatInteger('en', 12_345)).toBe('12,345');
    expect(formatInteger('ar-XB', 12_345)).not.toBe('12,345');
    expect(isAppLocale('fr')).toBe(false);
  });
});
