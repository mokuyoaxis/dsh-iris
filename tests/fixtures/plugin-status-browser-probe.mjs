import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadCorePluginRegistry } from '@mokuyoaxis/dsh-iris/plugins';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { loadCorePluginFixture } from './core-plugin-fixture.mjs';

/** Actual owner DOM + HTTP, isolated service/roots only. No plugin execution or model probe. */
export async function verifyPluginStatusBrowser({ out, dataRoot, cdp, evaluate, click, wait, chooseToken, report, save, dimensions, measure, capture, pausedResponses, restart, tree }) {
  const result = report.pluginStatus = { status: 'running', checks: [], actualPaidCalls: 0 };
  const fixture = await loadCorePluginFixture();
  const entry = path.join(fixture.directory, 'status.mjs');
  fs.writeFileSync(entry, fs.readFileSync(fixture.entry, 'utf8').replace("title: 'Import an image'", "title: 'Import <img src=x onerror=alert(1)>'"), { flag: 'wx' });
  const registry = await loadCorePluginRegistry({ entries: [entry] });
  const connectionStore = path.join(out, 'plugin-status-connections');
  const selected = { pluginRegistry: registry, allowedOperations: ['example.media.import'], panelContributions: { pages: ['example.media.library'] },
    allowConnectionManagement: true, connectionStore };
  let session;
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const ready = () => wait(() => evaluate("!document.querySelector('#plugins-refresh').disabled&&!document.querySelector('#plugins-updated').hidden"), 'plugin status loaded');
  async function login({ openStatus = true } = {}) {
    const file = path.join(out, 'plugin-status-owner-' + crypto.randomUUID()); writeLocalApiTokenFile(file, session.accessToken, dataRoot);
    await cdp('Page.navigate', { url: 'about:blank' }); const navigation = await cdp('Page.navigate', { url: session.origin + '/' });
    await wait(async () => (await cdp('Page.getFrameTree')).frameTree.frame.loaderId === navigation.loaderId
      && evaluate("document.readyState!=='loading'&&document.querySelector('#connection')?.hidden===false&&document.documentElement.dataset.startup==='ready'"), 'current status login document');
    await chooseToken(file); await wait(() => evaluate("document.body.classList.contains('connected')"), 'status owner');
    if (openStatus) { await click('#plugins-tab'); await ready(); }
  }
  const post = async (route, value) => {
    const response = await fetch(session.origin + '/api/v0/connection-management/' + route, { method: 'POST',
      headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert(response.ok, route + ' HTTP ' + response.status); return response.json();
  };
  const pause = async route => {
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + route, requestStage: 'Request' }] });
    await click('#plugins-refresh'); await wait(() => pausedResponses.length > 0, 'controlled pending ' + route); return pausedResponses.shift();
  };
  const releaseCanceled = async requestId => {
    try { await cdp('Fetch.continueRequest', { requestId }); }
    catch (error) { assert.match(error.message, /Invalid [Ii]nterception[Ii]d/); }
    await cdp('Fetch.disable');
  };
  try {
    session = await restart(selected);
    const pin = registry.dependency('operations', 'example.media.import'), tools = ['iris_core_plugin_catalog', 'iris_core_plugin_call'];
    const records = [];
    for (const [label, scopes, selectedTools] of [['只读客户端', ['read'], tools], ['缺少工具客户端', ['read', 'execute'], ['iris_core_plugin_catalog']], ['创作客户端', ['read', 'execute'], tools]]) {
      const key = crypto.randomUUID(); await post('connections', { key, label, scopes, capabilities: [], tools: selectedTools, pluginOperations: [pin] });
      records.push({ connectionId: key, label, scopes, capabilities: [], tools: selectedTools, pluginOperations: [pin], revision: 1 });
    }
    const before = tree(dataRoot), start = report.requests.length;
    await login();
    await check('dedicated plugin navigation and loaded plugin details are folded by default', "document.body.dataset.page==='plugins'&&document.querySelector('#plugins-tab').getAttribute('aria-current')==='page'&&document.querySelectorAll('.plugin-status-card').length===1&&![...document.querySelectorAll('#plugins-panel details')].some(n=>n.open)");
    await capture('plugins-folded-light'); await click('.plugin-status-card>summary');
    await check('compatibility, actual mount and inactive declarations remain distinct', "document.querySelector('#plugins-list').textContent.includes('0.3.0-alpha.1 ≤ 版本 < 0.4.0')&&document.querySelector('#plugins-list').textContent.includes('已选入工作台')&&document.querySelector('#plugins-list').textContent.includes('未选入工作台')&&document.querySelector('#plugins-list').textContent.includes('服务未启用')&&document.querySelector('#plugins-list').textContent.includes('模型服务另行配置与实测')");
    await check('actual grants explain scope, tool and permitted-but-untested states', "document.querySelectorAll('.plugin-grant[data-status=scope]').length===1&&document.querySelectorAll('.plugin-grant[data-status=tool]').length===1&&document.querySelectorAll('.plugin-grant[data-status=permitted]').length===1&&document.querySelector('#plugins-list').textContent.includes('授权允许执行 · 未实测')&&document.querySelector('#plugins-list').textContent.includes('当前无握手实例记录')");
    await check('plugin titles stay text without injected elements', "document.querySelector('#plugins-list').textContent.includes('<img src=x onerror=alert(1)>')&&!document.querySelector('#plugins-list img')");
    await measure('plugins-wide'); await capture('plugins-open-light');
    await dimensions(390, 844); await measure('plugins-390'); await capture('plugins-390');
    await dimensions(320, 740); await measure('plugins-320'); await capture('plugins-320');
    await dimensions(1366, 900); await click('#appearance-open');
    await evaluate("(()=>{const n=document.querySelector('#appearance-theme');n.value='dark';n.dispatchEvent(new Event('input',{bubbles:true}));})()"); await click('#appearance-close');
    await check('plugin cards share the live workbench dark theme', "document.documentElement.dataset.theme==='dark'&&getComputedStyle(document.querySelector('.plugin-status-card')).backgroundColor!=='rgb(255, 255, 255)'");
    await capture('plugins-open-dark');
    await click('#plugins-connections'); await check('authorization action opens existing connection management', "document.body.dataset.page==='connections'&&!document.querySelector('#connections-panel').hidden");
    await click('#plugins-tab'); await ready();
    await post('connections/' + records[2].connectionId + '/update', { ...Object.fromEntries(['label', 'capabilities', 'tools', 'pluginOperations'].map(key => [key, records[2][key]])), expectedRevision: 1, scopes: ['read'] });
    await post('connections/' + records[1].connectionId + '/revoke', { expectedRevision: 1 });
    await click('#plugins-refresh'); await ready(); await click('.plugin-status-card>summary');
    await check('explicit refresh reads real permission reduction and revocation', "document.querySelectorAll('.plugin-grant[data-status=scope]').length===2&&document.querySelectorAll('.plugin-grant[data-status=revoked]').length===1&&!document.querySelector('.plugin-grant[data-status=permitted]')");
    const held = await pause('/api/v0/connection-management/connections');
    await cdp('Fetch.fulfillRequest', { requestId: held, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify({ error: { code: 'IRIS_API_BUSY', message: 'Controlled read unavailable' } })).toString('base64') }); await cdp('Fetch.disable');
    await wait(() => evaluate("!document.querySelector('#plugins-refresh').disabled&&!document.querySelector('#plugins-authorizations-note').hidden"), 'partial read error');
    await check('failed authorization read retains loaded catalog but marks the count unknown', "document.querySelectorAll('.plugin-status-card').length===1&&document.querySelector('#plugins-stats').textContent.includes('未知')&&document.querySelector('#plugins-authorizations-note').textContent.includes('IRIS_API_BUSY')");
    const failedCatalog = await pause('/api/v0/capabilities');
    await cdp('Fetch.fulfillRequest', { requestId: failedCatalog, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify({ error: { code: 'IRIS_API_UNAVAILABLE', message: 'Controlled catalog unavailable' } })).toString('base64') }); await cdp('Fetch.disable');
    await wait(() => evaluate("!document.querySelector('#plugins-refresh').disabled&&!document.querySelector('#plugins-feedback').hidden"), 'catalog read error');
    await check('failed catalog read shows its code without stale success, counts or an empty-directory claim', "document.querySelector('#plugins-feedback').textContent.includes('IRIS_API_UNAVAILABLE')&&!document.querySelector('#plugins-list').childElementCount&&!document.querySelector('#plugins-stats').childElementCount&&document.querySelector('#plugins-empty').hidden&&document.querySelector('#plugins-updated').hidden");
    const pending = await pause('/api/v0/capabilities'); await click('#studio-tab');
    await releaseCanceled(pending);
    await check('leaving aborts the pending read without reopening the diagnostics page', "document.body.dataset.page==='studio'&&document.querySelector('#plugins-panel').hidden&&!document.querySelector('#plugins-refresh').disabled");
    await click('#plugins-tab'); await ready();
    const logout = await pause('/api/v0/capabilities'); await click('#disconnect');
    await releaseCanceled(logout);
    await check('logout clears private diagnostics even when a read was pending', "!document.body.classList.contains('connected')&&document.querySelector('#plugins-panel').hidden&&!document.querySelector('#plugins-list').childElementCount&&!document.querySelector('#plugins-stats').childElementCount");
    assert(report.requests.slice(start).filter(item => item.url.includes('/api/')).every(item => item.method === 'GET'), 'the diagnostics UI performs only reads');
    assert(!report.requests.slice(start).some(item => item.url.includes('/plugin-assets/')), 'discovery does not import plugin UI modules');
    assert.deepEqual(tree(dataRoot), before, 'diagnostics and grant editing preserve business files');
    result.checks.push('browser actions use only existing GET routes, never import plugin code or alter Core business bytes'); save();

    session = await restart({ pluginRegistry: registry, allowConnectionManagement: true, connectionStore }); await login();
    await click('.plugin-status-card>summary');
    await check('a loaded plugin without service execution remains explicitly disabled', "document.querySelector('#plugins-list').textContent.includes('服务未启用')&&document.querySelectorAll('#plugins-stats dd')[1].textContent==='0'&&document.querySelectorAll('.plugin-grant[data-status=disabled]').length===2");
    await registry.dispose(); await click('#plugins-refresh'); await ready(); await click('.plugin-status-card>summary');
    await check('closed registry keeps identity records while clearing active counts and invocation availability', "document.querySelector('.plugin-status-card>summary').textContent.includes('已关闭')&&document.querySelector('#plugins-stats dd').textContent==='0'&&document.querySelectorAll('.plugin-grant[data-status=closed]').length===2&&document.querySelector('#plugins-list').textContent.includes('当前不可用')");
    await capture('plugins-closed-dark');
    session = await restart({ allowConnectionManagement: true, connectionStore }); await login();
    await check('missing plugin preserves saved authorizations with explicit diagnostics', "!document.querySelector('#plugins-empty').hidden&&!document.querySelector('#plugins-missing-section').hidden&&document.querySelectorAll('#plugins-missing .plugin-grant').length===3&&document.querySelector('#plugins-missing').textContent.includes('业务未加载')");
    await capture('plugins-missing-dark');
    session = await restart({}); await login();
    await check('empty service without connection management or grants stays useful', "!document.querySelector('#plugins-empty').hidden&&document.querySelector('#plugins-connections').hidden&&document.querySelector('#plugins-authorizations-note').hidden&&!document.querySelector('#plugins-stats').textContent.includes('未知')");
    await capture('plugins-empty-dark');
    session = await restart({});
    const oldService = report.requests.length; await login({ openStatus: false });
    assert(!report.requests.slice(oldService).some(item => item.url.endsWith('/plugin-status.js')), 'normal login does not need the new module route');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/plugin-status.js', requestStage: 'Request' }] });
    await click('#plugins-tab'); await wait(() => pausedResponses.length > 0, 'older service missing script route');
    await cdp('Fetch.fulfillRequest', { requestId: pausedResponses.shift(), responseCode: 404, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"error":{"code":"IRIS_API_NOT_FOUND"}}').toString('base64') });
    await cdp('Fetch.disable');
    await wait(() => evaluate("document.querySelector('#plugins-feedback').textContent.includes('插件页面未能载入')"), 'explicit module load failure');
    await check('older running service without the new static route keeps login usable and reports a reload action', "document.body.classList.contains('connected')&&document.querySelector('#plugins-refresh').disabled&&document.querySelector('#plugins-feedback').textContent.includes('正常重启 Core 并刷新页面')");
    await click('#studio-tab');
    await check('missing diagnostics module leaves the creation page and logout usable', "!document.querySelector('#workspace').hidden&&!document.querySelector('#disconnect').hidden&&document.querySelector('#plugins-panel').hidden");
    await click('#disconnect');
    await check('logout also clears a failed lazy-load message', "!document.body.classList.contains('connected')&&document.querySelector('#plugins-feedback').hidden&&!document.querySelector('#plugins-feedback').textContent");
    result.status = 'passed'; save();
  } finally { await registry.dispose(); }
}
