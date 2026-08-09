import { useEffect, useMemo, useState } from 'react';

import {
  formatInteger,
  isAppLocale,
  localeDirection,
  message,
  type AppLocale,
  type PlainMessageId
} from '@local-pii/i18n';
import { Button, Callout, Card, Metric, SelectField, StatusBadge } from '@local-pii/ui';

import type { CapabilityClient, CapabilitySummary, LocalEngineMode } from './api.js';

type PreflightState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly summary: CapabilitySummary }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'unavailable' };

export interface WebApplicationProps {
  readonly capabilityClient: CapabilityClient;
  readonly initialLocale?: AppLocale;
}

function engineModeMessage(mode: LocalEngineMode): PlainMessageId {
  if (mode === 'LOCAL_HYBRID') return 'capability.localHybrid';
  return 'capability.rulesOnly';
}

function localeLabel(locale: AppLocale, option: AppLocale): string {
  if (option === 'en-XA') return message(locale, 'locale.expanded');
  if (option === 'ar-XB') return message(locale, 'locale.rtl');
  return message(locale, 'locale.en');
}

export function WebApplication({ capabilityClient, initialLocale = 'en' }: WebApplicationProps) {
  const [locale, setLocale] = useState<AppLocale>(initialLocale);
  const [attempt, setAttempt] = useState(0);
  const [preflight, setPreflight] = useState<PreflightState>({ kind: 'checking' });
  const direction = localeDirection(locale);
  const t = useMemo(() => (id: PlainMessageId) => message(locale, id), [locale]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;
    document.title = message(locale, 'app.name');
  }, [direction, locale]);

  useEffect(() => {
    const controller = new AbortController();
    setPreflight({ kind: 'checking' });
    void capabilityClient.load(controller.signal).then(
      (summary) => { if (!controller.signal.aborted) setPreflight({ kind: 'ready', summary }); },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const kind = error instanceof Error && error.message === 'LOCAL_SESSION_MISSING'
          ? 'disconnected'
          : 'unavailable';
        setPreflight({ kind });
      }
    );
    return () => { controller.abort(); };
  }, [attempt, capabilityClient]);

  const status = preflight.kind === 'ready'
    ? t('preflight.ready')
    : preflight.kind === 'checking'
      ? t('preflight.checking')
      : preflight.kind === 'disconnected'
        ? t('preflight.disconnected')
        : t('preflight.unavailable');

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">{t('nav.skip')}</a>
      <header className="app-header">
        <a className="brand" href="#main" aria-label={t('app.name')}>
          <span className="brand-mark" aria-hidden="true">L</span>
          <span>{t('app.name')}</span>
        </a>
        <SelectField
          id="interface-locale"
          label={t('locale.label')}
          value={locale}
          onChange={(event) => { if (isAppLocale(event.target.value)) setLocale(event.target.value); }}
        >
          {(['en', 'en-XA', 'ar-XB'] as const).map((option) => (
            <option key={option} value={option}>{localeLabel(locale, option)}</option>
          ))}
        </SelectField>
      </header>

      <main id="main" className="app-main">
        <section className="hero" aria-labelledby="privacy-title">
          <div>
            <p className="eyebrow">{t('privacy.eyebrow')}</p>
            <h1 id="privacy-title">{t('privacy.title')}</h1>
            <p className="hero-copy">{t('privacy.body')}</p>
          </div>
          <ul className="privacy-list" aria-label={t('privacy.eyebrow')}>
            <li><span aria-hidden="true">✓</span>{t('privacy.network')}</li>
            <li><span aria-hidden="true">✓</span>{t('privacy.storage')}</li>
          </ul>
        </section>

        <div className="workspace-grid">
          <Card aria-labelledby="preflight-title">
            <div className="card-heading">
              <div>
                <p className="section-number" aria-hidden="true">01</p>
                <h2 id="preflight-title">{t('preflight.title')}</h2>
              </div>
              <StatusBadge tone={preflight.kind === 'ready' ? 'positive' : 'warning'}>{status}</StatusBadge>
            </div>
            <p className="muted">{t('preflight.body')}</p>

            <div role={preflight.kind === 'unavailable' ? 'alert' : 'status'} aria-live="polite">
              {preflight.kind === 'ready' ? (
                <>
                  <dl className="metrics">
                    <Metric label={t('capability.mode')} value={t(engineModeMessage(preflight.summary.engineMode))} />
                    <Metric label={t('capability.formats')} value={formatInteger(locale, preflight.summary.formatCount)} />
                    <Metric label={t('capability.detectors')} value={formatInteger(locale, preflight.summary.availableDetectorCount)} />
                    <Metric
                      label={t('capability.inputLimit')}
                      value={message(locale, 'units.mebibytes', {
                        count: formatInteger(locale, Math.floor(preflight.summary.maximumInputBytes / 1024 / 1024))
                      })}
                    />
                  </dl>
                  <Callout tone="positive">{t('preflight.connectedHint')}</Callout>
                </>
              ) : preflight.kind === 'checking' ? (
                <div className="checking-line"><span className="activity-dot" aria-hidden="true" />{status}</div>
              ) : (
                <Callout tone={preflight.kind === 'unavailable' ? 'critical' : 'neutral'}>
                  <p>{preflight.kind === 'disconnected' ? t('preflight.disconnectedHint') : status}</p>
                  <Button onClick={() => { setAttempt((value) => value + 1); }}>{t('preflight.retry')}</Button>
                </Callout>
              )}
            </div>
          </Card>

          <Card aria-labelledby="workflow-title" className="workflow-card">
            <div className="card-heading">
              <div>
                <p className="section-number" aria-hidden="true">02</p>
                <h2 id="workflow-title">{t('workflow.title')}</h2>
              </div>
              <StatusBadge>{t('status.planned')}</StatusBadge>
            </div>
            <ol className="workflow-list">
              <li><span>1</span>{t('workflow.stepOne')}</li>
              <li><span>2</span>{t('workflow.stepTwo')}</li>
              <li><span>3</span>{t('workflow.stepThree')}</li>
            </ol>
            <p className="coming-soon">{t('workflow.comingSoon')}</p>
          </Card>
        </div>
      </main>
    </div>
  );
}
