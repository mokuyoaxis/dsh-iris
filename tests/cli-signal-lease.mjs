// RECONSTRUCTED 2026-09-23 from the T-17 signal/lease contract.
// The original test and hanging Provider fixture bytes were not recovered.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/hanging-image-server.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../bin/dsh-iris.js', import.meta.url));

function firstLine(stream, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let value = '';
    const timer = setTimeout(() => reject(new Error('Provider fixture startup timed out')), timeoutMs);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      value += chunk;
      const end = value.indexOf('\n');
      if (end >= 0) {
        clearTimeout(timer);
        resolve(value.slice(0, end));
      }
    });
    stream.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function waitUntil(predicate, timeoutMs, context) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(context + ' timed out');
}

function exited(child, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error('CLI did not exit after signal')), timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

if (process.platform === 'win32') {
  console.log('CLI signal lease test skipped on Windows (POSIX SIGINT/SIGTERM required)');
} else {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-cli-signal-'));
  const children = new Set();
  async function exercise(signal, label, twice = false) {
    const dataRoot = path.join(base, label, 'core');
    const requestFile = path.join(base, label, 'request.json');
    const closedFile = path.join(base, label, 'closed.txt');
    const configFile = path.join(base, label, 'providers.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const server = spawn(process.execPath, [fixture, requestFile, closedFile], {
      cwd: repo, stdio: ['ignore', 'pipe', 'pipe']
    });
    children.add(server);
    const port = Number(await firstLine(server.stdout));
    assert.ok(Number.isInteger(port) && port > 0, '本地挂起 Provider 必须启动');
    fs.writeFileSync(configFile, JSON.stringify({
      version: 1,
      providers: [{
        id: 'local', name: 'local', enabled: true, type: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`, mediaProtocol: 'openai-images',
        apiKey: 'fixture-secret',
        models: [{ id: 'fixture-image', capabilities: ['image-gen'] }]
      }],
      assignments: { 'image-gen': ['local::fixture-image'] }
    }), { mode: 0o600 });
    const child = spawn(process.execPath, [
      cli, 'run', 'image', '--data-root', dataRoot,
      '--provider-config', configFile,
      '--input', JSON.stringify({ prompt: 'hang until signaled' })
    ], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
    children.add(child);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const lock = path.join(dataRoot, '.iris-runtime-writer-v0');
    try {
      await waitUntil(() => fs.existsSync(path.join(lock, 'owner.json')) && fs.existsSync(requestFile),
        8000, `${label} did not acquire a lease and submit to the fixture: ${stderr}`);
      const exitPromise = exited(child);
      assert.equal(child.kill(signal), true, `CLI 必须接收 ${signal}`);
      if (twice) child.kill(signal);
      const result = await exitPromise;
      assert.ok(result.code === (signal === 'SIGINT' ? 130 : 143) || result.signal === signal,
        `${signal} 必须有界退出：${stderr}`);
      if (!twice) {
        assert.equal(fs.existsSync(lock), false, `${signal} 必须释放 writer 租约`);
        await waitUntil(() => fs.existsSync(closedFile), 3000,
          `${signal} 未中止在途 Provider 请求`);
        const successor = spawnSync(process.execPath, [
          cli, 'artifact', 'rebuild', '--data-root', dataRoot
        ], { cwd: repo, encoding: 'utf8', timeout: 8000, env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
        assert.equal(successor.status, 0, `${signal} 后新 writer 必须能取得同一数据根：${successor.stderr}`);
      }
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      if (server.exitCode === null) server.kill('SIGTERM');
    }
  }

  try {
    await exercise('SIGINT', 'interrupt');
    await exercise('SIGTERM', 'terminate');
    await exercise('SIGINT', 'double-interrupt', true);
    console.log('CLI SIGINT/SIGTERM release the writer lease, abort fetch, and exit on repeated signal');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(base, { recursive: true, force: true });
  }
}
