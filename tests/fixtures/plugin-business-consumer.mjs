// Runs unchanged outside this repository. No imports of Iris implementation modules.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { loadCorePluginRegistry, createCorePluginRegistry, createCorePluginWorkbench, definePlugin } from '@mokuyoaxis/dsh-iris/plugins';

export const BUSINESS_ID = 'community.contact-sheet.create';
export async function createBusinessEnvironment({ entry = process.env.IRIS_TEST_BUSINESS_ENTRY || fileURLToPath(import.meta.resolve('@mokuyoaxis/dsh-iris/contact-sheet')) } = {}) {
  const business = (await import(pathToFileURL(entry).href)).default;
  const require = createRequire(import.meta.url), packageFile = require.resolve('@mokuyoaxis/dsh-iris/package.json');
  const cli = path.resolve(path.dirname(packageFile), JSON.parse(fs.readFileSync(packageFile)).bin['dsh-iris']);
  const execute = promisify(execFile), work = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-plugin-consumer-'));
  const dataRoot = path.join(work, 'core'), connectionStore = path.join(work, 'connections'), sources = [];
  let api, registry, started;
  async function cliRun(...args) {
    const result = await execute(process.execPath, [cli, ...args, ...(args[0] === 'mcp' ? [] : ['--data-root', dataRoot])], { env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
    const envelope = JSON.parse(result.stdout); assert.notEqual(envelope.ok, false, result.stdout); return envelope.result ?? envelope;
  }
  await cliRun('flow', 'init'); await cliRun('execution', 'init');
  for (const [i, background] of ['#f00000', '#0000f0'].entries()) {
    const file = path.join(work, 'source-' + i + '.png');
    await sharp({ create: { width: 32, height: 32, channels: 3, background } }).png().toFile(file);
    sources.push((await cliRun('artifact', 'import', '--input', JSON.stringify({ image_path: file }))).artifact.id);
  }
  async function start({ present = true, transform, version } = {}) {
    if (transform || version) {
      const manifest = structuredClone(business.manifest);
      if (version) manifest.version = version;
      const definition = definePlugin({ manifest, async activate(context) {
        const implementation = await business.activate(context);
        return { ...implementation, operations: { create: transform ? transform(implementation.operations.create) : implementation.operations.create } };
      } });
      registry = await createCorePluginRegistry({ plugins: present ? [definition] : [] });
    } else registry = await loadCorePluginRegistry({ entries: present ? [entry] : [] });
    // Only the real file-backed plugin contributes browser assets. Controlled lifecycle wrappers have no page.
    api = createCorePluginWorkbench({ dataRoot, registry, allowedOperations: present ? [BUSINESS_ID] : [], connectionStore,
      allowMcp: true, ...(!transform && !version && present ? { panelContributions: { pages: ['community.contact-sheet.board'] } } : {}) });
    started = await api.start(); return started;
  }
  async function close() { await api?.dispose(); api = null; await registry?.dispose(); registry = null; }
  async function raw(route, { value, key, headers = {}, method = value ? 'POST' : 'GET' } = {}) {
    return fetch(started.origin + route, { method, headers: { Authorization: 'Bearer ' + started.accessToken,
      ...(value ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...headers },
      ...(value ? { body: JSON.stringify(value) } : {}) });
  }
  async function http(route, options = {}, expected = 200) {
    const response = await raw(route, options), value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  }
  async function terminal(id) {
    for (let i = 0; i < 400; i++) {
      const value = (await http('/api/v0/operations/' + id)).operation;
      if (!['queued', 'running'].includes(value.state)) return value;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Operation did not finish');
  }
  const pin = () => registry.dependency('operations', BUSINESS_ID);
  const input = () => ({ artifactIds: [...sources], columns: 2, cellSize: 128 });
  const request = () => ({ key: crypto.randomUUID(), operationId: BUSINESS_ID, dependency: pin(), input: input() });
  const submit = ({ key, ...value }, options = {}, expected = 202) => http('/api/v0/plugin-operations', { ...options, value, key }, expected);
  const createConnection = async (pluginOperations = [pin()], scopes = ['read', 'execute', 'stop']) => {
    const result = await http('/api/v0/connection-management/connections', { value: { key: crypto.randomUUID(), label: 'Public business consumer',
      scopes, capabilities: [], pluginOperations } }, 201);
    return (await http('/api/v0/connection-management/connections')).connections.find(item => item.connectionId === result.connectionId);
  };
  const update = (record, value) => http('/api/v0/connection-management/connections/' + record.connectionId + '/update', {
    value: { expectedRevision: record.revision, label: record.label, scopes: record.scopes, capabilities: record.capabilities,
      tools: record.tools, pluginOperations: record.pluginOperations || [], ...value }
  });
  const exported = (record, transport = 'http') => http('/api/v0/connection-management/connections/' + record.connectionId + '/export', { value: { transport, format: 'entry' } });
  return { work, dataRoot, connectionStore, sources, cliRun, start, close, http, raw, terminal, pin, input, request, submit, createConnection, update, exported,
    get started() { return started; }, get registry() { return registry; }, get api() { return api; } };
}

export function barrier() {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), ready = new Promise(resolve => { release = resolve; });
  return { entered, release, async wait(signal) {
    enter(); signal.throwIfAborted();
    let aborted;
    try { await Promise.race([ready, new Promise((_, reject) => { aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true }); })]); }
    finally { signal.removeEventListener('abort', aborted); }
  } };
}
