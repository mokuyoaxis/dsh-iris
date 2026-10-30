import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { definePlugin, createCorePluginRegistry } from '@mokuyoaxis/dsh-iris/plugins';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { loadCorePluginFixture } from './core-plugin-fixture.mjs';

/** Production DOM + HTTP only; the independent plugin fixture performs no media call here. */
export async function verifyCapabilityCatalogBrowser({ out, dataRoot, cdp, evaluate, click, wait, chooseToken, report, save, dimensions, measure, capture, restart }) {
  const result = report.capabilityCatalog = { status: 'running', checks: [], actualPaidCalls: 0 };
  const { fixturePlugin } = await loadCorePluginFixture();
  let calls = 0;
  const base = fixturePlugin({ operation: async () => { calls++; return {}; } }), manifest = structuredClone(base.manifest);
  manifest.contributions.operations[0].title = 'List <img src=x onerror=alert(1)>';
  const registry = await createCorePluginRegistry({ plugins: [definePlugin({ manifest, activate: base.activate })] });
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  try {
    const session = await restart(registry), token = path.join(out, 'catalog-owner-token');
    writeLocalApiTokenFile(token, session.accessToken, dataRoot);
    await cdp('Page.navigate', { url: 'about:blank' }); await cdp('Page.navigate', { url: session.origin + '/' });
    await wait(() => evaluate("Boolean(document.documentElement.dataset.theme)"), 'catalog login mount');
    await chooseToken(token);
    await wait(() => evaluate("document.querySelector('#connection').hidden&&!document.querySelector('#connection-new').disabled"), 'catalog owner');
    await click('#connections-tab');
    await check('plugin contributions are visible and folded without changing the default connection form', "!document.querySelector('#connection-contributions').hidden&&!document.querySelector('#connection-contributions').open&&document.querySelector('#connection-editor').hidden");
    await click('#connection-contributions>summary');
    await check('all five declarations show exact plugin identity and separate their actual access states', "document.querySelectorAll('#connection-contribution-list>li').length===5&&document.querySelector('#connection-contribution-list').textContent.includes('example.media@1.0.0')&&document.querySelector('#connection-contribution-list').textContent.includes('需显式本地授权')&&document.querySelector('#connection-contribution-list').textContent.includes('MCP 待接入持久执行')&&document.querySelector('#connection-contribution-list').textContent.includes('页面尚未挂载')");
    await check('untrusted titles stay text and cannot inject a page element or execute script', "document.querySelector('#connection-contribution-list').textContent.includes('<img src=x onerror=alert(1)>')&&!document.querySelector('#connection-contribution-list img')");
    await wait(() => evaluate("document.querySelector('#connection-contributions .disclosure').textContent==='收起'"), 'catalog disclosure state');
    await measure('catalog-wide'); await capture('catalog-wide');
    await dimensions(390, 844); await measure('catalog-mobile'); await capture('catalog-mobile'); await dimensions(1366, 900);
    await click('#connection-new');
    await check('scope labels and feature defaults are supplied by Core instead of browser allowlists', "document.querySelectorAll('#connection-scopes input').length===4&&document.querySelector('#connection-scopes').textContent.includes('导入与创建')&&document.querySelector('#connection-image-options input[value=\"image-edit\"]').checked&&!document.querySelector('#connection-image-options input[value=\"image-generate\"]').checked");
    await click('#connection-tool-details>summary');
    await check('declared business operations do not become MCP tools or checkboxes', "!document.querySelector('#connection-tools').textContent.includes('example.media')&&document.querySelectorAll('#connection-tools input').length===12");
    await evaluate("document.querySelector('#connection-name').value='Catalog selection';document.querySelector('#connection-name').dispatchEvent(new Event('input',{bubbles:true}))");
    await click('#connection-save');
    await wait(() => evaluate("document.querySelectorAll('#connections-list .connection-item').length===1&&!document.querySelector('#connection-save').disabled"), 'catalog explicit grant');
    const profile = fs.readdirSync(path.join(out, 'catalog-connections', 'profiles')).filter(name => name.endsWith('.json'));
    assert.equal(profile.length, 1);
    const grant = JSON.parse(fs.readFileSync(path.join(out, 'catalog-connections', 'profiles', profile[0])));
    assert.deepEqual(grant.scopes, ['read']); assert.deepEqual(grant.capabilities, ['image-edit']); assert(grant.tools.every(name => name.startsWith('iris_core_')));
    await click('[data-connection-view="delivery"]'); await click('#connection-skill-details>summary'); await click('#connection-skill-generate');
    await wait(() => evaluate("!document.querySelector('#connection-skill-result').hidden"), 'catalog exact Skill');
    await check('generated Skill describes only the actual granted tool selection', "document.querySelector('#connection-skill-preview').value.includes('iris_core_models')&&!document.querySelector('#connection-skill-preview').value.includes('example.media.list')&&!document.querySelector('#connection-skill-preview').value.includes('- `iris_core_import_image`')");
    await click('#connection-back'); await registry.dispose(); await click('#connections-refresh');
    await wait(() => evaluate("!document.querySelector('#connections-refresh').disabled&&document.querySelector('#connection-contribution-list').textContent.includes('已不可用')"), 'closed registry readback');
    await check('registry closure is reflected by refresh without expanding a saved connection', "document.querySelectorAll('#connections-list .connection-item').length===1&&document.querySelectorAll('#connection-contribution-list>li').length===5");
    assert.equal(calls, 0); assert(!report.requests.some(item => /\/web\/(library|png)\.mjs/.test(item.url)));
    result.checks.push('discovery and permission editing do not call the plugin or load its browser modules');
    result.status = 'passed'; save();
  } finally { await registry.dispose(); }
}
