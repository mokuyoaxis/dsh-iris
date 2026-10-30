import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { writeLocalApiTokenFile } from '../../lib/local-api.js';
import { COMFY_WORKFLOW, comfyProtocolFixture } from './comfyui-protocol-fixture.mjs';
import { FLOW_RESULT } from './image-flow-fixture.mjs';

export async function verifyCoreComfyBrowser({ out, cdp, evaluate, click, wait, chooseToken, report, save, dimensions, measure, capture, restart }) {
  const result = report.comfyui = { status: 'running', checks: [], realComfyGpu: false, actualPaidCalls: 0 };
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); result.checks.push(name); save(); };
  const root = path.join(out, 'comfy-core'), config = path.join(out, 'comfy-providers.json');
  const fixture = await comfyProtocolFixture(), app = createApplicationRuntime({ dataRoot: root });
  const staticWorkflow = structuredClone(COMFY_WORKFLOW); staticWorkflow.version = 0; delete staticWorkflow.parameters;
  const initial = { providers: [{ id: 'comfy', name: 'ComfyUI · 本机', baseUrl: fixture.baseUrl, mediaProtocol: 'comfyui', auth: 'none', enabled: true,
    models: [{ id: 'fixed', capabilities: ['image-gen'], comfyWorkflow: staticWorkflow }] }], assignments: { 'image-gen': { mode: 'auto', models: [] } } };
  let session, token = 0, releaseInfo;
  async function login(reload = false) {
    const tokenFile = path.join(out, 'comfy-token-' + ++token); writeLocalApiTokenFile(tokenFile, session.accessToken, root);
    if (reload) await cdp('Page.reload'); else await cdp('Page.navigate', { url: session.origin + '/' });
    await wait(() => evaluate("Boolean(document.documentElement.dataset.theme)"), 'Comfy login mount');
    const retained = await evaluate(`sessionStorage.getItem('iris.workbench.session.v0')===${JSON.stringify(session.accessToken)}`);
    if (!retained) { await wait(() => evaluate("!document.querySelector('#connection').hidden"), 'Comfy new service login'); await chooseToken(tokenFile); }
    await wait(() => evaluate("!document.querySelector('#workspace').hidden&&document.querySelector('#model-summary').textContent!=='读取中'"), 'Comfy models loaded');
  }
  const field = async (selector, value) => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing '+${JSON.stringify(selector)});n.value=${JSON.stringify(String(value))};n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const param = id => '[data-workflow-parameter="' + id + '"]';
  async function upload(file) { const document = await cdp('DOM.getDocument'), input = await cdp('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#comfyui-file' }); await cdp('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [file] }); }
  try {
    await app.execute('flow.init', {}); await app.execute('execution.init', { imageGeneration: true }); await app.dispose();
    fs.writeFileSync(config, JSON.stringify(initial), { mode: 0o600 });
    session = await restart(root, config); await dimensions(1366, 1000); await login();
    await field('#appearance-theme', 'light'); await click('#providers-tab');
    await wait(() => evaluate("document.querySelector('#providers-list .provider-item')?.disabled===false"), 'Comfy saved settings reread');
    await click('#providers-list .provider-item'); await click('[data-provider-view="workflow"]'); await click('#comfyui-tools>summary');
    const invalid = path.join(out, 'canvas.json'), raw = path.join(out, 'raw-api.json'), template = path.join(out, 'portrait.json');
    fs.writeFileSync(invalid, '{"nodes":[]}'); fs.writeFileSync(raw, JSON.stringify(COMFY_WORKFLOW.graph)); fs.writeFileSync(template, JSON.stringify(COMFY_WORKFLOW));
    const configBefore = fs.readFileSync(config);
    await upload(invalid); await wait(() => evaluate("document.querySelector('#comfyui-note').textContent.includes('普通画布')"), 'canvas rejected');
    assert(fs.readFileSync(config).equals(configBefore)); assert.equal(fixture.requests.length, 0);
    await upload(raw); await wait(() => evaluate("!document.querySelector('#comfyui-bindings').hidden"), 'raw graph imported');
    await field('#comfyui-prompt-node', '6'); await field('#comfyui-size-node', '5');
    await check('raw graph import keeps positive and size explicit and exposes no parameters', "document.querySelector('#comfyui-preview-count').textContent==='固定工作流'&&document.querySelector('#comfyui-exposed-count').textContent==='0 / 32'");
    await click('#comfyui-exposed>summary');
    await click('[data-comfy-slot="10:strength_model"]');
    await field('[aria-label="参数名称 · 10:strength_model"]', '角色模型权重');
    await check('author can expose and name an existing float input without changing the underlying graph', "document.querySelector('#comfyui-preview-count').textContent==='1 个开放参数'&&document.querySelector('#comfyui-preview').textContent.includes('角色模型权重')&&document.querySelector('[aria-label=\"参数类型 · 10:strength_model\"]').value==='number'");
    await upload(template); await wait(() => evaluate("document.querySelector('#comfyui-preview-count').textContent==='7 个开放参数'"), 'v1 imported');
    await check('complete v1 imports bindings and renders a disabled preview with folded parameter declarations', "document.querySelector('#comfyui-prompt-node').value==='6'&&document.querySelector('#comfyui-size-node').value==='5'&&!document.querySelector('#comfyui-exposed').open&&[...document.querySelectorAll('#comfyui-preview input,#comfyui-preview select,#comfyui-preview textarea')].every(n=>n.disabled)&&document.querySelector('#provider-save').disabled");
    const beforeCheck = fixture.requests.length;
    await evaluate("document.querySelector('#comfyui-check').click();document.querySelector('#comfyui-check').click()");
    await wait(() => evaluate("document.querySelector('#comfyui-note').textContent.includes('静态检查通过')"), 'draft checked');
    assert.equal(fixture.requests.length - beforeCheck, new Set(Object.values(COMFY_WORKFLOW.graph).map(node => node.class_type)).size);
    assert(fs.readFileSync(config).equals(configBefore)); assert.equal(fixture.graphs.length, 0);
    result.checks.push('draft check uses saved connection, submits one read-only check for double click, and writes neither config nor generation');
    await capture('comfy-import-preview');
    await click('#comfyui-add'); await click('#provider-save');
    await wait(() => evaluate("document.querySelector('#providers-feedback').textContent==='已保存。新请求将使用当前配置。'"), 'workflow saved');
    const saved = JSON.parse(fs.readFileSync(config)); assert.deepEqual(saved.providers[0].models.find(model => model.id === 'portrait').comfyWorkflow, COMFY_WORKFLOW);
    assert.equal(saved.providers[0].models.length, 2); assert.equal(fixture.graphs.length, 0);
    await click('#comfyui-tools>summary'); await upload(template);
    await wait(() => evaluate("document.querySelector('#comfyui-preview-count').textContent==='7 个开放参数'"), 'replacement loaded');
    await click('#comfyui-add'); await check('same-name replacement requires an explicit confirmation', "!document.querySelector('#comfyui-replace').hidden&&document.querySelector('#provider-save').disabled");
    await click('#comfyui-replace-no'); assert.deepEqual(JSON.parse(fs.readFileSync(config)), saved);
    await click('#comfyui-discard'); await click('#studio-tab');
    await field('#model', 'comfy::portrait'); await field('#edit-prompt', '画一朵淡紫色鸢尾花。');
    await check('workflow selection shows typed parameters and defaults while keeping LoRA and additional controls folded', "!document.querySelector('#comfy-creation').hidden&&document.querySelector('[data-workflow-parameter=seed]').value==='1'&&[...document.querySelectorAll('#comfy-creation details')].every(n=>!n.open)&&!document.querySelector('#start-edit').disabled");
    await field(param('seed'), '1.5'); await check('invalid integer blocks generation and explains the field', "document.querySelector('#start-edit').disabled&&document.querySelector('#comfy-creation-note').textContent.includes('种子')");
    await field(param('seed'), '42'); await click('#comfy-creation-check');
    await wait(() => evaluate("document.querySelector('#comfy-creation-note').textContent.includes('静态检查通过')"), 'saved workflow checked');
    await check('check returns LoRA choices without changing current values or queuing', "document.querySelector('[data-workflow-parameter=lora]').tagName==='SELECT'&&JSON.parse(document.querySelector('[data-workflow-parameter=lora]').value)==='iris.safetensors'&&document.querySelector('[data-workflow-parameter=seed]').value==='42'");
    const loras = fixture.schemas.LoraLoader.input.required.lora_name[0];
    fixture.schemas.LoraLoader.input.required.lora_name[0] = [...loras, ...Array.from({ length: 256 }, (_, index) => 'extra-' + index + '.safetensors')];
    await evaluate("document.querySelector('#comfy-creation .comfy-lora').open=true"); await click('#comfy-creation-check');
    await wait(() => evaluate("document.querySelector('#comfy-creation-note').textContent.includes('静态检查通过')"), 'large candidate check');
    await check('truncated LoRA options keep a manual input, its value and the open section', "document.querySelector('[data-workflow-parameter=lora]').tagName==='INPUT'&&document.querySelector('[data-workflow-parameter=lora]').value==='iris.safetensors'&&document.querySelector('#comfy-creation .comfy-lora').open&&document.querySelector('#comfy-creation').textContent.includes('超过 256')");
    fixture.schemas.LoraLoader.input.required.lora_name[0] = loras;
    let unblock; const gate = new Promise(resolve => { unblock = resolve; }); releaseInfo = unblock;
    fixture.beforeInfo = async () => { fixture.beforeInfo = undefined; await gate; };
    const infoBefore = fixture.requests.length;
    await click('#comfy-creation-check'); await wait(() => fixture.requests.length > infoBefore, 'delayed check started');
    await field(param('seed'), '43'); unblock(); releaseInfo = null;
    await check('editing during a delayed check clears its authority immediately', "!document.querySelector('#comfy-creation-note').textContent.includes('通过')&&document.querySelector('[data-workflow-parameter=seed]').value==='43'");
    await field('#model', 'comfy::fixed'); await check('switching to a fixed workflow removes previous overrides', "document.querySelectorAll('#comfy-creation [data-workflow-parameter]').length===0");
    await field('#model', 'comfy::portrait'); await check('switching back loads template defaults instead of another model draft', "document.querySelector('[data-workflow-parameter=seed]').value==='1'");
    await evaluate("document.querySelector('#comfy-creation .comfy-lora').open=true");
    await field(param('lora'), 'portrait.safetensors'); await field(param('model_weight'), '0.65'); await field(param('clip_weight'), '0.4'); await field(param('seed'), '42');
    // A service enum is read again explicitly; it must not silently replace the chosen name.
    await click('#comfy-creation-check'); await wait(() => evaluate("document.querySelector('#comfy-creation-note').textContent.includes('静态检查通过')"), 'final parameter check');
    await evaluate("document.querySelector('#comfy-creation .comfy-lora').open=true");
    for (const width of [1366, 390, 320]) { await dimensions(width, 1000); await measure('comfy-parameters-' + width); await capture('comfy-parameters-' + width); }
    await dimensions(1366, 1000); await field('#appearance-theme', 'dark'); await capture('comfy-parameters-dark'); await field('#appearance-theme', 'light');
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await check('reduced motion disables the one-shot accent', "getComputedStyle(document.querySelector('#comfy-creation'),'::before').animationName==='none'");
    await cdp('Emulation.setEmulatedMedia', { features: [] });
    assert.equal(fixture.graphs.length, 0); result.checks.push('desktop, 390/320px, light/dark, LoRA dual weights and safe integer controls validated before any generation');
    await click('#start-edit'); await evaluate("document.querySelector('#start-edit').click()");
    await wait(() => evaluate("document.querySelector('#status-title').textContent==='原任务进行中'&&document.querySelector('#start-edit').textContent==='查看原任务'&&!document.querySelector('#start-edit').disabled"), 'original job running');
    const runId = await evaluate('location.hash.slice(1)'); assert.equal(fixture.graphs.length, 1);
    assert.equal(fixture.graphs[0]['10'].inputs.lora_name, 'portrait.safetensors'); assert.equal(fixture.graphs[0]['10'].inputs.strength_model, 0.65);
    assert.equal(fixture.graphs[0]['10'].inputs.strength_clip, 0.4); assert.equal(fixture.graphs[0]['3'].inputs.seed, 42);
    fixture.phase = 'done'; await click('#start-edit');
    await wait(() => evaluate("document.querySelector('#status-title').textContent==='图片已就绪'&&document.querySelector('#output-image').complete"), 'original job result');
    assert.equal(fixture.graphs.length, 1); await click('#run-details>summary');
    await check('result shows stored parameters instead of current template defaults', "!document.querySelector('#run-parameters').hidden&&document.querySelector('#run-parameter-values').textContent.includes('portrait.safetensors')&&[...document.querySelectorAll('#run-parameter-values dd')].some(n=>n.textContent==='42')");
    await click('#select-output'); await wait(() => evaluate("!document.querySelector('#download').disabled"), 'result selected');
    const response = await fetch(session.origin + '/api/v0/runs/' + runId + '/download', { headers: { Authorization: 'Bearer ' + session.accessToken } });
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), FLOW_RESULT); await capture('comfy-result-parameters');
    const newer = JSON.parse(fs.readFileSync(config)); newer.providers[0].models.find(model => model.id === 'portrait').comfyWorkflow.graph['3'].inputs.seed = 999;
    fs.writeFileSync(config, JSON.stringify(newer)); await login(true);
    await wait(() => evaluate("!document.querySelector('#run-view').hidden&&document.querySelector('#run-parameter-values').textContent.includes('42')"), 'reloaded history');
    assert.equal(fixture.graphs.length, 1);
    await check('refresh with a changed template keeps historical inputs and clears no task identity', "[...document.querySelectorAll('#run-parameter-values dd')].some(n=>n.textContent==='42')&&![...document.querySelectorAll('#run-parameter-values dd')].some(n=>n.textContent==='999')");
    session = await restart(root, config, { allowProviderManagement: false }); await login(true); await click('#new-run'); await field('#model', 'comfy::portrait');
    await check('execution-only owner can fill declared parameters while management checks remain unavailable', "!document.querySelector('#comfy-creation').hidden&&document.querySelector('#comfy-creation-check').hidden&&document.querySelector('#providers-tab').hidden");
    assert.equal(fixture.graphs.length, 1); assert.deepEqual(report.browserErrors, []);
    result.status = 'passed';
  } finally { releaseInfo?.(); await app.dispose(); await fixture.close(); result.providerRequests = fixture.requests; save(); }
}
