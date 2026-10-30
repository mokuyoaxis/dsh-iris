import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { FLOW_RESULT } from './image-flow-fixture.mjs';

export async function verifyProviderWorkbenchBrowser({ out, dataRoot, session, cdp, evaluate, click, wait, chooseToken, report, save, dimensions, measure, capture, restart }) {
  const result = report.providerWorkbench = { checks: [] }, calls = [], config = path.join(out, 'providers.json');
  const upstream = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, path: request.url }); response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.method === 'GET' ? { data: [{ id: 'a' }, { id: 'b' }] }
      : { choices: [{ message: { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + FLOW_RESULT.toString('base64') } }] } }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  fs.writeFileSync(config, JSON.stringify({ providers: ['one', 'spare'].map(id => ({ id, name: id === 'one' ? '测试图片服务' : '备用服务', baseUrl,
    apiKey: 'browser-provider-secret', mediaProtocol: 'openai-chat-images', enabled: true,
    models: ['a', 'b'].map(id => ({ id, capabilities: ['image-gen'] })) })), assignments: { 'image-gen': { mode: 'auto', models: [] } } }), { mode: 0o600 });
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const ready = expression => evaluate(`document.readyState!=='loading'&&(${expression})`);
  const field = (id, value) => evaluate(`(()=>{const n=document.getElementById(${JSON.stringify(id)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const section = async name => { await wait(() => ready(`!document.querySelector('[data-provider-section="${name}"]').disabled`), 'model-service section enabled'); await click('[data-provider-section="' + name + '"]'); };
  try {
    session = await restart(config); const ownerFile = path.join(out, 'provider-owner.token'); writeLocalApiTokenFile(ownerFile, session.accessToken, dataRoot);
    await cdp('Page.navigate', { url: session.origin }); await wait(() => ready("!document.querySelector('#connection').hidden"), 'provider login page');
    await click('#paste-panel>summary'); await chooseToken(ownerFile);
    await wait(() => ready("document.body.classList.contains('connected')&&!document.querySelector('#providers-tab').hidden"), 'provider management login');
    await click('#providers-tab'); await wait(() => ready("document.querySelectorAll('#providers-list button').length===2&&!document.querySelector('#provider-new').disabled"), 'provider list');
    await check('model services have suppliers, global pools and health entry points; initial browsing calls no provider', "document.querySelectorAll('[data-provider-section]').length===3&&!document.querySelector('#provider-functions')");
    assert.equal(calls.length, 0);
    await click('#provider-new'); await field('provider-name', 'Unsaved provider'); await click('#provider-cancel');
    await wait(() => ready("!document.querySelector('#provider-close-confirm').hidden"), 'cancel provider draft confirmation');
    await click('#provider-close-cancel'); await check('cancel preserves the draft until explicit discard', "document.querySelector('#provider-name').value==='Unsaved provider'&&!document.querySelector('#provider-editor').hidden");
    await click('#provider-cancel'); await click('#provider-close-discard');
    await section('pools'); await wait(() => ready("!document.querySelector('#provider-pool-panel').hidden"), 'global pools');
    await fieldForFunction();
    async function fieldForFunction() { await evaluate("const n=document.querySelector('[data-function=\"image-gen\"]');n.value='manual';n.dispatchEvent(new Event('change',{bubbles:true}))"); }
    await click('#provider-assignments .function-policy:first-child .provider-rank-row:nth-of-type(2) input');
    await click('#provider-pool-save'); await wait(() => ready("document.querySelector('#provider-pool-save').disabled&&document.querySelector('#providers-feedback').textContent==='已保存。'"), 'pool saved');
    const saved = JSON.parse(fs.readFileSync(config)); assert.equal(saved.assignments['image-gen'].mode, 'manual'); assert.equal(saved.assignments['image-gen'].models.length, 1);
    result.checks.push('global pool saves separately with an actual ordered manual reference'); save();
    await section('health'); await wait(() => ready("document.querySelectorAll('#provider-spectrum button').length===6&&document.querySelector('[data-check-provider=\"one\"]')&&!document.querySelector('[data-check-provider=\"one\"]').disabled"), 'health spectrum');
    await check('six-colour spectrum separates candidates from recent success; details stay folded', "!document.querySelector('#provider-health-details').open&&document.querySelector('#provider-spectrum').textContent.includes('0 个近期成功')");
    await click('[data-check-provider="one"]'); await wait(() => ready("document.querySelector('#provider-monitors').textContent.includes('最近连接检查通过')"), 'explicit connection check');
    assert(calls.every(call => call.method === 'GET'));
    await check('directory success does not mark media verified', "document.querySelector('#provider-spectrum').textContent.includes('0 个近期成功')");
    await click('[data-monitor-provider="one"]'); await wait(() => ready("document.querySelector('[data-monitor-provider=\"one\"]').checked&&!document.querySelector('[data-check-provider=\"one\"]').disabled"), 'optional keepalive enabled');
    await click('[data-monitor-provider="one"]');
    await wait(() => ready("!document.querySelector('[data-monitor-provider=\"one\"]').checked&&!document.querySelector('[data-check-provider=\"one\"]').disabled"), 'optional keepalive disabled');
    await dimensions(390); await measure('provider-health-390'); await capture('provider-health-390');
    await click('[data-health-capability="image-gen"]');
    const postBefore = calls.filter(call => call.method === 'POST').length;
    await click('[data-probe-model]'); await wait(() => ready("!document.querySelector('#workspace').hidden&&document.querySelector('#edit-prompt').value.includes('圆形')"), 'explicit model test draft');
    assert.equal(calls.filter(call => call.method === 'POST').length, postBefore);
    await check('verification opens the exact model and local sample without submitting; final generation remains explicit', "document.querySelector('#model').value.includes('::')&&document.querySelector('#input-preview').src.startsWith('blob:')&&document.querySelector('#creation-feedback').textContent.includes('费用')");
    await click('#start-edit'); await wait(() => ready("!document.querySelector('#select-output').disabled"), 'actual durable validation image result');
    assert.equal(calls.filter(call => call.method === 'POST').length, postBefore + 1);
    result.checks.push('confirmed verification executes one real Core image flow and leaves the original Task/Operation available'); save();
    await click('#providers-tab'); await section('suppliers'); await wait(() => ready("!document.querySelector('#provider-new').disabled"), 'back to suppliers');
    await click('[data-provider-id="one"]'); await click('#provider-management-tools>summary'); await click('#provider-toggle');
    await wait(() => ready("document.querySelector('#provider-toggle').textContent==='恢复供应商'&&!document.querySelector('#provider-toggle').disabled"), 'provider disabled');
    await click('#provider-toggle'); await wait(() => ready("document.querySelector('#provider-toggle').textContent==='停用供应商'&&!document.querySelector('#provider-toggle').disabled"), 'provider restored');
    await click('#provider-cancel'); await click('[data-provider-id="spare"]'); await click('#provider-management-tools>summary'); await click('#provider-delete');
    await wait(() => ready("!document.querySelector('#provider-delete-confirm').hidden"), 'delete impact'); await click('#provider-delete-no');
    assert.equal(JSON.parse(fs.readFileSync(config)).providers.length, 2);
    await click('#provider-delete'); await wait(() => ready("!document.querySelector('#provider-delete-confirm').hidden"), 'delete impact again'); await click('#provider-delete-yes');
    await wait(() => ready("document.querySelectorAll('#providers-list button').length===1&&!document.querySelector('#provider-new').disabled"), 'confirmed provider removed');
    result.checks.push('provider disable/restore and impact-confirmed deletion work, including cancellation and saved model references'); save();
    await click('#connections-tab'); await wait(() => ready("!document.querySelector('#connection-new').disabled"), 'connections loaded'); await click('#connection-new');
    await field('connection-name', 'Unsaved harness'); await click('#connection-cancel');
    await wait(() => ready("!document.querySelector('#connection-leave-confirm').hidden"), 'connection cancel confirmation'); await click('#connection-leave-keep');
    await check('connection cancel keeps edits until explicit discard', "document.querySelector('#connection-name').value==='Unsaved harness'");
    await click('#connection-cancel'); await click('#connection-leave-discard');
    await click('#providers-tab'); await section('pools'); await measure('provider-pools-390'); await capture('provider-pools-390');
    await evaluate('window.scrollTo(0,document.documentElement.scrollHeight)');
    await check('logout stays in the visible sticky header after scrolling a long mobile page', "(()=>{const r=document.querySelector('#disconnect').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&getComputedStyle(document.querySelector('.site-header')).position==='sticky'})()");
    await dimensions(1366, 900); await section('health'); await measure('provider-health-desktop'); await capture('provider-health-desktop');
    await click('#appearance-open'); await field('appearance-theme', 'dark'); await click('#appearance-close'); await capture('provider-health-dark-desktop');
    await click('#disconnect'); await check('logout clears provider evidence and all private editor fields', "!document.body.classList.contains('connected')&&!document.querySelector('#provider-models').children.length&&!document.querySelector('#provider-monitors').children.length&&!document.querySelector('#provider-key').value");
    assert.equal(calls.filter(call => call.method === 'POST').length, 1); result.checks.push('no hidden media probes, no duplicate generation, and logout releases all private model-service views'); save();
  } finally { await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }); }
}
