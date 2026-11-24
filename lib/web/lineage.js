// Read-only artifact and Run provenance/lineage inspector (zero mutations, zero inline styles).
import { createCopyIdButton } from './clipboard.js';
const $ = selector => document.querySelector(selector);
const STATIC_IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export const ARTIFACT_KIND_LABELS = Object.freeze({
  import: '导入素材',
  'imported-image': '导入图片',
  'imported-audio': '导入音频',
  'generated-image': '生成图片',
  'generated-video': '生成视频',
  'generated-audio': '生成音频',
  'generated-music': '生成音乐',
  crop: '本地裁剪',
  'pixel-diff': '差异热力图',
  'video-frame': '视频帧',
  'muxed-video': '合轨视频',
  'html-screenshot': 'HTML 截图',
  comparison: '像素对比图',
  transcript: '转写文字',
  'vision-text': '视觉文字',
  'ocr-report': 'OCR 报告',
  'locate-result': '定位结果',
  'plugin-output': '插件产物',
  'plugin-image': '插件图片',
  'plugin-audio': '插件音频',
  'plugin-video': '插件视频',
  'plugin-text': '插件文本',
  'plugin-json': '插件 JSON'
});

const RELATION_LABELS = Object.freeze({
  'derived-from': '派生自',
  'frame-of': '抽帧自',
  'preview-of': '预览自',
  'transcript-of': '转写自',
  'audio-for': '音频来自',
  'retried-from': '重试自'
});

const RECIPE_LABELS = Object.freeze({
  'image-edit/v0': '图片编辑',
  'image-generate/v0': '图片生成',
  'speech/v0': '语音合成',
  'transcribe/v0': '音频转写',
  'music/v0': '音乐生成',
  'video-generate/v0': '视频生成',
  'video-i2v/v0': '图生视频',
  'video-s2v/v0': '数字人视频',
  'vision/v0': '看图问答',
  'ocr/v0': '图片文字识别',
  'locate/v0': '视觉定位',
  'summarize/v0': '多模态摘要'
});

const ROLE_LABELS = Object.freeze({
  source: '来源',
  output: '产物',
  selection: '已选',
  comparison: '对比',
  report: '报告',
  'retried-from': '重试自',
  'retried-by': '被重试'
});

export function formatArtifactKind(kind) {
  return ARTIFACT_KIND_LABELS[kind] || kind || '作品';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  return bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / (1024 * 1024)).toFixed(2) + ' MiB';
}

export function createLineagePreview(openPreview, onError) {
  let controller, url;
  function clear() {
    controller?.abort();
    controller = null;
    if (url) URL.revokeObjectURL(url);
    url = null;
  }
  async function show(client, item) {
    clear();
    if (!client) return;
    controller = new AbortController();
    const { signal } = controller;
    try {
      const blob = await client.get('/api/v0/artifacts/' + item.artifactId + '/content', { binary: true, signal });
      if (signal.aborted) return;
      url = URL.createObjectURL(blob);
      openPreview(url, `${formatArtifactKind(item.kind)} · ${item.artifactId}`);
    } catch (error) {
      if (!signal.aborted) { clear(); onError(error); }
    }
  }
  return { clear, show };
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

function artifactRow(item, { canCrop, canDiff, onPreview, onCrop, onDiff, onInspectArtifact }) {
  const row = el('li', undefined, 'lineage-row');
  const meta = el('div', undefined, 'lineage-meta');
  const titleLine = el('div', undefined, 'lineage-title-row');
  titleLine.append(el('span', formatArtifactKind(item.kind), 'badge'));
  if (item.relation) titleLine.append(el('span', RELATION_LABELS[item.relation] || item.relation, 'lineage-rel'));
  if (Array.isArray(item.roles) && item.roles.length) {
    titleLine.append(el('span', item.roles.map(r => ROLE_LABELS[r] || r).join(' / '), 'lineage-rel'));
  }
  const dims = item.width && item.height ? ` · ${item.width} × ${item.height}` : '';
  const sub = el('small', `${item.artifactId} · ${formatBytes(item.size)}${dims}${item.createdAt ? ' · ' + formatDate(item.createdAt) : ''}`, 'field-note');
  meta.append(titleLine, sub);

  const actions = el('div', undefined, 'lineage-actions');
  if (STATIC_IMAGES.has(item.mediaType) && onPreview) {
    const preview = el('button', '预览', 'quiet');
    preview.type = 'button';
    preview.dataset.lineagePreview = item.artifactId;
    preview.addEventListener('click', () => { void onPreview(item); });
    actions.append(preview);
  }
  if (STATIC_IMAGES.has(item.mediaType) && canCrop && onCrop) {
    const crop = el('button', '裁剪', 'quiet');
    crop.type = 'button';
    crop.dataset.lineageCrop = item.artifactId;
    crop.addEventListener('click', () => onCrop(item.artifactId));
    actions.append(crop);
  }
  if (STATIC_IMAGES.has(item.mediaType) && canDiff && onDiff) {
    const diff = el('button', '对比', 'quiet');
    diff.type = 'button';
    diff.dataset.lineageDiff = item.artifactId;
    diff.addEventListener('click', () => onDiff(item.artifactId));
    actions.append(diff);
  }
  if (onInspectArtifact) {
    const inspect = el('button', '血缘', 'quiet');
    inspect.type = 'button';
    inspect.dataset.lineageArtifact = item.artifactId;
    inspect.addEventListener('click', () => onInspectArtifact(item.artifactId));
    actions.append(inspect);
  }
  actions.append(createCopyIdButton(item.artifactId));
  row.append(meta, actions);
  return row;
}

function runRow(item, { onOpenRun }) {
  const row = el('li', undefined, 'lineage-row');
  const meta = el('div', undefined, 'lineage-meta');
  const titleLine = el('div', undefined, 'lineage-title-row');
  titleLine.append(el('span', RECIPE_LABELS[item.recipe] || item.recipe, 'badge'));
  if (Array.isArray(item.roles) && item.roles.length) {
    titleLine.append(el('span', item.roles.map(r => ROLE_LABELS[r] || r).join(' / '), 'lineage-rel'));
  }
  const sub = el('small', `${item.runId} · ${item.modelRef}${item.updatedAt ? ' · ' + formatDate(item.updatedAt) : ''}`, 'field-note');
  meta.append(titleLine, sub);
  const actions = el('div', undefined, 'lineage-actions');
  const open = el('button', '打开流程', 'secondary');
  open.type = 'button';
  open.dataset.lineageRun = item.runId;
  open.addEventListener('click', () => onOpenRun(item.runId));
  actions.append(open, createCopyIdButton(item.runId));
  row.append(meta, actions);
  return row;
}

function groupBlock(title, items, renderItem, note = '', total = items.length) {
  if (!items.length && !note) return null;
  const section = el('section', undefined, 'lineage-group');
  section.append(el('h4', title));
  if (items.length) {
    const list = el('ul', undefined, 'lineage-list');
    list.append(...items.map(renderItem));
    section.append(list);
  }
  if (note) section.append(el('p', note, 'field-note'));
  if (total > items.length) section.append(el('p', `当前显示 ${items.length} 项。`, 'field-note'));
  return section;
}

/** Render a single artifact's provenance graph into `container`. */
export function renderArtifactLineageView(container, data, handlers) {
  container.replaceChildren();
  const header = el('div', undefined, 'lineage-artifact-header');
  const info = el('div');
  info.append(
    el('strong', `${formatArtifactKind(data.artifact.kind)} · ${data.artifact.artifactId}`),
    el('p', `${data.artifact.mediaType} · ${formatBytes(data.artifact.size)}${data.artifact.width && data.artifact.height ? ` · ${data.artifact.width} × ${data.artifact.height}` : ''}`, 'field-note')
  );
  header.append(info);
  const nav = el('div', undefined, 'lineage-actions');
  if (handlers.onBack) {
    const back = el('button', handlers.backLabel || '← 返回', 'quiet');
    back.type = 'button';
    back.dataset.lineageBack = 'true';
    back.addEventListener('click', handlers.onBack);
    nav.append(back);
  }
  if (STATIC_IMAGES.has(data.artifact.mediaType) && handlers.onPreview) {
    const preview = el('button', '预览', 'quiet');
    preview.type = 'button';
    preview.addEventListener('click', () => { void handlers.onPreview(data.artifact); });
    nav.append(preview);
  }
  if (STATIC_IMAGES.has(data.artifact.mediaType) && handlers.canCrop && handlers.onCrop) {
    const crop = el('button', '去裁剪', 'secondary');
    crop.type = 'button';
    crop.addEventListener('click', () => handlers.onCrop(data.artifact.artifactId));
    nav.append(crop);
  }
  header.append(nav);
  container.append(header);

  const blocks = [
    groupBlock(
      `上游来源作品（${data.totalParents}）`,
      data.parents,
      item => artifactRow(item, handlers),
      data.missingParents ? `有 ${data.missingParents} 项上游引用已不可访问。` : '',
      data.totalParents
    ),
    groupBlock(
      `直接派生作品（${data.totalChildren}）`,
      data.children,
      item => artifactRow(item, handlers), '', data.totalChildren
    ),
    groupBlock(
      `关联流程（${data.totalRuns}）`,
      data.runs,
      item => runRow(item, handlers), '', data.totalRuns
    )
  ].filter(Boolean);

  if (!blocks.length) {
    container.append(el('p', '当前作品暂无上游来源、派生作品或关联流程记录。', 'field-note'));
  } else {
    container.append(...blocks);
  }
}

/** Manages the lazy-loaded read-only lineage `<details id="run-lineage">` inside `#run-view`. */
export function createRunLineagePanel({ describe, openRun, openPreview, openInCrop, openInDiff }) {
  const details = $('#run-lineage');
  const summaryNote = $('#run-lineage-summary');
  const feedback = $('#run-lineage-feedback');
  const body = $('#run-lineage-body');
  const refreshBtn = $('#run-lineage-refresh');

  let client = null, capabilities = [], runId = null, loadedRunId = null, controller = null, ticket = 0;
  let artifactStack = [];
  const preview = createLineagePreview(openPreview, error => setFeedback('预览读取失败：' + describe(error), true));

  function setFeedback(text = '', error = false) {
    feedback.hidden = !text;
    feedback.textContent = text;
    feedback.classList.toggle('error', error);
  }

  const rowHandlers = () => ({
    canCrop: capabilities.includes('local-media.crop'),
    canDiff: capabilities.includes('local-media.diff'),
    onPreview: item => preview.show(client, item),
    onCrop: openInCrop,
    onDiff: openInDiff,
    onOpenRun: openRun,
    onInspectArtifact: id => { void loadArtifact(id); }
  });

  function renderRunLineage(data) {
    body.replaceChildren();
    const handlers = rowHandlers();
    const totalLinks = data.totalUpstreamRuns + data.totalUpstreamArtifacts + data.totalDirectDerived + data.totalDownstreamRuns;
    summaryNote.textContent = totalLinks ? `${totalLinks} 项关联` : '暂无上下游派生';
    const blocks = [
      groupBlock(`上游流程（${data.totalUpstreamRuns}）`, data.upstreamRuns, item => runRow(item, handlers), '', data.totalUpstreamRuns),
      groupBlock(
        `上游来源作品（${data.totalUpstreamArtifacts}）`,
        data.upstreamArtifacts,
        item => artifactRow(item, handlers),
        data.missingUpstream ? `有 ${data.missingUpstream} 项上游引用已不可访问。` : '',
        data.totalUpstreamArtifacts
      ),
      groupBlock(`直接派生作品（${data.totalDirectDerived}）`, data.directDerived, item => artifactRow(item, handlers), '', data.totalDirectDerived),
      groupBlock(`下游关联流程（${data.totalDownstreamRuns}）`, data.downstreamRuns, item => runRow(item, handlers), '', data.totalDownstreamRuns)
    ].filter(Boolean);
    if (!blocks.length) {
      body.append(el('p', '当前流程暂无上游来源、直接派生作品或下游关联流程。', 'field-note'));
    }
    body.append(...blocks);
    const own = groupBlock(`本流程作品（${data.artifacts.length}）`, data.artifacts, item => artifactRow(item, handlers));
    if (own) body.append(own);
  }

  async function loadRunLineage(force = false) {
    if (!client || !runId) return;
    if (!force && loadedRunId === runId) return;
    preview.clear();
    controller?.abort();
    controller = new AbortController();
    const currentTicket = ++ticket;
    const targetRunId = runId;
    setFeedback('正在读取来源与派生血缘…');
    refreshBtn.disabled = true;
    try {
      const data = await client.getRunLineage(targetRunId, { signal: controller.signal });
      if (currentTicket !== ticket || targetRunId !== runId) return;
      if (data.contractVersion !== 0) throw new TypeError('不支持的血缘响应版本');
      loadedRunId = targetRunId;
      artifactStack = [];
      setFeedback('');
      renderRunLineage(data);
    } catch (error) {
      if (currentTicket === ticket && !controller.signal.aborted) {
        setFeedback('血缘读取失败：' + describe(error), true);
      }
    } finally {
      if (currentTicket === ticket) refreshBtn.disabled = false;
    }
  }

  async function loadArtifact(artifactId, path = [...artifactStack, artifactId]) {
    if (!client || !artifactId) return;
    preview.clear();
    controller?.abort();
    controller = new AbortController();
    const currentTicket = ++ticket;
    setFeedback('正在读取作品血缘…');
    refreshBtn.disabled = true;
    try {
      const data = await client.getArtifactLineage(artifactId, { signal: controller.signal });
      if (currentTicket !== ticket) return;
      if (data.contractVersion !== 0) throw new TypeError('不支持的血缘响应版本');
      artifactStack = path;
      setFeedback('');
      summaryNote.textContent = `作品 ${artifactId.slice(0, 16)}…`;
      renderArtifactLineageView(body, data, {
        ...rowHandlers(),
        backLabel: artifactStack.length > 1 ? '← 上一件作品' : '← 返回流程血缘',
        onBack: () => {
          const previous = artifactStack.slice(0, -1);
          if (previous.length) void loadArtifact(previous.at(-1), previous);
          else void loadRunLineage(true);
        }
      });
    } catch (error) {
      if (currentTicket === ticket && !controller.signal.aborted) {
        setFeedback('作品血缘读取失败：' + describe(error), true);
      }
    } finally {
      if (currentTicket === ticket) refreshBtn.disabled = false;
    }
  }

  details.addEventListener('toggle', () => {
    if (details.open && client && runId) void loadRunLineage(false);
    else preview.clear();
  });
  refreshBtn.addEventListener('click', () => {
    const activeArtifact = artifactStack.at(-1);
    if (activeArtifact) void loadArtifact(activeArtifact, artifactStack);
    else void loadRunLineage(true);
  });

  return Object.freeze({
    connect(http, session) {
      client = http;
      capabilities = session?.operations || [];
    },
    cancelPreview: preview.clear,
    setRun(nextRunId, { sameRun = false } = {}) {
      controller?.abort();
      controller = null;
      ticket++;
      preview.clear();
      runId = nextRunId;
      loadedRunId = null;
      artifactStack = [];
      setFeedback('');
      if (!nextRunId) {
        details.hidden = true;
        details.open = false;
        body.replaceChildren();
        summaryNote.textContent = '只读关系';
        return;
      }
      details.hidden = false;
      if (!sameRun) {
        details.open = false;
        body.replaceChildren();
        summaryNote.textContent = '只读关系';
      } else if (details.open) {
        void loadRunLineage(true);
      }
    },
    disconnect() {
      controller?.abort();
      controller = null;
      ticket++;
      preview.clear();
      client = null;
      capabilities = [];
      runId = null;
      loadedRunId = null;
      artifactStack = [];
      details.hidden = true;
      details.open = false;
      body.replaceChildren();
      summaryNote.textContent = '只读关系';
      setFeedback('');
    }
  });
}
