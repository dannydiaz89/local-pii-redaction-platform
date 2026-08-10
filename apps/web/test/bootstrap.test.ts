// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { consumeLocalBootstrap } from '../src/bootstrap.js';

describe('trusted browser bootstrap consumption', () => {
  it('snapshots the session and immediately removes global and DOM references', () => {
    const script = document.createElement('script');
    script.dataset.localPiiBootstrap = '';
    document.head.append(script);
    const browserWindow = {
      __LOCAL_PII_BOOTSTRAP__: {
        apiOrigin: 'http://127.0.0.1:4174',
        bearerToken: 'A'.repeat(43)
      }
    };

    expect(consumeLocalBootstrap(browserWindow, document)).toEqual({
      apiOrigin: 'http://127.0.0.1:4174',
      bearerToken: 'A'.repeat(43)
    });
    expect('__LOCAL_PII_BOOTSTRAP__' in browserWindow).toBe(false);
    expect(document.querySelector('[data-local-pii-bootstrap]')).toBeNull();
  });
});
