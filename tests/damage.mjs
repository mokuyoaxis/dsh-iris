/**
 * dsh-iris 持久化损坏隔离测试（阶段 0）。
 * 运行：node tests/damage.mjs
 * 验证 tasks.json / providers.json：
 *   ① 文件不存在 = 首次运行，正常初始化（不产生 corrupted 隔离文件）；
 *   ② 文件存在但损坏 → 隔离为 *.corrupted-*，不静默覆盖证据，原内容仍在隔离文件里；
 *   ③ 隔离后创建的新文件是合法 JSON，可继续读写；
 *   ④ POSIX 落盘文件创建时即 0600；
 *   ⑤ 损坏隔离记录诊断日志（不炸进程）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-damage-home');
const irisV1 = path.join(process.env.DSH_HOME, 'iris', 'v1');

const assert = (cond, msg, extra) => {
  if (!cond) {
    console.log('FAIL:', msg, extra === undefined ? '' : (' | ' + JSON.stringify(extra)));
    process.exit(1);
  }
};

const tasksFile = () => path.join(irisV1, 'tasks.json');
const provFile = () => path.join(irisV1, 'providers.json');
const POSIX_MODE = process.platform !== 'win32';

const config = await import('../lib/config.js');
const tasks = await import('../lib/tasks.js');

/* ---------- ① 文件不存在 → 首次初始化 ---------- */
let t0 = tasks.create({ cap: 'image', providerId: 'p1', model: 'm', prompt: 'first' });
assert(t0 && tasks.get(t0.id).status === 'running', '首次初始化可写');
assert(fs.existsSync(tasksFile()), '首次初始化生成 tasks.json');
if (POSIX_MODE) assert((fs.statSync(tasksFile()).mode & 0o777) === 0o600, 'tasks.json 创建即 0600', (fs.statSync(tasksFile()).mode & 0o777).toString(8));

// 临时文件在 persist 期间也 0600：直接模拟一次 writeFileSync 观测 .tmp 不存在（rename 已消费），
// 用 mode 选项验证新建即 0600 由 persist 内部保证——这里通过 stat 最终文件确认。
let m = fs.statSync(tasksFile()).mode;
if (POSIX_MODE) assert((m & 0o600) === 0o600, 'tasks.json 0600 位');

/* ---------- ② tasks.json 损坏 → 隔离，不静默覆盖 ---------- */
tasks.resetCache(); // 使下次读取走盘
const GARBAGE = 'this is { not : valid json !!!\n\x00binary\x01';
fs.writeFileSync(tasksFile(), GARBAGE);
let logged = '';
const origError = console.error;
console.error = (...a) => { logged += a.join(' '); };

let damaged;
try {
  damaged = tasks.create({ cap: 'video', providerId: 'p1', model: 'm', prompt: 'after-corrupt' });
} finally {
  console.error = origError;
}
assert(damaged && damaged.status === 'running', '损坏后仍可继续创建（降级空表）');
assert(/已隔离/.test(logged), '损坏隔离有诊断日志', logged.slice(0, 80));

const isolated = fs.readdirSync(irisV1).filter((f) => /^tasks\.json\.corrupted-\d+-[a-f0-9]+$/.test(f));
assert(isolated.length === 1, '损坏文件被隔离保留', fs.readdirSync(irisV1));
assert(fs.readFileSync(path.join(irisV1, isolated[0]), 'utf8') === GARBAGE, '隔离文件保留原损坏内容（证据不丢）');
assert(fs.existsSync(tasksFile()), '隔离后重建新 tasks.json');
if (POSIX_MODE) assert((fs.statSync(tasksFile()).mode & 0o600) === 0o600, '重建的 tasks.json 仍 0600');

/* ---------- ③ providers.json 损坏 → 隔离 ---------- */
fs.writeFileSync(provFile(), '{oops');
let loggedP = '';
console.error = (...a) => { loggedP += a.join(' '); };
try {
  config.load();
} finally {
  console.error = origError;
}
assert(/已隔离/.test(loggedP), 'providers.json 损坏隔离有日志', loggedP.slice(0, 80));
let pIsolated = fs.readdirSync(irisV1).filter((f) => /^providers\.json\.corrupted-\d+-[a-f0-9]+$/.test(f));
assert(pIsolated.length === 1, 'providers 损坏文件隔离', fs.readdirSync(irisV1));
assert(fs.existsSync(provFile()), 'providers 重建');
if (POSIX_MODE) assert((fs.statSync(provFile()).mode & 0o600) === 0o600, 'providers 0600');

/* ---------- ④ providers 正常读写 + 0600 ---------- */
config.resetCache();
const prov = config.upsert({ id: 'p_x', name: '测试', type: 'openai', baseUrl: 'http://x', apiKey: 'k', enabled: true });
assert(prov && config.providers().length === 1, '损坏隔离后 providers 可正常写入');
if (POSIX_MODE) assert((fs.statSync(provFile()).mode & 0o600) === 0o600, '写入后 providers 仍 0600');

/* ---------- ⑤ 隔离文件不参与正常读取（新表独立） ---------- */
assert(tasks.get(damaged.id).status === 'running', '隔离后的新任务可查');

/* ---------- ⑥ 语法合法但结构错误同样隔离 ---------- */
tasks.resetCache();
fs.writeFileSync(tasksFile(), '[]');
assert(tasks.list().length === 0, 'tasks 根数组不会伪装成空任务表');
const taskBackups = fs.readdirSync(irisV1).filter((f) => f.startsWith('tasks.json.corrupted-'));
assert(taskBackups.length === 2, 'tasks 结构损坏被另行隔离', taskBackups);

for (const invalidConfig of [
  '[]',
  JSON.stringify({ version: 1, providers: [], assignments: [] }),
  JSON.stringify({ version: 1, providers: [null], assignments: {} })
]) {
  config.resetCache();
  fs.writeFileSync(provFile(), invalidConfig);
  assert(config.load().providers.length === 0, '结构损坏后恢复为空配置');
}
pIsolated = fs.readdirSync(irisV1).filter((f) => f.startsWith('providers.json.corrupted-'));
assert(pIsolated.length === 4, '三类语义损坏均保留证据', pIsolated);

console.log('ALL OK —— 持久化损坏隔离通过（语法损坏/根数组/错误 assignments/空 provider/私有权限）');
