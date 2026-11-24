import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { definePlugin, createCorePluginRegistry } from '../../lib/plugins.js';
import { FLOW_SOURCE } from './image-flow-fixture.mjs';
import { AUDIO_WAV } from './audio-flow-fixture.mjs';

/** Real Chromium probe for 0.3.3: video i2v/s2v UI, music/v0 + informed retry lineage, outbox overview, and Host-Owned Schema Auto Form. */
export async function verifyV033Browser({ out, cdp, evaluate, click, wait, chooseToken, report, save, dimensions, measure, capture, restart }) {
  const result = report.v033 = { status: 'running', checks: [], actualPaidCalls: 0 };
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const field = (selector, value) => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const status = title => wait(() => evaluate(`document.querySelector('#viewer').getAttribute('aria-busy')==='false'&&!document.querySelector('#run-view').hidden&&document.querySelector('#status-title').textContent===${JSON.stringify(title)}`), title);

  let musicCalls = 0, musicMode = '502';
  const musicServer = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    musicCalls++;
    if (musicMode === '502') {
      musicMode = 'ok';
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'controlled 502' } }));
      return;
    }
    if (musicMode === 'drop') {
      musicMode = 'ok';
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'data:audio/wav;base64,' + AUDIO_WAV.toString('base64') } }] }));
  });
  await new Promise(resolve => musicServer.listen(0, '127.0.0.1', resolve));

  // Zero-frontend-code multimodal plugin: NO pages/settings/renderers, ONLY an operation with typed enum + nested object + artifactInputTypes + ui!
  const autoFormPlugin = definePlugin({
    manifest: {
      contractVersion: 0, id: 'example.auto-mm', version: '1.0.0',
      compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' },
      contributions: {
        operations: [{
          id: 'analyze', version: '1.0.0', title: '音频特征摘要（零前端）', mode: 'writer',
          commands: ['artifact.read', 'artifact.lineage', 'artifact.import'],
          artifactInputs: ['audioId', 'extraRefs'],
          artifactInputTypes: { audioId: ['audio'], extraRefs: ['image'] },
          artifactOutputKinds: ['json'],
          ui: { category: 'local-tool', summary: '宿主托管表单：读取音频并输出 JSON 特征摘要。' },
          inputSchema: {
            type: 'object',
            properties: {
              audioId: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$', title: '输入音频' },
              extraRefs: { type: 'array', items: { type: 'string', pattern: '^artifact_[a-f0-9]{24}$' }, minItems: 0, title: '附加参考图' },
              profile: { type: 'string', enum: ['quick', 'full'], title: '分析档位' },
              buckets: { type: 'integer', minimum: 1, maximum: 16, title: '分桶数量' },
              strictMode: { type: 'boolean', enum: [false, true], title: '严格模式' },
              tags: { type: 'array', items: { type: 'string' }, title: '标签列表' },
              options: {
                type: 'object',
                properties: { tag: { type: 'string' }, weight: { type: 'integer', minimum: 1, maximum: 10 } },
                additionalProperties: false,
                title: '扩展选项'
              }
            },
            required: ['audioId', 'extraRefs', 'profile', 'strictMode', 'tags', 'options'],
            additionalProperties: false
          }
        }]
      }
    },
    activate() {
      return {
        operations: {
          async analyze(input, { core }) {
            const read = await core.execute('artifact.read', { artifact_id: input.audioId });
            const lineage = await core.execute('artifact.lineage', { artifact_id: input.audioId });
            const bytes = Buffer.from(read.bytesBase64, 'base64');
            const summary = {
              source: input.audioId, extraRefs: input.extraRefs, mediaType: read.mediaType, bytes: bytes.length,
              profile: input.profile, buckets: input.buckets ?? 4,
              strictMode: input.strictMode, tags: input.tags, options: input.options,
              parents: lineage.totalParents, runs: lineage.totalRuns
            };
            const saved = await core.execute('artifact.import', {
              media_type: 'application/json',
              bytes: Buffer.from(JSON.stringify(summary), 'utf8')
            });
            return { summary, artifactId: saved.artifact.id };
          }
        }
      };
    }
  });

  const root = path.join(out, 'v033-core');
  const outboxDir = path.join(out, 'v033-outbox');
  fs.mkdirSync(outboxDir, { mode: 0o700 });
  fs.writeFileSync(path.join(outboxDir, 'demo-export.png'), FLOW_SOURCE);
  fs.writeFileSync(path.join(outboxDir, '.staging-hidden'), 'skip');
  const config = path.join(out, 'v033-providers.json');
  fs.writeFileSync(config, JSON.stringify({
    providers: [
      {
        id: 'dash', enabled: true, apiKey: 'LOCAL_ONLY_KEY',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', mediaProtocol: 'dashscope',
        models: [
          { id: 'wan2.2-t2v-plus', capabilities: ['video-gen'] },
          { id: 'wan2.6-i2v', capabilities: ['video-gen'] },
          { id: 'wan2.2-s2v', capabilities: ['video-gen'] }
        ]
      },
      {
        id: 'music-box', enabled: true, apiKey: 'LOCAL_ONLY_KEY',
        baseUrl: 'http://127.0.0.1:' + musicServer.address().port + '/v1',
        models: [{ id: 'piano-v1', capabilities: ['music-gen'], musicProtocol: 'gemini-web-music' }]
      }
    ],
    assignments: {
      'video-gen': ['dash::wan2.2-t2v-plus', 'dash::wan2.6-i2v', 'dash::wan2.2-s2v'],
      'music-gen': ['music-box::piano-v1']
    }
  }), { mode: 0o600 });

  const app = createApplicationRuntime({ dataRoot: root });
  const registry = await createCorePluginRegistry({ plugins: [autoFormPlugin] });
  try {
    await app.execute('flow.init', {});
    await app.execute('execution.init', { video: true });
    await app.execute('artifact.import', { image_bytes: FLOW_SOURCE });
    const seededAudio = (await app.execute('creation.audio', { key: crypto.randomUUID(), bytes: AUDIO_WAV, mediaType: 'audio/wav' })).artifact;

    const session = await restart({
      dataRoot: root, providerConfigPath: config, allowExecution: true, allowSelection: true,
      outboxDir, pluginRegistry: registry, allowedOperations: ['example.auto-mm.analyze']
    });
    const token = path.join(out, 'v033-owner-token');
    writeLocalApiTokenFile(token, session.accessToken, root);
    await cdp('Page.navigate', { url: 'about:blank' });
    await cdp('Page.navigate', { url: session.origin + '/#overview' });
    await wait(() => evaluate("document.querySelector('#connection')?.hidden===false"), 'v033 login screen');
    await chooseToken(token);
    await wait(() => evaluate("document.body.classList.contains('connected')&&!document.querySelector('#overview-panel').hidden"), 'v033 overview connected');
    await wait(() => evaluate("!document.querySelector('#overview-outbox').hidden&&document.querySelector('#overview-outbox-list').children.length===1"), 'outbox overview rendered');

    // 1. Overview outbox status (zero host path!) + video 3 modes + music card connected
    await check('overview shows controlled outbox bare filename with zero host paths', `document.querySelector('#overview-outbox-list').textContent.includes('demo-export.png')&&!document.querySelector('#overview-outbox').textContent.includes('.staging-hidden')&&!document.querySelector('#overview-outbox').textContent.includes(${JSON.stringify(outboxDir)})`);
    await check('overview exposes video t2v/i2v/s2v and music creation shortcuts', "['video','video-i2v','video-s2v','music'].every(m=>!document.querySelector('[data-overview-create=\"'+m+'\"]').disabled)");

    // 2. Video i2v & s2v creation forms + model mode filtering
    await click('[data-overview-create="video-i2v"]');
    await check('video-i2v filters models to i2v-capable, makes prompt optional and shows resolution', "document.querySelector('[data-creation-mode=\"video-i2v\"]').getAttribute('aria-pressed')==='true'&&!document.querySelector('#edit-prompt').required&&!document.querySelector('#source-input').hidden&&document.querySelector('#audio-source-input').hidden&&!document.querySelector('#video-resolution-field').hidden&&[...document.querySelector('#model').options].map(o=>o.value).filter(Boolean).join(',')==='dash::wan2.6-i2v'");

    await click('[data-creation-mode="video-s2v"]');
    await check('video-s2v filters models to s2v-capable, hides prompt and shows both image and audio inputs', "document.querySelector('[data-creation-mode=\"video-s2v\"]').getAttribute('aria-pressed')==='true'&&document.querySelector('#edit-prompt').hidden&&!document.querySelector('#source-input').hidden&&!document.querySelector('#audio-source-input').hidden&&[...document.querySelector('#model').options].map(o=>o.value).filter(Boolean).join(',')==='dash::wan2.2-s2v'");

    // 3. Music creation -> controlled HTTP 502 (single submission!) -> informed retry button -> ready audio + retried-from lineage!
    await click('[data-creation-mode="music"]');
    await field('#model', 'music-box::piano-v1');
    await field('#edit-prompt', 'Gentle rain acoustic piano');
    await click('#start-edit');
    await status('需要核对原任务');
    const failedRunId = await evaluate('location.hash.slice(1)');
    assert.equal(musicCalls, 1, 'Core music/v0 must never silently retry HTTP 502');
    await check('failed music run exposes informed retry button', "!document.querySelector('#retry-music-draft').hidden");

    await click('#retry-music-draft');
    await check('informed retry pre-populates prompt and displays retried-from banner', `!document.querySelector('#music-retry-banner').hidden&&document.querySelector('#music-retry-text').textContent.includes(${JSON.stringify(failedRunId)})&&document.querySelector('#edit-prompt').value==='Gentle rain acoustic piano'`);
    await click('#start-edit');
    await status('音乐已就绪');
    assert.equal(musicCalls, 2);
    await wait(() => evaluate("!document.querySelector('#audio-output-result').hidden&&document.querySelector('#output-audio').src.startsWith('blob:')"), 'music audio preview loaded');
    await click('#run-lineage > summary');
    await wait(() => evaluate(`document.querySelector('#run-lineage-body').textContent.includes(${JSON.stringify(failedRunId)})&&document.querySelector('#run-lineage-body').textContent.includes('重试自')`), 'music retried-from lineage displayed');
    await capture('v033-music-ready');

    // Also verify Issue #4 in real Chromium: unknown acceptance music run carries duplicate-billing warning into the retry draft!
    musicMode = 'drop';
    await click('#new-run');
    await click('[data-creation-mode="music"]');
    await field('#model', 'music-box::piano-v1');
    await field('#edit-prompt', 'Midnight rain unknown acceptance');
    await click('#start-edit');
    await status('需要核对原任务');
    await check('unknown-acceptance music run still exposes retry button', "!document.querySelector('#retry-music-draft').hidden");
    await click('#retry-music-draft');
    await check('retrying unknown-acceptance music run displays explicit duplicate-billing warning', "!document.querySelector('#music-retry-banner').hidden&&document.querySelector('#music-retry-banner').classList.contains('error')&&document.querySelector('#music-retry-text').textContent.includes('可能产生重复计费')");

    // 4. Host-Owned Schema Auto Form (zero plugin frontend code!) under strict style-src 'self' CSP!
    await click('#tools-tab');
    await wait(() => evaluate("!document.querySelector('[data-local-tool-tab=\"plugins\"]').hidden"), 'plugin auto-form tab visible');
    await click('[data-local-tool-tab="plugins"]');
    await wait(() => evaluate(`Boolean(document.querySelector('#tool-plugin-op-fields select[data-plugin-field="audioId"] option[value="${seededAudio.id}"]'))`), 'multimodal audio artifact picker populated');
    await field('#tool-plugin-op-fields [data-plugin-field="audioId"]', seededAudio.id);
    await field('#tool-plugin-op-fields [data-plugin-field="profile"]', 'full');
    await field('#tool-plugin-op-fields [data-plugin-field="buckets"]', '8');
    // Blocker #3 + lossless JSON array: select boolean enum 'false', preserve whitespace in JSON string array & nested JSON object!
    await field('#tool-plugin-op-fields [data-plugin-field="strictMode"]', '0');
    await field('#tool-plugin-op-fields [data-plugin-field="tags"]', '["  padded  ", ""]');
    await field('#tool-plugin-op-fields [data-plugin-field="options"]', '{"tag":"iris","weight":3}');
    await click('#tool-plugin-op-submit');
    await wait(() => evaluate("!document.querySelector('#tool-plugin-op-result').hidden&&document.querySelector('#tool-plugin-op-artifacts .plugin-op-artifact-card pre')?.textContent.includes('\"buckets\": 8')"), 'auto-form plugin executed and previewed JSON artifact');
    await check('auto-form preserves boolean enum false, required empty artifact array [], exact string array whitespace and nested JSON object', "(()=>{const text=document.querySelector('#tool-plugin-op-artifacts .plugin-op-artifact-card pre')?.textContent||'';const data=JSON.parse(text);return data.strictMode===false&&Array.isArray(data.extraRefs)&&data.extraRefs.length===0&&Array.isArray(data.tags)&&data.tags.length===2&&data.tags[0]==='  padded  '&&data.tags[1]===''&&data.options?.tag==='iris'&&data.options?.weight===3&&data.runs===0;})()");
    // Also verify required string array accepts exact empty array [] cleanly!
    await field('#tool-plugin-op-fields [data-plugin-field="audioId"]', seededAudio.id);
    await field('#tool-plugin-op-fields [data-plugin-field="profile"]', 'quick');
    await field('#tool-plugin-op-fields [data-plugin-field="strictMode"]', '0');
    await field('#tool-plugin-op-fields [data-plugin-field="tags"]', '[]');
    await field('#tool-plugin-op-fields [data-plugin-field="options"]', '{"tag":"empty","weight":1}');
    await click('#tool-plugin-op-submit');
    await wait(() => evaluate("(()=>{const text=document.querySelector('#tool-plugin-op-artifacts .plugin-op-artifact-card pre')?.textContent||'';if(!text)return false;const data=JSON.parse(text);return data.options?.tag==='empty'&&Array.isArray(data.tags)&&data.tags.length===0;})()"), 'auto-form accepts required empty array []');
    await click('#tool-plugin-op-artifacts .plugin-op-artifact-card button:last-of-type');
    await wait(() => evaluate(`!document.querySelector('#tool-lineage-panel').hidden&&document.querySelector('#tool-lineage-body').textContent.includes(${JSON.stringify(seededAudio.id)})`), 'auto-form artifact lineage opens inline');
    await measure('v033-plugin-autoform-desktop');
    await capture('v033-plugin-autoform-desktop');

    await dimensions(320, 844);
    await measure('v033-plugin-autoform-320');
    await capture('v033-plugin-autoform-320');
    await dimensions(1366, 900);

    // 5. Logout releases all blobs and clears forms
    await click('#disconnect');
    await wait(() => evaluate("document.querySelector('#connection').hidden===false&&window.testBlobs.size===0"), 'logout releases all object URLs');

    // Issue #5 + recheck #2 regression in real Chromium (after disconnect so host listener is inactive):
    // auto-poll pause unlocks lookup button, switching to another operation PRESERVES original Key & lookup button, and lookup recovers + unlocks submit!
    const pollPauseOk = await evaluate(`(async () => {
      const { createPluginOpForm } = await import('/plugin-op-form.js');
      const opId = 'op_' + '1'.repeat(64);
      const depA = { contractVersion: 0, pluginId: 'example.pause', pluginVersion: '1.0.0', kind: 'operations', contributionId: 'example.pause.slow', contributionVersion: '1.0.0' };
      const depB = { contractVersion: 0, pluginId: 'example.pause', pluginVersion: '1.0.0', kind: 'operations', contributionId: 'example.pause.other', contributionVersion: '1.0.0' };
      const catalog = { contractVersion: 0, operations: [
        { id: 'example.pause.slow', title: 'Slow', dependency: depA, available: true, inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { id: 'example.pause.other', title: 'Other', dependency: depB, available: true, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
      ] };
      let polls = 0, lookups = 0, submittedKey = null, lookedUpKey = null;
      const fakeClient = {
        get: async path => path.includes('catalog') ? catalog : { contractVersion: 0, artifacts: [] },
        listArtifacts: async () => ({ contractVersion: 0, artifacts: [] }),
        callPlugin: async ({ key }) => { submittedKey = key; return { operation: { id: opId, operationId: 'example.pause.slow', state: 'running', dependency: depA } }; },
        getOperation: async () => { polls++; return { operation: { id: opId, operationId: 'example.pause.slow', state: 'running', dependency: depA } }; },
        lookupOperation: async key => { lookups++; lookedUpKey = key; return { operation: { id: opId, operationId: 'example.pause.slow', state: 'succeeded', dependency: depA, result: { value: { recovered: true }, artifactIds: [] } } }; }
      };
      const form = createPluginOpForm({ describe: e => String(e?.message || e), pollLimit: 2, pollIntervalMs: 10, firstPollMs: 10 });
      form.connect(fakeClient, { pluginExecution: true, pluginOperations: [depA, depB], operations: ['operations.stop'] });
      await form.activate();
      document.querySelector('#tool-plugin-op-form').requestSubmit();
      await new Promise(r => setTimeout(r, 120));
      const select = document.querySelector('#tool-plugin-op-select');
      const lookupBtn = document.querySelector('#tool-plugin-op-lookup');
      const submitBtn = document.querySelector('#tool-plugin-op-submit');
      const feedbackText = document.querySelector('#tool-plugin-op-feedback').textContent;
      const unlockedBeforeSwitch = polls >= 2 && feedbackText.includes('自动读取已暂停') && !lookupBtn.hidden && !lookupBtn.disabled && submitBtn.disabled;
      // Switch to second operation while original task is still running & paused: lookup button MUST stay visible & retain original key!
      select.value = 'example.pause.other';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const preservedAfterSwitch = !lookupBtn.hidden && !lookupBtn.disabled && submitBtn.disabled && lookupBtn.textContent.includes('example.pause.slow');
      lookupBtn.click();
      await new Promise(r => setTimeout(r, 80));
      const recovered = lookups === 1 && lookedUpKey === submittedKey
        && document.querySelector('#tool-plugin-op-json').textContent.includes('"recovered": true')
        && !submitBtn.disabled;
      form.disconnect();

      // Lost-receipt regression: when op A's POST receipt is lost, switching to op B MUST block B's submit and preserve A's Key until lookup resolves!
      const calls = [];
      let lookupMode = '404';
      const lostClient = {
        get: async path => path.includes('catalog') ? catalog : { contractVersion: 0, artifacts: [] },
        listArtifacts: async () => ({ contractVersion: 0, artifacts: [] }),
        callPlugin: async ({ key, operationId }) => {
          calls.push({ key, operationId });
          if (calls.length === 1) throw new Error('controlled lost receipt');
          return { operation: { id: opId, operationId, state: 'succeeded', dependency: operationId === 'example.pause.slow' ? depA : depB, result: { value: { ok: operationId }, artifactIds: [] } } };
        },
        lookupOperation: async key => {
          if (lookupMode === '404') throw Object.assign(new Error('not found'), { status: 404 });
          return { operation: { id: opId, operationId: 'example.pause.slow', state: 'succeeded', dependency: depA, result: { value: { lookedUp: key }, artifactIds: [] } } };
        }
      };
      const form2 = createPluginOpForm({ describe: e => String(e?.message || e), pollLimit: 2, pollIntervalMs: 10, firstPollMs: 10 });
      form2.connect(lostClient, { pluginExecution: true, pluginOperations: [depA, depB], operations: [] });
      await form2.activate();
      // 1) Submit A -> receipt lost -> keyA retained
      document.querySelector('#tool-plugin-op-form').requestSubmit();
      await new Promise(r => setTimeout(r, 40));
      const keyA = calls[0]?.key;
      // 2) Switch to B -> submit MUST be disabled, programmatic submit MUST NOT fire or overwrite keyA
      select.value = 'example.pause.other';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const bBlocked = submitBtn.disabled && !lookupBtn.hidden && lookupBtn.textContent.includes('example.pause.slow');
      document.querySelector('#tool-plugin-op-form').requestSubmit();
      await new Promise(r => setTimeout(r, 30));
      const noOverwrite = calls.length === 1;
      // 3) Switch back to A -> submitting A MUST reuse exact keyA (zero duplicate execution)!
      select.value = 'example.pause.slow';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const aReenabled = !submitBtn.disabled;
      document.querySelector('#tool-plugin-op-form').requestSubmit();
      await new Promise(r => setTimeout(r, 40));
      const reusedKeyA = calls.length === 2 && calls[1].operationId === 'example.pause.slow' && calls[1].key === keyA;
      form2.disconnect();
      // 4) Also verify 404 lookup unlocks switching to B cleanly!
      calls.length = 0;
      const form3 = createPluginOpForm({ describe: e => String(e?.message || e), pollLimit: 2, pollIntervalMs: 10, firstPollMs: 10 });
      form3.connect(lostClient, { pluginExecution: true, pluginOperations: [depA, depB], operations: [] });
      await form3.activate();
      document.querySelector('#tool-plugin-op-form').requestSubmit();
      await new Promise(r => setTimeout(r, 40));
      select.value = 'example.pause.other';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const blockedBefore404 = submitBtn.disabled;
      lookupBtn.click();
      await new Promise(r => setTimeout(r, 40));
      const unlockedAfter404 = !submitBtn.disabled;
      document.querySelector('#tool-plugin-op-form').requestSubmit();
      await new Promise(r => setTimeout(r, 40));
      const bSucceededAfter404 = calls.length === 2 && calls[1].operationId === 'example.pause.other' && calls[1].key !== calls[0].key;
      form3.disconnect();
      return unlockedBeforeSwitch && preservedAfterSwitch && recovered
        && Boolean(keyA) && bBlocked && noOverwrite && aReenabled && reusedKeyA
        && blockedBefore404 && unlockedAfter404 && bSucceededAfter404;
    })()`);
    assert.equal(pollPauseOk, true, 'auto-poll pause must preserve lookup button across operation switch and recover original operation');
    result.checks.push('auto-poll pause preserves lookup button across operation switch and recovers original key'); save();
    result.status = 'passed'; save();
  } finally {
    await registry.dispose();
    await app.dispose();
    await new Promise(resolve => musicServer.close(resolve));
  }
}
