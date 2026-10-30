import { createReadClient, redeemLoginLink } from './transport.js';
import { presentFlow } from './flow-view.js';
import { createConnectionPanel } from './connections.js';
import { createMediaClient, CREATIONS, IMPORTS } from './media-client.js';
import { createCreationPanel } from './creation.js';
import { createGallery } from './gallery.js';
import { createProviderPanel } from './providers.js';
import { createAppearance } from './appearance.js';

const $ = selector => document.querySelector(selector);
const urls = new Set();
let client = null, mediaClient = null, recoveryTicket = 0, epoch = 0, runTicket = 0, runController = null, current = null;
let runs = [], nextCursor = null, historyBusy = false, connecting = false, capabilities = [], page = 'studio', historyTotal = 0;
let canManageProviders = false, audioEnabled = false;
let loginController = null;
let startupSequence = 0;
const passwordMode = document.documentElement.dataset.auth === 'password';
let passwordLogin, passwordLoginLoading;
let plugins = null;
const RUN = /^run_[a-f0-9]{24}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/, SESSION_KEY = 'iris.workbench.session.v0';
const date = value => new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const valid = context => context.epoch === epoch && context.client === client;
const context = () => ({ epoch, client });
const audioRun = view => ['speech/v0', 'transcribe/v0'].includes(view?.recipe);
const recipeLabel = recipe => ({ 'image-edit/v0': '图片编辑', 'image-generate/v0': '图片生成', 'speech/v0': '语音合成', 'transcribe/v0': '音频转写' })[recipe];
const connectionPanel = createConnectionPanel({ describe });
const gallery = createGallery({ openRun: id => loadRun(id), describe });
const providerPanel = createProviderPanel({ describe, onSaved: () => loadModels(context()), onSettings: (value, error) => overview.setSettings(value, error),
  onProbe: options => creation.prepareVerification(options) });
const creation = createCreationPanel({ openRun: loadRun, refreshHistory: () => loadHistory(context(), false, false),
  showDraft, describe, recover: recoverActions, renderOperation });
const overview = createOverviewPanel();
function tab(next = 'studio') {
  page = next;
  document.body.dataset.page = page;
  $('#overview-panel').hidden = page !== 'overview'; $('#workspace').hidden = page !== 'studio'; $('#connections-panel').hidden = page !== 'connections'; $('#gallery-panel').hidden = page !== 'gallery'; $('#providers-panel').hidden = page !== 'providers';
  for (const [id, target] of [['overview-tab', 'overview'], ['studio-tab', 'studio'], ['media-tab', 'gallery'], ['connections-tab', 'connections'], ['providers-tab', 'providers']]) {
    $('#' + id).setAttribute('aria-current', page === target ? 'page' : 'false');
  }
  $('#page-label').textContent = { overview: '总览', studio: '创作', gallery: '作品', connections: '客户端连接', providers: '模型服务' }[page];
  plugins?.show(page);
  if (page === 'plugin-settings') $('#page-label').textContent = '扩展设置';
  else if (page === 'plugin-history') $('#page-label').textContent = '业务记录';
  else if (page.startsWith('plugin:')) $('#page-label').textContent = $('#plugin-page-title').textContent;
  connectionPanel.show(page === 'connections'); gallery.show(page === 'gallery'); creation.show(page === 'studio');
  providerPanel.show(page === 'providers');
  if (page !== 'studio') { closePreview(); for (const id of ['source-audio', 'output-audio', 'audio-input-preview']) $('#' + id).pause(); }
}

function feedback(message, error = false) {
  $('#feedback').textContent = message; $('#feedback').hidden = !message;
  $('#feedback').classList.toggle('error', error);
}
function storedSession(method, value) {
  try {
    const result = window.sessionStorage[method](SESSION_KEY, value);
    if (method !== 'getItem') $('#session-notice').hidden = true;
    return result;
  } catch (error) {
    if (!['SecurityError', 'QuotaExceededError', 'InvalidStateError'].includes(error.name)) throw error;
    const note = $('#session-notice'); note.hidden = false;
    note.textContent = method === 'removeItem' ? '浏览器无法清除保存的登录信息，请关闭此标签页。'
      : '浏览器不允许保存标签页登录，本次仍可连接，刷新后需要重新登录。';
    return null;
  }
}
function restoreSession() {
  const token = storedSession('getItem');
  if (!token) return;
  if (!TOKEN.test(token)) { storedSession('removeItem'); feedback('保存的登录信息已失效，请重新连接。', true); return; }
  return connectToken(token, { restoring: true });
}
async function openSession() {
  if (passwordMode) {
    passwordLoginLoading ||= import('./workbench-login.js').then(({ createWorkbenchLogin }) => passwordLogin = createWorkbenchLogin({
      connect: token => connectToken(token, { restoring: true }), disconnect: () => disconnect('', { forget: false }), feedback, describe
    }));
    await passwordLoginLoading; return passwordLogin.open();
  }
  if (!location.hash.startsWith('#login=')) return restoreSession();
  const ticket = location.hash.slice('#login='.length);
  history.replaceState(null, '', location.pathname + location.search);
  disconnect('', { forget: false });
  if (!TOKEN.test(ticket)) { feedback('登录链接无效，请从启动终端获取新链接，或展开备用登录。', true); return; }
  const attempt = epoch, controller = new AbortController();
  loginController = controller; connecting = true; $('#connect').disabled = true;
  feedback('正在进入工作台…');
  try {
    const token = await redeemLoginLink(ticket, controller.signal);
    if (attempt === epoch) await connectToken(token);
  } catch (error) {
    if (attempt === epoch) feedback(describe(error), true);
  } finally {
    if (attempt === epoch) { connecting = false; $('#connect').disabled = false; }
    if (loginController === controller) loginController = null;
  }
}
async function openWorkbench() {
  const attempt = ++startupSequence;
  // Explicit legacy links retain the manual fallback while a ticket exchange is in flight.
  document.documentElement.dataset.startup = !passwordMode && location.hash.startsWith('#login=') ? 'ready' : 'pending';
  try { await openSession(); }
  catch (error) { feedback(describe(error), true); }
  finally { if (attempt === startupSequence) document.documentElement.dataset.startup = 'ready'; }
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
  $('#viewer-empty h2').textContent = ({ generate: '从一句想法开始', edit: '从一张图片开始', tts: '让文字有声音', transcribe: '把声音留下来' })[mode];
  $('#viewer-empty p').textContent = ({ generate: '写下你想看见的画面，选一个模型。作品会保存在当前工作区。', edit: '选好原图，写下想法。作品会保存在当前工作区。',
    tts: '写下要朗读的内容，选择语音模型。合成后可在这里试听、下载。', transcribe: '选择一段音频和转写模型。原音频与文字结果都会保存在当前工作区。' })[mode];
  $('.canvas-label').textContent = ['tts', 'transcribe'].includes(mode) ? '声音工作台' : '创作画布';
  $('#view-modes').hidden = mode !== 'edit'; $('#reuse-selected').hidden = ['tts', 'transcribe'].includes(mode);
  $('#draft-preview').removeAttribute('src'); $('#draft-preview').hidden = !preview; if (preview) $('#draft-preview').src = preview;
  $('#prompt').textContent = ''; $('#run-facts').replaceChildren(); $('#run-parameter-values').replaceChildren(); $('#run-parameters').hidden = true; $('#download').disabled = true;
  $('#run-details').open = false; $('[data-view="overlay"]').disabled = true; setView('pair'); feedback(''); renderHistory();
}
function renderOperation(operation) {
  if (current?.id !== operation.runId) return;
  $('#operation-note').hidden = false;
  const active = ['queued', 'running'].includes(operation.state);
  $('#operation-note').textContent = active ? '只读取已接收操作的本地进度；停止仅结束本地等待。'
    : operation.state === 'canceled' ? '已停止本地等待。远端取消未请求，不代表退款或未计费。'
      : operation.state === 'interrupted' ? '原操作已中断，现有任务与结果仍保留；不会自动重提。'
        : '本次操作已结束，作品进展以当前流程为准。';
  if (active) {
    $('#status-title').textContent = operation.state === 'queued' ? '本次操作已接收' : '正在处理';
    $('#status-message').textContent = '可以离开此页，已接收的事实仍会保存。';
  }
}
function releaseMedia() {
  plugins?.clearPreview();
  runController?.abort(); runController = null;
  closePreview();
  for (const id of ['source-audio', 'output-audio']) { const player = $('#' + id); player.pause(); player.removeAttribute('src'); player.load(); }
  for (const id of ['audio-source-result', 'audio-output-result', 'transcript-result']) $('#' + id).hidden = true;
  $('#transcript-result').textContent = ''; $('#audio-result-note').textContent = ''; $('#audio-result').hidden = true;
  for (const kind of ['source', 'output']) $('#overlay-' + kind).removeAttribute('src');
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
  for (const kind of ['source', 'output']) {
    const image = $('#' + kind + '-image'); image.hidden = true; image.removeAttribute('src');
    $('#' + kind + '-dimensions').textContent = '';
    $('#' + kind + '-placeholder').hidden = false;
  }
}
function disconnect(message = '', { forget = true } = {}) {
  plugins?.disconnect();
  loginController?.abort(); loginController = null;
  if (forget) { if (passwordMode) passwordLogin?.forget(); else storedSession('removeItem'); }
  providerPanel.disconnect(); overview.disconnect(); canManageProviders = audioEnabled = false; $('#providers-panel').hidden = true; $('#providers-tab').hidden = true;
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
  $('#history-list').replaceChildren(); $('#model-list').replaceChildren(); $('#run-facts').replaceChildren(); $('#run-parameter-values').replaceChildren(); $('#run-parameters').hidden = true;
  $('#prompt').textContent = ''; $('#status-title').textContent = ''; $('#status-message').textContent = ''; $('#operation-note').textContent = ''; $('#operation-note').hidden = true;
  $('#run-meta').textContent = ''; $('#model-summary').textContent = '读取中'; $('#model-note').textContent = '';
  $('#model-panel').open = false; $('#run-details').open = false; $('#history-count').textContent = '0';
  $('#refresh').disabled = false; $('#load-more').hidden = true;
  feedback(message, Boolean(message));
}
async function connectToken(raw, { restoring = false } = {}) {
  disconnect('', { forget: !restoring });
  const token = raw.trim();
  if (!TOKEN.test(token)) { feedback('Token 格式无效，请选择本次启动生成的会话文件。', true); return; }
  const attempt = epoch;
  connecting = true; $('#connect').disabled = true; feedback('正在连接本地工作台…');
  client = createReadClient(token, { onUnauthorized: () => {
    if (attempt === epoch) disconnect(passwordMode ? '登录已失效，请重新输入访问口令。'
      : '登录已失效，请打开当前服务的登录链接，或展开备用登录使用本次启动的 Token 文件。');
  } });
  const ctx = context();
  try {
    const session = await client.get('/api/v0/session');
    if (!valid(ctx)) return;
    if (session.contractVersion !== 0 || !session.operations.includes('runs.inspect')) throw new TypeError('不支持的工作台会话');
    if (!passwordMode) storedSession('setItem', token);
    mediaClient = createMediaClient({ client: ctx.client, session, origin: location.origin });
    capabilities = session.operations; audioEnabled = session.audio === true; overview.connect(session); creation.connect(ctx.client, mediaClient, session); gallery.connect(ctx.client, session);
    if (!plugins && (session.pluginExecution || session.panelContributions?.pages.length || session.panelContributions?.settings.length || session.panelContributions?.renderers.length)) {
      const { createPluginPanel } = await import('./plugin-panel.js');
      if (!valid(ctx)) return;
      plugins = createPluginPanel({ navigate: tab, describe, onProvidersSaved: result => { overview.setSettings(result); void loadModels(context()); } });
    }
    plugins?.connect(ctx.client, session);
    canManageProviders = session.providerManagement === true; $('#providers-tab').hidden = !canManageProviders;
    document.body.classList.add('connected'); $('#app-sidebar').hidden = false;
    $('#connection').hidden = true; $('#workspace').hidden = false; $('#disconnect').hidden = false;
    tab(); $('#workspace-nav').hidden = false; $('#connections-tab').hidden = !session.connectionManagement;
    $('#recent-panel').open = !matchMedia('(max-width:850px)').matches;
    $('#mode-badge').textContent = session.operations.includes('runs.continue') ? '可创作' : session.connectionManagement ? 'Core 工作台' : session.readOnly ? '只读预览' : '可选择作品';
    const overviewRequested = location.hash === '#overview';
    if (!RUN.test(location.hash.slice(1))) creation.beginDraft();
    if (overviewRequested) { history.replaceState(null, '', '#overview'); tab('overview'); }
    document.documentElement.dataset.startup = 'ready';
    $('#main-content').focus({ preventScroll: true });
    feedback('');
    await Promise.all([loadModels(ctx), loadHistory(ctx), recoverActions(ctx), ...(session.connectionManagement ? [connectionPanel.connect(ctx.client)] : []),
      ...(canManageProviders ? [providerPanel.connect(ctx.client)] : [])]);
  } catch (error) {
    if (valid(ctx)) disconnect(describe(error), { forget: !restoring || error.status === 401 || error.message.startsWith('不支持') });
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
    const labels = { 'image-import': '素材保存', 'flow-create': '改图流程创建', 'generation-create': '生图流程创建', 'audio-import': '音频保存',
      'speech-create': '语音流程创建', 'transcription-create': '转写流程创建', continue: '执行', selection: '作品选择', stop: '本地停止' };
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
      if (['prepared', 'not_found'].includes(item.status) && [...CREATIONS, 'continue'].includes(item.action.kind)) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary'; retry.textContent = '准备按原 Key 接回';
        retry.addEventListener('click', async () => {
          tab(); if (item.action.runId) await loadRun(item.action.runId);
          if (valid(ctx)) creation.retry(item.action);
        }); row.append(retry);
      }
      return row;
    }));
    const found = results.find(item => item.status === 'confirmed' && CREATIONS.includes(item.action.kind) && !IMPORTS.includes(item.action.kind));
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
    const results = await Promise.all([ctx.client.get('/api/v0/models'), ...(audioEnabled ? [ctx.client.get('/api/v0/audio-models')] : [])]);
    if (!valid(ctx)) return;
    if (results.some(result => result.contractVersion !== 0)) throw new TypeError('不支持的模型列表版本');
    const models = results.flatMap(result => result.models), configured = results[0].configured;
    creation.setModels(models); overview.setModels({ models, configured });
    $('#model-summary').textContent = !configured ? '未指定配置' : models.length + ' 个候选';
    $('#model-note').textContent = !configured ? '启动时可传入 --provider-config。读取已有作品不需要模型配置。'
      : '以下是配置中的候选，尚不代表已实测。此页面不会探测或调用模型。';
    $('#model-list').replaceChildren(...models.map(model => {
      const item = document.createElement('li'); item.textContent = model.displayName + (model.capability ? model.capability === 'tts' ? ' · 语音合成' : ' · 音频转写' : model.supportsImageEdit ? ' · 支持改图协议' : ''); return item;
    }));
  } catch (error) {
    if (valid(ctx)) { $('#model-summary').textContent = '配置不可用'; $('#model-note').textContent = describe(error); overview.setModels(null, describe(error)); }
  }
}

// A read-only view of existing session/catalogue facts. Opening a card never executes media.
function createOverviewPanel() {
  const features = [
    { id: 'image', cap: 'image-gen', title: '图片', subtitle: '生成、修改，或运行 ComfyUI 工作流。',
      icon: 'M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4 M8 8h.01', modes: [['generate', '生成图片', 'generations.create'], ['edit', '修改图片', 'runs.create']],
      detail: 'API 与 ComfyUI 共用图片作品。修改图片需所选协议支持带图编辑；ComfyUI 参数来自已保存工作流，真实服务仍需单独验收。', command: 'run image' },
    { id: 'video', cap: 'video-gen', title: '视频', subtitle: '文生视频、图生视频与语音驱动视频。',
      icon: 'M3 6h12v12H3z M15 10l6-3v10l-6-3', modes: [],
      detail: 'CLI 与 DSH 已有生成和原任务跟踪。Core 创作页与通用 MCP 尚未接入，配置用途不会自动增加入口。', command: 'run video' },
    { id: 'tts', cap: 'tts', title: '语音', subtitle: '让一段文字成为可以试听的声音。',
      icon: 'M4 10h4l5-4v12l-5-4H4z M16 8c3 2 3 6 0 8 M19 5c5 4 5 10 0 14', modes: [['tts', '合成语音', 'speeches.create']],
      detail: '新 v3 音频工作区提供 Web / MCP 流程，当前内置合成接口为 DashScope Qwen-TTS 普通 HTTP；音色须与实际模型匹配。', command: 'run tts' },
    { id: 'music', cap: 'music-gen', title: '音乐', subtitle: '按创作要求生成并保存音频。',
      icon: 'M9 17V5l11-2v12 M9 5v4l11-2 M9 17a3 3 0 1 1-3-3h3 M20 15a3 3 0 1 1-3-3h3', modes: [],
      detail: 'CLI / DSH 当前支持 Chat Completions 响应文字中的 MP3/WAV 内嵌音频，需明确选择模型音乐协议。Core 创作页与通用 MCP 待接入。', command: 'run music' },
    { id: 'transcribe', cap: 'transcribe', title: '转写', subtitle: '保存原音频，接回可查看的文字。',
      icon: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8', modes: [['transcribe', '转写音频', 'transcriptions.create']],
      detail: '新 v3 工作区提供 Web / MCP 流程，沿用现有 DashScope 转写接口。原音频保存在当前工作区，明确开始后才上传并调用模型。', command: 'run transcribe' },
    { id: 'vision', cap: 'vision', title: '视觉', subtitle: '看图、长图 OCR、定位与视频摘要。',
      icon: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0', modes: [],
      detail: 'CLI 与 DSH 已有视觉工具，Core 创作页与通用 MCP 待接入。独立 CLI 需配置视觉模型；DSH 的宿主视觉选项不代表独立 Core 具有宿主服务。', command: 'vision look / locate / ocr / summarize' }
  ];
  const node = (tag, text, className) => {
    const value = document.createElement(tag); if (text !== undefined) value.textContent = text;
    if (className) value.className = className; return value;
  };
  let info = null, catalog = null, settings = null, total = null, refreshing = false;
  const errors = { models: '', settings: '', history: '' };
  const operations = () => info?.operations || [];
  const executable = () => operations().includes('runs.continue');
  const candidates = feature => catalog?.models.filter(model => feature.id === 'image' ? !model.capability : model.capability === feature.cap);
  const supported = feature => feature.id === 'image' || feature.modes.length && info?.audio === true;
  function fact(list, title, value) { list.append(node('dt', title), node('dd', value)); }
  function card(feature, index) {
    const article = node('article', undefined, 'overview-capability card'); article.dataset.overviewCapability = feature.id; article.dataset.providerTone = String(index);
    const heading = node('div', undefined, 'overview-capability-heading'), mark = node('span', undefined, 'overview-capability-icon');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS(svg.namespaceURI, 'path');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); path.setAttribute('d', feature.icon); svg.append(path); mark.append(svg);
    heading.append(mark, node('h3', feature.title), node('span', supported(feature) ? '面板已接入' : feature.modes.length ? '需音频工作区' : 'CLI / DSH', 'overview-entry'));
    article.append(heading, node('p', feature.subtitle, 'overview-capability-description'));
    const declared = settings?.providers.flatMap(provider => provider.models.filter(model => model.capabilities.includes(feature.cap)));
    const policy = settings?.assignments[feature.cap], values = candidates(feature);
    const config = errors.settings ? '配置读取失败，未作判断' : settings
      ? declared.length + ' 个已标注 · ' + ({ auto: '自动选择', manual: '手动排序', disabled: '功能已停用' })[policy.mode]
      : info.providerManagement ? '读取已保存配置…' : !feature.modes.length ? '当前会话未提供配置详情' : !supported(feature) ? '当前工作区未提供音频候选'
        : errors.models ? '候选读取失败' : !catalog ? '读取模型候选…' : !catalog.configured ? '未指定配置' : values.length + ' 个候选';
    const facts = node('dl', undefined, 'overview-capability-facts'); fact(facts, '配置', config);
    if (feature.modes.length && info.providerManagement) fact(facts, '候选', errors.models ? '读取失败，未作判断'
      : !catalog ? '读取中…' : !supported(feature) ? '此工作区未接入音频流程' : values.length + ' 个当前候选');
    const records = declared?.map(model => model.verified[feature.cap]).filter(Boolean), passed = records?.filter(record => record.ok).length;
    const evidence = errors.settings ? '记录读取失败' : !settings ? info.providerManagement ? '读取实测记录…' : '当前会话未提供记录'
      : !records.length ? '尚无实测记录' : passed + ' 通过 · ' + (records.length - passed) + ' 未通过';
    fact(facts, '历史实测', evidence); article.append(facts);
    const actions = node('div', undefined, 'overview-capability-actions');
    if (supported(feature) && executable()) {
      for (const [mode, label, operation] of feature.modes) {
        const action = node('button', label, 'secondary'); action.type = 'button'; action.dataset.overviewCreate = mode;
        const count = values?.filter(model => mode !== 'edit' || model.supportsImageEdit).length;
        action.disabled = !operations().includes(operation) || Boolean(errors.models) || !count;
        action.title = action.disabled ? !operations().includes(operation) ? '当前服务未开放此创建入口' : errors.models ? '模型候选尚未读取成功' : '暂无此功能的可用候选' : '打开创作表单，不会自动提交';
        action.addEventListener('click', () => creation.beginDraft({ mode })); actions.append(action);
      }
    } else if (supported(feature)) actions.append(node('span', '当前仅浏览，开启执行后可创作。', 'overview-action-note'));
    if (info.providerManagement && (!supported(feature) || !values?.length || !executable())) {
      const manage = node('button', '配置模型', 'quiet'); manage.type = 'button'; manage.dataset.overviewConfigure = feature.id;
      manage.addEventListener('click', () => tab('providers')); actions.append(manage);
    }
    article.append(actions);
    const more = node('details', undefined, 'overview-capability-more'), summary = node('summary');
    const disclosure = node('span', '展开', 'disclosure'); summary.append(node('span', '入口与说明'), disclosure); more.append(summary, node('p', feature.detail));
    more.append(node('p', 'CLI 入口 · dsh-iris ' + feature.command, 'overview-command'));
    const latest = records?.filter(record => Number.isFinite(Date.parse(record.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (latest) {
      const time = node('time', '最近实测记录 · ' + date(latest.at), 'overview-evidence-time'); time.dateTime = latest.at; more.append(time);
    }
    more.addEventListener('toggle', () => { disclosure.textContent = more.open ? '收起' : '展开'; }); article.append(more);
    return article;
  }
  function render() {
    if (!info) return;
    const stats = $('#overview-stats'); stats.replaceChildren();
    const state = node('div'); fact(state, '当前服务', executable() ? '可创作' : '仅浏览');
    state.append(node('span', info.audio ? '图片、语音与转写工作区' : '图片工作区', 'overview-stat-note')); stats.append(state);
    const models = node('div'); fact(models, '创作候选', errors.models ? '读取失败' : !catalog ? '读取中…' : !catalog.configured ? '未指定配置' : new Set(catalog.models.map(model => model.modelRef)).size + ' 个');
    models.append(node('span', info.audio ? '图片/语音/转写，按模型去重' : '图片候选，按模型去重', 'overview-stat-note')); stats.append(models);
    const history = node('div'); fact(history, '已保存流程', errors.history ? '读取失败' : total === null ? '读取中…' : total + ' 个');
    history.append(node('span', '仅统计当前工作区', 'overview-stat-note')); stats.append(history);
    const expanded = new Set([...document.querySelectorAll('#overview-capabilities details[open]')].map(details => details.closest('[data-overview-capability]').dataset.overviewCapability));
    $('#overview-capabilities').replaceChildren(...features.map(card));
    for (const article of $('#overview-capabilities').children) if (expanded.has(article.dataset.overviewCapability)) article.querySelector('details').open = true;
    $('#overview-create').textContent = executable() ? catalog && !catalog.models.length && info.providerManagement ? '配置模型' : '开始创作' : '查看创作页';
    $('#overview-refresh').disabled = refreshing; $('#overview-refresh').textContent = refreshing ? '读取中…' : '刷新状态';
    const failures = Object.values(errors).filter(Boolean); $('#overview-feedback').hidden = !failures.length;
    $('#overview-feedback').textContent = failures.length ? '部分状态读取失败，未将未知状态判断为未配置。' + failures.join(' · ') : '';
    $('#overview-feedback').classList.toggle('error', failures.length > 0);
  }
  $('#overview-create').addEventListener('click', () => {
    if (!executable()) tab();
    else if (catalog && !catalog.models.length && info.providerManagement) tab('providers');
    else creation.beginDraft();
  });
  $('#overview-gallery').addEventListener('click', () => tab('gallery'));
  $('#overview-refresh').addEventListener('click', async () => {
    if (refreshing || !info) return;
    const ctx = context(); refreshing = true; render();
    try {
      await Promise.all([loadModels(ctx), loadHistory(ctx, false, false), ...(info.providerManagement ? [(async () => {
        try {
          const value = await ctx.client.get('/api/v0/provider-management/settings');
          if (!valid(ctx)) return;
          if (value.contractVersion !== 0) throw new TypeError('不支持的供应商设置版本');
          settings = value; errors.settings = '';
        } catch (error) { if (valid(ctx)) { settings = null; errors.settings = describe(error); } }
      })()] : [])]);
    } finally { if (valid(ctx)) { refreshing = false; render(); } }
  });
  return Object.freeze({
    connect(session) { info = session; catalog = settings = null; total = null; for (const key of Object.keys(errors)) errors[key] = ''; render(); },
    setModels(value, error = '') { catalog = value; errors.models = error; render(); },
    setSettings(value, error = '') { settings = value; errors.settings = error; render(); },
    setHistory(value, error = '') { total = value; errors.history = error; render(); },
    disconnect() { info = catalog = settings = null; total = null; refreshing = false; $('#overview-panel').hidden = true; $('#overview-capabilities').replaceChildren(); $('#overview-stats').replaceChildren(); $('#overview-feedback').hidden = true; }
  });
}

function renderHistory() {
  $('#history-count').textContent = String(historyTotal);
  $('#history-empty').hidden = runs.length !== 0;
  $('#history-list').replaceChildren(...runs.map((run, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'history-item';
    button.dataset.runId = run.id; button.setAttribute('aria-current', run.id === current?.id ? 'true' : 'false');
    const title = document.createElement('strong'); title.textContent = (audioRun(run) ? recipeLabel(run.recipe) : '图片流程') + ' · ' + date(run.createdAt);
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
    renderHistory(); overview.setHistory(result.total);
    if (openDesired && !more && selectionAtStart === runTicket) {
      const desired = current?.id || (RUN.test(location.hash.slice(1)) ? location.hash.slice(1) : null);
      if (desired) await loadRun(desired);
    }
  } catch (error) { if (valid(ctx)) { feedback(describe(error), true); overview.setHistory(null, describe(error)); } }
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
    return { id: artifactId, mediaType: blob.type.split(';')[0], label: kind === 'source' ? '原图' : '生成结果' };
  } catch (error) {
    if (valid(ctx) && ticket === runTicket && !signal.aborted) placeholder.textContent = '图片读取失败。' + describe(error);
  }
}
async function loadAudioMedia(ctx, ticket, kind, artifactId, signal) {
  if (!artifactId) return;
  const text = kind === 'transcript';
  try {
    const blob = await ctx.client.get('/api/v0/artifacts/' + artifactId + (text ? '/text' : '/audio'), { binary: true, signal });
    if (!valid(ctx) || ticket !== runTicket) return;
    if (text) {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
      if (!valid(ctx) || ticket !== runTicket) return;
      $('#transcript-result').textContent = value; $('#transcript-result').hidden = false;
    } else {
      const url = URL.createObjectURL(blob); urls.add(url);
      $('#' + kind + '-audio').src = url; $('#audio-' + kind + '-result').hidden = false;
    }
    return { id: artifactId, mediaType: blob.type.split(';')[0], label: text ? '转写文字' : kind === 'source' ? '原音频' : '合成语音' };
  } catch (error) {
    if (valid(ctx) && ticket === runTicket && !signal.aborted) $('#audio-result-note').textContent += (text ? '文字' : '音频') + '读取失败：' + describe(error) + ' ';
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
    const presentation = presentFlow(view, capabilities), isAudio = audioRun(view); current = view;
    history.replaceState(null, '', '#' + view.id); renderHistory();
    $('#status-title').textContent = presentation.title; $('#status-message').textContent = presentation.message;
    $('#run-view').dataset.tone = presentation.tone;
    $('#run-view').dataset.hasOutput = String(Boolean(view.output));
    $('#run-view').dataset.recipe = view.recipe; $('#source-card').hidden = !view.source; $('#view-modes').hidden = isAudio || !view.source;
    $('#prompt-title').textContent = isAudio ? view.recipe === 'speech/v0' ? '朗读内容' : '转写来源' : view.source ? '修改要求' : '画面描述';
    $('[data-view="overlay"]').disabled = !view.source || !view.output; if (!sameRun || !view.output || !view.source) setView('pair');
    if (isAudio) { $('#image-pair').hidden = true; $('#overlay-view').hidden = true; }
    $('#audio-result').hidden = !isAudio; $('#reuse-selected').hidden = isAudio;
    $('.canvas-label').textContent = isAudio ? '声音工作台' : '创作画布';
    $('#audio-result-kind').textContent = view.recipe === 'speech/v0' ? 'VOICE' : 'TRANSCRIPT';
    $('#audio-result-title').textContent = view.recipe === 'speech/v0' ? '让文字有声音' : '声音里的文字';
    $('#audio-result-note').textContent = view.output ? '作品已保存；点击播放或下载即可使用。' : '明确执行后，原任务的结果会保存在这里。';
    $('#operation-note').hidden = true;
    $('#selection-feedback').textContent = isAudio ? view.output ? view.recipe === 'speech/v0' ? '音频已保存，可以试听或下载。' : '转写已保存，可下载 UTF-8 文本。' : '结果尚未保存。'
      : view.selection ? '当前选择已记录，可以下载原始图片。' : capabilities.includes('runs.select')
      ? '选择喜欢的版本，再保存到设备。' : '当前未开启选择权限；已有选择仍可下载。';
    $('#run-meta').textContent = view.input.modelRef + ' · ' + date(view.createdAt);
    $('#prompt').textContent = isAudio ? view.input.text || '使用此流程已保存的原音频。' : view.input.prompt;
    const parameters = Object.entries(view.input.workflowParameters || {});
    $('#run-parameters').hidden = !parameters.length;
    $('#run-parameter-values').replaceChildren(...parameters.flatMap(([id, value]) => {
      const label = document.createElement('dt'), item = document.createElement('dd'); label.textContent = id;
      item.textContent = typeof value === 'boolean' ? value ? '开启' : '关闭' : String(value); return [label, item];
    }));
    $('#source-selected').hidden = !view.source || view.selection?.artifactId !== view.source.artifactId;
    $('#output-selected').hidden = !view.output || view.selection?.artifactId !== view.output.artifactId;
    $('#source-card').classList.toggle('is-selected', !$('#source-selected').hidden);
    $('#output-card').classList.toggle('is-selected', !$('#output-selected').hidden);
    $('#select-source').setAttribute('aria-pressed', String(!$('#source-selected').hidden));
    $('#select-output').setAttribute('aria-pressed', String(!$('#output-selected').hidden));
    $('#download').disabled = isAudio ? !view.output : !view.selection;
    $('#download').textContent = isAudio ? view.recipe === 'speech/v0' ? '下载音频' : '下载文字' : '下载已选作品';
    $('#run-details .muted').hidden = isAudio;
    $('#run-facts').replaceChildren(); if (!sameRun) $('#run-details').open = false;
    creation.view(view, { sameRun });
    addFact('流程', view.id); addFact('版本', String(view.revision)); addFact('保存时间', date(view.updatedAt));
    addFact('类型', recipeLabel(view.recipe));
    if (view.input.voice) addFact('音色', view.input.voice);
    if (view.source) addFact(isAudio ? '原音频' : '原图', view.source.artifactId); addFact('结果', view.output?.artifactId || '尚未保存');
    addFact('原任务', view.task?.id || '尚未创建');
    if (view.metrics) addFact('像素差异', (view.metrics.ratio * 100).toFixed(2) + '%');
    $('#viewer-empty').hidden = true; $('#run-view').hidden = false;
    const previewArtifacts = await Promise.all(isAudio ? [loadAudioMedia(ctx, ticket, 'source', view.source?.artifactId, signal),
      loadAudioMedia(ctx, ticket, view.recipe === 'speech/v0' ? 'output' : 'transcript', view.output?.artifactId, signal)]
      : [loadMedia(ctx, ticket, 'source', view.source?.artifactId, signal), loadMedia(ctx, ticket, 'output', view.output?.artifactId, signal)]);
    if (valid(ctx) && ticket === runTicket && !signal.aborted) plugins?.previewArtifacts(previewArtifacts, view.selection?.artifactId || view.output?.artifactId);
  } catch (error) {
    if (valid(ctx) && ticket === runTicket && !signal.aborted) {
      $('#viewer-empty h2').textContent = '暂时无法读取此流程'; feedback(describe(error), true);
    }
  } finally { if (valid(ctx) && ticket === runTicket) $('#viewer').setAttribute('aria-busy', 'false'); }
}
async function download() {
  if (!(audioRun(current) ? current?.output : current?.selection) || $('#download').disabled) return;
  const ctx = context(), id = current.id, ticket = runTicket;
  $('#download').disabled = true; feedback('正在读取作品…');
  try {
    const { blob, filename } = await ctx.client.get('/api/v0/runs/' + id + '/download', { download: true });
    if (!valid(ctx) || ticket !== runTicket) return;
    const url = URL.createObjectURL(blob); urls.add(url);
    const link = document.createElement('a'); link.href = url;
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'text/plain': 'txt' }[blob.type];
    if (!extension) throw new TypeError('不支持的下载格式');
    // The CLI may have changed the selection since this view was loaded. Use the server's
    // filename, which identifies the exact artifact returned by this download request.
    if (!/^iris-artifact_[a-f0-9]{24}\.(?:png|jpg|webp|wav|mp3|ogg|flac|txt)$/.test(filename)) throw new TypeError('不支持的下载文件名');
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
$('#disconnect').addEventListener('click', () => passwordMode ? passwordLogin?.logout() : disconnect());
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
$('#overview-tab').addEventListener('click', () => tab('overview'));
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
window.addEventListener('pagehide', () => { startupSequence++; document.documentElement.dataset.startup = 'pending'; passwordLogin?.pause(); disconnect('', { forget: false }); });
window.addEventListener('pageshow', event => { if (event.persisted && !client && !connecting) openWorkbench(); });
matchMedia('(max-width:850px)').addEventListener('change', event => { if (client) $('#recent-panel').open = !event.matches; });
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#login=') || passwordMode && location.hash.startsWith('#setup=')) { openWorkbench(); return; }
  if (location.hash === '#overview') { if (client) tab('overview'); return; }
  const id = location.hash.slice(1);
  if (RUN.test(id)) { if (id !== current?.id) loadRun(id); else if (client) tab(); }
});
openWorkbench();
