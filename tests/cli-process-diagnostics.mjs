import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { assertCliProcess } from './cli-process.js';

const secret = 'fixture-cli-secret-' + randomUUID();
const messages = [], originalError = console.error;
const run = (source, options = {}) => {
  const started = performance.now();
  const timeoutMs = options.timeout ?? 30000;
  const result = spawnSync(process.execPath, ['-e', source, secret], { encoding: 'utf8', timeout: timeoutMs,
    env: { ...process.env, IRIS_DIAGNOSTIC_SECRET: secret }, ...options });
  return { result, timeoutMs, elapsedMs: performance.now() - started };
};
const check = (sample, expectedStatus = 0) => assertCliProcess(sample.result, {
  testFile: 'tests/cli-process-diagnostics.mjs', stage: 'config check',
  timeoutMs: sample.timeoutMs, elapsedMs: sample.elapsedMs, expectedStatus
});
const fail = (sample, expectedStatus = 0) => {
  const before = messages.length;
  assert.throws(() => check(sample, expectedStatus), error => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert(!error.message.includes(secret));
    assert.match(error.message, /config check/);
    return true;
  });
  assert.equal(messages.length, before + 1);
  const message = messages.at(-1);
  assert(message.startsWith('CLI_PROCESS_FAILURE '));
  assert(!message.includes(secret));
  const context = JSON.parse(message.slice('CLI_PROCESS_FAILURE '.length));
  assert.deepEqual(Object.keys(context).sort(), ['testFile', 'stage', 'childPid', 'timeoutMs', 'elapsedMs',
    'expectedStatus', 'status', 'signal', 'errorCode', 'errno', 'failureType'].sort());
  assert.equal(context.testFile, 'tests/cli-process-diagnostics.mjs');
  assert.equal(context.stage, 'config check');
  assert.equal(context.childPid, sample.result.pid || null);
  assert.equal(context.timeoutMs, sample.timeoutMs);
  assert.equal(context.elapsedMs, Math.round(sample.elapsedMs));
  assert.equal(context.expectedStatus, expectedStatus);
  assert(context.elapsedMs >= 0);
  return context;
};

try {
  console.error = (...items) => messages.push(items.join(' '));
  const normal = run('process.stdout.write(JSON.stringify({ok:true}));');
  assert.equal(check(normal), normal.result);
  assert.deepEqual(JSON.parse(normal.result.stdout), { ok: true });
  const denied = run('process.exitCode=1;');
  assert.equal(check(denied, 1), denied.result);
  assert.equal(messages.length, 0, 'success and expected business refusal are silent');

  const business = run('process.stdout.write(process.argv[1]); process.stderr.write(process.env.IRIS_DIAGNOSTIC_SECRET); process.exitCode=7;');
  assert.equal(business.result.stdout, secret); assert.equal(business.result.stderr, secret);
  const businessContext = fail(business);
  assert.equal(businessContext.failureType, 'exit_status'); assert.equal(businessContext.status, 7);
  assert.equal(businessContext.errorCode, null); assert.equal(businessContext.signal, null);

  const started = performance.now();
  const missing = { result: spawnSync(path.join(os.tmpdir(), 'iris-missing-' + randomUUID()), [secret],
    { encoding: 'utf8', timeout: 30000 }), timeoutMs: 30000, elapsedMs: performance.now() - started };
  assert.equal(missing.result.error.code, 'ENOENT');
  assert(missing.result.error.spawnargs.includes(secret));
  const missingContext = fail(missing);
  assert.equal(missingContext.failureType, 'process_error'); assert.equal(missingContext.errorCode, 'ENOENT');
  assert.equal(missingContext.errno, missing.result.error.errno); assert.equal(missingContext.childPid, null);

  const overflow = run('process.stdout.write(process.argv[1].repeat(4096));', { maxBuffer: 64 });
  assert.equal(overflow.result.error.code, 'ENOBUFS');
  assert.equal(fail(overflow).errorCode, 'ENOBUFS');

  if (process.platform !== 'win32') {
    const trap = 'process.on("SIGTERM",()=>process.exit(143)); process.stdout.write("ready\\n"); setInterval(()=>{},1000);';
    const timedOut = run(trap, { timeout: 2000 });
    assert.match(timedOut.result.stdout, /ready/);
    assert.equal(timedOut.result.status, 143); assert.equal(timedOut.result.signal, null);
    assert.equal(timedOut.result.error.code, 'ETIMEDOUT');
    const timeoutContext = fail(timedOut, 143);
    assert.equal(timeoutContext.failureType, 'process_error'); assert.equal(timeoutContext.errorCode, 'ETIMEDOUT');
    assert.equal(timeoutContext.status, 143); assert.equal(timeoutContext.signal, null);
    assert(timeoutContext.elapsedMs >= 2000, 'a matching exit status must not conceal a process timeout');

    // This sender is a child of the waiting fixture and only signals its own parent.
    const sender = 'require("node:child_process").spawn(process.execPath,["-e",'
      + '"const target=Number(process.argv[1]); if(target<=1||process.ppid!==target)process.exit(2); process.kill(target, \'SIGTERM\');",'
      + 'String(process.pid)],{stdio:"ignore"});';
    const terminated = run(trap + sender);
    assert.match(terminated.result.stdout, /ready/);
    assert.equal(terminated.result.status, 143); assert.equal(terminated.result.signal, null);
    assert.equal(terminated.result.error, undefined);
    const terminatedContext = fail(terminated);
    assert.equal(terminatedContext.failureType, 'exit_status'); assert.equal(terminatedContext.errorCode, null);
    assert.equal(terminatedContext.status, 143); assert.equal(terminatedContext.signal, null);
    assert.equal(check(terminated, 143), terminated.result, 'a deliberate exit 143 without process error is distinct');

    const signalled = run('setInterval(()=>{},1000);' + sender);
    assert.equal(signalled.result.signal, 'SIGTERM'); assert.equal(signalled.result.status, null);
    const signalContext = fail(signalled);
    assert.equal(signalContext.failureType, 'signal'); assert.equal(signalContext.signal, 'SIGTERM');
    assert.equal(signalContext.errorCode, null);
  } else {
    console.log('SKIP POSIX SIGTERM/143 controls on Windows; shared exit/error/privacy checks remain active');
  }
} finally { console.error = originalError; }
console.log('PASS CLI diagnostics: success/refusal, safe process context, ENOENT/ENOBUFS and distinct timeout/termination results');
