// Internal Core invocation boundary. No Provider implementations, Zod, module loading or filesystem.
import { freezePluginValue, pluginJson, pluginFail } from './plugin-contract.js';

const registries = new WeakMap();
export function registerPluginOperations(registry, state) { registries.set(registry, state); }

/** Reserve across the Core queue; the public registry never exposes an executable handler. */
export function reservePluginOperation(registry, id, input, allowedOperations, expectedDependency) {
  const owned = registries.get(registry);
  if (!owned) pluginFail('IRIS_PLUGIN_INVALID', '需要当前插件注册实例');
  owned.requireActive();
  const operation = owned.operations.get(id);
  if (!operation) pluginFail('IRIS_PLUGIN_CONTRIBUTION_MISSING', '业务贡献未加载');
  if (!Array.isArray(allowedOperations) || !allowedOperations.includes(id)) pluginFail('IRIS_PLUGIN_OPERATION_DENIED', '业务贡献未获本次 Core 装配授权');
  const dependency = registry.dependency('operations', id);
  if (expectedDependency !== undefined) {
    registry.assertDependency(expectedDependency);
    if (expectedDependency.kind !== 'operations' || expectedDependency.contributionId !== id) pluginFail('IRIS_PLUGIN_DEPENDENCY_MISMATCH', '不能用其他贡献的持久依赖执行当前业务');
  }
  const checked = operation.schema.safeParse(pluginJson(input));
  if (!checked.success) pluginFail('IRIS_PLUGIN_INPUT_INVALID', '输入不符合 ' + id + ' 的 Schema');
  let release;
  const done = new Promise(resolve => { release = () => { owned.active.delete(done); resolve(); }; });
  owned.active.add(done);
  return { mode: operation.descriptor.mode, commands: operation.descriptor.commands, artifactInputs: operation.descriptor.artifactInputs || [],
    input: freezePluginValue(checked.data), dependency, release,
    async invoke(context) { return { dependency, value: pluginJson(await operation.handler(freezePluginValue(checked.data), context)) }; } };
}
