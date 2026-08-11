import type { LocalApiSession } from '@local-pii/sdk';

interface BootstrapWindow {
  __LOCAL_PII_BOOTSTRAP__?: LocalApiSession;
}

/** Snapshots the per-launch handoff and removes both discoverable browser references immediately. */
export function consumeLocalBootstrap(
  browserWindow: BootstrapWindow,
  browserDocument: Pick<Document, 'querySelector'>
): LocalApiSession | undefined {
  const bootstrap = browserWindow.__LOCAL_PII_BOOTSTRAP__;
  delete browserWindow.__LOCAL_PII_BOOTSTRAP__;
  browserDocument.querySelector('[data-local-pii-bootstrap]')?.remove();
  return bootstrap;
}
