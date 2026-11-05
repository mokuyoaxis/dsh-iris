import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

export async function verifyProviderCredentialsBrowser({ out, cdp, evaluate, click, wait, report, save, dimensions, measure, capture, restart }) {
  const envName = 'IRIS_BROWSER_CREDENTIAL_' + crypto.randomUUID().replaceAll('-', '').toUpperCase();
  const secret = 'browser-only-fixture-' + crypto.randomUUID(), calls = [], config = path.join(out, 'env-providers.json');
  const result = report.providerCredentials = { status: 'running', checks: [], paidCalls: 0 };
  const upstream = http.createServer((request, response) => {
    calls.push({ path: request.url, authenticated: request.headers.authorization === 'Bearer ' + secret });
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'image-model' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(config, JSON.stringify({ providers: [], assignments: {} }), { mode: 0o600 });
  const raw = () => JSON.parse(fs.readFileSync(config));
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const field = (id, value) => evaluate(`(()=>{const n=document.getElementById(${JSON.stringify(id)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));if(n.tagName==='SELECT')n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  async function loaded() { await wait(() => evaluate("document.querySelector('#providers-feedback')?.textContent.includes('已保存')&&!document.querySelector('#provider-save').disabled"), 'credential save completed'); }
  async function refresh() {
    await click('#providers-refresh');
    await wait(() => evaluate("document.querySelectorAll('#providers-list .provider-item').length===1&&!document.querySelector('#providers-refresh').disabled"), 'credential state refreshed');
    await click('#providers-list .provider-item');
  }
  try {
    const session = await restart(config);
    await cdp('Page.navigate', { url: session.loginUrl });
    await wait(() => evaluate("document.querySelector('#connection')?.hidden&&!document.querySelector('#providers-tab').hidden"), 'credential workbench login');
    await click('#providers-tab'); await wait(() => evaluate("!document.querySelector('#provider-new').disabled"), 'provider configuration ready');
    await click('#provider-new'); await field('provider-name', '环境变量媒体服务');
    await field('provider-url', 'http://127.0.0.1:' + upstream.address().port + '/v1');
    await field('provider-key-action', 'env'); await field('provider-key-env', envName);
    await check('environment mode asks only for a variable name and keeps the password field hidden', "!document.querySelector('#provider-key-env-field').hidden&&document.querySelector('#provider-key-env').required&&!document.querySelector('#provider-key-env').readOnly&&document.querySelector('#provider-key-field').hidden&&!document.querySelector('#provider-key').required");
    await click('#provider-save'); await loaded();
    assert.equal(raw().providers[0].apiKeyEnv, envName); assert.equal(raw().providers[0].apiKey, undefined); assert.equal(calls.length, 0);
    await check('saving an absent variable keeps a readable reference and clear unavailable status, without a network probe', "document.querySelector('#provider-key-state').textContent.includes('未就绪')&&document.querySelector('#provider-key-env').readOnly&&document.querySelector('#provider-key-action').value==='keep'&&document.querySelector('.service-status').textContent==='环境凭据未就绪'");
    await field('provider-key-action', 'env'); await field('provider-key-env', envName + '_DISCARDED');
    await click('#provider-cancel'); await wait(() => evaluate("!document.querySelector('#provider-close-confirm').hidden"), 'discard credential draft confirmation');
    await click('#provider-close-discard'); assert.equal(raw().providers[0].apiKeyEnv, envName);
    result.checks.push('cancel/discard leaves the saved environment reference intact'); save();
    process.env[envName] = secret; await refresh();
    await check('refresh reads current readiness, preserves only the name and never fills the API key input', `document.querySelector('#provider-key-state').textContent.includes('已就绪')&&document.querySelector('#provider-key-env').value===${JSON.stringify(envName)}&&document.querySelector('#provider-key').value===''`);
    assert.equal(calls.length, 0);
    await click('[data-provider-view="models"]');
    await click('#provider-discover'); await wait(() => evaluate("!document.querySelector('#provider-directory').hidden&&!document.querySelector('#provider-discover').disabled"), 'explicit saved-provider discovery');
    assert.equal(calls.length, 1); assert.equal(calls[0].authenticated, true);
    assert(!fs.readFileSync(config, 'utf8').includes(secret));
    result.checks.push('explicit directory action sends the process key to the owned provider while configuration retains only the reference'); save();
    await click('[data-provider-view="connection"]');
    await field('provider-key-action', 'env'); await field('provider-key-env', envName + '_DRAFT');
    await field('provider-preset', 'comfyui'); await field('provider-preset', 'custom');
    await check('API/ComfyUI preset round-trip preserves the pending environment reference draft', `document.querySelector('#provider-key-action').value==='env'&&document.querySelector('#provider-key-env').value===${JSON.stringify(envName + '_DRAFT')}`);
    await click('#provider-cancel'); await wait(() => evaluate("!document.querySelector('#provider-close-confirm').hidden"), 'preset draft discard'); await click('#provider-close-discard');
    process.env[envName] = 'invalid\r\nvalue'; await refresh();
    await check('invalid process values are distinguishable from missing or ready references', "document.querySelector('#provider-key-state').textContent.includes('值无效')");
    await dimensions(390, 844); await measure('credentials-390'); await capture('credentials-mobile');
    await dimensions(320, 740); await measure('credentials-320'); await dimensions(1366, 900); await measure('credentials-wide'); await capture('credentials-wide');
    await field('provider-key-action', 'clear'); await click('#provider-save'); await loaded();
    assert.equal(raw().providers[0].apiKeyEnv, undefined); assert.equal(raw().providers[0].apiKey, undefined);
    for (const name of fs.readdirSync(out).filter(name => name.startsWith('env-providers.json'))) assert(!fs.readFileSync(path.join(out, name), 'utf8').includes(secret));
    result.checks.push('clear removes the reference and no resolved value appears in configuration or its backups');
    result.status = 'passed'; save();
  } finally { delete process.env[envName]; await new Promise(resolve => upstream.close(resolve)); }
}
