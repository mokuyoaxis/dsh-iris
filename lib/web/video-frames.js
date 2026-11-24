const $ = selector => document.querySelector(selector);
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png' };

export function createVideoFramesPanel({ describe, openPreview, useFrames, handoffFrame, onCropFrame, onInspectArtifact }) {
  const panel = $('#video-frames'), form = $('#video-frames-form'), results = $('#frame-results');
  const status = $('#frame-status'), handoff = $('#summarize-frames'), lastFrameBtn = $('#extract-last-frame');
  let source, controller, frames = [];
  const selected = new Set(), urls = new Set();

  function clearFrames() {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear(); frames = []; selected.clear(); results.replaceChildren();
    handoff.hidden = true; handoff.disabled = true;
  }

  function reset() {
    controller?.abort(); controller = null; source = null;
    clearFrames();
    $('#video-frames-fields').disabled = false; $('#extract-frames').disabled = false;
    if (lastFrameBtn) lastFrameBtn.disabled = false;
    form.reset(); status.textContent = ''; panel.open = false; panel.hidden = true;
  }

  function updateSelection() {
    handoff.hidden = !source.canSummarize || !frames.length;
    handoff.disabled = !selected.size;
    status.textContent = source.canSummarize
      ? '已选 ' + selected.size + ' / ' + frames.length + ' 帧'
      : frames.length === 1 && frames[0].sampleMode === 'last'
        ? '已提取尾帧（可用于续拍图生视频或改图）'
        : '已提取 ' + frames.length + ' 帧';
  }

  function renderFrame(frame, activeSource, signal) {
    const { client, canSummarize, canI2v, canEdit, canS2v, canCrop } = activeSource;
    const isLast = frame.sampleMode === 'last';
    const label = (isLast ? '尾帧' : '第 ' + frame.frameIndex + ' 帧') + ' · ' + Number(frame.atSec.toFixed(3)) + ' 秒';
    const item = document.createElement('li');
    item.dataset.frameArtifactId = frame.artifactId;
    if (isLast) item.dataset.frameSampleMode = 'last';
    const preview = document.createElement('button');
    preview.className = 'frame-preview quiet';
    preview.type = 'button'; preview.disabled = true;
    preview.setAttribute('aria-label', '查看' + label);
    const image = document.createElement('img'); image.alt = ''; image.hidden = true;
    const caption = document.createElement('span'); caption.textContent = label;
    preview.append(image, caption);
    preview.addEventListener('click', () => openPreview(image.src, label));
    const actions = document.createElement('div'); actions.className = 'frame-actions';
    let loadedBlob = null;
    if (canSummarize) {
      const choice = document.createElement('label');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true;
      checkbox.setAttribute('aria-label', '选择' + label);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(frame.artifactId); else selected.delete(frame.artifactId);
        updateSelection();
      });
      choice.append(checkbox, '选入摘要'); actions.append(choice);
    }
    const download = document.createElement('a');
    download.textContent = '下载'; download.setAttribute('aria-label', '下载' + label); download.hidden = true;
    actions.append(download);
    const addHandoff = (targetMode, text) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quiet';
      btn.textContent = text;
      btn.dataset.frameHandoff = targetMode;
      btn.addEventListener('click', () => handoffFrame?.(targetMode, {
        artifactId: frame.artifactId,
        file: loadedBlob || undefined,
        label: `视频${label}`
      }));
      actions.append(btn);
    };
    if (canI2v && handoffFrame) addHandoff('video-i2v', '图生视频');
    if (canEdit && handoffFrame) addHandoff('edit', '改图');
    if (canS2v && handoffFrame) addHandoff('video-s2v', '数字人首帧');
    if (canCrop && onCropFrame) {
      const cropBtn = document.createElement('button');
      cropBtn.type = 'button'; cropBtn.className = 'quiet'; cropBtn.textContent = '裁剪';
      cropBtn.dataset.frameHandoff = 'crop';
      cropBtn.addEventListener('click', () => onCropFrame(frame.artifactId));
      actions.append(cropBtn);
    }
    if (onInspectArtifact) {
      const lineageBtn = document.createElement('button');
      lineageBtn.type = 'button'; lineageBtn.className = 'quiet'; lineageBtn.textContent = '血缘';
      lineageBtn.dataset.frameLineage = frame.artifactId;
      lineageBtn.addEventListener('click', () => onInspectArtifact(frame.artifactId));
      actions.append(lineageBtn);
    }
    item.append(preview, actions);
    void client.get('/api/v0/artifacts/' + frame.artifactId + '/content', { binary: true, signal }).then(blob => {
      if (signal.aborted) return;
      if (blob.type !== frame.mediaType) throw new TypeError('帧媒体类型与原作品不一致');
      loadedBlob = blob;
      const url = URL.createObjectURL(blob); urls.add(url);
      image.src = url; image.hidden = false; preview.disabled = false;
      download.href = url; download.download = 'iris-' + frame.artifactId + '.' + EXTENSIONS[frame.mediaType]; download.hidden = false;
    }).catch(error => { if (!signal.aborted) caption.textContent = label + ' · 预览读取失败：' + describe(error); });
    return item;
  }

  async function runExtraction(mode = 'uniform') {
    if (!source || $('#extract-frames').disabled) return;
    if (mode === 'uniform' && !form.reportValidity()) return;
    controller?.abort(); controller = new AbortController();
    const { signal } = controller;
    const activeSource = source;
    const { artifactId, client } = activeSource;
    clearFrames();
    $('#video-frames-fields').disabled = true; $('#extract-frames').disabled = true;
    if (lastFrameBtn) lastFrameBtn.disabled = true;
    status.textContent = mode === 'last' ? '正在本地提取视频尾帧…' : '正在本地提取视频帧…';
    try {
      const targetWidth = Number.isFinite($('#frame-width').valueAsNumber) && $('#frame-width').valueAsNumber >= 16
        ? $('#frame-width').valueAsNumber : (mode === 'last' ? 1280 : 480);
      const format = $('#frame-format').value || 'png';
      const response = await client.extractFrames(mode === 'last'
        ? { artifactId, mode: 'last', targetWidth, format }
        : { artifactId, maxFrames: $('#frame-limit').valueAsNumber, targetWidth, format }, { signal });
      if (signal.aborted) return;
      if (response.contractVersion !== 0 || response.sourceArtifactId !== artifactId || !response.frames?.length
          || response.frames.length > 20 || response.frames.some(frame => !/^artifact_[a-f0-9]{24}$/.test(frame.artifactId)
            || !Object.hasOwn(EXTENSIONS, frame.mediaType) || !Number.isFinite(frame.atSec) || !Number.isInteger(frame.frameIndex))) {
        throw new TypeError('抽帧结果与原视频不一致');
      }
      frames = response.frames;
      if (activeSource.canSummarize) for (const frame of frames) selected.add(frame.artifactId);
      results.replaceChildren(...frames.map(frame => renderFrame(frame, activeSource, signal)));
      updateSelection();
    } catch (error) {
      if (!signal.aborted) status.textContent = error.code === 'IRIS_LOCAL_MEDIA_UNAVAILABLE'
        ? '当前 Core 宿主无法抽帧，需要 ffmpeg 和 ffprobe。' : '抽帧失败：' + describe(error);
    } finally {
      if (!signal.aborted) {
        $('#video-frames-fields').disabled = false; $('#extract-frames').disabled = false;
        if (lastFrameBtn) lastFrameBtn.disabled = false;
      }
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    await runExtraction('uniform');
  });
  lastFrameBtn?.addEventListener('click', () => { void runExtraction('last'); });
  handoff.addEventListener('click', () => {
    if (!handoff.disabled) useFrames(frames.filter(frame => selected.has(frame.artifactId)).map(frame => frame.artifactId));
  });

  return Object.freeze({
    reset,
    show(value) { source = value; panel.hidden = false; }
  });
}
