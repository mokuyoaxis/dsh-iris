import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-browser-startup');
const verifier = fileURLToPath(new URL('../scripts/verify-local-web-browser.mjs', import.meta.url));
async function verify(name, executable) {
  const out = path.join(root, name);
  const child = spawn(process.execPath, [verifier, '--browser-executable', executable, '--output', out, '--no-sandbox', '--overview'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', timedOut = false;
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 35000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(timedOut, false, name + ': verifier failed to close\n' + output);
    assert.equal(result.code, 1, JSON.stringify(result) + '\n' + output);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json')));
    assert.equal(report.status, 'failed'); assert.equal(report.actualPaidCalls, 0);
    assert.equal(report.browserStartup.timeoutMs, 12000, 'keep the existing startup budget');
    assert.equal(report.browserStartup.portFileExists, false);
    console.log(JSON.stringify({ case: name, startup: report.browserStartup, cleanup: report.browserCleanup, exit: report.browserExit }));
    return report;
  } finally { clearTimeout(deadline); }
}

// A real executable that rejects Chromium flags must be reported as an early
// process exit, before cleanup can obscure the original exit status.
const early = await verify('early-exit', process.execPath);
assert.equal(early.browserStartup.status, 'exited_before_ready');
assert.equal(typeof early.browserStartup.exitBeforeReady.code, 'number');
assert.notEqual(early.browserStartup.exitBeforeReady.code, 0);
assert.equal(early.browserStartup.process.exitCode, early.browserStartup.exitBeforeReady.code);
assert.equal(early.browserExit.code, early.browserStartup.exitBeforeReady.code);

if (process.platform !== 'win32') {
  const denied = path.join(root, 'non executable browser'); fs.writeFileSync(denied, 'fixture', { mode: 0o600 });
  const failed = await verify('spawn-error', denied);
  assert.equal(failed.browserStartup.status, 'spawn_failed'); assert.equal(failed.browserStartup.spawnError.code, 'EACCES');

  const hanging = path.join(root, 'hanging browser'); fs.writeFileSync(hanging, '#!/bin/sh\nexec sleep 25\n', { mode: 0o700 });
  const timeout = await verify('startup-timeout', hanging);
  assert.equal(timeout.browserStartup.status, 'timed_out');
  assert(timeout.browserStartup.elapsedMs >= 12000);
  assert.equal(timeout.browserStartup.process.exitCode, null); assert.equal(timeout.browserStartup.process.closed, false);
  assert.equal(timeout.browserStartup.exitBeforeReady, undefined);
  assert.equal(timeout.browserCleanup.before.exitCode, null); assert.equal(timeout.browserCleanup.before.closed, false);
  assert.deepEqual(timeout.browserCleanup.signalsRequested, ['SIGTERM']);
  assert.equal(timeout.browserExit.signal, 'SIGTERM', 'cleanup signals must not masquerade as an early startup exit');
} else console.log('SKIP POSIX permission and shell timeout fixtures on Windows; early-exit verification still runs');
console.log('PASS Chromium startup diagnostics distinguish process exit, spawn failure, readiness timeout and cleanup');
