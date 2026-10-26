// Partial preflight against official /object_info/{node_class}. Never queues a prompt.
import { comfyWorkflowDigest, projectComfyWorkflow } from './comfyui-workflow.js';
import { comfyFail } from './comfyui-client.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const link = value => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isSafeInteger(value[1]) && value[1] >= 0;
const MESSAGES = { node_unavailable: '节点尚未安装、未加载或不存在', input_missing: '缺少必需输入',
  choice_unavailable: '所选值不在服务当前公布的选项中，请核对模型文件或选项', input_type: '输入类型与服务定义不符',
  input_range: '数值超出服务允许范围', link_invalid: '连接引用的节点或输出不存在', link_type: '连接两端的数据类型不符',
  output_node_required: '请选择可执行的图片输出节点', parameter_schema_unsupported: '此参数的节点定义暂不支持静态检查' };
function literalIssue(value, spec) {
  if (!Array.isArray(spec)) return null;
  const [type, limits] = spec;
  if (Array.isArray(type)) return type.includes(value) ? null : 'choice_unavailable';
  if (!['STRING', 'BOOLEAN', 'INT', 'FLOAT'].includes(type)) return null;
  if (type === 'STRING' ? typeof value !== 'string' : type === 'BOOLEAN' ? typeof value !== 'boolean'
    : type === 'INT' ? !Number.isSafeInteger(value) : typeof value !== 'number' || !Number.isFinite(value)) return 'input_type';
  if (typeof value === 'number' && (typeof limits?.min === 'number' && value < limits.min || typeof limits?.max === 'number' && value > limits.max)) return 'input_range';
  return null;
}
export async function inspectComfyWorkflow(client, workflow, { signal, timeoutMs = 15000 } = {}) {
  const combined = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  const schemas = new Map();
  for (const type of new Set(Object.values(workflow.graph).map(node => node.class_type))) {
    const value = await client.request(client.route('object_info/' + encodeURIComponent(type)), { signal: combined, stage: 'validate', timeoutMs });
    if (!object(value) || Object.hasOwn(value, type) && (!object(value[type]) || !object(value[type].input)
        || value[type].input.required !== undefined && !object(value[type].input.required)
        || value[type].input.optional !== undefined && !object(value[type].input.optional)
        || !Array.isArray(value[type].output))) comfyFail('ComfyUI 节点定义响应无效', 'validate');
    schemas.set(type, Object.hasOwn(value, type) ? value[type] : null);
  }
  const issues = [], fields = new Map();
  const issue = (code, node, input) => {
    const parameter = workflow.parameters?.find(parameter => parameter.node === node && parameter.input === input);
    const label = parameter?.label || parameter?.id || '节点 ' + node + (input ? ' 的 ' + input : '');
    issues.push({ code, node, ...(input ? { input } : {}), message: label + '：' + MESSAGES[code] });
  };
  for (const [id, node] of Object.entries(workflow.graph)) {
    const schema = schemas.get(node.class_type);
    if (!schema) { issue('node_unavailable', id); continue; }
    const inputs = { ...schema.input.optional, ...schema.input.required };
    fields.set(id, inputs);
    for (const name of Object.keys(schema.input.required || {})) if (!Object.hasOwn(node.inputs, name)) issue('input_missing', id, name);
    for (const [name, value] of Object.entries(node.inputs)) {
      const spec = inputs[name];
      if (link(value)) {
        const source = workflow.graph[value[0]], sourceSchema = source && schemas.get(source.class_type);
        if (!source || sourceSchema && value[1] >= sourceSchema.output.length) issue('link_invalid', id, name);
        const expected = spec?.[0], actual = sourceSchema?.output[value[1]];
        if (typeof expected === 'string' && typeof actual === 'string' && expected !== '*' && actual !== '*'
            && !expected.includes(',') && !actual.includes(',') && expected !== actual) issue('link_type', id, name);
      } else {
        const code = literalIssue(value, spec);
        if (code) issue(code, id, name);
      }
    }
  }
  const output = schemas.get(workflow.graph[workflow.outputNode].class_type);
  if (output && output.output_node !== true) issue('output_node_required', workflow.outputNode);
  const parameters = (projectComfyWorkflow(workflow).parameters || []).map(parameter => {
    const { default: value, ...descriptor } = parameter;
    const spec = fields.get(parameter.node)?.[parameter.input];
    if (!spec || !Array.isArray(spec) || !Array.isArray(spec[0]) && !['STRING', 'BOOLEAN', 'INT', 'FLOAT'].includes(spec[0])) {
      issue('parameter_schema_unsupported', parameter.node, parameter.input);
    }
    const choices = Array.isArray(spec?.[0]) ? spec[0] : null;
    return { ...descriptor, value, ...(choices ? { availableChoices: choices.slice(0, 256), choicesTruncated: choices.length > 256 } : {}) };
  });
  return { contractVersion: 0, ok: issues.length === 0, workflowSha256: comfyWorkflowDigest(workflow),
    nodeCount: Object.keys(workflow.graph).length, checkedClasses: schemas.size, parameters, issues,
    scope: 'node-definitions-and-literal-inputs', executed: false, persisted: false,
    limitations: ['不执行节点或自定义校验；不证明模型家族兼容、显存充足、外部服务可用或真实出图成功'] };
}
