import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { createVisionProviderAdapter } from '../../lib/vision-provider-adapter.js';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { readCoreArtifactBytes } from '../../lib/core-artifacts.js';

/** Chromium reads actual Core artifacts and explicitly executes a saved Run; no paid model. */
export async function verifyVisionBrowser({ out, cdp, evaluate, click, wait, chooseToken, readyRun, report, save, dimensions, measure, capture, downloads, restart }) {
  const root = path.join(out, 'vision-core'), config = path.join(out, 'vision-providers.json');
  const text = '紫色鸢尾 <script>window.irisImageScriptExecuted=true</script>';
  let posts = 0;
  const adapter = createVisionProviderAdapter({ id: 'vision-fixture', type: 'openai', baseUrl: 'https://vision.invalid/v1', apiKey: 'CONTROLLED_VISION_KEY' }, {
    fetchPort: async () => { posts++; return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); }
  });
  const ports = { resolveVisionCandidates: () => [{ adapter, model: 'vision-fixture::vision', providerBinding: 'sha256:' + 'a'.repeat(64), selectionReason: 'explicit' }], resolveTaskAdapter: () => adapter };
  const app = createApplicationRuntime({ dataRoot: root, ...ports });
  fs.writeFileSync(config, JSON.stringify({ providers: [{ id: 'vision-fixture', type: 'openai', baseUrl: 'https://vision.invalid/v1', apiKey: 'CONTROLLED_VISION_KEY',
    models: [{ id: 'vision', capabilities: ['vision'] }] }], assignments: { vision: ['vision-fixture::vision'] } }), { mode: 0o600 });
  let session;
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); report.checks.push(name); save(); };
  const status = title => wait(() => evaluate(`document.querySelector('#status-title').textContent===${JSON.stringify(title)}&&!document.querySelector('#viewer').getAttribute('aria-busy').includes('true')`), title);
  async function reload() {
    const loader = (await cdp('Page.getFrameTree')).frameTree.frame.loaderId;
    await cdp('Page.reload');
    await wait(async () => (await cdp('Page.getFrameTree')).frameTree.frame.loaderId !== loader, 'new vision document');
    await wait(() => evaluate("Boolean(document.documentElement?.dataset.theme&&document.querySelector('#viewer'))"), 'vision document mounted');
  }
  const read = async id => { const response = await fetch(session.origin + '/api/v0/runs/' + id, { headers: { Authorization: 'Bearer ' + session.accessToken } }); assert.equal(response.status, 200); return response.json(); };
  try {
    await app.execute('flow.init', {}); await app.execute('execution.init', { vision: true });
    const source = (await app.execute('artifact.import', { image_bytes: await sharp({ create: { width: 100, height: 250, channels: 3, background: 'white' } }).png().toBuffer() })).artifact;
    const input = { sourceArtifactId: source.id, modelRef: 'vision-fixture::vision' };
    const draft = await app.execute('creation.vision', { key: crypto.randomUUID(), value: { ...input, question: '描述图片' } });
    const ocr = await app.execute('creation.ocr', { key: crypto.randomUUID(), value: { ...input, chunkHeight: 100, overlap: 0, maxInvocations: 1 } });
    await app.dispose();
    session = await restart(root, config, ports, { allowConnectionManagement: true, connectionStore: path.join(out, 'vision-connections'), allowMcp: true });
    report.requestRootVersion = 5;
    const token = path.join(out, 'vision-owner-token'); writeLocalApiTokenFile(token, session.accessToken, root);
    await cdp('Page.navigate', { url: session.origin + '/#' + draft.flow.run.id });
    await wait(() => evaluate('Boolean(document.querySelector("#token-file"))'), 'vision login'); await chooseToken(token);
    await readyRun(draft.flow.run.id); await status('已保存，尚未开始'); assert.equal(posts, 0);
    await check('saved vision offers an explicit vision action, without image comparison or selection', "!document.querySelector('#vision-result').hidden&&document.querySelector('#image-pair').hidden&&document.querySelector('#reuse-selected').hidden&&document.querySelector('#start-edit').textContent==='开始看图'");
    await click('#start-edit'); await status('看图结果已保存');
    await wait(() => evaluate("!document.querySelector('#vision-text-result').hidden"), 'saved vision text');
    await check('image text is literal text and never creates script elements', `document.querySelector('#vision-text-result').textContent===${JSON.stringify(text)}&&document.querySelector('#vision-text-result').children.length===0&&window.irisImageScriptExecuted!==true`);
    const saved = await read(draft.flow.run.id); assert.equal(posts, 1);
    await click('#download');
    let downloaded;
    await wait(() => { downloaded = fs.readdirSync(downloads).find(name => name.endsWith('.txt')); return downloaded && fs.readFileSync(path.join(downloads, downloaded)).equals(Buffer.from(text)); }, 'exact vision text download bytes');
    report.checks.push('actual browser download equals the original text artifact bytes');
    await reload(); await readyRun(saved.id); await status('看图结果已保存'); assert.equal(posts, 1); assert.equal((await read(saved.id)).task.id, saved.task.id);
    report.checks.push('reload keeps the original vision Task without another POST');
    await cdp('Page.navigate', { url: session.origin + '/#' + ocr.flow.run.id }); await readyRun(ocr.flow.run.id); await click('#start-edit'); await status('OCR 部分完成');
    await wait(() => evaluate("!document.querySelector('#vision-text-result').hidden"), 'partial OCR text');
    await check('partial OCR presents missing chunks and permits text download without retry', "document.querySelector('#status-message').textContent.includes('未处理 2 块')&&document.querySelector('#selection-feedback').textContent.includes('部分')&&!document.querySelector('#download').disabled&&document.querySelector('#start-edit').disabled");
    const partial = await read(ocr.flow.run.id); assert.equal(partial.ocr.skippedChunks, 2); assert.equal(posts, 2);
    assert.equal(JSON.parse(readCoreArtifactBytes(root, partial.report.artifactId).bytes).status, 'partial');
    for (const [width, height, name] of [[1366, 960, 'vision-desktop'], [390, 844, 'vision-mobile']]) { await dimensions(width, height); await measure(name, width); await capture(name); }
    await click('#connections-tab'); await click('#connection-new');
    await check('v5 connection center offers distinct vision and OCR choices', "Boolean(document.querySelector('#connection-vision-options input[value=vision]'))&&Boolean(document.querySelector('#connection-vision-options input[value=ocr]'))");
    await click('#connection-vision-options input[value=ocr]');
    await check('OCR can be explicitly selected without selecting vision', "document.querySelector('#connection-vision-options input[value=ocr]').checked&&!document.querySelector('#connection-vision-options input[value=vision]').checked");
    const inputFile = path.join(out, 'vision-form-input.png');
    fs.writeFileSync(inputFile, readCoreArtifactBytes(root, source.id).bytes);
    async function upload() {
      const document = await cdp('DOM.getDocument');
      const node = await cdp('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#image-file' });
      await cdp('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [inputFile] });
    }
    async function values(fields) {
      await evaluate(`(() => { for (const [selector,value] of Object.entries(${JSON.stringify(fields)})) { const node=document.querySelector(selector); node.value=value; node.dispatchEvent(new Event('input',{bubbles:true})); } })()`);
    }
    async function login(file, runId, label) {
      const retained = await evaluate(`sessionStorage.getItem('iris.workbench.session.v0')===${JSON.stringify(session.accessToken)}`);
      report.visionLogins ||= []; report.visionLogins.push({ label, retained }); save();
      assert.equal(await evaluate('location.origin'), session.origin);
      // A fragment navigation can keep the old document and its service grants.
      // Reload explicitly so this check always reads the restarted Core session.
      await evaluate(`history.replaceState(null,'',${JSON.stringify('/' + (runId ? '#' + runId : ''))})`);
      await reload();
      if (!retained) { await wait(() => evaluate("!document.querySelector('#connection').hidden"), label + ' login'); await chooseToken(file); }
      await wait(() => evaluate("!document.querySelector('#workspace').hidden&&document.querySelector('#model-summary').textContent!=='读取中'"), label + ' workspace');
    }
    await dimensions(1366, 960); await click('#studio-tab'); await click('#new-run'); await click('[data-creation-mode=vision]');
    await check('v5 offers a vision draft with required question and only vision models', "!document.querySelector('#source-input').hidden&&!document.querySelector('#edit-prompt').hidden&&document.querySelector('#edit-prompt').required&&document.querySelector('#edit-prompt').maxLength===8192&&document.querySelector('#model').options.length===2");
    await values({ '#model': 'vision-fixture::vision' }); await upload();
    await check('an empty question cannot save or invoke a vision task', "document.querySelector('#start-edit').disabled&&document.querySelector('#start-edit').textContent==='保存看图任务'"); assert.equal(posts, 2);
    await values({ '#edit-prompt': '图片里有什么？' });
    await wait(() => evaluate("!document.querySelector('#start-edit').disabled"), 'vision form can save');
    await measure('vision-create-desktop', 1366); await capture('vision-create-desktop');
    await click('#start-edit'); await status('已保存，尚未开始');
    const createdVisionId = await evaluate('location.hash.slice(1)'); await readyRun(createdVisionId);
    const createdVision = await read(createdVisionId); assert.equal(posts, 2); assert.equal(createdVision.input.question, '图片里有什么？');
    await check('saving vision locks the original input and waits for a second explicit action', "document.querySelector('#draft-fields').disabled&&document.querySelector('#start-edit').textContent==='开始看图'&&!document.querySelector('#start-edit').disabled");
    await click('#start-edit'); await status('看图结果已保存'); assert.equal(posts, 3);
    const executedVision = await read(createdVisionId); assert.equal(executedVision.task.attemptCount, 1);
    await reload(); await readyRun(createdVisionId); await status('看图结果已保存'); assert.equal(posts, 3);
    assert.equal((await read(createdVisionId)).task.id, executedVision.task.id);
    assert.deepEqual(readCoreArtifactBytes(root, createdVision.source.artifactId).bytes, fs.readFileSync(inputFile));
    await click('#new-run'); await click('[data-creation-mode=ocr]'); await values({ '#model': 'vision-fixture::vision' }); await upload();
    await evaluate("document.querySelector('#ocr-settings details').open=true");
    await values({ '#ocr-chunk-height': '100', '#ocr-overlap': '0', '#ocr-max-dimension': '2048', '#ocr-max-invocations': '1' });
    await check('OCR mode accepts an image and budget without a question', "!document.querySelector('#ocr-settings').hidden&&!document.querySelector('#ocr-settings').disabled&&document.querySelector('#edit-prompt').hidden&&!document.querySelector('#edit-prompt').required&&document.querySelector('#start-edit').textContent==='保存OCR任务'");
    await click('#start-edit'); await status('已保存，尚未开始');
    const createdOcrId = await evaluate('location.hash.slice(1)'); await readyRun(createdOcrId);
    const createdOcr = await read(createdOcrId); assert.equal(posts, 3); assert.equal(createdOcr.plan.totalChunks, 3); assert.equal(createdOcr.input.maxInvocations, 1);
    await check('saved OCR exposes the actual plan before the first inference', "document.querySelector('#ocr-plan-note').textContent.includes('预计 3 块')&&document.querySelector('#ocr-plan-note').textContent.includes('最多调用 1 次')&&document.querySelector('#start-edit').textContent==='开始识别'");
    for (const [width, height, name] of [[1366, 960, 'ocr-create-desktop'], [390, 844, 'ocr-create-mobile']]) { await dimensions(width, height); await measure(name, width); await capture(name); }
    await click('#start-edit'); await status('OCR 部分完成'); assert.equal(posts, 4);
    const executedOcr = await read(createdOcrId); assert.equal(executedOcr.task.attemptCount, 1); assert.equal(executedOcr.ocr.skippedChunks, 2);
    await check('Web-created partial OCR remains a partial result with no automatic retry', "document.querySelector('#start-edit').disabled&&document.querySelector('#status-message').textContent.includes('未处理 2 块')&&!document.querySelector('#download').disabled");
    session = await restart(root, config, ports, { allowExecution: false, allowLocalWrites: true });
    const draftToken = path.join(out, 'vision-draft-token'); writeLocalApiTokenFile(draftToken, session.accessToken, root);
    await login(draftToken, null, 'create-only');
    await click('#new-run'); await click('[data-creation-mode=vision]');
    await values({ '#model': 'vision-fixture::vision', '#edit-prompt': '只保存任务' }); await upload();
    await click('#start-edit'); await status('已保存，尚未开始');
    const draftOnlyId = await evaluate('location.hash.slice(1)'), draftOnly = await read(draftOnlyId);
    assert.equal(draftOnly.task, null); assert.equal(posts, 4);
    await check('create-only v5 saves a vision draft without permitting execution', "document.querySelector('#start-edit').disabled&&document.querySelector('#creation-help').textContent.includes('未开启执行')");
    session = await restart(root, config, ports, { allowExecution: false });
    const readonlyToken = path.join(out, 'vision-readonly-token'); writeLocalApiTokenFile(readonlyToken, session.accessToken, root);
    await login(readonlyToken, createdOcrId, 'readonly'); await readyRun(createdOcrId);
    await check('read-only v5 can inspect OCR but cannot create or execute', "document.querySelector('[data-creation-mode=vision]').disabled&&document.querySelector('[data-creation-mode=ocr]').disabled&&document.querySelector('#start-edit').disabled&&!document.querySelector('#download').disabled"); assert.equal(posts, 4);
    const legacyRoot = path.join(out, 'legacy-vision-form-core'), legacy = createApplicationRuntime({ dataRoot: legacyRoot });
    try { await legacy.execute('flow.init', {}); await legacy.execute('execution.init', {}); } finally { await legacy.dispose(); }
    session = await restart(legacyRoot, config, ports, {});
    const legacyToken = path.join(out, 'vision-legacy-token'); writeLocalApiTokenFile(legacyToken, session.accessToken, legacyRoot);
    await login(legacyToken, null, 'legacy');
    await check('legacy root keeps the new vision and OCR creation modes hidden', "document.querySelector('[data-creation-mode=vision]').hidden&&document.querySelector('[data-creation-mode=ocr]').hidden"); assert.equal(posts, 4);
    report.vision = { controlledProviderPosts: posts, realModelCalls: 0, visionRunId: saved.id, ocrRunId: partial.id,
      createdVisionRunId: createdVisionId, createdOcrRunId: createdOcrId, draftOnlyRunId: draftOnlyId, readOnlyVerified: true, legacyRootVerified: true, downloaded };
    save();
  } finally { await app.dispose(); }
}
