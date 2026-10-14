import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createLintTrace, recordLintTrace, snapshotLintProcesses } from '../scripts/lint-trace.mjs';
import { runTestProcess } from '../scripts/test-process.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-lint-diagnostics');
const first = createLintTrace(root);
recordLintTrace(first, 'preserve-first-failure', { file: 'example.js' });
const original = fs.readFileSync(first);
const second = createLintTrace(root);
assert.notEqual(first, second);
assert.deepEqual(fs.readFileSync(first), original);
if (process.platform !== 'win32') {
  assert.equal(fs.statSync(first).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(first)).mode & 0o777, 0o700);
}

// An actual owned child verifies proc-tree selection without reading argv/env.
const probe = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
await once(probe, 'spawn');
try {
  const snapshot = snapshotLintProcesses(process.pid);
  if (process.platform === 'linux') {
    assert.equal(snapshot.supported, true);
    const child = snapshot.processes.find(item => item.pid === probe.pid);
    assert.ok(child, 'owned child must be in the proc snapshot');
    assert.equal(child.parentPid, process.pid);
    assert.ok(Number.isInteger(child.startTicks));
    assert.ok(!('args' in child) && !('env' in child));
  } else assert.equal(snapshot.supported, false);
} finally {
  const closed = once(probe, 'close');
  probe.kill('SIGKILL');
  await closed;
}

const helper = new URL('../scripts/lint-trace.mjs', import.meta.url).href;
const fixture = path.join(root, 'lint.mjs');
fs.writeFileSync(fixture, `
import { recordLintTrace } from ${JSON.stringify(helper)};
recordLintTrace(process.env.IRIS_LINT_TRACE_FILE, 'syntax-start', { file: 'controlled-stall.js', sequence: 1 });
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
`);
console.log('lint-diagnostics: 以下为预期的 3 秒超时 fixture，不是项目 lint 门禁');
const failed = await runTestProcess(fixture, { cwd: root, timeoutMs: 3000 });
assert.equal(failed.error?.code, 'ETIMEDOUT');
assert.equal(failed.signal, 'SIGKILL');
const failureBytes = fs.readFileSync(failed.traceFile);
const events = failureBytes.toString().trim().split('\n').map(line => JSON.parse(line));
assert.ok(events.some(item => item.event === 'syntax-start' && item.file === 'controlled-stall.js'));
const timeout = events.find(item => item.event === 'runner-timeout');
assert.equal(timeout.timeoutMs, 3000, 'fixture-only deadline; project runner remains 120 seconds');
if (process.platform === 'linux') assert.ok(timeout.processSnapshot.processes.some(item => item.pid === timeout.childPid));
assert.equal(events.at(-1).event, 'runner-close');
assert.equal(events.at(-1).errorCode, 'ETIMEDOUT');
assert.ok(!events.some(item => item.event === 'exit'), 'SIGKILL evidence must not depend on an exit handler');
console.log('LINT_TIMEOUT_FIXTURE ' + JSON.stringify(timeout));

// A later passing rerun gets a new log and preserves the first failure bytes.
fs.writeFileSync(fixture, `
import { recordLintTrace } from ${JSON.stringify(helper)};
recordLintTrace(process.env.IRIS_LINT_TRACE_FILE, 'complete', { files: 1 });
`);
const passed = await runTestProcess(fixture, { cwd: root, timeoutMs: 10000 });
assert.equal(passed.status, 0);
assert.equal(passed.signal, null);
assert.equal(passed.error, undefined);
assert.notEqual(failed.traceFile, passed.traceFile);
assert.deepEqual(fs.readFileSync(failed.traceFile), failureBytes);
assert.equal(JSON.parse(fs.readFileSync(passed.traceFile, 'utf8').trim().split('\n').at(-1)).status, 0);
console.log('PASS lint 现场：私有独立日志、进程树、同步阻塞强杀前记录、成功复查不覆盖首次失败');
