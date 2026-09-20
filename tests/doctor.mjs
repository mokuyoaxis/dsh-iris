import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempDshHome } from './test-env.js';
import { doctor, formatDoctorReport } from '../lib/doctor.js';

const { root } = useTempDshHome('iris-doctor');
const dataDir = path.join(root, 'iris', 'v1');
fs.mkdirSync(path.join(dataDir, 'outputs'), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(dataDir, 'outputs', 'ready.png'), 'ok');
fs.writeFileSync(path.join(dataDir, 'outputs', 'library-only.png'), 'kept-after-history-clear');
fs.writeFileSync(path.join(dataDir, 'artifacts.json'), JSON.stringify({
  version: 1,
  artifacts: [{
    id: 'a_1234567890abcdef', file: 'library-only.png', token: 'ab'.repeat(16),
    mime: 'image/png', size: 24, createdAt: new Date().toISOString()
  }]
}), { mode: 0o600 });
fs.writeFileSync(path.join(dataDir, 'providers.json'), JSON.stringify({
  version: 1,
  providers: [{
    id: 'p1', enabled: true, baseUrl: 'https://example.invalid/v1', apiKey: 'secret-never-print',
    models: [{ id: 'image-model', capabilities: ['image-gen'] }]
  }],
  assignments: { 'image-gen': ['p1::image-model'] }
}), { mode: 0o600 });
fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({
  version: 1,
  tasks: [
    { id: 'old-ok', status: 'succeeded', files: ['ready.png'], createdAt: new Date().toISOString() },
    {
      id: 'v2-acknowledged', schemaVersion: 2, status: 'running', phase: 'terminal',
      acceptance: 'unknown', watchState: 'idle', outcome: 'unknown', deliveryState: 'none', cancelState: 'none',
      attempts: [], manualRetries: [{ taskId: 'v2-retry', createdAt: new Date().toISOString() }],
      createdAt: new Date().toISOString()
    }
  ]
}), { mode: 0o600 });

const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};
const runner = () => ({ status: 0 });
const sharpLoader = async () => ({});
const healthy = await doctor({ dshHome: root, commandRunner: runner, sharpLoader, packageVersion: 'test' });
assert(healthy.exitCode === 0 && healthy.summary.errors === 0 && healthy.summary.warnings === 0, '健康 fixture 应退出 0', healthy);
assert(healthy.checks.some((item) => item.id === 'artifact-index' && item.status === 'ok')
  && healthy.checks.some((item) => item.id === 'artifacts' && item.status === 'ok'),
  '只有作品索引、没有任务引用的文件不应误报孤儿', healthy.checks);
assert(!JSON.stringify(healthy).includes('secret-never-print'), 'Doctor JSON 不得输出 API Key');
assert(!fs.readdirSync(dataDir).some((name) => name.startsWith('.iris-doctor-')), '写入探针必须清理');
assert(/Iris Doctor test/.test(formatDoctorReport(healthy)), '文本与 JSON 共用结果模型');

if (process.platform !== 'win32') {
  fs.chmodSync(path.join(dataDir, 'tasks.json'), 0o644);
  const exposed = await doctor({ dshHome: root, commandRunner: runner, sharpLoader });
  assert(exposed.exitCode === 1 && exposed.checks.some((item) => item.id === 'storage' && item.status === 'warn'),
    '私有文件权限过宽应给出警告', exposed);
  fs.chmodSync(path.join(dataDir, 'tasks.json'), 0o600);
}

const providersFile = path.join(dataDir, 'providers.json');
fs.writeFileSync(providersFile, JSON.stringify({ providers: [{
  id: 'no-auth', auth: 'none', mediaBaseUrl: 'http://local.invalid/v1',
  models: [{ id: 'image-model', capabilities: ['image-gen'] }]
}], assignments: {} }));
const noAuth = await doctor({ dshHome: root, commandRunner: runner, sharpLoader });
assert(noAuth.checks.find((item) => item.id === 'providers').status === 'ok',
  'auth:none 与独立媒体端点不得误报缺少凭据或端点', noAuth);
fs.writeFileSync(providersFile, JSON.stringify({ version: 1, providers: [{ id: 'bad', enabled: true }], assignments: {} }));
const warning = await doctor({ dshHome: root, commandRunner: runner, sharpLoader });
assert(warning.exitCode === 1 && warning.summary.warnings > 0 && warning.summary.errors === 0, '警告稳定退出码为 1', warning.summary);

fs.writeFileSync(providersFile, '{broken');
const broken = await doctor({ dshHome: root, commandRunner: runner, sharpLoader });
assert(broken.exitCode === 2 && broken.summary.errors > 0, '硬错误稳定退出码为 2', broken.summary);
assert(broken.checks.find((item) => item.id === 'config').suggestion, '每个配置硬错误带可执行建议');

const cli = spawnSync(process.execPath, ['bin/dsh-iris.js', 'doctor', '--json'], {
  cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  env: { ...process.env, DSH_HOME: root }, encoding: 'utf8', shell: false
});
assert([0, 1, 2].includes(cli.status), 'CLI 使用稳定诊断退出码', cli.status);
const cliJson = JSON.parse(cli.stdout);
assert(cliJson.schemaVersion === 1 && cliJson.mode === 'offline', 'CLI --json 输出公开结果模型');
assert(!cli.stdout.includes('secret-never-print'), 'CLI 不泄露密钥');

console.log('ALL OK —— 离线 Doctor 结果模型、环境/存储/配置/任务检查、脱敏与 CLI 退出码通过');
