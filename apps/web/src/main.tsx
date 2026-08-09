import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { message } from '@local-pii/i18n';
import '@local-pii/ui/styles.css';

import { createCapabilityClient, createDisconnectedCapabilityClient, type LocalApiSession } from './api.js';
import { WebApplication } from './application.js';
import './web.css';

declare global {
  interface Window {
    /** Injected by the trusted local launcher for this application lifetime; never persisted by the web app. */
    readonly __LOCAL_PII_BOOTSTRAP__?: LocalApiSession;
  }
}

const root = document.querySelector('#root');
if (root === null) throw new Error('The web application root is unavailable.');
document.title = message('en', 'app.name');

let capabilityClient = createDisconnectedCapabilityClient();
if (window.__LOCAL_PII_BOOTSTRAP__ !== undefined) {
  try {
    capabilityClient = createCapabilityClient(window.__LOCAL_PII_BOOTSTRAP__);
  } catch {
    capabilityClient = createDisconnectedCapabilityClient();
  }
}

createRoot(root).render(
  <StrictMode>
    <WebApplication capabilityClient={capabilityClient} />
  </StrictMode>
);
