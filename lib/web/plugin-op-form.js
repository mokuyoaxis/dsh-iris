// Host-owned Schema-driven Auto Form for plugin operations (zero inline styles, strict CSP safe).
import { formatArtifactKind, formatBytes } from './lineage.js';
import { createCopyIdButton } from './clipboard.js';
import { createOutboxExportControl } from './outbox-export.js';

const $ = selector => document.querySelector(selector);
const ARTIFACT_PATTERN = '^artifact_[a-f0-9]{24}$';
const ARTIFACT_ID = /^artifact_[a-f0-9]{24}$/;
const ACTIVE_STATES = new Set(['queued', 'running']);
const MEDIA_ROUTES = {
  'image/png': ['content', 'png'], 'image/jpeg': ['content', 'jpg'], 'image/webp': ['content', 'webp'],
  'audio/wav': ['audio', 'wav'], 'audio/mpeg': ['audio', 'mp3'], 'audio/ogg': ['audio', 'ogg'], 'audio/flac': ['audio', 'flac'],
  'video/mp4': ['video', 'mp4'], 'video/webm': ['video', 'webm'],
  'text/plain': ['text', 'txt'], 'application/json': ['json', 'json']
};
const MEDIA_KIND_LABELS = { image: '图片', audio: '音频', video: '视频', text: '文本', json: 'JSON' };

function artifactMediaKind(mediaType) {
  if (typeof mediaType !== 'string') return null;
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('video/')) return 'video';
  if (mediaType === 'text/plain') return 'text';
  if (mediaType === 'application/json') return 'json';
  return null;
}

function sameJsonValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((item, i) => sameJsonValue(item, b[i]));
  const keysA = Object.keys(a), keysB = Object.keys(b);
  return keysA.length === keysB.length && keysA.every(k => Object.hasOwn(b, k) && sameJsonValue(a[k], b[k]));
}

/** Pure projection from an operation catalog entry to form field descriptors. */
export function schemaFieldSpecs(operation) {
  const schema = operation?.inputSchema;
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object') return [];
  const requiredSet = new Set(Array.isArray(schema.required) ? schema.required : []);
  const artifactInputs = new Set(Array.isArray(operation.artifactInputs) ? operation.artifactInputs : []);
  const typeMap = operation.artifactInputTypes && typeof operation.artifactInputTypes === 'object' ? operation.artifactInputTypes : {};
  return Object.entries(schema.properties).map(([name, prop]) => {
    const isScalarArtifact = prop?.type === 'string' && (artifactInputs.has(name) || prop.pattern === ARTIFACT_PATTERN);
    const isArrayArtifact = prop?.type === 'array' && prop.items?.type === 'string'
      && (artifactInputs.has(name) || prop.items.pattern === ARTIFACT_PATTERN);
    const allowedMediaKinds = isScalarArtifact || isArrayArtifact
      ? (Array.isArray(typeMap[name]) && typeMap[name].length ? [...typeMap[name]] : ['image'])
      : [];
    const hasConst = Object.hasOwn(prop || {}, 'const');
    const enumValues = Array.isArray(prop?.enum) ? prop.enum.map(item => structuredClone(item)) : null;
    const itemType = prop?.items?.type || undefined;
    const isStructured = !isScalarArtifact && !isArrayArtifact && !enumValues && !hasConst
      && (prop?.type === 'object' || prop?.type === 'array' || prop?.type === 'null' || Array.isArray(prop?.anyOf) || !prop?.type);
    return {
      name,
      type: prop?.type || (isStructured ? 'json' : 'string'),
      required: requiredSet.has(name),
      title: typeof prop?.title === 'string' && prop.title.trim() ? prop.title.trim() : name,
      description: typeof prop?.description === 'string' ? prop.description.trim() : '',
      isArtifact: isScalarArtifact,
      isArtifactArray: isArrayArtifact,
      isStructured,
      hasConst,
      constValue: hasConst ? structuredClone(prop.const) : undefined,
      allowedMediaKinds,
      enumValues,
      min: Number.isFinite(prop?.minimum) ? prop.minimum : undefined,
      max: Number.isFinite(prop?.maximum) ? prop.maximum : undefined,
      exclusiveMin: Number.isFinite(prop?.exclusiveMinimum) ? prop.exclusiveMinimum : undefined,
      exclusiveMax: Number.isFinite(prop?.exclusiveMaximum) ? prop.exclusiveMaximum : undefined,
      minLength: Number.isSafeInteger(prop?.minLength) ? prop.minLength : undefined,
      maxLength: Number.isSafeInteger(prop?.maxLength) ? prop.maxLength : undefined,
      pattern: typeof prop?.pattern === 'string' ? prop.pattern : undefined,
      minItems: Number.isSafeInteger(prop?.minItems) ? prop.minItems : undefined,
      maxItems: Number.isSafeInteger(prop?.maxItems) ? prop.maxItems : undefined,
      uniqueItems: prop?.uniqueItems === true,
      itemType,
      defaultValue: prop?.default
    };
  });
}

/** Pure collector & validator turning raw field values into a strict JSON payload. */
export function collectSchemaFormInput(specs, rawValues) {
  const payload = {};
  for (const field of specs) {
    const raw = rawValues[field.name];
    if (field.isArtifactArray) {
      const list = Array.isArray(raw) ? raw.filter(Boolean) : [];
      const minItems = field.minItems ?? 0;
      if (!list.length) {
        if (!field.required) continue;
        if (minItems > 0) throw new Error(`${field.title} 至少需要 ${minItems} 项`);
        payload[field.name] = [];
        continue;
      }
      if (list.length < minItems) throw new Error(`${field.title} 至少需要 ${minItems} 项`);
      if (field.maxItems !== undefined && list.length > field.maxItems) throw new Error(`${field.title} 最多允许 ${field.maxItems} 项`);
      if (field.uniqueItems && new Set(list).size !== list.length) throw new Error(`${field.title} 不能包含重复作品`);
      if (list.some(item => !ARTIFACT_ID.test(item))) throw new Error(`${field.title} 包含无效作品 ID`);
      payload[field.name] = list;
      continue;
    }
    if (field.hasConst) {
      if (sameJsonValue(raw, field.constValue)) {
        payload[field.name] = structuredClone(field.constValue);
        continue;
      }
      if (raw === undefined || raw === '') {
        if (field.required) throw new Error(`${field.title} 不能为空`);
        continue;
      }
      throw new Error(`${field.title} 必须等于固定值 ${JSON.stringify(field.constValue)}`);
    }
    if (field.enumValues) {
      const matchIndex = field.enumValues.findIndex(item => sameJsonValue(item, raw));
      if (matchIndex !== -1) {
        payload[field.name] = structuredClone(field.enumValues[matchIndex]);
        continue;
      }
      if (raw === undefined || raw === '') {
        if (field.required) throw new Error(`${field.title} 不能为空`);
        continue;
      }
      throw new Error(`${field.title} 必须是允许的选项之一`);
    }
    if (field.isStructured) {
      let parsed;
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) {
          if (field.required) throw new Error(`${field.title} 不能为空`);
          continue;
        }
        try { parsed = JSON.parse(trimmed); }
        catch (_) { throw new Error(`${field.title} 必须是有效的 JSON`); }
      } else if (raw === undefined) {
        if (field.required) throw new Error(`${field.title} 不能为空`);
        continue;
      } else {
        parsed = structuredClone(raw);
      }
      if (field.type === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
        throw new Error(`${field.title} 必须是 JSON 对象`);
      }
      if (field.type === 'array') {
        if (!Array.isArray(parsed)) throw new Error(`${field.title} 必须是 JSON 数组`);
        if (field.minItems !== undefined && parsed.length < field.minItems) throw new Error(`${field.title} 至少需要 ${field.minItems} 项`);
        if (field.maxItems !== undefined && parsed.length > field.maxItems) throw new Error(`${field.title} 最多允许 ${field.maxItems} 项`);
        if (field.uniqueItems && parsed.some((item, index) => parsed.findIndex(other => sameJsonValue(item, other)) !== index)) {
          throw new Error(`${field.title} 不能包含重复项`);
        }
        if (field.itemType) {
          for (const item of parsed) {
            const validItem = field.itemType === 'string' ? typeof item === 'string'
              : field.itemType === 'integer' ? typeof item === 'number' && Number.isSafeInteger(item)
                : field.itemType === 'number' ? typeof item === 'number' && Number.isFinite(item)
                  : field.itemType === 'boolean' ? typeof item === 'boolean'
                    : field.itemType === 'object' ? Boolean(item && typeof item === 'object' && !Array.isArray(item))
                      : field.itemType === 'array' ? Array.isArray(item)
                        : field.itemType === 'null' ? item === null : true;
            if (!validItem) throw new Error(`${field.title} 中的列表项类型必须是 ${field.itemType}`);
          }
        }
      }
      if (field.type === 'null' && parsed !== null) {
        throw new Error(`${field.title} 必须为 null`);
      }
      payload[field.name] = parsed;
      continue;
    }
    if (field.type === 'boolean') {
      if (raw === undefined) {
        if (field.required) throw new Error(`${field.title} 不能为空`);
        continue;
      }
      if (typeof raw !== 'boolean') throw new Error(`${field.title} 必须是布尔值`);
      payload[field.name] = raw;
      continue;
    }
    if (field.type === 'integer' || field.type === 'number') {
      if (raw === '' || raw === undefined || raw === null) {
        if (field.required) throw new Error(`${field.title} 不能为空`);
        continue;
      }
      const num = Number(raw);
      if (!Number.isFinite(num) || field.type === 'integer' && !Number.isSafeInteger(num)) {
        throw new Error(`${field.title} 必须是有效的${field.type === 'integer' ? '整数' : '数字'}`);
      }
      if (field.min !== undefined && num < field.min) throw new Error(`${field.title} 不能小于 ${field.min}`);
      if (field.max !== undefined && num > field.max) throw new Error(`${field.title} 不能大于 ${field.max}`);
      if (field.exclusiveMin !== undefined && num <= field.exclusiveMin) throw new Error(`${field.title} 必须大于 ${field.exclusiveMin}`);
      if (field.exclusiveMax !== undefined && num >= field.exclusiveMax) throw new Error(`${field.title} 必须小于 ${field.exclusiveMax}`);
      payload[field.name] = num;
      continue;
    }
    const text = raw === undefined || raw === null ? '' : String(raw);
    if (!text) {
      if (field.required) throw new Error(`${field.title} 不能为空`);
      continue;
    }
    if (field.minLength !== undefined && text.length < field.minLength) throw new Error(`${field.title} 至少需要 ${field.minLength} 个字符`);
    if (field.maxLength !== undefined && text.length > field.maxLength) throw new Error(`${field.title} 最多允许 ${field.maxLength} 个字符`);
    if (field.isArtifact && !ARTIFACT_ID.test(text)) throw new Error(`${field.title} 必须是有效的作品 ID`);
    payload[field.name] = text;
  }
  return payload;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function createPluginOpForm({ describe, openPreview, handoffImage, onInspectArtifact, onOutboxExported, pollLimit = 40, pollIntervalMs = 1000, firstPollMs = 300 }) {
  let client = null, session = null, operations = [], selectedOp = null, specs = [];
  let catalogController = null, artifactController = null, runController = null, pollTimer = null;
  let allArtifacts = [], busy = false, stopping = false, pollPaused = false, activeOp = null, pendingKey = null;
  const fieldReaders = new Map();
  const objectUrls = new Set();

  function revokeUrls() {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  function setStatus(text = '', error = false) {
    const node = $('#tool-plugin-op-feedback');
    if (!node) return;
    node.hidden = !text;
    node.textContent = text;
    node.classList.toggle('error', error);
  }

  const canExecute = () => Boolean(session?.pluginExecution && operations.length);

  function updateControls() {
    const running = Boolean(activeOp && ACTIVE_STATES.has(activeOp.state));
    const watching = running && !pollPaused;
    const unconfirmedOther = Boolean(pendingKey && !pendingKey.confirmedAbsent && selectedOp && pendingKey.operationId !== selectedOp.id);
    const submit = $('#tool-plugin-op-submit'), lookup = $('#tool-plugin-op-lookup'), stopBtn = $('#tool-plugin-op-stop');
    if (submit) {
      submit.disabled = !client || !selectedOp || busy || running || unconfirmedOther;
      submit.textContent = busy ? '正在提交…' : running ? '执行中…' : unconfirmedOther ? '请先核对原请求' : '运行插件业务';
    }
    if (lookup) {
      lookup.hidden = !pendingKey || busy || watching;
      lookup.disabled = busy || watching;
      lookup.textContent = pendingKey && selectedOp && pendingKey.operationId !== selectedOp.id
        ? `按原 Key 核对（${pendingKey.operationId}）` : '按原 Key 核对';
    }
    if (stopBtn) {
      stopBtn.hidden = !running || !session?.operations?.includes('operations.stop');
      stopBtn.disabled = stopping;
      stopBtn.textContent = stopping ? '正在停止…' : '停止等待';
    }
  }

  function eligibleArtifacts(allowedMediaKinds) {
    const allowed = new Set(allowedMediaKinds.length ? allowedMediaKinds : ['image']);
    return allArtifacts.filter(item => allowed.has(artifactMediaKind(item.mediaType)));
  }

  function artifactOptionLabel(item) {
    const dims = item.width && item.height ? ` · ${item.width}×${item.height}` : '';
    return `${formatArtifactKind(item.kind)} · ${item.artifactId}${dims} · ${formatBytes(item.size)}`;
  }

  function renderFields() {
    const container = $('#tool-plugin-op-fields');
    const meta = $('#tool-plugin-op-meta');
    if (!container || !meta) return;
    fieldReaders.clear();
    container.replaceChildren();
    if (!selectedOp) {
      meta.textContent = operations.length ? '请选择一个已启用的插件业务。' : '当前服务未启用任何插件业务。';
      specs = [];
      updateControls();
      return;
    }
    const uiParts = [
      selectedOp.dependency ? `${selectedOp.dependency.pluginId}@${selectedOp.dependency.pluginVersion}` : '',
      selectedOp.ui?.category ? `分类：${selectedOp.ui.category}` : '',
      selectedOp.ui?.summary || ''
    ].filter(Boolean);
    meta.textContent = uiParts.join(' · ') || selectedOp.id;
    specs = schemaFieldSpecs(selectedOp);
    if (!specs.length) {
      container.append(el('p', '此插件业务无需额外输入参数，可直接运行。', 'field-note'));
      updateControls();
      return;
    }
    for (const field of specs) {
      const wrap = el('div', undefined, 'plugin-op-field');
      const inputId = 'plugin-op-input-' + field.name.replace(/[^A-Za-z0-9_-]/g, '_');
      if (field.isArtifactArray) {
        const kindsText = field.allowedMediaKinds.map(k => MEDIA_KIND_LABELS[k] || k).join('/');
        const boundsText = field.minItems !== undefined || field.maxItems !== undefined
          ? `（${field.minItems ?? 0}–${field.maxItems ?? '不限'} 项）` : '';
        wrap.append(el('span', `${field.title}${field.required ? ' *' : ''} · ${kindsText}${boundsText}`, 'field-label'));
        const items = eligibleArtifacts(field.allowedMediaKinds);
        const list = el('div', undefined, 'plugin-op-checklist');
        list.dataset.pluginField = field.name;
        if (!items.length) {
          list.append(el('p', `当前工作区暂无可选的${kindsText}作品。`, 'field-note'));
        } else {
          for (const item of items) {
            const label = el('label', undefined, 'plugin-op-check-item');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.value = item.artifactId;
            label.append(box, el('span', artifactOptionLabel(item)));
            list.append(label);
          }
        }
        wrap.append(list);
        fieldReaders.set(field.name, () => [...list.querySelectorAll('input:checked')].map(node => node.value));
      } else if (field.isArtifact) {
        const kindsText = field.allowedMediaKinds.map(k => MEDIA_KIND_LABELS[k] || k).join('/');
        const label = el('label', `${field.title}${field.required ? ' *' : ''} · ${kindsText}`, 'field-label');
        label.htmlFor = inputId;
        const select = document.createElement('select');
        select.id = inputId;
        select.dataset.pluginField = field.name;
        select.required = field.required;
        const items = eligibleArtifacts(field.allowedMediaKinds);
        select.append(new Option(items.length ? `选择${kindsText}作品…` : `当前暂无可选${kindsText}作品`, ''));
        for (const item of items) select.append(new Option(artifactOptionLabel(item), item.artifactId));
        wrap.append(label, select);
        fieldReaders.set(field.name, () => select.value);
      } else if (field.hasConst) {
        const label = el('label', `${field.title}${field.required ? ' *' : ''}`, 'field-label');
        label.htmlFor = inputId;
        const select = document.createElement('select');
        select.id = inputId;
        select.dataset.pluginField = field.name;
        select.required = field.required;
        if (!field.required) select.append(new Option('留空（不传此字段）', ''));
        const constLabel = typeof field.constValue === 'string'
          ? (field.constValue === '' ? '""（空字符串）' : field.constValue)
          : JSON.stringify(field.constValue);
        const opt = new Option(constLabel, '0');
        opt.dataset.enumJson = JSON.stringify(field.constValue);
        select.append(opt);
        if (field.required) select.value = '0';
        wrap.append(label, select);
        fieldReaders.set(field.name, () => (select.value === '' ? undefined : structuredClone(field.constValue)));
      } else if (field.enumValues) {
        const label = el('label', `${field.title}${field.required ? ' *' : ''}`, 'field-label');
        label.htmlFor = inputId;
        const select = document.createElement('select');
        select.id = inputId;
        select.dataset.pluginField = field.name;
        select.required = field.required;
        const allNonEmptyStrings = field.enumValues.every(v => typeof v === 'string' && v !== '');
        if (!field.required) select.append(new Option('留空（不传此字段）', ''));
        field.enumValues.forEach((value, index) => {
          const text = typeof value === 'string' ? (value === '' ? '""（空字符串）' : value) : JSON.stringify(value);
          const opt = new Option(text, allNonEmptyStrings ? value : String(index));
          opt.dataset.enumJson = JSON.stringify(value);
          select.append(opt);
        });
        if (field.defaultValue !== undefined) {
          const idx = field.enumValues.findIndex(v => sameJsonValue(v, field.defaultValue));
          if (idx !== -1) select.value = allNonEmptyStrings ? field.enumValues[idx] : String(idx);
        }
        wrap.append(label, select);
        fieldReaders.set(field.name, () => {
          if (select.value === '') return undefined;
          return allNonEmptyStrings ? select.value : structuredClone(field.enumValues[Number(select.value)]);
        });
      } else if (field.isStructured) {
        const label = el('label', `${field.title}${field.required ? ' *' : ''}（JSON）`, 'field-label');
        label.htmlFor = inputId;
        const area = document.createElement('textarea');
        area.id = inputId;
        area.rows = 4;
        area.dataset.pluginField = field.name;
        area.dataset.pluginJson = 'true';
        area.placeholder = field.type === 'object' ? '{"key": "value"}'
          : field.type === 'array' ? (field.itemType === 'string' ? '["item1", "item2"]' : '[...]')
            : '输入合法 JSON 值';
        area.required = field.required;
        if (field.defaultValue !== undefined) area.value = JSON.stringify(field.defaultValue, null, 2);
        wrap.append(label, area);
        fieldReaders.set(field.name, () => area.value);
      } else if (field.type === 'boolean') {
        const label = el('label', undefined, 'tool-html-check');
        label.htmlFor = inputId;
        const box = document.createElement('input');
        box.id = inputId;
        box.type = 'checkbox';
        box.dataset.pluginField = field.name;
        box.checked = field.defaultValue === true;
        label.append(box, el('span', field.title));
        wrap.append(label);
        fieldReaders.set(field.name, () => box.checked);
      } else if (field.type === 'integer' || field.type === 'number') {
        const label = el('label', `${field.title}${field.required ? ' *' : ''}`, 'field-label');
        label.htmlFor = inputId;
        const input = document.createElement('input');
        input.id = inputId;
        input.type = 'number';
        input.dataset.pluginField = field.name;
        input.step = field.type === 'integer' ? '1' : 'any';
        if (field.min !== undefined) input.min = String(field.min);
        if (field.max !== undefined) input.max = String(field.max);
        if (field.defaultValue !== undefined) input.value = String(field.defaultValue);
        input.required = field.required;
        wrap.append(label, input);
        fieldReaders.set(field.name, () => input.value);
      } else {
        const label = el('label', `${field.title}${field.required ? ' *' : ''}`, 'field-label');
        label.htmlFor = inputId;
        const multiline = field.maxLength !== undefined && field.maxLength > 200;
        const input = document.createElement(multiline ? 'textarea' : 'input');
        input.id = inputId;
        input.dataset.pluginField = field.name;
        if (!multiline) input.type = 'text'; else input.rows = 3;
        if (field.minLength !== undefined) input.minLength = field.minLength;
        if (field.maxLength !== undefined) input.maxLength = field.maxLength;
        if (field.pattern) input.pattern = field.pattern;
        if (field.defaultValue !== undefined) input.value = String(field.defaultValue);
        input.required = field.required;
        wrap.append(label, input);
        fieldReaders.set(field.name, () => input.value);
      }
      if (field.description) wrap.append(el('p', field.description, 'field-note'));
      container.append(wrap);
    }
    updateControls();
  }

  async function renderResult(operation) {
    const section = $('#tool-plugin-op-result');
    const summary = $('#tool-plugin-op-summary');
    const jsonPre = $('#tool-plugin-op-json');
    const artifactsContainer = $('#tool-plugin-op-artifacts');
    if (!section || !summary || !jsonPre || !artifactsContainer) return;
    revokeUrls();
    artifactsContainer.replaceChildren();
    section.hidden = false;
    summary.textContent = `${operation.operationId} · 状态 ${operation.state} · ${operation.id}`;
    if (operation.result?.value && Object.keys(operation.result.value).length) {
      jsonPre.textContent = JSON.stringify(operation.result.value, null, 2);
      jsonPre.hidden = false;
    } else {
      jsonPre.textContent = '';
      jsonPre.hidden = true;
    }
    const ids = operation.result?.artifactIds || [];
    if (!ids.length || !client) return;
    const activeClient = client;
    for (const artifactId of ids) {
      const card = el('article', undefined, 'plugin-op-artifact-card');
      card.dataset.artifactId = artifactId;
      card.append(el('strong', artifactId));
      const note = el('p', '正在读取产物预览…', 'field-note');
      card.append(note);
      artifactsContainer.append(card);
      try {
        const meta = await activeClient.getArtifactMeta(artifactId);
        if (activeClient !== client) return;
        const routeInfo = MEDIA_ROUTES[meta.mediaType];
        note.textContent = `${formatArtifactKind(meta.kind)} · ${meta.mediaType} · ${formatBytes(meta.size)}`;
        const actions = el('div', undefined, 'export-actions');
        if (routeInfo) {
          const [route, ext] = routeInfo;
          const blob = await activeClient.get(`/api/v0/artifacts/${artifactId}/${route}`, { binary: true });
          if (activeClient !== client) return;
          const url = URL.createObjectURL(blob);
          objectUrls.add(url);
          if (meta.mediaType.startsWith('image/')) {
            const previewBtn = el('button', undefined, 'tool-heatmap-button');
            previewBtn.type = 'button';
            previewBtn.setAttribute('aria-label', '放大查看插件产物图片');
            const img = document.createElement('img');
            img.src = url;
            img.alt = '插件业务产物图片';
            previewBtn.append(img);
            previewBtn.addEventListener('click', () => openPreview?.(url, `${formatArtifactKind(meta.kind)} · ${artifactId}`));
            card.append(previewBtn);
            if (session?.operations?.includes('runs.create')) {
              const btn = el('button', '去改图', 'secondary'); btn.type = 'button';
              btn.addEventListener('click', () => handoffImage?.('edit', { file: blob, artifactId, label: `插件产物 · ${artifactId}` }));
              actions.append(btn);
            }
            if (session?.video && session?.operations?.includes('videos-i2v.create')) {
              const btn = el('button', '图生视频', 'secondary'); btn.type = 'button';
              btn.addEventListener('click', () => handoffImage?.('video-i2v', { file: blob, artifactId, label: `插件产物 · ${artifactId}` }));
              actions.append(btn);
            }
          } else if (meta.mediaType.startsWith('audio/')) {
            const audio = document.createElement('audio');
            audio.controls = true; audio.preload = 'metadata'; audio.src = url;
            card.append(audio);
          } else if (meta.mediaType.startsWith('video/')) {
            const video = document.createElement('video');
            video.controls = true; video.playsInline = true; video.preload = 'metadata'; video.src = url;
            card.append(video);
          } else {
            const raw = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer());
            const text = meta.mediaType === 'application/json' ? (() => { try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; } })() : raw;
            card.append(el('pre', text, 'transcript-result'));
          }
          const dl = el('button', '下载产物', 'quiet'); dl.type = 'button';
          dl.addEventListener('click', () => {
            const link = document.createElement('a');
            link.href = url; link.download = `iris-${artifactId}.${ext}`; link.click();
          });
          actions.append(dl);
        }
        if (onInspectArtifact) {
          const lineageBtn = el('button', '查看血缘', 'quiet'); lineageBtn.type = 'button';
          lineageBtn.dataset.pluginLineage = artifactId;
          lineageBtn.addEventListener('click', () => onInspectArtifact(artifactId));
          actions.append(lineageBtn);
        }
        actions.append(createCopyIdButton(artifactId));
        card.append(actions);
        const outboxCtrl = createOutboxExportControl({
          container: card,
          getClient: () => client,
          canExport: () => Boolean(session?.outbox && session?.operations?.includes('outbox.export')),
          describe,
          onExported: onOutboxExported
        });
        outboxCtrl.setTarget({ artifactId, mediaType: meta.mediaType });
      } catch (error) {
        if (activeClient === client) note.textContent = '产物读取失败：' + describe(error);
      }
    }
  }

  function watchOperation(operation) {
    stopPolling();
    pollPaused = false;
    activeOp = operation;
    updateControls();
    if (!ACTIVE_STATES.has(operation.state)) {
      pendingKey = null;
      setStatus(operation.state === 'succeeded' ? '插件业务执行完成。' : `插件业务状态：${operation.state}`, operation.state === 'failed');
      void renderResult(operation);
      void loadArtifacts();
      return;
    }
    setStatus('插件业务正在执行，等待结果…');
    const activeClient = client;
    let reads = 0;
    const tick = async () => {
      if (activeClient !== client || !activeOp || activeOp.id !== operation.id) return;
      try {
        const res = await activeClient.getOperation(operation.id);
        if (activeClient !== client) return;
        activeOp = res.operation;
        if (!ACTIVE_STATES.has(activeOp.state)) {
          watchOperation(activeOp);
          return;
        }
        if (++reads < pollLimit) pollTimer = setTimeout(tick, pollIntervalMs);
        else {
          pollPaused = true;
          setStatus('自动读取已暂停，可点击“按原 Key 核对”查看最新状态。');
          updateControls();
        }
      } catch (error) {
        if (activeClient === client) {
          pollPaused = true;
          setStatus('状态读取中断，可点击“按原 Key 核对”继续核对：' + describe(error), true);
          updateControls();
        }
      }
    };
    pollTimer = setTimeout(tick, firstPollMs);
  }

  async function loadArtifacts() {
    if (!client) return;
    artifactController?.abort();
    const controller = artifactController = new AbortController();
    try {
      const data = await client.listArtifacts({ kind: 'all', limit: 50, offset: 0 }, { signal: controller.signal });
      if (artifactController !== controller) return;
      if (data.contractVersion === 0 && Array.isArray(data.artifacts)) {
        allArtifacts = data.artifacts;
        renderFields();
      }
    } catch (error) {
      if (artifactController === controller && !controller.signal.aborted) {
        setStatus('工作区作品目录读取失败：' + describe(error), true);
      }
    } finally {
      if (artifactController === controller) artifactController = null;
    }
  }

  async function loadCatalog() {
    if (!client || !session?.pluginExecution) return;
    catalogController?.abort();
    const controller = catalogController = new AbortController();
    setStatus('正在读取已启用的插件业务目录…');
    try {
      const data = await client.get('/api/v0/plugin-operations/catalog', { signal: controller.signal });
      if (catalogController !== controller) return;
      if (data.contractVersion !== 0 || !Array.isArray(data.operations)) throw new TypeError('不支持的插件业务目录');
      operations = data.operations.filter(op => op.available !== false);
      const select = $('#tool-plugin-op-select');
      if (select) {
        const prev = select.value;
        select.replaceChildren(
          new Option(operations.length ? '选择一个已启用的插件业务…' : '当前未启用插件业务', ''),
          ...operations.map(op => new Option(`${op.title} · ${op.id}`, op.id))
        );
        const nextId = operations.some(op => op.id === prev) ? prev : (operations[0]?.id || '');
        select.value = nextId;
        selectedOp = operations.find(op => op.id === nextId) || null;
      }
      setStatus(operations.length ? `已加载 ${operations.length} 个已启用插件业务。选择并核对参数后再点击运行。` : '当前未启用任何插件业务。');
      await loadArtifacts();
    } catch (error) {
      if (catalogController === controller && !controller.signal.aborted) {
        setStatus('插件业务目录读取失败：' + describe(error), true);
      }
    } finally {
      if (catalogController === controller) catalogController = null;
      updateControls();
    }
  }

  async function submitForm(event) {
    event.preventDefault();
    if (!client || !selectedOp || busy) return;
    if (activeOp && ACTIVE_STATES.has(activeOp.state)) {
      updateControls();
      return;
    }
    if (pendingKey && !pendingKey.confirmedAbsent && pendingKey.operationId !== selectedOp.id) {
      setStatus(`存在未确认的插件请求（${pendingKey.operationId}），请先点击“按原 Key 核对”确认原状态后再运行其他业务。`, true);
      updateControls();
      return;
    }
    let payload;
    try {
      const rawValues = Object.fromEntries([...fieldReaders.entries()].map(([name, read]) => [name, read()]));
      payload = collectSchemaFormInput(specs, rawValues);
    } catch (error) {
      setStatus(error.message, true);
      return;
    }
    const key = pendingKey?.operationId === selectedOp.id ? pendingKey.key : crypto.randomUUID();
    pendingKey = { key, operationId: selectedOp.id, confirmedAbsent: false };
    pollPaused = false;
    runController?.abort();
    const controller = runController = new AbortController();
    busy = true;
    updateControls();
    setStatus('正在提交插件业务…');
    try {
      const res = await client.callPlugin({ key, operationId: selectedOp.id, dependency: selectedOp.dependency, input: payload }, { signal: controller.signal });
      if (runController !== controller) return;
      watchOperation(res.operation);
    } catch (error) {
      if (runController === controller && !controller.signal.aborted) {
        setStatus('插件业务未确认完成，已保留原请求 Key，可点击“按原 Key 核对”：' + describe(error), true);
      }
    } finally {
      if (runController === controller) { runController = null; busy = false; updateControls(); }
    }
  }

  async function lookupPending() {
    if (!client || !pendingKey || busy) return;
    pollPaused = false;
    busy = true; updateControls();
    setStatus('正在按原请求 Key 核对插件业务…');
    try {
      const res = await client.lookupOperation(pendingKey.key);
      if (!client) return;
      watchOperation(res.operation);
    } catch (error) {
      if (client) {
        if (activeOp && ACTIVE_STATES.has(activeOp.state)) pollPaused = true;
        if (error.status === 404 && pendingKey) {
          pendingKey = { ...pendingKey, confirmedAbsent: true };
          setStatus('原请求尚未落盘，可直接重新点击“运行插件业务”（复用同一 Key），或切换执行其他业务。', false);
        } else {
          setStatus('核对失败：' + describe(error), true);
        }
      }
    } finally {
      busy = false; updateControls();
    }
  }

  async function stopRunning() {
    if (!client || !activeOp || stopping) return;
    stopping = true; updateControls();
    try {
      const res = await client.stopOperation(activeOp.id);
      if (client) watchOperation(res.operation);
    } catch (error) {
      if (client) setStatus('停止等待失败：' + describe(error), true);
    } finally {
      stopping = false; updateControls();
    }
  }

  $('#tool-plugin-op-select')?.addEventListener('change', event => {
    selectedOp = operations.find(op => op.id === event.target.value) || null;
    renderFields();
  });
  $('#tool-plugin-op-form')?.addEventListener('submit', submitForm);
  $('#tool-plugin-op-lookup')?.addEventListener('click', () => { void lookupPending(); });
  $('#tool-plugin-op-stop')?.addEventListener('click', () => { void stopRunning(); });

  return Object.freeze({
    connect(http, info) {
      client = http; session = info;
      operations = []; selectedOp = null; specs = []; allArtifacts = [];
      activeOp = null; pendingKey = null; pollPaused = false;
      const tabBtn = $('[data-local-tool-tab="plugins"]');
      if (tabBtn) tabBtn.hidden = !(info?.pluginExecution && info?.pluginOperations?.length);
      updateControls();
    },
    async activate() {
      if (!client || !session?.pluginExecution) return;
      if (!operations.length) await loadCatalog();
      else await loadArtifacts();
    },
    refresh() {
      if (client && session?.pluginExecution) void loadCatalog();
    },
    isAvailable: canExecute,
    disconnect() {
      stopPolling();
      catalogController?.abort(); catalogController = null;
      artifactController?.abort(); artifactController = null;
      runController?.abort(); runController = null;
      revokeUrls();
      client = null; session = null; operations = []; selectedOp = null; specs = []; allArtifacts = [];
      busy = false; stopping = false; pollPaused = false; activeOp = null; pendingKey = null;
      fieldReaders.clear();
      const tabBtn = $('[data-local-tool-tab="plugins"]');
      if (tabBtn) tabBtn.hidden = true;
      $('#tool-plugin-op-select')?.replaceChildren();
      $('#tool-plugin-op-fields')?.replaceChildren();
      $('#tool-plugin-op-artifacts')?.replaceChildren();
      if ($('#tool-plugin-op-meta')) $('#tool-plugin-op-meta').textContent = '';
      if ($('#tool-plugin-op-result')) $('#tool-plugin-op-result').hidden = true;
      if ($('#tool-plugin-op-json')) { $('#tool-plugin-op-json').textContent = ''; $('#tool-plugin-op-json').hidden = true; }
      setStatus('');
      updateControls();
    }
  });
}
