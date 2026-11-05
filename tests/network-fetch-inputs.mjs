import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createProviderNetworkManager } from '../lib/network-routing.js';
import { createMediaScheduler } from '../lib/media-scheduler.js';
import { createNetworkProxyFixture } from './fixtures/network-proxy-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-network-fetch-inputs');
const fixture = await createNetworkProxyFixture(root), proxy = await fixture.createProxy();
const original = { fetch, Request, FormData };
const { getGlobalDispatcher } = await import('undici'), dispatcher = getGlobalDispatcher();
try {
  for (const scheduled of [false, true]) {
    for (const route of ['inherit', 'direct', 'proxy']) {
      const id = `${route}-${scheduled}`, file = path.join(root, id + '.json');
      const requirement = { schemaVersion: 1, configId: crypto.randomUUID(), catalogId: crypto.randomUUID() };
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, configId: requirement.configId, generation: 1,
        nodes: [{ id: 'proxy', protocol: 'http', host: '127.0.0.1', port: proxy.port }],
        pools: [{ id: 'outbound', mode: 'fixed', candidates: [route === 'proxy' ? { kind: 'node', nodeId: 'proxy' } : { kind: 'direct' }] }],
        bindings: route === 'inherit' ? [] : [{ catalogId: requirement.catalogId, providerId: 'p', poolId: 'outbound' }] }), { mode: 0o600 });
      const scheduler = scheduled ? createMediaScheduler({ schemaVersion: 1, httpConcurrency: 1, requestsPerSecond: 100 }) : undefined;
      const manager = createProviderNetworkManager({ networkConfigPath: file, scheduler });
      const client = manager.resolveProviderNetwork({ providerId: 'p', modelRef: 'p::fixture', networkRequirement: requirement });
      const send = (input, options) => client.run(async port => {
        const response = await port(input, options); await response.text(); return response;
      }, { operation: 'prepareInput' });
      try {
        const body = new FormData();
        body.append('policy', 'first'); body.append('policy', 'second');
        body.append('file', new Blob(['fixture-file-bytes'], { type: 'audio/wav' }), 'fixture speech.wav');
        await send(fixture.httpOrigin + '/' + id + '/form', { method: 'POST', headers: { 'x-fixture': id }, body });
        const form = fixture.requests.at(-1), text = form.body.toString();
        assert.match(form.headers['content-type'], /^multipart\/form-data; boundary=/);
        assert.equal(Number(form.headers['content-length']), form.body.length, 'FormData retains a known length without buffering the upload');
        assert.equal(form.headers['x-fixture'], id);
        assert(text.indexOf('first') < text.indexOf('second') && text.indexOf('second') < text.indexOf('fixture-file-bytes'));
        assert.match(text, /filename="fixture speech.wav"/); assert.match(text, /Content-Type: audio\/wav/i);

        const request = new Request(fixture.httpOrigin + '/' + id + '/request', { method: 'POST', body: 'original', headers: { 'x-fixture': 'original' } });
        await send(request, { method: 'PATCH', body: 'replacement', headers: { 'x-fixture': id } });
        const received = fixture.requests.at(-1);
        assert.equal(received.method, 'PATCH'); assert.equal(received.body.toString(), 'replacement'); assert.equal(received.headers['x-fixture'], id);

        const multipart = new Request(fixture.httpOrigin + '/' + id + '/request-form', { method: 'POST', body });
        await send(multipart);
        assert.match(fixture.requests.at(-1).headers['content-type'], /^multipart\/form-data; boundary=/);
        assert(fixture.requests.at(-1).body.includes(Buffer.from('fixture-file-bytes')));
        assert.equal(multipart.bodyUsed, true);
        const count = fixture.requests.length;
        await assert.rejects(send(multipart), TypeError);
        assert.equal(fixture.requests.length, count, 'a consumed Request is not replayed');

        const redirected = await send(new Request(fixture.httpOrigin + '/doctor/redirect', { redirect: 'manual' }));
        assert.equal(redirected.status, 302); assert.equal(fixture.requests.at(-1).path, '/doctor/redirect');
        const controller = new AbortController(); controller.abort(new Error('fixture request cancelled'));
        const before = fixture.requests.length;
        await assert.rejects(send(new Request(fixture.httpOrigin + '/' + id + '/cancelled', { signal: controller.signal })));
        assert.equal(fixture.requests.length, before, 'Request.signal stops the request before dispatch');

        if (scheduler) {
          const slowCount = fixture.requests.filter(row => row.path === '/slow-body').length;
          const slow = client.run(async port => (await port(fixture.httpOrigin + '/slow-body')).text(), { operation: 'download' });
          await fixture.waitForRequests(row => row.path === '/slow-body', slowCount + 1);
          const stop = new AbortController();
          const pending = send(new Request(fixture.httpOrigin + '/' + id + '/queued', { signal: stop.signal }));
          const rejected = assert.rejects(pending);
          stop.abort(new Error('fixture queued request cancelled'));
          await rejected; fixture.release('/slow-body'); await slow;
          assert(!fixture.requests.some(row => row.path === '/' + id + '/queued'));
          assert.equal(scheduler.snapshot().httpActive, 0);
        }
      } finally { await manager.dispose(); scheduler?.dispose(); }
    }
  }
  assert.equal(globalThis.fetch, original.fetch); assert.equal(globalThis.Request, original.Request); assert.equal(globalThis.FormData, original.FormData);
  assert.equal(getGlobalDispatcher(), dispatcher); assert(proxy.connects.length > 0); assert.deepEqual(fixture.errors, []);
  console.log('Network fetch inputs: native multipart, Request overrides/body lifetime/redirect/cancellation, inherited/direct/CONNECT and scheduling passed without global mutation or replay');
} finally { await fixture.close(); }
