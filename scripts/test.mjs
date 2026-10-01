import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runTestProcess } from './test-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.mjs')).sort();
const testTimeoutMs = 120000;
console.log(`Test runtime: Node ${process.versions.node}`);
if (!tests.length) {
  console.error('未找到测试文件');
  process.exit(1);
}
for (const name of tests) {
  console.log(`\n▶ ${name}`);
  const result = await runTestProcess(path.join(root, 'tests', name), {
    cwd: root, timeoutMs: testTimeoutMs
  });
  if (result.error || result.signal || result.status !== 0) {
    const detail = `测试失败：${name}` + (result.error?.code === 'ETIMEDOUT'
      ? ` (超过 ${testTimeoutMs / 1000} 秒)`
      : result.error ? ` (${result.error.message})` : result.signal ? ` (${result.signal})` : '');
    console.error(detail);
    if (process.env.GITHUB_ACTIONS) {
      const annotation = detail.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
      console.error(`::error file=tests/${name}::${annotation}`);
    }
    process.exit(result.status || 1);
  }
}
console.log(`全部 ${tests.length} 个测试文件通过`);
