import { englishCatalog } from './catalogs/en.js';

export const supportedLocales = ['en', 'en-XA', 'ar-XB'] as const;

export type AppLocale = typeof supportedLocales[number];
export type TextDirection = 'ltr' | 'rtl';

export type MessageId = keyof typeof englishCatalog;

export interface MessageParameters {
  readonly 'units.mebibytes': { readonly count: string };
}

type ParameterizedMessageId = keyof MessageParameters;
export type PlainMessageId = Exclude<MessageId, ParameterizedMessageId>;

const placeholderPattern = /\{([a-zA-Z][a-zA-Z0-9]*)\}/gu;

function pseudoExpand(value: string): string {
  const accents: Readonly<Record<string, string>> = {
    a: 'àá', e: 'ëé', i: 'ïí', o: 'ôó', u: 'üú', A: 'ÀÁ', E: 'ËÉ', I: 'ÏÍ', O: 'ÔÓ', U: 'ÜÚ'
  };
  return `［${value.split(placeholderPattern).map((part, index) => {
    if (index % 2 === 1) return `{${part}}`;
    return part.replace(/[AEIOUaeiou]/gu, (character) => accents[character] ?? character);
  }).join('')}］`;
}

function pseudoRtl(value: string): string {
  return `\u2067${value.split(placeholderPattern).map((part, index) => {
    if (index % 2 === 1) return `{${part}}`;
    return part.split(' ').reverse().join(' ');
  }).join('')}\u2069`;
}

function localizedTemplate(locale: AppLocale, id: MessageId): string {
  const message = englishCatalog[id];
  if (locale === 'en-XA') return pseudoExpand(message);
  if (locale === 'ar-XB') return pseudoRtl(message);
  return message;
}

function interpolate(template: string, parameters: Readonly<Record<string, string>>): string {
  return template.replace(placeholderPattern, (_match, name: string) => {
    const value = parameters[name];
    if (value === undefined) throw new TypeError('A required translation parameter is missing.');
    return value;
  });
}

export function message(locale: AppLocale, id: PlainMessageId): string;
export function message<Id extends ParameterizedMessageId>(locale: AppLocale, id: Id, parameters: MessageParameters[Id]): string;
export function message(
  locale: AppLocale,
  id: MessageId,
  parameters: Readonly<Record<string, string>> = {}
): string {
  return interpolate(localizedTemplate(locale, id), parameters);
}

export function localeDirection(locale: AppLocale): TextDirection {
  return locale === 'ar-XB' ? 'rtl' : 'ltr';
}

export function formatInteger(locale: AppLocale, value: number): string {
  const formattingLocale = locale === 'ar-XB' ? 'ar-EG-u-nu-arab' : 'en';
  return new Intl.NumberFormat(formattingLocale, { maximumFractionDigits: 0 }).format(value);
}

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (supportedLocales as readonly string[]).includes(value);
}
