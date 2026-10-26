// Explicit owner management only. No discovery, credential storage or automatic media call.
const BASE = '/api/v0/connection-management';
const $ = selector => document.querySelector(selector);
const states = { pending: '尚未使用', used: '使用过', revoked: '已撤销', configured: '静态配置' };
const scopes = { read: '读取记录', create: '导入与创建', execute: '执行流程', stop: '停止等待' };
const control = ['iris_core_connection', 'iris_core_connections'];
const element = (tag, text, className) => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
const checked = selector => [...document.querySelectorAll(selector + ':checked')].map(input => input.value);
const date = value => new Date(value).toLocaleString('zh-CN');

export function createConnectionPanel({ describe }) {
  let client, epoch = 0, catalog, records = [], selected = null, key, busy = false, visible = false, viewTicket = 0;
  let capabilities = [], tools = [], allowedScopes = ['read'], templates = [], skillBundle = null;
  const urls = new Set();
  const current = () => records.find(record => record.connectionId === selected);
  const valid = (at, connection) => at === epoch && client === connection;
  function feedback(text = '', error = false) {
    const node = $('#connections-feedback'); node.hidden = !text; node.textContent = text; node.classList.toggle('error', error);
  }
  function clearExport() {
    viewTicket++;
    $('#connection-configuration').value = ''; $('#connection-export-result').hidden = true;
    $('#connection-export-note').textContent = '';
    skillBundle = null; $('#connection-skill-preview').value = ''; $('#connection-skill-result').hidden = true;
    for (const url of urls) URL.revokeObjectURL(url); urls.clear();
  }
  function controls() {
    const record = current(), editable = !record || record.managed && !record.revokedAt;
    $('#connection-fields').disabled = busy || !catalog || !editable;
    for (const id of ['connection-new', 'connection-export-button', 'connection-revoke', 'connection-revoke-yes',
      'connection-template', 'connection-template-import', 'connection-template-example', 'connection-template-file', 'connection-skill-generate']) $('#' + id).disabled = busy || !catalog;
    for (const id of ['connection-transport', 'connection-format']) $('#' + id).disabled = busy || !catalog || Boolean($('#connection-template').value);
    $('#connections-refresh').disabled = busy;
    for (const node of document.querySelectorAll('.connection-item')) node.disabled = busy;
  }
  function renderList() {
    $('#connections-count').textContent = String(records.filter(record => record.state !== 'revoked').length);
    $('#connections-empty').hidden = records.length !== 0;
    $('#connections-list').replaceChildren(...records.map(record => {
      const button = element('button', '', 'connection-item'); button.type = 'button'; button.dataset.connectionId = record.connectionId;
      button.setAttribute('aria-current', String(record.connectionId === selected));
      button.append(element('strong', record.label), element('small', states[record.state] || record.state));
      button.addEventListener('click', () => { if (!busy) select(record.connectionId); }); return button;
    }));
    controls();
  }
  function option(value, title, selectedValues, change, { disabled = false, note = '' } = {}) {
    const label = element('label', '', 'check-option'), input = document.createElement('input');
    input.type = 'checkbox'; input.value = value; input.checked = selectedValues.includes(value); input.disabled = disabled;
    input.addEventListener('change', change); const text = element('span', title);
    if (note) text.append(element('small', note)); label.append(input, text); return label;
  }
  function renderTools() {
    const enabled = new Set([...control, ...catalog.groups.filter(group => capabilities.includes(group.id)).flatMap(group => group.tools)]);
    $('#connection-tools').replaceChildren(...catalog.tools.filter(tool => enabled.has(tool.name)).map(tool =>
      option(tool.name, tool.name.replace('iris_core_', ''), tools, () => {
        tools = checked('#connection-tools input'); countTools(); clearExport();
      }, { disabled: !allowedScopes.includes(tool.scope) || !catalog.availableScopes.includes(tool.scope), note: scopes[tool.scope] })));
    countTools();
  }
  function countTools() {
    const count = catalog.tools.filter(tool => tools.includes(tool.name) && allowedScopes.includes(tool.scope) && catalog.availableScopes.includes(tool.scope)
      && (control.includes(tool.name) || catalog.groups.some(group => capabilities.includes(group.id) && group.tools.includes(tool.name)))).length;
    $('#connection-tool-count').textContent = count + ' 个可用';
  }
  function renderOptions() {
    $('#connection-media').replaceChildren(...catalog.media.map(media => option(media.id, media.title,
      media.capabilities.some(id => capabilities.includes(id)) ? [media.id] : [], () => {
        const enabled = checked('#connection-media input');
        capabilities = catalog.media.filter(item => enabled.includes(item.id)).flatMap(item => {
          const selected = item.capabilities.filter(id => capabilities.includes(id));
          return selected.length ? selected : item.capabilities.slice(0, 1);
        });
        tools = [...new Set([...control, ...catalog.groups.filter(group => capabilities.includes(group.id)).flatMap(group => group.tools)])];
        renderOptions(); clearExport();
      }, { disabled: !media.capabilities.length, note: media.capabilities.length ? '选择下方具体功能' : '未接入' })));
    const image = catalog.media.find(item => item.id === 'image');
    $('#connection-image-options').replaceChildren(...(image?.capabilities || []).map(id => option(id,
      id === 'image-generate' ? '生成图片' : '修改图片', capabilities, () => {
        capabilities = checked('#connection-image-options input');
        tools = [...new Set([...control, ...catalog.groups.filter(group => capabilities.includes(group.id)).flatMap(group => group.tools)])];
        renderOptions(); clearExport();
      })));
    $('#connection-scopes').replaceChildren(...Object.entries(scopes).map(([id, title]) => option(id, title, allowedScopes, () => {
      allowedScopes = checked('#connection-scopes input'); renderOptions(); clearExport();
    }, { disabled: id === 'read' || !catalog.availableScopes.includes(id) && !allowedScopes.includes(id), note: catalog.availableScopes.includes(id) ? '' : '服务未开启' })));
    renderTools();
  }
  function fact(label, value) { $('#connection-facts').append(element('dt', label), element('dd', value)); }
  function select(id = null) {
    selected = id; key = crypto.randomUUID(); clearExport(); feedback();
    const record = current();
    capabilities = [...(record?.capabilities || ['image-edit'])]; tools = [...(record?.tools || catalog.tools.map(tool => tool.name))];
    allowedScopes = [...(record?.scopes || ['read'])];
    $('#connection-name').value = record?.label || '';
    $('#connection-editor-title').textContent = record ? '连接设置' : '新建连接';
    $('#connection-state').textContent = record ? states[record.state] : '尚未保存';
    $('#connection-save').textContent = record ? '保存更改' : '创建连接';
    $('#connection-save-note').textContent = record?.revokedAt ? '撤销已保存。需要使用时，请新建连接。'
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
    $('#connection-revoke-section').hidden = !record?.managed || Boolean(record.revokedAt);
    $('#connection-revoke-confirm').hidden = true; $('#connection-revoke').hidden = false;
    $('#connection-tool-details').open = false;
    $('#connection-skill-details').open = false;
    $('#connection-transport option[value="http"]').disabled = !catalog.httpEnabled;
    renderOptions(); renderList();
  }
  async function reload(connection) {
    const result = await connection.get(BASE + '/connections');
    if (result.contractVersion !== 0) throw new TypeError('不支持的连接列表版本');
    return result.connections;
  }
  function templateChoice() {
    const template = templates.find(item => item.templateId === $('#connection-template').value), note = $('#connection-template-note');
    note.replaceChildren(); note.hidden = !template;
    if (template) {
      $('#connection-transport').value = template.transport; $('#connection-format').value = template.format;
      note.append(document.createTextNode('模板只应用传输和格式。'));
      if (template.documentationUrl) {
        const link = element('a', '查看客户端文档'); link.href = template.documentationUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; note.append(link);
      }
    }
    clearExport(); controls();
  }
  function renderTemplates(selectedId = $('#connection-template').value) {
    const manual = element('option', '手动选择'); manual.value = '';
    $('#connection-template').replaceChildren(manual, ...templates.map(template => {
      const node = element('option', template.title); node.value = template.templateId; node.disabled = template.transport === 'http' && !catalog.httpEnabled; return node;
    }));
    $('#connection-template').value = templates.some(template => template.templateId === selectedId && (template.transport !== 'http' || catalog.httpEnabled)) ? selectedId : '';
    templateChoice();
  }
  function download(value, filename) {
    const url = URL.createObjectURL(new Blob([value], { type: 'application/json' })); urls.add(url);
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
      const value = { label: $('#connection-name').value, scopes: allowedScopes, capabilities, tools };
      const result = await ctx.connection.postManagement(BASE + '/connections' + (record ? '/' + selected + '/update' : ''),
        { ...value, ...(record ? { expectedRevision: record.revision } : { key }) });
      const next = await reload(ctx.connection); if (!ctx.valid()) return;
      records = next; select(result.connectionId); feedback(record ? '更改已保存，后续调用按新授权检查。' : '连接已创建。生成配置并交给客户端后，即可接入。');
    });
  });
  $('#connection-export-button').addEventListener('click', () => {
    clearExport();
    const id = selected, ticket = viewTicket;
    perform(async ctx => {
      const result = await ctx.connection.postManagement(BASE + '/connections/' + id + '/export', $('#connection-template').value
        ? { templateId: $('#connection-template').value } : { transport: $('#connection-transport').value, format: $('#connection-format').value });
      if (!ctx.valid()) return;
      if (selected !== id || !visible || viewTicket !== ticket) { feedback('配置已准备，但页面已切换。需要时请重新生成配置。'); return; }
      $('#connection-configuration').value = JSON.stringify(result.configuration, null, 2) + '\n';
      $('#connection-export-note').textContent = result.containsCredentials ? '此 HTTP 配置含连接密钥，请仅交给获授权的本机客户端。' : 'stdio 配置引用本机私有文件，需要使用本机路径。';
      $('#connection-export-result').hidden = false; feedback('配置已生成。客户端是否安装或加载，需要在客户端确认。');
    });
  });
  $('#connection-copy').addEventListener('click', async () => {
    const at = epoch;
    try { await navigator.clipboard.writeText($('#connection-configuration').value); if (at === epoch) feedback('配置已复制。'); }
    catch (error) { if (at === epoch) feedback('未能复制，请手动选择配置文本。' + error.message, true); }
  });
  $('#connection-download').addEventListener('click', () => {
    const value = $('#connection-configuration').value; if (!value) return;
    download(value, 'iris-mcp.json');
    $('#connection-configuration').value = ''; $('#connection-export-result').hidden = true;
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
      templates = result.templates; renderTemplates(imported.templateId); feedback('模板已保存，仅应用传输与格式；连接授权没有改变。');
    });
  });
  $('#connection-skill-generate').addEventListener('click', () => {
    clearExport(); const id = selected, ticket = viewTicket;
    perform(async ctx => {
      const result = await ctx.connection.postManagement(BASE + '/connections/' + id + '/skill', {});
      if (!ctx.valid()) return;
      if (selected !== id || !visible || viewTicket !== ticket) { feedback('说明已准备，但页面已切换。需要时请重新生成说明。'); return; }
      skillBundle = result.bundle; $('#connection-skill-preview').value = result.preview; $('#connection-skill-result').hidden = false;
      feedback('说明已生成。下载并安装后，还需在客户端确认已发现此 Skill。');
    });
  });
  $('#connection-skill-download').addEventListener('click', () => {
    if (!skillBundle) return;
    download(JSON.stringify(skillBundle, null, 2) + '\n', 'iris-skill.json'); clearExport(); feedback('Skill 文件下载已交给浏览器，尚未安装。');
  });
  $('#connection-skill-clear').addEventListener('click', clearExport);
  $('#connection-revoke').addEventListener('click', () => { $('#connection-revoke-confirm').hidden = false; $('#connection-revoke').hidden = true; clearExport(); });
  $('#connection-revoke-no').addEventListener('click', () => { $('#connection-revoke-confirm').hidden = true; $('#connection-revoke').hidden = false; });
  $('#connection-revoke-yes').addEventListener('click', () => perform(async ctx => {
    const record = current();
    await ctx.connection.postManagement(BASE + '/connections/' + selected + '/revoke', { expectedRevision: record.revision });
    const id = selected, next = await reload(ctx.connection); if (!ctx.valid()) return;
    records = next; select(id); feedback('连接已撤销，旧配置不能再调用 Core。');
  }));
  $('#connection-new').addEventListener('click', () => { if (!busy) select(); });
  $('#connections-refresh').addEventListener('click', () => perform(async ctx => {
    if (!catalog) { await connect(ctx.connection); return; }
    const [next, saved] = await Promise.all([reload(ctx.connection), ctx.connection.get(BASE + '/templates')]); if (!ctx.valid()) return;
    records = next; templates = saved.templates; renderTemplates(); select(selected); feedback('连接记录已刷新。');
  }));
  for (const id of ['connection-transport', 'connection-format', 'connection-name']) $('#' + id).addEventListener('input', clearExport);
  $('#connection-clear-export').addEventListener('click', clearExport);
  async function connect(connection) {
      const at = ++epoch; client = connection; busy = true; records = []; selected = null; clearExport(); feedback('正在读取连接…'); controls();
      try {
        const [available, next, saved] = await Promise.all([connection.get(BASE + '/catalog'), connection.get(BASE + '/connections'), connection.get(BASE + '/templates')]);
        if (!valid(at, connection)) return;
        if (available.contractVersion !== 0 || next.contractVersion !== 0 || saved.contractVersion !== 0) throw new TypeError('不支持的连接管理版本');
        catalog = available; records = next.connections; templates = saved.templates; renderTemplates(); select(records[0]?.connectionId || null); feedback();
      } catch (error) { if (valid(at, connection)) feedback(describe(error), true); }
      finally { if (valid(at, connection)) { busy = false; controls(); } }
  }
  return Object.freeze({
    connect,
    show(value) { if (visible !== value) viewTicket++; visible = value; if (!value) clearExport(); },
    disconnect() {
      epoch++; client = null; busy = false; visible = false; catalog = null; records = []; templates = []; selected = null; clearExport(); feedback();
      $('#connection-template').replaceChildren(); $('#connection-template-note').replaceChildren(); $('#connection-template-note').hidden = true; $('#connection-template-file').value = '';
      $('#connections-list').replaceChildren(); $('#connection-facts').replaceChildren(); $('#connection-name').value = '';
      for (const id of ['connection-media', 'connection-scopes', 'connection-tools']) $('#' + id).replaceChildren();
      $('#connection-export').hidden = true; $('#connection-revoke-section').hidden = true; $('#connection-fields').disabled = true;
      $('#connections-count').textContent = '0';
    }
  });
}
