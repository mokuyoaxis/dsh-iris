import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCoreTask } from '../lib/core-tasks.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-headless-cli-'));
const dataRoot = path.join(base, 'data');
const input = path.join(base, 'input.png');
const output = path.join(base, 'exported.png');

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

function cli(args) {
  return spawnSync(process.execPath, ['bin/dsh-iris.js', ...args], {
    cwd: repo,
    env: { ...process.env, DSH_HOME: path.join(base, 'must-not-be-used') },
    encoding: 'utf8',
    shell: false
  });
}

try {
  await sharp({ create: { width: 10, height: 8, channels: 4, background: '#6854d9' } }).png().toFile(input);
  const cropInput = JSON.stringify({ image_path: input, left: 2, top: 1, width: 5, height: 4 });
  const run = cli(['run', 'crop', '--data-root', dataRoot, '--input', cropInput]);
  assert(run.status === 0, 'CLI crop 必须成功', { stderr: run.stderr, stdout: run.stdout });
  const created = JSON.parse(run.stdout);
  const id = created.artifact?.id;
  assert(/^artifact_[a-f0-9]{24}$/.test(id)
    && created.artifact.metadata.width === 5 && created.artifact.metadata.height === 4,
  'crop 必须返回中性 Artifact', created);
  assert(!run.stdout.includes(input) && !run.stdout.includes(dataRoot), 'Command 结果不得泄露输入或数据根绝对路径');

  const taskRuntime = createCoreRuntime({ dataRoot, mode: 'writer' });
  taskRuntime.start();
  let task;
  try {
    task = await taskRuntime.run('execute', ({ dataRoot: rootPath }) =>
      createCoreTask(rootPath, { capability: 'image' }));
  } finally {
    await taskRuntime.dispose();
  }
  const taskFile = path.join(dataRoot, 'task-store', 'v0', 'tasks', task.id + '.json');
  const taskBefore = fs.readFileSync(taskFile, 'utf8');
  const taskList = cli(['task', 'list', '--data-root', dataRoot]);
  const listedTasks = JSON.parse(taskList.stdout);
  assert(taskList.status === 0 && listedTasks.command === 'task.list'
      && listedTasks.total === 1 && listedTasks.tasks[0].id === task.id,
    'CLI task list 必须跨进程只读列出 Core Task', { stderr: taskList.stderr, listedTasks });
  const taskInspect = cli(['task', 'inspect', task.id, '--data-root', dataRoot]);
  const inspectedTask = JSON.parse(taskInspect.stdout);
  assert(taskInspect.status === 0 && inspectedTask.command === 'task.inspect'
      && inspectedTask.task.id === task.id && inspectedTask.task.capability === 'image',
    'CLI task inspect 必须跨进程读取同一 Core Task', { stderr: taskInspect.stderr, inspectedTask });
  assert(fs.readFileSync(taskFile, 'utf8') === taskBefore
      && !fs.existsSync(path.join(dataRoot, '.iris-runtime-writer-v0')),
    'CLI task reader 不得修改 Task 或建立 writer 租约');
  const invalidTask = cli(['task', 'inspect', 'task_invalid', '--data-root', dataRoot]);
  assert(invalidTask.status === 1 && invalidTask.stderr.includes('IRIS_TASK_ID_INVALID')
      && !invalidTask.stderr.includes(dataRoot),
    'CLI task inspect 必须稳定拒绝无效 ID 且不泄露数据根', invalidTask.stderr);

  const inspect = cli(['artifact', 'inspect', id, '--data-root', dataRoot]);
  assert(inspect.status === 0, '新 CLI 进程必须能 inspect Artifact', inspect.stderr);
  const inspected = JSON.parse(inspect.stdout);
  assert(inspected.artifact.id === id && inspected.artifact.mediaType === 'image/png'
      && /^[a-f0-9]{64}$/.test(inspected.artifact.digest?.value),
    'inspect 必须返回同一 Artifact 与 SHA-256', inspected);

  const list = cli(['artifact', 'list', '--data-root', dataRoot]);
  const listed = JSON.parse(list.stdout);
  assert(list.status === 0 && listed.total === 1 && listed.artifacts[0].id === id,
    'CLI list 必须读取可丢弃 Index', { stderr: list.stderr, listed });
  fs.rmSync(path.join(dataRoot, 'artifact-store', 'v0', 'index.json'));
  const missingIndex = cli(['artifact', 'list', '--data-root', dataRoot]);
  assert(missingIndex.status === 1 && missingIndex.stderr.includes('IRIS_ARTIFACT_INDEX_INVALID'),
    'reader 不得隐式重建缺失 Index', missingIndex.stderr);
  const rebuild = cli(['artifact', 'rebuild', '--data-root', dataRoot]);
  assert(rebuild.status === 0 && JSON.parse(rebuild.stdout).total === 1,
    'writer 必须通过显式 rebuild 恢复 Index', rebuild.stderr);

  const exported = cli(['artifact', 'export', id, '--data-root', dataRoot, '--output', output]);
  assert(exported.status === 0 && fs.existsSync(output), '新 CLI 进程必须能 export Artifact', exported.stderr);
  const dimensions = await sharp(output).metadata();
  assert(dimensions.width === 5 && dimensions.height === 4, '导出文件必须保留裁剪尺寸', dimensions);

  const noOverwrite = cli(['artifact', 'export', id, '--data-root', dataRoot, '--output', output]);
  assert(noOverwrite.status === 1 && noOverwrite.stderr.includes('IRIS_ARTIFACT_EXPORT_EXISTS'),
    'export 默认不得覆盖已有文件', noOverwrite.stderr);

  const missingRoot = path.join(base, 'missing');
  const missing = cli(['artifact', 'inspect', id, '--data-root', missingRoot]);
  assert(missing.status === 1 && missing.stderr.includes('IRIS_CORE_DATA_ROOT_NOT_FOUND') && !fs.existsSync(missingRoot),
    'inspect 缺失数据根时必须失败且保持零写入', missing.stderr);

  const object = path.join(dataRoot, 'artifact-store', 'v0', 'objects', id + '.png');
  fs.appendFileSync(object, 'tampered-size');
  const invalid = cli(['artifact', 'inspect', id, '--data-root', dataRoot]);
  assert(invalid.status === 1 && invalid.stderr.includes('IRIS_ARTIFACT_DIGEST_MISMATCH'),
    'inspect 必须拒绝文件大小与记录不一致的 Artifact', invalid.stderr);

  const badRegion = cli(['run', 'crop', '--data-root', dataRoot, '--input',
    JSON.stringify({ image_path: input, left: 0, top: 0, width: 100, height: 100 })]);
  assert(badRegion.status === 1 && badRegion.stderr.includes('IRIS_COMMAND_INPUT_INVALID')
    && !badRegion.stderr.includes(input), '越界裁剪必须安全失败且不暴露输入路径', badRegion.stderr);
  assert(!fs.existsSync(path.join(base, 'must-not-be-used')), 'headless CLI 显式 dataRoot 时不得读取 DSH_HOME');
  console.log('ALL OK —— 无 DSH CLI 完成 Task reader、crop 与 Artifact inspect/list/rebuild/export，且不覆盖文件或泄露路径');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
