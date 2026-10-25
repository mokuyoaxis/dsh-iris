import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-gallery'), dataRoot = path.join(root, 'core');
const fixture = imageFlowFixture(dataRoot), app = createApplicationRuntime({ dataRoot, ...fixture });
const secondFixture = imageFlowFixture(dataRoot), second = createApplicationRuntime({ dataRoot, ...secondFixture });
const api = createLocalReadApi({ dataRoot });
const tree = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true }).filter(name => fs.lstatSync(path.join(dataRoot, name)).isFile())
  .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(dataRoot, name))).digest('hex')]));
try {
  await app.execute('flow.init', {});
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const ids = [];
  for (let index = 0; index < 7; index++) ids.push((await app.execute('flow.create', {
    source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'PRIVATE_GALLERY_PROMPT_' + index
  })).run.id);
  const completed = await app.execute('flow.continue', { run_id: ids[0] });
  await app.execute('flow.select', { run_id: ids[0], artifact_id: completed.run.output.artifactId });
  const other = await second.execute('flow.continue', { run_id: ids[1] });
  await app.execute('flow.select', { run_id: ids[1], artifact_id: source.id });
  const session = await api.start(), headers = { Authorization: 'Bearer ' + session.accessToken };
  const before = tree(), events = readFlowEvents(dataRoot), cliBefore = await app.execute('flow.list', {});
  assert(!Object.hasOwn(cliBefore.runs[0], 'selection'), 'HTTP projection does not expand CLI/MCP summaries');
  async function get(query) {
    const response = await fetch(session.origin + '/api/v0/runs' + query, { headers });
    const value = await response.json(); return { status: response.status, value, headers: response.headers };
  }
  for (const [filter, expected] of [['all', 7], ['selected', 2], ['unselected', 5]]) {
    const seen = [], pages = []; let cursor;
    do {
      const result = await get('?' + new URLSearchParams({ selection: filter, limit: '1', ...(cursor ? { cursor } : {}) }));
      assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal(result.value.total, expected); assert.deepEqual(result.value.counts, { all: 7, selected: 2, unselected: 5 });
      for (const run of result.value.runs) {
        assert.deepEqual(Object.keys(run).sort(), ['id', 'recipe', 'createdAt', 'updatedAt', 'revision', 'modelRef', 'source', 'output', 'selection'].sort());
        assert.equal(run.modelRef, FLOW_MODEL); assert.equal(typeof run.revision, 'number');
        assert.equal(run.source.artifactId, source.id);
        if (filter !== 'all') assert.equal(Boolean(run.selection), filter === 'selected');
      }
      assert(!JSON.stringify(result.value).includes('PRIVATE_GALLERY_PROMPT')); assert(!JSON.stringify(result.value).includes('providerBinding'));
      seen.push(...result.value.runs.map(run => run.id)); pages.push(...result.value.runs); cursor = result.value.nextCursor;
    } while (cursor);
    assert.equal(new Set(seen).size, expected);
    if (filter === 'selected') {
      assert.equal(pages.find(run => run.id === ids[0]).selection.artifactId, completed.run.output.artifactId);
      assert.equal(pages.find(run => run.id === ids[1]).selection.artifactId, source.id);
      assert.equal(pages.find(run => run.id === ids[1]).output.artifactId, other.run.output.artifactId);
    }
  }
  for (const query of ['?selection=', '?selection=unknown', '?selection=all&selection=selected',
    '?selection=selected&cursor=' + ids[6], '?selection=unselected&cursor=' + ids[0], '?selection=all&limit=31']) {
    assert.equal((await get(query)).status, 400, query);
  }
  assert.deepEqual((await get('')).value, (await get('?selection=all')).value, 'omitted filter retains the complete list');
  assert.equal((await fetch(session.origin + '/api/v0/runs?selection=selected')).status, 401);
  assert.deepEqual(tree(), before); assert.deepEqual(readFlowEvents(dataRoot), events);
  assert.deepEqual(await app.execute('flow.list', {}), cliBefore);
  console.log('PASS gallery API: real selections, filtering before pagination/counts, finite private summary, cursor isolation, no CLI/MCP expansion, no writes or Provider calls');
} finally { await api.dispose(); await app.dispose(); await second.dispose(); }
