// Zero-cost local media tools panel: arbitrary EXIF-aligned crop, two-image pixel diff heatmap, video+audio mux, optional HTML/SVG sandbox render and host-owned plugin op auto form.
import { clampCropRect, isSameCropRect, buildLocateOverlaySpec, renderLocateSvg } from './locate-overlay.js';
import { createLineagePreview, formatArtifactKind, formatBytes, renderArtifactLineageView } from './lineage.js';
import { createPluginOpForm } from './plugin-op-form.js';
import { createOutboxExportControl } from './outbox-export.js';
import { copyTextValue } from './clipboard.js';

const $ = selector => document.querySelector(selector);
const CROP_INPUTS = [['left', 'tool-crop-left'], ['top', 'tool-crop-top'], ['width', 'tool-crop-width'], ['height', 'tool-crop-height']];
const IMAGE_SELECTS = ['#tool-crop-select', '#tool-diff-a', '#tool-diff-b'];

function syncInputs(rect) {
  if (!rect) return;
  for (const [key, id] of CROP_INPUTS) $('#' + id).value = String(rect[key]);
}

function optionLabel(item) {
  const dims = item.width && item.height ? ` · ${item.width}×${item.height}` : '';
  return `${formatArtifactKind(item.kind)} · ${item.artifactId}${dims} · ${formatBytes(item.size)}`;
}

export function createLocalToolsPanel({ describe, openPreview, openOverlayPreview, handoffImage, openRun, onOutboxExported }) {
  let client = null, session = null, visible = false, activeTool = 'crop';
  let artifacts = [], nextOffset = null, listController = null;
  let videoArtifacts = [], audioArtifacts = [], muxListController = null;
  let cropState = null, cropController = null, cropActionController = null;
  let diffBusy = false, diffController = null, diffResult = null;
  const diffThumbControllers = { a: null, b: null };
  const diffThumbIds = { a: null, b: null };
  let muxBusy = false, muxController = null, muxResult = null;
  const muxPreviewControllers = { video: null, audio: null };
  let htmlBusy = false, htmlController = null, htmlResult = null;
  let lineageController = null, lineageStack = [];
  const urls = new Map();
  const lineagePreview = createLineagePreview(openPreview, error => setStatus('#tool-lineage-feedback', '预览读取失败：' + describe(error), true));
  const canExportOutbox = () => Boolean(session?.outbox && session?.operations?.includes('outbox.export'));
  const makeOutbox = selector => createOutboxExportControl({
    container: $(selector), getClient: () => client, canExport: canExportOutbox, describe, onExported: onOutboxExported
  });
  const cropOutbox = makeOutbox('#tool-crop-outbox');
  const diffOutbox = makeOutbox('#tool-diff-outbox');
  const htmlOutbox = makeOutbox('#tool-html-outbox');
  const muxOutbox = makeOutbox('#tool-mux-outbox');
  const pluginOpForm = createPluginOpForm({
    describe, openPreview, handoffImage,
    onInspectArtifact: id => { void inspectArtifactLineage(id, [id]); },
    onOutboxExported
  });

  const hasOp = name => Boolean(session?.operations?.includes(name));
  const canCrop = () => hasOp('local-media.crop');
  const canDiff = () => hasOp('local-media.diff');
  const canMux = () => session?.video === true && session?.audio === true && hasOp('local-media.mux');
  const muxSupported = () => session?.video === true && session?.audio === true;
  const canHtml = () => session?.htmlRender === true && hasOp('html.render');

  function releaseImage(selector) {
    const url = urls.get(selector);
    if (url) URL.revokeObjectURL(url);
    urls.delete(selector);
    const node = $(selector);
    if (!node) return;
    if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') { node.pause(); node.removeAttribute('src'); node.load(); }
    else node.removeAttribute('src');
  }

  async function decodePreview(selector, blob) {
    releaseImage(selector);
    const image = $(selector);
    const url = URL.createObjectURL(blob);
    urls.set(selector, url);
    image.src = url;
    try {
      await image.decode();
    } catch (error) {
      if (urls.get(selector) === url) releaseImage(selector);
      throw error;
    }
    return url;
  }

  function setStatus(selector, text = '', error = false) {
    const el = $(selector);
    el.hidden = !text;
    el.textContent = text;
    el.classList.toggle('error', error);
  }

  function triggerDownload(url, filename) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  }

  function updateHandoffButtons(containerSelector, enabled) {
    const visionEnabled = session?.vision === true, videoEnabled = session?.video === true;
    for (const button of document.querySelectorAll(containerSelector + ' [data-tool-handoff]')) {
      const mode = button.dataset.toolHandoff;
      const allowed = enabled && (mode === 'crop' ? true
        : mode === 'edit' ? hasOp('runs.create')
          : mode === 'video-i2v' ? videoEnabled && hasOp('videos-i2v.create')
            : mode === 'vision' ? visionEnabled && hasOp('visions.create')
              : mode === 'ocr' ? visionEnabled && hasOp('ocrs.create')
                : mode === 'locate' ? visionEnabled && hasOp('locates.create') : false);
      button.hidden = !allowed;
    }
  }

  function setTool(next) {
    if (!['crop', 'diff', 'mux', 'html', 'plugins'].includes(next)) return;
    if (next === 'plugins' && !(session?.pluginExecution && session?.pluginOperations?.length)) return;
    if (next === 'mux' && !muxSupported()) return;
    activeTool = next;
    for (const button of document.querySelectorAll('#local-tools-tabs [data-local-tool-tab]')) {
      button.setAttribute('aria-pressed', String(button.dataset.localToolTab === activeTool));
    }
    $('#tool-crop-section').hidden = activeTool !== 'crop';
    $('#tool-diff-section').hidden = activeTool !== 'diff';
    $('#tool-mux-section').hidden = activeTool !== 'mux';
    $('#tool-html-section').hidden = activeTool !== 'html';
    $('#tool-plugins-section').hidden = activeTool !== 'plugins';
    renderHtmlGate();
    renderDiffControls();
    renderMuxControls();
    renderCropView();
    if (activeTool === 'mux' && client && !videoArtifacts.length && !audioArtifacts.length && !muxListController) void loadMuxArtifacts();
    if (activeTool === 'plugins') void pluginOpForm.activate();
  }

  function populateSelect(select) {
    const selected = select.selectedOptions[0];
    select.replaceChildren(new Option(artifacts.length ? '选择工作区中的静态图片…' : '当前工作区暂无静态图片作品', ''),
      ...artifacts.map(item => new Option(optionLabel(item), item.artifactId)));
    if (!selected?.value) return;
    // Preserve an explicit choice across refreshes, including direct handoffs outside the current page.
    if (!artifacts.some(item => item.artifactId === selected.value)) select.add(selected, 1);
    select.value = selected.value;
  }

  function selectArtifact(select, artifactId) {
    select.value = artifactId;
    if (select.value === artifactId) return;
    select.add(new Option('正在核对图片 · ' + artifactId, artifactId), 1);
    select.value = artifactId;
  }

  async function loadArtifacts({ more = false } = {}) {
    if (!client || more && (listController || nextOffset === null)) return;
    const offset = more ? nextOffset : 0;
    listController?.abort();
    const controller = listController = new AbortController();
    $('#tools-refresh').disabled = $('#tools-more').disabled = true;
    setStatus('#tools-feedback', '正在读取工作区图片目录…');
    try {
      const data = await client.listArtifacts({ kind: 'image', limit: 50, offset }, { signal: controller.signal });
      if (listController !== controller) return;
      if (data.contractVersion !== 0 || !Array.isArray(data.artifacts)) throw new TypeError('不支持的作品目录响应');
      artifacts = more ? [...new Map([...artifacts, ...data.artifacts].map(item => [item.artifactId, item])).values()] : data.artifacts;
      nextOffset = data.nextOffset;
      for (const selector of IMAGE_SELECTS) populateSelect($(selector));
      const countNote = artifacts.length
        ? `工作区目录有 ${data.total} 张候选图片，已加载 ${artifacts.length} 张。`
        : '当前工作区尚无静态图片；可先导入、生图、抽帧或渲染 HTML。';
      setStatus('#tools-feedback', countNote);
    } catch (error) {
      if (listController === controller && !controller.signal.aborted) {
        setStatus('#tools-feedback', '图片目录读取失败：' + describe(error), true);
      }
    } finally {
      if (listController === controller) {
        listController = null;
        $('#tools-refresh').disabled = $('#tools-more').disabled = false;
        $('#tools-more').hidden = nextOffset === null;
      }
    }
  }

  async function readSourceImage(artifactId, signal) {
    const meta = await client.getArtifactMeta(artifactId, { signal });
    if (meta.contractVersion !== 0 || meta.artifactId !== artifactId || !meta.image) {
      throw new Error('所选作品不支持静态图片处理或已超过大小上限');
    }
    signal.throwIfAborted();
    const blob = await client.get('/api/v0/artifacts/' + artifactId + '/content', { binary: true, signal });
    if (blob.type !== meta.mediaType) throw new Error('图片内容类型与作品元数据不一致');
    return { meta, blob };
  }

  // --- Tool 1: Arbitrary EXIF-aligned Crop ---
  function currentCropOverlaySpec() {
    if (!cropState?.meta?.image || !cropState.imageWidth || !cropState.imageHeight) return null;
    const { width, height, orientation } = cropState.meta.image;
    const fullBox = { left: 0, top: 0, width, height };
    return buildLocateOverlaySpec({
      imageWidth: cropState.imageWidth,
      imageHeight: cropState.imageHeight,
      result: { found: true, width, height, input: { orientation }, bbox: fullBox },
      cropRect: cropState.cropRect,
      showBox: cropState.showBox,
      showScrim: cropState.showScrim
    });
  }

  function renderCropView() {
    const hasImage = Boolean(cropState?.sourceUrl && cropState.artifactId === $('#tool-crop-select').value);
    const spec = currentCropOverlaySpec();
    const ok = spec?.reason === 'ok';
    $('#tool-crop-stage-frame').hidden = !hasImage;
    $('#tool-crop-placeholder').hidden = hasImage;
    renderLocateSvg($('#tool-crop-overlay'), spec, { maskId: 'tool-crop-scrim-mask' });
    if ($('#image-dialog').open && cropState?.sourceUrl && $('#expanded-image').src === cropState.sourceUrl) {
      renderLocateSvg($('#expanded-overlay'), spec, { maskId: 'expanded-scrim-mask' });
    }
    $('#tool-crop-toggles').hidden = !ok;
    if (ok) {
      $('#tool-crop-toggle-box').setAttribute('aria-pressed', String(cropState.showBox));
      $('#tool-crop-toggle-box').textContent = cropState.showBox ? '隐藏选区框' : '显示选区框';
      $('#tool-crop-toggle-scrim').setAttribute('aria-pressed', String(cropState.showScrim));
      $('#tool-crop-toggle-scrim').disabled = !cropState.showBox;
    }
    const badge = $('#tool-crop-badge');
    if (!cropState) {
      badge.textContent = '选择图片开始';
      $('#tool-crop-dimensions').textContent = '';
    } else if (cropState.error) {
      badge.textContent = '图片读取失败';
      $('#tool-crop-dimensions').textContent = cropState.error;
    } else if (!hasImage) {
      badge.textContent = '正在读取原图与 EXIF 几何…';
      $('#tool-crop-dimensions').textContent = '';
    } else if (!ok) {
      badge.textContent = '图片尺寸与元数据不匹配';
      $('#tool-crop-dimensions').textContent = '已中止叠框，请核对原图元数据。';
    } else {
      const { width, height, orientation } = cropState.meta.image;
      const rect = cropState.cropRect;
      badge.textContent = `(${rect.left}, ${rect.top}) · ${rect.width} × ${rect.height} px / 原图 ${width} × ${height}`;
      $('#tool-crop-dimensions').textContent = orientation !== 1
        ? `原图像素 ${width} × ${height} · 显示尺寸 ${cropState.imageWidth} × ${cropState.imageHeight} · EXIF 方向 ${orientation}（画布按显示方向投影，裁剪提交原图像素坐标）`
        : `原图像素 ${width} × ${height} · 零外部计费`;
    }
    const writable = canCrop();
    $('#tool-crop-readonly-note').hidden = writable || !ok;
    $('#tool-crop-controls').hidden = !ok;
    $('#tool-crop-submit').hidden = !writable;
    $('#tool-crop-submit').disabled = true;
    if (ok) {
      const { width, height } = cropState.meta.image;
      const fullBox = { left: 0, top: 0, width, height };
      $('#tool-crop-left').max = String(width - 1);
      $('#tool-crop-top').max = String(height - 1);
      $('#tool-crop-width').max = String(width);
      $('#tool-crop-height').max = String(height);
      const isFull = isSameCropRect(cropState.cropRect, fullBox);
      $('#tool-crop-reset').disabled = cropState.cropping || isFull;
      const needsPreview = Boolean(cropState.cropped && !cropState.cropped.url);
      const savedSame = needsPreview && isSameCropRect(cropState.cropped.rect, cropState.cropRect);
      $('#tool-crop-submit').disabled = !writable || cropState.cropping || savedSame;
      $('#tool-crop-submit').textContent = savedSame ? '裁剪区域已保存' : cropState.cropping ? '正在本地裁剪…' : '按选区裁剪（零计费）';
    }
    const cropped = cropState?.cropped;
    $('#tool-crop-result').hidden = !cropped;
    if (cropped) {
      const needsPreview = !cropped.url;
      $('#tool-crop-result-image').hidden = needsPreview;
      $('#tool-crop-reload').hidden = !needsPreview;
      $('#tool-crop-reload').disabled = Boolean(cropState.cropping);
      $('#tool-crop-download').disabled = needsPreview;
      $('#tool-crop-result-meta').textContent = `${cropped.width} × ${cropped.height} px · ${cropped.artifactId} · PNG（已保存在当前工作区）`;
      updateHandoffButtons('#tool-crop-result', !needsPreview);
      cropOutbox.setTarget({ artifactId: cropped.artifactId, mediaType: 'image/png' });
    } else {
      cropOutbox.setTarget(null);
    }
  }

  async function loadCropSource(artifactId) {
    cropController?.abort();
    cropActionController?.abort();
    releaseImage('#tool-crop-image');
    releaseImage('#tool-crop-result-image');
    if (!artifactId || !client) {
      cropState = null;
      $('#tool-crop-placeholder').textContent = '从上方选择一张静态图片，即可按原图像素坐标实时预览并裁剪。';
      setStatus('#tool-crop-feedback', '');
      renderCropView();
      return;
    }
    const controller = cropController = new AbortController();
    cropState = {
      artifactId, meta: null, sourceUrl: null, imageWidth: 0, imageHeight: 0,
      cropRect: null, showBox: true, showScrim: true, cropping: false, cropped: null, error: ''
    };
    $('#tool-crop-placeholder').textContent = '正在读取原图与几何元数据…';
    setStatus('#tool-crop-feedback', '');
    renderCropView();
    try {
      const { meta, blob } = await readSourceImage(artifactId, controller.signal);
      if (cropController !== controller || !cropState) return;
      const url = await decodePreview('#tool-crop-image', blob);
      if (cropController !== controller || !cropState) return;
      const image = $('#tool-crop-image');
      cropState.meta = meta;
      cropState.sourceUrl = url;
      cropState.imageWidth = image.naturalWidth;
      cropState.imageHeight = image.naturalHeight;
      cropState.cropRect = clampCropRect({ left: 0, top: 0, width: meta.image.width, height: meta.image.height }, meta.image.width, meta.image.height);
      $('#tool-crop-select').selectedOptions[0].textContent = optionLabel({ ...meta, ...meta.image });
      syncInputs(cropState.cropRect);
      renderCropView();
    } catch (error) {
      if (cropController === controller && !controller.signal.aborted && cropState) {
        cropState.error = describe(error);
        $('#tool-crop-placeholder').textContent = '读取失败：' + cropState.error;
        $('#tool-crop-select').selectedOptions[0].textContent = '不可用图片 · ' + artifactId;
        renderCropView();
      }
    }
  }

  async function runCrop({ previewOnly = false } = {}) {
    if (!client || !cropState?.meta?.image || cropState.cropping) return;
    if (!previewOnly && (!canCrop() || cropState.artifactId !== $('#tool-crop-select').value
        || currentCropOverlaySpec()?.reason !== 'ok' || $('#tool-crop-submit').disabled)) return;
    if (previewOnly && !cropState.cropped?.artifactId) return;
    cropActionController?.abort();
    const controller = cropActionController = new AbortController();
    const state = cropState;
    const rect = previewOnly ? state.cropped.rect
      : clampCropRect(state.cropRect, state.meta.image.width, state.meta.image.height);
    if (!previewOnly) {
      state.cropRect = rect;
      syncInputs(rect);
    }
    state.cropping = true;
    setStatus('#tool-crop-feedback', previewOnly ? '正在重新读取裁剪预览…' : '正在本地裁剪并保存 PNG（零外部计费）…');
    renderCropView();
    let saved = previewOnly ? state.cropped : null;
    try {
      if (!previewOnly) {
        const res = await client.cropImage({ artifactId: state.artifactId, ...rect }, { signal: controller.signal });
        if (cropState !== state || controller.signal.aborted) return;
        if (res.contractVersion !== 0 || !res.artifact?.artifactId || res.artifact.sourceArtifactId !== state.artifactId) {
          throw new TypeError('不支持的裁剪响应');
        }
        releaseImage('#tool-crop-result-image');
        saved = {
          artifactId: res.artifact.artifactId,
          width: res.artifact.width || rect.width,
          height: res.artifact.height || rect.height,
          rect: { ...rect },
          url: null,
          blob: null
        };
        state.cropped = saved;
        renderCropView();
      }
      const blob = await client.get('/api/v0/artifacts/' + saved.artifactId + '/content', { binary: true, signal: controller.signal });
      if (cropState !== state || controller.signal.aborted) return;
      const url = await decodePreview('#tool-crop-result-image', blob);
      if (cropState !== state || controller.signal.aborted) return;
      saved.blob = blob;
      saved.url = url;
      setStatus('#tool-crop-feedback', `已保存本地裁剪图 ${saved.artifactId}（${saved.width} × ${saved.height} px，零模型调用）。`);
      void loadArtifacts();
    } catch (error) {
      if (cropState === state && !controller.signal.aborted) {
        setStatus('#tool-crop-feedback', saved
          ? `本地裁剪图 ${saved.artifactId} 已保存，但预览读取失败：${describe(error)}（点击“重新读取裁剪预览”即可重试，不会重复裁剪）。`
          : '本地裁剪失败：' + describe(error), true);
      }
    } finally {
      if (cropState === state) {
        state.cropping = false;
        renderCropView();
      }
    }
  }

  // --- Tool 2: Two-Image Pixel Diff Heatmap ---
  const diffSourcesReady = () => ['a', 'b'].every(slot => diffThumbIds[slot] && diffThumbIds[slot] === $('#tool-diff-' + slot).value);

  function renderDiffControls() {
    const writable = canDiff();
    const ready = diffSourcesReady();
    $('#tool-diff-readonly-note').hidden = writable;
    $('#tool-diff-submit').hidden = !writable;
    $('#tool-diff-submit').disabled = !writable || diffBusy || !ready;
    $('#tool-diff-submit').textContent = diffBusy ? '正在本地比对…' : '生成像素对比热力图（零计费）';
    $('#tool-diff-result').hidden = !diffResult;
    if (diffResult) {
      const needsPreview = !diffResult.url;
      $('#tool-diff-heatmap').hidden = needsPreview;
      $('#tool-diff-heatmap-button').disabled = needsPreview;
      $('#tool-diff-reload').hidden = !needsPreview;
      $('#tool-diff-reload').disabled = diffBusy;
      $('#tool-diff-download').disabled = needsPreview;
      const m = diffResult.metrics;
      $('#tool-diff-summary').textContent = `差异占比 ${(m.ratio * 100).toFixed(2)}% · ${m.diffPixels} / ${m.totalPixels} 像素 · 归一化尺寸 ${m.width} × ${m.height} · 热力图 ${diffResult.artifactId}`;
      $('#tool-diff-sources').textContent = '来源图片 ' + diffResult.sources.join(' · ');
      const list = $('#tool-diff-regions');
      list.replaceChildren(...(m.worstRegions || []).map(region => {
        const li = document.createElement('li');
        li.textContent = `第 ${region.row + 1} 行 · 第 ${region.col + 1} 列 · 局部差异 ${(region.score * 100).toFixed(1)}%`;
        return li;
      }));
      $('#tool-diff-regions-empty').hidden = Boolean(m.worstRegions?.length);
      diffOutbox.setTarget({ artifactId: diffResult.artifactId, mediaType: 'image/png' });
    } else {
      diffOutbox.setTarget(null);
    }
  }

  async function loadDiffThumb(slot, artifactId) {
    diffThumbControllers[slot]?.abort();
    diffThumbControllers[slot] = null;
    diffThumbIds[slot] = null;
    const selector = '#tool-diff-preview-' + slot, img = $(selector), select = $('#tool-diff-' + slot);
    const note = $('#tool-diff-note-' + slot);
    img.hidden = true;
    releaseImage(selector);
    if (!artifactId || !client) {
      note.textContent = '未选择图片';
      renderDiffControls();
      return;
    }
    const controller = diffThumbControllers[slot] = new AbortController();
    note.textContent = '读取预览中…';
    renderDiffControls();
    try {
      const { meta, blob } = await readSourceImage(artifactId, controller.signal);
      if (diffThumbControllers[slot] !== controller || select.value !== artifactId) return;
      await decodePreview(selector, blob);
      if (diffThumbControllers[slot] !== controller || select.value !== artifactId) return;
      img.hidden = false;
      diffThumbIds[slot] = artifactId;
      const { width, height, orientation } = meta.image;
      select.selectedOptions[0].textContent = optionLabel({ ...meta, width, height });
      note.textContent = `${width} × ${height} px · ${artifactId}`
        + (orientation === 1 ? '' : ` · 对比使用原始像素，预览按 EXIF 方向 ${orientation} 显示`);
      renderDiffControls();
    } catch (error) {
      if (diffThumbControllers[slot] === controller && !controller.signal.aborted && select.value === artifactId) {
        select.selectedOptions[0].textContent = '不可用图片 · ' + artifactId;
        note.textContent = '预览失败：' + describe(error);
      }
    }
  }

  async function runDiff({ previewOnly = false } = {}) {
    if (!client || diffBusy) return;
    if (!previewOnly && (!canDiff() || !diffSourcesReady())) return;
    const imageAArtifactId = $('#tool-diff-a').value;
    const imageBArtifactId = $('#tool-diff-b').value;
    if (previewOnly && !diffResult?.artifactId) return;
    diffController?.abort();
    const controller = diffController = new AbortController();
    diffBusy = true;
    setStatus('#tool-diff-feedback', previewOnly ? '正在重新读取热力图预览…' : '正在本地逐像素对比并生成热力图（零外部计费）…');
    renderDiffControls();
    let saved = previewOnly ? diffResult : null;
    try {
      if (!previewOnly) {
        const grid = $('#tool-diff-grid').valueAsNumber;
        const topRegions = $('#tool-diff-regions-limit').valueAsNumber;
        const res = await client.pixelDiff({
          imageAArtifactId, imageBArtifactId,
          ...(Number.isSafeInteger(grid) ? { grid } : {}),
          ...(Number.isSafeInteger(topRegions) ? { topRegions } : {})
        }, { signal: controller.signal });
        if (diffController !== controller) return;
        if (res.contractVersion !== 0 || !res.artifact?.artifactId || !res.metrics) throw new TypeError('不支持的像素对比响应');
        releaseImage('#tool-diff-heatmap');
        saved = { artifactId: res.artifact.artifactId, sources: [imageAArtifactId, imageBArtifactId], metrics: res.metrics, url: null };
        diffResult = saved;
        renderDiffControls();
      }
      const blob = await client.get('/api/v0/artifacts/' + saved.artifactId + '/content', { binary: true, signal: controller.signal });
      if (diffController !== controller) return;
      const url = await decodePreview('#tool-diff-heatmap', blob);
      if (diffController !== controller) return;
      saved.url = url;
      setStatus('#tool-diff-feedback', `像素对比完成，已保存热力图 ${saved.artifactId}（零模型调用）。`);
      void loadArtifacts();
    } catch (error) {
      if (diffController === controller && !controller.signal.aborted) {
        setStatus('#tool-diff-feedback', saved
          ? `热力图 ${saved.artifactId} 已保存，但预览读取失败：${describe(error)}（点击“重新读取热力图”即可重试）。`
          : '像素对比失败：' + describe(error), true);
      }
    } finally {
      if (diffController === controller) {
        diffBusy = false;
        renderDiffControls();
      }
    }
  }

  // --- Tool 3: Optional HTML/SVG Sandbox Render ---
  function renderHtmlGate() {
    const enabled = session?.htmlRender === true;
    const writable = canHtml();
    const unavailableNote = $('#tool-html-unavailable');
    const form = $('#tool-html-form');
    if (!enabled) {
      unavailableNote.hidden = false;
      unavailableNote.textContent = '当前服务未启用无头 HTML 截图。启动 Core 时需显式传入 --browser-executable <Chromium 绝对路径> 与本地写入开关；Iris 绝不自动扫描宿主浏览器。';
      form.hidden = true;
    } else if (!writable) {
      unavailableNote.hidden = false;
      unavailableNote.textContent = '当前服务已配置无头浏览器但处于只读模式；开启 --allow-local-writes 后可在本机沙箱 CSP 中渲染 HTML/SVG。';
      form.hidden = true;
    } else {
      unavailableNote.hidden = true;
      form.hidden = false;
      const htmlText = $('#tool-html-input').value.trim();
      $('#tool-html-submit').disabled = htmlBusy || !htmlText;
      $('#tool-html-submit').textContent = htmlBusy ? '正在沙箱渲染 PNG…' : '本地渲染 PNG（零计费）';
    }
    $('#tool-html-result').hidden = !htmlResult;
    if (htmlResult) {
      const needsPreview = !htmlResult.url;
      $('#tool-html-preview').hidden = needsPreview;
      $('#tool-html-preview-button').disabled = needsPreview;
      $('#tool-html-reload').hidden = !needsPreview;
      $('#tool-html-reload').disabled = htmlBusy;
      $('#tool-html-download').disabled = needsPreview;
      $('#tool-html-meta').textContent = `${htmlResult.width} × ${htmlResult.height} px · ${htmlResult.artifactId} · PNG（无网络/无脚本沙箱渲染）`;
      updateHandoffButtons('#tool-html-result', !needsPreview);
      htmlOutbox.setTarget({ artifactId: htmlResult.artifactId, mediaType: 'image/png' });
    } else {
      htmlOutbox.setTarget(null);
    }
  }

  // --- Tool 4: Local Zero-Cost Video + Audio Mux ---
  function populateMuxSelect(select, list, emptyText, placeholder) {
    const selected = select.selectedOptions[0];
    select.replaceChildren(new Option(list.length ? placeholder : emptyText, ''),
      ...list.map(item => new Option(optionLabel(item), item.artifactId)));
    if (selected?.value && !list.some(item => item.artifactId === selected.value)) select.add(selected, 1);
    if (selected?.value) select.value = selected.value;
  }

  function renderMuxControls() {
    const supported = muxSupported();
    const muxTab = $('[data-local-tool-tab="mux"]');
    if (muxTab) muxTab.hidden = !supported;
    const writable = canMux();
    $('#tool-mux-readonly-note').hidden = writable || !supported;
    const ready = writable && !muxBusy && Boolean($('#tool-mux-video').value) && Boolean($('#tool-mux-audio').value);
    $('#tool-mux-submit').hidden = !writable;
    $('#tool-mux-submit').disabled = !ready;
    $('#tool-mux-submit').textContent = muxBusy ? '正在本地合成 MP4…' : '合并为带音轨 MP4（零计费）';
    $('#tool-mux-result').hidden = !muxResult;
    if (muxResult) {
      const needsPreview = !muxResult.url;
      $('#tool-mux-output').hidden = needsPreview;
      $('#tool-mux-reload').hidden = !needsPreview;
      $('#tool-mux-reload').disabled = muxBusy;
      $('#tool-mux-download').disabled = needsPreview;
      const m = muxResult.media || {};
      const dims = m.width && m.height ? `${m.width} × ${m.height} · ` : '';
      const dur = Number.isFinite(m.durationSec) ? `${m.durationSec.toFixed(2)}s · ` : '';
      $('#tool-mux-meta').textContent = `${dims}${dur}${formatBytes(muxResult.size)} · ${muxResult.artifactId} · MP4（双来源血缘已保存）`;
      muxOutbox.setTarget({ artifactId: muxResult.artifactId, mediaType: 'video/mp4' });
    } else {
      muxOutbox.setTarget(null);
    }
  }

  async function loadMuxArtifacts() {
    if (!client || !muxSupported()) return;
    muxListController?.abort();
    const controller = muxListController = new AbortController();
    try {
      const [videos, audios] = await Promise.all([
        client.listArtifacts({ kind: 'video', limit: 50, offset: 0 }, { signal: controller.signal }),
        client.listArtifacts({ kind: 'audio', limit: 50, offset: 0 }, { signal: controller.signal })
      ]);
      if (muxListController !== controller) return;
      videoArtifacts = Array.isArray(videos.artifacts) ? videos.artifacts : [];
      audioArtifacts = Array.isArray(audios.artifacts) ? audios.artifacts : [];
      populateMuxSelect($('#tool-mux-video'), videoArtifacts, '当前工作区暂无视频作品', '选择工作区中的视频作品…');
      populateMuxSelect($('#tool-mux-audio'), audioArtifacts, '当前工作区暂无音频/音乐作品', '选择工作区中的音频或音乐作品…');
      renderMuxControls();
    } catch (error) {
      if (muxListController === controller && !controller.signal.aborted) {
        setStatus('#tool-mux-feedback', '音视频目录读取失败：' + describe(error), true);
      }
    } finally {
      if (muxListController === controller) muxListController = null;
    }
  }

  async function loadMuxPreview(slot, artifactId) {
    muxPreviewControllers[slot]?.abort();
    muxPreviewControllers[slot] = null;
    const selector = slot === 'video' ? '#tool-mux-video-preview' : '#tool-mux-audio-preview';
    const select = slot === 'video' ? $('#tool-mux-video') : $('#tool-mux-audio');
    const note = slot === 'video' ? $('#tool-mux-video-note') : $('#tool-mux-audio-note');
    const player = $(selector);
    player.hidden = true;
    releaseImage(selector);
    if (!artifactId || !client) {
      note.textContent = slot === 'video' ? '未选择视频' : '未选择音频';
      renderMuxControls();
      return;
    }
    const controller = muxPreviewControllers[slot] = new AbortController();
    note.textContent = slot === 'video' ? '读取视频预览…' : '读取音频试听…';
    renderMuxControls();
    try {
      const blob = await client.get(`/api/v0/artifacts/${artifactId}/${slot}`, { binary: true, signal: controller.signal });
      if (muxPreviewControllers[slot] !== controller || select.value !== artifactId) return;
      const url = URL.createObjectURL(blob);
      urls.set(selector, url);
      player.src = url;
      player.hidden = false;
      note.textContent = `${artifactId} · ${formatBytes(blob.size)}`;
    } catch (error) {
      if (muxPreviewControllers[slot] === controller && !controller.signal.aborted && select.value === artifactId) {
        note.textContent = '预览读取失败：' + describe(error);
      }
    } finally {
      if (muxPreviewControllers[slot] === controller) muxPreviewControllers[slot] = null;
      renderMuxControls();
    }
  }

  async function runMux({ previewOnly = false } = {}) {
    if (!client || muxBusy) return;
    if (!previewOnly && !canMux()) return;
    if (previewOnly && !muxResult?.artifactId) return;
    muxController?.abort();
    const controller = muxController = new AbortController();
    muxBusy = true;
    setStatus('#tool-mux-feedback', previewOnly ? '正在重新读取合轨视频…' : '正在调用本机 ffmpeg 合轨（零外部计费）…');
    renderMuxControls();
    let saved = previewOnly ? muxResult : null;
    try {
      if (!previewOnly) {
        const videoArtifactId = $('#tool-mux-video').value;
        const audioArtifactId = $('#tool-mux-audio').value;
        const audioFit = $('#tool-mux-fit').value;
        const audioMode = $('#tool-mux-mode').value;
        const audioVolume = $('#tool-mux-volume').valueAsNumber;
        const res = await client.muxVideoAudio({
          videoArtifactId,
          audioArtifactId,
          audioFit,
          audioMode,
          ...(Number.isFinite(audioVolume) ? { audioVolume } : {})
        }, { signal: controller.signal });
        if (muxController !== controller) return;
        if (res.contractVersion !== 0 || !res.artifact?.artifactId) throw new TypeError('不支持的音视频合轨响应');
        releaseImage('#tool-mux-output');
        saved = {
          artifactId: res.artifact.artifactId,
          size: res.artifact.size,
          media: res.media,
          url: null
        };
        muxResult = saved;
        renderMuxControls();
      }
      const blob = await client.get('/api/v0/artifacts/' + saved.artifactId + '/video', { binary: true, signal: controller.signal });
      if (muxController !== controller) return;
      const url = URL.createObjectURL(blob);
      urls.set('#tool-mux-output', url);
      $('#tool-mux-output').src = url;
      saved.url = url;
      setStatus('#tool-mux-feedback', `已保存合轨 MP4 ${saved.artifactId}（零模型调用，双来源血缘已记录）。`);
      void loadMuxArtifacts();
    } catch (error) {
      if (muxController === controller && !controller.signal.aborted) {
        setStatus('#tool-mux-feedback', saved
          ? `合轨视频 ${saved.artifactId} 已保存，但播放读取失败：${describe(error)}（点击“重新读取合轨视频”即可重试）。`
          : error.code === 'IRIS_LOCAL_MEDIA_UNAVAILABLE'
            ? '当前 Core 宿主未安装 ffmpeg / ffprobe，无法执行音视频合轨。'
            : '音视频合轨失败：' + describe(error), true);
      }
    } finally {
      if (muxController === controller) {
        muxBusy = false;
        renderMuxControls();
      }
    }
  }

  async function runHtmlRender({ previewOnly = false } = {}) {
    if (!client || htmlBusy) return;
    if (!previewOnly && !canHtml()) return;
    if (previewOnly && !htmlResult?.artifactId) return;
    htmlController?.abort();
    const controller = htmlController = new AbortController();
    htmlBusy = true;
    setStatus('#tool-html-feedback', previewOnly ? '正在重新读取截图预览…' : '正在本机无头沙箱渲染 PNG（无网络、无脚本、零外部计费）…');
    renderHtmlGate();
    let saved = previewOnly ? htmlResult : null;
    try {
      if (!previewOnly) {
        const html = $('#tool-html-input').value;
        const width = $('#tool-html-width').valueAsNumber;
        const height = $('#tool-html-height').valueAsNumber;
        const fullPage = $('#tool-html-fullpage').checked;
        const res = await client.renderHtml({
          html,
          ...(Number.isSafeInteger(width) ? { width } : {}),
          ...(Number.isSafeInteger(height) ? { height } : {}),
          fullPage
        }, { signal: controller.signal });
        if (htmlController !== controller) return;
        if (res.contractVersion !== 0 || !res.artifact?.artifactId) throw new TypeError('不支持的 HTML 截图响应');
        releaseImage('#tool-html-preview');
        saved = {
          artifactId: res.artifact.artifactId,
          width: res.artifact.width,
          height: res.artifact.height,
          url: null,
          blob: null
        };
        htmlResult = saved;
        renderHtmlGate();
      }
      const blob = await client.get('/api/v0/artifacts/' + saved.artifactId + '/content', { binary: true, signal: controller.signal });
      if (htmlController !== controller) return;
      const url = await decodePreview('#tool-html-preview', blob);
      if (htmlController !== controller) return;
      saved.blob = blob;
      saved.url = url;
      setStatus('#tool-html-feedback', `已保存沙箱渲染截图 ${saved.artifactId}（${saved.width} × ${saved.height} px，零模型调用）。`);
      void loadArtifacts();
    } catch (error) {
      if (htmlController === controller && !controller.signal.aborted) {
        setStatus('#tool-html-feedback', saved
          ? `截图 ${saved.artifactId} 已保存，但预览读取失败：${describe(error)}（点击“重新读取截图预览”即可重试）。`
          : 'HTML 截图失败：' + describe(error), true);
      }
    } finally {
      if (htmlController === controller) {
        htmlBusy = false;
        renderHtmlGate();
      }
    }
  }

  // --- Inline Artifact Lineage Inspector inside Local Tools ---
  function closeLineage() {
    lineageController?.abort(); lineageController = null; lineageStack = [];
    lineagePreview.clear();
    $('#tool-lineage-panel').hidden = true;
    $('#tool-lineage-body').replaceChildren();
    setStatus('#tool-lineage-feedback', '');
  }

  async function inspectArtifactLineage(artifactId, path = [...lineageStack, artifactId]) {
    if (!client || !artifactId) return;
    lineageController?.abort();
    lineagePreview.clear();
    const controller = lineageController = new AbortController();
    const panel = $('#tool-lineage-panel');
    panel.hidden = false;
    setStatus('#tool-lineage-feedback', '正在读取作品来源与派生血缘…');
    try {
      const data = await client.getArtifactLineage(artifactId, { signal: controller.signal });
      if (lineageController !== controller) return;
      if (data.contractVersion !== 0) throw new TypeError('不支持的血缘响应');
      lineageStack = path;
      setStatus('#tool-lineage-feedback', '');
      renderArtifactLineageView($('#tool-lineage-body'), data, {
        canCrop: canCrop(),
        canDiff: canDiff(),
        backLabel: '← 上一件作品',
        onBack: path.length < 2 ? undefined : () => {
          const previous = lineageStack.slice(0, -1);
          void inspectArtifactLineage(previous.at(-1), previous);
        },
        onPreview: item => lineagePreview.show(client, item),
        onCrop: id => openTool('crop', { artifactId: id }),
        onDiff: id => openTool('diff', { artifactId: id }),
        onOpenRun: openRun,
        onInspectArtifact: id => { void inspectArtifactLineage(id); }
      });
    } catch (error) {
      if (lineageController === controller && !controller.signal.aborted) {
        setStatus('#tool-lineage-feedback', '血缘读取失败：' + describe(error), true);
      }
    }
  }

  function openTool(tool = 'crop', { artifactId, secondArtifactId, videoArtifactId, audioArtifactId } = {}) {
    setTool(tool);
    if (tool === 'crop' && artifactId) {
      selectArtifact($('#tool-crop-select'), artifactId);
      void loadCropSource(artifactId);
    } else if (tool === 'diff' && (artifactId || secondArtifactId)) {
      const currentA = $('#tool-diff-a').value;
      const nextA = artifactId || currentA;
      const nextB = secondArtifactId || (currentA && artifactId && currentA !== artifactId ? currentA : $('#tool-diff-b').value);
      for (const [slot, id] of [['a', nextA], ['b', nextB]]) {
        if (!id) continue;
        selectArtifact($('#tool-diff-' + slot), id);
        void loadDiffThumb(slot, id);
      }
    } else if (tool === 'mux' && muxSupported()) {
      const vId = videoArtifactId || artifactId;
      const aId = audioArtifactId || secondArtifactId;
      void loadMuxArtifacts().then(() => {
        if (vId && activeTool === 'mux') {
          selectArtifact($('#tool-mux-video'), vId);
          void loadMuxPreview('video', vId);
        }
        if (aId && activeTool === 'mux') {
          selectArtifact($('#tool-mux-audio'), aId);
          void loadMuxPreview('audio', aId);
        }
      });
    }
  }

  // --- Wire UI events ---
  for (const button of document.querySelectorAll('#local-tools-tabs [data-local-tool-tab]')) {
    button.addEventListener('click', () => setTool(button.dataset.localToolTab));
  }
  $('#tools-refresh').addEventListener('click', () => {
    void loadArtifacts();
    if (muxSupported()) void loadMuxArtifacts();
    if (activeTool === 'plugins') pluginOpForm.refresh();
  });
  $('#tools-more').addEventListener('click', () => { void loadArtifacts({ more: true }); });
  $('#tool-crop-select').addEventListener('change', event => { void loadCropSource(event.target.value); });
  $('#tool-crop-toggle-box').addEventListener('click', () => {
    if (!cropState) return;
    cropState.showBox = !cropState.showBox;
    renderCropView();
  });
  $('#tool-crop-toggle-scrim').addEventListener('click', () => {
    if (!cropState || !cropState.showBox) return;
    cropState.showScrim = !cropState.showScrim;
    renderCropView();
  });
  $('#tool-crop-stage-preview').addEventListener('click', () => {
    if (!cropState?.sourceUrl) return;
    openOverlayPreview(cropState.sourceUrl, '本地裁剪预览 · ' + cropState.artifactId, currentCropOverlaySpec());
  });
  for (const [, id] of CROP_INPUTS) {
    $('#' + id).addEventListener('input', () => {
      if (!cropState?.meta?.image) return;
      const raw = Object.fromEntries(CROP_INPUTS.map(([key, inputId]) => [key, $('#' + inputId).value]));
      if (Object.values(raw).some(value => value === '' || !Number.isFinite(Number(value)))) return;
      cropState.cropRect = clampCropRect(raw, cropState.meta.image.width, cropState.meta.image.height);
      renderCropView();
    });
    $('#' + id).addEventListener('change', () => {
      if (!cropState?.meta?.image || !cropState.cropRect) return;
      const fallback = cropState.cropRect;
      const raw = Object.fromEntries(CROP_INPUTS.map(([key, inputId]) => {
        const value = $('#' + inputId).value;
        return [key, value === '' ? fallback[key] : Number(value)];
      }));
      cropState.cropRect = clampCropRect(raw, cropState.meta.image.width, cropState.meta.image.height);
      syncInputs(cropState.cropRect);
      renderCropView();
    });
  }
  $('#tool-crop-reset').addEventListener('click', () => {
    if (!cropState?.meta?.image) return;
    const { width, height } = cropState.meta.image;
    cropState.cropRect = { left: 0, top: 0, width, height };
    syncInputs(cropState.cropRect);
    renderCropView();
  });
  $('#tool-crop-submit').addEventListener('click', () => { void runCrop(); });
  $('#tool-crop-reload').addEventListener('click', () => { void runCrop({ previewOnly: true }); });
  $('#tool-crop-download').addEventListener('click', () => {
    if (cropState?.cropped?.url) triggerDownload(cropState.cropped.url, 'iris-' + cropState.cropped.artifactId + '.png');
  });
  $('#tool-crop-lineage').addEventListener('click', () => {
    if (cropState?.cropped) void inspectArtifactLineage(cropState.cropped.artifactId, [cropState.cropped.artifactId]);
  });
  for (const button of document.querySelectorAll('#tool-crop-result [data-tool-handoff]')) {
    button.addEventListener('click', () => {
      const cropped = cropState?.cropped;
      if (!cropped?.artifactId) return;
      handoffImage(button.dataset.toolHandoff, {
        file: cropped.blob || undefined,
        artifactId: cropped.artifactId,
        label: `本地裁剪图 · ${cropped.width} × ${cropped.height}`
      });
    });
  }

  $('#tool-diff-a').addEventListener('change', event => { void loadDiffThumb('a', event.target.value); });
  $('#tool-diff-b').addEventListener('change', event => { void loadDiffThumb('b', event.target.value); });
  $('#tool-diff-form').addEventListener('submit', event => {
    event.preventDefault();
    if ($('#tool-diff-form').reportValidity()) void runDiff();
  });
  $('#tool-diff-reload').addEventListener('click', () => { void runDiff({ previewOnly: true }); });
  $('#tool-diff-heatmap-button').addEventListener('click', () => {
    if (diffResult?.url) openPreview(diffResult.url, '像素对比热力图 · ' + diffResult.artifactId);
  });
  $('#tool-diff-download').addEventListener('click', () => {
    if (diffResult?.url) triggerDownload(diffResult.url, 'iris-' + diffResult.artifactId + '.png');
  });
  $('#tool-diff-lineage').addEventListener('click', () => {
    if (diffResult) void inspectArtifactLineage(diffResult.artifactId, [diffResult.artifactId]);
  });

  $('#tool-html-input').addEventListener('input', () => renderHtmlGate());
  $('#tool-html-form').addEventListener('submit', event => {
    event.preventDefault();
    if ($('#tool-html-form').reportValidity()) void runHtmlRender();
  });
  $('#tool-html-reload').addEventListener('click', () => { void runHtmlRender({ previewOnly: true }); });
  $('#tool-html-preview-button').addEventListener('click', () => {
    if (htmlResult?.url) openPreview(htmlResult.url, 'HTML 沙箱截图 · ' + htmlResult.artifactId);
  });
  $('#tool-html-download').addEventListener('click', () => {
    if (htmlResult?.url) triggerDownload(htmlResult.url, 'iris-' + htmlResult.artifactId + '.png');
  });
  $('#tool-html-lineage').addEventListener('click', () => {
    if (htmlResult) void inspectArtifactLineage(htmlResult.artifactId, [htmlResult.artifactId]);
  });
  for (const button of document.querySelectorAll('#tool-html-result [data-tool-handoff]')) {
    button.addEventListener('click', () => {
      if (!htmlResult?.artifactId) return;
      if (button.dataset.toolHandoff === 'crop') {
        openTool('crop', { artifactId: htmlResult.artifactId });
        return;
      }
      handoffImage(button.dataset.toolHandoff, {
        file: htmlResult.blob || undefined,
        artifactId: htmlResult.artifactId,
        label: `HTML 截图 · ${htmlResult.width} × ${htmlResult.height}`
      });
    });
  }

  function wireCopyId(selector, getId, feedbackSelector) {
    $(selector)?.addEventListener('click', async () => {
      const id = getId();
      if (!id) return;
      const ok = await copyTextValue(id);
      setStatus(feedbackSelector, ok ? `已复制作品 ID：${id}` : `请手动复制作品 ID：${id}`, !ok);
    });
  }
  wireCopyId('#tool-crop-copy-id', () => cropState?.cropped?.artifactId, '#tool-crop-feedback');
  wireCopyId('#tool-diff-copy-id', () => diffResult?.artifactId, '#tool-diff-feedback');
  wireCopyId('#tool-html-copy-id', () => htmlResult?.artifactId, '#tool-html-feedback');
  wireCopyId('#tool-mux-copy-id', () => muxResult?.artifactId, '#tool-mux-feedback');

  $('#tool-mux-video').addEventListener('change', event => { void loadMuxPreview('video', event.target.value); });
  $('#tool-mux-audio').addEventListener('change', event => { void loadMuxPreview('audio', event.target.value); });
  $('#tool-mux-form').addEventListener('submit', event => {
    event.preventDefault();
    if ($('#tool-mux-form').reportValidity()) void runMux();
  });
  $('#tool-mux-reload').addEventListener('click', () => { void runMux({ previewOnly: true }); });
  $('#tool-mux-download').addEventListener('click', () => {
    if (muxResult?.url) triggerDownload(muxResult.url, 'iris-' + muxResult.artifactId + '.mp4');
  });
  $('#tool-mux-lineage').addEventListener('click', () => {
    if (muxResult) void inspectArtifactLineage(muxResult.artifactId, [muxResult.artifactId]);
  });

  $('#tool-lineage-close').addEventListener('click', closeLineage);

  return Object.freeze({
    connect(http, info) {
      client = http;
      session = info;
      artifacts = [];
      videoArtifacts = [];
      audioArtifacts = [];
      pluginOpForm.connect(http, info);
      renderHtmlGate();
      renderDiffControls();
      renderMuxControls();
      renderCropView();
      for (const ctrl of [cropOutbox, diffOutbox, htmlOutbox, muxOutbox]) ctrl.refresh();
    },
    show(nextVisible) {
      const opening = nextVisible && !visible;
      visible = nextVisible;
      if (!visible) {
        lineagePreview.clear();
        for (const id of ['tool-mux-video-preview', 'tool-mux-audio-preview', 'tool-mux-output']) $('#' + id)?.pause();
      }
      if (opening && client && !artifacts.length && !listController) {
        renderHtmlGate();
        renderDiffControls();
        renderMuxControls();
        renderCropView();
        void loadArtifacts();
      }
      if (opening && activeTool === 'mux' && muxSupported() && !videoArtifacts.length && !audioArtifacts.length && !muxListController) {
        void loadMuxArtifacts();
      }
      if (opening && activeTool === 'plugins') void pluginOpForm.activate();
    },
    openTool,
    inspectArtifactLineage(artifactId) { void inspectArtifactLineage(artifactId, [artifactId]); },
    disconnect() {
      pluginOpForm.disconnect();
      for (const ctrl of [cropOutbox, diffOutbox, htmlOutbox, muxOutbox]) ctrl.reset();
      listController?.abort(); listController = null; nextOffset = null;
      muxListController?.abort(); muxListController = null;
      cropController?.abort(); cropController = null;
      cropActionController?.abort(); cropActionController = null;
      diffController?.abort(); diffController = null; diffBusy = false;
      diffThumbControllers.a?.abort(); diffThumbControllers.a = null;
      diffThumbControllers.b?.abort(); diffThumbControllers.b = null;
      diffThumbIds.a = diffThumbIds.b = null;
      muxController?.abort(); muxController = null; muxBusy = false;
      muxPreviewControllers.video?.abort(); muxPreviewControllers.video = null;
      muxPreviewControllers.audio?.abort(); muxPreviewControllers.audio = null;
      htmlController?.abort(); htmlController = null; htmlBusy = false;
      closeLineage();
      for (const selector of urls.keys()) releaseImage(selector);
      client = null; session = null; visible = false; activeTool = 'crop';
      artifacts = []; videoArtifacts = []; audioArtifacts = []; cropState = null; diffResult = null; muxResult = null; htmlResult = null;
      $('#tool-crop-select').replaceChildren();
      $('#tool-diff-a').replaceChildren();
      $('#tool-diff-b').replaceChildren();
      $('#tool-mux-video').replaceChildren();
      $('#tool-mux-audio').replaceChildren();
      $('#tool-mux-video-preview').hidden = $('#tool-mux-audio-preview').hidden = true;
      $('#tool-mux-video-note').textContent = '未选择视频';
      $('#tool-mux-audio-note').textContent = '未选择音频';
      $('#tool-mux-fit').value = 'shortest';
      $('#tool-mux-mode').value = 'replace';
      $('#tool-mux-volume').value = '1';
      $('#tools-more').hidden = $('#tools-more').disabled = true;
      $('#tool-diff-preview-a').hidden = $('#tool-diff-preview-b').hidden = true;
      $('#tool-diff-note-a').textContent = $('#tool-diff-note-b').textContent = '未选择图片';
      $('#tool-crop-placeholder').textContent = '从上方选择一张静态图片，即可按原图像素坐标实时预览并裁剪。';
      for (const [, id] of CROP_INPUTS) {
        const input = $('#' + id);
        input.value = '';
        input.removeAttribute('max');
      }
      for (const selector of ['#tool-crop-result-meta', '#tool-diff-summary', '#tool-diff-sources', '#tool-html-meta', '#tool-mux-meta']) {
        $(selector).textContent = '';
      }
      $('#tool-diff-regions').replaceChildren();
      $('#tool-html-input').value = '';
      $('#tool-html-width').value = '1280';
      $('#tool-html-height').value = '720';
      $('#tool-html-fullpage').checked = true;
      for (const id of ['#tools-feedback', '#tool-crop-feedback', '#tool-diff-feedback', '#tool-mux-feedback', '#tool-html-feedback']) {
        setStatus(id, '');
      }
      renderLocateSvg($('#tool-crop-overlay'), null);
      setTool('crop');
    }
  });
}
