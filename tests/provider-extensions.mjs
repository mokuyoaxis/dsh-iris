import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createProviderRegistry, defineProviderAdapter, normalizeMediaEndpoint } from '@mokuyoaxis/dsh-iris/provider-extensions';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { imageCandidatesFromCatalog, providerTaskBinding } from '../lib/provider-catalog.js';
import { supportsImageEdit, normalizeImageProtocol } from '../lib/provider-protocol.js';
import { invokeProviderOperation } from '../lib/provider-adapter.js';

const provider = { id: 'fixture', auth: 'none', baseUrl: 'http://127.0.0.1:1234/v1/', mediaProtocol: 'fixture-images',
  models: [{ id: 'edit', capabilities: ['image-gen'], imageProtocol: 'fixture-images' }] };
const catalog = { providers: [provider], assignments: { 'image-gen': { mode: 'auto', models: [] } } };
const checks = [];
function factory({ id = 'fixture.extension', protocol = 'fixture-images', version = '1.0.0', contractVersion = 0,
  submit = async () => ({ kind: 'acceptance_unknown', error: { stage: 'response', acceptance: 'unknown', category: 'network' } }), dispose } = {}) {
  return () => ({ id, version, contractVersion, dispose, protocols: [{ id: protocol, label: 'Fixture images',
    capabilities: ['image-gen'], configuration: [{ key: 'apiKey', label: 'API Key', type: 'secret' }],
    normalizeEndpoint: normalizeMediaEndpoint, supportsImageEdit: () => true,
    createAdapter: value => defineProviderAdapter({ id: value.id, protocol, capabilities: ['image'],
      operations: { submit, mapError: error => error },
      unsupported: { discover: 'fixture', poll: 'fixture', cancel: 'fixture', download: 'fixture' } }) }] });
}

const first = await createProviderRegistry({ extensions: [factory()] });
const second = await createProviderRegistry();
try {
  assert.equal(first.snapshot().protocols.length, 7); assert.equal(second.snapshot().protocols.length, 6);
  assert.equal(imageCandidatesFromCatalog(catalog, '', first).length, 1);
  assert.throws(() => imageCandidatesFromCatalog(catalog), { code: 'IRIS_PROVIDER_IMAGE_PROTOCOL_INVALID' });
  assert.throws(() => imageCandidatesFromCatalog({ ...catalog, providers: [{ ...provider,
    models: [{ id: 'edit', capabilities: ['image-gen'] }] }] }), { code: 'IRIS_PROVIDER_MODEL_UNAVAILABLE' });
  assert.throws(() => createConfiguredProviderAdapter(provider, { registry: second }), { code: 'IRIS_PROVIDER_PROTOCOL_UNSUPPORTED' });
  assert.equal(normalizeImageProtocol('fixture-images', first), 'fixture-images');
  assert.throws(() => normalizeImageProtocol('fixture-images', second), { code: 'IRIS_PROVIDER_IMAGE_PROTOCOL_INVALID' });
  assert.equal(supportsImageEdit('fixture-images', 'edit', first), true);
  checks.push('instance isolation, auto candidates, model overrides and edit support use the explicit registry');

  const metadata = first.snapshot(); metadata.protocols[0].configuration[0].label = 'changed';
  assert.notEqual(first.snapshot().protocols[0].configuration[0].label, 'changed');
  assert(!JSON.stringify(metadata).includes(provider.baseUrl));
  assert.throws(() => first.descriptor('fixture-images').capabilities.push('tts'));
  checks.push('descriptors are immutable and public snapshots contain configuration descriptions only');

  for (const protocol of second.snapshot().protocols.filter(protocol => protocol.id !== 'comfyui')) {
    const value = { ...provider, mediaProtocol: protocol.id, models: [], baseUrl: protocol.id === 'dashscope'
      ? 'https://dashscope.aliyuncs.com/compatible-mode/v1' : 'https://fixture.invalid/v1///' };
    const endpoint = protocol.id === 'dashscope' ? 'https://dashscope.aliyuncs.com/api/v1' : 'https://fixture.invalid/v1';
    const original = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify([1, protocol.id, endpoint])).digest('hex');
    assert.equal(providerTaskBinding(value), original); assert.equal(providerTaskBinding(value, second), original);
  }
  checks.push('all five built-in Task bindings retain the exact historical hash input');

  let closed = 0;
  await assert.rejects(createProviderRegistry({ extensions: [factory({ contractVersion: 1, dispose: () => { closed++; } })] }),
    { code: 'IRIS_PROVIDER_EXTENSION_INVALID' });
  assert.equal(closed, 1);
  await assert.rejects(createProviderRegistry({ extensions: [factory({ version: 'latest' })] }), { code: 'IRIS_PROVIDER_EXTENSION_INVALID' });
  await assert.rejects(createProviderRegistry({ extensions: [factory(), factory({ protocol: 'different-images' })] }), { code: 'IRIS_PROVIDER_EXTENSION_INVALID' });
  await assert.rejects(createProviderRegistry({ extensions: [factory({ protocol: 'openai-images' })] }), { code: 'IRIS_PROVIDER_EXTENSION_INVALID' });
  const cleanups = [];
  await assert.rejects(createProviderRegistry({ extensions: [factory({ dispose: async () => { cleanups.push('first'); } }),
    factory({ id: 'fixture.second', dispose: async () => { cleanups.push('second'); } })] }), { code: 'IRIS_PROVIDER_EXTENSION_INVALID' });
  assert.deepEqual(cleanups, ['second', 'first']);
  checks.push('version, duplicate ID/protocol rejection and failed activation clean up owned instances');

  let release, started;
  const entered = new Promise(resolve => { started = resolve; }), pending = new Promise(resolve => { release = resolve; });
  let disposed = 0;
  const active = await createProviderRegistry({ extensions: [factory({ submit: async () => { started(); await pending;
    return { kind: 'accepted', remoteTaskId: 'original-remote' }; }, dispose: async () => { disposed++; } })] });
  const adapter = createConfiguredProviderAdapter(provider, { registry: active });
  const call = invokeProviderOperation(adapter, 'submit', { capability: 'image', model: 'edit', input: {} });
  await entered;
  const closing = active.dispose(); assert.equal(active.dispose(), closing); assert.equal(disposed, 0);
  await assert.rejects(adapter.operations.submit({}), { code: 'IRIS_PROVIDER_EXTENSION_CLOSED' });
  assert.equal((await invokeProviderOperation(adapter, 'submit', {})).kind, 'not_accepted');
  release(); assert.equal((await call).remoteTaskId, 'original-remote'); await closing;
  assert.equal(disposed, 1); assert.equal(active.snapshot().state, 'closed');
  checks.push('dispose rejects new calls, waits for the original accepted call, and releases once');

  const broken = await createProviderRegistry({ extensions: [factory({ dispose: () => { throw new Error('fixture cleanup failed'); } })] });
  await assert.rejects(broken.dispose(), AggregateError); assert.equal(broken.snapshot().cleanupFailed, true);
  await assert.rejects(broken.dispose(), AggregateError);
  checks.push('cleanup failures remain explicit and repeat disposal preserves the failure');

  const secret = 'literal-fixture-key-123', leaked = await createProviderRegistry({ extensions: [factory({
    submit: async () => { throw Object.assign(new Error('rejected ' + secret), { acceptance: 'not_accepted', code: secret }); }
  })] });
  try {
    const evidence = [];
    const value = await invokeProviderOperation(createConfiguredProviderAdapter({ ...provider, apiKey: secret, auth: 'bearer' }, {
      registry: leaked, onModelAvailability: event => evidence.push(event) }), 'submit', { capability: 'image', model: 'edit', input: {} });
    assert(!JSON.stringify(value).includes(secret)); assert(!JSON.stringify(evidence).includes(secret));
    checks.push('external adapter errors and health persistence redact the exact connection key');
  } finally { await leaked.dispose(); }

  let seenKey;
  const withoutAuth = await createProviderRegistry({ extensions: [() => {
    const extension = factory()(), original = extension.protocols[0].createAdapter;
    extension.protocols[0].createAdapter = value => { seenKey = value.apiKey; return original(value); };
    return extension;
  }] });
  try {
    createConfiguredProviderAdapter({ ...provider, auth: 'none', apiKey: 'retained-old-key' }, { registry: withoutAuth });
    assert.equal(seenKey, '');
    checks.push('auth:none never exposes the retained old key to an extension adapter factory');
  } finally { await withoutAuth.dispose(); }
} finally { await first.dispose(); await second.dispose(); }
console.log(JSON.stringify({ checks, count: checks.length }));
