// Reusable inline controller for exporting a saved Artifact to Core's controlled --outbox-dir.
export const OUTBOX_EXTENSIONS = Object.freeze({
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm',
  'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/flac': '.flac',
  'text/plain': '.txt', 'application/json': '.json'
});

const UNSAFE_NAME = /[/\\\x00-\x1f\x7f<>:"|?*]/;
const RESERVED_BASE = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/i;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  return bytes < 1024 ? bytes + ' B' : bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KiB' : (bytes / (1024 * 1024)).toFixed(2) + ' MiB';
}

export function suggestedOutboxName(artifactId, mediaType) {
  const ext = OUTBOX_EXTENSIONS[mediaType];
  return artifactId && ext ? `iris-${artifactId}${ext}` : '';
}

export function validateOutboxFilename(name, mediaType) {
  const trimmed = String(name || '').trim();
  const ext = OUTBOX_EXTENSIONS[mediaType];
  if (!ext) return '当前作品格式不支持受控出件。';
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.startsWith('.') || /[ .]$/.test(trimmed) || UNSAFE_NAME.test(trimmed)) {
    return '请填写合法的顶层裸文件名（不含路径分隔符、特殊字符或前导点）。';
  }
  if (new TextEncoder().encode(trimmed).byteLength > 255) return '文件名 UTF-8 长度不能超过 255 字节。';
  if (RESERVED_BASE.test(trimmed.split('.')[0].trimEnd())) return '文件名不能使用系统保留名。';
  const dot = trimmed.lastIndexOf('.');
  const actualExt = dot > 0 ? trimmed.slice(dot).toLowerCase() : '';
  const okExt = actualExt === ext || (mediaType === 'image/jpeg' && actualExt === '.jpeg');
  if (!okExt) return `扩展名须匹配作品类型（需要 ${mediaType === 'image/jpeg' ? '.jpg 或 .jpeg' : ext}）。`;
  return '';
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

/**
 * Mount a reusable inline outbox export toggle + form inside an existing container element.
 * Hidden automatically when --outbox-dir is disabled or caller lacks outbox.export.
 */
export function createOutboxExportControl({ container, getClient, canExport, describe, onExported, triggerLabel = '导出到出件目录' }) {
  let target = null;
  let pendingKey = null;
  let pendingName = '';
  let busy = false;
  let controller = null;

  const wrap = el('div', undefined, 'outbox-export-control');
  wrap.hidden = true;

  const trigger = el('button', triggerLabel, 'secondary outbox-export-trigger');
  trigger.type = 'button';
  trigger.dataset.outboxTrigger = 'true';

  const panel = el('form', undefined, 'outbox-export-form');
  panel.hidden = true;
  const label = el('label', '出件文件名（仅顶层裸名，绝不覆盖已有文件）', 'field-label');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 255;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.required = true;
  input.dataset.outboxFilename = 'true';
  label.append(input);

  const actions = el('div', undefined, 'export-actions');
  const submit = el('button', '确认落盘到出件目录', 'secondary');
  submit.type = 'submit';
  submit.dataset.outboxSubmit = 'true';
  const cancel = el('button', '收起', 'quiet');
  cancel.type = 'button';
  actions.append(submit, cancel);

  const feedback = el('p', '', 'field-note');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  feedback.hidden = true;

  panel.append(label, actions, feedback);
  wrap.append(trigger, panel);
  container.append(wrap);

  function setFeedback(text = '', error = false) {
    feedback.hidden = !text;
    feedback.textContent = text;
    feedback.classList.toggle('error', error);
  }

  function syncVisibility() {
    const allowed = Boolean(target?.artifactId && OUTBOX_EXTENSIONS[target.mediaType] && canExport?.());
    wrap.hidden = !allowed;
    if (!allowed) {
      panel.hidden = true;
      setFeedback('');
    }
    trigger.disabled = busy;
    input.disabled = busy;
    submit.disabled = busy;
    submit.textContent = busy ? '正在安全落盘…' : pendingKey ? '按原 UUID 核对落盘' : '确认落盘到出件目录';
  }

  trigger.addEventListener('click', () => {
    if (!target || busy) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      if (!input.value.trim()) input.value = suggestedOutboxName(target.artifactId, target.mediaType);
      input.focus();
      input.select();
    }
  });

  cancel.addEventListener('click', () => {
    if (busy) return;
    panel.hidden = true;
  });

  input.addEventListener('input', () => {
    if (pendingKey && input.value.trim() !== pendingName) {
      pendingKey = null;
      pendingName = '';
      syncVisibility();
    }
  });

  panel.addEventListener('submit', async event => {
    event.preventDefault();
    const client = getClient?.();
    if (!client || !target || busy || !canExport?.()) return;
    const name = input.value.trim();
    const issue = validateOutboxFilename(name, target.mediaType);
    if (issue) {
      setFeedback(issue, true);
      input.focus();
      return;
    }
    const key = pendingKey && pendingName === name ? pendingKey : crypto.randomUUID();
    pendingKey = key;
    pendingName = name;
    busy = true;
    controller?.abort();
    controller = new AbortController();
    const activeTarget = target;
    setFeedback('正在校验原字节并原子写入出件目录…');
    syncVisibility();
    try {
      const result = await client.exportOutbox({ artifactId: activeTarget.artifactId, name }, { key, signal: controller.signal });
      if (target !== activeTarget) return;
      pendingKey = null;
      pendingName = '';
      setFeedback(`已安全落盘到出件目录：${result.name}（${formatBytes(result.bytes)}）`);
      onExported?.(result);
    } catch (error) {
      if (target !== activeTarget || controller?.signal.aborted) return;
      if (error?.code === 'IRIS_OUTBOX_FILE_EXISTS' || error?.code === 'IRIS_OUTBOX_INPUT_INVALID') {
        pendingKey = null;
        pendingName = '';
        setFeedback(error.code === 'IRIS_OUTBOX_FILE_EXISTS' ? '出件目录已存在同名文件，请修改文件名后再试。' : describe(error), true);
        input.focus();
      } else if (error?.code === 'IRIS_OUTBOX_UNCONFIRMED') {
        setFeedback('未能确认原出件的落盘归属，已保留原 UUID；请勿改名，可点击“按原 UUID 核对落盘”或在本机检查出件目录。', true);
      } else {
        setFeedback('出件请求未确认完成：' + describe(error) + '。可保持原文件名点击按钮按原 UUID 核对。', true);
      }
    } finally {
      if (target === activeTarget) {
        busy = false;
        syncVisibility();
      }
    }
  });

  return Object.freeze({
    element: wrap,
    setTarget(next) {
      const same = next && target && next.artifactId === target.artifactId && next.mediaType === target.mediaType;
      if (same) { syncVisibility(); return; }
      controller?.abort();
      controller = null;
      busy = false;
      pendingKey = null;
      pendingName = '';
      target = next && next.artifactId && next.mediaType ? { artifactId: next.artifactId, mediaType: next.mediaType } : null;
      panel.hidden = true;
      input.value = target ? suggestedOutboxName(target.artifactId, target.mediaType) : '';
      setFeedback('');
      syncVisibility();
    },
    refresh() { syncVisibility(); },
    reset() {
      controller?.abort();
      controller = null;
      busy = false;
      pendingKey = null;
      pendingName = '';
      target = null;
      panel.hidden = true;
      input.value = '';
      setFeedback('');
      syncVisibility();
    }
  });
}
