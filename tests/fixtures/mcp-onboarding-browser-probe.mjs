import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';

export async function verifyMcpOnboardingBrowser({ out, dataRoot, cdp, evaluate, click, wait, chooseToken, report, save, dimensions, measure, capture, downloads, restart }) {
  const result = report.mcpOnboarding = { status: 'running', checks: [], actualPaidCalls: 0 };
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const field = (selector, value) => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  let session, logins = 0;
  async function login() {
    const file = path.join(out, 'onboarding-token-' + ++logins); writeLocalApiTokenFile(file, session.accessToken, dataRoot);
    await evaluate("sessionStorage.removeItem('iris.workbench.session.v0')");
    await cdp('Page.navigate', { url: 'about:blank' }); await cdp('Page.navigate', { url: session.origin + '/' });
    await wait(() => evaluate("Boolean(document.documentElement.dataset.theme)"), 'onboarding login mount');
    await chooseToken(file); await wait(() => evaluate("document.querySelector('#connection').hidden&&!document.querySelector('#connection-new').disabled"), 'onboarding owner');
    await click('#connections-tab');
  }
  session = await restart(true); await login(); await click('#connection-new');
  await evaluate("document.querySelector('#connection-name').value='Preset browser fixture';document.querySelector('#connection-name').dispatchEvent(new Event('input',{bubbles:true}))");
  await click('#connection-save');
  await wait(() => evaluate("!document.querySelector('#connection-export').hidden&&!document.querySelector('#connection-export-button').disabled"), 'onboarding saved connection');
  await check('all eight explicitly chosen client presets and the generic manual path are available', "document.querySelectorAll('#connection-template option[value^=\"preset:\"]').length===8&&document.querySelector('#connection-template').value===''");
  await field('#connection-template', 'preset:codex-stdio');
  await check('Codex preset selects native TOML with merge instructions while preserving authorization', "document.querySelector('#connection-format').value==='codex-toml'&&document.querySelector('#connection-format').disabled&&document.querySelector('#connection-template-note').textContent.includes('config.toml')&&document.querySelector('#connection-template-note').textContent.includes('保留其他段')");
  await click('#connection-export-button');
  await wait(() => evaluate("!document.querySelector('#connection-export-result').hidden"), 'onboarding TOML export');
  await check('the preview is raw native TOML and offers a TOML download', "document.querySelector('#connection-configuration').value.startsWith('[mcp_servers.iris]')&&document.querySelector('#connection-download').textContent==='下载 TOML'&&!document.querySelector('#connection-configuration').value.startsWith('\"')");
  await measure('onboarding-codex-wide'); await capture('onboarding-codex-wide');
  await dimensions(390, 844); await measure('onboarding-codex-mobile'); await capture('onboarding-codex-mobile'); await dimensions(1366, 900);
  await click('#connection-download');
  const file = path.join(downloads, 'iris-mcp.toml'); await wait(() => fs.existsSync(file), 'actual TOML browser download');
  // Pass the actual download as an argument; never shell-interpolate its content.
  const downloaded = spawnSync('python3', ['-c', 'import sys,tomllib;value=tomllib.load(open(sys.argv[1],"rb"));assert "command" in value["mcp_servers"]["iris"]', file], { encoding: 'utf8' });
  assert.equal(downloaded.status, 0, downloaded.stderr);
  result.checks.push('a real browser download has a .toml filename and parses independently');
  await field('#connection-template', 'preset:claude-http'); await click('#connection-export-button');
  await wait(() => evaluate("!document.querySelector('#connection-export-result').hidden"), 'Claude native HTTP export');
  await check('Claude HTTP uses an explicit type and a separate credential warning', "(()=>{const c=JSON.parse(document.querySelector('#connection-configuration').value).mcpServers.iris;return c.type==='http'&&c.url===location.origin+'/mcp'&&document.querySelector('#connection-export-note').textContent.includes('含连接密钥')})()");
  await field('#connection-template', 'preset:kimi-stdio');
  await check('changing clients clears the previous credential preview', "document.querySelector('#connection-configuration').value===''&&document.querySelector('#connection-export-result').hidden");
  await click('#connection-export-button'); await wait(() => evaluate("!document.querySelector('#connection-export-result').hidden"), 'Kimi stdio export');
  await check('Kimi retains the general mcpServers command/args structure', "(()=>{const c=JSON.parse(document.querySelector('#connection-configuration').value).mcpServers.iris;return typeof c.command==='string'&&Array.isArray(c.args)&&!c.url})()");
  await field('#connection-template', ''); await field('#connection-format', 'entry'); await click('#connection-export-button');
  await wait(() => evaluate("!document.querySelector('#connection-export-result').hidden"), 'generic entry export');
  await check('the generic entry path remains independently selectable', "Array.isArray(JSON.parse(document.querySelector('#connection-configuration').value).args)&&!document.querySelector('#connection-format').disabled");
  const profiles = path.join(out, 'onboarding-connections', 'profiles'), profile = JSON.parse(fs.readFileSync(path.join(profiles, fs.readdirSync(profiles).find(name => name.endsWith('.json')))));
  assert.deepEqual(profile.scopes, ['read']); assert.deepEqual(profile.capabilities, ['image-edit']); assert.equal(profile.revision, 1);
  const revoked = await fetch(session.origin + '/api/v0/connection-management/connections/' + profile.connectionId + '/revoke', {
    method: 'POST', headers: { Authorization: 'Bearer ' + session.accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 1 }) });
  assert.equal(revoked.status, 200); await revoked.arrayBuffer(); await click('#connection-export-button');
  await wait(() => evaluate("document.querySelector('#connections-feedback').textContent.includes('关联 ID：')&&!document.querySelector('#connection-export-button').disabled"), 'locatable revoked export error');
  await check('a rejected stale export retains its request ID once and leaves no credential preview', "(document.querySelector('#connections-feedback').textContent.match(/关联 ID：/g)||[]).length===1&&document.querySelector('#connection-configuration').value===''");
  session = await restart(false); await login();
  await check('HTTP presets are unavailable when this service has not enabled HTTP MCP', "[...document.querySelectorAll('#connection-template option[value^=\"preset:\"]')].filter(n=>n.value.endsWith('-http')).every(n=>n.disabled)&&document.querySelector('#connection-transport option[value=http]').disabled");
  result.status = 'passed'; save();
}
