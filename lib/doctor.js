'use strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { attentionDisposition, deriveUserState, semanticViolations } from './task-semantics.js';
import { HOST_CONTRACT_VERSION, hostCapabilitySnapshot } from './host-contract.js';
import {
  EXPECTED_IRIS_CLIENT_SEATS, EXPECTED_IRIS_ROUTES, EXPECTED_IRIS_SKILLS, EXPECTED_IRIS_TOOLS,
  HOST_CLIENT_PROTOCOL_VERSION, IRIS_PLUGIN_ID
} from './host-runtime.js';

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
  return ['providers.json', 'tasks.json', 'artifacts.json', 'prompt-optimizer.json']
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

  const library = readJson(path.join(dataDir, 'artifacts.json'));
  if (library.exists && (library.error || !plain(library.value) || !Array.isArray(library.value.artifacts))) {
    checks.push(result('artifact-index', 'warn', 'artifacts.json 结构无效或无法解析', '保留损坏索引作为证据；重新启动 Iris 后会从 outputs/ 重建最小作品索引。'));
  } else if (library.exists) {
    let invalid = 0;
    for (const item of library.value.artifacts) {
      if (!plain(item) || !String(item.id || '').startsWith('a_') || !String(item.token || '').match(/^[a-f0-9]{32}$/)
          || !String(item.file || '') || path.basename(String(item.file)) !== String(item.file)) {
        invalid++;
        continue;
      }
      const safe = String(item.file);
      referenced.add(safe);
      try {
        const stat = fs.lstatSync(path.join(outputs, safe));
        if (!stat.isFile() || stat.isSymbolicLink()) missing++;
      } catch (_) { missing++; }
    }
    checks.push(invalid
      ? result('artifact-index', 'warn', `${invalid} 个作品索引条目无效`, '在工作台运行“找回本地作品”重建最小索引。')
      : result('artifact-index', 'ok', `${library.value.artifacts.length} 个作品索引条目结构有效`));
  }

  let orphan = 0;
  if (fs.existsSync(outputs)) {
    for (const name of fs.readdirSync(outputs)) {
      const target = path.join(outputs, name);
      try { if (fs.lstatSync(target).isFile() && !referenced.has(name)) orphan++; } catch (_) {}
    }
  }
  if (missing) checks.push(result('artifacts', 'warn', `${missing} 个任务或作品索引引用的文件不可访问；另有 ${orphan} 个孤儿文件`, '在工作台检查任务详情并运行“找回本地作品”。'));
  else if (orphan) checks.push(result('artifacts', 'warn', `${orphan} 个输出文件既没有任务引用也未进入作品库`, '先运行“找回本地作品”；仍无法入库的文件再作为孤儿处理。'));
  else checks.push(result('artifacts', 'ok', `${referenced.size} 个任务/作品引用可核对，未发现孤儿文件`));

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


function summarizeChecks(checks) {
  const errors = checks.filter((item) => item.status === 'error').length;
  const warnings = checks.filter((item) => item.status === 'warn').length;
  return {
    summary: { ok: checks.length - errors - warnings, warnings, errors },
    exitCode: errors ? 2 : (warnings ? 1 : 0)
  };
}

function dshVersionSupported(value) {
  /* 已实测的宿主窗口：>=0.1.2-rc.1 <0.1.3-0，以及 0.1.5-rc.1。
     其他预览版没有宿主 canary 证据，不放行。 */
  const version = String(value || '').trim().replace(/\s+/g, '');
  if (/^0\.1\.5-rc\.1(?:\+.*)?$/.test(version)) return true;
  const match = version.match(/^0\.1\.2(?:-rc\.(\d+))?(?:\+.*)?$/);
  return Boolean(match && (match[1] === undefined || Number(match[1]) >= 1));
}

function names(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function missing(expected, actual) {
  const found = new Set(names(actual));
  return expected.filter((item) => !found.has(item));
}

function capabilityCheck(checks, snapshot, id, port, label, severity = 'warn') {
  const capability = snapshot.capabilities[port];
  if (capability && capability.status === 'available') {
    checks.push(result(id, 'ok', label + ' Host Port 可用'));
    return true;
  }
  const status = severity === 'error' ? 'error' : 'warn';
  const kind = capability?.status === 'incompatible' ? '接口不兼容' : '能力缺失';
  checks.push(result(id, status, label + '不可用（' + kind + '）' + (capability?.reason ? '：' + capability.reason : ''),
    capability?.status === 'incompatible'
      ? '核对当前 DSH 版本与 Iris 支持范围，必要时回退到已验证版本。'
      : '启用对应 DSH 服务；不需要该能力时可忽略此降级。'));
  return false;
}

/**
 * 运行中宿主诊断。只消费安全快照和注册账本，不调用任何端口，因此默认零网络、
 * 零计费，也不会打开 Browser、读取附件/会话或调用模型。
 */
export function hostDoctor(host, evidence = {}, options = {}) {
  const snapshot = hostCapabilitySnapshot(host);
  const packageVersion = String(options.packageVersion || evidence?.server?.version || readPackageVersion());
  const checks = [];

  checks.push(snapshot.contractVersion === HOST_CONTRACT_VERSION
    ? result('host-contract', 'ok', 'Host Adapter v' + snapshot.contractVersion + ' · ' + snapshot.host.id)
    : result('host-contract', 'error', 'Host Adapter 契约版本不兼容',
      '使用与当前 Iris 包匹配的 Host Adapter。'));

  if (snapshot.host.id === 'deepseek-harness') {
    if (snapshot.host.version === 'unknown') {
      checks.push(result('dsh-version', 'warn', '无法从当前进程识别 DSH 版本',
        '使用 dsh --version 核对；0.1.4 已验证 >=0.1.2-rc.1 <0.1.3-0 与 0.1.5-rc.1。'));
    } else if (dshVersionSupported(snapshot.host.version)) {
      checks.push(result('dsh-version', 'ok', 'DSH ' + snapshot.host.version + ' 位于已验证支持范围'));
    } else {
      checks.push(result('dsh-version', 'error', 'DSH ' + snapshot.host.version + ' 超出已验证支持范围',
        '使用 >=0.1.2-rc.1 <0.1.3-0 或 0.1.5-rc.1，或先运行新的隔离 canary 再扩大支持范围。'));
    }
  }

  const server = evidence && typeof evidence.server === 'object' ? evidence.server : {};
  if (server.loaded === true && server.pluginId === IRIS_PLUGIN_ID) {
    checks.push(result('plugin', 'ok', IRIS_PLUGIN_ID + ' 服务端已装载 · ' + packageVersion));
  } else {
    checks.push(result('plugin', 'error', '无法确认 Iris 服务端插件身份或装载事实',
      '检查 profile 中是否启用完整 scoped 包名 @mokuyoaxis/dsh-iris，并查看 DSH 启动日志。'));
  }

  const toolsAvailable = capabilityCheck(checks, snapshot, 'tools-port', 'tools', 'Agent 工具注册', 'error');
  const missingTools = missing(EXPECTED_IRIS_TOOLS, evidence.tools);
  checks.push(toolsAvailable && missingTools.length === 0
    ? result('tools', 'ok', EXPECTED_IRIS_TOOLS.length + ' 个 Iris 工具均已登记')
    : result('tools', 'error', '缺少 ' + missingTools.length + '/' + EXPECTED_IRIS_TOOLS.length + ' 个 Iris 工具'
      + (missingTools.length ? '：' + missingTools.join(', ') : ''),
    '检查单工具注册隔离日志；不要因一项失败重启或重复提交媒体任务。'));

  const routesAvailable = capabilityCheck(checks, snapshot, 'routes-port', 'routes', 'Web 路由注册', 'error');
  const missingRoutes = missing(EXPECTED_IRIS_ROUTES, evidence.routes);
  checks.push(routesAvailable && missingRoutes.length === 0
    ? result('routes', 'ok', EXPECTED_IRIS_ROUTES.length + ' 组 Iris 路由均已登记')
    : result('routes', 'error', '缺少 ' + missingRoutes.length + '/' + EXPECTED_IRIS_ROUTES.length + ' 组 Iris 路由'
      + (missingRoutes.length ? '：' + missingRoutes.join(', ') : ''),
    '检查 webServer/httpServer 与路由挂载日志。'));

  const skillsAvailable = capabilityCheck(checks, snapshot, 'skills-port', 'skills', 'Skill 注册');
  const missingSkills = missing(EXPECTED_IRIS_SKILLS, evidence.skills);
  checks.push(skillsAvailable && missingSkills.length === 0
    ? result('skills', 'ok', EXPECTED_IRIS_SKILLS.length + ' 项随包 Skill 均已登记')
    : result('skills', 'warn', '缺少 ' + missingSkills.length + '/' + EXPECTED_IRIS_SKILLS.length + ' 项随包 Skill'
      + (missingSkills.length ? '：' + missingSkills.join(', ') : ''),
    '工具仍可直接调用；检查 DSH Skill registry 和插件启动日志。'));

  capabilityCheck(checks, snapshot, 'browser', 'browser', 'HTML Browser');
  capabilityCheck(checks, snapshot, 'attachments', 'attachments', '附件读写');
  capabilityCheck(checks, snapshot, 'sessions', 'sessions', '会话查询');
  capabilityCheck(checks, snapshot, 'text-model', 'textModel', '宿主文本模型');
  capabilityCheck(checks, snapshot, 'vision-model', 'visionModel', '宿主视觉模型');

  const client = evidence && typeof evidence.client === 'object' ? evidence.client : null;
  if (!client || client.loaded !== true) {
    checks.push(result('client', 'warn', '尚未收到 Iris 浏览器客户端握手',
      '在同一 DSH 实例打开或刷新 Web 页面，再重新访问 /iris/api/doctor。'));
  } else if (client.pluginId !== IRIS_PLUGIN_ID
      || client.protocolVersion !== HOST_CLIENT_PROTOCOL_VERSION
      || client.version !== packageVersion) {
    checks.push(result('client', 'error',
      'Iris 服务端/客户端版本不一致：server ' + packageVersion + ' · client ' + String(client.version || 'unknown')
      + ' · protocol ' + String(client.protocolVersion),
    '重新打开 DSH 输出的认证 URL并强制刷新；若仍不一致，清理该 profile 的旧插件链接后重装。'));
  } else {
    const missingSeats = missing(EXPECTED_IRIS_CLIENT_SEATS, client.seats);
    checks.push(missingSeats.length
      ? result('client', 'error', '浏览器客户端缺少 ' + missingSeats.length + '/' + EXPECTED_IRIS_CLIENT_SEATS.length
        + ' 个 UI Slot：' + missingSeats.join(', '),
      '检查客户端模块表和 DSH Slot API；服务端任务不受影响。')
      : result('client', 'ok', '客户端 ' + client.version + ' 已装载，4 个 UI Slot 均已登记'));
  }

  checks.push(result('scope', 'ok', 'Host Doctor 只读取能力快照和 Iris 注册账本；未调用端口、Browser、模型或供应商'));

  const totals = summarizeChecks(checks);
  return {
    schemaVersion: 1,
    package: { name: IRIS_PLUGIN_ID, version: packageVersion },
    mode: 'host',
    environment: { node: process.versions.node, platform: process.platform, arch: process.arch },
    host: snapshot.host,
    capabilities: snapshot.capabilities,
    checks,
    ...totals
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
