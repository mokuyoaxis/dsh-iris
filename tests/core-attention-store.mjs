/**
 * Core 注意力处置偏好（Host 偏好层）存储验收。
 * 运行：node tests/core-attention-store.mjs
 *
 * 验证：原子写（tmp+rename 无残留）、权限 0600、损坏降级为无偏好、动作幂等
 * （偏好不变不写盘）、正交语义（acknowledge/hide 互不清除）、绝不触碰 Core 数据根。
 */
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

const { root, cleanup } = useTempDshHome('iris-core-attention-store');
const {
  applyCoreAttentionAction,
  attentionDispositionOf,
  readCoreAttentionPrefs
} = await import('../lib/core-attention.js');
const { irisHome, dshCoreDataRoot } = await importClientModules();

async function importClientModules() {
  const config = await import('../lib/config.js');
  const dsh = await import('../lib/dsh-core-adapter.js');
  return { irisHome: config.irisHome, dshCoreDataRoot: dsh.dshCoreDataRoot };
}

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const file = () => path.join(irisHome(), 'core-attention.json');
const TASK_A = 'task_' + 'a'.repeat(24);
const TASK_B = 'task_' + 'b'.repeat(24);

try {
  /* 起始：文件缺失即无偏好，且不创建文件 */
  const empty = readCoreAttentionPrefs();
  assert(empty.version === 1 && Object.keys(empty.entries).length === 0 && !fs.existsSync(file()),
    '缺失的偏好文件必须视为无偏好且不创建', empty);

  /* 写：原子落盘、0600、内容只含指针与时间 */
  const first = applyCoreAttentionAction(TASK_A, 'acknowledge');
  assert(first.changed === true && first.disposition === 'acknowledged', '首次受理必须变化', first);
  assert(fs.existsSync(file()) && (fs.statSync(file()).mode & 0o777) === 0o600,
    '偏好文件必须 0600', fs.statSync(file()).mode);
  const content = fs.readFileSync(file(), 'utf8');
  const parsed = JSON.parse(content);
  assert(parsed.version === 1 && typeof parsed.entries[TASK_A].acknowledgedAt === 'string'
      && !content.includes('prompt') && !content.includes(root + '/core-v0'),
    '偏好文件只存指针与时间戳', parsed);
  assert(!fs.readdirSync(irisHome()).some((name) => name.startsWith('core-attention.json.tmp')),
    '原子写不得残留 tmp 文件', fs.readdirSync(irisHome()));

  /* 幂等：同一动作再次执行偏好不变、文件字节不变 */
  const bytes1 = fs.readFileSync(file(), 'utf8');
  const again = applyCoreAttentionAction(TASK_A, 'acknowledge');
  assert(again.changed === false && fs.readFileSync(file(), 'utf8') === bytes1,
    '重复受理必须是幂等无写盘', again);

  /* 正交语义：acknowledge 与 hide 互不清除；restore 不解除 hide */
  applyCoreAttentionAction(TASK_A, 'hide');
  let prefs = readCoreAttentionPrefs();
  assert(prefs.entries[TASK_A].acknowledgedAt && prefs.entries[TASK_A].hiddenAt,
    'hide 必须保留 acknowledgedAt', prefs.entries[TASK_A]);
  assert(attentionDispositionOf(prefs.entries[TASK_A]) === 'hidden', 'hidden 优先');
  applyCoreAttentionAction(TASK_A, 'restore');
  prefs = readCoreAttentionPrefs();
  assert(!prefs.entries[TASK_A].acknowledgedAt && prefs.entries[TASK_A].hiddenAt
      && attentionDispositionOf(prefs.entries[TASK_A]) === 'hidden',
    'restore 只解除受理，不解除隐藏', prefs.entries[TASK_A]);
  const unhide = applyCoreAttentionAction(TASK_A, 'unhide');
  assert(unhide.changed === true
      && Object.keys(readCoreAttentionPrefs().entries).length === 0,
    'unhide 清空后条目应整体移除', readCoreAttentionPrefs());
  const secondTask = applyCoreAttentionAction(TASK_B, 'hide');
  assert(secondTask.disposition === 'hidden'
      && readCoreAttentionPrefs().entries[TASK_B].hiddenAt,
    '第二条任务互不影响', secondTask);

  /* 坏 ID / 非法动作 */
  for (const [taskId, action, code] of [
    ['not-a-task', 'acknowledge', 'IRIS_DSH_TASK_INVALID'],
    [TASK_A, 'destroy', 'IRIS_DSH_ATTENTION_INVALID']
  ]) {
    let error;
    try { applyCoreAttentionAction(taskId, action); } catch (caught) { error = caught; }
    assert(error?.code === code, '非法输入必须拒绝为 ' + code, error?.code);
  }
  assert(!fs.readFileSync(file(), 'utf8').includes('not-a-task'), '非法输入不得写盘');

  /* 损坏降级为无偏好（不报错、文件保留供人工查看） */
  fs.writeFileSync(file(), '{broken json', { mode: 0o600 });
  const degraded = readCoreAttentionPrefs();
  assert(Object.keys(degraded.entries).length === 0, '损坏文件必须降级为无偏好', degraded);
  const recovered = applyCoreAttentionAction(TASK_A, 'acknowledge');
  assert(recovered.changed === true && readCoreAttentionPrefs().entries[TASK_A].acknowledgedAt,
    '损坏后可正常恢复写入', recovered);

  /* 绝不触碰 Core 数据根 */
  assert(!fs.existsSync(dshCoreDataRoot()), '偏好层绝不得创建 Core 数据根');

  console.log('ALL OK —— Core 注意力偏好：原子写、0600、幂等、正交语义、损坏降级、零 Core 触碰');
} finally {
  cleanup();
}
