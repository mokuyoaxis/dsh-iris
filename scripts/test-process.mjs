import { spawn } from 'node:child_process';
import path from 'node:path';
import { createLintTrace, recordLintTrace, snapshotLintProcesses } from './lint-trace.mjs';

export function testProcessArgs(testFile) {
  return [
    '--import', new URL('./test-shutdown.mjs', import.meta.url).href,
    testFile
  ];
}

// Await the OS close notification with a live parent event loop. Successful
// assertions or JS exit handlers alone do not count as a successful process.
export function runTestProcess(testFile, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const traceFile = path.basename(testFile) === 'lint.mjs' ? createLintTrace(cwd) : undefined;
    const started = performance.now();
    if (traceFile) recordLintTrace(traceFile, 'runner-start', { node: process.version, platform: process.platform,
      arch: process.arch, timeoutMs });
    const child = spawn(process.execPath, testProcessArgs(testFile), {
      cwd, stdio: 'inherit', shell: false,
      env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '', ...(traceFile ? { IRIS_LINT_TRACE_FILE: traceFile } : {}) }
    });
    console.log(`Test process: ${child.pid}`);
    if (traceFile) {
      recordLintTrace(traceFile, 'runner-spawned', { childPid: child.pid });
      console.log(`[lint] 现场日志：${path.relative(cwd, traceFile)}`);
    }
    let error;
    const timer = setTimeout(() => {
      error = Object.assign(new Error(`Test process ${child.pid} timed out`), { code: 'ETIMEDOUT' });
      try {
        if (traceFile) {
          console.error('[lint] 高优先级异常：整体超时。保留首次失败现场，复查通过不解除未定位风险。');
          recordLintTrace(traceFile, 'runner-timeout', { childPid: child.pid, timeoutMs,
            elapsedMs: Math.round(performance.now() - started), processSnapshot: snapshotLintProcesses(child.pid) });
          console.error(`[lint] 超时现场：${path.relative(cwd, traceFile)}`);
        }
      } catch (cause) {
        // Diagnostic I/O must not prevent termination or hide the timeout.
        error.cause = cause;
        console.error(`[lint] 超时现场记录失败：${cause.code || cause.name}`);
      } finally { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.once('error', (cause) => { error ??= cause; });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      console.log(`Test process ${child.pid}: closed (${status ?? signal})`);
      if (traceFile) recordLintTrace(traceFile, 'runner-close', { childPid: child.pid, status, signal,
        elapsedMs: Math.round(performance.now() - started), ...(error ? { errorCode: error.code } : {}) });
      resolve({ status, signal, error, ...(traceFile ? { traceFile } : {}) });
    });
  });
}
