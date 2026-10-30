import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeLocalApiTokenFile } from './local-api.js';

const invalid = message => { throw Object.assign(new Error(message), { code: 'IRIS_API_TOKEN_DIRECTORY_INVALID' }); };

/** The explicitly chosen directory may be new; its parent must exist. No chmod or cleanup. */
export function checkLocalApiTokenDirectory(directory, dataRoot) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) invalid('token-dir 必须是根外私有目录的绝对路径');
  const supplied = path.resolve(directory);
  let info;
  try { info = fs.lstatSync(supplied); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info && (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && info.mode & 0o077)) {
    invalid('token-dir 必须是私有真实目录（POSIX 0700）；不会修改已有目录权限');
  }
  const resolved = info ? fs.realpathSync(supplied) : path.join(fs.realpathSync(path.dirname(supplied)), path.basename(supplied));
  const physical = info ? fs.realpathSync.native(supplied) : path.join(fs.realpathSync.native(path.dirname(supplied)), path.basename(supplied));
  const relative = path.relative(fs.realpathSync.native(dataRoot), physical);
  if (!relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) invalid('token-dir 必须位于 Core 数据根之外');
  return resolved;
}

export function writeLocalApiTokenDirectory(directory, token, dataRoot) {
  const target = checkLocalApiTokenDirectory(directory, dataRoot);
  if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
  const file = path.join(target, 'session-' + crypto.randomUUID() + '.token');
  writeLocalApiTokenFile(file, token, dataRoot);
  return file;
}
