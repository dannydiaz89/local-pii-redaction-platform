import { useEffect, useMemo, useRef, useState } from 'react';

import {
  formatInteger,
  formatList,
  formatPercent,
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
  JobEventType,
  PolicyCatalogSummary,
  PreviewDetectionSource,
  PreviewEntityType,
  ProcessingScanSummary,
  ScanProgressState
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

type ScanState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'scanning'; readonly progress: ScanProgressState }
  | {
    readonly kind: 'complete';
    readonly summary: ProcessingScanSummary;
    readonly pageHistory: readonly number[];
    readonly loadingPage: boolean;
  }
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

function sourceMessage(source: PreviewDetectionSource): PlainMessageId {
  const messages: Record<PreviewDetectionSource, PlainMessageId> = {
    REGEX: 'source.regex',
    CHECKSUM: 'source.checksum',
    STRUCTURED: 'source.structured',
    DICTIONARY: 'source.dictionary',
    MODEL: 'source.model',
    MANUAL: 'source.manual'
  };
  return messages[source];
}

function jobStateMessage(state: ScanProgressState): PlainMessageId {
  const messages: Partial<Record<ScanProgressState, PlainMessageId>> = {
    UPLOADING: 'job.state.uploading',
    QUEUED: 'job.state.queued',
    VALIDATING: 'job.state.validating',
    EXTRACTING: 'job.state.extracting',
    DETECTING: 'job.state.detecting',
    RESOLVING: 'job.state.resolving',
    NEEDS_REVIEW: 'job.state.review',
    SUCCEEDED: 'job.state.complete',
    CANCELLING: 'job.state.cancelling',
    CANCELLED: 'job.state.cancelled',
    FAILED: 'job.state.failed'
  };
  return messages[state] ?? 'job.state.failed';
}

function jobEventMessage(type: JobEventType): PlainMessageId {
  const messages: Record<JobEventType, PlainMessageId> = {
    JOB_CREATED: 'job.event.created',
    STATE_CHANGED: 'job.event.stateChanged',
    REVIEW_REQUIRED: 'job.event.reviewRequired',
    JOB_COMPLETED: 'job.event.completed',
    JOB_FAILED: 'job.event.failed',
    CANCELLATION_REQUESTED: 'job.event.cancellationRequested'
  };
  return messages[type];
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
  const [scan, setScan] = useState<ScanState>({ kind: 'idle' });
  const [detectionFilter, setDetectionFilter] = useState<PreviewEntityType | 'ALL'>('ALL');
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
    setScan({ kind: 'idle' });
    setDetectionFilter('ALL');
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
  const defaultPolicy = preflight.kind === 'ready' ? preflight.policyCatalog.defaultPolicy : undefined;
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
  const detailCategories = scan.kind === 'complete'
    ? [...new Set(Object.keys(scan.summary.byEntity) as PreviewEntityType[])].sort()
    : [];
  const visibleDetails = scan.kind === 'complete'
    ? scan.summary.details.filter(({ entityType }) => detectionFilter === 'ALL' || entityType === detectionFilter)
    : [];

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

        <div className={`workspace-grid${scan.kind === 'complete' ? ' has-results' : ''}`}>
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
                  setScan({ kind: 'idle' });
                  setDetectionFilter('ALL');
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
            {selectedFile !== undefined && filePreflight.kind === 'ready' && defaultPolicy !== undefined ? (
              <Button
                disabled={scan.kind === 'scanning'}
                onClick={() => {
                  const controller = new AbortController();
                  previewController.current?.abort();
                  previewController.current = controller;
                  setScan({ kind: 'scanning', progress: 'UPLOADING' });
                  void jobClient.scan(
                    selectedFile,
                    defaultPolicy,
                    (progress) => {
                      if (!controller.signal.aborted) setScan({ kind: 'scanning', progress });
                    },
                    controller.signal
                  ).then(
                    (summary) => {
                      if (!controller.signal.aborted) {
                        setScan({ kind: 'complete', summary, pageHistory: [], loadingPage: false });
                        setDetectionFilter('ALL');
                      }
                    },
                    () => {
                      if (!controller.signal.aborted) setScan({ kind: 'failed' });
                    }
                  );
                }}
              >{scan.kind === 'scanning' ? t('preview.scanning') : t('preview.scan')}</Button>
            ) : null}
            {scan.kind !== 'idle' ? (
              <div role={scan.kind === 'failed' ? 'alert' : 'status'} aria-live="polite">
                {scan.kind === 'scanning' ? (
                  <Callout>{message(locale, 'job.progress', { state: t(jobStateMessage(scan.progress)) })}</Callout>
                ) : scan.kind === 'failed' ? (
                  <Callout tone="critical">{t('preview.failed')}</Callout>
                ) : (
                  <Callout tone={scan.summary.conflicts === 0 ? 'positive' : 'critical'}>
                    <div className="job-status-line">
                      <StatusBadge tone={scan.summary.conflicts === 0 ? 'positive' : 'warning'}>
                        {t(jobStateMessage(scan.summary.job.state))}
                      </StatusBadge>
                      <span>{message(locale, 'job.events', {
                        count: formatInteger(locale, scan.summary.events.length)
                      })}</span>
                    </div>
                    <details className="job-activity">
                      <summary>{t('job.activity')}</summary>
                      <ol>
                        {scan.summary.events.map((event) => (
                          <li key={event.id}>{t(jobEventMessage(event.type))}</li>
                        ))}
                      </ol>
                    </details>
                    <p>{scan.summary.detections === 0
                      ? t('preview.clean')
                      : scan.summary.detections === 1
                        ? t('preview.completeOne')
                        : message(locale, 'preview.complete', {
                          count: formatInteger(locale, scan.summary.detections)
                        })}</p>
                    {scan.summary.conflicts > 0 ? (
                      <p>{message(locale, 'preview.conflicts', {
                        count: formatInteger(locale, scan.summary.conflicts)
                      })}</p>
                    ) : null}
                    {Object.keys(scan.summary.byEntity).length > 0 ? (
                      <div>
                        <h3>{t('preview.categories')}</h3>
                        <ul className="preview-categories">
                          {Object.entries(scan.summary.byEntity).map(([entityType, count]) => (
                            <li key={entityType}>
                              <span>{t(entityMessage(entityType as PreviewEntityType))}</span>
                              <strong>{formatInteger(locale, count)}</strong>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {scan.summary.conflictDetails.length > 0 ? (
                      <div className="preview-conflicts">
                        <h3>{t('preview.conflictDetails')}</h3>
                        <p className="preview-conflict-warning">{t('preview.conflictUndecided')}</p>
                        <div className="preview-table-scroll" role="region" tabIndex={0} aria-label={t('preview.conflictDetails')}>
                          <table className="preview-table">
                            <thead>
                              <tr>
                                <th scope="col">{t('preview.columnLocation')}</th>
                                <th scope="col">{t('preview.columnCategory')}</th>
                                <th scope="col">{t('preview.columnSources')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {scan.summary.conflictDetails.map((conflict) => (
                                <tr key={`${String(conflict.start)}:${String(conflict.end)}:${conflict.entityTypes.join(':')}`}>
                                  <th scope="row">{message(locale, 'preview.conflictLocation', {
                                    start: formatInteger(locale, conflict.start + 1),
                                    end: formatInteger(locale, conflict.end)
                                  })}</th>
                                  <td>{message(locale, 'preview.conflictTypes', {
                                    types: formatList(locale, conflict.entityTypes.map((entityType) =>
                                      t(entityMessage(entityType))))
                                  })}</td>
                                  <td>{message(locale, 'preview.conflictSources', {
                                    sources: formatList(locale, conflict.sources.map((source) => t(sourceMessage(source))))
                                  })}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {scan.summary.conflictDetailsLimited ? (
                          <p>{message(locale, 'preview.conflictsLimited', {
                            count: formatInteger(locale, scan.summary.conflictDetails.length)
                          })}</p>
                        ) : null}
                      </div>
                    ) : null}
                    {scan.summary.details.length > 0 ? (
                      <div className="preview-review">
                        <div className="preview-review-heading">
                          <h3 id="preview-details-heading">{t('preview.details')}</h3>
                          <div className="preview-filter">
                            <label htmlFor="detection-filter">{t('preview.filter')}</label>
                            <select
                              id="detection-filter"
                              value={detectionFilter}
                              onChange={(event) => {
                                const next = event.currentTarget.value;
                                if (next === 'ALL' || detailCategories.includes(next as PreviewEntityType)) {
                                  setDetectionFilter(next as PreviewEntityType | 'ALL');
                                }
                              }}
                            >
                              <option value="ALL">{t('preview.filterAll')}</option>
                              {detailCategories.map((entityType) => (
                                <option key={entityType} value={entityType}>{t(entityMessage(entityType))}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div
                          className="preview-table-scroll"
                          role="region"
                          tabIndex={0}
                          aria-labelledby="preview-details-heading"
                        >
                          <table className="preview-table">
                            <thead>
                              <tr>
                                <th scope="col">{t('preview.columnCategory')}</th>
                                <th scope="col">{t('preview.columnLocation')}</th>
                                <th scope="col">{t('preview.columnConfidence')}</th>
                                <th scope="col">{t('preview.columnSources')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {visibleDetails.map((detail) => (
                                <tr key={`${detail.entityType}:${String(detail.start)}:${String(detail.end)}`}>
                                  <th scope="row">{t(entityMessage(detail.entityType))}</th>
                                  <td>{message(locale, 'preview.location', {
                                    start: formatInteger(locale, detail.start + 1),
                                    end: formatInteger(locale, detail.end)
                                  })}</td>
                                  <td>{message(locale, 'preview.confidence', {
                                    percent: formatPercent(locale, detail.confidence)
                                  })}</td>
                                  <td>{message(locale, 'preview.sources', {
                                    sources: formatList(locale, detail.sources.map((source) => t(sourceMessage(source))))
                                  })}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <div className="page-controls" aria-label={t('job.pages')}>
                          <Button
                            disabled={scan.loadingPage || scan.pageHistory.length === 0}
                            onClick={() => {
                              const priorCursor = scan.pageHistory.at(-1);
                              if (priorCursor === undefined) return;
                              const controller = previewController.current;
                              if (controller === undefined) return;
                              setScan({ ...scan, loadingPage: true });
                              void jobClient.listDetections(
                                scan.summary.job.id, priorCursor, 100, controller.signal
                              ).then((page) => {
                                if (controller.signal.aborted) return;
                                if (page.jobRevision !== scan.summary.job.revision) {
                                  setScan({ kind: 'failed' });
                                  return;
                                }
                                setScan({
                                  kind: 'complete',
                                  summary: { ...scan.summary, ...page },
                                  pageHistory: scan.pageHistory.slice(0, -1),
                                  loadingPage: false
                                });
                              }, () => { if (!controller.signal.aborted) setScan({ kind: 'failed' }); });
                            }}
                          >{t('job.previousPage')}</Button>
                          <span>{message(locale, 'job.pageRange', {
                            start: formatInteger(locale, scan.summary.cursor + 1),
                            end: formatInteger(locale, scan.summary.cursor + scan.summary.details.length),
                            total: formatInteger(locale, scan.summary.detections)
                          })}</span>
                          <Button
                            disabled={scan.loadingPage || scan.summary.nextCursor === null}
                            onClick={() => {
                              const nextCursor = scan.summary.nextCursor;
                              const controller = previewController.current;
                              if (nextCursor === null || controller === undefined) return;
                              setScan({ ...scan, loadingPage: true });
                              void jobClient.listDetections(
                                scan.summary.job.id, nextCursor, 100, controller.signal
                              ).then((page) => {
                                if (controller.signal.aborted) return;
                                if (page.jobRevision !== scan.summary.job.revision) {
                                  setScan({ kind: 'failed' });
                                  return;
                                }
                                setScan({
                                  kind: 'complete',
                                  summary: { ...scan.summary, ...page },
                                  pageHistory: [...scan.pageHistory, scan.summary.cursor],
                                  loadingPage: false
                                });
                              }, () => { if (!controller.signal.aborted) setScan({ kind: 'failed' }); });
                            }}
                          >{t('job.nextPage')}</Button>
                        </div>
                        <p className="preview-details-privacy">{t('preview.confidenceHint')}</p>
                        <p className="preview-details-privacy">{t('preview.detailsPrivacy')}</p>
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
