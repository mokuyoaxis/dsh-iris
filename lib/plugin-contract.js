// Experimental contribution contract. No Host, filesystem, registry or execution state.
export const PLUGIN_CONTRACT_VERSION = 0;
export const PLUGIN_KINDS = Object.freeze(['providers', 'operations', 'pages', 'renderers', 'settings']);
export const PLUGIN_CORE_COMMANDS = Object.freeze({
  'artifact.inspect': 'reader', 'artifact.list': 'reader', 'artifact.read': 'reader',
  'task.inspect': 'reader', 'task.list': 'reader', 'artifact.import': 'writer'
});

const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const CAPS = new Set(['image-gen', 'video-gen', 'tts', 'music-gen', 'transcribe']);
const CORE_NAMESPACES = new Set(['iris', 'artifact', 'task', 'media', 'flow', 'creation', 'execution', 'operation', 'core']);

export class PluginContractError extends Error {
  constructor(code, message) { super(message); this.name = 'PluginContractError'; this.code = code; }
}
export function pluginFail(code, message) { throw new PluginContractError(code, message); }
const invalid = message => pluginFail('IRIS_PLUGIN_INVALID', message);
export const pluginObject = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
export function pluginFields(value, allowed, required = allowed) {
  return pluginObject(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
}
function versionParts(value) {
  const match = typeof value === 'string' && value.length <= 160 && value.match(VERSION);
  if (!match || match[4]?.split('.').some(part => /^[0-9]+$/.test(part) && part.length > 1 && part[0] === '0')) invalid('插件版本须为有效 SemVer');
  return { core: match.slice(1, 4), pre: match[4]?.split('.') || [] };
}
const numericOrder = (a, b) => a.length === b.length ? a === b ? 0 : a < b ? -1 : 1 : a.length < b.length ? -1 : 1;
/** SemVer precedence only; compatibility is a closed/open interval, not npm range syntax. */
export function comparePluginVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) { const order = numericOrder(left.core[i], right.core[i]); if (order) return order; }
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^[0-9]+$/.test(x), yn = /^[0-9]+$/.test(y);
    return xn && yn ? numericOrder(x, y) : xn !== yn ? xn ? -1 : 1 : x < y ? -1 : 1;
  }
  return 0;
}
function checkedId(value) {
  if (typeof value !== 'string' || value.length > 80 || !ID.test(value)) invalid('插件及贡献 ID 须为有界小写标识');
  return value;
}
export function qualifiedPluginId(pluginId, localId) { return checkedId(checkedId(pluginId) + '.' + checkedId(localId)); }
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) invalid('贡献标题无效');
  return value;
}
function asset(value, extension) {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(value)
      || !extension.test(value) || value.split('/').some(part => part === '.' || part === '..')) invalid('Web 入口须为插件内相对 JS/MJS 路径，样式须为 CSS');
  return value;
}
/** JSON boundaries never coerce, strip fields or preserve mutable author-owned objects. */
export function pluginJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if ((!Array.isArray(value) && !pluginObject(value)) || ancestors.has(value)) invalid('插件描述、输入和结果须为无循环的 JSON 数据');
  ancestors.add(value);
  const result = Array.isArray(value) ? value.map(item => pluginJson(item, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pluginJson(item, ancestors)]));
  ancestors.delete(value);
  return result;
}
export function freezePluginValue(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freezePluginValue(item); Object.freeze(value); }
  return value;
}

// A documented JSON Schema subset; unknown/default/ref keywords must not be silently ignored.
function checkedInputSchema(value) {
  const fields = ['type', 'title', 'description', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'enum', 'const',
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems'];
  if (!pluginFields(value, fields, []) || value.type !== undefined && !['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(value.type)) invalid('业务输入包含未支持的 JSON Schema 字段或类型');
  if (value.properties !== undefined) {
    if (!pluginObject(value.properties)) invalid('Schema properties 必须为对象');
    for (const item of Object.values(value.properties)) checkedInputSchema(item);
  }
  if (value.required !== undefined && (!Array.isArray(value.required) || new Set(value.required).size !== value.required.length
      || value.required.some(key => typeof key !== 'string' || !Object.hasOwn(value.properties || {}, key)))) invalid('Schema required 必须引用已声明属性');
  if (value.items !== undefined) checkedInputSchema(value.items);
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') checkedInputSchema(value.additionalProperties);
  if (value.anyOf !== undefined) {
    if (!Array.isArray(value.anyOf) || !value.anyOf.length) invalid('Schema anyOf 须为非空 Schema 数组');
    value.anyOf.forEach(checkedInputSchema);
  }
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || key === 'multipleOf' && value[key] <= 0)) invalid('Schema 数值约束类型无效');
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 0)) invalid('Schema 长度约束须为非负整数');
  }
  if (value.pattern !== undefined && typeof value.pattern !== 'string' || value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)
      || value.title !== undefined && typeof value.title !== 'string' || value.description !== undefined && typeof value.description !== 'string') invalid('Schema 文本或枚举约束无效');
  return value;
}

function checkedContribution(kind, value) {
  const common = ['id', 'version', 'title'];
  const fields = kind === 'providers' ? ['capabilities', 'configuration'] : kind === 'operations' ? ['mode', 'commands', 'inputSchema', 'artifactInputs']
    : kind === 'renderers' ? ['entry', 'styles', 'mediaTypes'] : ['entry', 'styles'];
  const required = [...common, ...fields.filter(field => !['configuration', 'styles', 'artifactInputs'].includes(field))];
  if (!pluginFields(value, [...common, ...fields], required)) invalid('贡献字段不符合 ' + kind + ' 契约');
  const result = { id: checkedId(value.id), version: value.version, title: label(value.title) }; versionParts(value.version);
  if (kind === 'providers') {
    if (!Array.isArray(value.capabilities) || !value.capabilities.length || value.capabilities.some(cap => !CAPS.has(cap))
        || new Set(value.capabilities).size !== value.capabilities.length) invalid('Provider 能力须为支持的明确列表');
    const configuration = value.configuration === undefined ? [] : value.configuration;
    if (!Array.isArray(configuration) || new Set(configuration.map(field => field?.key)).size !== configuration.length) invalid('Provider 配置字段重复或无效');
    for (const field of configuration) {
      if (!pluginFields(field, ['key', 'label', 'type', 'required', 'advanced'], ['key', 'label', 'type'])
          || !['baseUrl', 'mediaBaseUrl', 'apiKey'].includes(field.key) || field.type !== (field.key === 'apiKey' ? 'secret' : 'url')
          || field.required !== undefined && typeof field.required !== 'boolean' || field.advanced !== undefined && typeof field.advanced !== 'boolean') invalid('Provider 配置描述无效');
      label(field.label);
    }
    Object.assign(result, { capabilities: [...value.capabilities], configuration: pluginJson(configuration) });
  } else if (kind === 'operations') {
    if (!['reader', 'writer'].includes(value.mode) || !Array.isArray(value.commands) || new Set(value.commands).size !== value.commands.length
        || value.commands.some(name => typeof name !== 'string' || !Object.hasOwn(PLUGIN_CORE_COMMANDS, name)
          || value.mode === 'reader' && PLUGIN_CORE_COMMANDS[name] !== 'reader')) invalid('业务模式或 Core 命令声明无效');
    if (!pluginObject(value.inputSchema) || value.inputSchema.type !== 'object' || value.inputSchema.additionalProperties !== false) invalid('业务输入须声明封闭的 JSON 对象 Schema');
    Object.assign(result, { mode: value.mode, commands: [...value.commands], inputSchema: checkedInputSchema(pluginJson(value.inputSchema)) });
    if (value.artifactInputs !== undefined) {
      if (!Array.isArray(value.artifactInputs) || new Set(value.artifactInputs).size !== value.artifactInputs.length
          || value.artifactInputs.some(key => { const field = result.inputSchema.properties?.[key];
            return typeof key !== 'string' || !(field?.type === 'string' || field?.type === 'array' && field.items?.type === 'string'); })) invalid('artifactInputs 须引用顶层 Artifact ID 字符串或数组字段');
      result.artifactInputs = [...value.artifactInputs];
    }
  } else {
    result.entry = asset(value.entry, /\.m?js$/);
    if (value.styles !== undefined) {
      if (!Array.isArray(value.styles) || new Set(value.styles).size !== value.styles.length) invalid('样式列表无效');
      result.styles = value.styles.map(file => asset(file, /\.css$/));
    }
    if (kind === 'renderers') {
      if (!Array.isArray(value.mediaTypes) || !value.mediaTypes.length || new Set(value.mediaTypes).size !== value.mediaTypes.length
          || value.mediaTypes.some(type => typeof type !== 'string' || !MIME.test(type))) invalid('作品渲染器须声明准确媒体类型，不接受通配符');
      result.mediaTypes = [...value.mediaTypes];
    }
  }
  return result;
}

export function checkedPluginManifest(value) {
  if (!pluginFields(value, ['contractVersion', 'id', 'version', 'compatibility', 'contributions'])
      || value.contractVersion !== PLUGIN_CONTRACT_VERSION || !pluginFields(value.compatibility, ['min', 'maxExclusive'])
      || !pluginFields(value.contributions, PLUGIN_KINDS, [])) invalid('插件清单或契约版本无效');
  const id = checkedId(value.id); versionParts(value.version);
  if (CORE_NAMESPACES.has(id) || id.startsWith('iris.')) invalid('插件 ID 不能使用 Core 保留的命名空间');
  if (comparePluginVersions(value.compatibility.min, value.compatibility.maxExclusive) >= 0) invalid('Core 兼容区间须为 min <= version < maxExclusive');
  const contributions = {};
  for (const kind of PLUGIN_KINDS) {
    const entries = value.contributions[kind] === undefined ? [] : value.contributions[kind];
    if (!Array.isArray(entries)) invalid('贡献必须为数组');
    contributions[kind] = entries.map(entry => checkedContribution(kind, entry));
    const ids = contributions[kind].map(entry => qualifiedPluginId(id, entry.id));
    if (new Set(ids).size !== ids.length) invalid('同类贡献 ID 重复');
  }
  if (!Object.values(contributions).some(entries => entries.length)) invalid('插件必须声明至少一个贡献');
  return freezePluginValue({ contractVersion: PLUGIN_CONTRACT_VERSION, id, version: value.version,
    compatibility: { ...value.compatibility }, contributions });
}

export function definePlugin(value) {
  if (!pluginFields(value, ['manifest', 'activate']) || typeof value.activate !== 'function') invalid('插件需要 manifest 与 activate');
  return Object.freeze({ manifest: checkedPluginManifest(value.manifest), activate: value.activate });
}
export function assertPluginCompatibility(manifest, coreVersion) {
  if (comparePluginVersions(coreVersion, manifest.compatibility.min) < 0 || comparePluginVersions(coreVersion, manifest.compatibility.maxExclusive) >= 0) {
    pluginFail('IRIS_PLUGIN_INCOMPATIBLE', '插件 ' + manifest.id + ' 不支持当前 Core 版本');
  }
}
export function checkedPluginDependency(value) {
  if (!pluginFields(value, ['contractVersion', 'pluginId', 'pluginVersion', 'kind', 'contributionId', 'contributionVersion'])
      || value.contractVersion !== PLUGIN_CONTRACT_VERSION || !PLUGIN_KINDS.includes(value.kind)) invalid('持久插件依赖无效');
  checkedId(value.pluginId); checkedId(value.contributionId); versionParts(value.pluginVersion); versionParts(value.contributionVersion);
  if (!value.contributionId.startsWith(value.pluginId + '.')) invalid('持久贡献不属于原插件');
  return freezePluginValue({ contractVersion: PLUGIN_CONTRACT_VERSION, pluginId: value.pluginId, pluginVersion: value.pluginVersion,
    kind: value.kind, contributionId: value.contributionId, contributionVersion: value.contributionVersion });
}
export function assertPluginDependencyMatches(expected, current) {
  const original = expected === undefined ? undefined : checkedPluginDependency(expected);
  const installed = current === undefined ? undefined : checkedPluginDependency(current);
  if (JSON.stringify(original) !== JSON.stringify(installed)) pluginFail('IRIS_PLUGIN_DEPENDENCY_MISMATCH', '原任务依赖的插件或贡献版本不一致；请恢复准确版本，不会重新提交');
}
export function pluginDependency(manifest, kind, localId) {
  const entry = manifest.contributions[kind]?.find(item => item.id === localId);
  if (!entry) pluginFail('IRIS_PLUGIN_CONTRIBUTION_MISSING', '插件未声明此贡献');
  return checkedPluginDependency({ contractVersion: PLUGIN_CONTRACT_VERSION, pluginId: manifest.id, pluginVersion: manifest.version,
    kind, contributionId: qualifiedPluginId(manifest.id, localId), contributionVersion: entry.version });
}
