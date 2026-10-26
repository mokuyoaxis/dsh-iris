// API graph configuration only. Never evaluates code or reads a local workflow path.
import crypto from 'node:crypto';

export const MAX_COMFY_WORKFLOW_BYTES = 40 * 1024;
const NODE = /^[A-Za-z0-9_.:-]{1,100}$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw Object.assign(new TypeError('ComfyUI 需要有界的 API 工作流、提示词节点、输出节点和可选尺寸节点；请使用 Export (API)'), { code: 'IRIS_CONFIG_INPUT_INVALID' }); };
const PARAMETER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const scalar = value => typeof value === 'string' && value.length <= 20000 || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const parameterFail = message => { throw Object.assign(new TypeError('ComfyUI 参数无效：' + message), { code: 'IRIS_COMFYUI_PARAMETERS_INVALID' }); };
export function normalizeComfyParameters(value) {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).length > 32
      || Object.keys(value).some(key => !PARAMETER.test(key) || ['constructor', 'prototype'].includes(key) || !scalar(value[key]))
      || Buffer.byteLength(JSON.stringify(value)) > 24 * 1024) parameterFail('需要 1–32 个具名标量，最多 24 KiB');
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
}
function parameterValue(parameter, value) {
  if (!scalar(value) || (parameter.type === 'integer' ? !Number.isSafeInteger(value)
    : parameter.type === 'number' ? typeof value !== 'number' : typeof value !== parameter.type)
      || parameter.min !== undefined && value < parameter.min || parameter.max !== undefined && value > parameter.max
      || parameter.choices !== undefined && !parameter.choices.includes(value)) parameterFail(parameter.id + ' 的类型、范围或选项不符');
  return value;
}
export function checkedComfyWorkflow(value) {
  if (!object(value) || Object.keys(value).some(key => !['version', 'graph', 'promptNode', 'outputNode', 'sizeNode', 'parameters'].includes(key))
      || ![0, 1].includes(value.version) || !object(value.graph) || !Object.keys(value.graph).length || Object.keys(value.graph).length > 256
      || Buffer.byteLength(JSON.stringify(value)) > MAX_COMFY_WORKFLOW_BYTES) fail();
  for (const [id, node] of Object.entries(value.graph)) {
    if (!NODE.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || !object(node)
        || typeof node.class_type !== 'string' || !node.class_type || node.class_type.length > 200 || !object(node.inputs)) fail();
    for (const [input, number] of Object.entries(node.inputs)) {
      if (typeof number === 'number' && (!Number.isFinite(number) || Number.isInteger(number) && !Number.isSafeInteger(number))) {
        throw Object.assign(new TypeError('ComfyUI 节点 ' + id + ' 的 ' + input + ' 超出 JavaScript 数值范围；整数须在 ±9007199254740991 内，请调整种子后重新导出'), { code: 'IRIS_CONFIG_INPUT_INVALID' });
      }
    }
  }
  if (![value.promptNode, value.outputNode].every(id => typeof id === 'string' && Object.hasOwn(value.graph, id))
      || typeof value.graph[value.promptNode].inputs.text !== 'string') fail();
  if (value.sizeNode !== undefined && (typeof value.sizeNode !== 'string' || !Object.hasOwn(value.graph, value.sizeNode)
      || !['width', 'height'].every(key => Number.isSafeInteger(value.graph[value.sizeNode].inputs[key]) && value.graph[value.sizeNode].inputs[key] > 0))) fail();
  if (value.version === 0 && value.parameters !== undefined) fail();
  if (value.version === 1) {
    if (!Array.isArray(value.parameters) || !value.parameters.length || value.parameters.length > 32) fail();
    const ids = new Set(), targets = new Set([value.promptNode + '\0text',
      ...(value.sizeNode ? ['width', 'height'].map(key => value.sizeNode + '\0' + key) : [])]);
    for (const parameter of value.parameters) {
      if (!object(parameter) || Object.keys(parameter).some(key => !['id', 'label', 'node', 'input', 'type', 'min', 'max', 'choices'].includes(key))
          || typeof parameter.id !== 'string' || !PARAMETER.test(parameter.id) || ['constructor', 'prototype'].includes(parameter.id) || ids.has(parameter.id)
          || typeof parameter.node !== 'string' || !Object.hasOwn(value.graph, parameter.node)
          || typeof parameter.input !== 'string' || !NODE.test(parameter.input) || ['__proto__', 'constructor', 'prototype'].includes(parameter.input)
          || !Object.hasOwn(value.graph[parameter.node].inputs, parameter.input)
          || !['string', 'integer', 'number', 'boolean'].includes(parameter.type)
          || parameter.label !== undefined && (typeof parameter.label !== 'string' || !parameter.label.trim() || parameter.label.length > 80)
          || targets.has(parameter.node + '\0' + parameter.input)) fail();
      for (const key of ['min', 'max']) if (parameter[key] !== undefined
          && (!['integer', 'number'].includes(parameter.type) || !Number.isFinite(parameter[key])
            || Math.abs(parameter[key]) > Number.MAX_SAFE_INTEGER || parameter.type === 'integer' && !Number.isSafeInteger(parameter[key]))) fail();
      if (parameter.min !== undefined && parameter.max !== undefined && parameter.min > parameter.max) fail();
      if (parameter.choices !== undefined && (!Array.isArray(parameter.choices) || !parameter.choices.length || parameter.choices.length > 256)) fail();
      for (const choice of parameter.choices || []) parameterValue({ ...parameter, choices: undefined }, choice);
      parameterValue(parameter, value.graph[parameter.node].inputs[parameter.input]);
      ids.add(parameter.id); targets.add(parameter.node + '\0' + parameter.input);
    }
  }
  return structuredClone(value);
}
export function compileComfyWorkflow(value, input = {}) {
  const workflow = checkedComfyWorkflow(value), parameters = input.workflow_parameters === undefined ? {}
    : normalizeComfyParameters(input.workflow_parameters);
  const declared = new Map((workflow.parameters || []).map(parameter => [parameter.id, parameter]));
  for (const [id, item] of Object.entries(parameters)) {
    const parameter = declared.get(id);
    if (!parameter) parameterFail('未开放的槽位 ' + id);
    workflow.graph[parameter.node].inputs[parameter.input] = parameterValue(parameter, item);
  }
  if (input.prompt !== undefined) workflow.graph[workflow.promptNode].inputs.text = input.prompt;
  return workflow;
}
export function comfyWorkflowDigest(value) {
  const workflow = checkedComfyWorkflow(value);
  // Stable JSON object ordering: formatting and key order are not a workflow change.
  const sorted = item => Array.isArray(item) ? item.map(sorted) : object(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])])) : item;
  return crypto.createHash('sha256').update(JSON.stringify(sorted(workflow))).digest('hex');
}
export function projectComfyWorkflow(value) {
  if (value === undefined) return undefined;
  const workflow = checkedComfyWorkflow(value);
  return { configured: true, sha256: comfyWorkflowDigest(workflow), nodeCount: Object.keys(workflow.graph).length,
    promptNode: workflow.promptNode, outputNode: workflow.outputNode, ...(workflow.sizeNode ? { sizeNode: workflow.sizeNode } : {}),
    ...(workflow.version === 1 ? { version: 1, parameters: workflow.parameters.map(parameter => ({ ...parameter,
      default: workflow.graph[parameter.node].inputs[parameter.input] })) } : {}) };
}
