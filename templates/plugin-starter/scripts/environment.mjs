// Acceptance helper: installed public SDK + CLI + HTTP. Not plugin runtime code.
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorePluginRegistry, createCorePluginRegistry, createCorePluginWorkbench, definePlugin } from '@mokuyoaxis/dsh-iris/plugins';
import plugin from '../index.mjs';
import { setup } from './setup.mjs';

export const businessId = plugin.manifest.id + '.create';
export async function createEnvironment() {
  const work = await mkdtemp(path.join(os.tmpdir(), 'iris-starter-')); await chmod(work, 0o700);
  const prepared = await setup(path.join(work, 'demo'));
  const config = JSON.parse(await readFile(prepared.configPath, 'utf8'));
  let api, registry, started, port;
  async function start({ present = true, enabled = true, version } = {}) {
    if (version) registry = await createCorePluginRegistry({ plugins: [definePlugin({
      manifest: { ...plugin.manifest, version }, activate: context => plugin.activate(context)
    })] });
    else registry = await loadCorePluginRegistry({ entries: present ? [prepared.entry] : [] });
    api = createCorePluginWorkbench({ dataRoot: prepared.dataRoot, registry,
      allowedOperations: present && enabled ? [businessId] : [], connectionStore: prepared.connectionStore, allowMcp: true,
      ...(present && !version ? { panelContributions: config.panel } : {}) });
    started = await api.start(port ? { port } : {}); port ??= Number(new URL(started.origin).port);
    return started;
  }
  async function close() { await api?.dispose(); api = undefined; await registry?.dispose(); registry = undefined; }
  async function raw(route, { value, key, headers, method = value === undefined ? 'GET' : 'POST' } = {}) {
    return fetch(started.origin + route, { method, headers: {
      Authorization: 'Bearer ' + started.accessToken, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(key ? { 'Idempotency-Key': key } : {}), ...headers
    }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(20_000) });
  }
  async function http(route, options, expected = 200) {
    const response = await raw(route, options), value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value)); return value;
  }
  async function terminal(id) {
    for (let i = 0; i < 300; i++) {
      const operation = (await http('/api/v0/operations/' + id)).operation;
      if (!['queued', 'running'].includes(operation.state)) return operation;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Operation did not finish');
  }
  const pin = () => registry.dependency('operations', businessId);
  const request = () => ({ key: crypto.randomUUID(), operationId: businessId, dependency: pin(),
    input: { artifactIds: prepared.artifactIds, columns: 2, cellSize: 128 } });
  const submit = ({ key, ...value }, expected = 202) => http('/api/v0/plugin-operations', { key, value }, expected);
  const base = '/api/v0/connection-management/connections';
  async function connection(pins = [pin()]) {
    const result = await http(base, { value: { key: crypto.randomUUID(), label: 'Independent starter test',
      scopes: ['read', 'execute', 'stop'], capabilities: [], pluginOperations: pins } }, 201);
    return (await http(base)).connections.find(item => item.connectionId === result.connectionId);
  }
  const exported = record => http(base + '/' + record.connectionId + '/export', { value: { transport: 'http', format: 'entry' } });
  const update = (record, scopes) => http(base + '/' + record.connectionId + '/update', { value: {
    expectedRevision: record.revision, label: record.label, scopes, capabilities: record.capabilities,
    tools: record.tools, pluginOperations: record.pluginOperations
  } });
  return { work, prepared, config, start, close, raw, http, terminal, pin, request, submit, connection, exported, update,
    get registry() { return registry; }, get started() { return started; },
    templateRoot: fileURLToPath(new URL('..', import.meta.url)) };
}
