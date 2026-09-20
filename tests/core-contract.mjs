import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  CORE_ACCESS_MODES,
  CORE_CONTRACT_VERSION,
  CORE_LIFECYCLE_STATES,
  CORE_OPERATIONS,
  CoreContractError,
  assertCoreOperation,
  coreDataRootBusyError,
  createCoreLifecycle,
  normalizeCoreOptions,
  transitionCoreLifecycle
} from '../lib/core-contract.js';

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

assert(CORE_CONTRACT_VERSION === 0, '首版 Core Runtime 候选契约必须显式为 v0');
assert(CORE_ACCESS_MODES.join(',') === 'reader,writer', '访问模式变化必须显式评审');
assert(CORE_LIFECYCLE_STATES.join(',') === 'created,started,disposing,disposed', '生命周期变化必须显式评审');
assert(CORE_OPERATIONS.join(',') === 'inspect,execute,recover', '副作用分类变化必须显式评审');

const root = path.join(os.tmpdir(), 'iris-core-contract', '..', 'iris-core-contract-data');
const writer = normalizeCoreOptions({ dataRoot: root });
assert(Object.isFrozen(writer) && writer.mode === 'writer' && writer.dataRoot === path.normalize(root),
  '选项必须规范化并冻结', writer);
const reader = normalizeCoreOptions({ dataRoot: root, mode: 'reader' });

for (const invalid of [
  null,
  {},
  { dataRoot: 'relative/path' },
  { dataRoot: path.resolve(root), mode: 'shared-writer' },
  { dataRoot: path.resolve(root), ctx: {} },
  { dataRoot: path.resolve(root), secret: 'must-not-cross-boundary' }
]) {
  let error;
  try { normalizeCoreOptions(invalid); } catch (caught) { error = caught; }
  assert(error instanceof CoreContractError && error.code === 'IRIS_CORE_OPTIONS_INVALID',
    '非法 Core 选项必须稳定失败', { invalid, code: error?.code });
}

const created = createCoreLifecycle();
const started = transitionCoreLifecycle(created, 'start');
assertCoreOperation(writer, started, 'inspect');
assertCoreOperation(writer, started, 'execute');
assertCoreOperation(writer, started, 'recover');
assertCoreOperation(reader, started, 'inspect');

for (const operation of ['execute', 'recover']) {
  let error;
  try { assertCoreOperation(reader, started, operation); } catch (caught) { error = caught; }
  assert(error?.code === 'IRIS_CORE_READ_ONLY', `reader 必须拒绝 ${operation}`, error?.code);
}

const disposing = transitionCoreLifecycle(started, 'dispose');
assert(transitionCoreLifecycle(disposing, 'dispose') === disposing, 'dispose 必须可幂等调用');
const disposed = transitionCoreLifecycle(disposing, 'finish-dispose');
assert(transitionCoreLifecycle(disposed, 'dispose') === disposed, '已释放实例再次 dispose 必须无副作用');
for (const [snapshot, event] of [[started, 'start'], [disposed, 'start'], [created, 'finish-dispose']]) {
  let error;
  try { transitionCoreLifecycle(snapshot, event); } catch (caught) { error = caught; }
  assert(error?.code === 'IRIS_CORE_STATE_INVALID', `${snapshot.state} / ${event} 必须拒绝`, error?.code);
}

const busy = coreDataRootBusyError();
assert(busy.code === 'IRIS_CORE_DATA_ROOT_BUSY' && !busy.message.includes(root),
  '写者冲突错误必须稳定且不泄露绝对路径', busy.message);

const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-core-no-dsh-'));
try {
  const loader = path.join(isolated, 'block-dsh.mjs');
  fs.writeFileSync(loader, `export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cordis' || specifier === 'dsh' || specifier.startsWith('@deepseek-ai/')) {
    throw new Error('DSH/Cordis intentionally unavailable');
  }
  return nextResolve(specifier, context);
}
  `);
  const probe = spawnSync(process.execPath, [
    '--no-warnings', '--experimental-loader', pathToFileURL(loader).href, '--input-type=module', '--eval',
    `await Promise.all([import(${JSON.stringify(new URL('../lib/core-contract.js', import.meta.url).href)}), import(${JSON.stringify(new URL('../lib/core-runtime.js', import.meta.url).href)}), import(${JSON.stringify(new URL('../lib/core-tasks.js', import.meta.url).href)}), import(${JSON.stringify(new URL('../lib/provider-task-runner.js', import.meta.url).href)}), import(${JSON.stringify(new URL('../lib/command-service.js', import.meta.url).href)})])`
  ], { cwd: isolated, encoding: 'utf8' });
  assert(probe.status === 0, 'Core 契约与 Runtime 必须在 DSH/Cordis 不可解析时装载',
    (probe.stderr || probe.stdout || '').trim());
} finally {
  fs.rmSync(isolated, { recursive: true, force: true });
}

const source = fs.readFileSync(new URL('../lib/core-contract.js', import.meta.url), 'utf8');
assert(!/@deepseek-ai\/|from ['"](?:cordis|dsh)/.test(source), 'Core 契约不得导入 DSH/Cordis');
const contract = fs.readFileSync(new URL('../docs/CORE_RUNTIME_CONTRACT.md', import.meta.url), 'utf8');
for (const phrase of ['每个数据根只允许一个写者', '只读不是隐式写入', '不得自动夺取', '不触发供应商请求']) {
  assert(contract.includes(phrase), `Core Runtime 契约缺少不可违反规则：${phrase}`);
}

console.log('ALL OK —— Core Runtime v0 显式数据根、单写者、只读边界和生命周期真值表通过');
