process.env.G1_NETWORK_GUARD_SELF_TEST = '1';

async function expectBlocked(label, attempt) {
  try {
    await attempt();
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'G1_NETWORK_BLOCKED') return;
    throw new Error(`G1 network guard did not block ${label}.`, { cause: error });
  }
  throw new Error(`G1 network guard allowed ${label}.`);
}

const net = await import('node:net');
const http = await import('node:http');
const https = await import('node:https');
const tls = await import('node:tls');
const dgram = await import('node:dgram');
const dns = await import('node:dns');
const dnsPromises = await import('node:dns/promises');

await expectBlocked('fetch', () => fetch('https://example.invalid/'));
await expectBlocked('socket', () => net.connect({ host: '127.0.0.1', port: 9 }));
await expectBlocked('http', () => http.request('http://127.0.0.1:9/'));
await expectBlocked('https', () => https.request('https://127.0.0.1:9/'));
await expectBlocked('tls', () => tls.connect({ host: '127.0.0.1', port: 9 }));
await expectBlocked('dgram', () => dgram.createSocket('udp4'));
await expectBlocked('dns callback API', () => dns.lookup('example.invalid', () => undefined));
await expectBlocked('dns promise API', () => dnsPromises.lookup('example.invalid'));

console.log('G1 network guard self-test passed.');
