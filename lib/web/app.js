import { createReadClient, redeemLoginLink } from './transport.js';
import { presentFlow } from './flow-view.js';
import { createConnectionPanel } from './connections.js';
import { createMediaClient, CREATIONS, IMPORTS } from './media-client.js';
import { createCreationPanel } from './creation.js';
import { createGallery } from './gallery.js';
import { createProviderPanel } from './providers.js';
import { createAppearance } from './appearance.js';
import { createNetworkPanel } from './network.js';
import { clampCropRect, isSameCropRect, buildLocateOverlaySpec, renderLocateSvg } from './locate-overlay.js';
import { createVideoFramesPanel } from './video-frames.js';
import { createLocalToolsPanel } from './local-tools.js';
import { createRunLineagePanel } from './lineage.js';
import { createOutboxExportControl } from './outbox-export.js';
import { createCopyIdButton } from './clipboard.js';

const $ = selector => document.querySelector(selector);
const urls = new Set();
let client = null, mediaClient = null, recoveryTicket = 0, epoch = 0, runTicket = 0, runController = null, current = null;
let locateCropController = null, locateState = null;
let runs = [], nextCursor = null, historyBusy = false, connecting = false, capabilities = [], page = 'studio', historyTotal = 0;
let canManageProviders = false, audioEnabled = false, musicEnabled = false, videoEnabled = false, visionEnabled = false, inboxEnabled = false, outboxEnabled = false;
let modeLabel = '只读预览';
let loginController = null;
let startupSequence = 0;
const passwordMode = document.documentElement.dataset.auth === 'password';
let passwordLogin, passwordLoginLoading;
let plugins = null;
let pluginStatus = null, pluginStatusSession = null;
const RUN = /^run_[a-f0-9]{24}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/, SESSION_KEY = 'iris.workbench.session.v0';
const date = value => new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const valid = context => context.epoch === epoch && context.client === client;
const context = () => ({ epoch, client });
const videoRun = view => ['video-generate/v0', 'video-i2v/v0', 'video-s2v/v0'].includes(view?.recipe);
const musicRun = view => view?.recipe === 'music/v0';
const audioRun = view => ['speech/v0', 'transcribe/v0', 'music/v0'].includes(view?.recipe);
const visionRun = view => ['vision/v0', 'ocr/v0', 'locate/v0', 'summarize/v0'].includes(view?.recipe);
const recipeLabel = recipe => ({ 'image-edit/v0': '图片编辑', 'image-generate/v0': '图片生成', 'speech/v0': '语音合成', 'transcribe/v0': '音频转写', 'music/v0': '音乐生成', 'video-generate/v0': '视频生成', 'video-i2v/v0': '图生视频', 'video-s2v/v0': '数字人视频', 'vision/v0': '看图', 'ocr/v0': '图片文字识别', 'locate/v0': '视觉定位', 'summarize/v0': '多模态摘要' })[recipe];
const connectionPanel = createConnectionPanel({ describe });
const gallery = createGallery({ openRun: id => loadRun(id), describe });
const providerPanel = createProviderPanel({ describe, onSaved: () => { void networkPanel.refresh(); return loadModels(context()); }, onSettings: (value, error) => overview.setSettings(value, error),
  onProbe: options => creation.prepareVerification(options), onNetworkOpen: id => { tab('network'); networkPanel.focusProvider(id); } });
const networkPanel = createNetworkPanel({ describe, onChanged: value => providerPanel.setNetworkFacts(value) });
const creation = createCreationPanel({ openRun: loadRun, refreshHistory: () => loadHistory(context(), false, false),
  showDraft, describe, recover: recoverActions, renderOperation });
const videoFrames = createVideoFramesPanel({ describe, openPreview: previewImage,
  useFrames: frameArtifactIds => creation.beginDraft({ mode: 'summarize', frameArtifactIds }),
  handoffFrame: (targetMode, options) => handoffImage(targetMode, options),
  onCropFrame: artifactId => openLocalTool('crop', { artifactId }),
  onInspectArtifact: artifactId => { tab('tools'); localTools.inspectArtifactLineage(artifactId); } });
const localTools = createLocalToolsPanel({ describe, openPreview: previewImage, openOverlayPreview: previewImageWithOverlay,
  handoffImage, openRun: id => loadRun(id), onOutboxExported: () => { void overview.loadOutbox(); } });
const runLineage = createRunLineagePanel({ describe, openRun: id => loadRun(id), openPreview: previewImage,
  openInCrop: artifactId => openLocalTool('crop', { artifactId }),
  openInDiff: artifactId => openLocalTool('diff', { artifactId }) });
const overview = createOverviewPanel();
const runOutbox = createOutboxExportControl({
  container: $('#run-outbox-export'),
  getClient: () => client,
  canExport: () => Boolean(outboxEnabled && capabilities.includes('outbox.export')),
  describe,
  onExported: () => { void overview.loadOutbox(); }
});
function openLocalTool(tool = 'crop', options = {}) {
  tab('tools');
  localTools.openTool(tool, options);
}
function handoffImage(targetMode, { file, artifactId, label }) {
  const required = { edit: 'runs.create', 'video-i2v': 'videos-i2v.create', 'video-s2v': 'videos-s2v.create', vision: 'visions.create', ocr: 'ocrs.create', locate: 'locates.create' }[targetMode];
  if (!required || !capabilities.includes(required)) return;
  creation.beginDraft({ file, artifactId, mode: targetMode, label });
}
function hideExtraReuseActions() {
  for (const button of document.querySelectorAll('[data-reuse-image]')) button.hidden = true;
  for (const id of ['reuse-selected-crop', 'reuse-audio-s2v', 'reuse-audio-mux', 'reuse-audio-transcribe', 'reuse-video-mux']) $('#' + id).hidden = true;
}
function tab(next = 'studio') {
  page = next;
  document.body.dataset.page = page;
  $('#overview-panel').hidden = page !== 'overview'; $('#workspace').hidden = page !== 'studio'; $('#connections-panel').hidden = page !== 'connections'; $('#gallery-panel').hidden = page !== 'gallery'; $('#tools-panel').hidden = page !== 'tools'; $('#providers-panel').hidden = page !== 'providers'; $('#plugins-panel').hidden = page !== 'plugins';
  $('#network-panel').hidden = page !== 'network';
  for (const [id, target] of [['overview-tab', 'overview'], ['studio-tab', 'studio'], ['media-tab', 'gallery'], ['tools-tab', 'tools'], ['connections-tab', 'connections'], ['providers-tab', 'providers'], ['network-tab', 'network'], ['plugins-tab', 'plugins']]) {
    $('#' + id).setAttribute('aria-current', page === target ? 'page' : 'false');
  }
  $('#page-label').textContent = { overview: '总览', studio: '创作', gallery: '作品', tools: '本地工具', connections: '客户端连接', providers: '模型服务', network: '网络出口', plugins: '插件' }[page];
  $('#mode-badge').textContent = page === 'network' ? '出口管理' : modeLabel;
  plugins?.show(page);
  if (page === 'plugin-settings') $('#page-label').textContent = '扩展设置';
  else if (page === 'plugin-history') $('#page-label').textContent = '业务记录';
  else if (page.startsWith('plugin:')) $('#page-label').textContent = $('#plugin-page-title').textContent;
  connectionPanel.show(page === 'connections'); gallery.show(page === 'gallery'); localTools.show(page === 'tools'); creation.show(page === 'studio');
  providerPanel.show(page === 'providers');
  networkPanel.show(page === 'network');
  pluginStatus?.show(page === 'plugins');
  if (page === 'plugins' && !pluginStatus) void openPluginStatus();
  closePreview();
  if (page !== 'studio') {
    runLineage.cancelPreview();
    for (const id of ['source-audio', 'output-audio', 'audio-input-preview', 'output-video', 'video-source-audio']) $('#' + id)?.pause();
  }
}

async function openPluginStatus() {
  const ctx = context();
  if (!ctx.client) return;
  $('#plugins-refresh').disabled = true;
  $('#plugins-feedback').hidden = false; $('#plugins-feedback').classList.remove('error'); $('#plugins-feedback').textContent = '正在载入插件页面…';
  try {
    const { createPluginStatusPanel } = await import('./plugin-status.js');
    if (!valid(ctx) || page !== 'plugins') return;
    if (!pluginStatus) { pluginStatus = createPluginStatusPanel({ describe, navigate: tab }); pluginStatus.connect(ctx.client, pluginStatusSession); }
    pluginStatus.show(true);
  } catch (error) {
    if (valid(ctx) && page === 'plugins') {
      $('#plugins-feedback').hidden = false;
      $('#plugins-feedback').classList.add('error');
      $('#plugins-feedback').textContent = '插件页面未能载入，请核对服务版本；源码更新后需正常重启 Core 并刷新页面。' + describe(error);
    }
  }
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
function closePreview() {
  if ($('#image-dialog').open) $('#image-dialog').close();
  $('#expanded-image').removeAttribute('src');
  $('#image-dialog-title').textContent = '图片预览';
  renderLocateSvg($('#expanded-overlay'), null);
}
function previewImage(url, title) {
  renderLocateSvg($('#expanded-overlay'), null);
  $('#expanded-image').src = url; $('#image-dialog-title').textContent = title; $('#image-dialog').showModal();
}
function previewImageWithOverlay(url, title, spec) {
  $('#expanded-image').src = url;
  $('#image-dialog-title').textContent = title;
  renderLocateSvg($('#expanded-overlay'), spec, { maskId: 'expanded-scrim-mask' });
  $('#image-dialog').showModal();
}
function setView(mode) {
  const overlay = mode === 'overlay'; $('#image-pair').hidden = overlay; $('#overlay-view').hidden = !overlay;
  for (const button of document.querySelectorAll('#view-modes button')) button.setAttribute('aria-pressed', String(button.dataset.view === mode));
}
function showDraft(preview, mode = 'edit') {
  runTicket++; current = null; releaseMedia(); runLineage.setRun(null); tab();
  history.replaceState(null, '', location.pathname);
  $('#viewer').setAttribute('aria-busy', 'false'); $('#viewer-empty').hidden = false; $('#run-view').hidden = true;
  $('#viewer-empty h2').textContent = ({ generate: '从一句想法开始', edit: '从一张图片开始', tts: '让文字有声音', transcribe: '把声音留下来', music: '让旋律留下来', video: '让想法动起来', 'video-i2v': '让画面动起来', 'video-s2v': '让肖像开口说话', vision: '读懂图片里的信息', ocr: '把图片里的文字留下来', locate: '在图片里精准找到目标', summarize: '用视频帧生成摘要' })[mode];
  $('#viewer-empty p').textContent = ({ generate: '写下你想看见的画面，选一个模型。作品会保存在当前工作区。', edit: '选好原图，写下想法。作品会保存在当前工作区。',
    video: '描述主体与动作，选择实际视频模型。原任务的结果可在这里播放、下载。', 'video-i2v': '选择首帧图片与支持图生视频的模型，可选补充动作描述。原任务的结果可在这里播放、下载。',
    'video-s2v': '选择首帧肖像图片与驱动音频，由支持数字人视频的模型合成。',
    music: '写下音乐风格与描述，选择音乐模型。单次提交不自动重试 502，完成后可试听、下载或新建重试草稿。',
    tts: '写下要朗读的内容，选择语音模型。合成后可在这里试听、下载。', transcribe: '选择一段音频和转写模型。原音频与文字结果都会保存在当前工作区。',
    vision: '选择原图与视觉模型，写下问题。先保存任务，再明确开始看图。', ocr: '选择原图与视觉模型，核对分块和调用预算。先保存任务，再开始识别。',
    locate: '选择原图与视觉模型，描述要定位的目标。先保存任务，再明确开始定位；结果可直接在画布叠框并一键零计费裁剪。',
    summarize: '摘要完成后可在这里读取和下载文字。' })[mode];
  $('.canvas-label').textContent = mode === 'summarize' ? '视频摘要' : mode === 'locate' ? '视觉定位' : ['vision', 'ocr'].includes(mode) ? '图片信息' : ['video', 'video-i2v', 'video-s2v'].includes(mode) ? '动态工作台' : mode === 'music' ? '音乐工作台' : ['tts', 'transcribe'].includes(mode) ? '声音工作台' : '创作画布';
  $('#view-modes').hidden = mode !== 'edit'; $('#reuse-selected').hidden = ['tts', 'transcribe', 'music', 'video', 'video-i2v', 'video-s2v', 'vision', 'ocr', 'locate', 'summarize'].includes(mode);
  hideExtraReuseActions();
  $('#retry-music-draft').hidden = true;
  hideExtraReuseActions();
  runOutbox.reset();
  $('#draft-preview').alt = mode === 'locate' ? '待视觉定位的本地图片预览' : ['vision', 'ocr'].includes(mode) ? '待识别的本地图片预览' : '待创作的本地预览';
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
        : operation.state === 'failed' ? '本地操作未完成，原记录仍保留。请核对任务及 Core 错误记录后，再决定是否继续。'
        : '本次操作已结束，作品进展以当前流程为准。';
  if (active) {
    const waiting = { remote_capacity: ['等待远端任务名额', '已有任务尚未确认结束，本次生成还没有提交。'],
      root_busy: ['等待数据根写权限', '当前工作区正被其他写入者占用。释放后需主动重试原操作，不会自动开始执行。'],
      cooldown: ['等待模型冷却', '达到可用时间后继续，不会重复提交原请求。'],
      rate_limit: ['等待发送窗口', '请求按当前发送速率排队。'], http_queue: ['等待网络名额', '其他请求正在提交、查询或下载。'],
      candidates: ['正在核对模型', '核对本次模型与原连接身份。'] }[operation.scheduling?.phase];
    const [title, message] = waiting || [operation.state === 'queued' ? '本次操作已接收' : '正在处理', '可以离开此页，已接收的事实仍会保存。'];
    $('#status-title').textContent = title;
    $('#status-message').textContent = message;
    if (locateState) {
      locateState.presentation = { title, message };
      renderLocateVisual();
    }
  }
}
function resetLocateUi() {
  locateCropController?.abort(); locateCropController = null; locateState = null;
  $('#locate-visual').hidden = true;
  $('#locate-toggles').hidden = true;
  $('#locate-badge').textContent = '等待定位';
  $('#locate-stage-frame').hidden = true;
  $('#locate-source-image').removeAttribute('src');
  $('#locate-source-placeholder').hidden = false;
  $('#locate-source-placeholder').textContent = '读取原图中…';
  renderLocateSvg($('#locate-overlay'), null);
  $('#locate-dimensions').textContent = '';
  $('#locate-actions').hidden = true;
  $('#locate-crop-button').hidden = true; $('#locate-crop-button').disabled = true;
  $('#locate-retry-target').hidden = true;
  $('#locate-crop-adjust').hidden = true; $('#locate-crop-adjust').open = false;
  $('#locate-crop-feedback').hidden = true; $('#locate-crop-feedback').textContent = ''; $('#locate-crop-feedback').classList.remove('error');
  $('#locate-crop-result').hidden = true; $('#locate-crop-image').hidden = false; $('#locate-crop-image').removeAttribute('src'); $('#locate-crop-dimensions').textContent = '';
  $('#locate-crop-reload').hidden = true; $('#locate-crop-download').disabled = false;
  $('#locate-json-details').hidden = true; $('#locate-json-details').open = false; $('#locate-json-result').textContent = '';
}
function releaseMedia() {
  plugins?.clearPreview();
  runLineage.cancelPreview();
  runOutbox.reset();
  runController?.abort(); runController = null;
  resetLocateUi();
  videoFrames.reset();
  closePreview();
  for (const id of ['source-audio', 'output-audio', 'output-video', 'video-source-audio']) { const player = $('#' + id); if (player) { player.pause(); player.removeAttribute('src'); player.load(); } }
  for (const id of ['audio-source-result', 'audio-output-result', 'transcript-result', 'video-sources-preview', 'video-source-image-wrap', 'video-source-audio-wrap']) { const node = $('#' + id); if (node) node.hidden = true; }
  $('#video-source-image')?.removeAttribute('src');
  $('#output-video').hidden = true; $('#video-result').hidden = true; $('#video-result-note').textContent = '';
  $('#vision-result').hidden = true; $('#vision-text-result').hidden = true; $('#vision-text-result').textContent = ''; $('#vision-result-note').textContent = '';
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
  pluginStatus?.disconnect(); pluginStatusSession = null;
  $('#plugins-panel').hidden = true; $('#plugins-feedback').textContent = ''; $('#plugins-feedback').hidden = true;
  plugins?.disconnect();
  loginController?.abort(); loginController = null;
  if (forget) { if (passwordMode) passwordLogin?.forget(); else storedSession('removeItem'); }
  providerPanel.disconnect(); overview.disconnect(); canManageProviders = audioEnabled = musicEnabled = videoEnabled = visionEnabled = inboxEnabled = outboxEnabled = false; $('#providers-panel').hidden = true; $('#providers-tab').hidden = true;
  networkPanel.disconnect(); $('#network-panel').hidden = true; $('#network-tab').hidden = true;
  creation.disconnect(); gallery.disconnect(); localTools.disconnect(); runLineage.disconnect(); capabilities = []; document.body.classList.remove('connected');
  epoch++; runTicket++; recoveryTicket++; mediaClient?.close(); mediaClient = null; client?.close(); client = null; current = null;
  $('#retry-music-draft').hidden = true;
  hideExtraReuseActions();
  runOutbox.reset();
  $('#recovery-panel').hidden = true; $('#recovery-panel').open = false;
  $('#recovery-list').replaceChildren(); $('#recovery-note').textContent = ''; $('#recovery-summary').textContent = '';
  $('#recovery-clear-confirm').hidden = true;
  connectionPanel.disconnect(); $('#workspace-nav').hidden = true; $('#app-sidebar').hidden = true; $('#connections-panel').hidden = true; $('#gallery-panel').hidden = true; $('#tools-panel').hidden = true;
  modeLabel = '只读预览'; $('#mode-badge').textContent = modeLabel;
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
    capabilities = session.operations; audioEnabled = session.audio === true; musicEnabled = session.music === true; videoEnabled = session.video === true; visionEnabled = session.vision === true; inboxEnabled = session.inbox === true; outboxEnabled = session.outbox === true; overview.connect(session); creation.connect(ctx.client, mediaClient, session); gallery.connect(ctx.client, session); localTools.connect(ctx.client, session); runLineage.connect(ctx.client, session);
    if (!plugins && (session.pluginExecution || session.panelContributions?.pages.length || session.panelContributions?.settings.length || session.panelContributions?.renderers.length)) {
      const { createPluginPanel } = await import('./plugin-panel.js');
      if (!valid(ctx)) return;
      plugins = createPluginPanel({
        navigate: tab, describe,
        onProvidersSaved: result => { overview.setSettings(result); void loadModels(context()); },
        openRun: id => loadRun(id),
        openArtifactLineage: artifactId => { tab('tools'); localTools.inspectArtifactLineage(artifactId); },
        sendToStudio: draft => { tab(); creation.beginDraft(draft); },
        sendToLocalTool: (tool, options) => openLocalTool(tool, options)
      });
    }
    plugins?.connect(ctx.client, session);
    pluginStatusSession = session; pluginStatus?.connect(ctx.client, session);
    canManageProviders = session.providerManagement === true; $('#providers-tab').hidden = !canManageProviders;
    $('#network-tab').hidden = session.networkManagement !== true;
    document.body.classList.add('connected'); $('#app-sidebar').hidden = false;
    $('#connection').hidden = true; $('#workspace').hidden = false; $('#disconnect').hidden = false;
    tab(); $('#workspace-nav').hidden = false; $('#connections-tab').hidden = !session.connectionManagement;
    $('#recent-panel').open = !matchMedia('(max-width:850px)').matches;
    modeLabel = session.operations.includes('runs.continue') ? '可创作' : session.connectionManagement ? 'Core 工作台' : session.readOnly ? '只读预览' : '可选择作品'; $('#mode-badge').textContent = modeLabel;
    const overviewRequested = location.hash === '#overview';
    if (!RUN.test(location.hash.slice(1))) creation.beginDraft();
    if (overviewRequested) { history.replaceState(null, '', '#overview'); tab('overview'); }
    document.documentElement.dataset.startup = 'ready';
    $('#main-content').focus({ preventScroll: true });
    feedback('');
    await Promise.all([loadModels(ctx), loadHistory(ctx), recoverActions(ctx), ...(session.inbox && session.operations.includes('inbox.list') ? [overview.loadInbox(ctx)] : []), ...(session.outbox ? [overview.loadOutbox(ctx)] : []), ...(session.connectionManagement ? [connectionPanel.connect(ctx.client)] : []),
      ...(canManageProviders ? [providerPanel.connect(ctx.client)] : []), ...(session.networkManagement ? [networkPanel.connect(ctx.client)] : [])]);
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
    const labels = { 'image-import': '素材保存', 'flow-create': '改图流程创建', 'generation-create': '生图流程创建', 'video-create': '视频流程创建', 'video-i2v-create': '图生视频流程创建', 'video-s2v-create': '数字人视频流程创建', 'audio-import': '音频保存',
      'speech-create': '语音流程创建', 'transcription-create': '转写流程创建', 'music-create': '音乐流程创建', 'vision-create': '看图任务创建', 'ocr-create': 'OCR任务创建', 'locate-create': '定位任务创建', 'summarize-create': '摘要任务创建', continue: '执行', selection: '作品选择', stop: '本地停止' };
    const states = { confirmed: '已读取原结果', prepared: '本地意图已保存，仍需明确接回', current: '已读取当前选择',
      active: '原操作仍在处理中', not_found: '尚未找到原请求，请保留原身份后明确处理',
      conflict: '原结果不可用或记录冲突，请核对详情', unavailable: '暂时无法核对，请稍后重试',
      capability_unavailable: '当前服务未开放对应查询，原标识已保留' };
    $('#recovery-list').replaceChildren(...results.map(item => {
      const row = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = labels[item.action.kind] + ' · ' + (item.status === 'active' && item.result.operation.scheduling?.phase === 'root_busy'
        ? '等待数据根写权限，释放后需主动重试' : states[item.status]); row.append(text);
      const runId = item.result?.result?.runId || item.result?.operation?.runId || item.action.runId;
      if (RUN.test(runId || '')) {
        const view = document.createElement('button'); view.type = 'button'; view.className = 'quiet'; view.textContent = '查看流程';
        view.addEventListener('click', () => { tab(); loadRun(runId); }); row.append(view);
      }
      const summary = item.action.kind === 'summarize-create';
      if (['prepared', 'not_found'].includes(item.status) && [...CREATIONS, 'continue'].includes(item.action.kind)
          && (!summary || creation.canRetrySummary(item.action, runId))) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary'; retry.textContent = '准备按原 Key 接回';
        retry.addEventListener('click', async () => {
          const action = summary ? { ...item.action, runId } : item.action;
          tab(); if (action.runId) await loadRun(action.runId);
          if (valid(ctx)) creation.retry(action);
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
    const results = await Promise.all([ctx.client.get('/api/v0/models'),
      ...(audioEnabled ? [ctx.client.get('/api/v0/audio-models')] : []),
      ...(musicEnabled ? [ctx.client.get('/api/v0/music-models').then(value => ({ ...value, models: value.models.map(model => ({ ...model, capability: 'music-gen' })) }))] : []),
      ...(videoEnabled ? [ctx.client.get('/api/v0/video-models').then(value => ({ ...value, models: value.models.map(model => ({ ...model, capability: 'video-gen' })) }))] : []),
      ...(visionEnabled ? [ctx.client.get('/api/v0/vision-models').then(value => ({ ...value, models: value.models.map(model => ({ ...model, capability: 'vision' })) }))] : [])]);
    if (!valid(ctx)) return;
    if (results.some(result => result.contractVersion !== 0)) throw new TypeError('不支持的模型列表版本');
    const models = results.flatMap(result => result.models), configured = results[0].configured;
    creation.setModels(models); overview.setModels({ models, configured });
    $('#model-summary').textContent = !configured ? '未指定配置' : models.length + ' 个候选';
    $('#model-note').textContent = !configured ? '启动时可传入 --provider-config。读取已有作品不需要模型配置。'
      : '以下是配置中的候选，尚不代表已实测。此页面不会探测或调用模型。';
    $('#model-list').replaceChildren(...models.map(model => {
      const item = document.createElement('li');
      const videoSuffix = model.videoModes?.length ? ' · 视频（' + model.videoModes.join('/') + '）' : ' · 视频生成';
      item.textContent = model.displayName + (model.capability ? model.capability === 'video-gen' ? videoSuffix : model.capability === 'music-gen' ? ' · 音乐生成' : model.capability === 'vision' ? ' · 看图 / OCR / 定位' : model.capability === 'tts' ? ' · 语音合成' : ' · 音频转写' : model.supportsImageEdit ? ' · 支持改图协议' : '');
      return item;
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
    { id: 'video', cap: 'video-gen', title: '视频', subtitle: '文生视频、图生视频与数字人视频。',
      icon: 'M3 6h12v12H3z M15 10l6-3v10l-6-3', modes: [['video', '生成视频', 'videos.create'], ['video-i2v', '图生视频', 'videos-i2v.create'], ['video-s2v', '数字人视频', 'videos-s2v.create']],
      detail: '新 v4+ 工作区提供文生视频、图生视频与数字人视频（S2V）流程，按模型协议支持列表分别筛选。明确开始后才调用模型；MP4/WebM 原件可播放下载。', command: 'run video' },
    { id: 'tts', cap: 'tts', title: '语音', subtitle: '让一段文字成为可以试听的声音。',
      icon: 'M4 10h4l5-4v12l-5-4H4z M16 8c3 2 3 6 0 8 M19 5c5 4 5 10 0 14', modes: [['tts', '合成语音', 'speeches.create']],
      detail: '新 v3 音频工作区提供 Web / MCP 流程，当前内置合成接口为 DashScope Qwen-TTS 普通 HTTP；音色须与实际模型匹配。', command: 'run tts' },
    { id: 'music', cap: 'music-gen', title: '音乐', subtitle: '按创作要求生成并保存音频，支持知情重试血缘。',
      icon: 'M9 17V5l11-2v12 M9 5v4l11-2 M9 17a3 3 0 1 1-3-3h3 M20 15a3 3 0 1 1-3-3h3', modes: [['music', '生成音乐', 'music.create']],
      detail: 'v3+ 工作区已接入 Core 音乐流程（Web / MCP / 第三方音乐协议插件）。每次执行最多提交一次，不自动重试 HTTP 502；支持带原描述新建重试草稿。', command: 'run music' },
    { id: 'transcribe', cap: 'transcribe', title: '转写', subtitle: '保存原音频，接回可查看的文字。',
      icon: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v3 M8 22h8', modes: [['transcribe', '转写音频', 'transcriptions.create']],
      detail: '新 v3 工作区提供 Web / MCP 流程，沿用现有 DashScope 转写接口。原音频保存在当前工作区，明确开始后才上传并调用模型。', command: 'run transcribe' },
    { id: 'vision', cap: 'vision', title: '视觉', subtitle: '看图问答、长图 OCR、视觉定位与视频摘要。',
      icon: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0', modes: [['vision', '看图问答', 'visions.create'], ['ocr', '文字识别', 'ocrs.create'], ['locate', '视觉定位', 'locates.create']],
      detail: '新 v5 工作区提供单图看图问答、长图分块 OCR 与视觉定位框叠加及一键零计费裁剪的 Web / MCP 流程（先保存任务再明确执行）；多模态视频/帧摘要（media-summarize）已接入 MCP 与工作台历史查看。DSH 的宿主视觉选项不代表独立 Core 具有宿主服务。', command: 'vision look / locate / ocr / summarize' }
  ];
  const node = (tag, text, className) => {
    const value = document.createElement(tag); if (text !== undefined) value.textContent = text;
    if (className) value.className = className; return value;
  };
  const INBOX_TYPE_TAG = { 'image/png': 'PNG', 'image/jpeg': 'JPG', 'image/webp': 'WEBP', 'audio/wav': 'WAV', 'audio/mpeg': 'MP3', 'audio/ogg': 'OGG', 'audio/flac': 'FLAC' };
  const formatBytes = bytes => bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / (1024 * 1024)).toFixed(2) + ' MiB';
  let info = null, catalog = null, settings = null, total = null, refreshing = false;
  let inboxData = null, inboxLoading = false, inboxError = '', inboxController = null;
  let outboxData = null, outboxLoading = false, outboxError = '', outboxController = null;
  const errors = { models: '', settings: '', history: '' };
  const operations = () => info?.operations || [];
  const executable = () => operations().includes('runs.continue');
  const candidates = feature => catalog?.models.filter(model => feature.id === 'image' ? !model.capability : model.capability === feature.cap);
  const supported = feature => feature.id === 'image' || feature.modes.length && (feature.id === 'vision' ? info?.vision === true : feature.id === 'video' ? info?.video === true : feature.id === 'music' ? info?.music === true : info?.audio === true);
  function fact(list, title, value) { list.append(node('dt', title), node('dd', value)); }
  function renderInbox() {
    const section = $('#overview-inbox');
    if (!info?.inbox || !operations().includes('inbox.list')) { section.hidden = true; return; }
    section.hidden = false;
    $('#overview-inbox-refresh').disabled = inboxLoading;
    $('#overview-inbox-refresh').textContent = inboxLoading ? '读取中…' : '刷新目录';
    const entries = inboxData?.files || [];
    $('#overview-inbox-count').textContent = inboxError ? '读取失败' : !inboxData ? '读取中…'
      : inboxData.truncated ? (entries.length ? `前 ${entries.length} 个（扫描已截断）` : '扫描已截断')
      : (inboxData.total ?? entries.length) + ' 个可导入';
    const feedbackEl = $('#overview-inbox-feedback');
    if (inboxError) {
      feedbackEl.hidden = false; feedbackEl.classList.add('error');
      feedbackEl.textContent = '收件目录读取失败：' + inboxError;
    } else if (inboxData?.truncated) {
      feedbackEl.hidden = false; feedbackEl.classList.remove('error');
      feedbackEl.textContent = entries.length
        ? `收件目录顶层条目过多，仅扫描了部分条目（当前显示 ${entries.length} 个可导入文件）；建议精简收件目录。`
        : '收件目录顶层条目过多，仅扫描了部分条目，未在已扫描范围内找到符合条件的图片或音频；建议精简收件目录。';
    } else if ((inboxData?.total ?? 0) > entries.length) {
      feedbackEl.hidden = false; feedbackEl.classList.remove('error');
      feedbackEl.textContent = `已显示前 ${entries.length} 个文件（共 ${inboxData.total} 个符合条件）。`;
    } else {
      feedbackEl.hidden = true; feedbackEl.classList.remove('error'); feedbackEl.textContent = '';
    }
    $('#overview-inbox-empty').hidden = inboxLoading || Boolean(inboxError) || !inboxData || Boolean(inboxData.truncated) || entries.length > 0;
    $('#overview-inbox-list').replaceChildren(...entries.map(entry => {
      const row = node('li', undefined, 'inbox-file-row'); row.dataset.inboxName = entry.name; row.dataset.inboxKind = entry.kind;
      const pill = node('span', INBOX_TYPE_TAG[entry.mediaType] || entry.kind.toUpperCase(), 'inbox-kind-pill');
      const meta = node('span', undefined, 'inbox-file-meta');
      const title = node('strong', entry.name); title.title = entry.name;
      const sub = node('small', formatBytes(entry.size) + (entry.kind === 'audio' ? ' · 音频' : ' · 图片'));
      meta.append(title, sub);
      row.append(pill, meta);
      const canImport = operations().includes('inbox.import') && (entry.kind === 'audio'
        ? ['transcriptions.create', 'videos-s2v.create'].some(op => operations().includes(op))
        : ['runs.create', 'videos-i2v.create', 'videos-s2v.create', 'visions.create', 'ocrs.create', 'locates.create'].some(op => operations().includes(op)));
      if (canImport) {
        const button = node('button', '导入并创作', 'secondary'); button.type = 'button'; button.dataset.overviewInboxImport = entry.name;
        button.addEventListener('click', async () => {
          const targetMode = entry.kind === 'audio'
            ? (operations().includes('transcriptions.create') ? 'transcribe' : 'video-s2v')
            : operations().includes('runs.create') ? 'edit'
              : operations().includes('videos-i2v.create') ? 'video-i2v'
                : operations().includes('videos-s2v.create') ? 'video-s2v'
                  : operations().includes('visions.create') ? 'vision'
                    : operations().includes('ocrs.create') ? 'ocr' : 'locate';
          button.disabled = true;
          try { await creation.importFromInbox(entry, { targetMode }); }
          finally { button.disabled = false; }
        });
        row.append(button);
      } else {
        row.append(node('span', '仅浏览', 'overview-action-note'));
      }
      return row;
    }));
  }
  async function loadInbox(ctx = context()) {
    if (!info?.inbox || !operations().includes('inbox.list') || !ctx.client) return;
    inboxController?.abort();
    const controller = inboxController = new AbortController();
    inboxLoading = true; renderInbox();
    try {
      const result = await ctx.client.listInbox({ limit: 50 }, { signal: controller.signal });
      if (!valid(ctx) || inboxController !== controller) return;
      inboxData = result; inboxError = '';
    } catch (error) {
      if (valid(ctx) && inboxController === controller && !controller.signal.aborted) {
        inboxData = null; inboxError = describe(error);
      }
    } finally {
      if (valid(ctx) && inboxController === controller) { inboxLoading = false; renderInbox(); }
    }
  }
  function renderOutbox() {
    const section = $('#overview-outbox');
    if (!info?.outbox) { section.hidden = true; return; }
    section.hidden = false;
    $('#overview-outbox-refresh').disabled = outboxLoading;
    $('#overview-outbox-refresh').textContent = outboxLoading ? '读取中…' : '刷新出件';
    const entries = outboxData?.files || [];
    $('#overview-outbox-count').textContent = outboxError ? '读取失败' : !outboxData ? '读取中…'
      : outboxData.truncated ? (entries.length ? `前 ${entries.length} 个（扫描已截断）` : '扫描已截断')
      : (outboxData.total ?? entries.length) + ' 个已落盘';
    const feedbackEl = $('#overview-outbox-feedback');
    if (outboxError) {
      feedbackEl.hidden = false; feedbackEl.classList.add('error');
      feedbackEl.textContent = '出件目录读取失败：' + outboxError;
    } else if (outboxData?.truncated) {
      feedbackEl.hidden = false; feedbackEl.classList.remove('error');
      feedbackEl.textContent = `出件目录顶层条目过多，仅列出已扫描的前 ${entries.length} 个常规文件。`;
    } else if ((outboxData?.total ?? 0) > entries.length) {
      feedbackEl.hidden = false; feedbackEl.classList.remove('error');
      feedbackEl.textContent = `已显示前 ${entries.length} 个出件文件（共 ${outboxData.total} 个）。`;
    } else {
      feedbackEl.hidden = true; feedbackEl.classList.remove('error'); feedbackEl.textContent = '';
    }
    $('#overview-outbox-empty').hidden = outboxLoading || Boolean(outboxError) || !outboxData || Boolean(outboxData.truncated) || entries.length > 0;
    $('#overview-outbox-list').replaceChildren(...entries.map(entry => {
      const row = node('li', undefined, 'inbox-file-row'); row.dataset.outboxName = entry.name;
      const ext = entry.name.includes('.') ? entry.name.split('.').at(-1).toUpperCase().slice(0, 6) : 'FILE';
      const pill = node('span', ext, 'inbox-kind-pill');
      const meta = node('span', undefined, 'inbox-file-meta');
      const title = node('strong', entry.name); title.title = entry.name;
      const sub = node('small', formatBytes(entry.bytes ?? entry.size) + ((entry.updatedAt || entry.modifiedAt) ? ' · ' + date(entry.updatedAt || entry.modifiedAt) : ''));
      meta.append(title, sub);
      row.append(pill, meta, node('span', '已落盘', 'overview-action-note'));
      return row;
    }));
  }
  async function loadOutbox(ctx = context()) {
    if (!info?.outbox || !ctx.client) return;
    outboxController?.abort();
    const controller = outboxController = new AbortController();
    outboxLoading = true; renderOutbox();
    try {
      const result = await ctx.client.listOutboxFiles({ limit: 50 }, { signal: controller.signal });
      if (!valid(ctx) || outboxController !== controller) return;
      outboxData = result; outboxError = '';
    } catch (error) {
      if (valid(ctx) && outboxController === controller && !controller.signal.aborted) {
        outboxData = null; outboxError = describe(error);
      }
    } finally {
      if (valid(ctx) && outboxController === controller) { outboxLoading = false; renderOutbox(); }
    }
  }
  function card(feature, index) {
    const article = node('article', undefined, 'overview-capability card'); article.dataset.overviewCapability = feature.id; article.dataset.providerTone = String(index);
    const heading = node('div', undefined, 'overview-capability-heading'), mark = node('span', undefined, 'overview-capability-icon');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS(svg.namespaceURI, 'path');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); path.setAttribute('d', feature.icon); svg.append(path); mark.append(svg);
    heading.append(mark, node('h3', feature.title), node('span', supported(feature) ? '面板已接入' : feature.modes.length ? feature.id === 'vision' ? '需视觉工作区' : feature.id === 'video' ? '需视频工作区' : '需音频工作区' : 'CLI / DSH', 'overview-entry'));
    article.append(heading, node('p', feature.subtitle, 'overview-capability-description'));
    const declared = settings?.providers.flatMap(provider => provider.models.filter(model => model.capabilities.includes(feature.cap)));
    const policy = settings?.assignments[feature.cap], values = candidates(feature);
    const workspaceKind = feature.id === 'vision' ? '视觉' : feature.id === 'video' ? '视频' : '音频';
    const config = errors.settings ? '配置读取失败，未作判断' : settings
      ? declared.length + ' 个已标注 · ' + ({ auto: '自动选择', manual: '手动排序', disabled: '功能已停用' })[policy.mode]
      : info.providerManagement ? '读取已保存配置…' : !feature.modes.length ? '当前会话未提供配置详情' : !supported(feature) ? '当前工作区未提供' + workspaceKind + '候选'
        : errors.models ? '候选读取失败' : !catalog ? '读取模型候选…' : !catalog.configured ? '未指定配置' : values.length + ' 个候选';
    const facts = node('dl', undefined, 'overview-capability-facts'); fact(facts, '配置', config);
    if (feature.modes.length && info.providerManagement) fact(facts, '候选', errors.models ? '读取失败，未作判断'
      : !catalog ? '读取中…' : !supported(feature) ? '此工作区未接入' + workspaceKind + '流程' : values.length + ' 个当前候选');
    const records = declared?.map(model => model.verified[feature.cap]).filter(Boolean), passed = records?.filter(record => record.ok).length;
    const evidence = errors.settings ? '记录读取失败' : !settings ? info.providerManagement ? '读取实测记录…' : '当前会话未提供记录'
      : !records.length ? '尚无实测记录' : passed + ' 通过 · ' + (records.length - passed) + ' 未通过';
    fact(facts, '历史实测', evidence); article.append(facts);
    const actions = node('div', undefined, 'overview-capability-actions');
    if (supported(feature) && executable()) {
      for (const [mode, label, operation] of feature.modes) {
        const action = node('button', label, 'secondary'); action.type = 'button'; action.dataset.overviewCreate = mode;
        const count = values?.filter(model => mode === 'edit' ? model.supportsImageEdit
          : mode === 'video' ? (!model.videoModes || model.videoModes.includes('t2v'))
          : mode === 'video-i2v' ? model.videoModes?.includes('i2v')
          : mode === 'video-s2v' ? model.videoModes?.includes('s2v') : true).length;
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
    state.append(node('span', (info.vision ? '图片、视频、语音、音乐、转写与视觉工作区' : info.video ? '图片、视频、语音、音乐与转写工作区' : info.audio ? '图片、语音、音乐与转写工作区' : '图片工作区') + (info.inbox ? ' · 已接入只读收件目录' : '') + (info.outbox ? ' · 已启用受控出件' : ''), 'overview-stat-note')); stats.append(state);
    const models = node('div'); fact(models, '创作候选', errors.models ? '读取失败' : !catalog ? '读取中…' : !catalog.configured ? '未指定配置' : new Set(catalog.models.map(model => model.modelRef)).size + ' 个');
    models.append(node('span', info.vision ? '图片/视频/语音/音乐/转写/视觉，按模型去重' : info.video ? '图片/视频/语音/音乐/转写，按模型去重' : info.audio ? '图片/语音/音乐/转写，按模型去重' : '图片候选，按模型去重', 'overview-stat-note')); stats.append(models);
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
    renderInbox();
    renderOutbox();
  }
  $('#overview-create').addEventListener('click', () => {
    if (!executable()) tab();
    else if (catalog && !catalog.models.length && info.providerManagement) tab('providers');
    else creation.beginDraft();
  });
  $('#overview-gallery').addEventListener('click', () => tab('gallery'));
  $('#overview-inbox-refresh').addEventListener('click', () => { void loadInbox(); });
  $('#overview-outbox-refresh').addEventListener('click', () => { void loadOutbox(); });
  $('#overview-refresh').addEventListener('click', async () => {
    if (refreshing || !info) return;
    const ctx = context(); refreshing = true; render();
    try {
      await Promise.all([loadModels(ctx), loadHistory(ctx, false, false), ...(info.inbox && operations().includes('inbox.list') ? [loadInbox(ctx)] : []), ...(info.outbox ? [loadOutbox(ctx)] : []), ...(info.providerManagement ? [(async () => {
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
    connect(session) { info = session; catalog = settings = null; total = null; inboxData = null; inboxLoading = false; inboxError = ''; inboxController?.abort(); inboxController = null; outboxData = null; outboxLoading = false; outboxError = ''; outboxController?.abort(); outboxController = null; for (const key of Object.keys(errors)) errors[key] = ''; render(); },
    loadInbox,
    loadOutbox,
    setModels(value, error = '') { catalog = value; errors.models = error; render(); },
    setSettings(value, error = '') { settings = value; errors.settings = error; render(); },
    setHistory(value, error = '') { total = value; errors.history = error; render(); },
    disconnect() { inboxController?.abort(); inboxController = null; inboxData = null; inboxLoading = false; inboxError = ''; outboxController?.abort(); outboxController = null; outboxData = null; outboxLoading = false; outboxError = ''; info = catalog = settings = null; total = null; refreshing = false; $('#overview-panel').hidden = true; $('#overview-inbox').hidden = true; $('#overview-inbox-list').replaceChildren(); $('#overview-inbox-feedback').hidden = true; $('#overview-inbox-empty').hidden = true; $('#overview-outbox').hidden = true; $('#overview-outbox-list').replaceChildren(); $('#overview-outbox-feedback').hidden = true; $('#overview-outbox-empty').hidden = true; $('#overview-capabilities').replaceChildren(); $('#overview-stats').replaceChildren(); $('#overview-feedback').hidden = true; }
  });
}

function renderHistory() {
  $('#history-count').textContent = String(historyTotal);
  $('#history-empty').hidden = runs.length !== 0;
  $('#history-list').replaceChildren(...runs.map((run, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'history-item';
    button.dataset.runId = run.id; button.setAttribute('aria-current', run.id === current?.id ? 'true' : 'false');
    const title = document.createElement('strong'); title.textContent = (audioRun(run) || videoRun(run) || visionRun(run) ? recipeLabel(run.recipe) : '图片流程') + ' · ' + date(run.createdAt);
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
  key.textContent = label;
  if (/^(?:run|artifact|task)_[a-f0-9]{24}$/.test(String(value || ''))) {
    const wrap = document.createElement('span');
    wrap.className = 'fact-value-row';
    const text = document.createElement('span');
    text.textContent = value;
    wrap.append(text, createCopyIdButton(value, { onStatus: (msg, err) => feedback(msg, Boolean(err)) }));
    item.append(wrap);
  } else {
    item.textContent = value;
  }
  $('#run-facts').append(key, item);
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
async function loadVisionText(ctx, ticket, artifactId, signal) {
  if (!artifactId) return;
  try {
    const blob = await ctx.client.get('/api/v0/artifacts/' + artifactId + '/vision-text', { binary: true, signal });
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
    if (!valid(ctx) || ticket !== runTicket || signal.aborted) return;
    $('#vision-text-result').textContent = text; $('#vision-text-result').hidden = false;
    $('#vision-result-note').textContent = '读取原文字完成；未调用模型。';
    return { id: artifactId, mediaType: 'text/plain', label: '图片识别文字', route: 'vision-text' };
  } catch (error) {
    if (valid(ctx) && ticket === runTicket && !signal.aborted) $('#vision-result-note').textContent = '文字读取失败：' + describe(error);
  }
}
const LOCATE_CROP_INPUTS = [['left', 'locate-crop-left'], ['top', 'locate-crop-top'], ['width', 'locate-crop-width'], ['height', 'locate-crop-height']];
function syncLocateCropInputs(rect) {
  if (!rect) return;
  for (const [key, id] of LOCATE_CROP_INPUTS) $('#' + id).value = String(rect[key]);
}
function locateCropFeedback(text = '', error = false) {
  const el = $('#locate-crop-feedback');
  el.hidden = !text; el.textContent = text; el.classList.toggle('error', error);
}
function renderLocateVisual() {
  if (!locateState) return;
  const { imageWidth, imageHeight, result, resultError, presentation, showBox, showScrim, cropping, cropped } = locateState;
  const spec = buildLocateOverlaySpec({ imageWidth, imageHeight, result, cropRect: locateState.cropRect, showBox, showScrim });
  renderLocateSvg($('#locate-overlay'), spec, { maskId: 'locate-scrim-mask' });
  if ($('#image-dialog').open && locateState.sourceUrl && $('#expanded-image').src === locateState.sourceUrl) {
    renderLocateSvg($('#expanded-overlay'), spec, { maskId: 'expanded-scrim-mask' });
  }
  const hasOverlay = spec.reason === 'ok';
  if (hasOverlay && !locateState.cropRect) {
    locateState.cropRect = result.bbox;
    syncLocateCropInputs(locateState.cropRect);
  }
  const { cropRect } = locateState;
  $('#locate-toggles').hidden = !hasOverlay;
  if (hasOverlay) {
    $('#locate-toggle-box').setAttribute('aria-pressed', String(showBox));
    $('#locate-toggle-box').textContent = showBox ? '隐藏定位框' : '显示定位框';
    $('#locate-toggle-scrim').setAttribute('aria-pressed', String(showScrim));
    $('#locate-toggle-scrim').disabled = !showBox;
  }
  const badge = $('#locate-badge'), note = $('#vision-result-note');
  if (resultError) {
    badge.textContent = '定位结果读取失败';
    note.textContent = resultError;
  } else if (!result) {
    badge.textContent = current.output ? '读取定位坐标中…' : presentation.title;
    note.textContent = current.output ? '正在读取原图与定位坐标…' : presentation.message;
  } else if (result.found !== true) {
    badge.textContent = `未找到目标 · 原图 ${result.width} × ${result.height}`;
    note.textContent = '模型判定未找到目标。';
  } else if (spec.reason === 'dimension_mismatch') {
    badge.textContent = '定位坐标与图片预览不匹配';
    note.textContent = '请核对原图方向和尺寸。可展开查看或下载原始定位坐标。';
  } else {
    const box = result.bbox;
    badge.textContent = `(${box.left}, ${box.top}) · ${box.width} × ${box.height} px / 原图 ${result.width} × ${result.height}`;
    note.textContent = '';
  }
  const canCrop = hasOverlay && Boolean(locateState.sourceArtifactId) && capabilities.includes('local-media.crop');
  const canRetryLocate = current.status === 'ready' && Boolean(result && locateState.sourceArtifactId) && capabilities.includes('locates.create');
  const needsPreview = Boolean(cropped && !cropped.url);
  const savedSelection = needsPreview && isSameCropRect(cropped.rect, cropRect);
  $('#locate-crop-button').hidden = !canCrop;
  $('#locate-crop-button').disabled = !canCrop || cropping || savedSelection;
  $('#locate-crop-button').textContent = savedSelection ? '裁剪区域已保存' : cropping ? '正在本地处理…'
    : spec.customCrop ? '按微调区域裁剪（零计费）' : '按定位框裁剪（零计费）';
  $('#locate-retry-target').hidden = !canRetryLocate;
  $('#locate-retry-target').disabled = cropping;
  $('#locate-actions').hidden = !canCrop && !canRetryLocate;
  $('#locate-crop-adjust').hidden = !canCrop;
  if (canCrop && cropRect) {
    $('#locate-crop-left').max = String(result.width - 1);
    $('#locate-crop-top').max = String(result.height - 1);
    $('#locate-crop-width').max = String(result.width);
    $('#locate-crop-height').max = String(result.height);
    $('#locate-crop-summary').textContent = spec.customCrop
      ? `已微调 · (${cropRect.left}, ${cropRect.top}) ${cropRect.width} × ${cropRect.height} px`
      : `模型定位框 · ${cropRect.width} × ${cropRect.height} px`;
    $('#locate-crop-reset').disabled = cropping || !spec.customCrop;
  }
  $('#locate-crop-result').hidden = !cropped;
  if (cropped) {
    const preview = $('#locate-crop-image');
    preview.hidden = needsPreview;
    if (cropped.url) preview.src = cropped.url;
    else preview.removeAttribute('src');
    $('#locate-crop-reload').hidden = !needsPreview;
    $('#locate-crop-reload').disabled = cropping;
    $('#locate-crop-download').disabled = needsPreview;
    $('#locate-crop-dimensions').textContent = `${cropped.width} × ${cropped.height} px · ${cropped.artifactId} · PNG（已保存在当前工作区）`;
    $('#locate-crop-use-edit').hidden = !capabilities.includes('runs.create');
    $('#locate-crop-use-i2v').hidden = !videoEnabled || !capabilities.includes('videos-i2v.create');
    $('#locate-crop-use-vision').hidden = !visionEnabled || !capabilities.includes('visions.create');
    $('#locate-crop-use-ocr').hidden = !visionEnabled || !capabilities.includes('ocrs.create');
    $('#locate-crop-use-locate').hidden = !visionEnabled || !capabilities.includes('locates.create');
  }
}
async function loadLocateSource(ctx, ticket, artifactId, signal) {
  const placeholder = $('#locate-source-placeholder');
  placeholder.hidden = false; placeholder.textContent = artifactId ? '读取原图中…' : '原图不可用';
  if (!artifactId) return;
  try {
    const blob = await ctx.client.get('/api/v0/artifacts/' + artifactId + '/content', { binary: true, signal });
    if (!valid(ctx) || ticket !== runTicket || signal.aborted || !locateState) return;
    const url = URL.createObjectURL(blob); urls.add(url);
    const image = $('#locate-source-image'); image.src = url;
    await image.decode();
    if (!valid(ctx) || ticket !== runTicket || signal.aborted || !locateState) return;
    locateState.sourceBlob = blob;
    locateState.sourceUrl = url;
    locateState.imageWidth = image.naturalWidth;
    locateState.imageHeight = image.naturalHeight;
    $('#locate-stage-frame').hidden = false;
    placeholder.hidden = true;
    $('#locate-dimensions').textContent = `预览 ${image.naturalWidth} × ${image.naturalHeight} px · 点击图片放大查看`;
    creation.source(url);
    renderLocateVisual();
    return { id: artifactId, mediaType: blob.type.split(';')[0], label: '定位原图' };
  } catch (error) {
    if (valid(ctx) && ticket === runTicket && !signal.aborted) placeholder.textContent = '原图读取失败。' + describe(error);
  }
}
async function loadLocateResult(ctx, ticket, artifactId, signal) {
  if (!artifactId) return;
  try {
    const result = await ctx.client.get('/api/v0/artifacts/' + artifactId + '/locate-result', { signal });
    if (!valid(ctx) || ticket !== runTicket || signal.aborted || !locateState) return;
    locateState.result = result;
    $('#locate-json-result').textContent = JSON.stringify(result, null, 2);
    $('#locate-json-details').hidden = false;
    renderLocateVisual();
    return { id: artifactId, mediaType: 'application/json', label: '视觉定位结果', route: 'locate-result' };
  } catch (error) {
    if (valid(ctx) && ticket === runTicket && !signal.aborted && locateState) {
      locateState.resultError = describe(error);
      renderLocateVisual();
    }
  }
}
async function runLocateCrop({ previewOnly = false } = {}) {
  const state = locateState;
  if (!state || state.cropping || !client) return;
  const { sourceArtifactId, cropRect: rect } = state;
  let savedCrop = previewOnly ? state.cropped : null;
  if (previewOnly ? !savedCrop || savedCrop.url : $('#locate-crop-button').disabled) return;
  if (!previewOnly) syncLocateCropInputs(rect);
  const controller = locateCropController = new AbortController();
  const ctx = context(), ticket = runTicket;
  const active = () => valid(ctx) && ticket === runTicket && locateState === state && !controller.signal.aborted;
  state.cropping = true;
  locateCropFeedback(previewOnly ? '正在读取已保存的裁剪图…' : '正在按坐标本地裁剪（零外部计费）…');
  renderLocateVisual();
  try {
    if (!savedCrop) {
      const response = await ctx.client.cropImage({
        artifactId: sourceArtifactId, left: rect.left, top: rect.top, width: rect.width, height: rect.height
      }, { signal: controller.signal });
      if (!active()) return;
      const artifact = response.artifact;
      if (response.contractVersion !== 0 || typeof artifact?.artifactId !== 'string') throw new TypeError('不支持的本地裁剪响应');
      if (state.cropped?.url) { URL.revokeObjectURL(state.cropped.url); urls.delete(state.cropped.url); }
      savedCrop = state.cropped = { artifactId: artifact.artifactId, width: artifact.width, height: artifact.height, rect, blob: null, url: null };
      locateCropFeedback('裁剪已保存，正在读取预览…');
      renderLocateVisual();
    }
    const blob = await ctx.client.get('/api/v0/artifacts/' + savedCrop.artifactId + '/content', { binary: true, signal: controller.signal });
    if (!active()) return;
    savedCrop.blob = blob;
    savedCrop.url = URL.createObjectURL(blob); urls.add(savedCrop.url);
    locateCropFeedback('裁剪图已载入。');
  } catch (error) {
    if (active()) locateCropFeedback((savedCrop ? '裁剪已保存，预览读取失败。' : '本地裁剪失败。') + describe(error), true);
  } finally {
    if (locateCropController === controller) locateCropController = null;
    if (active()) { state.cropping = false; renderLocateVisual(); }
  }
}
function downloadCroppedImage() {
  const cropped = locateState?.cropped;
  if (!cropped?.blob || !/^artifact_[a-f0-9]{24}$/.test(cropped.artifactId)) return;
  const link = document.createElement('a');
  link.href = cropped.url;
  link.download = 'iris-' + cropped.artifactId + '.png';
  link.click();
  locateCropFeedback('裁剪 PNG 下载请求已交给浏览器。');
}
function handoffCroppedImage(targetMode) {
  const cropped = locateState?.cropped;
  if (!cropped?.artifactId) return;
  const required = { edit: 'runs.create', 'video-i2v': 'videos-i2v.create', vision: 'visions.create', ocr: 'ocrs.create', locate: 'locates.create' }[targetMode];
  if (!required || !capabilities.includes(required)) return;
  const modelRef = ['vision', 'ocr', 'locate'].includes(targetMode) ? locateState.modelRef : '';
  creation.beginDraft({
    file: cropped.blob,
    artifactId: cropped.artifactId,
    mode: targetMode,
    label: `定位裁剪图 · ${cropped.width} × ${cropped.height}`,
    modelRef
  });
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
async function loadVideoMedia(ctx, ticket, artifactId, signal) {
  $('#video-result-note').textContent = artifactId ? '正在读取原视频…' : '明确执行后，原任务的视频会保存在这里。';
  if (!artifactId) return;
  try {
    const blob = await ctx.client.get('/api/v0/artifacts/' + artifactId + '/video', { binary: true, signal });
    if (!valid(ctx) || ticket !== runTicket || signal.aborted) return;
    if (!['video/mp4', 'video/webm'].includes(blob.type) || blob.size > 32 * 1024 * 1024) throw new TypeError('不支持的视频格式或大小');
    const url = URL.createObjectURL(blob); urls.add(url);
    $('#output-video').src = url; $('#output-video').hidden = false;
    $('#video-result-note').textContent = '原视频已载入。点击播放或下载；播放器支持取决于当前浏览器。';
    return { id: artifactId, artifactId, mediaType: blob.type, label: '生成视频' };
  } catch (error) { if (valid(ctx) && ticket === runTicket && !signal.aborted) $('#video-result-note').textContent = '视频读取失败：' + describe(error); }
}
async function loadVideoSources(ctx, ticket, view, signal) {
  const firstFrameId = view.recipe === 'video-i2v/v0' ? view.source?.artifactId
    : view.recipe === 'video-s2v/v0' ? view.sources?.[0]?.artifactId : null;
  const drivingAudioId = view.recipe === 'video-s2v/v0' ? view.sources?.[1]?.artifactId : null;
  if (!firstFrameId && !drivingAudioId) return;
  const jobs = [];
  if (firstFrameId) {
    jobs.push(ctx.client.get('/api/v0/artifacts/' + firstFrameId + '/content', { binary: true, signal }).then(blob => {
      if (!valid(ctx) || ticket !== runTicket || signal.aborted) return;
      const url = URL.createObjectURL(blob); urls.add(url);
      $('#video-source-image').src = url;
      $('#video-source-image-wrap').hidden = false;
      $('#video-sources-preview').hidden = false;
      creation.source(url);
    }).catch(() => {}));
  }
  if (drivingAudioId) {
    jobs.push(ctx.client.get('/api/v0/artifacts/' + drivingAudioId + '/audio', { binary: true, signal }).then(blob => {
      if (!valid(ctx) || ticket !== runTicket || signal.aborted) return;
      const url = URL.createObjectURL(blob); urls.add(url);
      $('#video-source-audio').src = url;
      $('#video-source-audio-wrap').hidden = false;
      $('#video-sources-preview').hidden = false;
      creation.sourceAudio(url);
    }).catch(() => {}));
  }
  await Promise.all(jobs);
}
async function loadRun(id, { fromAction = false } = {}) {
  const ctx = context(); if (!ctx.client || !RUN.test(id)) return;
  if (!fromAction) creation.cancelChain();
  creation.loading();
  tab(); const sameRun = current?.id === id;
  const savedCrop = sameRun ? locateState?.cropped : null;
  const savedCropRect = sameRun && locateState?.cropRect ? { ...locateState.cropRect } : null;
  const ticket = ++runTicket;
  current = null; releaseMedia(); runController = new AbortController();
  const signal = runController.signal;
  $('#run-view').hidden = true; $('#viewer-empty').hidden = false;
  $('#viewer-empty h2').textContent = '正在读取流程…'; $('#viewer').setAttribute('aria-busy', 'true');
  $('#download').disabled = true; feedback('');
  try {
    const view = await ctx.client.get('/api/v0/runs/' + id, { signal });
    if (!valid(ctx) || ticket !== runTicket) return;
    const presentation = presentFlow(view, capabilities), isAudio = audioRun(view), isMusic = musicRun(view), isVideo = videoRun(view), isVision = visionRun(view), isLocate = view.recipe === 'locate/v0', isSummarize = view.recipe === 'summarize/v0'; current = view;
    history.replaceState(null, '', '#' + view.id); renderHistory();
    $('#status-title').textContent = presentation.title; $('#status-message').textContent = presentation.message;
    $('#run-view').dataset.tone = presentation.tone;
    $('#run-view').dataset.hasOutput = String(Boolean(view.output));
    $('#run-view').dataset.recipe = view.recipe; $('#source-card').hidden = !view.source; $('#view-modes').hidden = isAudio || isVideo || isVision || !view.source;
    $('#prompt-title').textContent = isLocate ? '定位目标' : isSummarize ? '摘要要求' : isVision ? view.recipe === 'vision/v0' ? '看图问题' : 'OCR 设置' : isMusic ? '音乐描述' : view.recipe === 'video-s2v/v0' ? '数字人驱动输入' : view.recipe === 'video-i2v/v0' ? '图生视频描述' : isAudio ? view.recipe === 'speech/v0' ? '朗读内容' : '转写来源' : view.source ? '修改要求' : '画面描述';
    $('[data-view="overlay"]').disabled = !view.source || !view.output; if (!sameRun || !view.output || !view.source) setView('pair');
    if (isAudio || isVideo || isVision) { $('#image-pair').hidden = true; $('#overlay-view').hidden = true; }
    $('#vision-result').hidden = !isVision; $('#vision-text-result').hidden = true; $('#vision-text-result').textContent = '';
    $('#vision-result-eyebrow').textContent = isLocate ? 'VISUAL GROUNDING' : isSummarize ? 'MEDIA SUMMARY' : 'VISION / OCR';
    $('#vision-result-heading').textContent = isLocate ? view.input.target : isSummarize ? '多模态摘要' : '图片里的信息';
    $('#locate-visual').hidden = !isLocate;
    if (isLocate) {
      const cropUrl = savedCrop?.blob ? URL.createObjectURL(savedCrop.blob) : null;
      if (cropUrl) urls.add(cropUrl);
      locateState = {
        presentation, modelRef: view.input.modelRef, target: view.input.target,
        sourceArtifactId: view.source?.artifactId || null, sourceBlob: null, sourceUrl: null,
        imageWidth: 0, imageHeight: 0, result: null, resultError: '', cropRect: savedCropRect,
        showBox: true, showScrim: true, cropping: false, cropped: savedCrop ? { ...savedCrop, url: cropUrl } : null
      };
      if (savedCropRect) syncLocateCropInputs(savedCropRect);
      renderLocateVisual();
    } else {
      $('#vision-result-note').textContent = view.output ? '正在读取原文字…' : '尚未保存可用文字。';
    }
    $('#audio-result').hidden = !isAudio; $('#video-result').hidden = !isVideo; $('#reuse-selected').hidden = isAudio || isVideo || isVision;
    hideExtraReuseActions();
    if (!isAudio && !isVideo && !isVision && view.selection) {
      const imageReuseGates = {
        'video-i2v': videoEnabled && capabilities.includes('videos-i2v.create'),
        'video-s2v': videoEnabled && capabilities.includes('videos-s2v.create'),
        vision: visionEnabled && capabilities.includes('visions.create'),
        ocr: visionEnabled && capabilities.includes('ocrs.create'),
        locate: visionEnabled && capabilities.includes('locates.create')
      };
      for (const button of document.querySelectorAll('[data-reuse-image]')) {
        button.hidden = !imageReuseGates[button.dataset.reuseImage];
      }
      $('#reuse-selected-crop').hidden = !capabilities.includes('local-media.crop');
    } else if (isAudio && view.recipe !== 'transcribe/v0' && view.output) {
      $('#reuse-audio-s2v').hidden = !(videoEnabled && capabilities.includes('videos-s2v.create'));
      $('#reuse-audio-mux').hidden = !(videoEnabled && audioEnabled && capabilities.includes('local-media.mux'));
      $('#reuse-audio-transcribe').hidden = !(audioEnabled && capabilities.includes('transcriptions.create'));
    } else if (isVideo && view.output) {
      $('#reuse-video-mux').hidden = !(videoEnabled && audioEnabled && capabilities.includes('local-media.mux'));
    }
    const canRetryMusic = isMusic && capabilities.includes('music.create')
      && Boolean(view.task) && ['needs_attention', 'ready'].includes(view.status);
    $('#retry-music-draft').hidden = !canRetryMusic;
    if (isVideo && view.output && capabilities.includes('local-media.frames')) {
      videoFrames.show({
        client: ctx.client,
        artifactId: view.output.artifactId,
        canSummarize: capabilities.includes('summaries.create'),
        canI2v: videoEnabled && capabilities.includes('videos-i2v.create'),
        canEdit: capabilities.includes('runs.create'),
        canS2v: videoEnabled && capabilities.includes('videos-s2v.create'),
        canCrop: capabilities.includes('local-media.crop')
      });
    }
    $('.canvas-label').textContent = isSummarize ? '视频摘要' : isLocate ? '视觉定位' : isVision ? '图片信息' : isVideo ? '动态工作台' : isMusic ? '音乐工作台' : isAudio ? '声音工作台' : '创作画布';
    $('#audio-result-kind').textContent = isMusic ? 'MUSIC' : view.recipe === 'speech/v0' ? 'VOICE' : 'TRANSCRIPT';
    $('#audio-result-title').textContent = isMusic ? '让旋律留下来' : view.recipe === 'speech/v0' ? '让文字有声音' : '声音里的文字';
    $('#audio-output-label').textContent = isMusic ? '生成音乐' : '合成语音';
    $('#audio-result-note').textContent = view.output ? '作品已保存；点击播放或下载即可使用。' : '明确执行后，原任务的结果会保存在这里。';
    $('#operation-note').hidden = true;
    $('#selection-feedback').textContent = isVideo ? view.output ? '视频已保存，可以播放或下载原件。' : '原任务结果尚未保存。' : isMusic ? view.output ? '音乐已保存，可以试听、下载，或基于原描述新建重试草稿。' : '原任务结果尚未保存；单次有限提交不自动重试 502。' : isAudio ? view.output ? view.recipe === 'speech/v0' ? '音频已保存，可以试听或下载。' : '转写已保存，可下载 UTF-8 文本。' : '结果尚未保存。'
      : view.selection ? '当前选择已记录，可以下载原始图片。' : capabilities.includes('runs.select')
      ? '选择喜欢的版本，再保存到设备。' : '当前未开启选择权限；已有选择仍可下载。';
    $('#run-meta').textContent = view.input.modelRef + ' · ' + date(view.createdAt);
    $('#prompt').textContent = isLocate ? view.input.target
      : isSummarize ? [view.input.question || '默认多模态视频/帧摘要', view.input.transcript ? `附带字幕/转写（${view.input.transcript.length} 字符）` : ''].filter(Boolean).join('\n\n')
      : isVision ? view.input.question || `块高 ${view.input.chunkHeight}，重叠 ${view.input.overlap}，最多调用 ${view.input.maxInvocations} 次`
      : isMusic ? view.input.prompt
      : view.recipe === 'video-s2v/v0' ? '使用此流程已保存的首帧图片与驱动音频。'
      : view.recipe === 'video-i2v/v0' ? (view.input.prompt || '未填写动作描述（仅首帧驱动）。')
      : isAudio ? view.input.text || '使用此流程已保存的原音频。' : view.input.prompt;
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
    $('#download').disabled = isAudio || isVideo || isVision ? !view.output : !view.selection;
    $('#download').textContent = isLocate ? '下载定位 JSON' : isVision ? '下载文字' : isVideo ? '下载视频' : isMusic ? '下载音乐' : isAudio ? view.recipe === 'speech/v0' ? '下载音频' : '下载文字' : '下载已选作品';
    $('#run-details .muted').hidden = isAudio || isVideo || isVision;
    if (isVision) $('#selection-feedback').textContent = view.output ? isLocate ? '定位坐标已保存，可下载 UTF-8 JSON。' : view.ocr?.status === 'partial' ? '部分文字已保存，请核对缺块。' : '原文字已保存，可下载 UTF-8 文本。' : isLocate ? '原任务定位结果尚未保存。' : '原任务文字尚未保存。';
    $('#run-facts').replaceChildren(); if (!sameRun) $('#run-details').open = false;
    creation.view(view, { sameRun });
    runLineage.setRun(view.id, { sameRun });
    addFact('流程', view.id); addFact('版本', String(view.revision)); addFact('保存时间', date(view.updatedAt));
    addFact('类型', recipeLabel(view.recipe));
    if (view.plan) addFact('OCR 计划', view.plan.totalChunks + ' 块');
    if (view.ocr) addFact('OCR 完成度', `${view.ocr.successfulChunks}/${view.ocr.totalChunks} 块；实际调用 ${view.ocr.invocations} 次`);
    if (view.locate) addFact('定位结果', view.locate.found ? `已找到 · (${view.locate.bbox.left}, ${view.locate.bbox.top}) ${view.locate.bbox.width} × ${view.locate.bbox.height} px` : '未找到目标');
    if (view.recipe === 'video-s2v/v0' && Array.isArray(view.sources) && view.sources.length === 2) {
      addFact('首帧图片', view.sources[0].artifactId);
      addFact('驱动音频', view.sources[1].artifactId);
    } else if (Array.isArray(view.sources) && view.sources.length) addFact('来源帧数', view.sources.length + ' 帧');
    if (view.ocr?.deduplication && (view.ocr.deduplication.appliedSeams || view.ocr.deduplication.ambiguousSeams)) {
      const dedup = view.ocr.deduplication;
      addFact('重叠去重', [
        dedup.appliedSeams ? `合并 ${dedup.appliedSeams} 处边界（移除 ${dedup.removedLines} 行 / ${dedup.removedChars} 字符）` : '',
        dedup.ambiguousSeams ? `保留 ${dedup.ambiguousSeams} 处歧义边界` : ''
      ].filter(Boolean).join('；'));
    }
    if (view.input.voice) addFact('音色', view.input.voice);
    if (view.input.duration !== undefined) addFact('时长', String(view.input.duration) + ' 秒');
    if (isVideo && view.input.size) addFact('尺寸', view.input.size);
    if (isVideo && view.input.resolution) addFact('分辨率', view.input.resolution);
    if (isMusic && view.input.timeoutMs !== undefined) addFact('单次超时', String(view.input.timeoutMs) + ' ms');
    if (view.retriedFrom) addFact('重试自流程', view.retriedFrom.runId);
    if (view.source) addFact(view.recipe === 'transcribe/v0' ? '原音频' : view.recipe === 'video-i2v/v0' ? '首帧图片' : '原图', view.source.artifactId); addFact('结果', view.output?.artifactId || '尚未保存');
    addFact('原任务', view.task?.id || '尚未创建');
    const route = view.task?.networkRoutes?.reduce((latest, value) => !latest || value.lastAt > latest.lastAt ? value : latest, null);
    if (view.task) addFact('最近记录的出口', route ? [route.route === 'proxy' ? '出口池 ' + route.poolId + ' / ' + route.nodeId : route.route === 'direct' ? '明确直连' : '继承环境',
      ({ discover: '目录检查', prepareInput: '输入准备', submit: '提交', poll: '查询', download: '交付', cancel: '取消', vision: '视觉' })[route.operation], date(route.lastAt)].join(' · ') : '未记录');
    if (view.metrics) addFact('像素差异', (view.metrics.ratio * 100).toFixed(2) + '%');
    $('#viewer-empty').hidden = true; $('#run-view').hidden = false;
    const previewArtifacts = await Promise.all(isLocate ? [loadLocateSource(ctx, ticket, view.source?.artifactId, signal), loadLocateResult(ctx, ticket, view.output?.artifactId, signal)] : isVision ? [loadVisionText(ctx, ticket, view.output?.artifactId, signal)] : isVideo ? [loadVideoMedia(ctx, ticket, view.output?.artifactId, signal), loadVideoSources(ctx, ticket, view, signal)] : isMusic ? [loadAudioMedia(ctx, ticket, 'output', view.output?.artifactId, signal)] : isAudio ? [loadAudioMedia(ctx, ticket, 'source', view.source?.artifactId, signal),
      loadAudioMedia(ctx, ticket, view.recipe === 'speech/v0' ? 'output' : 'transcript', view.output?.artifactId, signal)]
      : [loadMedia(ctx, ticket, 'source', view.source?.artifactId, signal), loadMedia(ctx, ticket, 'output', view.output?.artifactId, signal)]);
    if (valid(ctx) && ticket === runTicket && !signal.aborted) {
      const validPreviews = previewArtifacts.filter(item => item && item.id);
      plugins?.previewArtifacts(validPreviews, view.selection?.artifactId || view.output?.artifactId);
      const exportArtifactId = isAudio || isVideo || isVision ? view.output?.artifactId : view.selection?.artifactId;
      const exportEntry = exportArtifactId ? validPreviews.find(item => item.id === exportArtifactId) : null;
      runOutbox.setTarget(exportEntry ? { artifactId: exportEntry.id, mediaType: exportEntry.mediaType } : null);
    }
  } catch (error) {
    if (valid(ctx) && ticket === runTicket && !signal.aborted) {
      runLineage.setRun(null);
      $('#viewer-empty h2').textContent = '暂时无法读取此流程'; feedback(describe(error), true);
    }
  } finally { if (valid(ctx) && ticket === runTicket) $('#viewer').setAttribute('aria-busy', 'false'); }
}
async function download() {
  if (!(audioRun(current) || videoRun(current) || visionRun(current) ? current?.output : current?.selection) || $('#download').disabled) return;
  const ctx = context(), id = current.id, ticket = runTicket;
  $('#download').disabled = true; feedback('正在读取作品…');
  try {
    const { blob, filename } = await ctx.client.get('/api/v0/runs/' + id + '/download', { download: true });
    if (!valid(ctx) || ticket !== runTicket) return;
    const url = URL.createObjectURL(blob); urls.add(url);
    const link = document.createElement('a'); link.href = url;
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'text/plain': 'txt', 'application/json': 'json', 'video/mp4': 'mp4', 'video/webm': 'webm' }[blob.type];
    if (!extension) throw new TypeError('不支持的下载格式');
    // The CLI may have changed the selection since this view was loaded. Use the server's
    // filename, which identifies the exact artifact returned by this download request.
    if (!/^iris-artifact_[a-f0-9]{24}\.(?:png|jpg|webp|wav|mp3|ogg|flac|txt|json|mp4|webm)$/.test(filename)) throw new TypeError('不支持的下载文件名');
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
$('#retry-music-draft').addEventListener('click', () => {
  if (!current || current.recipe !== 'music/v0' || !capabilities.includes('music.create')
      || !current.task || !['needs_attention', 'ready'].includes(current.status)) return;
  creation.beginDraft({
    mode: 'music',
    modelRef: current.input.modelRef,
    prompt: current.input.prompt,
    ...(current.input.timeoutMs !== undefined ? { timeoutMs: current.input.timeoutMs } : {}),
    retriedFromRunId: current.id,
    retriedFromUnknown: current.task.acceptance === 'unknown' || current.task.outcome === 'unknown'
  });
});
$('#video-source-image-btn').addEventListener('click', () => {
  const src = $('#video-source-image').src;
  if (src) previewImage(src, '视频首帧来源预览');
});
for (const button of document.querySelectorAll('[data-reuse-image]')) {
  button.addEventListener('click', () => { void creation.reuse(button.dataset.reuseImage); });
}
$('#reuse-selected-crop').addEventListener('click', () => {
  if (current?.selection?.artifactId) openLocalTool('crop', { artifactId: current.selection.artifactId });
});
async function handoffRunAudio(targetMode) {
  if (!current?.output?.artifactId || !client) return;
  const ctx = context(), artifactId = current.output.artifactId;
  const label = (current.recipe === 'music/v0' ? '生成音乐' : '合成语音') + ' · ' + artifactId;
  let audioFile;
  try {
    const blob = await ctx.client.get('/api/v0/artifacts/' + artifactId + '/audio', { binary: true });
    if (!valid(ctx)) return;
    audioFile = blob;
  } catch (_) { /* Keep Artifact ID handoff even if preview fetch fails */ }
  creation.beginDraft({ mode: targetMode, audioArtifactId: artifactId, audioFile, audioLabel: label });
}
$('#reuse-audio-s2v').addEventListener('click', () => { void handoffRunAudio('video-s2v'); });
$('#reuse-audio-transcribe').addEventListener('click', () => { void handoffRunAudio('transcribe'); });
$('#reuse-audio-mux').addEventListener('click', () => {
  if (current?.output?.artifactId) openLocalTool('mux', { audioArtifactId: current.output.artifactId });
});
$('#reuse-video-mux').addEventListener('click', () => {
  if (current?.output?.artifactId) openLocalTool('mux', { videoArtifactId: current.output.artifactId });
});
$('#overview-tab').addEventListener('click', () => tab('overview'));
$('#studio-tab').addEventListener('click', () => tab());
$('#media-tab').addEventListener('click', () => tab('gallery'));
$('#tools-tab').addEventListener('click', () => tab('tools'));
$('#connections-tab').addEventListener('click', () => tab('connections'));
$('#plugins-tab').addEventListener('click', () => tab('plugins'));
for (const button of document.querySelectorAll('#overview-tools [data-local-tool]')) {
  button.addEventListener('click', () => openLocalTool(button.dataset.localTool));
}
for (const id of ['new-run', 'gallery-new']) $('#' + id).addEventListener('click', () => creation.beginDraft());
for (const button of document.querySelectorAll('#view-modes button')) button.addEventListener('click', () => { if (!button.disabled) setView(button.dataset.view); });
$('#compare-split').addEventListener('input', event => $('#overlay-output').style.setProperty('--split', event.target.value + '%'));
for (const kind of ['source', 'output']) $('#' + kind + '-preview').addEventListener('click', () => {
  const image = $('#' + kind + '-image'); if (image.hidden || !image.src) return;
  previewImage(image.src, kind === 'source' ? '原图预览' : '结果预览');
});
$('#locate-stage-preview').addEventListener('click', () => {
  if (!locateState?.sourceUrl) return;
  $('#expanded-image').src = locateState.sourceUrl;
  $('#image-dialog-title').textContent = '视觉定位预览 · ' + locateState.target;
  const spec = buildLocateOverlaySpec({
    imageWidth: locateState.imageWidth, imageHeight: locateState.imageHeight,
    result: locateState.result, cropRect: locateState.cropRect,
    showBox: locateState.showBox, showScrim: locateState.showScrim
  });
  renderLocateSvg($('#expanded-overlay'), spec, { maskId: 'expanded-scrim-mask' });
  $('#image-dialog').showModal();
});
$('#locate-toggle-box').addEventListener('click', () => {
  if (!locateState) return;
  locateState.showBox = !locateState.showBox;
  renderLocateVisual();
});
$('#locate-toggle-scrim').addEventListener('click', () => {
  if (!locateState || !locateState.showBox) return;
  locateState.showScrim = !locateState.showScrim;
  renderLocateVisual();
});
for (const [, id] of LOCATE_CROP_INPUTS) {
  $('#' + id).addEventListener('input', () => {
    if (!locateState?.cropRect) return;
    const raw = Object.fromEntries(LOCATE_CROP_INPUTS.map(([key, inputId]) => [key, $('#' + inputId).value]));
    if (Object.values(raw).some(value => value === '' || !Number.isFinite(Number(value)))) return;
    locateState.cropRect = clampCropRect(raw, locateState.result.width, locateState.result.height);
    renderLocateVisual();
  });
  $('#' + id).addEventListener('change', () => {
    if (!locateState?.cropRect) return;
    const fallback = locateState.cropRect;
    const raw = Object.fromEntries(LOCATE_CROP_INPUTS.map(([key, inputId]) => {
      const value = $('#' + inputId).value;
      return [key, value === '' ? fallback[key] : Number(value)];
    }));
    locateState.cropRect = clampCropRect(raw, locateState.result.width, locateState.result.height);
    syncLocateCropInputs(locateState.cropRect);
    renderLocateVisual();
  });
}
$('#locate-crop-reset').addEventListener('click', () => {
  if (!locateState?.cropRect) return;
  locateState.cropRect = locateState.result.bbox;
  syncLocateCropInputs(locateState.cropRect);
  renderLocateVisual();
});
$('#locate-crop-button').addEventListener('click', () => { void runLocateCrop(); });
$('#locate-crop-reload').addEventListener('click', () => { void runLocateCrop({ previewOnly: true }); });
$('#locate-retry-target').addEventListener('click', () => {
  if ($('#locate-retry-target').hidden) return;
  creation.beginDraft({
    file: locateState.sourceBlob || undefined,
    artifactId: locateState.sourceArtifactId,
    mode: 'locate',
    label: '原图 · 重新定位',
    modelRef: locateState.modelRef
  });
});
$('#locate-crop-download').addEventListener('click', downloadCroppedImage);
for (const button of document.querySelectorAll('[data-locate-handoff]')) {
  button.addEventListener('click', () => handoffCroppedImage(button.dataset.locateHandoff));
}
$('#close-image-dialog').addEventListener('click', closePreview);
$('#image-dialog').addEventListener('close', () => {
  $('#expanded-image').removeAttribute('src');
  renderLocateSvg($('#expanded-overlay'), null);
});
for (const details of document.querySelectorAll('details')) details.addEventListener('toggle', () => {
  details.querySelector('.disclosure').textContent = details.open ? '收起' : '展开';
});
createAppearance();
$('#providers-tab').addEventListener('click', () => { if (canManageProviders) tab('providers'); });
$('#network-tab').addEventListener('click', () => { if (!$('#network-tab').hidden) tab('network'); });
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
