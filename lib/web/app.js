import { createReadClient } from './transport.js';
import { presentReadOnlyFlow } from './flow-view.js';
import { createConnectionPanel } from './connections.js';

const $ = selector => document.querySelector(selector);
const urls = new Set();
let client = null, epoch = 0, runTicket = 0, runController = null, current = null;
let runs = [], nextCursor = null, historyBusy = false, connecting = false;
const RUN = /^run_[a-f0-9]{24}$/;
const date = value => new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const valid = context => context.epoch === epoch && context.client === client;
const context = () => ({ epoch, client });
const connectionPanel = createConnectionPanel({ describe });
function tab(connections = false) {
  if (connections) feedback('');
  $('#workspace').hidden = connections; $('#connections-panel').hidden = !connections;
  $('#media-tab').setAttribute('aria-current', connections ? 'false' : 'page');
  $('#connections-tab').setAttribute('aria-current', connections ? 'page' : 'false');
  connectionPanel.show(connections);
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
function releaseMedia() {
  runController?.abort(); runController = null;
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
  for (const kind of ['source', 'output']) {
    const image = $('#' + kind + '-image'); image.hidden = true; image.removeAttribute('src');
    $('#' + kind + '-dimensions').textContent = '';
    $('#' + kind + '-placeholder').hidden = false;
  }
}
function disconnect(message = '') {
  epoch++; runTicket++; client?.close(); client = null; current = null;
  connectionPanel.disconnect(); $('#workspace-nav').hidden = true; $('#connections-panel').hidden = true;
  $('#mode-badge').textContent = '只读预览';
  connecting = false; historyBusy = false; runs = []; nextCursor = null;
  releaseMedia(); $('#connect').disabled = false; $('#token').value = ''; $('#token-file').value = '';
  $('#workspace').hidden = true; $('#connection').hidden = false; $('#disconnect').hidden = true;
  $('#run-view').hidden = true; $('#viewer-empty').hidden = false; $('#download').disabled = true;
  $('#viewer-empty h2').textContent = '从一段创作开始';
  $('#viewer').setAttribute('aria-busy', 'false');
  $('#history-list').replaceChildren(); $('#model-list').replaceChildren(); $('#run-facts').replaceChildren();
  $('#prompt').textContent = ''; $('#status-title').textContent = ''; $('#status-message').textContent = '';
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
    if (session.contractVersion !== 0 || !(session.readOnly || session.workbenchMediaReadOnly) || !session.operations.includes('runs.inspect')) throw new TypeError('不支持的工作台会话');
    $('#connection').hidden = true; $('#workspace').hidden = false; $('#disconnect').hidden = false;
    tab(); $('#workspace-nav').hidden = !session.connectionManagement;
    $('#mode-badge').textContent = session.connectionManagement ? 'Core 工作台' : '只读预览';
    feedback('');
    await Promise.all([loadModels(ctx), loadHistory(ctx), ...(session.connectionManagement ? [connectionPanel.connect(ctx.client)] : [])]);
  } catch (error) {
    if (valid(ctx)) disconnect(describe(error));
  } finally {
    if (attempt === epoch) { connecting = false; $('#connect').disabled = false; }
  }
}

async function loadModels(ctx) {
  try {
    const result = await ctx.client.get('/api/v0/models');
    if (!valid(ctx)) return;
    if (result.contractVersion !== 0) throw new TypeError('不支持的模型列表版本');
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
  $('#history-count').textContent = String(runs.length);
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
async function loadHistory(ctx = context(), more = false) {
  if (!ctx.client || historyBusy) return;
  const selectionAtStart = runTicket;
  historyBusy = true; $('#refresh').disabled = true; $('#load-more').disabled = true;
  try {
    const result = await ctx.client.get('/api/v0/runs?limit=20' + (more && nextCursor ? '&cursor=' + nextCursor : ''));
    if (!valid(ctx)) return;
    if (result.contractVersion !== 0) throw new TypeError('不支持的历史列表版本');
    runs = more ? [...runs, ...result.runs] : result.runs; nextCursor = result.nextCursor;
    renderHistory();
    if (!more && selectionAtStart === runTicket) {
      const desired = current?.id || (RUN.test(location.hash.slice(1)) ? location.hash.slice(1) : runs[0]?.id);
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
    $('#' + kind + '-dimensions').textContent = image.naturalWidth + ' × ' + image.naturalHeight;
  } catch (error) {
    if (valid(ctx) && ticket === runTicket && !signal.aborted) placeholder.textContent = '图片读取失败。' + describe(error);
  }
}
async function loadRun(id) {
  const ctx = context(); if (!ctx.client || !RUN.test(id)) return;
  const ticket = ++runTicket;
  current = null; releaseMedia(); runController = new AbortController();
  const signal = runController.signal;
  $('#run-view').hidden = true; $('#viewer-empty').hidden = false;
  $('#viewer-empty h2').textContent = '正在读取流程…'; $('#viewer').setAttribute('aria-busy', 'true');
  $('#download').disabled = true; feedback('');
  try {
    const view = await ctx.client.get('/api/v0/runs/' + id, { signal });
    if (!valid(ctx) || ticket !== runTicket) return;
    const presentation = presentReadOnlyFlow(view); current = view;
    history.replaceState(null, '', '#' + view.id); renderHistory();
    $('#status-title').textContent = presentation.title; $('#status-message').textContent = presentation.message;
    $('#run-view').dataset.tone = presentation.tone;
    $('#run-meta').textContent = view.input.modelRef + ' · ' + date(view.createdAt);
    $('#prompt').textContent = view.input.prompt;
    $('#source-selected').hidden = view.selection?.artifactId !== view.source.artifactId;
    $('#output-selected').hidden = !view.output || view.selection?.artifactId !== view.output.artifactId;
    $('#source-card').classList.toggle('is-selected', !$('#source-selected').hidden);
    $('#output-card').classList.toggle('is-selected', !$('#output-selected').hidden);
    $('#download').disabled = !view.selection;
    $('#run-facts').replaceChildren(); $('#run-details').open = false;
    addFact('流程', view.id); addFact('版本', String(view.revision)); addFact('保存时间', date(view.updatedAt));
    addFact('原图', view.source.artifactId); addFact('结果', view.output?.artifactId || '尚未保存');
    addFact('原任务', view.task?.id || '尚未创建');
    if (view.metrics) addFact('像素差异', (view.metrics.ratio * 100).toFixed(2) + '%');
    $('#viewer-empty').hidden = true; $('#run-view').hidden = false;
    await Promise.all([loadMedia(ctx, ticket, 'source', view.source.artifactId, signal),
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
$('#refresh').addEventListener('click', () => loadHistory());
$('#load-more').addEventListener('click', () => loadHistory(context(), true));
$('#download').addEventListener('click', download);
$('#media-tab').addEventListener('click', () => tab());
$('#connections-tab').addEventListener('click', () => tab(true));
for (const details of document.querySelectorAll('details')) details.addEventListener('toggle', () => {
  details.querySelector('.disclosure').textContent = details.open ? '收起' : '展开';
});
function theme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'; $('#theme').textContent = dark ? '浅色' : '深色';
}
theme(matchMedia('(prefers-color-scheme: dark)').matches);
$('#theme').addEventListener('click', () => theme(document.documentElement.dataset.theme !== 'dark'));
window.addEventListener('pagehide', () => disconnect());
window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (RUN.test(id) && id !== current?.id) loadRun(id); });
