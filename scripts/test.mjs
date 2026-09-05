import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.mjs')).sort();
if (!tests.length) {
  console.error('未找到测试文件');
  process.exit(1);
}
for (const name of tests) {
  const result = spawnSync(process.execPath, [path.join(root, 'tests', name)], {
    cwd: root, stdio: 'inherit', shell: false,
    // 测试装载插件时不能继承用户真实的凭据导入请求。
    env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '' }
  });
  if (result.error || result.signal || result.status !== 0) {
    console.error(`测试失败：${name}` + (result.error ? ` (${result.error.message})` : ''));
    process.exit(result.status || 1);
  }
}
console.log(`全部 ${tests.length} 个测试文件通过`);
