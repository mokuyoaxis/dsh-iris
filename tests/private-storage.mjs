import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWritePrivate, hardenPrivateTree, writePrivateFile } from '../lib/private-storage.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-private-storage-'));
const root = path.join(base, 'iris', 'v1');
const outside = path.join(base, 'outside.txt');
try {
  atomicWritePrivate(path.join(root, 'providers.json'), '{"version":1}');
  writePrivateFile(path.join(root, 'outputs', 'image.bin'), Buffer.from('private'));
  fs.writeFileSync(outside, 'outside', { mode: 0o644 });
  const link = path.join(root, 'outside-link');
  try { fs.symlinkSync(outside, link); } catch (_) { /* 某些 Windows 环境无创建符号链接权限 */ }

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, 'providers.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, 'outputs', 'image.bin')).mode & 0o777, 0o600);

    fs.chmodSync(root, 0o755);
    fs.chmodSync(path.join(root, 'outputs', 'image.bin'), 0o644);
    hardenPrivateTree(root);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700, '既有 Iris 目录收紧为 0700');
    assert.equal(fs.statSync(path.join(root, 'outputs', 'image.bin')).mode & 0o777, 0o600, '既有 Iris 文件收紧为 0600');
    assert.equal(fs.statSync(outside).mode & 0o777, 0o644, '不跟随符号链接修改树外文件');
  }

  assert.equal(fs.readdirSync(root).some((name) => name.includes('.tmp-')), false, '原子写入不留临时文件');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

console.log('ALL OK —— 私有目录/文件权限、原子写入与符号链接边界通过');
