// Current choices come from Core; saved grants remain explicit and never expand on install.
import { CORE_CONTROL_TOOLS, CORE_BRIDGE_GROUPS, CORE_PLUGIN_CONTROL_TOOLS } from './core-capability-catalog.js';
export const BRIDGE_CONTROL_TOOLS = CORE_CONTROL_TOOLS;
export const BRIDGE_CAPABILITIES = CORE_BRIDGE_GROUPS;
export const BRIDGE_TOOL_NAMES = Object.freeze([...new Set([...BRIDGE_CONTROL_TOOLS, ...BRIDGE_CAPABILITIES.flatMap(item => item.tools), ...CORE_PLUGIN_CONTROL_TOOLS])]);
export const DEFAULT_BRIDGE_CAPABILITIES = Object.freeze(['image-edit']);
// Frozen compatibility boundary for old files that predate explicit selection.
export const LEGACY_BRIDGE_TOOLS_V0 = Object.freeze([
  'iris_core_connection', 'iris_core_models', 'iris_core_runs', 'iris_core_run', 'iris_core_import_image',
  'iris_core_create_run', 'iris_core_continue', 'iris_core_operation', 'iris_core_lookup', 'iris_core_stop',
  'iris_core_image', 'iris_core_connections'
]);

function invalid(message) { throw Object.assign(new Error(message), { code: 'IRIS_CONNECTION_INPUT_INVALID' }); }
export function checkedBridgeCapabilities(value) {
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(id => !BRIDGE_CAPABILITIES.some(item => item.id === id))) {
    invalid('能力须为明确支持的功能分组列表；未接入的媒体功能不能启用');
  }
  return [...value];
}
export function checkedBridgeTools(value) {
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(name => !BRIDGE_TOOL_NAMES.includes(name))) {
    invalid('工具须为已知 MCP 工具名称的明确列表');
  }
  return [...value];
}
export function selectedBridgeTools(capabilities = DEFAULT_BRIDGE_CAPABILITIES, tools = BRIDGE_TOOL_NAMES, pluginOperations = []) {
  const enabled = new Set([...BRIDGE_CONTROL_TOOLS, ...BRIDGE_CAPABILITIES.filter(item => capabilities.includes(item.id)).flatMap(item => item.tools),
    ...(pluginOperations.length ? CORE_PLUGIN_CONTROL_TOOLS : [])]);
  return tools.filter(name => enabled.has(name));
}
