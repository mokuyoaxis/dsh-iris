/** Explicit installation of the bundled Core skill or a rendered connection snapshot. No host/model I/O. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectionSkillResources } from './connection-skill.js';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SKILL = 'iris-core';
const RECEIPT = '.iris-install.json';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const error = (code, message) => Object.assign(new Error(message), { code });
const isWithin = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
}

// Resolve existing ancestors without creating them, including for dry-run/status.
function physicalPath(file) {
  const entry = stat(file);
  if (entry) return fs.realpathSync(file);
  return path.join(physicalPath(path.dirname(file)), path.basename(file));
}

function readTree(root, { installed = false, expected } = {}) {
  const files = Object.create(null), bytes = Object.create(null), directories = [];
  const walk = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (installed && !prefix && name === RECEIPT) continue;
      const relative = prefix + name, file = path.join(directory, name), entry = fs.lstatSync(file);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw error('IRIS_SKILL_UNSAFE_PATH', 'Skill 中存在软链或特殊文件：' + relative);
      }
      if (entry.isDirectory()) {
        directories.push(relative); walk(file, relative + '/');
      } else {
        // Added/size-changed user files need not be read to establish a conflict.
        const content = !expected || expected[relative]?.size === entry.size ? fs.readFileSync(file) : null;
        files[relative] = { size: entry.size, sha256: content ? digest(content) : null };
        if (!installed) bytes[relative] = content;
      }
    }
  };
  walk(root);
  return { files, bytes, directories: directories.sort() };
}

function sameTree(tree, recorded) {
  const names = Object.keys(tree.files).sort(), other = Object.keys(recorded.files).sort();
  return JSON.stringify(names) === JSON.stringify(other)
    && names.every(name => tree.files[name].size === recorded.files[name].size
      && tree.files[name].sha256 === recorded.files[name].sha256)
    && JSON.stringify(tree.directories) === JSON.stringify([...recorded.directories].sort());
}

function validReceipt(value, packageName, skillName) {
  const relative = name => typeof name === 'string' && name.length > 0 && !name.includes('\\')
    && !name.includes('\0') && !name.split('/').some(part => !part || part === '.' || part === '..');
  return value?.schemaVersion === 1 && value.packageName === packageName && value.skillName === skillName
    && typeof value.packageVersion === 'string' && value.packageVersion.length > 0
    && value.files && !Array.isArray(value.files) && typeof value.files === 'object'
    && Object.hasOwn(value.files, 'SKILL.md') && !Object.hasOwn(value.files, RECEIPT)
    && Object.entries(value.files).every(([name, item]) => relative(name)
      && Number.isSafeInteger(item?.size) && item.size >= 0 && /^[a-f0-9]{64}$/.test(item.sha256))
    && Array.isArray(value.directories) && value.directories.every(relative);
}

function packageResources(packageRoot) {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const source = fs.realpathSync(path.join(packageRoot, 'skills', SKILL));
  const tree = readTree(source);
  if (!tree.files['SKILL.md'] || tree.files[RECEIPT]) {
    throw error('IRIS_SKILL_PACKAGE_INVALID', '包内缺少 Skill 入口，或含有不应发布的安装记录');
  }
  return { skillName: SKILL, source, metadata, ...tree };
}

function bundleResources(file, packageRoot) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw error('IRIS_SKILL_OPTIONS_INVALID', '--bundle 必须是绝对路径');
  const entry = fs.lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 16384) throw error('IRIS_SKILL_BUNDLE_INVALID', 'Skill 交付文件必须是最多 16 KiB 的普通 JSON 文件');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (cause) { if (!(cause instanceof SyntaxError)) throw cause; throw error('IRIS_SKILL_BUNDLE_INVALID', 'Skill 交付文件不是有效 JSON'); }
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  return { ...connectionSkillResources(value, metadata), source: fs.realpathSync(file) };
}

function inspect(destination, resources) {
  const entry = stat(destination);
  if (!entry) return { status: 'not_installed' };
  if (entry.isSymbolicLink() || !entry.isDirectory()) return { status: 'unmanaged', reason: 'not_a_plain_directory' };
  const receiptFile = path.join(destination, RECEIPT), receiptStat = stat(receiptFile);
  if (!receiptStat?.isFile() || receiptStat.isSymbolicLink()) return { status: 'unmanaged', reason: 'no_valid_receipt' };
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')); }
  catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    return { status: 'unmanaged', reason: 'invalid_receipt' };
  }
  if (!validReceipt(receipt, resources.metadata.name, resources.skillName)) return { status: 'unmanaged', reason: 'invalid_receipt' };
  const base = { installedVersion: receipt.packageVersion };
  let tree;
  try { tree = readTree(destination, { installed: true, expected: receipt.files }); }
  catch (cause) {
    if (cause.code !== 'IRIS_SKILL_UNSAFE_PATH') throw cause;
    return { ...base, status: 'modified', reason: 'unsafe_entry' };
  }
  if (!sameTree(tree, receipt)) return { ...base, status: 'modified', reason: 'local_changes' };
  return { ...base, status: receipt.packageVersion === resources.metadata.version && sameTree(tree, resources)
    ? 'current' : 'update_available' };
}

function resolveDirectory({ target, directory, env, home }) {
  if (target !== undefined && target !== 'kimi') throw error('IRIS_SKILL_OPTIONS_INVALID', '当前仅支持 --target kimi；其他宿主请用 --directory');
  if (directory === undefined) {
    if (target !== 'kimi') throw error('IRIS_SKILL_OPTIONS_INVALID', '请明确指定 --target kimi 或 --directory');
    const kimiHome = env.KIMI_CODE_HOME || path.join(home, '.kimi-code');
    if (!path.isAbsolute(kimiHome)) throw error('IRIS_SKILL_OPTIONS_INVALID', 'KIMI_CODE_HOME 必须是绝对路径');
    directory = path.join(kimiHome, 'skills');
  }
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw error('IRIS_SKILL_OPTIONS_INVALID', 'directory 必须是绝对路径');
  return physicalPath(path.resolve(directory));
}

function ensureDirectory(directory) {
  const entry = stat(directory);
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw error('IRIS_SKILL_UNSAFE_PATH', '控制目录必须是普通目录：' + directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function archive(destination, control, action) {
  const transaction = fs.mkdtempSync(path.join(control, 'backup-'));
  const backupPath = path.join(transaction, path.basename(destination));
  fs.writeFileSync(path.join(transaction, 'move.json'), JSON.stringify({ schemaVersion: 1, action,
    at: new Date().toISOString(), origin: destination, backupPath }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(destination, backupPath);
  return backupPath;
}

function copyResources(destination, resources) {
  fs.mkdirSync(destination, { mode: 0o700 }); // Exclusive claim; never replace even an empty user directory.
  for (const relative of resources.directories) fs.mkdirSync(path.join(destination, relative), { recursive: true, mode: 0o700 });
  for (const [relative, bytes] of Object.entries(resources.bytes)) fs.writeFileSync(path.join(destination, relative), bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(destination, RECEIPT), JSON.stringify({ schemaVersion: 1,
    packageName: resources.metadata.name, packageVersion: resources.metadata.version, skillName: resources.skillName,
    installedAt: new Date().toISOString(), files: resources.files, directories: resources.directories
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

/** Internal CLI service. Explicit mutations only; no postinstall or public SDK export. */
export function manageCoreSkill({ action, target, directory, bundle, dryRun = false }, {
  packageRoot = PACKAGE_ROOT, env = process.env, home = os.homedir()
} = {}) {
  if (!['install', 'status', 'uninstall'].includes(action) || action === 'status' && dryRun) {
    throw error('IRIS_SKILL_OPTIONS_INVALID', '使用 skills install/status/uninstall；status 不接受 --dry-run');
  }
  const resources = bundle === undefined ? packageResources(packageRoot) : bundleResources(bundle, packageRoot);
  const resolved = resolveDirectory({ target, directory, env, home }), destination = path.join(resolved, resources.skillName);
  if (isWithin(resources.source, destination) || isWithin(destination, resources.source)) {
    throw error('IRIS_SKILL_OPTIONS_INVALID', '安装目标不能与包内 Skill 源目录重叠');
  }
  const base = { skill: resources.skillName, target: target || 'directory', directory: resolved, destination,
    packageVersion: resources.metadata.version, discovery: 'not_checked' };
  const before = inspect(destination, resources);
  const result = { ...base, ...before };
  if (action === 'status') return result;
  const conflict = () => error('IRIS_SKILL_CONFLICT', '保留现有 Skill；目标没有有效归属记录、包含本地修改或软链。请先检查：' + destination);
  if (['modified', 'unmanaged'].includes(before.status)) throw conflict();
  if (action === 'install' && before.status === 'current'
      || action === 'uninstall' && before.status === 'not_installed') return { ...result, action: 'unchanged', dryRun };
  const operation = action === 'uninstall' ? 'uninstall' : before.status === 'not_installed' ? 'install' : 'update';
  if (dryRun) return { ...result, action: operation, dryRun: true };
  const controls = path.join(path.dirname(resolved), '.iris-skill-installs');
  const control = path.join(controls, digest(resolved).slice(0, 16));
  if (isWithin(resolved, control)) throw error('IRIS_SKILL_OPTIONS_INVALID', '安装目录必须允许在扫描目录之外保存备份');
  ensureDirectory(controls); ensureDirectory(control);
  const lock = path.join(control, 'lock.json');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
    throw error('IRIS_SKILL_BUSY', '已有安装操作或未核实的锁，保留现场：' + lock);
  }
  let backupPath;
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, destination }) + '\n');
    const current = inspect(destination, resources);
    if (current.status !== before.status || current.installedVersion !== before.installedVersion) {
      throw error('IRIS_SKILL_CONFLICT', '安装状态已变化，请重新检查：' + destination);
    }
    ensureDirectory(resolved);
    if (before.status !== 'not_installed') backupPath = archive(destination, control, operation);
    if (action === 'uninstall') return { ...base, status: 'not_installed', action: 'uninstalled', backupPath };
    copyResources(destination, resources);
    return { ...base, status: 'current', installedVersion: resources.metadata.version,
      action: operation === 'update' ? 'updated' : 'installed', ...(backupPath ? { backupPath } : {}) };
  } catch (cause) {
    if (backupPath) cause.message += '\n原版保存在：' + backupPath;
    throw cause;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock); // Only this invocation's exclusively created coordination file.
  }
}
