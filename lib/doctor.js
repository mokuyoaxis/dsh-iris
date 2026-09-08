'use strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { attentionDisposition, deriveUserState, semanticViolations } from './task-semantics.js';

const PACKAGE_FILE = new URL('../package.json', import.meta.url);

function readPackageVersion() {
  try { return JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8')).version || 'unknown'; } catch (_) { return 'unknown'; }
}

function result(id, status, summary, suggestion) {
  return { id, status, summary, ...(suggestion ? { suggestion } : {}) };
}

function parseVersion(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

function atLeast(actual, required) {
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}

function readJson(file) {
  if (!fs.existsSync(file)) return { exists: false, value: null };
  try { return { exists: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (_) { return { exists: true, value: null, error: 'JSON 无法解析' }; }
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isGroupOrWorldAccessible(target) {
  if (process.platform === 'win32' || !fs.existsSync(target)) return false;
  try { return (fs.lstatSync(target).mode & 0o077) !== 0; } catch (_) { return false; }
}

function privateFileModeProblems(dataDir) {
  if (process.platform === 'win32') return [];
  return ['providers.json', 'tasks.json', 'prompt-optimizer.json']
    .filter((name) => isGroupOrWorldAccessible(path.join(dataDir, name)));
}

function commandAvailable(command, runner) {
  try {
    const run = runner(command, ['-version']);
    return Boolean(run && run.status === 0 && !run.error);
  } catch (_) { return false; }
}

function nearestExisting(target) {
  let current = target;
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function writableProbe(dataDir) {
  const base = fs.existsSync(dataDir) ? dataDir : nearestExisting(path.dirname(dataDir));
  if (!base) return false;
  const probe = path.join(base, `.iris-doctor-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(probe, 'probe', { flag: 'wx', mode: 0o600 });
    fs.rmSync(probe);
    return true;
  } catch (_) {
    try { fs.rmSync(probe, { force: true }); } catch (_) {}
    return false;
  }
}

function inspectConfig(dataDir, checks) {
  const config = readJson(path.join(dataDir, 'providers.json'));
  if (!config.exists) {
    checks.push(result('config', 'warn', '尚未创建供应商配置', '启动 Iris 后在工作台添加供应商，或准备好 DSH_HOME 后再运行 doctor。'));
    return { providers: [], assignments: {} };
  }
  if (config.error || !plain(config.value) || !Array.isArray(config.value.providers)
      || !plain(config.value.assignments || {})) {
    checks.push(result('config', 'error', 'providers.json 结构无效或无法解析', '先备份该文件，再从 Iris 工作台重新配置；不要把密钥粘贴到诊断输出。'));
    return { providers: [], assignments: {} };
  }
  const providers = config.value.providers;
  let incomplete = 0;
  let enabled = 0;
  let models = 0;
  for (const provider of providers) {
    if (!plain(provider)) { incomplete++; continue; }
    if (provider.enabled !== false) enabled++;
    if (provider.enabled !== false && (!String(provider.baseUrl || '').trim() || !String(provider.apiKey || '').trim())) incomplete++;
    models += Array.isArray(provider.models) ? provider.models.length : 0;
  }
  if (incomplete) checks.push(result('providers', 'warn', `${incomplete} 个启用供应商缺少 Base URL、API Key 或结构无效`, '在 Iris 工作台补全或停用对应供应商。'));
  else if (!enabled) checks.push(result('providers', 'warn', '没有启用的供应商', '在 Iris 工作台启用至少一个供应商。'));
  else checks.push(result('providers', 'ok', `${enabled} 个供应商已启用；凭据未输出`));
  const assignments = config.value.assignments || {};
  const assignmentCount = Object.keys(assignments).length;
  if (!models) checks.push(result('models', 'warn', '模型池为空或尚未发现模型', '在工作台对供应商执行“发现模型”，再核对能力标签。'));
  else checks.push(result('models', 'ok', `模型池记录 ${models} 个模型，能力分配 ${assignmentCount} 项`));
  return { providers, assignments };
}

function inspectTasks(dataDir, checks) {
  const stored = readJson(path.join(dataDir, 'tasks.json'));
  if (!stored.exists) {
    checks.push(result('tasks', 'ok', '尚无任务记录'));
    return [];
  }
  if (stored.error || !plain(stored.value) || !Array.isArray(stored.value.tasks)) {
    checks.push(result('tasks', 'error', 'tasks.json 结构无效或无法解析', '保留损坏文件作为证据；重新启动 Iris 会尝试隔离并建立新任务表。'));
    return [];
  }
  let invalid = 0;
  let attention = 0;
  for (const task of stored.value.tasks) {
    if (!plain(task) || !String(task.id || '').trim()) { invalid++; continue; }
    if (task.schemaVersion === 2) {
      if (semanticViolations(task).length) invalid++;
      const userState = deriveUserState(task);
      if (['watching_paused', 'needs_attention', 'artifact_unavailable'].includes(userState)
          && attentionDisposition(task).status !== 'acknowledged') attention++;
    } else if (task.status === 'running' && !task.remoteTaskId) attention++;
  }
  if (invalid) checks.push(result('tasks', 'error', `${invalid} 条任务记录语义或结构无效`, '不要手工改写任务事实；先备份 tasks.json 并保留损坏证据。'));
  else if (attention) checks.push(result('tasks', 'warn', `${stored.value.tasks.length} 条任务中有 ${attention} 条需要人工确认`, '在 Iris 工作台的“需要处理”分区查看，并选择重新观察、重新交付、标为已读或知情重试。'));
  else checks.push(result('tasks', 'ok', `${stored.value.tasks.length} 条任务记录结构有效`));
  return stored.value.tasks.filter(plain);
}

function inspectArtifacts(dataDir, tasks, checks) {
  const outputs = path.join(dataDir, 'outputs');
  const referenced = new Set();
  let missing = 0;
  for (const task of tasks) {
    for (const name of task.files || []) {
      const safe = path.basename(String(name));
      referenced.add(safe);
      try { if (!fs.statSync(path.join(outputs, safe)).isFile()) missing++; } catch (_) { missing++; }
    }
    for (const item of task.media || []) if (item && item.file) referenced.add(path.basename(String(item.file)));
    for (const item of task.attachments || []) if (item && item.file) referenced.add(path.basename(String(item.file)));
  }
  let orphan = 0;
  if (fs.existsSync(outputs)) {
    for (const name of fs.readdirSync(outputs)) {
      const target = path.join(outputs, name);
      try { if (fs.lstatSync(target).isFile() && !referenced.has(name)) orphan++; } catch (_) {}
    }
  }
  if (missing) checks.push(result('artifacts', 'warn', `${missing} 个任务产物不可访问；另有 ${orphan} 个孤儿文件`, '在工作台检查任务详情并运行孤儿产物扫描。'));
  else if (orphan) checks.push(result('artifacts', 'warn', `${orphan} 个产物文件没有任务引用`, '先在工作台运行孤儿扫描，确认后再删除。'));
  else checks.push(result('artifacts', 'ok', `${referenced.size} 个已引用产物可核对，未发现孤儿文件`));

  const uploads = path.join(dataDir, 'uploads');
  let temporary = 0;
  if (fs.existsSync(uploads)) {
    for (const name of fs.readdirSync(uploads)) if (name.endsWith('.part')) temporary++;
  }
  checks.push(temporary
    ? result('temporary-files', 'warn', `${temporary} 个上传临时 .part 文件残留`, '确认没有上传进行中后重启 Iris，由启动清理逻辑处理。')
    : result('temporary-files', 'ok', '未发现上传临时文件残留'));
}

/**
 * 零网络离线诊断。仅创建并立即删除一个写入探针；不启动 DSH、不读取或输出 API Key。
 */
export async function doctor(options = {}) {
  const dshHome = path.resolve(options.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const dataDir = path.join(dshHome, 'iris', 'v1');
  const runner = options.commandRunner || ((command, args) => spawnSync(command, args, { stdio: 'ignore', shell: false }));
  const sharpLoader = options.sharpLoader || (() => import('sharp'));
  const nodeVersion = options.nodeVersion || process.versions.node;
  const checks = [];

  checks.push(atLeast(parseVersion(nodeVersion), [20, 10, 0])
    ? result('node', 'ok', `Node.js ${nodeVersion}`)
    : result('node', 'error', `Node.js ${nodeVersion} 低于最低要求 20.10.0`, '升级 Node.js 后再运行 Iris。'));
  try { await sharpLoader(); checks.push(result('sharp', 'ok', 'sharp 可加载')); }
  catch (_) { checks.push(result('sharp', 'error', 'sharp 无法加载', '在当前平台重新安装 @mokuyoaxis/dsh-iris，确认 sharp 有可用的 ARM64/系统构建。')); }
  for (const command of ['ffmpeg', 'ffprobe']) {
    checks.push(commandAvailable(command, runner)
      ? result(command, 'ok', `${command} 可用`)
      : result(command, 'warn', `${command} 不可用`, '视频抽帧与摘要需要 ffmpeg/ffprobe；其他 Iris 能力不受影响。'));
  }

  const dataExists = fs.existsSync(dataDir);
  if (dataExists) {
    let symlink = false;
    try { symlink = fs.lstatSync(dataDir).isSymbolicLink(); } catch (_) {}
    if (symlink) checks.push(result('storage', 'error', 'Iris 数据目录是符号链接，私有边界无法保证', '改用真实的私有目录并人工迁移数据。'));
    else if (!writableProbe(dataDir)) checks.push(result('storage', 'error', 'Iris 数据目录不可写', '修复当前用户对 $DSH_HOME/iris/v1 的写权限。'));
    else if (isGroupOrWorldAccessible(dataDir)) checks.push(result('storage', 'warn', 'Iris 数据目录允许组或其他用户访问', '在 POSIX 上将目录权限收紧为 0700、文件收紧为 0600。'));
    else {
      const exposedFiles = privateFileModeProblems(dataDir);
      checks.push(exposedFiles.length
        ? result('storage', 'warn', `${exposedFiles.length} 个私有数据文件允许组或其他用户访问`, '在 POSIX 上将 providers.json、tasks.json 与提示词配置权限收紧为 0600。')
        : result('storage', 'ok', 'Iris 数据目录可写、私有文件权限合格，临时探针已清理'));
    }
  } else {
    checks.push(writableProbe(dataDir)
      ? result('storage', 'ok', 'Iris 数据目录尚未创建；父目录可写，临时探针已清理')
      : result('storage', 'error', 'Iris 数据目录不存在且父目录不可写', '设置一个当前用户可写的 DSH_HOME。'));
  }

  inspectConfig(dataDir, checks);
  const taskRecords = inspectTasks(dataDir, checks);
  inspectArtifacts(dataDir, taskRecords, checks);
  checks.push(result('scope', 'ok', '离线模式未启动 DSH、未检查浏览器/工具注册，也未发送供应商请求'));

  const errors = checks.filter((item) => item.status === 'error').length;
  const warnings = checks.filter((item) => item.status === 'warn').length;
  return {
    schemaVersion: 1,
    package: { name: '@mokuyoaxis/dsh-iris', version: options.packageVersion || readPackageVersion() },
    mode: 'offline',
    environment: { node: nodeVersion, platform: process.platform, arch: process.arch },
    checks,
    summary: { ok: checks.length - errors - warnings, warnings, errors },
    exitCode: errors ? 2 : (warnings ? 1 : 0)
  };
}

export function formatDoctorReport(report) {
  const mark = { ok: '✓', warn: '!', error: '✗' };
  const lines = [`Iris Doctor ${report.package.version} · ${report.mode}`];
  for (const check of report.checks) {
    lines.push(`${mark[check.status] || '-'} ${check.id}: ${check.summary}`);
    if (check.suggestion) lines.push(`  建议：${check.suggestion}`);
  }
  lines.push(`结果：${report.summary.errors} 错误，${report.summary.warnings} 警告`);
  return lines.join('\n');
}
