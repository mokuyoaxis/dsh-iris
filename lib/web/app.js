import { createReadClient } from './transport.js';
import { presentFlow } from './flow-view.js';
import { createConnectionPanel } from './connections.js';
import { createMediaClient } from './media-client.js';
import { createCreationPanel } from './creation.js';
import { createGallery } from './gallery.js';
import { createProviderPanel } from './providers.js';
import { createAppearance } from './appearance.js';

const $ = selector => document.querySelector(selector);
const urls = new Set();
let client = null, mediaClient = null, recoveryTicket = 0, epoch = 0, runTicket = 0, runController = null, current = null;
let runs = [], nextCursor = null, historyBusy = false, connecting = false, capabilities = [], page = 'studio', historyTotal = 0;
let canManageProviders = false;
const RUN = /^run_[a-f0-9]{24}$/;
const date = value => new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const valid = context => context.epoch === epoch && context.client === client;
const context = () => ({ epoch, client });
const connectionPanel = createConnectionPanel({ describe });
const gallery = createGallery({ openRun: id => loadRun(id), describe });
const providerPanel = createProviderPanel({ describe, onSaved: () => loadModels(context()) });
const creation = createCreationPanel({ openRun: loadRun, refreshHistory: () => loadHistory(context(), false, false),
  showDraft, describe, recover: recoverActions, renderOperation });
function tab(next = 'studio') {
  page = next;
  $('#workspace').hidden = page !== 'studio'; $('#connections-panel').hidden = page !== 'connections'; $('#gallery-panel').hidden = page !== 'gallery'; $('#providers-panel').hidden = page !== 'providers';
  for (const [id, target] of [['studio-tab', 'studio'], ['media-tab', 'gallery'], ['connections-tab', 'connections'], ['providers-tab', 'providers']]) {
    $('#' + id).setAttribute('aria-current', page === target ? 'page' : 'false');
  }
  $('#page-label').textContent = { studio: '创作', gallery: '作品', connections: '连接', providers: '供应商与模型' }[page];
  connectionPanel.show(page === 'connections'); gallery.show(page === 'gallery'); creation.show(page === 'studio');
  if (page !== 'studio') closePreview();
}

function feedback(message, error = false) {
  $('#feedback').textContent = message; $('#feedback').hidden = !message;
  $('#feedback').classList.toggle('error', error);
}
function describe(error) {
  if (error.name === 'TimeoutError') return '读取超时，请确认本地服务仍在运行后重试。';
  if (error instanceof TypeError && !error.message.startsWith('不支持')) return '无法连接本地服务，请确认启动地址并重新连接。';
  return [error.message, error.code, error.requestId ? '关联 ID：' + error.requestId : ''].filter(Boolean).join(' · ');
}
function closePreview() { if ($('#image-dialog').open) $('#image-dialog').close(); $('#expanded-image').removeAttribute('src'); }
function setView(mode) {
  const overlay = mode === 'overlay'; $('#image-pair').hidden = overlay; $('#overlay-view').hidden = !overlay;
  for (const button of document.querySelectorAll('#view-modes button')) button.setAttribute('aria-pressed', String(button.dataset.view === mode));
}
function showDraft(preview, mode = 'edit') {
  runTicket++; current = null; releaseMedia(); tab();
  history.replaceState(null, '', location.pathname);
  $('#viewer').setAttribute('aria-busy', 'false'); $('#viewer-empty').hidden = false; $('#run-view').hidden = true;
  $('#viewer-empty h2').textContent = mode === 'generate' ? '从一句想法开始' : '从一张图片开始';
  $('#viewer-empty p').textContent = mode === 'generate' ? '写下你想看见的画面，选一个模型。作品会保存在当前工作区。' : '选好原图，写下想法。作品会保存在当前工作区。';
  $('#draft-preview').removeAttribute('src'); $('#draft-preview').hidden = !preview; if (preview) $('#draft-preview').src = preview;
  $('#prompt').textContent = ''; $('#run-facts').replaceChildren(); $('#download').disabled = true;
  $('#run-details').open = false; $('[data-view="overlay"]').disabled = true; setView('pair'); feedback(''); renderHistory();
}
function renderOperation(operation) {
  if (current?.id !== operation.runId) return;
  $('#operation-note').hidden = false;
  const active = ['queued', 'running'].includes(operation.state);
  $('#operation-note').textContent = active ? '只读取已接收操作的本地进度；停止仅结束本地等待。'
    : operation.state === 'canceled' ? '已停止本地等待。远端取消未请求，不代表退款或未计费。'
      : operation.state === 'interrupted' ? '原操作已中断，现有任务与结果仍保留；不会自动重提。'
        : '本次操作已结束，图片进展以当前流程为准。';
  if (active) {
    $('#status-title').textContent = operation.state === 'queued' ? '本次操作已接收' : '正在处理';
    $('#status-message').textContent = '可以离开此页，已接收的事实仍会保存。';
  }
}
function releaseMedia() {
  runController?.abort(); runController = null;
  closePreview();
  for (const kind of ['source', 'output']) $('#overlay-' + kind).removeAttribute('src');
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
  for (const kind of ['source', 'output']) {
    const image = $('#' + kind + '-image'); image.hidden = true; image.removeAttribute('src');
    $('#' + kind + '-dimensions').textContent = '';
    $('#' + kind + '-placeholder').hidden = false;
  }
}
function disconnect(message = '') {
  providerPanel.disconnect(); canManageProviders = false; $('#providers-panel').hidden = true; $('#providers-tab').hidden = true;
  creation.disconnect(); gallery.disconnect(); capabilities = []; document.body.classList.remove('connected');
  epoch++; runTicket++; recoveryTicket++; mediaClient?.close(); mediaClient = null; client?.close(); client = null; current = null;
  $('#recovery-panel').hidden = true; $('#recovery-panel').open = false;
  $('#recovery-list').replaceChildren(); $('#recovery-note').textContent = ''; $('#recovery-summary').textContent = '';
  $('#recovery-clear-confirm').hidden = true;
  connectionPanel.disconnect(); $('#workspace-nav').hidden = true; $('#app-sidebar').hidden = true; $('#connections-panel').hidden = true; $('#gallery-panel').hidden = true;
  $('#mode-badge').textContent = '只读预览';
  connecting = false; historyBusy = false; runs = []; nextCursor = null; historyTotal = 0;
  releaseMedia(); $('#connect').disabled = false; $('#token').value = ''; $('#token-file').value = '';
  $('#workspace').hidden = true; $('#connection').hidden = false; $('#disconnect').hidden = true;
  $('#run-view').hidden = true; $('#viewer-empty').hidden = false; $('#download').disabled = true;
  $('#viewer-empty h2').textContent = '从一张图片开始'; $('#draft-preview').hidden = true; $('#draft-preview').removeAttribute('src');
  $('#viewer').setAttribute('aria-busy', 'false');
  $('#history-list').replaceChildren(); $('#model-list').replaceChildren(); $('#run-facts').replaceChildren();
  $('#prompt').textContent = ''; $('#status-title').textContent = ''; $('#status-message').textContent = ''; $('#operation-note').textContent = ''; $('#operation-note').hidden = true;
  $('#run-meta').textContent = ''; $('#model-summary').textContent = '读取中'; $('#model-note').textContent = '';
  $('#model-panel').open = false; $('#run-details').open = false; $('#history-count').textContent = '0';
  $('#refresh').disabled = false; $('#load-more').hidden = true;
  feedback(message, Boolean(message));
}
async function connectToken(raw) {
  disconnect();
  const token = raw.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { feedback('Token 格式无效，请选择本次启动生成的会话文件。', true); return; }
  const attempt = epoch;
  connecting = true; $('#connect').disabled = true; feedback('正在连接本地工作台…');
  client = createReadClient(token, { onUnauthorized: () => {
    if (attempt === epoch) disconnect('会话已失效，请选择当前服务生成的 Token 文件重新连接。');
  } });
  const ctx = context();
  try {
    const session = await client.get('/api/v0/session');
    if (!valid(ctx)) return;
    if (session.contractVersion !== 0 || !session.operations.includes('runs.inspect')) throw new TypeError('不支持的工作台会话');
    mediaClient = createMediaClient({ client: ctx.client, session, origin: location.origin });
    capabilities = session.operations; creation.connect(ctx.client, mediaClient, session); gallery.connect(ctx.client);
    canManageProviders = session.providerManagement === true; $('#providers-tab').hidden = !canManageProviders;
    document.body.classList.add('connected'); $('#app-sidebar').hidden = false;
    $('#connection').hidden = true; $('#workspace').hidden = false; $('#disconnect').hidden = false;
    tab(); $('#workspace-nav').hidden = false; $('#connections-tab').hidden = !session.connectionManagement;
    $('#recent-panel').open = !matchMedia('(max-width:850px)').matches;
    $('#mode-badge').textContent = session.operations.includes('runs.continue') ? '可创作' : session.connectionManagement ? 'Core 工作台' : session.readOnly ? '只读预览' : '可选择作品';
    if (!RUN.test(location.hash.slice(1))) creation.beginDraft();
    $('#main-content').focus({ preventScroll: true });
    feedback('');
    await Promise.all([loadModels(ctx), loadHistory(ctx), recoverActions(ctx), ...(session.connectionManagement ? [connectionPanel.connect(ctx.client)] : []),
      ...(canManageProviders ? [providerPanel.connect(ctx.client)] : [])]);
  } catch (error) {
    if (valid(ctx)) disconnect(describe(error));
  } finally {
    if (attempt === epoch) { connecting = false; $('#connect').disabled = false; }
  }
}

async function recoverActions(ctx = context()) {
  if (!ctx.client || !mediaClient) return;
  const media = mediaClient, ticket = ++recoveryTicket;
  $('#recovery-check').disabled = true;
  try {
    const results = await media.recover();
    if (!valid(ctx) || media !== mediaClient || ticket !== recoveryTicket) return;
    const saved = media.snapshot();
    creation.recovered(results);
    $('#recovery-panel').hidden = !results.length && !saved.notice && !saved.actions.length;
    $('#recovery-summary').textContent = saved.actions.length ? saved.actions.length + ' 项待核对' : results.length ? '已读取当前结果' : '';
    const notices = { storage_unavailable: '浏览器恢复存储不可用。本次仅保留内存中的操作标识，刷新后恢复受限。',
      root_changed: '当前工作区已改变，旧的本地恢复标识已清除，原服务记录仍保留。',
      corrupt: '本标签页的恢复记录损坏，原记录已保留。本页仍可浏览作品，新操作暂停。',
      root_unavailable: '当前工作区没有创建请求身份，刷新后请按已有流程核对。' };
    $('#recovery-note').textContent = notices[saved.notice] || (saved.mode === 'memory' && saved.actions.length
      ? '当前只保留内存中的动作标识，刷新恢复受限。请先核对原结果。' : '这里只读取原请求与已保存结果，不会自动开始或继续生成。');
    $('#recovery-check').hidden = saved.blocked || !saved.actions.length;
    $('#recovery-clear').hidden = !saved.blocked && !saved.actions.length;
    const labels = { 'image-import': '素材保存', 'flow-create': '改图流程创建', 'generation-create': '生图流程创建', continue: '执行', selection: '作品选择', stop: '本地停止' };
    const states = { confirmed: '已读取原结果', prepared: '本地意图已保存，仍需明确接回', current: '已读取当前选择',
      active: '原操作仍在处理中', not_found: '尚未找到原请求，请保留原身份后明确处理',
      conflict: '原结果不可用或记录冲突，请核对详情', unavailable: '暂时无法核对，请稍后重试',
      capability_unavailable: '当前服务未开放对应查询，原标识已保留' };
    $('#recovery-list').replaceChildren(...results.map(item => {
      const row = document.createElement('li');
      const text = document.createElement('span'); text.textContent = labels[item.action.kind] + ' · ' + states[item.status]; row.append(text);
      const runId = item.result?.result?.runId || item.result?.operation?.runId || item.action.runId;
      if (RUN.test(runId || '')) {
        const view = document.createElement('button'); view.type = 'button'; view.className = 'quiet'; view.textContent = '查看流程';
        view.addEventListener('click', () => { tab(); loadRun(runId); }); row.append(view);
      }
      if (['prepared', 'not_found'].includes(item.status) && ['image-import', 'flow-create', 'generation-create', 'continue'].includes(item.action.kind)) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary'; retry.textContent = '准备按原 Key 接回';
        retry.addEventListener('click', async () => {
          tab(); if (item.action.runId) await loadRun(item.action.runId);
          if (valid(ctx)) creation.retry(item.action);
        }); row.append(retry);
      }
      return row;
    }));
    const found = results.find(item => item.status === 'confirmed' && ['flow-create', 'generation-create'].includes(item.action.kind));
    if (found && page === 'studio' && !current && !RUN.test(location.hash.slice(1))) {
      await loadRun(found.result.result.runId, { fromAction: true });
    }
  } catch (error) {
    if (valid(ctx) && media === mediaClient && ticket === recoveryTicket) {
      $('#recovery-panel').hidden = false; $('#recovery-note').textContent = describe(error);
    }
  } finally { if (valid(ctx) && media === mediaClient && ticket === recoveryTicket) $('#recovery-check').disabled = false; }
}

async function loadModels(ctx) {
  try {
    const result = await ctx.client.get('/api/v0/models');
    if (!valid(ctx)) return;
    if (result.contractVersion !== 0) throw new TypeError('不支持的模型列表版本');
    creation.setModels(result.models);
    $('#model-summary').textContent = !result.configured ? '未指定配置' : result.total + ' 个候选';
    $('#model-note').textContent = !result.configured ? '启动时可传入 --provider-config。读取已有作品不需要模型配置。'
      : '以下是配置中的候选，尚不代表已实测。此页面不会探测或调用模型。';
    $('#model-list').replaceChildren(...result.models.map(model => {
      const item = document.createElement('li'); item.textContent = model.displayName + (model.supportsImageEdit ? ' · 支持改图协议' : ''); return item;
    }));
  } catch (error) {
    if (valid(ctx)) { $('#model-summary').textContent = '配置不可用'; $('#model-note').textContent = describe(error); }
  }
}
function renderHistory() {
  $('#history-count').textContent = String(historyTotal);
  $('#history-empty').hidden = runs.length !== 0;
  $('#history-list').replaceChildren(...runs.map((run, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'history-item';
    button.dataset.runId = run.id; button.setAttribute('aria-current', run.id === current?.id ? 'true' : 'false');
    const title = document.createElement('strong'); title.textContent = '图片流程 · ' + date(run.createdAt);
    const label = document.createElement('span'); label.textContent = run.modelRef;
    const number = document.createElement('small'); number.textContent = String(index + 1).padStart(2, '0');
    button.append(number, title, label); button.addEventListener('click', () => loadRun(run.id)); return button;
  }));
  $('#load-more').hidden = !nextCursor; $('#load-more').disabled = historyBusy;
}
async function loadHistory(ctx = context(), more = false, openDesired = true) {
  if (!ctx.client || historyBusy) return;
  const selectionAtStart = runTicket;
  historyBusy = true; $('#refresh').disabled = true; $('#load-more').disabled = true;
  try {
    const result = await ctx.client.get('/api/v0/runs?limit=20' + (more && nextCursor ? '&cursor=' + nextCursor : ''));
    if (!valid(ctx)) return;
    if (result.contractVersion !== 0) throw new TypeError('不支持的历史列表版本');
    runs = more ? [...runs, ...result.runs] : result.runs; nextCursor = result.nextCursor; historyTotal = result.total;
    renderHistory();
    if (openDesired && !more && selectionAtStart === runTicket) {
      const desired = current?.id || (RUN.test(location.hash.slice(1)) ? location.hash.slice(1) : null);
      if (desired) await loadRun(desired);
    }
  } catch (error) { if (valid(ctx)) feedback(describe(error), true); }
  finally {
    if (valid(ctx)) { historyBusy = false; $('#refresh').disabled = false; $('#load-more').disabled = false; }
  }
}
function addFact(label, value) {
  const key = document.createElement('dt'), item = document.createElement('dd');
  key.textContent = label; item.textContent = value; $('#run-facts').append(key, item);
}
async function loadMedia(ctx, ticket, kind, artifactId, signal) {
  const placeholder = $('#' + kind + '-placeholder'); placeholder.textContent = artifactId ? '读取中…' : '尚无已保存的结果';
  if (!artifactId) return;
  try {
    const blob = await ctx.client.get('/api/v0/artifacts/' + artifactId + '/content', { binary: true, signal });
    if (!valid(ctx) || ticket !== runTicket) return;
    const url = URL.createObjectURL(blob); urls.add(url);
    const image = $('#' + kind + '-image'); image.src = url;
    await image.decode();
    if (!valid(ctx) || ticket !== runTicket) return;
    image.hidden = false; placeholder.hidden = true;
    $('#overlay-' + kind).src = url;
    if (kind === 'source') creation.source(url);
    $('#' + kind + '-dimensions').textContent = image.naturalWidth + ' × ' + image.naturalHeight;
  } catch (error) {
    if (valid(ctx) && ticket === runTicket && !signal.aborted) placeholder.textContent = '图片读取失败。' + describe(error);
  }
}
async function loadRun(id, { fromAction = false } = {}) {
  const ctx = context(); if (!ctx.client || !RUN.test(id)) return;
  if (!fromAction) creation.cancelChain();
  creation.loading();
  tab(); const sameRun = current?.id === id;
  const ticket = ++runTicket;
  current = null; releaseMedia(); runController = new AbortController();
  const signal = runController.signal;
  $('#run-view').hidden = true; $('#viewer-empty').hidden = false;
  $('#viewer-empty h2').textContent = '正在读取流程…'; $('#viewer').setAttribute('aria-busy', 'true');
  $('#download').disabled = true; feedback('');
  try {
    const view = await ctx.client.get('/api/v0/runs/' + id, { signal });
    if (!valid(ctx) || ticket !== runTicket) return;
    const presentation = presentFlow(view, capabilities); current = view;
    history.replaceState(null, '', '#' + view.id); renderHistory();
    $('#status-title').textContent = presentation.title; $('#status-message').textContent = presentation.message;
    $('#run-view').dataset.tone = presentation.tone;
    $('#run-view').dataset.hasOutput = String(Boolean(view.output));
    $('#run-view').dataset.recipe = view.recipe; $('#source-card').hidden = !view.source; $('#view-modes').hidden = !view.source;
    $('#prompt-title').textContent = view.source ? '修改要求' : '画面描述';
    $('[data-view="overlay"]').disabled = !view.source || !view.output; if (!sameRun || !view.output || !view.source) setView('pair');
    $('#operation-note').hidden = true;
    $('#selection-feedback').textContent = view.selection ? '当前选择已记录，可以下载原始图片。' : capabilities.includes('runs.select')
      ? '选择喜欢的版本，再保存到设备。' : '当前未开启选择权限；已有选择仍可下载。';
    $('#run-meta').textContent = view.input.modelRef + ' · ' + date(view.createdAt);
    $('#prompt').textContent = view.input.prompt;
    $('#source-selected').hidden = !view.source || view.selection?.artifactId !== view.source.artifactId;
    $('#output-selected').hidden = !view.output || view.selection?.artifactId !== view.output.artifactId;
    $('#source-card').classList.toggle('is-selected', !$('#source-selected').hidden);
    $('#output-card').classList.toggle('is-selected', !$('#output-selected').hidden);
    $('#select-source').setAttribute('aria-pressed', String(!$('#source-selected').hidden));
    $('#select-output').setAttribute('aria-pressed', String(!$('#output-selected').hidden));
    $('#download').disabled = !view.selection;
    $('#run-facts').replaceChildren(); if (!sameRun) $('#run-details').open = false;
    creation.view(view, { sameRun });
    addFact('流程', view.id); addFact('版本', String(view.revision)); addFact('保存时间', date(view.updatedAt));
    addFact('类型', view.source ? '图片编辑' : '图片生成');
    if (view.source) addFact('原图', view.source.artifactId); addFact('结果', view.output?.artifactId || '尚未保存');
    addFact('原任务', view.task?.id || '尚未创建');
    if (view.metrics) addFact('像素差异', (view.metrics.ratio * 100).toFixed(2) + '%');
    $('#viewer-empty').hidden = true; $('#run-view').hidden = false;
    await Promise.all([loadMedia(ctx, ticket, 'source', view.source?.artifactId, signal),
      loadMedia(ctx, ticket, 'output', view.output?.artifactId, signal)]);
  } catch (error) {
    if (valid(ctx) && ticket === runTicket && !signal.aborted) {
      $('#viewer-empty h2').textContent = '暂时无法读取此流程'; feedback(describe(error), true);
    }
  } finally { if (valid(ctx) && ticket === runTicket) $('#viewer').setAttribute('aria-busy', 'false'); }
}
async function download() {
  if (!current?.selection || $('#download').disabled) return;
  const ctx = context(), id = current.id, ticket = runTicket;
  $('#download').disabled = true; feedback('正在读取已选作品…');
  try {
    const { blob, filename } = await ctx.client.get('/api/v0/runs/' + id + '/download', { download: true });
    if (!valid(ctx) || ticket !== runTicket) return;
    const url = URL.createObjectURL(blob); urls.add(url);
    const link = document.createElement('a'); link.href = url;
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type];
    if (!extension) throw new TypeError('不支持的下载格式');
    // The CLI may have changed the selection since this view was loaded. Use the server's
    // filename, which identifies the exact artifact returned by this download request.
    if (!/^iris-artifact_[a-f0-9]{24}\.(?:png|jpg|webp)$/.test(filename)) throw new TypeError('不支持的下载文件名');
    link.download = filename; link.click();
    setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); }, 60000);
    feedback('下载请求已交给浏览器，请在浏览器下载记录中查看。');
  } catch (error) { if (valid(ctx) && ticket === runTicket) feedback(describe(error), true); }
  finally { if (valid(ctx) && ticket === runTicket) $('#download').disabled = false; }
}

$('#connect-form').addEventListener('submit', event => {
  event.preventDefault(); if (connecting) return;
  const token = $('#token').value; $('#token').value = ''; connectToken(token);
});
$('#token-file').addEventListener('change', async event => {
  const file = event.target.files[0], attempt = epoch; event.target.value = '';
  if (!file) return;
  if (file.size > 256) { feedback('请选择启动时生成的小型 Token 文本文件。', true); return; }
  try { const token = await file.text(); if (attempt === epoch) await connectToken(token); }
  catch (error) { if (attempt === epoch) feedback('无法读取 Token 文件：' + error.message, true); }
});
$('#disconnect').addEventListener('click', () => disconnect());
$('#refresh').addEventListener('click', async () => { await loadHistory(); await recoverActions(); await creation.refresh(); });
$('#recovery-check').addEventListener('click', () => recoverActions());
$('#recovery-clear').addEventListener('click', () => { $('#recovery-clear-confirm').hidden = false; });
$('#recovery-clear-no').addEventListener('click', () => { $('#recovery-clear-confirm').hidden = true; });
$('#recovery-clear-yes').addEventListener('click', async () => {
  if (!mediaClient) return;
  try { mediaClient.clearRecovery(); $('#recovery-clear-confirm').hidden = true; await recoverActions(); }
  catch (error) { feedback(describe(error), true); }
});
$('#load-more').addEventListener('click', () => loadHistory(context(), true));
$('#download').addEventListener('click', download);
$('#studio-tab').addEventListener('click', () => tab());
$('#media-tab').addEventListener('click', () => tab('gallery'));
$('#connections-tab').addEventListener('click', () => tab('connections'));
for (const id of ['new-run', 'gallery-new']) $('#' + id).addEventListener('click', () => creation.beginDraft());
for (const button of document.querySelectorAll('#view-modes button')) button.addEventListener('click', () => { if (!button.disabled) setView(button.dataset.view); });
$('#compare-split').addEventListener('input', event => $('#overlay-output').style.setProperty('--split', event.target.value + '%'));
for (const kind of ['source', 'output']) $('#' + kind + '-preview').addEventListener('click', () => {
  const image = $('#' + kind + '-image'); if (image.hidden || !image.src) return;
  $('#expanded-image').src = image.src; $('#image-dialog-title').textContent = kind === 'source' ? '原图预览' : '结果预览'; $('#image-dialog').showModal();
});
$('#close-image-dialog').addEventListener('click', closePreview);
$('#image-dialog').addEventListener('close', () => $('#expanded-image').removeAttribute('src'));
for (const details of document.querySelectorAll('details')) details.addEventListener('toggle', () => {
  details.querySelector('.disclosure').textContent = details.open ? '收起' : '展开';
});
createAppearance();
$('#providers-tab').addEventListener('click', () => { if (canManageProviders) tab('providers'); });
$('#manage-models').addEventListener('click', () => {
  if (canManageProviders) tab('providers');
  else feedback('当前服务未开启供应商管理。启动时添加 --allow-provider-management 并指定 --provider-config 后可配置。');
});
window.addEventListener('pagehide', () => disconnect());
matchMedia('(max-width:850px)').addEventListener('change', event => { if (client) $('#recent-panel').open = !event.matches; });
window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (RUN.test(id) && id !== current?.id) loadRun(id); });
