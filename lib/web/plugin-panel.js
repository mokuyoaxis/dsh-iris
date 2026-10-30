const $ = selector => document.querySelector(selector);
const node = (tag, text, className) => { const item = document.createElement(tag); if (text) item.textContent = text; if (className) item.className = className; return item; };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const ARTIFACT = /^artifact_[a-f0-9]{24}$/, RUN = /^run_[a-f0-9]{24}$/;
const MEDIA = { 'image/png': 'content', 'image/jpeg': 'content', 'image/webp': 'content',
  'audio/wav': 'audio', 'audio/mpeg': 'audio', 'audio/ogg': 'audio', 'audio/flac': 'audio', 'text/plain': 'text' };

/** Trusted same-origin modules. Shadow DOM isolates styles, not permissions or JavaScript. */
export function createPluginPanel({ navigate, describe, onProvidersSaved }) {
  let client, session, manifest, page = '', artifacts = [], currentArtifact, active = new Map();
  const themeListeners = new Set();
  const themeValue = () => Object.freeze({ mode: document.documentElement.dataset.theme || 'light',
    density: document.documentElement.dataset.density || 'comfortable', accent: 'iris' });
  const themeObserver = new MutationObserver(() => {
    for (const listener of themeListeners) listener(themeValue());
  });
  function report(item, stage, error, target = $('#plugin-feedback')) {
    const message = item.id + ' · ' + stage + ' · ' + describe(error);
    target.textContent = message; target.hidden = false; target.classList.add('error');
    target.dataset.code = 'IRIS_PLUGIN_WEB_' + stage.toUpperCase();
  }
  function stop(slot) { const previous = active.get(slot); active.delete(slot); previous?.(); }
  function stopAll() { for (const slot of [...active.keys()]) stop(slot); }
  function mount(slot, item, extra = {}) {
    stop(slot); slot.replaceChildren();
    const lifetime = new AbortController(), signal = lifetime.signal, http = client;
    const host = node('div', '', 'plugin-surface'); host.dataset.pluginContribution = item.id;
    const status = node('p', '正在加载…', 'field-note'); status.setAttribute('role', 'status');
    slot.append(host, status);
    const shadow = host.attachShadow({ mode: 'open' }), container = node('div', '', 'plugin-content');
    const unsubscriptions = new Set();
    let cleanup, settled = false, released = false;
    async function release() {
      if (released || !settled) return; released = true;
      try { await cleanup?.(); } catch (error) { report(item, 'cleanup', error); }
    }
    function close() {
      signal.aborted || lifetime.abort();
      for (const unsubscribe of unsubscriptions) unsubscribe();
      host.remove(); status.remove(); void release();
    }
    active.set(slot, close);
    function live() { signal.throwIfAborted(); if (http !== client) throw new DOMException('登录上下文已关闭', 'AbortError'); }
    function options(value = {}) { live(); return { ...value, signal: AbortSignal.any([signal, ...(value.signal ? [value.signal] : [])]) }; }
    const read = (path, value) => http.get(path, options(value));
    const api = Object.freeze({
      ...(session.pluginExecution ? { pluginOperations: Object.freeze({
        catalog: (query = {}, value) => read('/api/v0/plugin-operations/catalog?' + new URLSearchParams(query), value),
        history: value => read('/api/v0/plugin-operations', value),
        execute: (request, value) => http.callPlugin(request, options(value)),
        inspect: (id, value) => http.getOperation(id, options(value)),
        lookup: (key, value) => http.lookupOperation(key, options(value)),
        stop: (id, value) => http.stopOperation(id, options(value))
      }) } : {}),
      runs: (query = {}, value) => read('/api/v0/runs?' + new URLSearchParams(query), value),
      run: (id, value) => { if (typeof id !== 'string' || !RUN.test(id)) throw new TypeError('流程 ID 无效'); return read('/api/v0/runs/' + id, value); },
      models: value => read('/api/v0/models', value),
      audioModels: value => read('/api/v0/audio-models', value),
      artifact: (artifact, value) => {
        if (typeof artifact?.id !== 'string' || !ARTIFACT.test(artifact.id) || !Object.hasOwn(MEDIA, artifact?.mediaType)) throw new TypeError('作品 ID 或媒体类型无效');
        return read('/api/v0/artifacts/' + artifact.id + '/' + MEDIA[artifact.mediaType], { ...value, binary: true });
      },
      ...(session.providerManagement && item.dependency.kind === 'settings' ? { providers: Object.freeze({
        read: value => read('/api/v0/provider-management/settings', value),
        async save(input, value) {
          const result = await http.postProvider('save', input, options(value));
          live(); onProvidersSaved?.(result); return result;
        }
      }) } : {})
    });
    const theme = Object.freeze({ current: themeValue,
      subscribe(listener) {
        live();
        if (typeof listener !== 'function') throw new TypeError('主题监听须为函数');
        const subscription = value => { try { listener(value); } catch (error) { report(item, 'theme', error); } };
        const off = () => { themeListeners.delete(subscription); unsubscriptions.delete(off); };
        themeListeners.add(subscription); unsubscriptions.add(off); return off;
      }
    });
    const context = Object.freeze({ container, signal, dependency: item.dependency, api, session, theme, ...extra });
    let stage = 'styles';
    void (async () => {
      try {
        await Promise.all(['/plugin-surface.css', ...item.styles].map(href => new Promise((resolve, reject) => {
          const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href;
          const abort = () => reject(signal.reason);
          link.addEventListener('load', () => { signal.removeEventListener('abort', abort); resolve(); }, { once: true });
          link.addEventListener('error', () => { signal.removeEventListener('abort', abort); reject(new Error('样式资源加载失败')); }, { once: true });
          signal.addEventListener('abort', abort, { once: true }); shadow.append(link);
        })));
        live(); stage = 'module';
        const module = await import(item.entry);
        live(); if (typeof module.mount !== 'function') throw new Error('入口须导出 mount(context)');
        shadow.append(container); stage = 'mount';
        cleanup = await module.mount(context);
        if (cleanup !== undefined && typeof cleanup !== 'function') { cleanup = undefined; throw new Error('mount 只能返回释放函数或 undefined'); }
        if (!signal.aborted) status.hidden = true;
      } catch (error) {
        if (!signal.aborted) {
          // A failed mount has no live API/listeners; keep its diagnostic outside its removed host.
          lifetime.abort(); for (const unsubscribe of unsubscriptions) unsubscribe(); host.remove();
          report(item, stage, error, status);
        }
      } finally { settled = true; if (signal.aborted) await release(); }
    })();
  }
  function renderPage() {
    const item = manifest?.pages.find(value => 'plugin:' + value.id === page);
    $('#plugin-page-panel').hidden = !item;
    $('#plugin-settings-panel').hidden = page !== 'plugin-settings';
    $('#plugin-history-panel').hidden = page !== 'plugin-history';
    for (const button of $('#plugin-navigation').querySelectorAll('button')) button.setAttribute('aria-current', button.dataset.page === page ? 'page' : 'false');
    if (item) {
      $('#plugin-page-title').textContent = item.title;
      $('#plugin-page-identity').textContent = item.dependency.pluginId + ' · v' + item.dependency.pluginVersion;
      mount($('#plugin-page-slot'), item);
    }
    if (page === 'plugin-settings') {
      for (const details of $('#plugin-settings-list').children) if (details.open) mount(details.querySelector('.plugin-slot'), manifest.settings.find(value => value.id === details.dataset.contribution));
    }
    if (page === 'plugin-history') showHistory();
  }
  function showHistory() {
    const slot = $('#plugin-history-list'); stop(slot); slot.replaceChildren();
    const controller = new AbortController(), signal = controller.signal, http = client, urls = new Set();
    active.set(slot, () => { controller.abort(); for (const url of urls) URL.revokeObjectURL(url); });
    $('#plugin-history-feedback').textContent = '正在读取保存的业务记录…';
    void http.get('/api/v0/plugin-operations', { signal }).then(value => {
      if (signal.aborted || http !== client) return;
      $('#plugin-history-feedback').textContent = value.operations.length ? '显示最近业务；缺少插件仍可读取原记录。' : '尚无保存的业务记录。';
      for (const operation of value.operations) {
        const article = node('article', '', 'card plugin-history-item'), title = node('h2', operation.operationId);
        const identity = node('p', operation.dependency.pluginId + ' · v' + operation.dependency.pluginVersion, 'field-note');
        const status = node('p', operation.state + ' · ' + operation.id, 'field-note'); article.dataset.operationId = operation.id;
        article.append(title, identity, status);
        for (const id of operation.result?.artifactIds || []) {
          const preview = node('button', '查看原作品', 'secondary'); preview.type = 'button';
          preview.addEventListener('click', async () => {
            preview.disabled = true;
            try {
              const blob = await http.get('/api/v0/artifacts/' + id + '/content', { signal, binary: true });
              if (signal.aborted || http !== client) return;
              const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type];
              if (!extension) throw new Error('此业务作品不是支持的图片类型');
              const url = URL.createObjectURL(blob); urls.add(url); const image = node('img'); image.src = url; image.alt = '此业务保存的原始作品';
              const link = node('a', '下载原图'); link.href = url; link.download = 'iris-' + id + '.' + extension; article.append(image, link); preview.hidden = true;
            } catch (error) { if (!signal.aborted) { status.textContent = describe(error); preview.disabled = false; } }
          }); article.append(preview);
        }
        slot.append(article);
      }
    }).catch(error => { if (!signal.aborted) $('#plugin-history-feedback').textContent = describe(error); });
  }
  $('#plugin-history-refresh').addEventListener('click', () => { if (client && page === 'plugin-history') showHistory(); });
  function renderPreview() {
    stop($('#plugin-preview-slot')); $('#plugin-preview-slot').replaceChildren();
    const id = $('#plugin-renderer').value, item = manifest?.renderers.find(value => value.id === id && value.mediaTypes.includes(currentArtifact?.mediaType));
    if (page === 'studio' && $('#plugin-preview').open && item) mount($('#plugin-preview-slot'), item, { artifact: currentArtifact });
  }
  function selectArtifact() {
    stop($('#plugin-preview-slot'));
    currentArtifact = artifacts.find(value => value.id === $('#plugin-artifact').value);
    $('#plugin-renderer').replaceChildren(new Option('默认预览', ''), ...(manifest?.renderers || [])
      .filter(item => item.mediaTypes.includes(currentArtifact?.mediaType)).map(item => new Option(item.title, item.id)));
    renderPreview();
  }
  $('#plugin-renderer').addEventListener('change', renderPreview);
  $('#plugin-artifact').addEventListener('change', selectArtifact);
  $('#plugin-preview').addEventListener('toggle', renderPreview);
  return Object.freeze({
    connect(http, facts) {
      client = http;
      session = freeze({ contractVersion: facts.contractVersion, instanceId: facts.instanceId, rootId: facts.rootId,
        operations: [...facts.operations], readOnly: facts.readOnly, audio: facts.audio === true, providerManagement: facts.providerManagement === true,
        pluginExecution: facts.pluginExecution === true, pluginOperations: structuredClone(facts.pluginOperations || []) });
      manifest = freeze(structuredClone(facts.panelContributions || { contractVersion: 0, pages: [], settings: [], renderers: [] }));
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-density', 'data-accent'] });
      const nav = $('#plugin-navigation'); nav.replaceChildren(); nav.hidden = !manifest.pages.length && !manifest.settings.length && !session.pluginExecution;
      for (const item of [...manifest.pages, ...(manifest.settings.length ? [{ id: '', title: '扩展设置' }] : []), ...(session.pluginExecution ? [{ id: 'history', title: '业务记录' }] : [])]) {
        const button = node('button', item.title, 'nav-item'); button.type = 'button';
        button.dataset.page = item.id === 'history' ? 'plugin-history' : item.id ? 'plugin:' + item.id : 'plugin-settings';
        button.addEventListener('click', () => navigate(button.dataset.page)); nav.append(button);
      }
      $('#plugin-settings-list').replaceChildren(...manifest.settings.map(item => {
        const details = node('details', '', 'card plugin-settings-card'); details.dataset.contribution = item.id;
        const summary = node('summary'), label = node('span', item.title), disclosure = node('span', '展开', 'disclosure');
        summary.append(label, disclosure);
        const identity = node('p', item.dependency.pluginId + ' · v' + item.dependency.pluginVersion, 'field-note');
        const slot = node('div', '', 'plugin-slot'); details.append(summary, identity, slot);
        details.addEventListener('toggle', () => {
          disclosure.textContent = details.open ? '收起' : '展开';
          if (details.isConnected && details.open && page === 'plugin-settings' && client && manifest.settings.includes(item)) mount(slot, item); else stop(slot);
        }); return details;
      }));
    },
    show(next) {
      if (page === next) return;
      $('#plugin-feedback').hidden = true; stopAll(); page = next;
      if (client) { renderPage(); renderPreview(); }
      else { $('#plugin-page-panel').hidden = true; $('#plugin-settings-panel').hidden = true; $('#plugin-history-panel').hidden = true; }
    },
    previewArtifacts(values, preferredId) {
      artifacts = values.filter(value => value && manifest?.renderers.some(item => item.mediaTypes.includes(value.mediaType))).map(value => freeze({ ...value }));
      const selected = artifacts.find(value => value.id === preferredId) || artifacts[0];
      $('#plugin-preview').hidden = !artifacts.length; $('#plugin-preview').open = false;
      $('#plugin-artifact').replaceChildren(...artifacts.map(value => new Option(value.label, value.id)));
      if (selected) $('#plugin-artifact').value = selected.id;
      selectArtifact();
    },
    clearPreview() { stop($('#plugin-preview-slot')); artifacts = []; currentArtifact = null; $('#plugin-preview').hidden = true; $('#plugin-preview').open = false; $('#plugin-preview-slot').replaceChildren(); },
    disconnect() {
      $('#plugin-feedback').hidden = true;
      stopAll(); themeObserver.disconnect(); themeListeners.clear(); client = session = manifest = null; page = '';
      $('#plugin-navigation').replaceChildren(); $('#plugin-navigation').hidden = true;
      $('#plugin-page-panel').hidden = $('#plugin-settings-panel').hidden = $('#plugin-history-panel').hidden = true;
      $('#plugin-history-list').replaceChildren();
      $('#plugin-page-slot').replaceChildren(); $('#plugin-settings-list').replaceChildren();
      artifacts = []; currentArtifact = null; $('#plugin-preview').hidden = true; $('#plugin-preview').open = false;
    }
  });
}
