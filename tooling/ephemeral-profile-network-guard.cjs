'use strict';

let blockedAttemptCount = 0;

function blocked(api) {
  blockedAttemptCount += 1;
  const error = new Error(`G1_NETWORK_BLOCKED:${api}`);
  error.code = 'G1_NETWORK_BLOCKED';
  return error;
}

function blockFunction(target, name, api) {
  if (typeof target[name] !== 'function') return;
  target[name] = function blockedNetworkOperation() {
    throw blocked(api);
  };
}

function blockFunctions(target, names, prefix) {
  for (const name of names) blockFunction(target, name, `${prefix}.${name}`);
}

globalThis.fetch = function blockedFetch() {
  return Promise.reject(blocked('fetch'));
};

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const dgram = require('node:dgram');
const dns = require('node:dns');
const dnsPromises = require('node:dns/promises');

blockFunctions(net, ['connect', 'createConnection'], 'net');
blockFunction(net.Socket.prototype, 'connect', 'net.Socket.prototype');
blockFunction(net.Server.prototype, 'listen', 'net.Server.prototype');
blockFunctions(http, ['request', 'get'], 'http');
blockFunctions(https, ['request', 'get'], 'https');
blockFunctions(tls, ['connect', 'createConnection'], 'tls');
blockFunctions(dgram, ['createSocket'], 'dgram');

const dnsOperations = [
  'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
  'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
  'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'
];
blockFunctions(dns, dnsOperations, 'dns');
blockFunctions(dnsPromises, dnsOperations, 'dns.promises');
blockFunctions(dns.Resolver.prototype, dnsOperations, 'dns.Resolver.prototype');
blockFunctions(dnsPromises.Resolver.prototype, dnsOperations, 'dns.promises.Resolver.prototype');
blockFunctions(dgram.Socket.prototype, ['bind', 'connect', 'send'], 'dgram.Socket.prototype');

process.on('beforeExit', () => {
  if (blockedAttemptCount > 0 && process.env.G1_NETWORK_GUARD_SELF_TEST !== '1') {
    process.stderr.write('G1 network guard observed a forbidden network attempt.\n');
    process.exitCode = 97;
  }
});
