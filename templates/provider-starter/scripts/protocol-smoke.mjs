import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCorePluginRegistry, ProviderContractError } from '@mokuyoaxis/dsh-iris/plugins';
import plugin, { PROVIDER_PROTOCOL, SUPPORTED_MODEL } from '../index.mjs';
import { createFixture, PNG } from './fixture.mjs';

const fixture = await createFixture(), registry = await createCorePluginRegistry({ plugins: [plugin] });
const work = await mkdtemp(path.join(os.tmpdir(), 'iris-wan-protocol-'));
const adapter = registry.providers.createAdapter(PROVIDER_PROTOCOL, { id: 'p', baseUrl: fixture.origin, apiKey: 'synthetic-private-upstream-detail' });
const methods = adapter.operations, request = { capability: 'image', model: SUPPORTED_MODEL, input: { prompt: 'local fixture', n: 1 } };
async function rejects(action, stage, acceptance, category = 'protocol') {
  await assert.rejects(action, error => error instanceof ProviderContractError && error.stage === stage && error.acceptance === acceptance && error.category === category
    && !error.message.includes('synthetic-private-upstream-detail'));
}
try {
  assert.deepEqual((await methods.discover({})).models, [{ id: SUPPORTED_MODEL, capabilities: ['image-gen'] }]);
  fixture.mode = 'bad-page'; await rejects(() => methods.discover({}), 'validate', 'not_accepted');
  fixture.mode = 'normal'; const before = fixture.requests.length;
  await rejects(() => methods.submit({ ...request, model: 'unsupported' }), 'validate', 'not_accepted', 'invalid_request');
  await rejects(() => methods.submit({ ...request, input: { prompt: 'x', n: 5 } }), 'validate', 'not_accepted', 'invalid_request');
  assert.equal(fixture.requests.length, before);
  const accepted = await methods.submit(request), remote = { capability: 'image', remoteTaskId: accepted.remoteTaskId };
  assert.equal((await methods.poll(remote)).kind, 'pending'); fixture.ready = true;
  fixture.mode = 'bad-poll'; await rejects(() => methods.poll(remote), 'poll', 'accepted'); fixture.mode = 'normal';
  const result = await methods.poll(remote), targetPath = path.join(work, 'image.png');
  assert.equal((await methods.download({ capability: 'image', artifact: result.artifacts[0], targetPath })).bytes, PNG.length);
  assert.deepEqual(await readFile(targetPath), PNG);
  assert(fixture.requests.filter(row => row.cdn).every(row => row.authorization === undefined));
  await assert.rejects(methods.download({ capability: 'image', artifact: result.artifacts[0], targetPath }), { code: 'EEXIST' });
  for (const mode of ['missing-id', 'html', 'large']) {
    fixture.mode = mode; await rejects(() => methods.submit(request), 'response', 'unknown');
  }
  fixture.mode = 'rate-limit';
  await assert.rejects(methods.submit(request), error => error.acceptance === 'not_accepted' && error.category === 'rate_limit' && error.retryAfterMs === 2000);
  fixture.mode = 'redirect'; const cdnBefore = fixture.requests.filter(row => row.cdn).length;
  await assert.rejects(methods.submit(request), error => {
    const mapped = methods.mapError(error, { stage: 'submit', acceptance: 'unknown' });
    return mapped.acceptance === 'unknown' && !mapped.message.includes('synthetic-private-upstream-detail');
  });
  assert.equal(fixture.requests.filter(row => row.cdn).length, cdnBefore, 'authenticated API redirects are rejected');
  fixture.mode = 'normal'; const controller = new AbortController(); controller.abort();
  await assert.rejects(methods.discover({ signal: controller.signal }), error => methods.mapError(error, { stage: 'validate', acceptance: 'not_accepted' }).category === 'aborted');
  assert.deepEqual(fixture.errors, []);
  console.log(JSON.stringify({ ok: true, work, checks: ['complete directory and invalid pagination', 'explicit model/n validation before HTTP', 'accepted original task and pending/succeeded poll',
    'bounded Core-target delivery, no overwrite and credential-free CDN', 'unknown acceptance on malformed/oversized response', '429 cooldown hint', 'no authenticated redirect or raw error echo', 'caller cancellation'] }, null, 2));
} finally { await registry.dispose(); await fixture.close(); }
