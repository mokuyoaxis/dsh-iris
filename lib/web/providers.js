const LABELS = { 'image-gen': '图片', 'video-gen': '视频', tts: '语音', 'music-gen': '音乐', transcribe: '转写', vision: '视觉' };
const $ = id => document.getElementById(id);
const element = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
const ref = (providerId, modelId) => encodeURIComponent(providerId) + '::' + encodeURIComponent(modelId);

export function createProviderPanel({ describe, onSaved }) {
  let client, data, draft, busy = false, dirty = false, unknown = false, generation = 0, originalIds = new Set();
  let policies = {}, touched = new Set(), directory = [], comfyGraph = null;
  const feedback = (text, error = false) => { $('providers-feedback').textContent = text; $('providers-feedback').hidden = !text; $('providers-feedback').classList.toggle('error', error); };
  const status = () => { $('provider-state').textContent = busy ? '处理中…' : dirty ? '未保存' : '已保存'; };
  function mark() { dirty = true; status(); summary(); }
  function summary() {
    const configured = draft?.models.filter(model => model.capabilities.length).length || 0;
    $('provider-save-summary').textContent = configured + ' 个已标注模型 · ' + (touched.size ? [...touched].map(cap => LABELS[cap] + '：' + ({ auto: '自动', manual: '手动', disabled: '停用' }[policies[cap].mode])).join('，') : '功能池保持现有设置');
  }
  function controls() {
    $('provider-fields').disabled = busy || !draft;
    $('providers-refresh').disabled = busy; $('provider-new').disabled = busy;
    $('provider-save').disabled = busy || unknown;
    $('provider-save').textContent = busy ? '正在处理…' : '保存设置';
    $('provider-discover').disabled = busy || dirty || !data?.providers.some(provider => provider.id === draft?.id && provider.configured);
    status();
    const comfy = $('provider-protocol').value === 'comfyui';
    $('comfyui-tools').hidden = !comfy;
    $('provider-discover').textContent = comfy ? '检查服务与工作流目录' : '读取模型目录';
    let url;
    try { url = new URL($('provider-media-url').value || $('provider-url').value); } catch (_) { /* The address is still being typed. */ }
    const safe = url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    $('comfyui-open').hidden = !safe; $('comfyui-open').removeAttribute('href'); if (safe) $('comfyui-open').href = url.href;
  }
  function options(select, values, selected) {
    select.replaceChildren(...values.map(([value, label]) => { const option = element('option', label); option.value = value; return option; }));
    if (selected && !values.some(([value]) => value === selected)) { const option = element('option', selected + ' · 未加载扩展'); option.value = selected; select.append(option); }
    select.value = selected;
  }
  function list() {
    $('providers-count').textContent = String(data.providers.length); $('providers-empty').hidden = data.providers.length > 0;
    $('providers-list').replaceChildren(...data.providers.map((provider, index) => {
      const button = element('button', '', 'connection-item provider-item'); button.type = 'button'; button.dataset.providerId = provider.id;
      button.dataset.providerTone = String(index % 6);
      button.setAttribute('aria-current', String(provider.id === draft?.id));
      button.append(element('strong', provider.name), element('small', (provider.enabled ? '启用' : '已停用') + ' · ' + provider.models.length + ' 个模型' + (!provider.configured ? ' · 待配置' : '')));
      button.addEventListener('click', () => { if (busy) return; if (dirty) { feedback('当前有未保存编辑，请先保存，或重新读取后切换。', true); return; } edit(provider); });
      return button;
    }));
  }
  function details(title) {
    const node = element('details', '', 'model-routing'); const head = element('summary'); const disclosure = element('span', '展开', 'disclosure');
    head.append(element('span', title), disclosure); node.append(head);
    node.addEventListener('toggle', () => { disclosure.textContent = node.open ? '收起' : '展开'; }); return node;
  }
  function renderModels() {
    $('provider-models-empty').hidden = draft.models.length > 0;
    $('provider-models').replaceChildren(...draft.models.map(model => {
      const row = element('article', '', 'provider-model'); row.dataset.modelId = model.id;
      const heading = element('div', '', 'section-heading'); heading.append(element('h3', model.id));
      const remove = element('button', originalIds.has(model.id) ? '清空用途' : '撤销添加', 'quiet inline-button'); remove.type = 'button';
      remove.addEventListener('click', () => { if (originalIds.has(model.id)) model.capabilities = []; else draft.models = draft.models.filter(item => item !== model); mark(); renderModels(); renderPolicies(); });
      heading.append(remove); row.append(heading);
      const choices = element('div', '', 'model-capabilities');
      for (const [cap, label] of Object.entries(LABELS)) {
        const choice = element('label', '', 'mini-check'); const input = element('input'); input.type = 'checkbox'; input.checked = model.capabilities.includes(cap); input.dataset.capability = cap;
        input.addEventListener('change', () => {
          model.capabilities = input.checked ? [...model.capabilities, cap] : model.capabilities.filter(value => value !== cap);
          if (input.checked && policies[cap].mode === 'disabled') { policies[cap].mode = 'auto'; touched.add(cap); }
          mark(); renderPolicies();
        }); choice.append(input, element('span', label)); choices.append(choice);
      }
      row.append(choices);
      const issues = model.unavailableCapabilities?.length ? '已知不可用：' + model.unavailableCapabilities.map(cap => LABELS[cap]).join('、')
        : model.rateLimited ? '限流或额度停用，需核对后实测'
          : Object.values(model.verified || {}).some(value => value.ok) ? '有已保存的实测记录；不代表所有用途通过' : '能力由你确认，尚无成功实测记录';
      row.append(element('p', issues, 'field-note'));
      if (model.comfyWorkflow) row.append(element('p', 'ComfyUI · 提示词 ' + model.comfyWorkflow.promptNode + ' → 输出 ' + model.comfyWorkflow.outputNode
        + (model.comfyWorkflow.graph ? ' · 工作流尚未保存' : ' · 已保存工作流 ' + model.comfyWorkflow.sha256.slice(0, 12)), 'field-note'));
      const advanced = details('模型协议与验证');
      for (const [key, cap, label] of [['imageProtocol', 'image-gen', '图片协议'], ['musicProtocol', 'music-gen', '音乐协议']]) {
        const select = element('select'); select.setAttribute('aria-label', model.id + ' · ' + label);
        options(select, [[key === 'imageProtocol' ? 'auto' : '', '沿用默认 / 未指定'], ...data.protocols.filter(item => item.capabilities.includes(cap)).map(item => [item.id, item.label])], model[key] || (key === 'imageProtocol' ? 'auto' : ''));
        select.addEventListener('change', () => { model[key] = select.value; mark(); });
        const wrapper = element('label', label, 'field-label'); wrapper.append(select); advanced.append(wrapper);
      }
      for (const [cap, value] of Object.entries(model.verified || {})) advanced.append(element('p', (LABELS[cap] || cap) + ' · ' + (value.ok ? '通过' : '未通过') + ' · ' + (value.category || '未知') + ' · ' + (value.at || ''), 'field-note'));
      advanced.append(element('p', '实际媒体测试可能计费。首版请通过 CLI models test 显式测试；目录读取不执行媒体。', 'field-note'));
      row.append(advanced); return row;
    }));
    summary(); controls();
  }
  function renderPolicies() {
    const all = [...data.providers.filter(provider => provider.id !== draft.id), draft];
    $('provider-assignments').replaceChildren(...Object.keys(LABELS).map(cap => {
      const row = element('div', '', 'function-policy'), heading = element('div', '', 'section-heading');
      heading.append(element('h3', LABELS[cap])); const select = element('select'); select.dataset.function = cap; select.setAttribute('aria-label', LABELS[cap] + '选择方式');
      options(select, [['disabled', '停用'], ['auto', '自动选择'], ['manual', '手动排序']], policies[cap].mode);
      select.addEventListener('change', () => { policies[cap].mode = select.value; touched.add(cap); mark(); renderPolicies(); });
      heading.append(select); row.append(heading);
      if (policies[cap].mode === 'manual') {
        const candidates = all.flatMap(provider => provider.models.filter(model => model.capabilities.includes(cap)).map(model => ({ name: provider.name + ' / ' + model.id, ref: ref(provider.id, model.id) })));
        for (const saved of policies[cap].models) if (!candidates.some(item => item.ref === saved)) candidates.push({ name: saved + ' · 当前不可用', ref: saved });
        candidates.sort((a, b) => { const order = value => { const index = policies[cap].models.indexOf(value); return index < 0 ? 9999 : index; }; return order(a.ref) - order(b.ref); });
        for (const candidate of candidates) {
          const choice = element('label', '', 'mini-check'); const input = element('input'); input.type = 'checkbox'; input.checked = policies[cap].models.includes(candidate.ref);
          input.addEventListener('change', () => { policies[cap].models = input.checked ? [...policies[cap].models, candidate.ref] : policies[cap].models.filter(item => item !== candidate.ref); touched.add(cap); mark(); renderPolicies(); });
          choice.append(input, element('span', (input.checked ? (policies[cap].models.indexOf(candidate.ref) + 1) + '. ' : '') + candidate.name)); row.append(choice);
        }
        if (!candidates.length) row.append(element('p', '请先给模型勾选此用途。', 'field-note'));
      }
      if (cap === 'vision') {
        const label = element('label', '', 'mini-check'), input = element('input'); input.type = 'checkbox'; input.checked = policies[cap].hostVision;
        input.addEventListener('change', () => { policies[cap].hostVision = input.checked; touched.add(cap); mark(); }); label.append(input, element('span', '允许宿主视觉（独立 Core 无此宿主服务）')); row.append(label);
      }
      return row;
    }));
  }
  function edit(provider) {
    comfyGraph = null; $('comfyui-bindings').hidden = true; $('comfyui-file').value = ''; $('comfyui-tools').open = false;
    $('comfyui-note').textContent = '最多 40 KiB。导入只保存草稿，不执行工作流。';
    draft = provider ? structuredClone(provider) : { id: 'provider-' + crypto.randomUUID().slice(0, 8), name: '', baseUrl: '', mediaBaseUrl: '', mediaProtocol: 'openai-images', enabled: true, auth: 'bearer', hasCredential: false, models: [] };
    document.querySelector('.provider-editor').dataset.providerTone = String((provider ? data.providers.indexOf(provider) : data.providers.length) % 6);
    policies = structuredClone(data.assignments); touched = new Set(); originalIds = new Set(draft.models.map(model => model.id)); dirty = !provider; unknown = false; directory = [];
    $('provider-editor-title').textContent = provider ? '编辑供应商' : '添加供应商';
    for (const [key, field] of [['name', 'name'], ['url', 'baseUrl'], ['media-url', 'mediaBaseUrl'], ['auth', 'auth']]) $('provider-' + key).value = draft[field];
    options($('provider-protocol'), data.protocols.map(item => [item.id, item.label]), draft.mediaProtocol);
    $('provider-enabled').checked = draft.enabled; $('provider-key-action').value = provider ? 'keep' : 'replace'; $('provider-key').value = ''; keyAction();
    $('provider-key-state').textContent = draft.hasCredential ? '已保存 · 不回显' : '尚未保存';
    $('provider-id-note').textContent = '稳定 ID：' + draft.id; $('provider-preset').value = 'custom'; $('provider-model-id').value = '';
    $('provider-advanced').open = false; $('provider-functions').open = false; $('provider-directory').hidden = true;
    $('provider-directory-note').textContent = '目录只使用已保存连接；成功不代表媒体实测通过。';
    list(); renderModels(); renderPolicies(); controls();
  }
  function keyAction() { const replacing = $('provider-key-action').value === 'replace'; $('provider-key-field').hidden = !replacing; $('provider-key').required = replacing; if (!replacing) $('provider-key').value = ''; }
  function readForm() {
    draft.name = $('provider-name').value; draft.baseUrl = $('provider-url').value; draft.mediaBaseUrl = $('provider-media-url').value;
    draft.mediaProtocol = $('provider-protocol').value; draft.auth = $('provider-auth').value; draft.enabled = $('provider-enabled').checked;
  }
  async function refresh(discard = false) {
    if (!client || busy) return;
    if (dirty && !discard) { $('providers-reload-confirm').hidden = false; return; }
    $('providers-reload-confirm').hidden = true;
    const active = client, ticket = generation, reloading = Boolean(data); busy = true; controls(); feedback('正在读取设置…');
    try {
      const result = await active.get('/api/v0/provider-management/settings');
      if (ticket !== generation || active !== client) return;
      if (result.contractVersion !== 0) throw new TypeError('不支持的供应商设置版本');
      const id = draft?.id; data = result; edit(data.providers.find(provider => provider.id === id) || data.providers[0]); feedback('');
      if (reloading) await onSaved();
    } catch (error) { if (ticket === generation) feedback(describe(error), true); }
    finally { if (ticket === generation) { busy = false; controls(); } }
  }
  function addModel(id) {
    id = id.trim(); if (!id) return;
    if (draft.models.some(model => model.id === id)) { feedback('模型已在配置中。'); return; }
    draft.models.push({ id, capabilities: [], imageProtocol: 'auto', musicProtocol: '' }); mark(); renderModels(); renderPolicies();
    feedback('已加入草稿。请勾选用途，再保存；原本停用的对应功能会改为自动选择。');
  }
  function directoryList() {
    const search = $('provider-directory-search').value.toLowerCase();
    $('provider-directory-list').replaceChildren(...directory.filter(model => model.id.toLowerCase().includes(search)).map(model => {
      const row = element('div', '', 'directory-item'); row.append(element('span', model.id));
      const add = element('button', draft.models.some(item => item.id === model.id) ? '已添加' : '加入草稿', 'quiet'); add.type = 'button'; add.disabled = draft.models.some(item => item.id === model.id);
      add.addEventListener('click', () => { addModel(model.id); directoryList(); }); row.append(add); return row;
    }));
  }
  $('provider-form').addEventListener('input', () => { if (draft) { readForm(); mark(); controls(); } });
  $('provider-key-action').addEventListener('change', keyAction);
  $('provider-auth').addEventListener('change', () => {
    if ($('provider-auth').value === 'none' && !draft.hasCredential && !$('provider-key').value) { $('provider-key-action').value = 'keep'; keyAction(); }
  });
  $('provider-new').addEventListener('click', () => { if (!data || busy) return; if (dirty) { feedback('请先保存当前草稿，或重新读取后添加。', true); return; } edit(); feedback(''); });
  $('providers-refresh').addEventListener('click', () => refresh());
  $('providers-reload-yes').addEventListener('click', () => refresh(true));
  $('providers-reload-no').addEventListener('click', () => { $('providers-reload-confirm').hidden = true; });
  $('provider-model-add').addEventListener('click', () => { addModel($('provider-model-id').value); $('provider-model-id').value = ''; });
  $('provider-model-id').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('provider-model-add').click(); } });
  $('provider-preset').addEventListener('change', event => {
    if (event.target.value === 'openai') { $('provider-url').value = 'https://api.openai.com/v1'; $('provider-protocol').value = 'openai-images'; if (!$('provider-name').value) $('provider-name').value = 'OpenAI'; }
    if (event.target.value === 'dashscope') { $('provider-url').value = 'https://dashscope.aliyuncs.com/compatible-mode/v1'; $('provider-protocol').value = 'dashscope'; if (!$('provider-name').value) $('provider-name').value = '百炼'; }
    if (event.target.value === 'comfyui') {
      $('provider-url').value = 'http://127.0.0.1:8188'; $('provider-protocol').value = 'comfyui'; $('provider-auth').value = 'none';
      $('provider-key-action').value = 'keep'; keyAction(); if (!$('provider-name').value) $('provider-name').value = 'ComfyUI';
      $('comfyui-tools').open = true;
    }
    readForm(); mark(); controls();
  });
  $('provider-directory-search').addEventListener('input', directoryList);
  $('provider-discover').addEventListener('click', async () => {
    const active = client, ticket = generation; if (!active || busy || dirty) return;
    busy = true; controls(); feedback('正在读取模型目录…');
    try {
      const result = await active.postProvider('discover', { expectedRevision: data.revision, providerId: draft.id });
      if (ticket !== generation) return;
      directory = result.models; $('provider-directory').hidden = false; $('provider-directory-search').value = ''; directoryList();
      $('provider-directory-note').textContent = '目录读取成功 · ' + directory.length + ' 个模型' + (result.truncated ? '（已截取前 256 个）' : '') + ' · 未写入配置，也未实测媒体'; feedback('');
    } catch (error) { if (ticket === generation) feedback(describe(error), true); }
    finally { if (ticket === generation) { busy = false; controls(); } }
  });
  $('provider-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!client || busy || unknown) return;
    readForm(); const active = client, ticket = generation;
    const provider = Object.fromEntries(['id', 'name', 'baseUrl', 'mediaBaseUrl', 'mediaProtocol', 'enabled', 'auth'].map(key => [key, draft[key]]));
    provider.models = draft.models.map(model => ({ id: model.id, capabilities: model.capabilities, imageProtocol: model.imageProtocol || 'auto', musicProtocol: model.musicProtocol || '',
      ...(model.comfyWorkflow?.graph ? { comfyWorkflow: model.comfyWorkflow } : {}) }));
    const action = $('provider-key-action').value, credential = { action, ...(action === 'replace' ? { value: $('provider-key').value } : {}) };
    const input = { expectedRevision: data.revision, provider, credential, assignments: Object.fromEntries([...touched].map(cap => [cap, policies[cap]])) };
    busy = true; controls(); feedback('正在保存连接、模型与用途…');
    try {
      const result = await active.postProvider('save', input);
      if (ticket !== generation) return;
      data = result; const id = draft.id; edit(data.providers.find(provider => provider.id === id)); feedback('已保存。新请求将使用当前配置。'); await onSaved();
    } catch (error) {
      if (ticket !== generation) return;
      unknown = !error.status || error.status >= 500 || error.status === 409;
      feedback(describe(error) + (unknown ? '。草稿已保留，请重新读取并核对保存结果；不会自动重试。' : ''), true);
    } finally { credential.value = ''; if (ticket === generation) { busy = false; controls(); } }
  });
  $('comfyui-file').addEventListener('change', async event => {
    const file = event.target.files[0], ticket = generation; event.target.value = '';
    if (!file || busy) return;
    try {
      if (file.size > 40 * 1024) throw new TypeError('工作流超过 40 KiB，请精简后导入。');
      const graph = JSON.parse(await file.text());
      if (ticket !== generation || !client) return;
      if (!graph || typeof graph !== 'object' || Array.isArray(graph) || !Object.keys(graph).length
          || Object.keys(graph).length > 256 || Object.values(graph).some(node => typeof node?.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs))) {
        throw new TypeError('需要 Export (API) 的节点映射，普通画布 JSON 不能直接执行。');
      }
      comfyGraph = graph;
      const entries = Object.entries(graph), label = ([id, node]) => [id, id + ' · ' + node.class_type];
      const prompts = entries.filter(([, node]) => typeof node.inputs.text === 'string').map(label);
      const outputs = entries.filter(([, node]) => /SaveImage|PreviewImage/i.test(node.class_type)).map(label);
      options($('comfyui-prompt-node'), [['', '明确选择提示词节点'], ...prompts], '');
      options($('comfyui-output-node'), [['', '明确选择输出节点'], ...entries.map(label)], outputs.length === 1 ? outputs[0][0] : '');
      options($('comfyui-size-node'), [['', '沿用工作流尺寸'], ...entries.filter(([, node]) => ['width', 'height'].every(key => Number.isSafeInteger(node.inputs[key]) && node.inputs[key] > 0)).map(label)], '');
      $('comfyui-model').value = file.name.replace(/\.json$/i, '').slice(0, 120); $('comfyui-bindings').hidden = false;
      $('comfyui-note').textContent = '已读取 ' + entries.length + ' 个节点。请核对正向提示词与图片输出节点。';
    } catch (error) { if (ticket === generation) { comfyGraph = null; $('comfyui-bindings').hidden = true; $('comfyui-note').textContent = error.message; } }
  });
  $('comfyui-add').addEventListener('click', () => {
    if (!comfyGraph || busy) return;
    const id = $('comfyui-model').value.trim(), promptNode = $('comfyui-prompt-node').value, outputNode = $('comfyui-output-node').value, sizeNode = $('comfyui-size-node').value;
    if (!id || !promptNode || !outputNode) { $('comfyui-note').textContent = '请填写工作流名称，并明确选择提示词和输出节点。'; return; }
    let model = draft.models.find(model => model.id === id);
    if (!model) { model = { id, capabilities: [], imageProtocol: 'comfyui', musicProtocol: '' }; draft.models.push(model); }
    model.comfyWorkflow = { version: 0, graph: structuredClone(comfyGraph), promptNode, outputNode, ...(sizeNode ? { sizeNode } : {}) };
    model.imageProtocol = 'comfyui'; if (!model.capabilities.includes('image-gen')) model.capabilities.push('image-gen');
    if (policies['image-gen'].mode === 'disabled') { policies['image-gen'].mode = 'auto'; touched.add('image-gen'); }
    mark(); renderModels(); renderPolicies(); $('comfyui-note').textContent = '已加入模型草稿。点击“保存设置”后，创作页可选择此工作流。';
  });
  return Object.freeze({
    async connect(value) { client = value; generation++; dirty = false; data = null; draft = null; await refresh(); },
    disconnect() { generation++; client = null; data = draft = null; comfyGraph = null; directory = []; policies = {}; touched.clear(); dirty = busy = unknown = false; $('provider-key').value = ''; $('provider-form').reset(); $('comfyui-bindings').hidden = true; $('provider-models').replaceChildren(); $('providers-list').replaceChildren(); $('provider-directory-list').replaceChildren(); $('provider-assignments').replaceChildren(); $('providers-reload-confirm').hidden = true; feedback(''); },
    show() {}
  });
}
