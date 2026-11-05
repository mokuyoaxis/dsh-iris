// Read-only presentation of Core declarations and exact saved grants. Never grants or calls a business.
const $ = selector => document.querySelector(selector);
const kinds = { providers: '模型协议', operations: '业务操作', pages: '页面', settings: '设置表单', renderers: '作品预览' };
const lifecycle = { active: '已加载', loading: '加载中', closing: '正在关闭', closed: '已关闭' };
const sameDependency = (a, b) => ['contractVersion', 'pluginId', 'pluginVersion', 'kind', 'contributionId', 'contributionVersion'].every(key => a[key] === b[key]);
const node = (tag, text = '', className = '') => {
  const value = document.createElement(tag); value.textContent = text; value.className = className; return value;
};
const reason = (code, label, hint) => ({ code, label, hint });

function authorization(record, pin, entry, state) {
  if (record.revokedAt || record.state === 'revoked') return reason('revoked', '已撤销', '此连接不能发起新调用。');
  if (!entry) return reason('missing', '业务未加载', '在启动选择中恢复原插件和准确业务版本；历史记录仍保留。');
  if (!sameDependency(pin, entry.dependency)) return reason('version', '版本不一致', '当前加载版本与原授权不同，请核对准确依赖；不会自动替换授权。');
  if (state !== 'active') return reason('closed', '插件不可用', '插件注册实例正在关闭或已关闭。');
  if (entry.access.mcp !== 'requires-selection') return reason('disabled', '服务未启用', '在启动选择文件的 operations 中明确选择此业务，再正常重启服务。');
  if (!record.scopes.includes('execute')) return reason('scope', '缺少执行权限', '在客户端连接设置中明确允许执行。');
  if (!record.tools.includes('iris_core_plugin_call')) return reason('tool', '未选择调用工具', '在客户端连接设置中选择 plugin_call 工具。');
  return reason('permitted', '授权允许执行', '配置满足调用条件；业务未实测。客户端还需连接并协商所需权限。');
}

/** Diagnostic projection only. Core remains the authority for every real invocation. */
export function projectPluginStatus(catalog, records) {
  if (catalog.contractVersion !== 0 || !catalog.contributions || !Array.isArray(catalog.plugins)) throw new TypeError('不支持的插件目录版本');
  const entries = Object.entries(catalog.contributions).flatMap(([kind, items]) => items.map(item => ({ ...item, kind })));
  const authorizations = records === null ? null : records.flatMap(record => (record.pluginOperations || []).map(pin => {
    const entry = entries.find(item => item.kind === 'operations' && item.id === pin.contributionId);
    return { connectionId: record.connectionId, connectionLabel: record.label, pin, ...authorization(record, pin, entry, catalog.state),
      instances: (record.instances || []).map(instance => ({ runtimeInstanceId: instance.runtimeInstanceId,
        ...(instance.state !== 'connected' ? reason('disconnected', '握手已断开', '不是当前可用实例。')
          : !(instance.pluginOperations || []).some(value => sameDependency(value, pin)) ? reason('unselected', '握手未选择此业务', '实例范围小于保存的授权。')
            : authorization(instance, pin, entry, catalog.state)) })) };
  }));
  return { state: catalog.state, coreVersion: catalog.coreVersion, authorizations,
    enabled: entries.filter(item => item.kind === 'operations' && item.access.web === 'via-operation').length,
    plugins: catalog.plugins.map(plugin => ({ ...plugin, state: catalog.state,
      contributions: entries.filter(item => item.dependency.pluginId === plugin.id) })),
    missing: (authorizations || []).filter(item => !entries.some(entry => entry.kind === 'operations' && entry.id === item.pin.contributionId)) };
}

function contributionStatus(entry) {
  if (entry.access.local === 'unavailable') return '当前不可用';
  if (entry.kind === 'providers') return '协议已加载 · 模型服务另行配置与实测';
  if (entry.kind === 'operations') return entry.access.mcp === 'requires-selection' ? '服务已启用 · 客户端需单独授权' : '服务未启用';
  return entry.access.web === 'available-in-panel' ? '已选入工作台' : '未选入工作台';
}

export function createPluginStatusPanel({ describe, navigate }) {
  let client, session, visible = false, ticket = 0, controller;
  function cancel() { ticket++; controller?.abort(); controller = null; $('#plugins-refresh').disabled = false; $('#plugins-list').setAttribute('aria-busy', 'false'); }
  function clear() {
    for (const id of ['plugins-list', 'plugins-missing', 'plugins-stats']) $('#' + id).replaceChildren();
    for (const id of ['plugins-feedback', 'plugins-authorizations-note', 'plugins-updated']) { $('#' + id).textContent = ''; $('#' + id).hidden = true; }
    $('#plugins-empty').hidden = true; $('#plugins-missing-section').hidden = true;
  }
  function feedback(text, error = false) { const target = $('#plugins-feedback'); target.textContent = text; target.hidden = !text; target.classList.toggle('error', error); }
  function renderGrant(value) {
    const item = node('li', '', 'plugin-grant'); item.dataset.status = value.code;
    const heading = node('div', '', 'plugin-grant-heading'); heading.append(node('strong', value.connectionLabel));
    item.append(heading, node('span', value.code === 'permitted' ? '授权允许执行 · 未实测' : value.label, 'plugin-state'));
    item.append(node('p', value.hint, 'field-note'));
    const pin = value.pin;
    item.append(node('p', pin.pluginId + '@' + pin.pluginVersion + ' · ' + pin.contributionId + '@' + pin.contributionVersion, 'plugin-identity'));
    if (value.instances.length) {
      const facts = node('ul', '', 'plugin-instances');
      for (const instance of value.instances) facts.append(node('li', instance.label + (instance.code === 'permitted' ? ' · 未实测' : '')));
      item.append(facts, node('p', value.instances.length + ' 个握手实例记录，不代表客户端持续在线。', 'field-note'));
    } else item.append(node('p', '当前无握手实例记录，不表示客户端安装失败。', 'field-note'));
    return item;
  }
  const grantRows = values => values.map(renderGrant);
  function render(value) {
    const grants = value.authorizations;
    const open = new Set([...document.querySelectorAll('.plugin-status-card[open]')].map(card => card.dataset.pluginId));
    const stats = [['已加载插件', value.plugins.filter(plugin => plugin.state === 'active').length], ['已启用业务', value.enabled], ['业务授权', grants === null ? '未知' : grants.filter(item => item.code !== 'revoked').length]];
    $('#plugins-stats').replaceChildren(...stats.map(([label, count]) => { const row = node('div'); row.append(node('dt', label), node('dd', String(count))); return row; }));
    $('#plugins-empty').hidden = value.plugins.length !== 0;
    $('#plugins-list').replaceChildren(...value.plugins.map(plugin => {
      const card = node('details', '', 'card plugin-status-card'); card.dataset.pluginId = plugin.id;
      card.open = open.has(plugin.id);
      const summary = node('summary'), mark = node('span', '◇', 'plugin-status-mark'); mark.setAttribute('aria-hidden', 'true');
      const title = node('span', '', 'plugin-status-title'); title.append(node('strong', plugin.id), node('small', 'v' + plugin.version + ' · ' + plugin.contributions.length + ' 项贡献'));
      const disclosure = node('span', card.open ? '收起' : '展开', 'disclosure');
      summary.append(mark, title, node('span', lifecycle[plugin.state], 'plugin-state'), disclosure); card.append(summary);
      card.addEventListener('toggle', () => { disclosure.textContent = card.open ? '收起' : '展开'; });
      const body = node('div', '', 'plugin-status-body'), compatibility = plugin.compatibility;
      body.append(node('p', 'Core 兼容范围：' + compatibility.min + ' ≤ 版本 < ' + compatibility.maxExclusive, 'plugin-identity'),
        node('p', (value.coreVersion ? '装配时 Core ' + value.coreVersion + '，' : '') + '版本已通过加载校验。' + (plugin.state === 'active' ? '加载不代表媒体实测。' : '当前注册实例' + lifecycle[plugin.state] + '。'), 'field-note'));
      const contributions = node('ul', '', 'plugin-contribution-status');
      for (const entry of plugin.contributions) {
        const row = node('li'); row.dataset.contributionId = entry.id;
        row.append(node('small', kinds[entry.kind], 'plugin-kind'), node('strong', entry.title), node('p', contributionStatus(entry), 'field-note'), node('p', entry.id + '@' + entry.version, 'plugin-identity'));
        contributions.append(row);
      }
      body.append(contributions);
      const own = grants?.filter(item => item.pin.pluginId === plugin.id);
      body.append(node('h3', '客户端授权'));
      if (own?.length) { const list = node('ul', '', 'plugin-grants'); list.append(...grantRows(own)); body.append(list); }
      else body.append(node('p', grants ? '尚无客户端选择此插件业务。' : '授权信息尚未读取，不能判断客户端选择。', 'field-note'));
      card.append(body); return card;
    }));
    const missing = grants?.filter(item => value.missing.some(value => value.connectionId === item.connectionId && sameDependency(value.pin, item.pin))) || [];
    $('#plugins-missing-section').hidden = !missing.length;
    $('#plugins-missing').replaceChildren(...grantRows(missing));
  }
  async function refresh() {
    if (!client || !visible) return;
    cancel(); const at = ticket, connection = client, activeSession = session;
    controller = new AbortController(); const { signal } = controller;
    clear(); $('#plugins-refresh').disabled = true; $('#plugins-list').setAttribute('aria-busy', 'true'); feedback('正在读取插件状态…');
    const valid = () => at === ticket && client === connection && visible && !signal.aborted;
    try {
      const catalog = await connection.get('/api/v0/capabilities', { signal });
      if (!valid()) return;
      render(projectPluginStatus(catalog, null)); feedback('');
      let records;
      try {
        const result = await connection.get(activeSession.connectionManagement ? '/api/v0/connection-management/connections' : '/api/v0/connections', { signal });
        if (result.contractVersion !== 0 || !Array.isArray(result.connections)) throw new TypeError('不支持的连接列表版本');
        records = result.connections;
      } catch (error) {
        if (!valid()) return;
        // A service without either static grants or managed connections has no /connections route.
        if (!activeSession.connectionManagement && error.status === 404) records = [];
        else { const note = $('#plugins-authorizations-note'); note.hidden = false; note.textContent = '授权信息未能读取：' + describe(error) + '；插件目录已读取。'; }
      }
      if (!valid()) return;
      if (records) render(projectPluginStatus(catalog, records));
      const updated = $('#plugins-updated'); updated.hidden = false; updated.textContent = '读取于 ' + new Date().toLocaleTimeString('zh-CN') + ' · 不调用业务或测试模型';
    } catch (error) { if (valid()) { clear(); feedback('插件目录未能读取：' + describe(error), true); } }
    finally { if (valid()) { controller = null; $('#plugins-refresh').disabled = false; $('#plugins-list').setAttribute('aria-busy', 'false'); } }
  }
  $('#plugins-refresh').addEventListener('click', refresh);
  $('#plugins-connections').addEventListener('click', () => navigate('connections'));
  return {
    connect(connection, facts) { cancel(); clear(); client = connection; session = facts; $('#plugins-connections').hidden = !facts.connectionManagement; },
    show(value) { visible = value; if (visible) void refresh(); else cancel(); },
    disconnect() { visible = false; cancel(); clear(); client = session = null; $('#plugins-panel').hidden = true; }
  };
}
