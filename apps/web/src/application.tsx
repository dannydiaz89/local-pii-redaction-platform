import { useEffect, useMemo, useRef, useState } from 'react';

import {
  formatInteger,
  localeDirection,
  message,
  type AppLocale,
  type PlainMessageId
} from '@local-pii/i18n';
import { Button, Callout, Card, FileField, Metric, StatusBadge } from '@local-pii/ui';

import type { CapabilityClient, CapabilitySummary, LocalEngineMode } from './api.js';
import { preflightSelectedFile, type FilePreflightResult } from './file-preflight.js';
import type {
  LocalJobClient,
  PolicyCatalogSummary,
  PreviewEntityType,
  PreviewScanSummary
} from './job-api.js';
import { webPreviewMaximumInputBytes } from './preview-limit.js';

type PreflightState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly summary: CapabilitySummary; readonly policyCatalog: PolicyCatalogSummary }
  | { readonly kind: 'disconnected' }
  | { readonly kind: 'unavailable' };

export interface WebApplicationProps {
  readonly capabilityClient: CapabilityClient;
  readonly jobClient: LocalJobClient;
  readonly initialLocale?: AppLocale;
}

type PreviewState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'scanning' }
  | { readonly kind: 'complete'; readonly summary: PreviewScanSummary }
  | { readonly kind: 'failed' };

function engineModeMessage(mode: LocalEngineMode): PlainMessageId {
  if (mode === 'LOCAL_HYBRID') return 'capability.localHybrid';
  return 'capability.rulesOnly';
}

function policyMessage(policyId: string): PlainMessageId {
  if (policyId === 'development-labels') return 'policy.developmentLabels';
  if (policyId === 'high-risk-disclosure') return 'policy.highRiskDisclosure';
  return 'policy.configured';
}

function entityMessage(entityType: PreviewEntityType): PlainMessageId {
  const messages: Partial<Record<PreviewEntityType, PlainMessageId>> = {
    EMAIL: 'entity.email', PHONE: 'entity.phone', SSN: 'entity.ssn', CREDIT_CARD: 'entity.creditCard',
    IP_ADDRESS: 'entity.ipAddress', API_KEY: 'entity.apiKey', ACCESS_TOKEN: 'entity.accessToken',
    PASSWORD: 'entity.password'
  };
  return messages[entityType] ?? 'entity.other';
}

function formatByteSize(locale: AppLocale, byteLength: number): string {
  const mebibyte = 1024 * 1024;
  if (byteLength >= mebibyte && byteLength % mebibyte === 0) {
    return message(locale, 'units.mebibytes', { count: formatInteger(locale, byteLength / mebibyte) });
  }
  if (byteLength >= 1024 && byteLength % 1024 === 0) {
    return message(locale, 'units.kibibytes', { count: formatInteger(locale, byteLength / 1024) });
  }
  return message(locale, 'units.bytes', { count: formatInteger(locale, byteLength) });
}

export function WebApplication({ capabilityClient, jobClient, initialLocale = 'en' }: WebApplicationProps) {
  const locale = initialLocale;
  const [attempt, setAttempt] = useState(0);
  const [preflight, setPreflight] = useState<PreflightState>({ kind: 'checking' });
  const [filePreflight, setFilePreflight] = useState<FilePreflightResult>({ kind: 'none' });
  const [selectedFile, setSelectedFile] = useState<File>();
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });
  const previewController = useRef<AbortController | undefined>(undefined);
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
    setFilePreflight({ kind: 'none' });
    setSelectedFile(undefined);
    setPreview({ kind: 'idle' });
    previewController.current?.abort();
    void Promise.all([
      capabilityClient.load(controller.signal),
      jobClient.loadPolicies(controller.signal)
    ]).then(
      ([summary, policyCatalog]) => {
        if (!controller.signal.aborted) setPreflight({ kind: 'ready', summary, policyCatalog });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const kind = error instanceof Error && error.message === 'LOCAL_SESSION_MISSING'
          ? 'disconnected'
          : 'unavailable';
        setPreflight({ kind });
      }
    );
    return () => { controller.abort(); };
  }, [attempt, capabilityClient, jobClient]);

  useEffect(() => () => { previewController.current?.abort(); }, []);

  const status = preflight.kind === 'ready'
    ? t('preflight.ready')
    : preflight.kind === 'checking'
      ? t('preflight.checking')
      : preflight.kind === 'disconnected'
        ? t('preflight.disconnected')
        : t('preflight.unavailable');
  const supportedExtensions = preflight.kind === 'ready'
    ? preflight.summary.supportedFiles.map(({ extension }) => extension)
    : [];
  const previewCapabilities = preflight.kind === 'ready'
    ? {
      supportedFiles: preflight.summary.supportedFiles.map((format) => ({
        ...format,
        maximumInputBytes: Math.min(format.maximumInputBytes, webPreviewMaximumInputBytes)
      }))
    }
    : { supportedFiles: [] };
  const maximumPreviewBytes = Math.min(
    preflight.kind === 'ready' ? preflight.summary.maximumInputBytes : webPreviewMaximumInputBytes,
    webPreviewMaximumInputBytes
  );
  const intakeMessage = filePreflight.kind === 'ready'
    ? message(locale, 'intake.ready', {
      format: filePreflight.extension.slice(1).toUpperCase(),
      size: formatByteSize(locale, filePreflight.byteLength)
    })
    : filePreflight.kind === 'too-large'
      ? message(locale, 'intake.tooLarge', { limit: formatByteSize(locale, filePreflight.maximumInputBytes) })
      : filePreflight.kind === 'unsupported'
        ? t('intake.unsupported')
        : t('intake.none');

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">{t('nav.skip')}</a>
      <header className="app-header">
        <a className="brand" href="#main" aria-label={t('app.name')}>
          <span className="brand-mark" aria-hidden="true">L</span>
          <span>{t('app.name')}</span>
        </a>
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
                      label={t('policy.default')}
                      value={t(policyMessage(preflight.policyCatalog.defaultPolicy.id))}
                    />
                    <Metric
                      label={t('capability.inputLimit')}
                      value={message(locale, 'units.mebibytes', {
                        count: formatInteger(locale, Math.floor(maximumPreviewBytes / 1024 / 1024))
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

          <Card aria-labelledby="intake-title" className="intake-card">
            <div className="card-heading">
              <div>
                <p className="section-number" aria-hidden="true">02</p>
                <h2 id="intake-title">{t('intake.title')}</h2>
              </div>
              <StatusBadge tone={preflight.kind === 'ready' ? 'positive' : 'warning'}>
                {preflight.kind === 'ready' ? t('status.available') : t('status.waiting')}
              </StatusBadge>
            </div>
            <p className="muted">{t('intake.body')}</p>
            {preflight.kind === 'ready' ? (
              <FileField
                id="document-file"
                label={t('intake.label')}
                hint={message(locale, 'intake.hint', {
                  extensions: supportedExtensions.join(', '),
                  limit: formatByteSize(locale, maximumPreviewBytes)
                })}
                accept={supportedExtensions.join(',')}
                onChange={(event) => {
                  previewController.current?.abort();
                  const selected = event.currentTarget.files?.length === 1
                    ? event.currentTarget.files[0]
                    : undefined;
                  const result = preflightSelectedFile(selected, previewCapabilities);
                  setFilePreflight(result);
                  setSelectedFile(result.kind === 'ready' ? selected : undefined);
                  setPreview({ kind: 'idle' });
                }}
              />
            ) : (
              <Callout>{t('intake.waiting')}</Callout>
            )}
            {preflight.kind === 'ready' ? (
              <div
                className="intake-result"
                role={filePreflight.kind === 'unsupported' || filePreflight.kind === 'too-large' ? 'alert' : 'status'}
                aria-live="polite"
              >
                <Callout tone={filePreflight.kind === 'ready'
                  ? 'positive'
                  : filePreflight.kind === 'unsupported' || filePreflight.kind === 'too-large'
                    ? 'critical'
                    : 'neutral'}>{intakeMessage}</Callout>
              </div>
            ) : null}
            {selectedFile !== undefined && filePreflight.kind === 'ready' ? (
              <Button
                disabled={preview.kind === 'scanning'}
                onClick={() => {
                  const controller = new AbortController();
                  previewController.current?.abort();
                  previewController.current = controller;
                  setPreview({ kind: 'scanning' });
                  void jobClient.scanPreview(selectedFile, controller.signal).then(
                    (summary) => {
                      if (!controller.signal.aborted) setPreview({ kind: 'complete', summary });
                    },
                    () => {
                      if (!controller.signal.aborted) setPreview({ kind: 'failed' });
                    }
                  );
                }}
              >{preview.kind === 'scanning' ? t('preview.scanning') : t('preview.scan')}</Button>
            ) : null}
            {preview.kind !== 'idle' ? (
              <div role={preview.kind === 'failed' ? 'alert' : 'status'} aria-live="polite">
                {preview.kind === 'scanning' ? (
                  <Callout>{t('preview.scanning')}</Callout>
                ) : preview.kind === 'failed' ? (
                  <Callout tone="critical">{t('preview.failed')}</Callout>
                ) : (
                  <Callout tone={preview.summary.conflicts === 0 ? 'positive' : 'critical'}>
                    <p>{preview.summary.detections === 0
                      ? t('preview.clean')
                      : preview.summary.detections === 1
                        ? t('preview.completeOne')
                        : message(locale, 'preview.complete', {
                          count: formatInteger(locale, preview.summary.detections)
                        })}</p>
                    {preview.summary.conflicts > 0 ? (
                      <p>{message(locale, 'preview.conflicts', {
                        count: formatInteger(locale, preview.summary.conflicts)
                      })}</p>
                    ) : null}
                    {Object.keys(preview.summary.byEntity).length > 0 ? (
                      <div>
                        <h3>{t('preview.categories')}</h3>
                        <ul className="preview-categories">
                          {Object.entries(preview.summary.byEntity).map(([entityType, count]) => (
                            <li key={entityType}>
                              <span>{t(entityMessage(entityType as PreviewEntityType))}</span>
                              <strong>{formatInteger(locale, count)}</strong>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </Callout>
                )}
              </div>
            ) : null}
            <p className="intake-privacy">{t('intake.privacy')}</p>
            <p className="coming-soon">{t('intake.next')}</p>
          </Card>
        </div>
      </main>
    </div>
  );
}
