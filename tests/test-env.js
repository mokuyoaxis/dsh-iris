import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 为单个测试创建跨平台、退出时自动清理的隔离 DSH_HOME。 */
export function useTempDshHome(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  process.env.DSH_HOME = root;
  const cleanup = () => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  };
  process.once('exit', cleanup);
  return { root, cleanup };
}
