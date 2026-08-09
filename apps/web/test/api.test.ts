import { describe, expect, it, vi } from 'vitest';

import { createCapabilityClient, projectCapabilitySummary } from '../src/api.js';

const session = {
  apiOrigin: 'http://127.0.0.1:4174',
  bearerToken: 'A'.repeat(43)
} as const;

function capabilityResponse(): Readonly<Record<string, unknown>> {
  return {
    engineMode: 'RULES_ONLY',
    formats: [{ id: 'text' }, { id: 'markdown' }],
    detectors: [
      { id: 'rules', availability: 'AVAILABLE' },
      { id: 'model', availability: 'DISABLED' }
    ],
    limits: { maximumInputBytes: 104_857_600 }
  };
}

describe('browser capability client', () => {
  it('projects only bounded display-safe capability aggregates', () => {
    expect(projectCapabilitySummary(capabilityResponse())).toEqual({
      engineMode: 'RULES_ONLY',
      formatCount: 2,
      availableDetectorCount: 1,
      maximumInputBytes: 104_857_600
    });
    expect(() => projectCapabilitySummary({ ...capabilityResponse(), engineMode: 'SURPRISE' })).toThrow(
      'CAPABILITY_RESPONSE_INVALID'
    );
    expect(() => projectCapabilitySummary({ ...capabilityResponse(), engineMode: 'REMOTE' })).toThrow(
      'CAPABILITY_RESPONSE_INVALID'
    );
  });

  it('uses the exact numeric-loopback session with no redirects, referrer, credentials, or cache', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify(capabilityResponse()),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ));
    const client = createCapabilityClient(session, fetchImplementation);
    await expect(client.load(new AbortController().signal)).resolves.toMatchObject({ engineMode: 'RULES_ONLY' });

    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    if (!(url instanceof URL)) throw new TypeError('The capability request URL was not normalized.');
    expect(url.href).toBe('http://127.0.0.1:4174/v1/capabilities');
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer'
    });
    expect(init?.headers).toEqual({
      authorization: `Bearer ${session.bearerToken}`,
      accept: 'application/json'
    });
  });

  it('rejects non-loopback sessions and oversized or malformed responses', async () => {
    expect(() => createCapabilityClient({ ...session, apiOrigin: 'http://localhost:4174' })).toThrow(TypeError);
    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '200000' }
    }));
    await expect(createCapabilityClient(session, oversized).load(new AbortController().signal)).rejects.toThrow(
      'CAPABILITY_RESPONSE_INVALID'
    );
  });

  it('bounds a non-cooperative capability request and aborts its transport signal', async () => {
    let transportSignal: AbortSignal | undefined;
    const hanging = vi.fn<typeof fetch>((_input, init) => {
      transportSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const client = createCapabilityClient(session, hanging, 10);
    await expect(client.load(new AbortController().signal)).rejects.toThrow('CAPABILITY_REQUEST_CANCELLED');
    expect(transportSignal?.aborted).toBe(true);
  });
});
