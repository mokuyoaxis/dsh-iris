import { readWorkflowImport, workflowSlots, buildWorkflow, renderWorkflowParameters, inspectionMessage, parameterLabel } from './comfyui.js';

const LABELS = { 'image-gen': '图片', 'video-gen': '视频', tts: '语音', 'music-gen': '音乐', transcribe: '转写', vision: '视觉' };
const $ = id => document.getElementById(id);
const element = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
const ref = (providerId, modelId) => encodeURIComponent(providerId) + '::' + encodeURIComponent(modelId);

export function createProviderPanel({ describe, onSaved, onSettings, onProbe = () => {} }) {
  let client, data, draft, busy = false, dirty = false, unknown = false, generation = 0, originalIds = new Set();
  let policies = {}, touched = new Set(), directory = [], comfyTemplate = null, slots = [], importRead = 0, importAdded = false;
  let checkController, apiDraft = null, editing = false, view = 'connection';
  let section = 'suppliers', diagnostics = null, healthCapability = 'image-gen', pendingLeave;
  function editor(open) {
    editing = open; $('provider-editor').hidden = !open; $('providers-overview').hidden = open || section !== 'suppliers';
    $('provider-sections').hidden = open;
    $('provider-close-confirm').hidden = true;
  }
  function setView(next) {
    view = next;
    for (const button of document.querySelectorAll('[data-provider-view]')) {
      const active = button.dataset.providerView === view; button.setAttribute('aria-pressed', String(active));
      $('provider-view-' + button.dataset.providerView).hidden = !active;
    }
  }
  const connectionFields = ['url', 'media-url', 'protocol', 'auth', 'key-action', 'key'];
  const apiFields = () => Object.fromEntries(connectionFields.map(field => [field, $('provider-' + field).value]));
  function restoreApiDraft() {
    const fields = apiDraft || { url: '', 'media-url': '', protocol: 'openai-images', auth: 'bearer', 'key-action': draft.hasCredential ? 'keep' : 'replace', key: '' };
    for (const field of connectionFields) $('provider-' + field).value = fields[field];
    keyAction();
  }
  const feedback = (text, error = false) => { $('providers-feedback').textContent = text; $('providers-feedback').hidden = !text; $('providers-feedback').classList.toggle('error', error); };
  const status = () => { $('provider-state').textContent = busy ? '处理中…' : dirty ? '未保存' : '已保存'; };
  function mark() { dirty = true; status(); summary(); }
  function summary() {
    const configured = draft?.models.filter(model => model.capabilities.length).length || 0;
    $('provider-save-summary').textContent = configured + ' 个已标注模型 · ' + (touched.size ? [...touched].map(cap => LABELS[cap] + '：' + ({ auto: '自动', manual: '手动', disabled: '停用' }[policies[cap].mode])).join('，') : '功能池保持现有设置');
  }
  function controls() {
    $('provider-fields').disabled = busy || !draft;
    $('providers-refresh').disabled = busy; $('provider-new').disabled = busy || !data; $('provider-back').disabled = busy;
    $('provider-close-discard').disabled = busy || unknown; $('provider-close-cancel').disabled = busy;
    for (const button of document.querySelectorAll('#providers-list button')) button.disabled = busy;
    $('provider-save').disabled = busy || unknown || Boolean(comfyTemplate && !importAdded);
    $('provider-save').textContent = busy ? '正在处理…' : '保存设置';
    $('provider-pool-fields').disabled = busy || unknown || !data;
    $('provider-new').hidden = editing || section !== 'suppliers';
    for (const id of ['provider-cancel', 'provider-pool-save', 'provider-pool-cancel', 'provider-health-refresh']) $(id).disabled = busy || unknown || !data;
    $('provider-pool-save').disabled ||= !touched.size;
    for (const button of document.querySelectorAll('[data-provider-section]')) button.disabled = busy || !data;
    const saved = data?.providers.find(provider => provider.id === draft?.id);
    $('provider-management-tools').hidden = !saved;
    for (const id of ['provider-toggle', 'provider-delete', 'provider-delete-no']) $(id).disabled = busy || dirty || unknown;
    $('provider-toggle').textContent = saved?.enabled ? '停用供应商' : '恢复供应商';
    $('provider-discover').disabled = busy || dirty || !data?.providers.some(provider => provider.id === draft?.id && provider.configured);
    status();
    const comfy = $('provider-protocol').value === 'comfyui';
    document.querySelector('.provider-editor').classList.toggle('comfy-mode', comfy);
    $('provider-comfy-mode').hidden = !comfy;
    $('provider-preset-note').textContent = comfy ? '工作流模式已开启。导入 API 工作流，选择开放参数和 LoRA；保存配置不会生成图片。'
      : '按服务文档填写；编程订阅或聊天登录不等于媒体 API 认证。';
    $('comfyui-tools').hidden = !comfy;
    document.querySelector('[data-provider-view="workflow"]').hidden = !comfy;
    if (!comfy && view === 'workflow') setView('connection');
    $('comfyui-check').disabled = busy || !comfyTemplate || !savedComfyConnection();
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
      const button = element('button', '', 'service-card provider-item'); button.type = 'button'; button.dataset.providerId = provider.id;
      button.dataset.providerTone = String(index % 6);
      button.setAttribute('aria-current', String(provider.id === draft?.id));
      const heading = element('span', '', 'service-card-heading');
      heading.append(element('span', provider.mediaProtocol === 'comfyui' ? 'CF' : 'API', 'service-mark'), element('small', !provider.enabled ? '已停用' : provider.configured ? '已配置' : '待配置', 'service-status'));
      button.append(heading, element('strong', provider.name), element('span', provider.baseUrl || '尚未填写地址', 'service-endpoint'),
        element('span', provider.models.length + ' 个模型 · ' + (provider.mediaProtocol === 'comfyui' ? 'ComfyUI 工作流' : 'API 服务'), 'service-meta'), element('span', '配置服务 →', 'service-action'));
      button.addEventListener('click', () => { if (busy) return; if (dirty || comfyTemplate) { editor(true); feedback('当前有未保存编辑，请先保存，或重新读取后切换。', true); return; } edit(provider); editor(true); setView('connection'); feedback(''); });
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
        options(select, [[key === 'imageProtocol' ? 'auto' : '', key === 'imageProtocol' ? '沿用供应商默认' : '未指定（需选择）'],
          ...data.protocols.filter(item => item.capabilities.includes(cap)).map(item => [item.id, item.label])], model[key] || (key === 'imageProtocol' ? 'auto' : ''));
        select.addEventListener('change', () => { model[key] = select.value; mark(); });
        const wrapper = element('label', label, 'field-label'); wrapper.append(select); advanced.append(wrapper);
        if (key === 'musicProtocol') advanced.append(element('p', '使用音乐功能时需单独选择协议。Chat Completions 内嵌音频需返回 MP3/WAV，不限供应商名称。', 'field-note'));
      }
      for (const [cap, value] of Object.entries(model.verified || {})) advanced.append(element('p', (LABELS[cap] || cap) + ' · ' + (value.ok ? '通过' : '未通过') + ' · ' + (value.category || '未知') + ' · ' + (value.at || ''), 'field-note'));
      advanced.append(element('p', '可在健康检测准备媒体测试，或使用 CLI models test；实际调用可能计费，目录读取不生成媒体。', 'field-note'));
      row.append(advanced); return row;
    }));
    summary(); controls();
  }
  function renderPolicies() {
    const all = draft ? [...data.providers.filter(provider => provider.id !== draft.id), draft] : data.providers;
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
          choice.append(input, element('span', (input.checked ? (policies[cap].models.indexOf(candidate.ref) + 1) + '. ' : '') + candidate.name));
          const rank = element('div', '', 'provider-rank-row'); rank.append(choice);
          if (input.checked) for (const [text, step] of [['上移', -1], ['下移', 1]]) {
            const move = element('button', text, 'quiet'); move.type = 'button'; move.setAttribute('aria-label', candidate.name + ' · ' + text);
            const index = policies[cap].models.indexOf(candidate.ref); move.disabled = index + step < 0 || index + step >= policies[cap].models.length;
            move.addEventListener('click', () => { const values = policies[cap].models; [values[index], values[index + step]] = [values[index + step], values[index]]; touched.add(cap); mark(); renderPolicies(); }); rank.append(move);
          }
          row.append(rank);
        }
        if (!candidates.length) row.append(element('p', '请先给模型勾选此用途。', 'field-note'));
      }
      if (cap === 'vision') {
        const label = element('label', '', 'mini-check'), input = element('input'); input.type = 'checkbox'; input.checked = policies[cap].hostVision;
        input.addEventListener('change', () => { policies[cap].hostVision = input.checked; touched.add(cap); mark(); }); label.append(input, element('span', '允许宿主视觉（独立 Core 无此宿主服务）')); row.append(label);
      }
      return row;
    }));
    $('provider-pool-note').textContent = touched.size ? '尚未保存 · ' + [...touched].map(cap => LABELS[cap]).join('、') : '已保存 · 按顺序优先选择，不是跨请求轮询。';
    controls();
  }
  function edit(provider) {
    resetComfyImport(); $('comfyui-tools').open = false; apiDraft = null;
    draft = provider ? structuredClone(provider) : { id: 'provider-' + crypto.randomUUID().slice(0, 8), name: '', baseUrl: '', mediaBaseUrl: '', mediaProtocol: 'openai-images', enabled: true, auth: 'bearer', hasCredential: false, models: [] };
    document.querySelector('.provider-editor').dataset.providerTone = String((provider ? data.providers.indexOf(provider) : data.providers.length) % 6);
    policies = structuredClone(data.assignments); touched = new Set(); originalIds = new Set(draft.models.map(model => model.id)); dirty = !provider; unknown = false; directory = [];
    $('provider-editor-title').textContent = provider ? '编辑供应商' : '添加供应商';
    for (const [key, field] of [['name', 'name'], ['url', 'baseUrl'], ['media-url', 'mediaBaseUrl'], ['auth', 'auth']]) $('provider-' + key).value = draft[field];
    options($('provider-protocol'), data.protocols.map(item => [item.id, item.label]), draft.mediaProtocol);
    $('provider-enabled').checked = draft.enabled; $('provider-key-action').value = provider ? 'keep' : 'replace'; $('provider-key').value = ''; keyAction();
    $('provider-key-state').textContent = draft.hasCredential ? '已保存 · 不回显' : '尚未保存';
    $('provider-id-note').textContent = '稳定 ID：' + draft.id; $('provider-preset').value = draft.mediaProtocol === 'comfyui' ? 'comfyui' : 'custom'; $('provider-model-id').value = '';
    if (draft.mediaProtocol !== 'comfyui') apiDraft = apiFields();
    $('provider-advanced').open = false; $('provider-management-tools').open = false; $('provider-delete-confirm').hidden = true; $('provider-directory').hidden = true;
    $('provider-directory-note').textContent = '目录只使用已保存连接；成功不代表媒体实测通过。';
    list(); renderModels(); renderPolicies(); controls();
  }
  function keyAction() { const replacing = $('provider-key-action').value === 'replace'; $('provider-key-field').hidden = !replacing; $('provider-key').required = replacing; if (!replacing) $('provider-key').value = ''; }
  function readForm() {
    draft.name = $('provider-name').value; draft.baseUrl = $('provider-url').value; draft.mediaBaseUrl = $('provider-media-url').value;
    draft.mediaProtocol = $('provider-protocol').value; draft.auth = $('provider-auth').value; draft.enabled = $('provider-enabled').checked;
    if (draft.mediaProtocol !== 'comfyui') apiDraft = apiFields();
  }
  async function refresh(discard = false) {
    if (!client || busy) return;
    if ((dirty || comfyTemplate) && !discard) { $('providers-reload-confirm').hidden = false; return; }
    $('providers-reload-confirm').hidden = true;
    const active = client, ticket = generation, reloading = Boolean(data); busy = true; controls(); feedback('正在读取设置…');
    try {
      const result = await active.get('/api/v0/provider-management/settings');
      if (ticket !== generation || active !== client) return;
      if (result.contractVersion !== 0) throw new TypeError('不支持的供应商设置版本');
      const id = draft?.id; data = result; onSettings(result);
      if (editing) edit(data.providers.find(provider => provider.id === id) || data.providers[0]);
      else { draft = apiDraft = null; dirty = false; unknown = false; policies = structuredClone(data.assignments); touched.clear(); resetComfyImport(); list(); if (section === 'pools') renderPolicies(); controls(); }
      await readDiagnostics(); feedback('');
      if (reloading) await onSaved();
    } catch (error) { if (ticket === generation) { feedback(describe(error), true); onSettings(null, describe(error)); } }
    finally { if (ticket === generation) { busy = false; controls(); } }
  }
  const reasonLabels = { provider_disabled: '供应商已停用', connection_unconfigured: '连接未就绪', function_disabled: '功能已停用', unconfirmed: '用途待确认', protocol_unsupported: '当前协议不支持', model_missing: '模型不存在，已隔离', cooling: '限流冷却中', quota: '额度或预算耗尽', outside_pool: '未加入当前模型池' };
  const time = value => value ? new Date(value).toLocaleString('zh-CN') : '尚无记录';
  async function readDiagnostics() {
    if (!client || !data) return;
    const active = client, ticket = generation;
    try {
      const value = await active.get('/api/v0/provider-management/diagnostics');
      if (ticket !== generation || active !== client) return;
      if (value.contractVersion !== 0 || value.revision !== data.revision) throw new Error('配置已变化，请重新读取模型服务后核对。');
      diagnostics = value; renderHealth();
    } catch (error) { if (ticket === generation) { diagnostics = null; renderHealth(); feedback(describe(error), true); } }
  }
  function renderHealth() {
    $('provider-spectrum').replaceChildren(...Object.entries(LABELS).map(([cap, label], index) => {
      const fact = diagnostics?.capabilities.find(item => item.capability === cap), button = element('button', '', 'provider-spectrum-card');
      button.type = 'button'; button.dataset.tone = String(index); button.dataset.healthCapability = cap;
      button.append(element('strong', label), element('small', fact ? fact.candidates.length + ' 个候选 · ' + fact.verified + ' 个近期成功' : '状态未知'),
        element('small', fact ? ({ auto: '自动池', manual: '手动优先级', disabled: '已停用' }[fact.mode]) + ' · ' + fact.models.filter(item => !item.eligible).length + ' 项未参与' : '请读取状态'));
      button.addEventListener('click', () => { healthCapability = cap; renderHealth(); $('provider-health-details').open = true; }); return button;
    }));
    $('provider-health-title').textContent = LABELS[healthCapability] + ' · 候选与验证';
    const fact = diagnostics?.capabilities.find(item => item.capability === healthCapability);
    $('provider-health-models').replaceChildren(...(fact?.models.length ? fact.models.map(model => {
      const card = element('article', '', 'provider-health-model'); card.append(element('strong', model.providerName + ' / ' + model.modelId));
      card.append(element('p', (model.reason ? reasonLabels[model.reason] : '候选 #' + model.rank) + ' · '
        + ({ verified: '近期成功', failed: '认证或权限受阻', configured: '尚无近期成功证据' }[model.state] || model.state), 'field-note'));
      card.append(element('p', '最近证据 · ' + time(model.evidence?.at) + (model.retryAt ? ' · 冷却至 ' + time(model.retryAt) : ''), 'field-note'));
      const supported = diagnostics.execution && model.eligible && (healthCapability === 'image-gen' || healthCapability === 'tts' && diagnostics.audio || healthCapability === 'transcribe' && diagnostics.audio);
      if (supported) {
        const test = element('button', '准备功能验证', 'secondary'); test.type = 'button'; test.dataset.probeModel = model.ref;
        test.disabled = busy; test.addEventListener('click', () => onProbe({ capability: healthCapability, modelRef: model.ref, comfy: model.comfy })); card.append(test);
        card.append(element('p', model.comfy ? '在创作页核对工作流和参数后提交，可能产生费用。' : '打开指定模型的验证草稿；点击创作页的生成按钮后才调用，可能产生费用。', 'field-note'));
      } else card.append(element('p', ['video-gen', 'music-gen', 'vision'].includes(healthCapability) ? '此功能的 Web 执行尚未接入，请使用现有 CLI / DSH 明确验证。' : '请先开放执行、配置功能池并处理受阻原因，再准备验证。', 'field-note'));
      return card;
    }) : [element('p', diagnostics ? '当前没有已标注此用途的模型。' : '检测状态尚未读取；不会当作通过。', 'field-note')]));
    $('provider-monitors').replaceChildren(...(data?.providers || []).map(provider => {
      const state = diagnostics?.monitors.find(item => item.providerId === provider.id), card = element('article', '', 'card provider-monitor');
      card.append(element('h3', provider.name), element('p', !state?.last ? '尚未检查连接' : (state.last.ok ? '最近连接检查通过' : '最近连接检查未通过 / 未确认')
        + ' · ' + time(state.last.at) + (state.last.code ? ' · ' + state.last.code : ''), 'field-note'));
      const test = element('button', '检查连接', 'secondary'); test.type = 'button'; test.dataset.checkProvider = provider.id;
      test.disabled = busy || !provider.configured || !provider.enabled || !diagnostics;
      test.addEventListener('click', () => manageProvider('check', { providerId: provider.id })); card.append(test);
      const controls = element('div', '', 'provider-monitor-options'), label = element('label', '定期轻量保活'), enabled = element('input'); enabled.type = 'checkbox'; enabled.checked = state?.enabled === true; enabled.dataset.monitorProvider = provider.id;
      const interval = element('select'); interval.setAttribute('aria-label', provider.name + '保活间隔'); options(interval, [['60', '每分钟'], ['300', '每5分钟'], ['900', '每15分钟']], String(state?.intervalSeconds || 300));
      enabled.disabled = interval.disabled = busy || !provider.enabled || !provider.configured || !state?.automaticSupported;
      const update = () => manageProvider('monitor', { providerId: provider.id, enabled: enabled.checked, intervalSeconds: Number(interval.value) });
      enabled.addEventListener('change', update); interval.addEventListener('change', () => { if (enabled.checked) update(); });
      label.prepend(enabled); controls.append(label, interval); card.append(controls);
      if (state && !state.automaticSupported) card.append(element('p', '此扩展协议没有已支持的自动轻量检查。', 'field-note'));
      return card;
    }));
  }
  function enterSection(next) {
    section = next; draft = apiDraft = null; dirty = unknown = false; touched.clear(); resetComfyImport(); $('provider-key').value = '';
    policies = structuredClone(data?.assignments || {}); editor(false);
    if (data) list();
    $('provider-pool-panel').hidden = next !== 'pools'; $('provider-health-panel').hidden = next !== 'health';
    for (const button of document.querySelectorAll('[data-provider-section]')) button.setAttribute('aria-pressed', String(button.dataset.providerSection === next));
    if (next === 'pools') renderPolicies(); if (next === 'health') { renderHealth(); void readDiagnostics(); }
    controls(); feedback('');
  }
  function leave(action) {
    if (busy) return;
    if (unknown) { feedback('保存结果尚未确认，请先重新读取核对。', true); return; }
    if (dirty || comfyTemplate) { pendingLeave = action; $('provider-close-confirm').hidden = false; $('provider-close-confirm').scrollIntoView({ block: 'center' }); $('provider-close-cancel').focus(); return; }
    action();
  }
  async function manageProvider(action, value) {
    if (!client || busy || dirty && action !== 'policies' || unknown) return;
    const active = client, ticket = generation; busy = true; controls(); renderHealth(); feedback('正在处理…');
    try {
      const result = await active.postProvider(action, { expectedRevision: data.revision, ...value });
      if (ticket !== generation) return;
      if (action === 'impact') {
        const blocked = result.blockingTasks.length + result.blockingRuns.length;
        $('provider-delete-impact').textContent = '将移除 ' + result.modelCount + ' 个模型及相关手工池引用。当前工作区：' + result.blockingTasks.length + ' 个待处理任务、' + result.blockingRuns.length + ' 个依赖流程。其他程序或工作区未扫描。作品与历史记录保留；私有配置备份保留原凭据。';
        $('provider-delete-yes').disabled = Boolean(blocked); $('provider-delete-confirm').hidden = false; feedback(blocked ? '仍有未完成或可恢复依赖，暂不能删除。' : '请核对影响后确认删除。', Boolean(blocked));
      } else if (['enabled', 'remove', 'policies'].includes(action)) {
        data = result; onSettings(result); dirty = unknown = false; touched.clear(); policies = structuredClone(data.assignments);
        if (action === 'enabled') {
          const toolsOpen = $('provider-management-tools').open;
          edit(data.providers.find(provider => provider.id === value.providerId));
          $('provider-management-tools').open = toolsOpen;
        }
        else enterSection(action === 'policies' ? 'pools' : 'suppliers');
        await onSaved(); await readDiagnostics(); feedback('已保存。');
      } else { await readDiagnostics(); feedback(action === 'check' ? result.ok ? '连接检查通过；未实测媒体。' : '连接检查未通过或未确认，请核对地址、认证和服务。' : '保活设置已更新，仅本次 Core 服务生效。', action === 'check' && !result.ok); }
    } catch (error) {
      if (ticket === generation) { unknown = ['enabled', 'remove', 'policies'].includes(action) && (!error.status || error.status >= 500 || error.status === 409); feedback(describe(error) + (unknown ? '。请重新读取核对结果，不会自动重试。' : ''), true); }
    } finally { if (ticket === generation) { busy = false; if (section === 'pools') renderPolicies(); controls(); renderHealth(); } }
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
  $('provider-form').addEventListener('input', event => { if (draft && !event.target.closest('#comfyui-tools')) { readForm(); mark(); invalidateComfyCheck(); controls(); } });
  $('provider-key-action').addEventListener('change', keyAction);
  $('provider-protocol').addEventListener('change', () => {
    $('provider-preset').value = $('provider-protocol').value === 'comfyui' ? 'comfyui' : 'custom';
    if ($('provider-protocol').value !== 'comfyui') resetComfyImport(); controls();
  });
  $('provider-auth').addEventListener('change', () => {
    if ($('provider-auth').value === 'none' && !draft.hasCredential && !$('provider-key').value) { $('provider-key-action').value = 'keep'; keyAction(); }
  });
  $('provider-new').addEventListener('click', () => { if (!data || busy) return; if (dirty || comfyTemplate) { editor(true); feedback('请先保存当前草稿，或重新读取后添加。', true); return; } edit(); editor(true); setView('connection'); feedback(''); $('provider-name').focus(); });
  for (const button of document.querySelectorAll('[data-provider-view]')) button.addEventListener('click', () => setView(button.dataset.providerView));
  $('provider-form').addEventListener('invalid', event => {
    const section = event.target.closest('[id^="provider-view-"]'); if (section) setView(section.id.slice('provider-view-'.length));
  }, true);
  const returnToList = () => { enterSection('suppliers'); $('provider-new').focus(); };
  $('provider-back').addEventListener('click', () => leave(returnToList));
  $('provider-cancel').addEventListener('click', () => leave(returnToList));
  $('provider-close-cancel').addEventListener('click', () => { pendingLeave = null; $('provider-close-confirm').hidden = true; });
  $('provider-close-discard').addEventListener('click', () => {
    const action = pendingLeave || returnToList; pendingLeave = null; dirty = false; resetComfyImport(); action(); feedback('未保存修改已放弃。');
  });
  for (const button of document.querySelectorAll('[data-provider-section]')) button.addEventListener('click', () => leave(() => enterSection(button.dataset.providerSection)));
  $('provider-pool-form').addEventListener('submit', event => { event.preventDefault(); if (touched.size) void manageProvider('policies', { assignments: Object.fromEntries([...touched].map(cap => [cap, policies[cap]])) }); });
  $('provider-pool-cancel').addEventListener('click', () => leave(() => enterSection('pools')));
  $('provider-health-refresh').addEventListener('click', () => readDiagnostics());
  $('provider-toggle').addEventListener('click', () => { const saved = data.providers.find(provider => provider.id === draft.id); void manageProvider('enabled', { providerId: saved.id, enabled: !saved.enabled }); });
  $('provider-delete').addEventListener('click', () => manageProvider('impact', { providerId: draft.id }));
  $('provider-delete-yes').addEventListener('click', () => manageProvider('remove', { providerId: draft.id, confirm: true }));
  $('provider-delete-no').addEventListener('click', () => { $('provider-delete-confirm').hidden = true; });
  $('providers-refresh').addEventListener('click', () => refresh());
  $('providers-reload-yes').addEventListener('click', () => refresh(true));
  $('providers-reload-no').addEventListener('click', () => { $('providers-reload-confirm').hidden = true; });
  $('provider-model-add').addEventListener('click', () => { addModel($('provider-model-id').value); $('provider-model-id').value = ''; });
  $('provider-model-id').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('provider-model-add').click(); } });
  $('provider-preset').addEventListener('change', event => {
    if (event.target.value !== 'comfyui' && $('provider-protocol').value === 'comfyui') restoreApiDraft();
    if (event.target.value === 'openai') { $('provider-url').value = 'https://api.openai.com/v1'; $('provider-protocol').value = 'openai-images'; if (!$('provider-name').value) $('provider-name').value = 'OpenAI'; }
    if (event.target.value === 'dashscope') { $('provider-url').value = 'https://dashscope.aliyuncs.com/compatible-mode/v1'; $('provider-protocol').value = 'dashscope'; if (!$('provider-name').value) $('provider-name').value = '百炼'; }
    if (['openai', 'dashscope'].includes(event.target.value)) { $('provider-auth').value = 'bearer'; $('provider-media-url').value = ''; }
    if (event.target.value === 'comfyui') {
      if ($('provider-protocol').value !== 'comfyui') apiDraft = apiFields();
      $('provider-url').value = 'http://127.0.0.1:8188'; $('provider-media-url').value = ''; $('provider-protocol').value = 'comfyui'; $('provider-auth').value = 'none';
      $('provider-key-action').value = 'keep'; keyAction(); if (!$('provider-name').value) $('provider-name').value = 'ComfyUI';
      $('comfyui-tools').open = true;
    }
    if ($('provider-protocol').value !== 'comfyui') resetComfyImport();
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
    event.preventDefault(); if (!client || busy || unknown || comfyTemplate && !importAdded) return;
    readForm(); const active = client, ticket = generation;
    const provider = Object.fromEntries(['id', 'name', 'baseUrl', 'mediaBaseUrl', 'mediaProtocol', 'enabled', 'auth'].map(key => [key, draft[key]]));
    provider.models = draft.models.map(model => ({ id: model.id, capabilities: model.capabilities, imageProtocol: model.imageProtocol || 'auto', musicProtocol: model.musicProtocol || '',
      ...(model.comfyWorkflow?.graph ? { comfyWorkflow: model.comfyWorkflow } : {}) }));
    const action = $('provider-key-action').value, credential = { action, ...(action === 'replace' ? { value: $('provider-key').value } : {}) };
    const input = { expectedRevision: data.revision, provider, credential, assignments: Object.fromEntries([...touched].map(cap => [cap, policies[cap]])) };
    $('provider-close-confirm').hidden = true; busy = true; controls(); feedback('正在保存连接、模型与用途…');
    try {
      const result = await active.postProvider('save', input);
      if (ticket !== generation) return;
      data = result; onSettings(result); const id = draft.id; edit(data.providers.find(provider => provider.id === id)); feedback('已保存。新请求将使用当前配置。'); await onSaved(); await readDiagnostics();
    } catch (error) {
      if (ticket !== generation) return;
      unknown = !error.status || error.status >= 500 || error.status === 409;
      feedback(describe(error) + (unknown ? '。草稿已保留，请重新读取并核对保存结果；不会自动重试。' : ''), true);
    } finally { credential.value = ''; if (ticket === generation) { busy = false; controls(); } }
  });
  function savedComfyConnection() {
    const saved = data?.providers.find(provider => provider.id === draft?.id);
    return saved?.configured && saved.enabled && saved.mediaProtocol === 'comfyui'
      && ['baseUrl', 'mediaBaseUrl', 'mediaProtocol', 'auth', 'enabled'].every(key => draft[key] === saved[key])
      && $('provider-key-action').value === 'keep';
  }
  function invalidateComfyCheck() {
    importRead++; checkController?.abort(); checkController = null;
    $('comfyui-replace').hidden = true;
    if (comfyTemplate) $('comfyui-note').textContent = '草稿已变化，请重新检查。导入与预览不生成图片。';
  }
  function resetComfyImport() {
    invalidateComfyCheck(); comfyTemplate = null; slots = []; importAdded = false;
    $('comfyui-bindings').hidden = true; $('comfyui-file').value = ''; $('comfyui-slots').replaceChildren(); $('comfyui-preview').replaceChildren();
    $('comfyui-note').textContent = '最多 40 KiB。支持 API 图和完整 Iris v0/v1 模板，导入不执行生成。';
  }
  function bindings() { return { promptNode: $('comfyui-prompt-node').value, outputNode: $('comfyui-output-node').value, sizeNode: $('comfyui-size-node').value }; }
  function importWorkflow() { return buildWorkflow(comfyTemplate, bindings(), slots); }
  function previewImport() {
    importAdded = false; invalidateComfyCheck(); controls();
    $('comfyui-exposed-count').textContent = slots.filter(slot => slot.exposed).length + ' / 32';
    try {
      const workflow = importWorkflow(), parameters = (workflow.parameters || []).map(parameter => ({ ...parameter, default: workflow.graph[parameter.node].inputs[parameter.input] }));
      $('comfyui-preview-count').textContent = parameters.length ? parameters.length + ' 个开放参数' : '固定工作流';
      renderWorkflowParameters($('comfyui-preview'), parameters, { disabled: true, preserveOpen: true });
      $('comfyui-add').disabled = false;
    } catch (error) { $('comfyui-preview').replaceChildren(element('p', error.message, 'field-note')); $('comfyui-add').disabled = true; }
  }
  function renderSlots() {
    const previous = new Map(slots.map(slot => [slot.node + '\0' + slot.input, slot]));
    slots = workflowSlots(comfyTemplate, bindings()).map(slot => previous.get(slot.node + '\0' + slot.input) || slot);
    $('comfyui-slots').replaceChildren(...slots.map(slot => {
      const row = element('div', '', 'comfy-slot'), toggle = element('label', '', 'mini-check'), exposed = element('input'); exposed.type = 'checkbox'; exposed.checked = slot.exposed;
      exposed.dataset.comfySlot = slot.node + ':' + slot.input; toggle.append(exposed, element('span', slot.node + ' · ' + slot.input));
      const name = element('input'); name.value = parameterLabel(slot); name.maxLength = 80; name.setAttribute('aria-label', '参数名称 · ' + slot.node + ':' + slot.input); name.disabled = !slot.exposed;
      const type = element('select'); type.setAttribute('aria-label', '参数类型 · ' + slot.node + ':' + slot.input);
      options(type, (['integer', 'number'].includes(slot.type) ? [['integer', '整数'], ['number', '小数']] : [[slot.type, slot.type === 'boolean' ? '开关' : '文本']]), slot.type); type.disabled = !slot.exposed;
      exposed.addEventListener('change', () => { slot.exposed = exposed.checked; name.disabled = type.disabled = !slot.exposed; previewImport(); });
      name.addEventListener('input', () => { slot.label = name.value; previewImport(); }); type.addEventListener('change', () => { slot.type = type.value; previewImport(); });
      row.append(toggle, name, type); return row;
    }));
    previewImport();
  }
  for (const id of ['comfyui-prompt-node', 'comfyui-output-node', 'comfyui-size-node']) $(id).addEventListener('change', () => { if (comfyTemplate) renderSlots(); });
  $('comfyui-model').addEventListener('input', () => { importAdded = false; invalidateComfyCheck(); controls(); });
  $('comfyui-discard').addEventListener('click', () => { resetComfyImport(); controls(); });
  $('comfyui-file').addEventListener('change', async event => {
    const file = event.target.files[0], ticket = generation; event.target.value = '';
    if (!file || busy) return;
    resetComfyImport(); const read = importRead;
    try {
      if (file.size > 40 * 1024) throw new TypeError('工作流超过 40 KiB，请精简后导入。');
      const template = readWorkflowImport(await file.text());
      if (ticket !== generation || read !== importRead || !client) return;
      comfyTemplate = template; const graph = template.graph;
      const entries = Object.entries(graph), label = ([id, node]) => [id, id + ' · ' + node.class_type];
      const prompts = entries.filter(([, node]) => typeof node.inputs.text === 'string').map(label);
      const outputs = entries.filter(([, node]) => /SaveImage|PreviewImage/i.test(node.class_type)).map(label);
      options($('comfyui-prompt-node'), [['', '明确选择提示词节点'], ...prompts], template.promptNode || '');
      options($('comfyui-output-node'), [['', '明确选择输出节点'], ...entries.map(label)], template.outputNode || (outputs.length === 1 ? outputs[0][0] : ''));
      options($('comfyui-size-node'), [['', '沿用工作流尺寸'], ...entries.filter(([, node]) => ['width', 'height'].every(key => Number.isSafeInteger(node.inputs[key]) && node.inputs[key] > 0)).map(label)], template.sizeNode || '');
      $('comfyui-model').value = file.name.replace(/\.json$/i, '').slice(0, 120); $('comfyui-bindings').hidden = false;
      $('comfyui-exposed').open = false; renderSlots();
      $('comfyui-note').textContent = '已读取 ' + entries.length + ' 个节点。请核对绑定及表单预览，再加入设置草稿。';
    } catch (error) { if (ticket === generation && read === importRead) { resetComfyImport(); $('comfyui-note').textContent = error.message; } }
    controls();
  });
  $('comfyui-check').addEventListener('click', async () => {
    if (busy || !client || !comfyTemplate || !savedComfyConnection()) return;
    let workflow; try { workflow = importWorkflow(); } catch (error) { $('comfyui-note').textContent = error.message; return; }
    const active = client, ticket = generation, read = ++importRead; checkController = new AbortController();
    busy = true; controls(); $('comfyui-note').textContent = '正在只读检查…';
    try {
      const report = await active.postProvider('workflow-check', { expectedRevision: data.revision, providerId: draft.id, comfyWorkflow: workflow }, { signal: checkController.signal });
      if (ticket === generation && read === importRead) $('comfyui-note').textContent = inspectionMessage(report);
    } catch (error) { if (ticket === generation && read === importRead) $('comfyui-note').textContent = describe(error); }
    finally { if (ticket === generation) { busy = false; checkController = null; controls(); } }
  });
  function addWorkflow(confirmed = false) {
    if (!comfyTemplate || busy) return;
    const id = $('comfyui-model').value.trim();
    if (!id) { $('comfyui-note').textContent = '请填写工作流名称。'; return; }
    let workflow; try { workflow = importWorkflow(); } catch (error) { $('comfyui-note').textContent = error.message; return; }
    let model = draft.models.find(model => model.id === id);
    if (model && !confirmed) { $('comfyui-replace').hidden = false; return; }
    if (!model) { model = { id, capabilities: [], imageProtocol: 'comfyui', musicProtocol: '' }; draft.models.push(model); }
    model.comfyWorkflow = workflow; importAdded = true; $('comfyui-replace').hidden = true;
    model.imageProtocol = 'comfyui'; if (!model.capabilities.includes('image-gen')) model.capabilities.push('image-gen');
    if (policies['image-gen'].mode === 'disabled') { policies['image-gen'].mode = 'auto'; touched.add('image-gen'); }
    mark(); renderModels(); renderPolicies(); $('comfyui-note').textContent = '已加入模型草稿。点击“保存设置”后，创作页可选择此工作流。';
  }
  $('comfyui-add').addEventListener('click', () => addWorkflow());
  $('comfyui-replace-yes').addEventListener('click', () => addWorkflow(true));
  $('comfyui-replace-no').addEventListener('click', () => { $('comfyui-replace').hidden = true; });
  return Object.freeze({
    async connect(value) { client = value; generation++; dirty = false; data = null; draft = null; section = 'suppliers'; diagnostics = null; editor(false); $('provider-pool-panel').hidden = $('provider-health-panel').hidden = true; await refresh(); },
    disconnect() { generation++; resetComfyImport(); client = null; data = draft = apiDraft = diagnostics = null; pendingLeave = null; directory = []; policies = {}; touched.clear(); dirty = busy = unknown = false; section = 'suppliers'; editor(false); $('provider-pool-panel').hidden = $('provider-health-panel').hidden = true; for (const id of ['provider-spectrum','provider-health-models','provider-monitors']) $(id).replaceChildren(); $('provider-key').value = ''; $('provider-form').reset(); $('provider-models').replaceChildren(); $('providers-list').replaceChildren(); $('provider-directory-list').replaceChildren(); $('provider-assignments').replaceChildren(); $('providers-reload-confirm').hidden = true; feedback(''); },
    show(visible) { if (visible && client && data && !busy && !dirty && !comfyTemplate) void refresh(); }
  });
}
