import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { createBusinessEnvironment } from './plugin-business-consumer.mjs';

/** Publicly assembled business + production DOM + official MCP client. No server-side tool fixture. */
export async function verifyPluginBusinessBrowser({ cdp, evaluate, click, wait, report, save, dimensions, measure, capture }) {
  const sdkRoot = process.env.IRIS_TEST_MCP_CLIENT_SDK_ROOT;
  assert(sdkRoot && path.isAbsolute(sdkRoot), 'Set IRIS_TEST_MCP_CLIENT_SDK_ROOT to an installed official client SDK');
  assert.equal(JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'))).name, '@modelcontextprotocol/client');
  const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.mjs')));
  const env = await createBusinessEnvironment(), result = report.pluginBusiness = { status: 'running', checks: [], actualPaidCalls: 0, work: env.work };
  const root = "document.querySelector('#plugin-page-slot .plugin-surface')?.shadowRoot";
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  let client;
  const parse = value => { assert(!value.isError, JSON.stringify(value)); return value.structuredContent; };
  async function login() {
    await cdp('Page.navigate', { url: 'about:blank' }); await cdp('Page.navigate', { url: env.started.loginUrl });
    await wait(() => evaluate("document.querySelector('#connection')?.hidden&&!document.querySelector('#workspace-nav').hidden"), 'public plugin workbench login');
  }
  try {
    await env.start(); await login();
    await wait(() => evaluate("Boolean(document.querySelector('[data-page=\"plugin:community.contact-sheet.board\"]'))"), 'real business navigation');
    await click('[data-page="plugin:community.contact-sheet.board"]');
    await wait(() => evaluate(`${root}?.querySelectorAll('.image-choice img').length===2&&[...${root}.querySelectorAll('.image-choice img')].every(n=>n.naturalWidth===32)`), 'two actual source images');
    await check('real business entry uses shared Panel session and existing Core image bytes', `${root}.querySelector('h2').textContent.includes('灵感')&&${root}.querySelector('button[type=submit]').disabled`);
    await evaluate(`(()=>{const r=${root};r.querySelector('[value="${env.sources[1]}"]').click();r.querySelector('[value="${env.sources[0]}"]').click();r.querySelector('[name=columns]').value='2';r.querySelector('[name=size]').value='128';r.querySelector('form').requestSubmit();})()`);
    await wait(() => evaluate(`${root}?.querySelector('[data-board-status]')?.textContent.startsWith('对照板已保存')&&${root}.querySelector('.board-result img')?.naturalWidth===292`), 'real Sharp contact sheet');
    await check('success has durable Operation identity, locked submitted inputs and an original PNG download', `${root}.querySelector('[data-board-status]').textContent.includes('op_')&&${root}.querySelector('[name=columns]').disabled&&${root}.querySelector('.board-result a').download.endsWith('.png')`);
    const facts = (await env.http('/api/v0/plugin-operations')).operations;
    assert.equal(facts.length, 1); assert.deepEqual(facts[0].input.artifactIds, [env.sources[1], env.sources[0]]);
    const bytes = Buffer.from(await (await env.raw('/api/v0/artifacts/' + facts[0].result.artifactIds[0] + '/content')).arrayBuffer());
    const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = x => [...data.subarray((60 * info.width + x) * info.channels, (60 * info.width + x) * info.channels + 3)];
    assert.deepEqual(pixel(60), [0, 0, 240]); assert.deepEqual(pixel(200), [240, 0, 0]);
    result.checks.push('browser selection order is reflected in real Core-stored output pixels'); save();
    await measure('business-wide'); await capture('contact-sheet-wide');
    await dimensions(390, 844); await measure('business-mobile'); await capture('contact-sheet-mobile'); await dimensions(1366, 900);
    await cdp('Page.reload');
    await wait(() => evaluate("document.querySelector('#connection')?.hidden&&Boolean(document.querySelector('[data-page=\"plugin:community.contact-sheet.board\"]'))"), 'business authenticated refresh');
    await click('[data-page="plugin:community.contact-sheet.board"]');
    await wait(() => evaluate(`${root}?.querySelector('.board-result img')?.naturalWidth===292`), 'original operation restored after page reload');
    assert.equal((await env.http('/api/v0/plugin-operations')).operations.length, 1);
    result.checks.push('refresh recovers the original UUID/result and performs no second business write'); save();

    await click('#connections-tab'); await click('#connection-new');
    await check('business choice starts unchecked and installation does not authorize a client', "document.querySelectorAll('#connection-plugin-options input').length===1&&!document.querySelector('#connection-plugin-options input').checked");
    await click('#connection-media input[value="image"]');
    await click('#connection-plugin-options input'); await click('#connection-scopes input[value="execute"]'); await click('#connection-scopes input[value="stop"]');
    await evaluate("document.querySelector('#connection-name').value='My contact-sheet client'"); await click('#connection-save');
    await wait(() => evaluate("document.querySelectorAll('#connections-list .connection-item').length===1&&!document.querySelector('#connection-save').disabled"), 'user-selected business connection persisted');
    const record = (await env.http('/api/v0/connection-management/connections')).connections[0];
    assert.deepEqual(record.capabilities, []); assert.equal(record.pluginOperations[0].contributionId, 'community.contact-sheet.create'); assert(record.scopes.includes('execute'));
    await evaluate("(()=>{const n=document.querySelector('#connection-transport');n.value='http';n.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#connection-format').value='entry';})()");
    await click('#connection-export-button'); await wait(() => evaluate("!document.querySelector('#connection-export-result').hidden"), 'public HTTP MCP configuration');
    const configuration = JSON.parse(await evaluate("document.querySelector('#connection-configuration').value"));
    client = new Client({ name: 'Browser-selected independent MCP consumer', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(configuration.url), { requestInit: { headers: configuration.headers } }));
    const names = (await client.listTools()).tools.map(item => item.name); assert.equal(names.length, 8); assert(names.includes('iris_core_plugin_call'));
    const catalog = parse(await client.callTool({ name: 'iris_core_plugin_catalog', arguments: {} }));
    const accepted = parse(await client.callTool({ name: 'iris_core_plugin_call', arguments: { key: crypto.randomUUID(), operationId: record.pluginOperations[0].contributionId,
      dependency: catalog.operations[0].dependency, input: env.input() } }));
    const operation = await env.terminal(accepted.operation.id); assert.equal(operation.state, 'succeeded');
    const image = (await client.callTool({ name: 'iris_core_image', arguments: { artifactId: operation.result.artifactIds[0] } })).content.find(item => item.type === 'image');
    assert.equal((await sharp(Buffer.from(image.data, 'base64')).metadata()).width, 292);
    result.checks.push('connection selected in the actual Web UI exports usable MCP configuration; official client discovers eight permitted tools and executes this real business'); save();
    await client.close(); client = null;
    await click('[data-connection-view="settings"]'); await click('#connection-scopes input[value="execute"]'); await click('#connection-save');
    await wait(() => evaluate("document.querySelector('#connections-feedback').textContent.includes('更改已保存')"), 'Web permission reduction');
    const reduced = (await env.http('/api/v0/connection-management/connections')).connections[0]; assert.deepEqual(reduced.scopes, ['read', 'stop']);
    const readConfig = (await env.exported(reduced)).configuration;
    client = new Client({ name: 'Reduced business consumer', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(readConfig.url), { requestInit: { headers: readConfig.headers } }));
    assert(!(await client.listTools()).tools.some(item => item.name === 'iris_core_plugin_call'));
    await client.close(); client = null; result.checks.push('reducing execution authority in Web removes the business call from real MCP discovery'); save();

    await env.close(); await env.start({ present: false }); await login();
    await wait(() => evaluate("Boolean(document.querySelector('[data-page=\"plugin-history\"]'))"), 'history without plugin');
    await check('missing plugin removes its page while Core keeps a history entry', "!document.querySelector('[data-page=\"plugin:community.contact-sheet.board\"]')&&Boolean(document.querySelector('[data-page=\"plugin-history\"]'))");
    await click('[data-page="plugin-history"]');
    await wait(() => evaluate("document.querySelectorAll('#plugin-history-list .plugin-history-item').length===2"), 'saved business history without implementation');
    await click('#plugin-history-list button');
    await wait(() => evaluate("document.querySelector('#plugin-history-list img')?.naturalWidth===292"), 'original saved output without plugin');
    await measure('business-history'); await capture('contact-sheet-history-no-plugin');
    result.checks.push('after Core restart with no business plugin, its saved Operations and actual PNG preview remain available in the Core history page');
    result.status = 'passed'; save();
  } finally { await client?.close(); await env.close(); }
}
