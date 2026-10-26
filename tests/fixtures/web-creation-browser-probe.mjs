import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { readAllOperations } from '../../lib/operation-store.js';
import { listCoreTasks } from '../../lib/core-tasks.js';
import { FLOW_MODEL, FLOW_SOURCE, FLOW_RESULT, imageFlowFixture, readFlowEvents } from './image-flow-fixture.mjs';

/** Real production controls, real local storage/HTTP; only Provider execution is controlled. */
export async function verifyWebCreationBrowser({ out, cdp, evaluate, click, wait, chooseToken, readyRun,
  report, save, tree, dimensions, measure, capture, restart, pausedResponses }) {
  const result = report.creation = { status: 'running', checks: [], actualPaidCalls: 0, roots: [] }, apps = [];
  let session, root, fixture, app, tokens = 0;
  const imageFile = path.join(out, 'creation-source.png'), config = path.join(out, 'creation-providers.json');
  fs.writeFileSync(imageFile, FLOW_SOURCE, { mode: 0o600 });
  fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'flow-fixture', name: 'Controlled image fixture', enabled: true,
    baseUrl: 'https://never-called.fixture.invalid/v1', apiKey: 'fixture-not-a-real-key', mediaProtocol: 'openai-chat-images',
    models: [{ id: 'edit', capabilities: ['image-gen'] }] }], assignments: { 'image-gen': [FLOW_MODEL] } }), { mode: 0o600 });
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const posts = () => report.requests.filter(item => item.method === 'POST');
  async function login({ keepHash = false } = {}) {
    const token = path.join(out, 'creation-token-' + ++tokens); writeLocalApiTokenFile(token, session.accessToken, root);
    if (keepHash) await cdp('Page.reload'); else await cdp('Page.navigate', { url: session.origin + '/' });
    await wait(() => evaluate("Boolean(document.documentElement.dataset.theme&&!document.querySelector('#connection').hidden)"), 'creation login');
    await chooseToken(token);
    await wait(() => evaluate("!document.querySelector('#workspace').hidden&&document.querySelector('#model-summary').textContent!=='读取中'"), 'creation workspace');
  }
  async function fresh(name, options = {}) {
    root = path.join(out, name); fixture = imageFlowFixture(root, options); app = createApplicationRuntime({ dataRoot: root, ...fixture }); apps.push(app);
    await app.execute('flow.init', {}); await app.execute('execution.init', {});
    session = await restart(root, fixture, config); result.roots.push({ root: name }); await login();
  }
  async function input(prompt = '保留红色主体，调整绿色背景。') {
    const document = await cdp('DOM.getDocument'), node = await cdp('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#image-file' });
    await cdp('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [imageFile] });
    await evaluate(`document.querySelector('#model').value=${JSON.stringify(FLOW_MODEL)};document.querySelector('#model').dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#edit-prompt').value=${JSON.stringify(prompt)};document.querySelector('#edit-prompt').dispatchEvent(new Event('input',{bubbles:true}))`);
    await wait(() => evaluate("!document.querySelector('#start-edit').disabled&&!document.querySelector('#draft-preview').hidden"), 'ready draft');
  }
  async function status(text) {
    await wait(() => evaluate(`document.querySelector('#status-title').textContent===${JSON.stringify(text)}&&document.querySelector('#viewer').getAttribute('aria-busy')==='false'`), 'creation status ' + text);
  }
  try {
    await dimensions(1366, 900); await fresh('creation-sync-core');
    await check('empty connected workspace shows a real draft, with no fabricated history', "document.querySelector('#history-list').children.length===0&&!document.querySelector('#viewer-empty').hidden&&document.querySelector('#run-view').hidden&&document.querySelector('#start-edit').disabled&&document.querySelector('#creation-settings').open");
    assert.equal(listCoreTasks(root).total, 0); assert.equal(fixture.calls.submit.length, 0);
    await input();
    await check('desktop draft keeps main input and start action in the first screen', "document.querySelector('#edit-prompt').getBoundingClientRect().bottom<=innerHeight&&document.querySelector('#start-edit').getBoundingClientRect().bottom<=innerHeight");
    await measure('creation-desktop-draft'); await capture('creation-desktop-draft');
    await dimensions(1024, 768); await measure('creation-1024'); await capture('creation-1024');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 683, height: 450, deviceScaleFactor: 2, mobile: false });
    await measure('creation-200-percent-layout'); await capture('creation-200-percent-layout');
    result.zoomCheck = '683 CSS px at deviceScaleFactor 2: equivalent layout width for 200% at 1366, not a browser zoom control test';
    await dimensions(1366, 900);
    const start = posts().length; await click('#start-edit');
    await evaluate("document.querySelector('#start-edit').click()");
    await status('图片已就绪'); await wait(() => evaluate("!document.querySelector('#select-output').disabled"), 'selectable result');
    const id = await evaluate('location.hash.slice(1)');
    assert.equal(posts().length - start, 3, 'one explicit click makes one upload, one create and one continue');
    assert.equal(fixture.calls.submit.length, 1); assert.equal(listCoreTasks(root).total, 1); assert.equal(readAllOperations(root).length, 1);
    result.checks.push('double click produces exactly three separately identified writes, one Task and one Provider submit');
    await check('fixed Run locks the original input and exposes only confirmed result choices', "document.querySelector('#draft-fields').disabled&&!document.querySelector('#source-image').hidden&&!document.querySelector('#output-image').hidden&&document.querySelector('#download').disabled&&!document.querySelector('#run-details').open");
    await click('[data-view="overlay"]');
    await evaluate("document.querySelector('#compare-split').value='65';document.querySelector('#compare-split').dispatchEvent(new Event('input',{bubbles:true}))");
    await check('overlay uses original media with an adjustable split', "!document.querySelector('#overlay-view').hidden&&document.querySelector('#overlay-output').style.getPropertyValue('--split')==='65%'");
    await click('[data-view="pair"]'); await click('#source-preview');
    await check('image preview opens with the actual original and keeps focus in the dialog', "document.querySelector('#image-dialog').open&&document.querySelector('#expanded-image').src===document.querySelector('#source-image').src&&document.querySelector('#image-dialog').contains(document.activeElement)");
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait(() => evaluate("!document.querySelector('#image-dialog').open"), 'Escape closes preview');
    await click('#select-output'); await status('已选择结果');
    await check('selection is confirmed by Core before download is enabled', "document.querySelector('#select-output').getAttribute('aria-pressed')==='true'&&!document.querySelector('#download').disabled");
    await click('#download');
    const selected = (await app.execute('flow.inspect', { run_id: id })).run.selection.artifactId;
    const output = path.join(out, 'downloads', 'iris-' + selected + '.png'); await wait(() => fs.existsSync(output), 'creation original download');
    assert.deepEqual(fs.readFileSync(output), FLOW_RESULT); result.checks.push('production download preserves the selected Artifact bytes');
    await capture('creation-selected');
    await click('#media-tab');
    await wait(() => evaluate("document.querySelectorAll('.gallery-card').length===1&&document.querySelector('#gallery-grid').getAttribute('aria-busy')==='false'"), 'real gallery');
    await check('gallery counts and cover come from the saved choice', "document.querySelector('[data-filter=selected] span').textContent==='1'&&document.querySelector('[data-filter=unselected] span').textContent==='0'&&document.querySelector('.gallery-info strong').textContent.includes('已选择')");
    await wait(() => evaluate("!document.querySelector('.gallery-cover img').hidden"), 'visible gallery preview'); await capture('creation-gallery');
    await click('[data-filter="unselected"]'); await wait(() => evaluate("!document.querySelector('#gallery-empty').hidden"), 'empty filtered gallery');
    await check('empty filter never substitutes sample artwork', "document.querySelectorAll('.gallery-card').length===0");
    await click('[data-filter="selected"]'); await wait(() => evaluate("document.querySelectorAll('.gallery-card').length===1"), 'selected gallery');
    await click('.gallery-card'); await readyRun(id);
    await app.execute('flow.select', { run_id: id, artifact_id: (await app.execute('flow.inspect', { run_id: id })).run.source.artifactId });
    const beforeConflict = posts().length; await click('#select-source');
    await wait(() => evaluate("document.querySelector('#selection-feedback').textContent.includes('已核对当前选择')"), 'stale selection readback');
    await check('a stale choice is rejected and current choice is read without automatic rewrite', "document.querySelector('#select-source').getAttribute('aria-pressed')==='true'");
    assert.equal(posts().length, beforeConflict + 1);
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/runs/' + id + '/selection', requestStage: 'Response' }] });
    await click('#select-output'); await wait(() => pausedResponses.length > 0, 'held committed selection');
    await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'ConnectionClosed' }); await cdp('Fetch.disable');
    await wait(() => evaluate("document.querySelector('#select-output').getAttribute('aria-pressed')==='true'&&document.querySelector('#selection-feedback').textContent.includes('已核对当前选择')"), 'lost choice GET recovery');
    result.checks.push('lost selection response reads current choice instead of replaying POST');
    const beforeReload = posts().length; await login({ keepHash: true }); await readyRun(id);
    assert.equal(posts().length, beforeReload); assert.equal(fixture.calls.submit.length, 1);
    await check('reload requires fresh authentication and never generates', "sessionStorage.length===0&&Object.keys(localStorage).every(key=>key==='iris.panel.appearance.v0')&&!document.querySelector('#token').value&&!location.search");
    for (const width of [390, 320]) {
      await dimensions(width); await measure('creation-mobile-' + width); await capture('creation-mobile-' + width);
      await check('fixed mobile inputs start folded at ' + width, "!document.querySelector('#creation-settings').open");
      await click('#creation-settings>summary'); await measure('creation-mobile-' + width + '-settings'); await click('#creation-settings>summary');
    }
    await click('#theme'); await capture('creation-mobile-dark'); await click('#theme'); await dimensions(1366, 900);
    const beforeReuse = tree(root), beforeReusePosts = posts().length;
    await click('#reuse-selected'); await wait(() => evaluate("!document.querySelector('#draft-preview').hidden&&!document.querySelector('#draft-fields').disabled"), 'new draft from selected artifact');
    await check('reuse creates only an editable draft with a fresh prompt', "document.querySelector('#edit-prompt').value===''&&document.querySelector('#run-view').hidden&&!location.hash");
    assert.deepEqual(tree(root), beforeReuse); assert.equal(posts().length, beforeReusePosts);
    session = await restart(root, fixture, config, { allowExecution: false, allowSelection: false }); await login();
    await check('default read-only UI disables creation and selection', "document.querySelector('#start-edit').disabled&&document.querySelector('#draft-fields').disabled&&document.querySelector('#connections-tab').hidden");
    await click('[data-run-id="' + id + '"]'); await readyRun(id);
    await check('read-only mode retains the selected download', "document.querySelector('#select-source').disabled&&document.querySelector('#select-output').disabled&&!document.querySelector('#download').disabled");
    session = await restart(root, fixture, config, { allowExecution: false, allowSelection: true }); await login({ keepHash: true }); await readyRun(id);
    await check('selection-only mode enables local choices without generation', "!document.querySelector('#select-source').disabled&&document.querySelector('#start-edit').disabled");
    const selectionOnlySubmitCount = fixture.calls.submit.length; await click('#select-source'); await status('已选择原图');
    assert.equal(fixture.calls.submit.length, selectionOnlySubmitCount);

    await fresh('creation-async-core', { mode: 'async', pendingPoll: true }); await input('一次提交，明确查看原任务。'); await click('#start-edit');
    await status('原任务进行中'); assert.equal(fixture.calls.submit.length, 1); assert.equal(fixture.calls.poll.length, 0);
    await check('asynchronous completion requires an explicit original-task action', "document.querySelector('#start-edit').textContent==='查看原任务'");
    await wait(() => evaluate("!document.querySelector('#start-edit').disabled"), 'manual observe enabled');
    await click('#start-edit'); await wait(() => fixture.calls.poll.length === 1, 'one controlled poll'); await status('原任务进行中');
    await wait(() => evaluate("!document.querySelector('#start-edit').disabled"), 'second explicit observe'); await click('#start-edit'); await status('图片已就绪');
    assert.equal(fixture.calls.submit.length, 1); assert.equal(fixture.calls.poll.length, 2); assert.equal(listCoreTasks(root).total, 1);
    result.checks.push('two explicit observations preserve one async Task and one submit');

    await fresh('creation-unknown-core', { mode: 'unknown' }); await input('未知受理保留原任务。'); await click('#start-edit'); await status('需要核对原任务');
    const unknownPosts = posts().length; await click('#refresh');
    await check('unknown acceptance stays explicit and disables accidental resubmission', "document.querySelector('#start-edit').disabled&&document.querySelector('#status-message').textContent.includes('可能已经计费')");
    assert.equal(posts().length, unknownPosts); assert.equal(fixture.calls.submit.length, 1);

    await fresh('creation-lost-create-core'); await input('创建回包丢失，不自动继续。');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/runs', requestStage: 'Response' }] });
    await click('#start-edit'); await wait(() => pausedResponses.length > 0, 'held creation commit');
    await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'ConnectionClosed' }); await cdp('Fetch.disable');
    await status('已保存，尚未开始'); assert.equal(fixture.calls.submit.length, 0); assert.equal(listCoreTasks(root).total, 0);
    assert.equal((await app.execute('flow.list', {})).total, 1);
    result.checks.push('lost creation response reopens one committed Run without its first continue');

    await fresh('creation-loading-core');
    const loadingSource = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
    const waitingRuns = [];
    for (const prompt of ['第一个尚未执行的流程。', '切换到第二个尚未执行的流程。']) waitingRuns.push((await app.execute('flow.create', {
      source_artifact_id: loadingSource.id, model_ref: FLOW_MODEL, prompt
    })).run.id);
    await click('#refresh'); await wait(() => evaluate("document.querySelectorAll('.history-item').length===2"), 'two unstarted Runs');
    await click('[data-run-id="' + waitingRuns[0] + '"]'); await readyRun(waitingRuns[0]);
    await wait(() => evaluate("!document.querySelector('#start-edit').disabled"), 'first unstarted Run actionable');
    const beforeRunSwitch = posts().length;
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/runs/' + waitingRuns[1], requestStage: 'Response' }] });
    await click('[data-run-id="' + waitingRuns[1] + '"]'); await wait(() => pausedResponses.length > 0, 'held requested Run');
    result.loadingInspection = { previousRun: waitingRuns[0], requestedRun: waitingRuns[1],
      actionDisabled: await evaluate("document.querySelector('#start-edit').disabled"), postsBefore: beforeRunSwitch }; save();
    await check('switching Runs suspends the previous Run actions until the requested Run is confirmed',
      "document.querySelector('#start-edit').disabled&&document.querySelector('#select-source').disabled&&document.querySelector('#select-output').disabled&&document.querySelector('#reuse-selected').disabled&&document.querySelector('#draft-fields').disabled");
    await evaluate("document.querySelector('#start-edit').click()"); assert.equal(posts().length, beforeRunSwitch);
    await cdp('Fetch.continueRequest', { requestId: pausedResponses.shift() }); await cdp('Fetch.disable'); await readyRun(waitingRuns[1]);
    await check('only the successfully loaded Run can become actionable', "!document.querySelector('#start-edit').disabled");
    assert.equal(listCoreTasks(root).total, 0); assert.equal(fixture.calls.submit.length, 0);
    await click('[data-run-id="' + waitingRuns[0] + '"]'); await readyRun(waitingRuns[0]);
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/runs/' + waitingRuns[1], requestStage: 'Response' }] });
    await click('[data-run-id="' + waitingRuns[1] + '"]'); await wait(() => pausedResponses.length > 0, 'held failed Run lookup');
    await cdp('Fetch.failRequest', { requestId: pausedResponses.shift(), errorReason: 'ConnectionClosed' }); await cdp('Fetch.disable');
    await wait(() => evaluate("document.querySelector('#viewer-empty h2').textContent==='暂时无法读取此流程'&&document.querySelector('#viewer').getAttribute('aria-busy')==='false'"), 'visible Run lookup failure');
    await check('a failed Run lookup never restores a previous Run action', "document.querySelector('#start-edit').disabled");
    await evaluate("document.querySelector('#start-edit').click()"); assert.equal(posts().length, beforeRunSwitch);
    await click('#new-run');
    await check('an explicit new draft releases the failed lookup without execution', "!document.querySelector('#draft-fields').disabled&&document.querySelector('#start-edit').disabled&&!location.hash");
    assert.equal(listCoreTasks(root).total, 0); assert.equal(fixture.calls.submit.length, 0);

    await fresh('creation-navigation-core'); await input('离开页面后不继续创建。');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/images', requestStage: 'Response' }] });
    await click('#start-edit'); await wait(() => pausedResponses.length > 0, 'held upload before navigation');
    await click('#media-tab'); await cdp('Fetch.continueRequest', { requestId: pausedResponses.shift() }); await cdp('Fetch.disable');
    await wait(() => evaluate("!document.querySelector('#gallery-empty').hidden"), 'empty gallery after leaving upload');
    await click('#studio-tab'); await wait(() => evaluate("!document.querySelector('#draft-fields').disabled"), 'original upload wait released');
    assert.equal((await app.execute('flow.list', {})).total, 0); assert.equal(listCoreTasks(root).total, 0); assert.equal(fixture.calls.submit.length, 0);
    result.checks.push('leaving during upload prevents the later create and first continue');
    await evaluate("sessionStorage.setItem('iris.workbench.recovery.v0','BROKEN_RECOVERY_FIXTURE')");
    const beforeLocalClear = tree(root), beforeLocalClearPosts = posts().length; await login();
    await wait(() => evaluate("document.querySelector('#recovery-note').textContent.includes('恢复记录损坏')"), 'retained corrupt recovery');
    await click('#recovery-panel>summary'); await click('#recovery-clear'); await click('#recovery-clear-no');
    await check('canceling local recovery treatment preserves the original bytes', "sessionStorage.getItem('iris.workbench.recovery.v0')==='BROKEN_RECOVERY_FIXTURE'");
    await click('#recovery-clear'); await click('#recovery-clear-yes');
    await wait(() => evaluate("sessionStorage.getItem('iris.workbench.recovery.v0')===null"), 'explicit local identity clear');
    assert.deepEqual(tree(root), beforeLocalClear); assert.equal(posts().length, beforeLocalClearPosts);
    result.checks.push('explicit local recovery treatment never removes Core facts or sends POST');

    await fresh('creation-stop-core', { beforeSubmit: (_input, { signal }) => new Promise((resolve, reject) => {
      if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    await input('明确停止本地等待。'); await click('#start-edit');
    await wait(() => evaluate("!document.querySelector('#stop-operation').hidden&&!document.querySelector('#stop-operation').disabled"), 'active local stop');
    const activeRun = await evaluate('location.hash.slice(1)'), activeOperation = readAllOperations(root)[0].id;
    await click('#media-tab');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: session.origin + '/api/v0/runs/' + activeRun, requestStage: 'Response' }] });
    await click('[data-run-id="' + activeRun + '"]'); await wait(() => pausedResponses.length > 0, 'held active Run on return');
    await wait(() => evaluate("document.querySelector('#recovery-list').textContent.includes('原操作仍在处理中')"), 'operation recovered before Run');
    const operationReads = () => report.requests.filter(item => item.method === 'GET' && item.url === session.origin + '/api/v0/operations/' + activeOperation).length;
    const readsBeforeResume = operationReads();
    await cdp('Fetch.continueRequest', { requestId: pausedResponses.shift() }); await cdp('Fetch.disable'); await readyRun(activeRun);
    await wait(() => operationReads() > readsBeforeResume, 'confirmed Run resumes original operation GET');
    result.checks.push('recovery received during Run loading resumes only the confirmed Run operation reads');
    await click('#stop-operation'); await wait(() => evaluate("document.querySelector('#creation-feedback').textContent.includes('已停止本地等待')"), 'confirmed local stop');
    assert.equal(readAllOperations(root)[0].state, 'canceled'); assert.equal(readFlowEvents(root).length, 0);
    await check('stop feedback does not claim remote cancellation or refund', "document.querySelector('#creation-feedback').textContent.includes('远端取消未请求')");
    await capture('creation-stopped');
    assert.deepEqual(report.browserErrors, []);
    result.status = 'passed'; save();
  } finally { for (const owned of apps) await owned.dispose(); }
}
