import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { message } from '@local-pii/i18n';
import '@local-pii/ui/styles.css';

import { createCapabilityClient, createDisconnectedCapabilityClient, type LocalApiSession } from './api.js';
import { WebApplication } from './application.js';
import { consumeLocalBootstrap } from './bootstrap.js';
import { createDisconnectedJobClient, createLocalJobClient } from './job-api.js';
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

let capabilityClient = createDisconnectedCapabilityClient();
let jobClient = createDisconnectedJobClient();
const bootstrap = consumeLocalBootstrap(window, document);
if (bootstrap !== undefined) {
  try {
    capabilityClient = createCapabilityClient(bootstrap);
    jobClient = createLocalJobClient(bootstrap);
  } catch {
    capabilityClient = createDisconnectedCapabilityClient();
    jobClient = createDisconnectedJobClient();
  }
}

createRoot(root).render(
  <StrictMode>
    <WebApplication capabilityClient={capabilityClient} jobClient={jobClient} />
  </StrictMode>
);
