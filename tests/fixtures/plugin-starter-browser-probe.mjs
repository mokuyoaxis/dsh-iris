import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

/** Runs the copied/packed independent project, not the repository's plugin entry. */
export async function verifyPluginStarterBrowser({ out, cdp, evaluate, click, wait, report, save, dimensions, measure, capture }) {
  const project = process.env.IRIS_TEST_STARTER_PROJECT, sdkRoot = process.env.IRIS_TEST_MCP_CLIENT_SDK_ROOT;
  assert(project && path.isAbsolute(project), 'Set IRIS_TEST_STARTER_PROJECT to an independent installed template');
  assert(sdkRoot && path.isAbsolute(sdkRoot), 'Set IRIS_TEST_MCP_CLIENT_SDK_ROOT to an installed official MCP client');
  const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.mjs')));
  const { createEnvironment, businessId } = await import(pathToFileURL(path.join(project, 'scripts/environment.mjs')));
  const { runCore } = await import(pathToFileURL(path.join(project, 'scripts/core-cli.mjs')));
  const env = await createEnvironment(), result = report.pluginStarter = { status: 'running', checks: [], project, work: env.work, actualPaidCalls: 0 };
  const root = "document.querySelector('#plugin-page-slot .plugin-surface')?.shadowRoot";
  const preview = "document.querySelector('#plugin-preview-slot .plugin-surface')?.shadowRoot";
  const nav = '[data-page="plugin:example.starter-board.board"]';
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  let client;
  async function login() {
    await cdp('Page.navigate', { url: 'about:blank' }); await cdp('Page.navigate', { url: env.started.loginUrl });
    await wait(() => evaluate("document.querySelector('#connection')?.hidden&&Boolean(document.querySelector('[data-page=\"plugin:example.starter-board.board\"]'))"), 'independent workbench login');
  }
  async function board() {
    await click(nav);
    await wait(() => evaluate(`${root}?.querySelectorAll('.starter-choice img').length>=2&&[...${root}.querySelectorAll('.starter-choice img')].every(n=>n.naturalWidth>0)`), 'independent source images');
  }
  try {
    // A public, unexecuted edit draft gives the native Run viewer a source PNG
    // for exercising the real renderer slot. No generation or remote request.
    const config = path.join(out, 'draft-provider.json');
    fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'preview', baseUrl: 'https://preview.invalid/v1', apiKey: 'test-only-no-account',
      mediaProtocol: 'openai-images', models: [{ id: 'edit', capabilities: ['image-gen'], imageProtocol: 'openai-chat-images' }] }],
    assignments: { 'image-gen': ['preview::edit'] } }), { mode: 0o600 });
    const draft = await runCore(env.prepared.dataRoot, 'flow', 'create', '--provider-config', config, '--input', JSON.stringify({
      source_artifact_id: env.prepared.artifactIds[0], model_ref: 'preview::edit', prompt: 'Unexecuted preview draft', n: 1
    }));
    await env.start(); await login(); await board();
    await check('copied package uses the real shared Core gallery, independent identity and folded instructions', `${root}.querySelector('h2').textContent.includes('灵感')&&!${root}.querySelector('details').open&&${root}.querySelector('[type=submit]').disabled`);
    await evaluate(`(()=>{const r=${root};r.querySelector('[value="${env.prepared.artifactIds[1]}"]').click();r.querySelector('[value="${env.prepared.artifactIds[0]}"]').click();r.querySelector('[name=size]').value='128';r.querySelector('form').requestSubmit();})()`);
    await wait(() => evaluate(`${root}?.querySelector('.starter-status').textContent.startsWith('对照板已保存')&&${root}.querySelector('.starter-result img')?.naturalWidth===292`), 'real independent business PNG');
    const operation = (await env.http('/api/v0/plugin-operations')).operations[0];
    assert.equal(operation.operationId, businessId); assert.deepEqual(operation.input.artifactIds, [...env.prepared.artifactIds].reverse());
    const bytes = Buffer.from(await (await env.raw('/api/v0/artifacts/' + operation.result.artifactIds[0] + '/content')).arrayBuffer());
    const pixels = await sharp(bytes).removeAlpha().raw().toBuffer();
    assert.deepEqual([...pixels.subarray((60 * 292 + 60) * 3, (60 * 292 + 60) * 3 + 3)], [229, 155, 118]);
    assert.deepEqual([...pixels.subarray((60 * 292 + 200) * 3, (60 * 292 + 200) * 3 + 3)], [111, 105, 184]);
    result.checks.push('browser-selected order is proved by the real Core PNG pixels, not a placeholder result'); save();
    await check('submitted inputs are locked and original download is available', `${root}.querySelector('[name=columns]').disabled&&${root}.querySelector('.starter-result a').download.endsWith('.png')`);
    await measure('starter-wide'); await capture('starter-light');
    await dimensions(390, 844); await measure('starter-390'); await capture('starter-mobile');
    await dimensions(320, 740); await measure('starter-320');
    await check('narrow-screen plugin controls remain inside the viewport', `[...${root}.querySelectorAll('button,select')].every(n=>!n.getClientRects().length||n.getBoundingClientRect().right<=innerWidth+1&&n.getBoundingClientRect().left>=0)`);
    await dimensions(1366, 900);
    await click('#appearance-open');
    await evaluate("(()=>{const n=document.querySelector('#appearance-theme');n.value='dark';n.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await click('#appearance-close');
    await wait(() => evaluate(`${root}?.querySelector('.plugin-content').dataset.theme==='dark'`), 'starter theme subscription');
    await check('shared dark theme preserves result and uses the declared Iris tokens', `${root}.querySelector('.starter-result img').naturalWidth===292&&getComputedStyle(${root}.querySelector('select')).backgroundColor!=='rgba(0, 0, 0, 0)'`);
    await capture('starter-dark');
    const blobUrls = await evaluate(`[...${root}.querySelectorAll('img')].map(n=>n.src)`);
    await click('#connections-tab');
    await wait(() => evaluate(`${JSON.stringify(blobUrls)}.every(url=>!window.testBlobs.has(url))`), 'page abort releases source/result URLs');
    result.checks.push('leaving the page releases its source and output object URLs'); save();
    await board();
    await wait(() => evaluate(`${root}?.querySelector('.starter-result img')?.naturalWidth===292`), 'same UUID after remount');
    await cdp('Page.reload');
    await wait(() => evaluate("document.querySelector('#connection')?.hidden&&Boolean(document.querySelector('[data-page=\"plugin:example.starter-board.board\"]'))"), 'retained browser authentication');
    await board();
    await wait(() => evaluate(`${root}?.querySelector('.starter-result img')?.naturalWidth===292`), 'UUID after refresh');
    assert.equal((await env.http('/api/v0/plugin-operations')).operations.length, 1);
    result.checks.push('page remount and full refresh recover one original UUID/Operation without another write'); save();
    await evaluate(`(()=>{const r=${root};[...r.querySelectorAll('button')].find(n=>n.textContent==='新建一张').click();r.querySelector('[value="${env.prepared.artifactIds[0]}"]').click();window.starterSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('example.starter-board.create:'))throw new DOMException('Controlled blocked storage','SecurityError');return window.starterSetItem.call(this,key,value)};r.querySelector('form').requestSubmit();})()`);
    await wait(() => evaluate(`${root}?.querySelector('.starter-status').textContent.includes('本次未提交')`), 'blocked UUID storage is an explicit no-submit failure');
    assert.equal((await env.http('/api/v0/plugin-operations')).operations.length, 1);
    await evaluate('Storage.prototype.setItem=window.starterSetItem;delete window.starterSetItem');
    result.checks.push('blocked browser UUID storage shows a clear error and performs zero business writes'); save();
    await cdp('Page.navigate', { url: env.started.origin + '/#' + draft.run.id });
    await wait(() => evaluate("!document.querySelector('#source-image').hidden&&document.querySelector('#source-image').naturalWidth===32&&!document.querySelector('#plugin-preview').hidden"), 'real unexecuted source Run');
    await click('#plugin-preview>summary');
    await evaluate("(()=>{const n=document.querySelector('#plugin-renderer');n.value='example.starter-board.png';n.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await wait(() => evaluate(`${preview}?.querySelector('img')?.naturalWidth===32`), 'template PNG renderer in native slot');
    await check('declared PNG renderer mounts in the real Core slot with original bytes and shared dark theme', `${preview}.querySelector('.plugin-content').dataset.theme==='dark'&&${preview}.querySelector('p').textContent.includes('32 × 32')`);
    const rendererUrl = await evaluate(`${preview}.querySelector('img').src`);
    await click('#plugin-preview>summary');
    await wait(() => evaluate(`!window.testBlobs.has(${JSON.stringify(rendererUrl)})&&!document.querySelector('#plugin-preview-slot .plugin-surface')`), 'renderer unmount releases its URL');
    result.checks.push('native preview collapse aborts and releases the independent renderer'); save();
    await click('#connections-tab'); await click('#connection-new');
    await check('actual Web connection form starts with the independent business unselected', "document.querySelectorAll('#connection-plugin-options input').length===1&&!document.querySelector('#connection-plugin-options input').checked");
    await click('#connection-media input[value="image"]'); await click('#connection-plugin-options input');
    await click('#connection-scopes input[value="execute"]');
    await evaluate("document.querySelector('#connection-name').value='Independent starter consumer'"); await click('#connection-save');
    await wait(() => evaluate("document.querySelectorAll('#connections-list .connection-item').length===1&&!document.querySelector('#connection-save').disabled"), 'saved explicit connection');
    const record = (await env.http('/api/v0/connection-management/connections')).connections[0];
    assert.deepEqual(record.capabilities, []); assert.equal(record.pluginOperations[0].contributionId, businessId);
    const exported = (await env.exported(record)).configuration;
    client = new Client({ name: 'Independent archive consumer', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(exported.url), { requestInit: { headers: exported.headers } }));
    assert((await client.listTools()).tools.some(item => item.name === 'iris_core_plugin_call'));
    const response = await client.callTool({ name: 'iris_core_plugin_call', arguments: env.request() });
    assert(!response.isError); const invoked = await env.terminal(response.structuredContent.operation.id); assert.equal(invoked.state, 'succeeded');
    result.checks.push('Web-selected independent contribution executes through the official MCP client and real persistent Core'); save();
    await client.close(); client = undefined;
    await env.close(); await env.start({ present: false });
    await cdp('Page.navigate', { url: env.started.loginUrl });
    await wait(() => evaluate("document.querySelector('#connection')?.hidden&&Boolean(document.querySelector('[data-page=\"plugin-history\"]'))"), 'history after missing-plugin restart');
    await check('restart without the independent package removes its page and retains Core history', "!document.querySelector('[data-page=\"plugin:example.starter-board.board\"]')&&Boolean(document.querySelector('[data-page=\"plugin-history\"]'))");
    await click('[data-page="plugin-history"]');
    await wait(() => evaluate("document.querySelectorAll('#plugin-history-list .plugin-history-item').length===2"), 'saved independent business history');
    await click('#plugin-history-list button');
    await wait(() => evaluate("document.querySelector('#plugin-history-list img')?.naturalWidth===292"), 'saved original board without implementation');
    result.checks.push('original PNG still previews in Core history after independent implementation removal');
    result.status = 'passed'; save();
  } finally { await client?.close(); await env.close(); }
}
