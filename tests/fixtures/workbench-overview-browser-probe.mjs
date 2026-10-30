import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { audioFlowFixture } from './audio-flow-fixture.mjs';

/** Real browser, HTTP and saved configuration. Overview paths must never contact providers. */
export async function verifyOverviewBrowser({ out, dataRoot, chosenRunId, tokenFile, cdp, evaluate, click, wait, chooseToken, readyRun,
  report, save, dimensions, measure, capture, tree, restart }) {
  const result = report.overview = { status: 'running', checks: [], realProvider: false, actualPaidCalls: 0 };
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const field = (selector, value) => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const card = id => `document.querySelector('[data-overview-capability="${id}"]')`;
  const root = path.join(out, 'overview-core'), config = path.join(out, 'overview-providers.json'), fixture = audioFlowFixture();
  let session, sequence = 0;
  const beforeOld = tree(dataRoot);
  const configValue = { providers: [{ id: 'audio-fixture', name: 'Local controlled service', enabled: true, auth: 'none',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope', models: [
      { id: 'qwen-image-2.0-pro', capabilities: ['image-gen'], verified: { 'image-gen': { ok: true, at: '2026-10-27T08:00:00Z', category: 'success' } } },
      { id: 'speech', capabilities: ['tts'], verified: { tts: { ok: false, at: '2026-10-26T08:00:00Z', category: 'timeout' } } },
      { id: 'transcribe', capabilities: ['transcribe'] }, { id: 'wan-video', capabilities: ['video-gen'] },
      { id: 'music', capabilities: ['music-gen'], musicProtocol: 'gemini-web-music' }, { id: 'vision', capabilities: ['vision'] }
    ] }], assignments: Object.fromEntries(['image-gen', 'video-gen', 'tts', 'music-gen', 'transcribe', 'vision'].map(cap => [cap, { mode: 'auto', models: [] }])) };
  fs.writeFileSync(config, JSON.stringify(configValue) + '\n', { flag: 'wx', mode: 0o600 });
  const app = createApplicationRuntime({ dataRoot: root });
  async function login(fragment = '#overview') {
    const token = path.join(out, 'overview-owner-' + ++sequence); writeLocalApiTokenFile(token, session.accessToken, root);
    const oldDocument = await evaluate('performance.timeOrigin');
    // A fragment-only Page.navigate keeps the old document and its previous service session.
    await cdp('Page.navigate', { url: 'about:blank' });
    await wait(() => evaluate("location.href==='about:blank'&&document.readyState==='complete'"), 'overview blank document committed');
    await cdp('Page.navigate', { url: session.origin + '/' + fragment });
    await wait(() => evaluate(`location.origin===${JSON.stringify(session.origin)}&&document.readyState==='complete'&&performance.timeOrigin!==${oldDocument}&&Boolean(document.documentElement.dataset.theme)&&!document.querySelector('#connection').hidden&&!document.querySelector('#connect').disabled`), 'overview login document');
    await chooseToken(token);
    await wait(() => evaluate("document.body.classList.contains('connected')&&!document.querySelector('#overview-panel').hidden&&document.querySelectorAll('[data-overview-capability]').length===6"), 'overview mounted');
    await wait(() => evaluate("!document.querySelector('#overview-stats').textContent.includes('读取中')&&!document.querySelector('#overview-capabilities').textContent.includes('读取已保存配置')"), 'overview facts read');
  }
  try {
    await chooseToken(tokenFile); await readyRun(chosenRunId);
    await check('existing Run deep links still open the original image flow', `location.hash==='#${chosenRunId}'&&!document.querySelector('#workspace').hidden&&document.querySelector('#overview-panel').hidden`);
    await click('#overview-tab');
    await check('six DSH-style media groups are distinct from folded local tools', "document.querySelectorAll('[data-overview-capability]').length===6&&!document.querySelector('#overview-tools').open&&!document.querySelector('#overview-notes').open&&document.querySelector('#overview-tools .disclosure').textContent==='展开'");
    await check('read-only service offers no generation action or owner management shortcut', "!document.querySelector('[data-overview-create]')&&!document.querySelector('[data-overview-configure]')&&document.querySelector('#overview-stats').textContent.includes('仅浏览')");
    await check('absent management metadata remains unknown; old roots do not report missing audio configuration', `${card('video')}.textContent.includes('当前会话未提供配置详情')&&${card('tts')}.textContent.includes('当前工作区未提供音频候选')&&${card('video')}.textContent.includes('当前会话未提供记录')`);
    await check('unimplemented Web/MCP media has no pretend creation button', `['video','music','vision'].every(id=>!document.querySelector('[data-overview-capability="'+id+'"] [data-overview-create]'))`);
    await click('#overview-tools>summary');
    await wait(() => evaluate("document.querySelector('#overview-tools .disclosure').textContent==='收起'"), 'local tools disclosure');
    await check('local tools name actual dependencies and the prompt optimizer DSH boundary', "document.querySelector('#overview-tools').textContent.includes('ffmpeg')&&document.querySelector('#overview-tools').textContent.includes('Chromium')&&document.querySelector('#overview-tools').textContent.includes('DSH 泡泡')");
    await click('#overview-tools>summary');
    await click('#overview-refresh'); await wait(() => evaluate("!document.querySelector('#overview-refresh').disabled"), 'read-only refresh');
    await click('.brand'); await wait(() => evaluate("location.hash==='#overview'"), 'brand overview fragment');
    await evaluate('history.back()'); await wait(() => evaluate("!document.querySelector('#workspace').hidden"), 'back to the same Run');
    await check('browser Back from the brand overview restores the original Run without creating a new flow', `location.hash==='#${chosenRunId}'&&document.querySelector('#overview-panel').hidden&&!document.querySelector('#run-view').hidden`);
    await click('#overview-tab');
    assert.deepEqual(tree(dataRoot), beforeOld); result.checks.push('opening and refreshing the old workspace changes no Core files');

    await app.execute('flow.init', {}); await app.execute('execution.init', { audio: true }); await app.dispose();
    session = await restart(root, config, { allowExecution: true, allowSelection: true, allowProviderManagement: true, executionPorts: fixture });
    const before = tree(root), originalConfig = fs.readFileSync(config);
    await dimensions(1440, 1000); await login();
    await check('overview bookmark restores directly and uses the authenticated session', "location.hash==='#overview'&&document.querySelector('#overview-tab').getAttribute('aria-current')==='page'&&document.querySelector('#page-label').textContent==='总览'");
    await check('current candidate counts come from image/audio catalogues, not six declared uses', "document.querySelector('#overview-stats').textContent.includes('3 个')&&document.querySelector('#overview-stats').textContent.includes('0 个')&&document.querySelectorAll('[data-overview-create]:not(:disabled)').length===4");
    await check('saved model uses, selection policy and historical evidence remain separate facts', `${card('image')}.textContent.includes('1 个已标注 · 自动选择')&&${card('image')}.textContent.includes('1 通过 · 0 未通过')&&${card('tts')}.textContent.includes('0 通过 · 1 未通过')&&${card('transcribe')}.textContent.includes('尚无实测记录')`);
    await check('unsupported media stays clearly labeled even when configured', `['video','music','vision'].every(id=>document.querySelector('[data-overview-capability="'+id+'"] .overview-entry').textContent==='CLI / DSH')&&${card('music')}.textContent.includes('1 个已标注')`);
    await capture('overview-desktop'); await measure('overview-desktop');
    await click('[data-overview-capability="image"] summary');
    await click('#overview-refresh'); await wait(() => evaluate("!document.querySelector('#overview-refresh').disabled"), 'configured refresh');
    await check('refresh retains expanded evidence and performs no new test', `${card('image')}.querySelector('details').open&&${card('image')}.textContent.includes('最近实测记录')`);
    for (const [mode, title] of [['generate', '从一句想法开始'], ['edit', '从一张图片开始'], ['tts', '让文字有声音'], ['transcribe', '把声音留下来']]) {
      await click('[data-overview-create="' + mode + '"]');
      await check(mode + ' shortcut opens its real form without submission', `!document.querySelector('#workspace').hidden&&document.querySelector('#viewer-empty h2').textContent===${JSON.stringify(title)}&&document.querySelector('[data-creation-mode="${mode}"]').getAttribute('aria-pressed')==='true'&&!location.hash`);
      await click('#overview-tab');
    }
    assert.deepEqual(tree(root), before); assert.deepEqual(fs.readFileSync(config), originalConfig);
    assert.equal(fixture.calls.submit.length, 0); assert.equal(fixture.calls.poll.length, 0); assert.equal(fixture.preparation.length, 0);
    result.checks.push('four creation shortcuts are local drafts: zero tasks, provider submits, polls, uploads or configuration changes');

    await click('[data-overview-configure="video"]'); await wait(() => evaluate("!document.querySelector('#provider-new').disabled"), 'provider list');
    await click('#providers-list [data-provider-id="audio-fixture"]');
    await field('#provider-name', 'Unsaved overview draft');
    await click('#overview-tab'); await click('#overview-refresh'); await wait(() => evaluate("!document.querySelector('#overview-refresh').disabled"), 'refresh while editing');
    await click('#providers-tab');
    await check('overview reads do not overwrite an unsaved provider draft', "document.querySelector('#provider-name').value==='Unsaved overview draft'&&document.querySelector('#provider-state').textContent==='未保存'");
    assert.deepEqual(fs.readFileSync(config), originalConfig);
    await click('#provider-save');
    await wait(() => evaluate("document.querySelector('#providers-feedback').textContent.startsWith('已保存')&&!document.querySelector('#provider-save').disabled"), 'provider name saved');
    await click('#provider-cancel'); await click('[data-provider-section="pools"]');
    await field('#provider-assignments [data-function="tts"]', 'disabled'); await click('#provider-pool-save');
    await wait(() => evaluate("document.querySelector('#providers-feedback').textContent.startsWith('已保存')&&!document.querySelector('#provider-pool-fields').disabled&&document.querySelector('#model-summary').textContent==='2 个候选'"), 'explicit disabled TTS policy');
    await click('#overview-tab');
    await check('explicit provider save updates the overview without reloading or making health claims', `${card('tts')}.textContent.includes('功能已停用')&&${card('tts')}.textContent.includes('0 个当前候选')&&document.querySelector('[data-overview-create="tts"]').disabled&&${card('tts')}.textContent.includes('0 通过 · 1 未通过')`);
    const savedConfig = fs.readFileSync(config);
    fs.writeFileSync(config, '{invalid controlled config\n', { mode: 0o600 });
    await click('#overview-refresh'); await wait(() => evaluate("!document.querySelector('#overview-refresh').disabled"), 'failed fact refresh');
    await check('configuration read failures stay unknown rather than becoming empty or successful', `!document.querySelector('#overview-feedback').hidden&&document.querySelector('#overview-stats').textContent.includes('读取失败')&&${card('image')}.textContent.includes('配置读取失败，未作判断')&&${card('image')}.textContent.includes('记录读取失败')&&[...document.querySelectorAll('[data-overview-create]')].every(button=>button.disabled)`);
    fs.writeFileSync(config, savedConfig, { mode: 0o600 });
    await click('#overview-refresh'); await wait(() => evaluate("!document.querySelector('#overview-refresh').disabled&&!document.querySelector('#overview-feedback').textContent"), 'explicit read recovery');
    await check('a successful reread restores actual candidates without a media probe', `${card('image')}.textContent.includes('1 个当前候选')&&!document.querySelector('[data-overview-create="generate"]').disabled`);
    await click('#overview-gallery'); await check('gallery shortcut opens the real current-workspace gallery', "!document.querySelector('#gallery-panel').hidden&&document.querySelector('#overview-panel').hidden");
    await click('#overview-tab');
    await dimensions(390); await measure('overview-390'); await capture('overview-390');
    await dimensions(320); await measure('overview-320'); await capture('overview-320');
    await click('#appearance-open'); await field('#appearance-theme', 'dark'); await click('#appearance-close');
    await measure('overview-dark-320'); await capture('overview-dark-320');
    await check('new cards retain the actual Iris accent in dark mode', `document.documentElement.dataset.theme==='dark'&&getComputedStyle(${card('music')}).getPropertyValue('--cap-tone').trim()==='#E59B76'`);
    await dimensions(1440, 1000); await capture('overview-dark-desktop');
    assert.deepEqual(tree(root), before); assert.equal(fixture.calls.submit.length, 0); assert.equal(fixture.calls.poll.length, 0);
    const posts = report.requests.filter(item => item.method === 'POST');
    assert.deepEqual(posts.map(item => new URL(item.url).pathname), ['/api/v0/provider-management/save', '/api/v0/provider-management/policies']);
    result.checks.push('the only browser POSTs are explicit provider and independent pool saves; all overview/form navigation is read-only');
    await click('#disconnect');
    await check('logout clears overview model/history projections', "document.querySelector('#overview-panel').hidden&&!document.querySelector('#overview-stats').children.length&&!document.querySelector('#overview-capabilities').children.length");

    session = await restart(root, config, { allowProviderManagement: false });
    await login();
    await check('v3 read-only service shows audio support without offering creation or management', `!document.querySelector('[data-overview-create]')&&!document.querySelector('[data-overview-configure]')&&${card('tts')}.querySelector('.overview-entry').textContent==='面板已接入'&&${card('tts')}.textContent.includes('当前会话未提供记录')`);
    await cdp('Page.reload'); await wait(() => evaluate("!document.querySelector('#overview-panel').hidden&&document.querySelector('#page-label').textContent==='总览'"), 'overview reload');
    await check('overview refresh retains login and does not submit or auto-test', "document.body.classList.contains('connected')&&location.hash==='#overview'&&document.querySelector('#overview-tools').open===false");
    assert.equal(report.requests.filter(item => item.method === 'POST').length, 2);
    result.status = 'passed'; save();
  } finally { await app.dispose(); }
}
