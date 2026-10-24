import { canSelect, presentFlow } from './view-model.js';
import { createDemoTransport, DEMO_MODELS } from './demo-transport.js';
import { createWorkspacePanels } from './workspace-panels.js';

const $ = id => document.getElementById(id);
const transport = createDemoTransport();
const SAMPLE = './assets/sample.webp';
const MAX_IMAGE = 20 * 1024 * 1024;
const sources = new Map();
let sourceSerial = 1000, currentSource, view = null, controller = null, compareMode = 'pair';
let uploading = false;
const panels = createWorkspacePanels({ list: transport.list, inspect: transport.inspect, sourceFor: id => sources.get(id),
  openRun, newRun: () => $('new-run').click(), feedback });

function feedback(message, error = false) {
  const output = $('feedback'); output.textContent = message; output.dataset.error = String(error);
  const control = document.querySelector('#studio-page:not([hidden]) .run-controls, #gallery-page:not([hidden]) .gallery-toolbar, #connections-page:not([hidden]) .draft-save-row');
  control?.after(output);
}
function sourceFromSample() {
  const source = { id: 'artifact_' + (++sourceSerial).toString(16).padStart(24, '0'), url: SAMPLE,
    name: 'iris-flower.webp', dimensions: '2048 × 2048', type: 'image/webp' };
  sources.set(source.id, source);
  return source;
}
function setSource(source) {
  currentSource = source;
  document.querySelectorAll('.source-image').forEach(image => { image.src = source.url; });
  $('input-preview').alt = source.name === 'iris-flower.webp' ? '内置鸢尾花样图' : '本地选图预览';
  $('file-name').textContent = source.name;
  $('file-dimensions').textContent = source.dimensions;
}
function updateHistory() {
  const entries = transport.list();
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = entries.length ? '选择已有流程…' : '尚无流程';
  $('history').replaceChildren(placeholder, ...entries.map((entry, index) => {
    const option = document.createElement('option'); option.value = entry.id;
    option.textContent = `流程 ${index + 1} · ${entry.id.slice(-6)}`; return option;
  }));
  $('history').disabled = !entries.length || Boolean(controller) || uploading;
  $('history').value = view?.id || '';
}
function render() {
  const busy = Boolean(controller);
  const state = view ? presentFlow(view) : { title: '准备好，就开始吧', tone: 'neutral', action: null,
    message: '画布会保留原图与结果，方便你慢慢比较。' };
  $('input-fields').disabled = Boolean(view) || busy || uploading;
  $('upload-hint').textContent = view ? '本次来源已固定' : '↥ 点击换图，或拖放图片';
  $('input-lock').hidden = !view;
  $('new-run').disabled = busy || uploading;
  $('start').disabled = Boolean(view && view.status !== 'not_started') || busy || uploading;
  $('start').textContent = uploading ? '正在读取图片…' : view && view.status !== 'not_started' ? '本次输入已固定' : '↗  开始演示';
  $('busy-indicator').hidden = !busy;
  $('run-status').dataset.tone = busy ? 'working' : state.tone;
  $('status-title').textContent = busy ? '正在演示，请稍候' : state.title;
  $('status-message').textContent = busy ? '这是本地状态演示，不会连接模型。停止等待不会伪造远端取消。' : state.message;
  $('run-status-icon').textContent = busy ? '◌' : state.tone === 'success' ? '✓' : state.tone === 'warning' ? '!' : '○';
  $('result-panel').setAttribute('aria-busy', String(busy));
  const hasOutput = Boolean(view?.output), selectable = Boolean(view && canSelect(view));
  $('result-panel').dataset.hasOutput = String(hasOutput);
  document.querySelectorAll('.output-image').forEach(image => { image.hidden = !hasOutput; });
  $('result-placeholder').hidden = hasOutput;
  $('placeholder-title').textContent = busy ? '结果正在路上' : view?.status === 'needs_attention' ? '先确认原任务' : '下一张，等你决定';
  $('placeholder-message').textContent = busy ? '不显示虚构百分比，也不另开生成' : view?.status === 'needs_attention' ? '原请求可能已计费，不自动重提' : '开始后，在这里查看结果';
  $('view-overlay').disabled = !hasOutput;
  if (!hasOutput) compareMode = 'pair';
  $('pair-view').hidden = compareMode !== 'pair'; $('overlay-view').hidden = compareMode !== 'overlay';
  for (const name of ['pair', 'overlay']) {
    $('view-' + name).classList.toggle('active', compareMode === name);
    $('view-' + name).setAttribute('aria-pressed', String(compareMode === name));
  }
  for (const name of ['source', 'output']) {
    const selected = Boolean(view?.selection && view.selection.artifactId === view[name]?.artifactId);
    for (const prefix of ['select-', 'overlay-select-']) {
      const button = $(prefix + name); button.disabled = !selectable || busy;
      button.setAttribute('aria-pressed', String(selected));
      const label = `${selected ? '已选' : '选择'}${name === 'source' ? '原图' : '结果'}`;
      if (prefix === 'select-') button.lastElementChild.textContent = label; else button.textContent = label;
    }
  }
  $('selection-message').textContent = view?.selection
    ? `已选择${view.selection.artifactId === view.source.artifactId ? '原图' : '示例结果'}，可下载到设备。`
    : hasOutput ? '示例结果为内置样图，并非对上传图片的修改。' : '先比较，再选择。选择后即可下载。';
  $('download').disabled = !view?.selection || busy;
  $('continue').hidden = !state.action || state.action === 'start';
  $('continue').textContent = state.label || '查看原任务'; $('continue').disabled = busy;
  $('cancel').hidden = !busy; $('refresh').disabled = !view;
  $('run-short-id').textContent = view ? `RUN · ${view.id.slice(-6)}` : '尚未开始';
  $('detail-run').textContent = view?.id || '尚未创建'; $('detail-task').textContent = view?.task?.id || '尚未提交';
  $('detail-state').textContent = view?.task ? [view.task.acceptance, view.task.outcome, view.task.deliveryState].join(' / ') : '—';
  $('detail-submissions').textContent = String(transport.stats().submissions);
  $('prompt-count').textContent = `${$('prompt').value.length} / 4000`;
  updateHistory();
  panels.update({ busy, uploading });
}

async function operate() {
  if (controller || !view) return;
  const runId = view.id;
  controller = new AbortController();
  const signal = controller.signal;
  const pending = transport.continueRun(runId, { signal });
  view = transport.inspect(runId); render();
  try {
    view = await pending;
    feedback(view.output ? '演示结果已就绪。请比较并明确选择图片。' : presentFlow(view).message);
  } catch (error) {
    if (signal.aborted) feedback('已停止本次等待。原任务状态保留；这不代表远端生成已取消。');
    else feedback(error.message, true);
    view = transport.inspect(runId);
  } finally { controller = null; render(); }
}

async function loadFile(file) {
  if (!file || view || controller || uploading) return;
  uploading = true; render();
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > MAX_IMAGE) {
      throw new Error('请选择不超过 20 MiB 的 PNG、JPEG 或 WebP 图片。');
    }
    const bitmap = await createImageBitmap(file);
    const dimensions = `${bitmap.width} × ${bitmap.height}`; bitmap.close();
    const url = URL.createObjectURL(file);
    const source = { id: 'artifact_' + (++sourceSerial).toString(16).padStart(24, '0'), url, name: file.name, dimensions, type: file.type };
    sources.set(source.id, source); setSource(source);
    feedback('本地预览已载入，文件没有上传。演示结果仍使用内置鸢尾花样图。');
  } catch (error) { feedback(error.message || '图片无法预览，请重新选择。', true); }
  finally { uploading = false; $('image-file').value = ''; render(); }
}

$('model').replaceChildren(...DEMO_MODELS.map(model => { const option = document.createElement('option'); option.value = model.modelRef; option.textContent = model.label; return option; }));
setSource(sourceFromSample());
$('edit-form').addEventListener('submit', event => {
  event.preventDefault();
  if (controller || uploading || (view && view.status !== 'not_started') || !$('edit-form').reportValidity()) return;
  if (!view && !$('prompt').value.trim()) { feedback('请填写具体的修改要求。', true); $('prompt').focus(); return; }
  view ||= transport.create({ sourceArtifactId: currentSource.id, modelRef: $('model').value, prompt: $('prompt').value }, { scenario: $('scenario').value });
  feedback('本次输入已固定，开始演示。');
  void operate();
});
$('continue').addEventListener('click', () => { void operate(); });
$('cancel').addEventListener('click', () => { controller?.abort(new DOMException('本次等待已停止', 'AbortError')); });
$('refresh').addEventListener('click', () => {
  if (!view) return;
  view = transport.inspect(view.id); render(); feedback('已重新读取本次状态，没有继续执行或提交生成。');
});
$('new-run').addEventListener('click', () => {
  if (controller || uploading) return;
  panels.show('studio');
  view = null; compareMode = 'pair'; $('input-fields').disabled = false;
  feedback('已准备新流程，之前的记录仍可在作品页或最近流程中查看。'); render(); $('prompt').focus();
});
$('prompt').addEventListener('input', () => { $('prompt-count').textContent = `${$('prompt').value.length} / 4000`; });
$('use-sample').addEventListener('click', () => {
  if (view || uploading) return;
  setSource(sourceFromSample()); feedback('已恢复内置样图。');
});
$('image-file').addEventListener('change', event => { void loadFile(event.target.files[0]); });
for (const name of ['dragover', 'dragleave', 'drop']) $('drop-zone').addEventListener(name, event => {
  event.preventDefault(); $('drop-zone').classList.toggle('dragging', name === 'dragover' && !view && !uploading);
  if (name === 'drop') { $('drop-zone').classList.remove('dragging'); void loadFile(event.dataTransfer.files[0]); }
});
for (const name of ['pair', 'overlay']) $('view-' + name).addEventListener('click', () => { compareMode = name; render(); });
$('compare-position').addEventListener('input', event => {
  const value = event.target.valueAsNumber;
  $('overlay-output').style.clipPath = `inset(0 0 0 ${value}%)`; $('compare-value').textContent = `${value}%`;
});
for (const name of ['source', 'output']) for (const prefix of ['select-', 'overlay-select-']) $(prefix + name).addEventListener('click', () => {
  if (!view || controller || !canSelect(view)) return;
  view = transport.select(view.id, view[name].artifactId); render();
  feedback(`已选择${name === 'source' ? '原图' : '示例结果'}。下载仍需单独点击。`);
});
function openRun(id) {
  if (!id || controller || uploading) return;
  view = transport.inspect(id); setSource(sources.get(view.source.artifactId));
  $('prompt').value = view.input.prompt; $('model').value = view.input.modelRef;
  panels.show('studio');
  render(); feedback('已读取原流程，没有继续执行。');
}
$('history').addEventListener('change', event => openRun(event.target.value));
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => {
  if (view || controller || uploading) return;
  $('prompt').value = button.dataset.prompt; $('prompt-count').textContent = `${$('prompt').value.length} / 4000`;
  feedback('已填入示例要求，点击开始演示才会执行。');
});
$('preview-open').addEventListener('click', () => {
  $('expanded-image').src = currentSource.url; $('expanded-image').alt = '放大的原图预览'; $('image-dialog').showModal();
});
$('about-demo').addEventListener('click', () => $('demo-dialog').showModal());
for (const button of document.querySelectorAll('[data-close-dialog]')) button.addEventListener('click', () => $(button.dataset.closeDialog).close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
$('download').addEventListener('click', async () => {
  if (!view?.selection || controller) return;
  const runId = view.id;
  const source = view.selection.artifactId === view.source.artifactId ? sources.get(view.source.artifactId) : { url: SAMPLE, type: 'image/webp' };
  try {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error('演示图片读取失败');
    const blob = await response.blob(), url = URL.createObjectURL(blob);
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[source.type];
    const link = document.createElement('a'); link.href = url; link.download = `iris-demo-${runId.slice(-6)}.${extension}`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    if (view?.id === runId) feedback('下载请求已交给浏览器；是否保存成功，请查看浏览器下载记录。');
  } catch (error) { if (view?.id === runId) feedback(error.message, true); }
});
function updateThemeLabel() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('theme-button').setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
  return dark;
}
$('theme-button').addEventListener('click', () => { document.documentElement.dataset.theme = updateThemeLabel() ? 'light' : 'dark'; updateThemeLabel(); });
window.addEventListener('pagehide', () => { for (const source of sources.values()) if (source.url.startsWith('blob:')) URL.revokeObjectURL(source.url); });
updateThemeLabel(); render();
