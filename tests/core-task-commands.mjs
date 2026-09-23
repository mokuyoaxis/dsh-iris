import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandService } from '../lib/command-service.js';
import { createCoreRuntime } from '../lib/core-runtime.js';
import {
  beginCoreAttempt,
  createCoreTask,
  recordCoreAttemptResult
} from '../lib/core-tasks.js';

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

function inventory(root) {
  const walk = (directory, prefix = '') => fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name !== '.iris-runtime-writer-v0')
    .flatMap((entry) => {
      const relative = path.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? [relative + '/', ...walk(absolute, relative)]
        : [relative + ':' + fs.readFileSync(absolute).toString('base64')];
    });
  return walk(root).join('\n');
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-task-command-'));
try {
  const dataRoot = path.join(base, 'data');
  const writer = createCoreRuntime({ dataRoot, mode: 'writer' });
  writer.start();
  const writerCommands = createCommandService(writer);
  assert(writerCommands.commands.includes('task.list') && writerCommands.commands.includes('task.inspect')
      && writerCommands.commands.includes('task.observe'),
    'Command 注册表必须暴露 Task reader 与显式 observe');
  const first = await writer.run('execute', ({ dataRoot: root }) => createCoreTask(root, { capability: 'image' }));
  const second = await writer.run('execute', ({ dataRoot: root }) => createCoreTask(root, { capability: 'video' }));
  await writer.dispose();

  const before = inventory(dataRoot);
  const reader = createCoreRuntime({ dataRoot, mode: 'reader' });
  reader.start();
  const commands = createCommandService(reader);
  const listed = await commands.execute('task.list', { offset: 0, limit: 1 });
  assert(Object.isFrozen(listed) && listed.command === 'task.list'
      && listed.total === 2 && listed.tasks.length === 1,
    'task.list 必须返回带分页的冻结事实', listed);
  const inspected = await commands.execute('task.inspect', { task_id: first.id });
  assert(Object.isFrozen(inspected) && Object.isFrozen(inspected.task)
      && inspected.task.id === first.id && inspected.task.capability === 'image',
    'task.inspect 必须返回同一冻结 Task', inspected);

  let extraError;
  try { await commands.execute('task.list', { secret: 'must-not-cross' }); } catch (error) { extraError = error; }
  assert(extraError?.code === 'IRIS_COMMAND_INPUT_INVALID', 'task.list 必须拒绝未声明输入字段', extraError?.code);
  let invalidError;
  try { await commands.execute('task.inspect', { task_id: 'task_invalid' }); } catch (error) { invalidError = error; }
  assert(invalidError?.code === 'IRIS_TASK_ID_INVALID', 'task.inspect 必须保留稳定 Task ID 错误', invalidError?.code);
  await reader.dispose();
  assert(inventory(dataRoot) === before && !fs.existsSync(path.join(dataRoot, '.iris-runtime-writer-v0')),
    'Task reader 不得修改记录或建立 writer 租约');

  const emptyRoot = path.join(base, 'empty');
  const emptyWriter = createCoreRuntime({ dataRoot: emptyRoot, mode: 'writer' });
  emptyWriter.start();
  await emptyWriter.dispose();
  const emptyBefore = inventory(emptyRoot);
  const emptyReader = createCoreRuntime({ dataRoot: emptyRoot, mode: 'reader' });
  emptyReader.start();
  const empty = await createCommandService(emptyReader).execute('task.list', {});
  await emptyReader.dispose();
  assert(empty.total === 0 && empty.tasks.length === 0 && inventory(emptyRoot) === emptyBefore
      && !fs.existsSync(path.join(emptyRoot, 'task-store')),
    '空数据根上的 task.list 必须返回空列表且零写入', empty);

  const observeRoot = path.join(base, 'observe');
  const observeWriter = createCoreRuntime({ dataRoot: observeRoot, mode: 'writer' });
  observeWriter.start();
  const accepted = await observeWriter.run('execute', ({ dataRoot: root }) => {
    const task = createCoreTask(root, { capability: 'image' });
    const attempt = beginCoreAttempt(root, task.id, {
      providerId: 'fake', model: 'fake::image-v0', providerBinding: 'sha256:' + 'a'.repeat(64)
    });
    return recordCoreAttemptResult(root, task.id, {
      ...attempt, acceptance: 'accepted', resultKind: 'accepted', remoteTaskId: 'remote-no-port'
    });
  });
  const acceptedFile = path.join(observeRoot, 'task-store', 'v0', 'tasks', accepted.id + '.json');
  const acceptedBefore = fs.readFileSync(acceptedFile, 'utf8');
  let providerError;
  try {
    await createCommandService(observeWriter).execute('task.observe', { task_id: accepted.id });
  } catch (error) { providerError = error; }
  assert(providerError?.code === 'IRIS_COMMAND_PROVIDER_REQUIRED'
      && fs.readFileSync(acceptedFile, 'utf8') === acceptedBefore,
    'Core Command 不得隐式读取供应商配置；没有 resolver 时必须零写入失败', providerError?.code);
  await observeWriter.dispose();

  assert(second.id !== first.id, 'Task ID 必须稳定且唯一');
  console.log('ALL OK —— Core Task reader 与显式 observe 端口、分页、稳定错误和零写入通过');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
