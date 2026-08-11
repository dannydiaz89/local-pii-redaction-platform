import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { message } from '@local-pii/i18n';
import '@local-pii/ui/styles.css';

import {
  createDisconnectedLocalSessionClient,
  createLocalSessionClient,
  type LocalApiSession
} from '@local-pii/sdk';
import { WebApplication } from './application.js';
import { consumeLocalBootstrap } from './bootstrap.js';
import './web.css';

declare global {
  interface Window {
    /** Injected by the trusted local launcher for this application lifetime; never persisted by the web app. */
    __LOCAL_PII_BOOTSTRAP__?: LocalApiSession;
  }
}

const root = document.querySelector('#root');
if (root === null) throw new Error('The web application root is unavailable.');
document.title = message('en', 'app.name');

let localClient = createDisconnectedLocalSessionClient();
const bootstrap = consumeLocalBootstrap(window, document);
if (bootstrap !== undefined) {
  try {
    localClient = createLocalSessionClient(bootstrap);
  } catch {
    localClient = createDisconnectedLocalSessionClient();
  }
}

createRoot(root).render(
  <StrictMode>
    <WebApplication capabilityClient={localClient.capabilities} jobClient={localClient.jobs} />
  </StrictMode>
);
