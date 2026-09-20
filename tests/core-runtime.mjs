import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCoreRuntime } from '../lib/core-runtime.js';

const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('writer child READY timeout: ' + stderr));
    }, 8000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => {
      if (!stdout.includes('READY')) {
        clearTimeout(timer);
        reject(new Error(`writer child exited ${code}: ${stderr}`));
      }
    });
  });
}

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

function childWriter(root) {
  return spawn(process.execPath, [fileURLToPath(new URL('./fixtures/core-writer-child.mjs', import.meta.url)), root], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-core-runtime-'));
const children = new Set();
const trackedWriter = (root) => {
  const child = childWriter(root);
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
};
try {
  const missing = path.join(base, 'missing-reader-root');
  const missingReader = createCoreRuntime({ dataRoot: missing, mode: 'reader' });
  let missingError;
  try { missingReader.start(); } catch (error) { missingError = error; }
  assert(missingError?.code === 'IRIS_CORE_DATA_ROOT_NOT_FOUND' && !fs.existsSync(missing),
    'reader 不得创建缺失的数据根', missingError?.code);
  await missingReader.dispose();

  const root = path.join(base, 'shared-root');
  const owner = trackedWriter(root);
  await waitForReady(owner);
  const lock = path.join(root, '.iris-runtime-writer-v0');
  assert(fs.existsSync(path.join(lock, 'owner.json')), 'writer 必须在操作前持有带 owner 证据的租约');

  const beforeReader = fs.readdirSync(root).sort().join(',');
  const reader = createCoreRuntime({ dataRoot: root, mode: 'reader' });
  reader.start();
  const readResult = await reader.run('inspect', ({ dataRoot, signal }) => ({ dataRoot, aborted: signal.aborted }));
  assert(path.isAbsolute(readResult.dataRoot) && readResult.aborted === false, 'reader 应获得物理根与实例信号');
  let readOnlyError;
  try { await reader.run('execute', () => null); } catch (error) { readOnlyError = error; }
  assert(readOnlyError?.code === 'IRIS_CORE_READ_ONLY', 'reader 必须在回调执行前拒绝写操作');
  await reader.dispose();
  assert(fs.readdirSync(root).sort().join(',') === beforeReader, 'reader 生命周期不得写入数据根');

  const contender = createCoreRuntime({ dataRoot: root, mode: 'writer' });
  let busyError;
  try { contender.start(); } catch (error) { busyError = error; }
  assert(busyError?.code === 'IRIS_CORE_DATA_ROOT_BUSY' && !busyError.message.includes(root),
    '第二写者必须 fail-fast 且不泄露绝对路径', busyError?.message);
  await contender.dispose();

  const alias = path.join(base, 'shared-root-alias');
  let aliasSupported = true;
  try { fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) aliasSupported = false;
    else throw error;
  }
  if (aliasSupported) {
    const aliasWriter = createCoreRuntime({ dataRoot: alias, mode: 'writer' });
    let aliasBusy;
    try { aliasWriter.start(); } catch (error) { aliasBusy = error; }
    assert(aliasBusy?.code === 'IRIS_CORE_DATA_ROOT_BUSY', '软链接/结点别名不得取得第二份写租约');
    await aliasWriter.dispose();
  }

  const ownerExit = waitForExit(owner);
  owner.stdin.write('STOP\n');
  const normal = await ownerExit;
  assert(normal.code === 0 && !fs.existsSync(lock), '正常 dispose 必须释放写者租约', normal);
  const successor = createCoreRuntime({ dataRoot: root, mode: 'writer' });
  successor.start();
  await successor.dispose();
  assert(!fs.existsSync(lock), '正常释放后新的 writer 必须能够接管并再次释放');

  const lifecycleRoot = path.join(base, 'lifecycle-root');
  const runtime = createCoreRuntime({ dataRoot: lifecycleRoot, mode: 'writer' });
  runtime.start();
  let cleanupSawLease = false;
  runtime.onDispose(() => { cleanupSawLease = fs.existsSync(path.join(lifecycleRoot, '.iris-runtime-writer-v0')); });
  const operation = runtime.run('execute', ({ signal }) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  }));
  const disposing = runtime.dispose();
  assert(runtime.snapshot().state === 'disposing' && runtime.signal.aborted, 'dispose 必须先停止新操作并传播取消');
  assert(await operation === 'aborted', '在途操作必须收到实例取消信号');
  const disposed = await disposing;
  assert(disposed.state === 'disposed' && cleanupSawLease && !fs.existsSync(path.join(lifecycleRoot, '.iris-runtime-writer-v0')),
    'cleanup 必须在租约释放前运行，最终状态必须为 disposed', disposed);
  assert(runtime.dispose() === disposing, 'dispose 必须返回同一个释放过程');

  const tamperRoot = path.join(base, 'tamper-root');
  const tampered = createCoreRuntime({ dataRoot: tamperRoot, mode: 'writer' });
  tampered.start();
  const tamperLock = path.join(tamperRoot, '.iris-runtime-writer-v0');
  const tamperOwner = path.join(tamperLock, 'owner.json');
  fs.writeFileSync(tamperOwner, JSON.stringify({ instanceId: 'another-owner' }));
  let tamperError;
  try { await tampered.dispose(); } catch (error) { tamperError = error; }
  assert(tamperError?.code === 'IRIS_CORE_LEASE_INVALID'
    && tampered.snapshot().state === 'disposing'
    && fs.existsSync(tamperLock),
  '所有者证据异常时不得释放租约或伪装 disposed', tamperError?.code);

  const crashRoot = path.join(base, 'crash-root');
  const crashed = trackedWriter(crashRoot);
  await waitForReady(crashed);
  const crashExit = waitForExit(crashed);
  crashed.kill('SIGKILL');
  await crashExit;
  const afterCrash = createCoreRuntime({ dataRoot: crashRoot, mode: 'writer' });
  let crashBusy;
  try { afterCrash.start(); } catch (error) { crashBusy = error; }
  assert(crashBusy?.code === 'IRIS_CORE_DATA_ROOT_BUSY', '异常退出后的租约不得被自动夺取');
  await afterCrash.dispose();

  console.log('ALL OK —— Core Runtime 多进程单写者、reader 零写入、路径别名、取消释放与崩溃保守边界通过');
} finally {
  for (const child of children) child.kill('SIGKILL');
  fs.rmSync(base, { recursive: true, force: true });
}
