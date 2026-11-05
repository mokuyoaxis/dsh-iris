const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node; };
const options = (select, rows, selected) => { select.replaceChildren(...rows.map(([value, text]) => { const item = el('option', text); item.value = value; return item; })); if (rows.some(([value]) => value === selected)) select.value = selected; };
const statusLabel = value => ({ configured: '已配置 · 未实测', empty: '空池', disabled: '已停用', unavailable: '无可用候选' })[value] || value;
export function networkRouteLabel(route) {
  return !route ? '出口未读取' : route.state === 'inherit' ? '继承环境' : route.state === 'blocked'
    ? '已阻止 · ' + (route.poolLabel || '核对网络配置') : route.poolLabel + ' · ' + (route.mode === 'fixed' ? '固定' : '有序主备');
}
export function createNetworkPanel({ describe, onChanged = () => {} }) {
  let client, data, draft, section = 'bindings', busy = false, unknown = false, dirty = false, generation = 0, visible = false;
  let candidates = [], pendingLeave, probeController, readController, writeController;
  const feedback = (text, error = false) => { $('network-feedback').textContent = text; $('network-feedback').hidden = !text; $('network-feedback').classList.toggle('error', error); };
  const active = (ticket, owner) => ticket === generation && owner === client;
  const nodeLabel = value => value.kind === 'direct' ? '明确直连' : data.network.nodes.find(node => node.id === value.nodeId)?.label || value.nodeId;
  function controls() {
    $('network-fields').disabled = busy || unknown;
    $('network-save').disabled = busy || unknown || draft?.kind === 'pool' && $('network-pool-mode').value === 'fixed' && candidates.length > 1;
    $('network-save').textContent = busy ? '正在保存…' : '保存设置';
    $('network-editor-state').textContent = busy ? '处理中…' : unknown ? '结果待核对' : dirty ? '未保存' : '已读取';
    $('network-refresh').disabled = busy && !probeController;
    $('network-new').disabled = busy || !data?.network;
    $('network-init').disabled = busy;
    $('network-back').disabled = busy; $('network-cancel').disabled = busy;
    for (const button of document.querySelectorAll('#network-list button, [data-network-section], #network-other-list button')) button.disabled = busy || button.dataset.networkBlocked === 'true';
    $('network-probe-start').disabled = busy || !data?.network || !data.providers.length;
    for (const id of ['network-probe-provider', 'network-probe-target', 'network-probe-url']) $(id).disabled = busy;
    $('network-probe-cancel').hidden = !probeController;
  }
  function changed() { dirty = true; controls(); }
  function leave(action) { if (busy) return; if (dirty || unknown) { pendingLeave = action; $('network-leave-confirm').hidden = false; return; } action(); }
  function closeEditor() { draft = null; candidates = []; dirty = unknown = false; $('network-editor').hidden = true; $('network-delete-confirm').hidden = true; $('network-leave-confirm').hidden = true; render(); }
  function stats() {
    $('network-stats').replaceChildren(...[['节点', data.network?.nodes.length || 0], ['出口池', data.network?.pools.length || 0], ['绑定', data.network?.bindings?.length || 0], ['继承环境', data.providers.filter(provider => provider.route.state === 'inherit').length]].map(([name, value]) => {
      const row = el('div'); row.append(el('dt', name), el('dd', String(value))); return row;
    }));
  }
  function render() {
    if (!data) {
      $('network-doctor').hidden = section !== 'doctor'; $('network-list').hidden = true; $('network-new').hidden = true; $('network-empty').hidden = true;
      $('network-setup').hidden = true; $('network-other-bindings').hidden = true; $('network-list').replaceChildren(); $('network-stats').replaceChildren();
      for (const button of document.querySelectorAll('[data-network-section]')) button.setAttribute('aria-pressed', String(button.dataset.networkSection === section));
      controls(); return;
    }
    stats(); $('network-sections').hidden = Boolean(draft);
    $('network-list').hidden = Boolean(draft) || section === 'doctor'; $('network-doctor').hidden = Boolean(draft) || section !== 'doctor';
    $('network-new').hidden = Boolean(draft) || !['nodes', 'pools'].includes(section) || !data.network;
    $('network-new').textContent = section === 'nodes' ? '＋ 添加节点' : '＋ 添加出口池';
    const ready = data.catalog.state === 'ready';
    $('network-setup').hidden = Boolean(draft) || data.storage !== 'missing' && (section !== 'bindings' || ready);
    $('network-init').hidden = data.storage !== 'missing';
    $('network-setup-note').textContent = data.storage === 'missing' ? '本次服务指定的网络文件尚未创建。明确初始化后才能管理节点与池；不会改动供应商目录。'
      : data.catalog.state === 'legacy' ? '当前是旧供应商目录。节点与池可以独立配置；绑定需先另存启用新目录，旧任务不会被迁移。'
        : data.catalog.state === 'absent' ? '此服务未指定供应商目录。可以管理资源，指定目录后再配置连接出口。' : '网络文件版本或身份与供应商目录不匹配。请核对启动时指定的文件，当前绑定不会被借用。';
    for (const button of document.querySelectorAll('[data-network-section]')) button.setAttribute('aria-pressed', String(button.dataset.networkSection === section));
    const records = section === 'bindings' ? data.providers : data.network?.[section] || [];
    $('network-empty').hidden = Boolean(draft) || section === 'doctor' || records.length > 0 || data.storage === 'missing';
    $('network-empty').textContent = section === 'nodes' ? '还没有节点。添加已有 HTTP/HTTPS 代理，不会安装代理服务。' : section === 'pools' ? '还没有出口池。节点可复用；直连需要明确添加。' : '当前没有供应商连接。';
    $('network-list').replaceChildren(...(section === 'doctor' ? [] : records).map((record, index) => {
      const card = el('article', '', 'card network-card'); card.dataset.networkTone = String(index % 6); card.dataset.networkId = record.id;
      const heading = el('div', '', 'section-heading');
      heading.append(el('span', section === 'bindings' ? '连接' : section === 'nodes' ? record.protocol.toUpperCase() : record.mode === 'fixed' ? '固定' : '有序主备', 'network-kicker'),
        el('span', section === 'bindings' ? record.route.state === 'blocked' ? '已阻止' : '配置路线' : section === 'nodes' ? !record.enabled ? '已停用' : record.credentialStatus === 'missing' ? '认证未就绪' : record.credentialStatus === 'invalid' ? '认证值无效' : '未实测' : statusLabel(record.status), 'badge'));
      card.append(heading, el('h3', record.name || record.label));
      card.append(el('p', section === 'bindings' ? networkRouteLabel(record.route) : section === 'nodes' ? record.host + ':' + record.port
        : record.candidates.length ? record.candidates.map(nodeLabel).join(' → ') : '空候选 · 绑定后阻止新请求', 'network-route'));
      card.append(el('p', section === 'bindings' ? !record.enabled ? '供应商已停用，绑定仍保留。' : '仅影响这条供应商连接。' : section === 'nodes'
        ? (record.auth ? '环境认证 · ' + record.credentialStatus : '无需代理认证') + ' · ' + record.referencedBy.length + ' 个池引用'
        : (record.referencedBy?.length || 0) + ' 条绑定 · 连接预检后才派发业务', 'field-note'));
      const button = el('button', section === 'bindings' ? '设置出口 →' : '编辑 →', 'quiet network-card-action'); button.type = 'button';
      button.dataset.networkBlocked = String(section === 'bindings' && !ready); button.addEventListener('click', () => edit(section === 'bindings' ? 'binding' : section === 'nodes' ? 'node' : 'pool', record)); card.append(button);
      return card;
    }));
    // Legacy/foreign references stay explicit and removable without scanning files.
    const others = (data.network?.bindings || []).filter(item => item.catalogId !== data.catalog.catalogId || !data.providers.some(provider => provider.id === item.providerId));
    $('network-other-bindings').hidden = Boolean(draft) || section !== 'bindings' || !others.length;
    $('network-other-list').replaceChildren(...others.map(item => {
      const row = el('div', '', 'network-other-row'); row.append(el('span', item.providerId + ' → ' + item.poolId + ' · ' + item.catalogId));
      const remove = el('button', '解除绑定', 'quiet'); remove.type = 'button'; remove.addEventListener('click', () => {
        const confirm = el('button', '确认解除', 'secondary danger'); confirm.type = 'button'; confirm.addEventListener('click', () => save('bindings/remove', { catalogId: item.catalogId, providerId: item.providerId, confirm: true }));
        const cancel = el('button', '取消', 'quiet'); cancel.type = 'button'; cancel.addEventListener('click', render); row.replaceChildren(el('span', '解除 ' + item.providerId + '？恢复继承环境，历史保留。'), confirm, cancel);
      }); row.append(remove); return row;
    }));
    const selected = $('network-probe-provider').value;
    options($('network-probe-provider'), data.providers.map(provider => [provider.id, provider.name]), selected || data.providers[0]?.id);
    controls();
  }
  function fill(prefix, values) { for (const [name, value] of Object.entries(values)) { const field = $('network-' + prefix + '-' + name); if (field.type === 'checkbox') field.checked = value; else field.value = value ?? ''; } }
  function edit(kind, record) {
    if (busy) return;
    draft = { kind, id: record?.id || null, record, revision: data.network.revision, providerRevision: data.catalog.revision }; dirty = false; unknown = false; feedback('');
    $('network-editor').hidden = false; $('network-delete-confirm').hidden = true;
    for (const type of ['node', 'pool', 'binding']) $('network-' + type + '-fields').hidden = type !== kind;
    // Disabled sections must not participate in native form validation.
    for (const type of ['node', 'pool']) for (const field of $('network-' + type + '-fields').querySelectorAll('input,select')) field.disabled = type !== kind;
    $('network-remove').hidden = !record || kind === 'binding';
    $('network-editor-title').textContent = kind === 'binding' ? '设置供应商出口' : (record ? '编辑' : '添加') + (kind === 'node' ? '节点' : '出口池');
    if (kind === 'node') {
      fill('node', { id: record?.id || '', label: record?.label || '', protocol: record?.protocol || 'http', host: record?.host || '', port: record?.port || '', enabled: record?.enabled ?? true,
        auth: Boolean(record?.auth), username: record?.auth?.usernameEnv || '', password: record?.auth?.passwordEnv || '' });
      $('network-node-id').readOnly = Boolean(record); $('network-auth-fields').hidden = !$('network-node-auth').checked;
    } else if (kind === 'pool') {
      fill('pool', { id: record?.id || '', label: record?.label || '', mode: record?.mode || 'ordered', enabled: record?.enabled ?? true });
      $('network-pool-id').readOnly = Boolean(record); candidates = structuredClone(record?.candidates || []); renderCandidates();
    } else {
      $('network-binding-provider').textContent = record.name; const binding = data.network.bindings.find(item => item.catalogId === data.catalog.catalogId && item.providerId === record.id);
      options($('network-binding-pool'), [['', '继承环境 · 解除显式绑定'], ...data.network.pools.map(pool => [pool.id, pool.label + ' · ' + statusLabel(pool.status)])], binding?.poolId || ''); bindingNote();
    }
    render(); $('network-editor-title').scrollIntoView({ block: 'nearest' });
  }
  function bindingNote() {
    const pool = data.network.pools.find(item => item.id === $('network-binding-pool').value);
    $('network-binding-note').textContent = !pool ? '保存后明确解除此连接的出口绑定，恢复继承当前环境；不改变已有任务身份。'
      : pool.status !== 'configured' ? '此池为空、停用或没有可用候选。保存绑定会阻止新请求，不会偷偷直连。' : '保存后使用此池允许的候选；只在连接预检失败时按顺序选择备用，不透明重放生成。';
  }
  function renderCandidates() {
    $('network-candidates').replaceChildren(...candidates.map((candidate, index) => {
      const row = el('div', '', 'network-candidate'); row.append(el('span', (index + 1) + '. ' + nodeLabel(candidate)));
      for (const [name, step] of [['上移', -1], ['下移', 1], ['移除', 0]]) {
        const button = el('button', name, 'quiet'); button.type = 'button'; button.disabled = step !== 0 && (index + step < 0 || index + step >= candidates.length);
        button.addEventListener('click', () => { if (!step) candidates.splice(index, 1); else [candidates[index], candidates[index + step]] = [candidates[index + step], candidates[index]]; changed(); renderCandidates(); }); row.append(button);
      } return row;
    }));
    options($('network-candidate-choice'), [...data.network.nodes.filter(node => !candidates.some(candidate => candidate.nodeId === node.id)).map(node => [node.id, node.label]),
      ...(!candidates.some(candidate => candidate.kind === 'direct') ? [['@direct', '明确允许直连']] : [])]);
    $('network-candidate-add').disabled = candidates.length >= 16 || !$('network-candidate-choice').options.length; controls();
  }
  async function refresh() {
    if (!client || busy) return;
    const owner = client, ticket = generation; readController?.abort(); const controller = readController = new AbortController();
    feedback('正在读取出口配置…');
    try {
      const value = await owner.get('/api/v0/network-management/settings', { signal: controller.signal });
      if (!active(ticket, owner) || controller.signal.aborted) return;
      if (draft) return; // A background read cannot rebase an open editor's CAS.
      if (value.contractVersion !== 0) throw new TypeError('不支持的网络设置版本');
      if (data?.network?.revision !== value.network?.revision) $('network-probe-result').hidden = true;
      data = value; onChanged(data); render(); feedback('');
      if (section === 'doctor' && visible) await readDoctor();
    } catch (error) { if (active(ticket, owner) && !controller.signal.aborted) { if (!draft) { data = null; onChanged(null); render(); } feedback(describe(error), true); } }
  }
  async function save(action, values = {}) {
    if (!client || busy || unknown) return;
    const owner = client, ticket = generation; readController?.abort(); busy = true; const controller = writeController = new AbortController(); controls(); feedback('正在保存…');
    try {
      const result = await owner.postNetwork(action, action === 'init' ? {} : { expectedRevision: draft?.revision || data.network.revision, ...values }, { signal: controller.signal });
      if (!active(ticket, owner)) return;
      data = result.settings; onChanged(data); $('network-probe-result').hidden = true; closeEditor(); feedback(result.changed ? '已保存。配置变更已生效，作品与任务历史保留。' : '设置未变化。');
    } catch (error) {
      if (!active(ticket, owner)) return;
      unknown = error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name);
      feedback(unknown ? '保存结果尚未确认，请重新读取并核对。不会自动重发。' : describe(error), true);
    } finally { if (active(ticket, owner)) { busy = false; writeController = null; render(); } }
  }
  async function readDoctor() {
    const owner = client, ticket = generation, controller = readController;
    if (!owner || busy) return;
    try {
      const result = await owner.get('/api/v0/network-management/doctor', { signal: controller?.signal });
      if (!active(ticket, owner) || !visible || section !== 'doctor') return;
      const fields = [['检查位置', '当前 Core · ' + result.process.platform + ' / ' + result.process.arch], ['Node', result.process.node],
        ['代理变量', Object.entries(result.environment.variables).filter(([, exists]) => exists).map(([name]) => name).join('、') || '未发现'],
        ['Node 环境代理开关', result.environment.nodeFlagRequested ? '已请求 · 实际路径仍需检测' : '未发现启用请求'], ['宿主策略 / 系统 TUN', '未知 · 不根据配置猜测'], ['读取时间', new Date(result.observedAt).toLocaleTimeString('zh-CN', { hour12: false })]];
      if (result.configuration.state === 'invalid') fields.push(['配置需核对', result.configuration.message + ' ' + result.configuration.issue]);
      $('network-environment').replaceChildren(...fields.flatMap(([key, value]) => [el('dt', key), el('dd', value)]));
    } catch (error) { if (active(ticket, owner) && !controller?.signal.aborted) feedback(describe(error), true); }
  }
  function enter(next) { section = next; closeEditor(); if (next === 'doctor') void readDoctor(); }
  for (const button of document.querySelectorAll('[data-network-section]')) button.addEventListener('click', () => leave(() => enter(button.dataset.networkSection)));
  $('network-new').addEventListener('click', () => edit(section === 'nodes' ? 'node' : 'pool'));
  $('network-refresh').addEventListener('click', () => leave(() => { closeEditor(); void refresh(); }));
  for (const id of ['network-back', 'network-cancel']) $(id).addEventListener('click', () => leave(closeEditor));
  $('network-leave-no').addEventListener('click', () => { pendingLeave = null; $('network-leave-confirm').hidden = true; });
  $('network-leave-yes').addEventListener('click', () => { const action = pendingLeave; pendingLeave = null; dirty = unknown = false; $('network-leave-confirm').hidden = true; action?.(); });
  $('network-form').addEventListener('input', changed); $('network-form').addEventListener('change', changed);
  $('network-node-auth').addEventListener('change', () => { $('network-auth-fields').hidden = !$('network-node-auth').checked; });
  $('network-pool-mode').addEventListener('change', controls);
  $('network-binding-pool').addEventListener('change', bindingNote);
  $('network-candidate-add').addEventListener('click', () => { const id = $('network-candidate-choice').value; if (!id) return; candidates.push(id === '@direct' ? { kind: 'direct' } : { kind: 'node', nodeId: id }); changed(); renderCandidates(); });
  $('network-init').addEventListener('click', () => save('init'));
  $('network-form').addEventListener('submit', event => {
    event.preventDefault(); if (!draft) return;
    if (draft.kind === 'binding') {
      const poolId = $('network-binding-pool').value;
      if (!poolId && !data.network.bindings.some(item => item.catalogId === data.catalog.catalogId && item.providerId === draft.id)) { closeEditor(); feedback('设置未变化。'); return; }
      return save(poolId ? 'bindings/set' : 'bindings/remove', poolId ? { expectedProviderRevision: draft.providerRevision, providerId: draft.id, poolId }
        : { catalogId: data.catalog.catalogId, providerId: draft.id, confirm: true });
    }
    const kind = draft.kind, record = { id: $('network-' + kind + '-id').value, label: $('network-' + kind + '-label').value, enabled: $('network-' + kind + '-enabled').checked };
    if (kind === 'node') Object.assign(record, { protocol: $('network-node-protocol').value, host: $('network-node-host').value, port: Number($('network-node-port').value),
      auth: $('network-node-auth').checked ? { usernameEnv: $('network-node-username').value, passwordEnv: $('network-node-password').value } : null });
    else Object.assign(record, { mode: $('network-pool-mode').value, candidates });
    void save(kind + 's/' + (draft.id ? 'set' : 'add'), { [kind]: record });
  });
  $('network-remove').addEventListener('click', () => { $('network-delete-confirm').hidden = false; });
  $('network-delete-no').addEventListener('click', () => { $('network-delete-confirm').hidden = true; });
  $('network-delete-yes').addEventListener('click', () => { if (draft) void save(draft.kind + 's/remove', { id: draft.id, confirm: true }); });
  $('network-probe-target').addEventListener('change', () => { const mode = $('network-probe-target').value; $('network-probe-url-field').hidden = mode === 'provider';
    $('network-probe-url').required = mode !== 'provider'; if (mode === 'ip' && !$('network-probe-url').value) $('network-probe-url').value = 'https://api.ipify.org?format=json'; });
  $('network-probe-form').addEventListener('input', () => { $('network-probe-result').hidden = true; });
  $('network-probe-form').addEventListener('change', () => { $('network-probe-result').hidden = true; });
  $('network-probe-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!client || busy) return;
    const owner = client, ticket = generation, controller = probeController = new AbortController(); busy = true; controls(); feedback('正在检测这条连接…');
    try {
      const target = $('network-probe-target').value;
      const result = await owner.postNetwork('probe', { expectedRevision: data.network.revision, expectedProviderRevision: data.catalog.revision,
        providerId: $('network-probe-provider').value, target, ...(target === 'provider' ? {} : { url: $('network-probe-url').value }) }, { signal: controller.signal });
      if (!active(ticket, owner) || controller.signal.aborted || !visible) return;
      const node = $('network-probe-result'); node.replaceChildren(el('strong', result.ok ? '本次检测通过' : result.reachable ? '已连接 · 结果需要核对' : '本次未通过'));
      node.append(el('p', (data.providers.find(provider => provider.id === result.providerId)?.name || result.providerId) + ' · ' + result.target.origin, 'field-note'));
      node.append(el('p', [result.route ? result.route.route === 'proxy' ? '出口池 ' + result.route.poolId + ' / 节点 ' + result.route.nodeId : result.route.route === 'direct' ? '明确直连' : '继承环境' : '尚未派发',
        result.httpStatus ? 'HTTP ' + result.httpStatus : null, result.elapsedMs + ' ms', result.observedIp ? '观察到 IP：' + result.observedIp : null].filter(Boolean).join(' · ')));
      if (result.issue) node.append(el('p', ({ IRIS_NETWORK_POOL_EXHAUSTED: '候选均未通过连接预检，请检查节点和代理认证。', IRIS_NETWORK_POOL_UNAVAILABLE: '出口池为空或停用，未隐式直连。',
        IRIS_NETWORK_PROBE_TIMEOUT: '检测超过8秒，已停止等待。', IRIS_NETWORK_PROBE_TOO_LARGE: '响应超过16 KiB，已停止读取。', IRIS_NETWORK_TARGET_HTTP_ERROR: '目标已返回响应，请核对地址及服务状态。',
        IRIS_NETWORK_IP_NOT_OBSERVED: '已连接，但JSON中没有有效的ip字段；不推断出口IP。', IRIS_NETWORK_TRANSPORT: '选定路线的请求失败，未自动换出口重发。' })[result.issue] || '未能完成本次GET，请核对目标、证书与网络。', 'field-note'));
      node.append(el('p', new Date(result.observedAt).toLocaleTimeString('zh-CN', { hour12: false }) + ' · 仅此目标、此时刻；不代表全部任务出口。', 'field-note'));
      node.hidden = false; feedback('');
    } catch (error) { if (active(ticket, owner)) feedback(controller.signal.aborted ? '检测已取消。' : describe(error), !controller.signal.aborted); }
    finally { if (active(ticket, owner)) { busy = false; probeController = null; controls(); } }
  });
  $('network-probe-cancel').addEventListener('click', () => probeController?.abort());
  return Object.freeze({
    connect(value) { client = value; generation++; data = null; draft = null; section = 'bindings'; dirty = unknown = busy = false; return refresh(); },
    disconnect() { generation++; readController?.abort(); probeController?.abort(); writeController?.abort(); client = data = draft = null; busy = dirty = unknown = visible = false; pendingLeave = null;
      $('network-list').replaceChildren(); $('network-stats').replaceChildren(); $('network-environment').replaceChildren(); $('network-other-list').replaceChildren(); $('network-editor').hidden = true;
      $('network-probe-result').replaceChildren(); $('network-probe-result').hidden = true; $('network-form').reset(); $('network-probe-form').reset(); $('network-leave-confirm').hidden = true;
      for (const id of ['network-candidates', 'network-probe-provider', 'network-binding-pool', 'network-binding-provider']) $(id).replaceChildren(); onChanged(null); feedback(''); },
    show(value) { const leaving = visible && !value; visible = value; if (leaving) { readController?.abort(); probeController?.abort(); } else if (value && client && !draft && !busy) void refresh(); },
    refresh() { if (!dirty && !draft && !busy) return refresh(); },
    focusProvider(id) { if (!data) return; leave(() => { const provider = data.providers.find(item => item.id === id); if (provider && data.catalog.state === 'ready') edit('binding', provider); else enter('bindings'); }); }
  });
}
