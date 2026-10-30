import { checkedPluginDependency, pluginFail } from './plugin-contract.js';

/** Saved authority is an exact dependency list, never a live registry expansion. */
export function checkedPluginSelection(value = []) {
  if (!Array.isArray(value) || value.length > 16) pluginFail('IRIS_CONNECTION_INPUT_INVALID', '插件业务须为最多 16 项明确依赖');
  let result;
  try { result = value.map(checkedPluginDependency); }
  catch (error) { if (error.code !== 'IRIS_PLUGIN_INVALID') throw error; pluginFail('IRIS_CONNECTION_INPUT_INVALID', '插件业务依赖格式无效'); }
  if (result.some(item => item.kind !== 'operations') || new Set(result.map(item => item.contributionId)).size !== result.length) pluginFail('IRIS_CONNECTION_INPUT_INVALID', '插件业务依赖重复或类型无效');
  return result;
}
export function hasPluginSelection(values, dependency) {
  const pin = checkedPluginDependency(dependency);
  return values.some(value => JSON.stringify(checkedPluginDependency(value)) === JSON.stringify(pin));
}
