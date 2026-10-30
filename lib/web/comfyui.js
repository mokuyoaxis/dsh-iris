// Browser presentation for explicitly exposed workflow inputs. Server validation remains authoritative.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const scalar = value => ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const labelByInput = { lora_name: 'LoRA', strength_model: '模型权重', strength_clip: 'CLIP 权重',
  ckpt_name: 'Checkpoint', seed: '种子', steps: '步数', sampler_name: '采样器', scheduler: '调度器', cfg: 'CFG', denoise: '降噪强度' };
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
export const parameterLabel = parameter => parameter.label || labelByInput[parameter.input] || (parameter.input === 'text' ? parameter.id === 'negative' ? '负面提示词' : '文本 · ' + parameter.node : parameter.id);

export function normalizeWorkflowValues(value) {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).length > 32
      || Object.entries(value).some(([id, item]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(id) || ['constructor', 'prototype'].includes(id)
        || !scalar(item) || typeof item === 'string' && item.length > 20000)
      || new TextEncoder().encode(JSON.stringify(value)).length > 24 * 1024) throw new TypeError('工作流参数需要 1–32 个有界标量，整数限于安全范围，正文最多 24 KiB');
  return Object.fromEntries(Object.keys(value).sort().map(id => [id, value[id]]));
}

export function readWorkflowImport(text) {
  if (new TextEncoder().encode(text).length > 40 * 1024) throw new TypeError('工作流超过 40 KiB，请精简后导入。');
  const value = JSON.parse(text), template = object(value) && Object.hasOwn(value, 'graph');
  const graph = template ? value.graph : value;
  if (!object(graph) || !Object.keys(graph).length || Object.keys(graph).length > 256
      || Object.entries(graph).some(([id, node]) => !/^[A-Za-z0-9_.:-]{1,100}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)
        || !object(node) || typeof node.class_type !== 'string' || !node.class_type || !object(node.inputs))) {
    throw new TypeError('需要 Export (API) 的节点映射或完整 Iris 模板，普通画布 JSON 不能执行。');
  }
  for (const node of Object.values(graph)) for (const number of Object.values(node.inputs)) {
    if (typeof number === 'number' && (!Number.isFinite(number) || Number.isInteger(number) && !Number.isSafeInteger(number))) {
      throw new TypeError('图中有超出安全范围的整数，请将种子调整到 0–9007199254740991 后重新导出。');
    }
  }
  if (template && (![0, 1].includes(value.version) || value.version === 1 && (!Array.isArray(value.parameters) || !value.parameters.length || value.parameters.length > 32))) {
    throw new TypeError('不支持的 Iris 工作流模板版本或参数数量。');
  }
  return structuredClone(template ? value : { version: 0, graph });
}

export function workflowSlots(template, { promptNode, sizeNode } = template) {
  const existing = new Map((template.parameters || []).map(parameter => [parameter.node + '\0' + parameter.input, parameter]));
  const used = new Set((template.parameters || []).map(parameter => parameter.id));
  return Object.entries(template.graph).flatMap(([node, value]) => Object.entries(value.inputs)
    .filter(([input, item]) => scalar(item) && !(node === promptNode && input === 'text') && !(node === sizeNode && ['width', 'height'].includes(input))
      && /^[A-Za-z0-9_.:-]{1,100}$/.test(input) && !['__proto__', 'constructor', 'prototype'].includes(input))
    .map(([input, item]) => {
      const parameter = existing.get(node + '\0' + input);
      const base = 'p_' + (node + '_' + input).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 48); let id = base, suffix = 0;
      if (!parameter) { while (used.has(id)) id = base + '_' + ++suffix; used.add(id); }
      const type = typeof item === 'number' ? Number.isSafeInteger(item) && !['strength_model', 'strength_clip', 'cfg', 'denoise'].includes(input) ? 'integer' : 'number' : typeof item;
      return { ...(parameter || { id, node, input, type }),
        default: item, exposed: Boolean(parameter), nodeType: value.class_type };
    }));
}

export function buildWorkflow(template, bindings, slots) {
  const { promptNode, outputNode, sizeNode } = bindings, graph = template.graph;
  if (typeof graph[promptNode]?.inputs.text !== 'string' || !graph[outputNode]) throw new TypeError('请明确选择正向提示词和图片输出节点。');
  if (sizeNode && !['width', 'height'].every(key => Number.isSafeInteger(graph[sizeNode]?.inputs[key]) && graph[sizeNode].inputs[key] > 0)) throw new TypeError('尺寸节点需要有效的 width 和 height。');
  const parameters = slots.filter(slot => slot.exposed).map(({ exposed, default: value, nodeType, ...parameter }) => parameter);
  const order = new Map((template.parameters || []).map((parameter, index) => [parameter.id, index]));
  parameters.sort((a, b) => (order.get(a.id) ?? 32) - (order.get(b.id) ?? 32));
  if (parameters.length > 32 || new Set(parameters.map(parameter => parameter.id)).size !== parameters.length) throw new TypeError('最多开放 32 个参数，参数 ID 不能重复。');
  for (const parameter of parameters) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(parameter.id) || ['constructor', 'prototype'].includes(parameter.id)) throw new TypeError('参数 ID 需要以英文字母开头，只含字母、数字和下划线。');
    if (parameter.label !== undefined && (!parameter.label.trim() || parameter.label.length > 80)) throw new TypeError('参数名称需要 1–80 个字符。');
  }
  const workflow = { version: parameters.length ? 1 : 0, graph: structuredClone(graph), promptNode, outputNode,
    ...(sizeNode ? { sizeNode } : {}), ...(parameters.length ? { parameters } : {}) };
  if (new TextEncoder().encode(JSON.stringify(workflow)).length > 40 * 1024) throw new TypeError('加上参数声明后，模板超过 40 KiB。');
  return workflow;
}

function disclosure(title, className = '') {
  const details = element('details', undefined, 'comfy-group ' + className), summary = element('summary');
  const state = element('span', '展开', 'disclosure'); summary.append(element('span', title), state); details.append(summary);
  details.addEventListener('toggle', () => { state.textContent = details.open ? '收起' : '展开'; }); return details;
}

/** Renders only supplied descriptors; reading returns a fresh, sorted value snapshot. */
export function renderWorkflowParameters(container, parameters, { values = {}, checked = [], onChange = () => {}, disabled = false, preserveOpen = false } = {}) {
  const expanded = new Set(preserveOpen ? [...container.querySelectorAll('details[open]')].map(node => node.dataset.parameterGroup) : []);
  container.replaceChildren(); const controls = new Map(), loras = new Map();
  const common = element('div', undefined, 'comfy-common'), advanced = disclosure('更多参数 · ' + parameters.filter(parameter => !['seed', 'text', 'lora_name', 'strength_model', 'strength_clip'].includes(parameter.input)).length);
  advanced.dataset.parameterGroup = 'advanced'; advanced.open = expanded.has('advanced');
  container.append(common);
  for (const parameter of parameters) {
    let parent = common;
    if (['lora_name', 'strength_model', 'strength_clip'].includes(parameter.input)) {
      if (!loras.has(parameter.node)) {
        const name = parameters.find(item => item.node === parameter.node && item.input === 'lora_name');
        const selected = name && (Object.hasOwn(values, name.id) ? values[name.id] : name.default);
        const card = disclosure('LoRA · ' + (selected || '节点 ' + parameter.node), 'comfy-lora');
        card.dataset.parameterGroup = 'lora:' + parameter.node; card.open = expanded.has(card.dataset.parameterGroup);
        const body = element('div', undefined, 'comfy-parameter-grid'); card.append(body); loras.set(parameter.node, body); container.append(card);
      }
      parent = loras.get(parameter.node);
    } else if (!['seed', 'text'].includes(parameter.input)) parent = advanced;
    const wrapper = element('label', undefined, 'comfy-parameter'); wrapper.append(element('span', parameterLabel(parameter)));
    const value = Object.hasOwn(values, parameter.id) ? values[parameter.id] : parameter.default;
    const discovered = checked.find(item => item.id === parameter.id);
    const choices = parameter.choices || discovered?.availableChoices;
    let input;
    if (choices && !discovered?.choicesTruncated) {
      input = element('select');
      for (const choice of choices) { const option = element('option', String(choice)); option.value = JSON.stringify(choice); input.append(option); }
      if (!choices.includes(value)) { const option = element('option', String(value) + ' · 不在当前候选中'); option.value = JSON.stringify(value); input.append(option); }
      input.value = JSON.stringify(value);
    } else if (parameter.type === 'boolean') { input = element('input'); input.type = 'checkbox'; input.checked = value; }
    else {
      input = element(parameter.type === 'string' && parameter.input === 'text' ? 'textarea' : 'input');
      if (input.tagName === 'TEXTAREA') input.rows = 2;
      else input.type = parameter.type === 'string' ? 'text' : 'number';
      input.value = String(value); if (parameter.type === 'string') input.maxLength = 20000;
      else { input.step = parameter.type === 'integer' ? '1' : 'any'; input.required = true;
        input.min = String(parameter.min ?? -Number.MAX_SAFE_INTEGER); input.max = String(parameter.max ?? Number.MAX_SAFE_INTEGER); }
    }
    input.dataset.workflowParameter = parameter.id; input.setAttribute('aria-label', parameterLabel(parameter)); input.disabled = disabled;
    input.addEventListener(input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input', () => {
      if (parameter.input === 'lora_name') parent.parentElement.querySelector('summary>span:first-child').textContent = 'LoRA · ' + (input.tagName === 'SELECT' ? JSON.parse(input.value) : input.value);
      onChange();
    }); wrapper.append(input);
    if (discovered?.choicesTruncated && !parameter.choices) wrapper.append(element('small', '候选超过 256 项，可手填服务上已有的名称。', 'field-note'));
    parent.append(wrapper); controls.set(parameter.id, { parameter, input });
  }
  if (advanced.children.length > 1) container.append(advanced);
  if (!parameters.length) container.append(element('p', '沿用工作流中的固定参数。', 'field-note'));
  function read() {
    const result = {};
    for (const [id, { parameter, input }] of controls) {
      const value = input.tagName === 'SELECT' ? JSON.parse(input.value) : parameter.type === 'boolean' ? input.checked
        : parameter.type === 'string' ? input.value : input.value === '' ? null : Number(input.value);
      if (!scalar(value) || parameter.type === 'integer' && !Number.isSafeInteger(value)
          || parameter.type === 'number' && typeof value !== 'number' || parameter.type === 'string' && typeof value !== 'string'
          || parameter.type === 'boolean' && typeof value !== 'boolean' || parameter.min !== undefined && value < parameter.min
          || parameter.max !== undefined && value > parameter.max || parameter.choices && !parameter.choices.includes(value)) {
        throw new TypeError(parameterLabel(parameter) + '的类型、范围或选项不符。');
      }
      result[id] = value;
    }
    return parameters.length ? normalizeWorkflowValues(result) : {};
  }
  return { read, valid() { try { read(); return true; } catch { return false; } } };
}

export function inspectionMessage(report) {
  return report.ok ? '静态检查通过 · ' + report.checkedClasses + ' 类节点 · 未执行生成'
    : '检查未通过：' + report.issues.map(issue => issue.message).join('；');
}
