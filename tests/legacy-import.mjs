import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-legacy-'));
process.env.DSH_HOME = path.join(dir, 'home');
delete process.env.IRIS_IMPORT_WORKBENCH_CONFIG;
const config = await import('../lib/config.js');
const { apply } = await import('../lib/index.js');
const ctx = { tools: { register: () => () => {} }, effect: (fn) => fn(), inject() {}, get() {} };
const source = path.join(dir, '旧配置 with spaces.json');
const target = path.join(process.env.DSH_HOME, 'iris', 'v1', 'providers.json');
const input = JSON.stringify({ providers: [{ id: 'old', apiKey: 'fixture-secret', baseUrl: 'https://dashscope.example/v1' }] });
fs.writeFileSync(source, input);
const read = fs.readFileSync;
const log = console.log;
const error = console.error;
const messages = [];
try {
  console.log = console.error = (...args) => messages.push(args.join(' '));
  let legacyReads = 0;
  fs.readFileSync = function (file, ...args) {
    if (String(file).replaceAll('\\', '/').endsWith('/projects/ai-paint/data/config.json')) {
      legacyReads++;
      return input;
    }
    return read.call(this, file, ...args);
  };
  await apply(ctx);
  assert.equal(legacyReads, 0, '默认启动不得探测旧项目');
  assert.equal(fs.existsSync(target), false, '默认启动不得导入凭据');
  fs.readFileSync = read;

  process.env.IRIS_IMPORT_WORKBENCH_CONFIG = 'relative.json';
  await apply(ctx);
  assert.equal(fs.existsSync(target), false);
  assert(messages.some((m) => m.includes('必须是绝对路径')));

  process.env.IRIS_IMPORT_WORKBENCH_CONFIG = source;
  await apply(ctx);
  assert.equal(config.allProviders().length, 1);
  assert.equal(config.allProviders()[0].apiKey, 'fixture-secret');
  assert.equal(fs.readFileSync(source, 'utf8'), input, '来源文件不变');
  const before = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(source, JSON.stringify({ providers: [{ apiKey: 'changed-source', baseUrl: 'https://other.example' }] }));
  await apply(ctx);
  assert.equal(fs.readFileSync(target, 'utf8'), before, '修改旧项目配置不得同步到 Iris');
  const sourceAfter = fs.readFileSync(source, 'utf8');
  config.upsert({ ...config.allProviders()[0], name: 'Iris 独立名称' });
  assert.equal(fs.readFileSync(source, 'utf8'), sourceAfter, '修改 Iris 配置不得回写来源');
  delete process.env.IRIS_IMPORT_WORKBENCH_CONFIG;
  await apply(ctx);
  assert.equal(config.allProviders()[0].name, 'Iris 独立名称');
  process.env.IRIS_IMPORT_WORKBENCH_CONFIG = source;

  for (const invalid of ['null', '{bad', '{"providers":[{"apiKey":12,"baseUrl":{}}]}']) {
    process.env.DSH_HOME = fs.mkdtempSync(path.join(dir, 'invalid-'));
    config.resetCache();
    fs.writeFileSync(source, invalid);
    await apply(ctx);
    assert.deepEqual(config.allProviders(), []);
  }
  assert(!messages.join('\n').includes('fixture-secret'), '日志不得输出密钥');
} finally {
  fs.readFileSync = read;
  console.log = log;
  console.error = error;
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('ALL OK —— 默认不探测旧配置、显式导入、路径校验、重复保护和错误隔离');
