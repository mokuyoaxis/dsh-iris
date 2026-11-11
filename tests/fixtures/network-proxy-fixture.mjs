// Local-only CONNECT fixture. This is test infrastructure, never a production proxy.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export async function within(promise, label = 'network proxy fixture', timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out: ' + label)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// Public test-only key/certificate, valid 2026-01-01 through 2036-01-01.
// Never use this known private key for real servers. It is excluded from npm.
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD10KbzfQom1uHU
slFVgtTzB+EKIRGc0xM/UZkJkfW8+hrDG9IT72MF6lkcKRlcYwDcCYhGZ0AyyWCp
J9mwITe4RC2/JhF61Ptokdv+QFHQ3ocRYgB3r67WhPYlEA4HN5YuhEpZ0P+fktaD
9vzAoMobTaqPxjnvD6FPhWE7nH2FSSnzVX7x8r9+v3VT/ktwqN54dWjjqIZCMxEq
Nta3JHKyBSTYdwajTKnMfihZ9FNVorAB3Ti6NlDmVU9xSNW/gzS3Bu3kBvIWr8FD
HQIT6EB9WCnRJ++JVR2SxWhSM2GCedjTsJ3WCsYP34CsDlJJ2EiXeCpkbamSY11m
F9b6Es3VAgMBAAECggEAA4Wgzr5M5e+QPsbrSWldebn0LHv6z59qmC6oHa38sl93
ALKmWOjGJ3CLJE8mcN9uRLjSPgf+sHuYKfRLNy3SqY44hZObDoJ8s6vbVhI/2dlG
YCZiUVSwEZzIFhHb0ZinSzVUB2NqNjQZZLymNHBZVPjQ58x0SguUSRplIUCFv+Ic
Sn9l3w1oLhP14OKQog58TwiIwRRoYkuECfI6gZQ2OXnwteho6KpfcKC6yDvzOSG4
RROOWUBHTPEJm4bj3HfUv6py1tYqzhRi2a8w5mPLvYSXGM56q1Fyaw+L6yRUkkax
XMJwcsdo8qvpCBEWN/uR6hAgGFaGGuPU+iOeESHmIQKBgQD7QHkGkDicE3K6fCDj
C3DSYJWjOzIfBbWl+vvNYZPpJ+HDNOH2Pw0X3ghjMFHRN7D8qa6K3IQOXKWcPKRp
FaI9PjHkpDb0ainuyea4fpfxsFrhqyGDP+wrcf4757NtxuyNIxBzTEp4CglEQtM8
THzpfz1wfWSxmkn/gt5dk1QnyQKBgQD6deB1iF1hclmOLIg0suLjDqXCfeNUO7MJ
Lyhfz4HeaaZ3N9xFQukeEDhRCCybcwU4cZWeGyPL4jL1TQsZr7AbUuH8FdNcNZqP
qOk/EKAnLwvWFLE7iol18VmU6x0QvR2doN3/IV9SoqNVxZ7Kc7x0u4YzpFgu7XvS
lNFF8UATrQKBgQDZxJjhYnFefdDL57iNcaYZAdPQxgb8MnOt6CsFaVTNGl8oVZag
WyfbDvwQFJpljzKc2+lHvDfNRunX0AvkdPbIxDZ0aQykrbuol2CdekPyHJu4yx3h
566oPUZQ39N6C5eOAN1KQc6t2m0LuCvkMJt3umwjKtvyv7rxdpmLW53uWQKBgBK5
5YJkI7c5eYCry7NE/LnFSpd0Gh8eJ5C0OeyP80HR3GRlhM6Y5h0dUVidp9gnjWhe
9bTQiqifzPeSPxY4kI46cDMM3rSyPVAobOgOMis71UK4YVf2T7jFxtDfk1jBCwnS
EUcWE652AohTMkAozxpbOvl5fC5mCy//eHYmR4gxAoGASnOTapL5tm4sGkaTmZwE
phm/syGMeR/z2P3n2TqUPr5aj1x64uoUSU2wKohUINeAFGrWyNGcO/2rRUGrFOlb
gaNkwDvBJ8ZCWrsww0DbRzZZtdDKrPEpdf76eweelwOWjtS6Qu6/DjfhEDTvVm6G
8Nt41oUc4odemfjRsLj8pa0=
-----END PRIVATE KEY-----
`;
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDPTCCAiWgAwIBAgIUWi49+oRjoqWqEiSkZpfB9Z2ALMEwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDEwMTAwMDAwMFoXDTM2MDEw
MTAwMDAwMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA9dCm830KJtbh1LJRVYLU8wfhCiERnNMTP1GZCZH1vPoa
wxvSE+9jBepZHCkZXGMA3AmIRmdAMslgqSfZsCE3uEQtvyYRetT7aJHb/kBR0N6H
EWIAd6+u1oT2JRAOBzeWLoRKWdD/n5LWg/b8wKDKG02qj8Y57w+hT4VhO5x9hUkp
81V+8fK/fr91U/5LcKjeeHVo46iGQjMRKjbWtyRysgUk2HcGo0ypzH4oWfRTVaKw
Ad04ujZQ5lVPcUjVv4M0twbt5AbyFq/BQx0CE+hAfVgp0SfviVUdksVoUjNhgnnY
07Cd1grGD9+ArA5SSdhIl3gqZG2pkmNdZhfW+hLN1QIDAQABo4GGMIGDMCwGA1Ud
EQQlMCOCCWxvY2FsaG9zdIcEfwAAAYcQAAAAAAAAAAAAAAAAAAAAATAPBgNVHRMB
Af8EBTADAQH/MA4GA1UdDwEB/wQEAwICpDATBgNVHSUEDDAKBggrBgEFBQcDATAd
BgNVHQ4EFgQUl42fx2PddArHJwasSOYNTwaovewwDQYJKoZIhvcNAQELBQADggEB
AJD1DXQ5Oc4JZ329u2gb+TR8ypraZbYsSIX7DAm2zzckhhwZKzO23V2qVnSsPXJV
7IRjrwSLzLPzIugaHnbeK+z7KXWV2Ea/9mW9pku/Pp258Lu1WckZnejXZlSoYl95
Ox1xuU4IR7HEI3wFPaDL0OMiO2WYTRH0cAngwiOvekmj8rQlP20qjNcrNH8VqMSh
KhYnkhsV76YaDhAzAzL89mPGvH1NnhJMgb1YieLoJ6nvH71v55MlqxY6YttAwyae
heWTeV+4LtBX2WMeBTX1/igjqdIwO3zmsh5ZcEyButduJDN3Ce9ed73mpFmV8ZXH
WKfLiqhtvit+/iRdSSA2iGs=
-----END CERTIFICATE-----
`;

function certificate(root) {
  fs.writeFileSync(path.join(root, 'proxy-fixture-key.pem'), TEST_TLS_KEY, { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'proxy-fixture-cert.pem'), TEST_TLS_CERT, { mode: 0o600 });
  return { key: Buffer.from(TEST_TLS_KEY), cert: Buffer.from(TEST_TLS_CERT) };
}

export async function createNetworkProxyFixture(root) {
  const credentials = certificate(root);
  const requests = [], connects = [], plainProxyRequests = [], errors = [];
  const servers = [], sockets = new Set(), pending = new Map(), events = new EventEmitter();
  const media = Buffer.from('fixture-media-through-the-selected-CONNECT-route');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  let httpOrigin, httpsOrigin, closing = false;

  function track(socket) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; }
  async function listen(server, tls) {
    servers.push(server); server.on('connection', track);
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  }
  function send(response, status, value) {
    if (response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
  }
  async function handleOrigin(request, response) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const row = { method: request.method, path: new URL(request.url, 'http://fixture').pathname,
      headers: { ...request.headers }, body: Buffer.concat(chunks), tls: Boolean(request.socket.encrypted) };
    requests.push(row); events.emit('request', row);
    if (row.path === '/doctor/ip') { send(response, 200, { ip: '203.0.113.8', ignored: 'fixture response body must not be reflected' }); return; }
    if (row.path === '/doctor/large') { response.end('x'.repeat(16385)); return; }
    if (row.path === '/doctor/error') { send(response, 403, { detail: 'fixture private upstream detail' }); return; }
    if (row.path === '/doctor/redirect') { response.writeHead(302, { Location: '/doctor/ip' }); response.end(); return; }
    if (row.path === '/received-then-reset') { request.socket.destroy(); return; }
    if (row.path === '/unknown/v1/images/generations') { request.socket.destroy(); return; }
    if (row.path === '/sync/v1/images/generations') { send(response, 200, { data: [{ url: httpOrigin + '/durable/result' }] }); return; }
    if (row.path === '/durable/submit') { send(response, 200, { taskId: 'original-remote' }); return; }
    if (row.path === '/durable/tasks/original-remote') {
      send(response, 200, { url: httpsOrigin + '/durable/result' }); return;
    }
    if (row.path === '/durable/result') { response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(image); return; }
    if (row.path === '/cdn/redirect') {
      response.writeHead(302, { Location: httpsOrigin + '/cdn/result' }); response.end(); return;
    }
    if (row.path === '/cdn/result') { response.writeHead(200); response.end(media); return; }
    if (row.path === '/provider-rate-limit') { send(response, 429, { error: { message: 'fixture provider rate limit' } }); return; }
    if (row.path.startsWith('/hold/')) {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      pending.set(row.path, release);
      await gate; pending.delete(row.path);
      send(response, 200, { path: row.path }); return;
    }
    if (row.path === '/slow-body') {
      response.writeHead(200, { 'Content-Type': 'text/plain' }); response.write('first-');
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      pending.set(row.path, release);
      await gate; pending.delete(row.path);
      if (!response.destroyed) response.end('last'); return;
    }
    send(response, 200, { path: row.path, method: row.method, authorization: row.headers.authorization || null,
      proxyAuthorization: row.headers['proxy-authorization'] || null });
  }
  const originHandler = (request, response) => {
    void handleOrigin(request, response).catch(error => {
      if (closing || request.destroyed) return;
      errors.push(error.message); send(response, 500, { error: 'fixture handler failed' });
    });
  };

  async function createProxy({ tls = false, tag = 'proxy', auth, rejectStatus } = {}) {
    const rows = [];
    const handler = (request, response) => {
      plainProxyRequests.push({ tag, method: request.method, url: request.url });
      response.writeHead(405); response.end('Fixture accepts CONNECT only');
    };
    const server = tls ? https.createServer(credentials, handler) : http.createServer(handler);
    server.on('connect', (request, client, head) => {
      const row = { tag, authority: request.url, headers: { ...request.headers }, tls: Boolean(client.encrypted) };
      rows.push(row); connects.push(row); events.emit('connect', row);
      const reject = status => { if (!client.destroyed) client.end(`HTTP/1.1 ${status} Fixture rejection\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); };
      if (auth && request.headers['proxy-authorization'] !== auth) { reject(407); return; }
      if (rejectStatus) { reject(rejectStatus); return; }
      let destination;
      try { destination = new URL('http://' + request.url); } catch (_) { reject(400); return; }
      const host = destination.hostname.replace(/^\[|\]$/g, '');
      if (!['127.0.0.1', '::1', 'localhost'].includes(host) || !destination.port) { reject(403); return; }
      const upstream = track(net.connect({ host, port: Number(destination.port) }));
      const disconnect = () => { upstream.destroy(); client.destroy(); };
      upstream.setTimeout(2000, disconnect);
      upstream.once('error', () => { reject(502); upstream.destroy(); });
      client.once('error', () => upstream.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('connect', () => {
        upstream.setTimeout(0);
        if (client.destroyed) { upstream.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
    });
    const url = await listen(server, tls);
    return { url, port: server.address().port, tag, connects: rows, tls };
  }
  function waitForRequests(predicate, count = 1) {
    return within(new Promise(resolve => {
      const check = () => {
        const matching = requests.filter(predicate);
        if (matching.length >= count) { events.off('request', check); resolve(matching); }
      };
      events.on('request', check); check();
    }), 'local upstream request');
  }
  function release(name) { pending.get(name)?.(); }
  function snapshot() {
    return { requests: requests.length, connects: connects.length, sockets: sockets.size,
      listeningServers: servers.filter(server => server.listening).length, pending: [...pending.keys()], closing };
  }
  async function close() {
    if (closing) return; closing = true;
    for (const complete of pending.values()) complete();
    events.removeAllListeners();
    for (const socket of sockets) socket.destroy();
    await within(Promise.all(servers.map(server => new Promise(resolve => {
      server.close(resolve); server.closeAllConnections?.();
    }))), 'local fixture close');
  }
  try {
    httpOrigin = await listen(http.createServer(originHandler), false);
    httpsOrigin = await listen(https.createServer(credentials, originHandler), true);
    return { httpOrigin, httpsOrigin, ca: credentials.cert, media, requests, connects, plainProxyRequests, errors,
      createProxy, waitForRequests, release, snapshot, close };
  } catch (error) { await close(); throw error; }
}
