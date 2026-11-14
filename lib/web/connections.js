// Explicit owner management only. No discovery, credential storage or automatic media call.
const BASE = '/api/v0/connection-management';
const $ = selector => document.querySelector(selector);
const states = { pending: '尚未使用', used: '使用过', revoked: '已撤销', configured: '静态配置' };
const element = (tag, text, className) => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
const checked = selector => [...document.querySelectorAll(selector + ':checked')].map(input => input.value);
const date = value => new Date(value).toLocaleString('zh-CN');

function selectedToolNames(record, catalog) {
  const controls = catalog.controlTools || catalog.tools.filter(tool => !catalog.groups.some(group => group.tools.includes(tool.name))).map(tool => tool.name);
  return new Set([...controls, ...catalog.groups.filter(group => record.capabilities.includes(group.id)).flatMap(group => group.tools),
    ...(record.pluginOperations?.length ? catalog.pluginControlTools || [] : [])]);
}
function effectiveTools(record, catalog) {
  const selected = selectedToolNames(record, catalog);
  const definitions = new Map([...catalog.tools, ...(catalog.pluginTools || [])].map(tool => [tool.name, tool]));
  return record.tools.filter(name => selected.has(name) && catalog.availableTools.includes(name)
    && definitions.has(name) && record.scopes.includes(definitions.get(name).scope) && catalog.availableScopes.includes(definitions.get(name).scope));
}
const samePin = (a, b) => ['contractVersion', 'pluginId', 'pluginVersion', 'kind', 'contributionId', 'contributionVersion'].every(key => a[key] === b[key]);

/** Owner GET facts only. This is a configuration check, never a transport probe or authority. */
export function inspectMcpSetup(record, catalog, { transport = 'stdio', location = 'same' } = {}) {
  if (catalog.contractVersion !== 0) throw new TypeError('不支持的连接管理版本');
  const issues = [], issue = (code, message) => issues.push({ code, message });
  const revoked = Boolean(record.revokedAt || record.state === 'revoked');
  if (location !== 'same') issue('location', '当前导出使用 Core 主机的回环地址与本机路径，不能直接交给另一台机器上的客户端。');
  if (transport === 'http' && !catalog.httpEnabled) issue('transport', '此服务没有开启 HTTP MCP；可选本机 stdio，或在下次明确启动服务时开启 HTTP。');
  if (revoked) issue('revoked', '此连接已撤销，旧配置不能继续使用。需要接入时请新建连接。');
  if (record.scopes.some(scope => !catalog.availableScopes.includes(scope))) issue('scope', '保存的操作权限超出此服务当前开放的范围，请核对服务开关与连接设置。');
  if (record.capabilities.some(id => !catalog.groups.some(group => group.id === id))) issue('capability', '此工作区没有开放全部已选媒体分组，原授权未被自动替换。');
  for (const pin of record.pluginOperations || []) {
    const entry = catalog.contributions.operations.find(item => item.id === pin.contributionId);
    if (!entry) issue('plugin', pin.contributionId + '：业务未加载，历史仍保留，请核对准确插件版本。');
    else if (!samePin(entry.dependency, pin)) issue('plugin', pin.contributionId + '：当前业务与保存的准确依赖版本不一致。');
    else if (entry.access.mcp !== 'requires-selection') issue('plugin', pin.contributionId + '：此服务尚未启用该业务；历史读取可能仍可用。');
  }
  const tools = revoked ? [] : effectiveTools(record, catalog);
  if (!revoked && !tools.length) issue('tools', '当前选择没有可用工具，请明确选择功能、工具与对应权限；不会自动补齐。');
  return { ok: issues.length === 0, issues, tools, mediaTested: false, transportTested: false };
}

/** A raw bridge/self-check handshake is not an MCP client's declaration. No online inference. */
export function mcpClientEvidence(record, catalog) {
  if (record.revokedAt || record.state === 'revoked') return { state: 'revoked', label: '连接已撤销', instances: [] };
  const instances = (record.instances || []).filter(instance => instance.declaredClient?.source === 'client-declared').map(instance => ({
    state: instance.state, at: instance.declaredClient.at, clientInfo: instance.declaredClient.clientInfo,
    transport: instance.declaredClient.transport, tools: effectiveTools(instance, catalog) }));
  if (instances.some(instance => instance.state === 'connected')) return { state: 'observed', label: '收到客户端握手与声明', instances };
  if (instances.length) return { state: 'disconnected', label: '客户端握手已断开', instances };
  if (record.lastContact) return { state: 'historical', label: '有历史客户端声明', instances, contact: record.lastContact };
  if (record.instances?.some(instance => instance.state === 'connected')) return { state: 'bridge', label: '仅收到桥接握手', instances };
  return { state: 'waiting', label: '等待客户端握手与声明', instances };
}

export function createConnectionPanel({ describe }) {
  let client, epoch = 0, catalog, records = [], selected = null, key, busy = false, visible = false, viewTicket = 0;
  let scopes = {};
  let capabilities = [], tools = [], pluginOperations = [], allowedScopes = ['read'], templates = [], skillBundle = null;
  let view = 'settings', exportDelivery = null;
  let formDirty = false;
  const exports = new Map(), inspections = new Map();
  let checkController = null;
  const closeButton = element('button', '返回列表', 'quiet'); closeButton.type = 'button'; closeButton.id = 'connection-cancel';
  const closeArea = element('div', '', 'provider-footer'); closeArea.append(closeButton); $('#connection-editor').append(closeArea);
  const urls = new Set();
  const current = () => records.find(record => record.connectionId === selected);
  const valid = (at, connection) => at === epoch && client === connection;
  function editor(open) { $('#connection-editor').hidden = !open; $('#connections-overview').hidden = open; }
  function setView(next) {
    if (next !== view) cancelCheck();
    if (next !== view) clearExport(); view = next;
    for (const button of document.querySelectorAll('[data-connection-view]')) {
      const active = button.dataset.connectionView === view; button.setAttribute('aria-pressed', String(active));
      $('#connection-view-' + button.dataset.connectionView).hidden = !active;
    }
    renderOnboarding(); controls();
  }
  function feedback(text = '', error = false) {
    const node = $('#connections-feedback'); node.hidden = !text; node.textContent = text; node.classList.toggle('error', error);
  }
  function clearExport() {
    viewTicket++;
    exportDelivery = null;
    $('#connection-configuration').value = ''; $('#connection-export-result').hidden = true;
    $('#connection-export-note').textContent = '';
    skillBundle = null; $('#connection-skill-preview').value = ''; $('#connection-skill-result').hidden = true;
    for (const url of urls) URL.revokeObjectURL(url); urls.clear();
    renderOnboarding();
  }
  function controls() {
    const record = current(), editable = !record || record.managed && !record.revokedAt;
    $('#connection-fields').disabled = busy || !catalog || !editable;
    for (const id of ['connection-new', 'connection-export-button', 'connection-revoke', 'connection-revoke-yes', 'connection-revoke-no', 'connection-delete', 'connection-delete-yes', 'connection-delete-no',
      'connection-template', 'connection-template-import', 'connection-template-example', 'connection-template-file', 'connection-skill-generate']) $('#' + id).disabled = busy || !catalog;
    for (const id of ['connection-transport', 'connection-format']) $('#' + id).disabled = busy || !catalog || Boolean($('#connection-template').value);
    $('#connections-refresh').disabled = busy;
    $('#connection-back').disabled = busy;
    closeButton.disabled = busy;
    for (const node of document.querySelectorAll('#connections-list .connection-item')) node.disabled = busy;
    for (const button of document.querySelectorAll('[data-connection-view]')) button.disabled = busy || button.dataset.connectionView === 'delivery' && (!record?.managed || Boolean(record.revokedAt)) || ['details', 'verification'].includes(button.dataset.connectionView) && !record;
    $('#connection-export-button').disabled ||= formDirty || $('#connection-location').value !== 'same';
    $('#connection-check').disabled = busy || !catalog || !record || formDirty;
    $('#connection-location').disabled = busy;
    $('#connection-verify-next').disabled = busy || !record;
  }
  function renderList() {
    $('#connections-count').textContent = String(records.filter(record => record.state !== 'revoked').length);
    $('#connections-empty').hidden = records.length !== 0;
    $('#connections-list').replaceChildren(...records.map(record => {
      const button = element('button', '', 'connection-item service-card'); button.type = 'button'; button.dataset.connectionId = record.connectionId;
      button.setAttribute('aria-current', String(record.connectionId === selected));
      const heading = element('span', '', 'service-card-heading'); heading.append(element('span', 'MCP', 'service-mark'), element('small', states[record.state] || record.state, 'service-status'));
      const media = record.capabilities.map(id => { const group = catalog.groups.find(group => group.id === id); return group?.shortTitle || group?.title || id; });
      for (const pin of record.pluginOperations || []) media.push(catalog.contributions?.operations?.find(item => item.id === pin.contributionId)?.title || pin.contributionId);
      button.append(heading, element('strong', record.label), element('span', media.join(' · ') || '仅控制工具', 'service-endpoint'),
        element('span', record.lastContact ? '最近使用 · ' + date(record.lastContact.at) : '等待客户端首次使用', 'service-meta'), element('span', record.revokedAt ? '查看与管理 →' : '接入与管理 →', 'service-action'));
      button.addEventListener('click', () => { if (!busy) { select(record.connectionId); editor(true); setView(record.managed && !record.revokedAt ? 'delivery' : 'details'); } }); return button;
    }));
    controls();
  }
  function option(value, title, selectedValues, change, { disabled = false, note = '' } = {}) {
    const label = element('label', '', 'check-option'), input = document.createElement('input');
    input.type = 'checkbox'; input.value = value; input.checked = selectedValues.includes(value); input.disabled = disabled;
    input.addEventListener('change', change); const text = element('span', title);
    if (note) text.append(element('small', note)); label.append(input, text); return label;
  }
  function enabledTools() {
    return new Set([...selectedToolNames({ capabilities, pluginOperations }, catalog)].filter(name => !catalog.availableTools || catalog.availableTools.includes(name)));
  }
  function renderTools() {
    const enabled = enabledTools();
    $('#connection-tools').replaceChildren(...catalog.tools.filter(tool => enabled.has(tool.name)).map(tool =>
      option(tool.name, tool.name.replace('iris_core_', ''), tools, () => {
        tools = checked('#connection-tools input'); countTools(); clearExport();
      }, { disabled: !allowedScopes.includes(tool.scope) || !catalog.availableScopes.includes(tool.scope), note: scopes[tool.scope] })));
    countTools();
  }
  function countTools() {
    const count = catalog.tools.filter(tool => tools.includes(tool.name) && allowedScopes.includes(tool.scope) && catalog.availableScopes.includes(tool.scope)
      && enabledTools().has(tool.name)).length;
    $('#connection-tool-count').textContent = count + ' 个可用';
  }
  function renderOptions() {
    const mediaOptions = catalog.media.map(media => option(media.id, media.title,
      media.capabilities.some(id => capabilities.includes(id)) ? [media.id] : [], () => {
        const enabled = checked('#connection-media input');
        capabilities = catalog.media.filter(item => enabled.includes(item.id)).flatMap(item => {
          const selected = item.capabilities.filter(id => capabilities.includes(id));
          return selected.length ? selected : item.capabilities.slice(0, 1);
        });
        tools = [...enabledTools()];
        renderOptions(); clearExport();
      }, { disabled: !media.capabilities.length, note: !media.capabilities.length ? '未接入' : media.note || '' }));
    $('#connection-media').replaceChildren(...mediaOptions.filter((_, index) => catalog.media[index].capabilities.length));
    $('#connection-media-unavailable').replaceChildren(...mediaOptions.filter((_, index) => !catalog.media[index].capabilities.length));
    for (const kind of ['image', 'vision']) {
      const media = catalog.media.find(item => item.id === kind), selector = '#connection-' + kind + '-options';
      $(selector).hidden = !media?.capabilities.length;
      $(selector).replaceChildren(...(media?.capabilities || []).map(id => option(id,
        catalog.groups.find(group => group.id === id).label || catalog.groups.find(group => group.id === id).title, capabilities, () => {
          capabilities = [...capabilities.filter(id => !media.capabilities.includes(id)), ...checked(selector + ' input')];
          tools = [...enabledTools()];
          renderOptions(); clearExport();
        })));
    }
    const entries = (catalog.contributions?.operations || []).filter(item => item.access.mcp === 'requires-selection');
    const choices = entries.map(item => ({ title: item.title, dependency: item.dependency, available: true, imageInput: !!item.artifactInputs?.length }));
    for (const pin of pluginOperations) if (!choices.some(item => JSON.stringify(item.dependency) === JSON.stringify(pin))) choices.push({ title: pin.contributionId, dependency: pin, available: false });
    $('#connection-plugin-section').hidden = !choices.length;
    $('#connection-plugin-options').replaceChildren(...choices.map(item => option(JSON.stringify(item.dependency), item.title,
      pluginOperations.map(pin => JSON.stringify(pin)), () => {
        pluginOperations = checked('#connection-plugin-options input').map(value => JSON.parse(value));
        const enabled = enabledTools();
        tools = [...new Set([...tools, ...(pluginOperations.length ? catalog.pluginControlTools || [] : [])])].filter(name => enabled.has(name));
        renderOptions(); clearExport();
      }, { note: item.dependency.pluginVersion + ' · ' + (item.available ? '需允许执行；只开放此准确业务版本' : '当前不可用；保留选择可读取原记录')
        + (item.imageInput ? ' · 图片输入共享本空间内 ≤8 MiB PNG/JPEG/WebP 素材' : '') })));
    $('#connection-scopes').replaceChildren(...Object.entries(scopes).map(([id, title]) => option(id, title, allowedScopes, () => {
      allowedScopes = checked('#connection-scopes input'); renderOptions(); clearExport();
    }, { disabled: id === 'read' || !catalog.availableScopes.includes(id) && !allowedScopes.includes(id), note: catalog.availableScopes.includes(id) ? '' : '服务未开启' })));
    renderTools();
  }
  function fact(label, value) { $('#connection-facts').append(element('dt', label), element('dd', value)); }
  function select(id = null) {
    selected = id; key = crypto.randomUUID(); clearExport(); feedback();
    const record = current();
    capabilities = [...(record?.capabilities || catalog.defaults?.capabilities || catalog.groups.slice(0, 1).map(group => group.id))];
    pluginOperations = structuredClone(record?.pluginOperations || []);
    const enabled = enabledTools();
    tools = [...(record?.tools || catalog.tools.filter(tool => enabled.has(tool.name)).map(tool => tool.name))];
    allowedScopes = [...(record?.scopes || ['read'])];
    $('#connection-name').value = record?.label || '';
    $('#connection-editor-title').textContent = record ? '连接设置' : '新建连接';
    $('#connection-state').textContent = record ? states[record.state] : '尚未保存';
    $('#connection-save').textContent = record ? '保存更改' : '创建连接';
    $('#connection-save-note').textContent = record?.revokedAt ? '连接已撤销。可删除记录，需要使用时请新建连接。'
      : record && !record.managed ? '静态授权由启动文件管理。' : '仅更新授权配置，不调用模型。';
    $('#connection-facts').replaceChildren(); $('#connection-facts').hidden = !record;
    if (record) {
      const instances = [...record.instances].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
      const contact = record.lastContact || instances.find(instance => instance.declaredClient)?.declaredClient;
      fact('连接身份', record.connectionId);
      fact('客户端声明', contact ? contact.clientInfo.name + ' · ' + contact.clientInfo.version : '尚未收到');
      if (contact) fact('最近声明', date(contact.at) + ' · ' + contact.transport);
      fact('桥接', record.adapterId || 'iris.mcp');
      if (instances.length) fact('桥版本', instances[0].harnessVersion);
      fact('实例记录', record.instances.length ? record.instances.length + ' 个握手实例（不表示持续在线）' : '当前无握手实例');
    }
    $('#connection-export').hidden = !record?.managed || Boolean(record.revokedAt);
    $('#connection-revoke-section').hidden = !record?.managed;
    $('#connection-revoke-confirm').hidden = true; $('#connection-revoke').hidden = Boolean(record?.revokedAt);
    $('#connection-delete-confirm').hidden = true; $('#connection-delete').hidden = false;
    $('#connection-tool-details').open = false;
    $('#connection-skill-details').open = false;
    $('#connection-transport option[value="http"]').disabled = !catalog.httpEnabled;
    if (!record) setView('settings'); else if (view === 'delivery' && (!record.managed || record.revokedAt)) setView('details');
    transportNote();
    renderOptions(); renderList();
    formDirty = false; $('#connection-leave-confirm').hidden = true; closeButton.textContent = '返回列表';
    renderOnboarding(); controls();
  }
  async function reload(connection) {
    const result = await connection.get(BASE + '/connections');
    if (result.contractVersion !== 0) throw new TypeError('不支持的连接列表版本');
    return result.connections;
  }
  function renderContributions() {
    const section = $('#connection-contributions'), list = $('#connection-contribution-list');
    list.replaceChildren(); section.hidden = !catalog?.plugins?.length;
    if (section.hidden) return;
    const labels = { providers: '模型协议', operations: '业务操作', pages: '页面', renderers: '作品渲染器', settings: '设置表单' };
    const status = { 'requires-grant': '需显式本地授权', 'requires-configuration': '需配置模型服务',
      'descriptor-only': '仅声明', unavailable: '已不可用', 'not-exposed': 'MCP 尚未接入',
      'durable-operation-required': 'MCP 待接入持久执行', 'not-mounted': '页面尚未挂载', 'available-in-panel': '已选入工作台' };
    Object.assign(status, { 'via-operation': 'Core 持久执行', 'requires-selection': '用户选择后可经 MCP 调用' });
    for (const [kind, entries] of Object.entries(catalog.contributions)) for (const entry of entries) {
      const item = element('li'), remote = kind === 'operations' ? entry.access.mcp : ['pages', 'renderers', 'settings'].includes(kind) ? entry.access.web : null;
      item.append(element('strong', entry.title), document.createTextNode(' · ' + labels[kind] + ' · ' + (status[entry.access.local] || entry.access.local)
        + (remote ? ' · ' + (status[remote] || remote) : '')),
        element('p', entry.dependency.pluginId + '@' + entry.dependency.pluginVersion + ' · ' + entry.id + '@' + entry.version, 'field-note'));
      list.append(item);
    }
  }
  function setCatalog(value) {
    catalog = { ...value, tools: [...value.tools, ...(value.pluginTools || [])] };
    // A running preview may still serve the earlier v0 DTO. Derive safe choices from its declarations.
    scopes = Object.fromEntries((catalog.scopeOptions || catalog.availableScopes.map(id => ({ id, title: id }))).map(item => [item.id, item.title]));
    renderContributions();
  }
  function transportNote() {
    $('#connection-transport-note').textContent = $('#connection-transport').value === 'http'
      ? 'HTTP：客户端连接此 Iris 服务的 /mcp 地址，使用导出配置中的专属密钥。Iris 服务需保持运行。'
      : 'stdio：客户端按 command / args 启动本机 MCP 桥接进程。保留本机路径，Iris 服务需保持运行。';
  }
  function templateChoice() {
    const template = templates.find(item => item.choiceId === $('#connection-template').value), note = $('#connection-template-note');
    note.replaceChildren(); note.hidden = !template;
    if (template) {
      $('#connection-transport').value = template.transport; $('#connection-format').value = template.format;
      note.append(document.createTextNode((template.hint || '模板只应用传输和格式。') + ' 不增加授权。'));
      if (template.documentationUrl) {
        const link = element('a', '查看客户端文档'); link.href = template.documentationUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; note.append(link);
      }
    }
    clearExport(); transportNote(); controls();
  }
  function renderTemplates(selectedId = $('#connection-template').value) {
    const manual = element('option', '手动选择'); manual.value = '';
    $('#connection-template').replaceChildren(manual, ...templates.map(template => {
      const node = element('option', template.title); node.value = template.choiceId; node.disabled = template.transport === 'http' && !catalog.httpEnabled; return node;
    }));
    $('#connection-template').value = templates.some(template => template.choiceId === selectedId && (template.transport !== 'http' || catalog.httpEnabled)) ? selectedId : '';
    templateChoice();
  }
  function setTemplates(value) {
    templates = [...(value.presets || []).map(item => ({ ...item, choiceId: 'preset:' + item.presetId })), ...value.templates.map(item => ({ ...item, choiceId: item.templateId }))];
    const formats = value.formats || ['mcpServers', 'entry'];
    for (const option of $('#connection-format').options) option.disabled = !formats.includes(option.value);
  }
  const choiceKey = () => [$('#connection-location').value, $('#connection-transport').value, $('#connection-format').value].join(':');
  function renderOnboarding() {
    const record = current();
    const scopeTitles = allowedScopes.map(id => scopes[id] || id);
    const names = (catalog?.groups || []).filter(group => capabilities.includes(group.id)).map(group => group.label || group.title);
    for (const pin of pluginOperations) names.push(catalog?.contributions?.operations?.find(item => samePin(item.dependency, pin))?.title || pin.contributionId);
    $('#connection-grant-summary').textContent = (names.join('、') || '仅控制工具') + ' · ' + scopeTitles.join('、');
    $('#connection-unsaved-note').hidden = !formDirty;
    $('#connection-location-note').textContent = $('#connection-location').value === 'same'
      ? '这里指运行 Agent 的机器，不是打开此网页的手机或电脑。两种传输都需要 Core 保持运行。'
      : '当前配置含 Core 主机的回环地址或本机路径，不能直接交给另一台机器上的客户端。请先确认部署方案；本页不会开启公网访问。';
    const exported = record && exports.get(record.connectionId), inspected = record && inspections.get(record.connectionId);
    const exportCurrent = exported && exported.revision === record.revision && exported.choice === choiceKey() && !formDirty;
    const inspectionCurrent = inspected && inspected.revision === record.revision && inspected.choice === choiceKey() && !formDirty;
    $('#connection-export-state').textContent = exportCurrent ? '当前配置已生成' : '本页未记录当前配置导出';
    $('#connection-export-evidence').textContent = exportCurrent ? date(exported.at) + ' · ' + exported.transport + ' · ' + exported.format + '；仍需导入客户端。'
      : '只记录本次登录中生成的配置。若你已在客户端配置过，可直接核对接入。';
    $('#connection-check-state').textContent = inspectionCurrent ? inspected.ok ? 'Iris 端配置检查通过' : '有待核对项' : '尚未检查当前配置';
    $('#connection-check-state').dataset.state = inspectionCurrent ? inspected.ok ? 'passed' : 'limited' : 'pending';
    $('#connection-check-evidence').textContent = inspectionCurrent ? date(inspected.at) + ' · 只读取此服务与保存授权，未检查客户端传输或媒体。'
      : '检查不会建立 MCP 连接，不会代替客户端握手或调用模型。';
    $('#connection-check-issues').replaceChildren(...(inspectionCurrent ? inspected.issues : []).map(item => { const row = element('li', item.message); row.dataset.check = item.code; return row; }));
    $('#connection-check-tools').replaceChildren(...(inspectionCurrent ? inspected.tools : []).map(name => element('li', name)));
    $('#connection-check-tools-note').textContent = inspectionCurrent ? inspected.tools.length + ' 个工具按当前授权允许使用；需在客户端确认是否已发现。' : '完成只读检查后显示 Core 当前允许的工具。';
    const evidence = record && catalog ? mcpClientEvidence(record, catalog) : null;
    $('#connection-client-state').textContent = evidence?.label || '等待创建连接';
    $('#connection-client-state').dataset.state = evidence?.state || 'waiting';
    $('#connection-client-evidence').replaceChildren();
    for (const instance of evidence?.instances || []) {
      const item = element('li', instance.clientInfo.name + ' · ' + instance.clientInfo.version + ' · ' + instance.transport + ' · '
        + (instance.state === 'connected' ? '握手记录' : '已断开') + ' · ' + date(instance.at));
      const details = element('details', '', 'tool-details'), summary = element('summary', ''), disclosure = element('span', '展开', 'disclosure');
      summary.append(element('span', '本次协商允许 ' + instance.tools.length + ' 个工具'), disclosure);
      const names = element('ul', '', 'connection-check-tools'); names.append(...instance.tools.map(name => element('li', name)));
      details.append(summary, names); details.addEventListener('toggle', () => { disclosure.textContent = details.open ? '收起' : '展开'; }); item.append(details);
      $('#connection-client-evidence').append(item);
    }
    if (evidence?.contact) $('#connection-client-evidence').append(element('li', evidence.contact.clientInfo.name + ' · ' + date(evidence.contact.at) + ' · 仅为历史声明'));
  }
  function cancelCheck() {
    if (!checkController) return;
    checkController.abort(); checkController = null; busy = false;
    feedback('只读检查已取消，未建立客户端连接。');
  }
  async function checkSetup() {
    const original = current();
    if (busy || !client || !original || formDirty || !visible) return;
    const at = epoch, connection = client, id = selected, ticket = viewTicket, choice = choiceKey();
    const controller = new AbortController(); checkController = controller; inspections.delete(id); renderOnboarding(); busy = true; controls(); feedback('正在只读核对 Iris 配置和客户端记录…');
    const currentRequest = () => valid(at, connection) && checkController === controller && visible && selected === id && viewTicket === ticket;
    try {
      const options = { signal: controller.signal };
      const [available, saved, session] = await Promise.all([connection.get(BASE + '/catalog', options), connection.get(BASE + '/connections', options), connection.get('/api/v0/session', options)]);
      if (!currentRequest()) return;
      if ([available, saved, session].some(value => value.contractVersion !== 0)) throw new TypeError('不支持的连接检查版本');
      records = saved.connections; setCatalog(available);
      const record = current();
      if (!record || record.revision !== original.revision) {
        inspections.delete(id); exports.delete(id); select(record?.connectionId || null);
        feedback('连接授权已变化，请核对当前设置后重新检查。', true); return;
      }
      const result = inspectMcpSetup(record, catalog, { transport: $('#connection-transport').value, location: $('#connection-location').value });
      inspections.set(id, { ...result, at: new Date().toISOString(), revision: record.revision, choice });
      // No draft can be active here. Refresh the badge/facts from the same saved record as the evidence.
      select(id);
      feedback(result.ok ? mcpClientEvidence(record, catalog).state === 'observed'
        ? '已读取当前配置与客户端声明；握手不代表持续在线或媒体已实测。'
        : 'Iris 端配置检查通过。请在客户端导入配置，再核对实际握手；媒体尚未实测。'
        : '发现需核对的配置项，读取或历史功能可能仍可用。', !result.ok);
    } catch (error) {
      if (currentRequest()) { inspections.delete(id); renderOnboarding(); feedback('只读检查未完成：' + describe(error), true); }
    } finally { if (checkController === controller) { checkController = null; busy = false; controls(); } }
  }
  function download(value, filename, mediaType = 'application/json') {
    const url = URL.createObjectURL(new Blob([value], { type: mediaType })); urls.add(url);
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 1000);
  }
  async function perform(action) {
    if (busy || !client) return;
    const at = epoch, connection = client; busy = true; controls(); feedback('正在处理…');
    try { await action({ at, connection, valid: () => valid(at, connection) }); }
    catch (error) {
      if (valid(at, connection)) feedback((!error.status || error.status >= 500 ? '尚未确认操作结果，请刷新连接记录核对。' : '')
        + (error.name === 'TimeoutError' ? '请求等待超时。' : describe(error)), true);
    }
    finally { if (valid(at, connection)) { busy = false; controls(); } }
  }
  $('#connection-form').addEventListener('submit', event => {
    event.preventDefault(); const record = current();
    if (record && (!record.managed || record.revokedAt)) return;
    perform(async ctx => {
      const value = { label: $('#connection-name').value, scopes: allowedScopes, capabilities, tools,
        ...(pluginOperations.length || record?.pluginOperations?.length ? { pluginOperations } : {}) };
      const result = await ctx.connection.postManagement(BASE + '/connections' + (record ? '/' + selected + '/update' : ''),
        { ...value, ...(record ? { expectedRevision: record.revision } : { key }) });
      const next = await reload(ctx.connection); if (!ctx.valid()) return;
      records = next; select(result.connectionId); if (!record) setView('delivery'); feedback(record ? '更改已保存，后续调用按新授权检查。' : '连接已创建。生成配置并交给客户端后，即可接入。');
    });
  });
  $('#connection-export-button').addEventListener('click', () => {
    if (formDirty || $('#connection-location').value !== 'same') return;
    clearExport();
    const id = selected, ticket = viewTicket;
    perform(async ctx => {
      const choice = templates.find(item => item.choiceId === $('#connection-template').value);
      const result = await ctx.connection.postManagement(BASE + '/connections/' + id + '/export', choice
        ? choice.presetId ? { presetId: choice.presetId } : { templateId: choice.templateId }
        : { transport: $('#connection-transport').value, format: $('#connection-format').value });
      if (!ctx.valid()) return;
      if (selected !== id || !visible || viewTicket !== ticket) return;
      $('#connection-configuration').value = result.content ?? JSON.stringify(result.configuration, null, 2) + '\n';
      exportDelivery = { filename: result.filename || 'iris-mcp.json', mediaType: result.mediaType || 'application/json' };
      $('#connection-download').textContent = exportDelivery.filename.endsWith('.toml') ? '下载 TOML' : '下载 JSON';
      $('#connection-export-note').textContent = result.containsCredentials ? '此 HTTP 配置含连接密钥，请仅交给获授权的本机客户端。' : 'stdio 配置引用本机私有文件，需要使用本机路径。';
      $('#connection-export-result').hidden = false; feedback('配置已生成。客户端是否安装或加载，需要在客户端确认。');
      const record = current();
      exports.set(id, { at: new Date().toISOString(), revision: record.revision, choice: choiceKey(), transport: $('#connection-transport').value, format: $('#connection-format').value });
      renderOnboarding();
    });
  });
  $('#connection-copy').addEventListener('click', async () => {
    const at = epoch, id = selected, ticket = viewTicket;
    const currentCopy = () => at === epoch && id === selected && ticket === viewTicket && visible;
    try { await navigator.clipboard.writeText($('#connection-configuration').value); if (currentCopy()) feedback('配置已复制。'); }
    catch (error) { if (currentCopy()) feedback('未能复制，请手动选择配置文本。' + error.message, true); }
  });
  $('#connection-download').addEventListener('click', () => {
    const value = $('#connection-configuration').value; if (!value) return;
    download(value, exportDelivery.filename, exportDelivery.mediaType);
    clearExport();
    $('#connection-export-note').textContent = ''; feedback('配置下载已交给浏览器。');
  });
  $('#connection-template').addEventListener('change', templateChoice);
  $('#connection-template-example').addEventListener('click', () => { if (catalog) download(JSON.stringify(catalog.templateExample, null, 2) + '\n', 'iris-template.json'); });
  $('#connection-template-import').addEventListener('click', () => $('#connection-template-file').click());
  $('#connection-template-file').addEventListener('change', () => {
    const file = $('#connection-template-file').files[0]; $('#connection-template-file').value = ''; if (!file) return;
    perform(async ctx => {
      if (file.size > 8192) throw Object.assign(new Error('模板最多 8 KiB。'), { status: 400 });
      let value;
      try { value = JSON.parse(await file.text()); }
      catch (_) { throw Object.assign(new Error('请选择有效的 JSON 模板。'), { status: 400 }); }
      if (!ctx.valid()) return;
      const imported = await ctx.connection.postManagement(BASE + '/templates', value);
      const result = await ctx.connection.get(BASE + '/templates'); if (!ctx.valid()) return;
      setTemplates(result); renderTemplates(imported.templateId); feedback('模板已保存，仅应用传输与格式；连接授权没有改变。');
    });
  });
  $('#connection-skill-generate').addEventListener('click', () => {
    clearExport(); const id = selected, ticket = viewTicket;
    perform(async ctx => {
      const result = await ctx.connection.postManagement(BASE + '/connections/' + id + '/skill', {});
      if (!ctx.valid()) return;
      if (selected !== id || !visible || viewTicket !== ticket) return;
      skillBundle = result.bundle; $('#connection-skill-preview').value = result.preview; $('#connection-skill-result').hidden = false;
      feedback('说明已生成。下载并安装后，还需在客户端确认已发现此 Skill。');
    });
  });
  $('#connection-skill-download').addEventListener('click', () => {
    if (!skillBundle) return;
    download(JSON.stringify(skillBundle, null, 2) + '\n', 'iris-skill.json'); clearExport(); feedback('Skill 文件下载已交给浏览器，尚未安装。');
  });
  $('#connection-skill-clear').addEventListener('click', clearExport);
  $('#connection-revoke').addEventListener('click', () => { $('#connection-revoke-confirm').hidden = false; $('#connection-revoke').hidden = true; $('#connection-delete').hidden = true; clearExport(); });
  $('#connection-revoke-no').addEventListener('click', () => { $('#connection-revoke-confirm').hidden = true; $('#connection-revoke').hidden = false; $('#connection-delete').hidden = false; });
  $('#connection-revoke-yes').addEventListener('click', () => perform(async ctx => {
    const record = current();
    await ctx.connection.postManagement(BASE + '/connections/' + selected + '/revoke', { expectedRevision: record.revision });
    const id = selected, next = await reload(ctx.connection); if (!ctx.valid()) return;
    records = next; select(id); feedback('连接已撤销，旧配置不能再调用 Core。');
  }));
  $('#connection-delete').addEventListener('click', () => { $('#connection-delete-confirm').hidden = false; $('#connection-delete').hidden = true; $('#connection-revoke').hidden = true; clearExport(); });
  $('#connection-delete-no').addEventListener('click', () => { $('#connection-delete-confirm').hidden = true; $('#connection-delete').hidden = false; $('#connection-revoke').hidden = Boolean(current()?.revokedAt); });
  $('#connection-delete-yes').addEventListener('click', () => perform(async ctx => {
    const record = current();
    await ctx.connection.postManagement(BASE + '/connections/' + selected + '/delete', { expectedRevision: record.revision });
    const next = await reload(ctx.connection); if (!ctx.valid()) return;
    records = next; select(records[0]?.connectionId || null); editor(false); feedback('连接已删除，旧配置已失效；作品和任务保留。');
  }));
  $('#connection-new').addEventListener('click', () => {
    if (busy || !catalog) return;
    select(); editor(true); setView('settings'); feedback('已准备新连接。填写名称、选择功能和权限后，点击“创建连接”。');
    const name = $('#connection-name'); name.focus({ preventScroll: true }); name.scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  function closeEditor(discard = false) {
    if (busy) return;
    if (formDirty && !discard) { $('#connection-leave-confirm').hidden = false; $('#connection-leave-confirm').scrollIntoView({ block: 'center' }); $('#connection-leave-keep').focus(); return; }
    clearExport(); formDirty = false; $('#connection-leave-confirm').hidden = true; editor(false); feedback(); $('#connection-new').focus();
  }
  $('#connection-form').addEventListener('input', () => { formDirty = true; closeButton.textContent = '取消编辑'; renderOnboarding(); controls(); });
  $('#connection-back').addEventListener('click', () => closeEditor());
  closeButton.addEventListener('click', () => closeEditor());
  $('#connection-leave-keep').addEventListener('click', () => { $('#connection-leave-confirm').hidden = true; });
  $('#connection-leave-discard').addEventListener('click', () => closeEditor(true));
  for (const button of document.querySelectorAll('[data-connection-view]')) button.addEventListener('click', () => setView(button.dataset.connectionView));
  $('#connections-refresh').addEventListener('click', () => perform(async ctx => {
    if (!catalog) { await connect(ctx.connection); return; }
    const [next, saved, available] = await Promise.all([reload(ctx.connection), ctx.connection.get(BASE + '/templates'), ctx.connection.get(BASE + '/catalog')]); if (!ctx.valid()) return;
    records = next; setTemplates(saved); setCatalog(available); renderTemplates(); select(selected); feedback('连接记录已刷新。');
  }));
  for (const id of ['connection-transport', 'connection-format', 'connection-name']) $('#' + id).addEventListener('input', clearExport);
  $('#connection-transport').addEventListener('change', transportNote);
  $('#connection-clear-export').addEventListener('click', clearExport);
  $('#connection-location').addEventListener('change', () => { clearExport(); controls(); });
  $('#connection-check').addEventListener('click', checkSetup);
  $('#connection-verify-next').addEventListener('click', () => setView('verification'));
  $('#connection-return-settings').addEventListener('click', () => setView('settings'));
  async function connect(connection) {
      const at = ++epoch; client = connection; busy = true; records = []; selected = null; editor(false); clearExport(); feedback('正在读取连接…'); controls();
      try {
        const [available, next, saved] = await Promise.all([connection.get(BASE + '/catalog'), connection.get(BASE + '/connections'), connection.get(BASE + '/templates')]);
        if (!valid(at, connection)) return;
        if (available.contractVersion !== 0 || next.contractVersion !== 0 || saved.contractVersion !== 0) throw new TypeError('不支持的连接管理版本');
        setCatalog(available); records = next.connections; setTemplates(saved);
        $('#connection-service-note').textContent = catalog.httpEnabled ? 'HTTP MCP 已开启 · ' + location.origin + '/mcp。创建连接会生成专属授权，不会自动配置或启动客户端。'
          : '可用 stdio 接入 · 此服务未开启 HTTP MCP。创建连接不会自动配置或启动客户端。';
        renderTemplates(); select(records[0]?.connectionId || null); feedback();
      } catch (error) { if (valid(at, connection)) feedback(describe(error), true); }
      finally { if (valid(at, connection)) { busy = false; controls(); } }
  }
  return Object.freeze({
    connect,
    show(value) { if (visible !== value) viewTicket++; visible = value; if (!value) { cancelCheck(); clearExport(); feedback(); controls(); } },
    disconnect() {
      cancelCheck(); exports.clear(); inspections.clear();
      capabilities = []; tools = []; pluginOperations = []; allowedScopes = ['read']; scopes = {}; $('#connection-location').value = 'same';
      epoch++; client = null; busy = false; visible = false; catalog = null; records = []; templates = []; selected = null; editor(false); clearExport(); feedback();
      formDirty = false; $('#connection-leave-confirm').hidden = true; closeButton.textContent = '返回列表';
      $('#connection-template').replaceChildren(); $('#connection-template-note').replaceChildren(); $('#connection-template-note').hidden = true; $('#connection-template-file').value = '';
      $('#connections-list').replaceChildren(); $('#connection-facts').replaceChildren(); $('#connection-name').value = '';
      $('#connection-contribution-list').replaceChildren(); $('#connection-contributions').hidden = true;
      $('#connection-service-note').textContent = '';
      for (const id of ['connection-media', 'connection-scopes', 'connection-tools']) $('#' + id).replaceChildren();
      $('#connection-export').hidden = true; $('#connection-revoke-section').hidden = true; $('#connection-fields').disabled = true;
      $('#connections-count').textContent = '0';
    }
  });
}
