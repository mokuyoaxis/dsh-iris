'use strict';
/**
 * Iris 私有存储原语。
 *
 * POSIX 上目录统一 0700、文件统一 0600；Windows 的 mode 不能替代 ACL，
 * 仍在创建时传入最小 mode，但公开文档不会把它描述成 Windows 访问控制。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HAS_POSIX_MODE = process.platform !== 'win32';

function tryChmod(target, mode) {
  if (!HAS_POSIX_MODE) return;
  try { fs.chmodSync(target, mode); } catch (_) { /* 调用方仍可继续使用宿主文件系统 */ }
}

export function ensurePrivateDir(dir) {
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // 不擅自 chmod 调用方传入的既有父目录（例如适配器单测使用 os.tmpdir）。
  // Iris 自有既有树由启动时 hardenPrivateTree() 明确收紧。
  if (!existed) tryChmod(dir, 0o700);
  return dir;
}

export function chmodPrivateFile(file) {
  tryChmod(file, 0o600);
}

export function writePrivateFile(file, data, options = {}) {
  ensurePrivateDir(path.dirname(file));
  fs.writeFileSync(file, data, { ...options, mode: 0o600 });
  chmodPrivateFile(file);
}

export function privateSibling(file, label = 'tmp') {
  return `${file}.${label}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

export function atomicWritePrivate(file, data) {
  ensurePrivateDir(path.dirname(file));
  const tmp = privateSibling(file);
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    chmodPrivateFile(file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* rename 成功后临时文件已不存在 */ }
  }
}

/** 收紧既有 Iris 树；不跟随符号链接，也不修改文件内容。 */
export function hardenPrivateTree(root) {
  ensurePrivateDir(root);
  if (!HAS_POSIX_MODE) return { directories: 0, files: 0, skipped: true };
  let directories = 0;
  let files = 0;
  const walk = (target) => {
    let st;
    try { st = fs.lstatSync(target); } catch (_) { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      tryChmod(target, 0o700);
      directories++;
      for (const name of fs.readdirSync(target)) walk(path.join(target, name));
      return;
    }
    if (st.isFile()) {
      tryChmod(target, 0o600);
      files++;
    }
  };
  walk(root);
  return { directories, files, skipped: false };
}
